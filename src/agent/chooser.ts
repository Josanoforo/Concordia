import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Nightshift, NightshiftChatError, type Receipt } from '../clients/nightshift.ts';
import { failure, ROOT, SafeError, sanitize, trace } from '../runtime.ts';
import { modelJsonText } from './model-json.ts';
import { estimateCallTokens } from './run-budget.ts';
import type { SecondaryJudgeNote } from './secondary-judge.ts';

export type ChoiceCall = { stage: string; status: string; decisionStatus?: string; requestedModel: string; selected?: string; reason?: string;
  reasonOriginal?: string; responseText?: string; /** First 500 characters of a rejected response, sanitized; kept in the run report (responseText is not). */ responseExcerpt?: string; receipt?: Receipt; error?: object; /** The action ids offered to the model for this call (so a later judge can be measured against the same choices). */ allowed?: string[];
  /** 1, or 2 when the single format retry ran. */ attempt?: 1 | 2;
  /** Tokens of every generation of this call (the retry's included); the run budget charges this when present. */ tokensCharged?: number;
  formatRetry?: { attempted: boolean; originalCode: string; reason?: string; outcome?: string }; firstAttempt?: { receipt?: Receipt; errorCode: string; responseExcerpt?: string }; promptHash: string; utc: string;
  /** Optional R5-6 note (flag OFF by default). Never changes `selected`. */ secondaryJudge?: SecondaryJudgeNote };
/** Picks exactly one id from a closed list. Implementations never receive or return SQL. */
export interface ActionChooser {
  choose(stage: string, observation: unknown, allowed: readonly string[], options?: { compact?: boolean; canRetry?: (estimatedTotalTokens: number) => boolean }): Promise<ChoiceCall>;
  /** Estimated total tokens (input + output allowance) of the call `choose` would make; absent for choosers that cost no tokens. */
  estimateTokens?(stage: string, observation: unknown, allowed: readonly string[], options?: { compact?: boolean }): number;
}

/** Fixed reminder sent with the single retry after an unparseable reply (M7-1). */
export const FORMAT_REMINDER = 'Your previous reply could not be parsed as JSON. Reply again with ONLY a bare JSON object, no Markdown fence and no other text: {"action":"<one exact allowed action>","reason":"<brief evidence-based reason>"}.';

/** Reason limits asked of / accepted from the model: normal and compact (continuation) mode. */
export const REASON_LIMIT = 500, COMPACT_REASON_LIMIT = 60;
/** Error-code prefix of the legacy U2 path (kept: it is recorded in existing runs); the generic agent uses MODEL. */
export const LEGACY_U2_CODE_PREFIX = 'U2_ADAPTIVE', GENERIC_CODE_PREFIX = 'MODEL';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The action is always validated strictly against the closed list. The reason is explanatory text: with `truncateReason`
 * (compact mode) an over-long reason is shortened to the limit instead of invalidating a valid decision, and the full
 * original text is returned in `reasonOriginal`. The compact limit applies to what is asked of the model, not to what is accepted from it.
 */
export function parseAdaptiveChoice(text: string, allowed: readonly string[], maxReasonLength = REASON_LIMIT, truncateReason = false, codePrefix = LEGACY_U2_CODE_PREFIX): { action: string; reason: string; reasonOriginal?: string } {
  let value: any;
  try { value = JSON.parse(modelJsonText(text)); } catch { throw new SafeError(`${codePrefix}_RESPONSE_NOT_JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['action', 'reason'].includes(key)) ||
    typeof value.action !== 'string' || !allowed.includes(value.action) || typeof value.reason !== 'string' || value.reason.trim().length < 8 || (!truncateReason && value.reason.length > maxReasonLength)) {
    throw new SafeError(`${codePrefix}_RESPONSE_INVALID`);
  }
  const reason = value.reason.trim();
  return reason.length > maxReasonLength ? { action: value.action, reason: reason.slice(0, maxReasonLength), reasonOriginal: reason } : { action: value.action, reason };
}

function appendJsonLine(relative: string, value: unknown) {
  const file = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

/**
 * N1 / E5-02 for the chooser: the decision is requested as a forced tool call (`tools` + a `tool_choice` naming the function). The allowed action ids are an enum in the schema, so the model can only
 * pick an id; it never writes SQL or a verdict. The call arguments come back as the response text and go through the same strict parser; an invalid reply keeps the M7-1 single retry (no new retries).
 */
export function choiceToolRequest(allowed: readonly string[], compact: boolean) {
  const name = 'choose_action';
  const tool = { type: 'function', function: { name, description: 'Select exactly one allowed next action and give a brief evidence-based reason. The action must be one of the listed ids; never write SQL.',
    parameters: { type: 'object', additionalProperties: false, required: ['action', 'reason'], properties: { action: { type: 'string', enum: [...allowed] }, reason: { type: 'string', minLength: 8, maxLength: compact ? COMPACT_REASON_LIMIT : REASON_LIMIT } } } } };
  return { tools: [tool] as object[], toolChoice: { type: 'function', function: { name } } as object };
}
const toolTokens = (request: { tools: object[] }) => Math.ceil(JSON.stringify(request.tools).length / 4);

/** Model-backed chooser (Nightshift). Task wording comes from the universe catalog. */
export class NightshiftChooser implements ActionChooser {
  constructor(private readonly nightshift: Nightshift, private readonly runId: string, private readonly task: { productLabel: string; plannerTask: string }, private readonly codePrefix = LEGACY_U2_CODE_PREFIX, private readonly structuredOutput: 'TOOL_CALL' | 'NONE' = codePrefix === GENERIC_CODE_PREFIX ? 'TOOL_CALL' : 'NONE') {}
  private tool(allowed: readonly string[], compact: boolean) { return this.structuredOutput === 'TOOL_CALL' ? choiceToolRequest(allowed, compact) : undefined; }
  private messages(stage: string, observation: unknown, allowed: readonly string[], compact: boolean) {
    const prompt = JSON.stringify({ task: `Decide one next action for the ${this.task.plannerTask} using only the supplied observations.`,
      stage, observations: observation, allowedActions: allowed,
      constraints: ['Return only JSON: {"action":"one exact allowed action","reason":"brief evidence-based reason"}. Bare JSON object: no Markdown code fence and no text before or after it.',
        'Never write SQL or invent values; the executor derives all query parameters from observed rows.',
        'A schema hypothesis is not acceptance or authorization. Bounded matches are not global claims.',
        'Choose STOP_EXPLORATION only when further permitted reads are not useful; do not request approval for routine uncertainty.',
        ...(compact ? ['Keep reason under 60 characters so the JSON fits a short response.'] : [])] });
    const system = compact
      ? `Choose one listed ${this.task.productLabel} action. Return compact valid JSON; reason must be factual, bounded, and under 60 characters.`
      : `You are the adaptive planner inside the ${this.task.productLabel} product. Select exactly one allowed action from observed evidence. Keep the reason factual and bounded.`;
    return { prompt, messages: [{ role: 'system' as const, content: system }, { role: 'user' as const, content: prompt }], maxTokens: compact ? 120 : 500 };
  }
  estimateTokens(stage: string, observation: unknown, allowed: readonly string[], options: { compact?: boolean } = {}): number {
    const built = this.messages(stage, observation, allowed, Boolean(options.compact));
    const tool = this.tool(allowed, Boolean(options.compact));
    return estimateCallTokens(built.messages, built.maxTokens) + (tool ? toolTokens(tool) : 0);
  }
  async choose(stage: string, observation: unknown, allowed: readonly string[], options: { compact?: boolean; canRetry?: (estimatedTotalTokens: number) => boolean } = {}): Promise<ChoiceCall> {
    const compact = Boolean(options.compact), { nightshift, runId } = this;
    const { prompt, messages, maxTokens } = this.messages(stage, observation, allowed, compact);
    const tool = this.tool(allowed, compact);
    const call: ChoiceCall = { stage, status: 'FAILED', requestedModel: nightshift.route, promptHash: sha(prompt), utc: new Date().toISOString(), attempt: 1 };
    const notJson = `${this.codePrefix}_RESPONSE_NOT_JSON`;
    /** One generation and its parse; fills the call from this attempt. */
    const attempt = async (chatMessages: typeof messages): Promise<void> => {
      delete call.decisionStatus; delete call.selected; delete call.reason; delete call.reasonOriginal; delete call.error; delete call.responseExcerpt; delete call.receipt; delete call.responseText;
      try {
        const generated = await nightshift.chat(chatMessages, { maxTokens, preserveTextOnFailure: true, ...(tool ?? {}) });
        call.status = 'PASS'; call.responseText = generated.text; call.receipt = generated.receipt;
        try { const parsed = parseAdaptiveChoice(generated.text, allowed, compact ? COMPACT_REASON_LIMIT : REASON_LIMIT, compact, this.codePrefix); call.decisionStatus = 'VALID'; call.selected = parsed.action; call.reason = parsed.reason; if (parsed.reasonOriginal) call.reasonOriginal = parsed.reasonOriginal; }
        catch (error) { call.decisionStatus = 'INVALID_RESPONSE'; call.error = failure(error); call.responseExcerpt = sanitize(generated.text.slice(0, 500)); }
      } catch (error) {
        call.status = 'FAIL'; call.error = failure(error);
        if (error instanceof NightshiftChatError) {
          call.responseText = error.responseText;
          if (error.receipt) call.receipt = error.receipt;
        }
      }
    };
    await attempt(messages);
    // M7-1: the single permitted retry. Only a syntactically unparseable reply triggers it (never a valid decision, a disallowed action, a transport/HTTP error or a token cap);
    // it carries a fixed format reminder, counts in the run budget (tokensCharged) and each generation keeps its own receipt. No third attempt.
    if (call.decisionStatus === 'INVALID_RESPONSE' && (call.error as { code?: string } | undefined)?.code === notJson) {
      const first = { receipt: call.receipt, errorCode: notJson, responseExcerpt: call.responseExcerpt };
      const firstTokens = call.receipt?.totalTokens ?? 0;
      const retryMessages = [...messages, { role: 'user' as const, content: FORMAT_REMINDER }];
      const estimated = estimateCallTokens(retryMessages, maxTokens) + (tool ? toolTokens(tool) : 0);
      const skipReason = !options.canRetry ? 'NO_BUDGET_CONTEXT' : !options.canRetry(firstTokens + estimated) ? 'TOKEN_BUDGET_WOULD_EXCEED' : undefined;
      if (skipReason) {
        call.formatRetry = { attempted: false, reason: skipReason, originalCode: notJson };
        trace({ kind: 'agent-model-format-retry', runId, stage, originalCode: notJson, outcome: 'SKIPPED', reason: skipReason, estimated });
      } else {
        call.attempt = 2;
        await attempt(retryMessages);
        const outcome = (call.decisionStatus as string | undefined) === 'VALID' ? 'VALID' : call.status === 'FAIL' ? 'TRANSPORT_FAIL' : 'INVALID_RESPONSE';
        call.firstAttempt = first;
        call.tokensCharged = firstTokens + (call.receipt?.totalTokens ?? 0);
        call.formatRetry = { attempted: true, originalCode: notJson, outcome };
        trace({ kind: 'agent-model-format-retry', runId, stage, originalCode: notJson, outcome });
      }
    }
    appendJsonLine(`.concordia/agent-runs/${runId}/adaptive-decisions.jsonl`, call);
    trace({ kind: 'agent-adaptive-model-decision', runId, ...call });
    return call;
  }
}

/** Offline chooser: first non-stop option, or stop. Deterministic, no model, no tokens. */
export class DeterministicChooser implements ActionChooser {
  async choose(stage: string, observation: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const selected = allowed.find(item => !item.startsWith('STOP_') && item !== 'NO_JOIN') ?? allowed[allowed.length - 1];
    return { stage, status: 'PASS', decisionStatus: 'VALID', requestedModel: 'deterministic', selected, reason: 'deterministic offline chooser: first permitted option', promptHash: sha({ stage, observation, allowed }), utc: new Date().toISOString() };
  }
}
