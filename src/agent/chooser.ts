import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Nightshift, NightshiftChatError, type Receipt } from '../clients/nightshift.ts';
import { failure, ROOT, SafeError, trace } from '../runtime.ts';
import { estimateCallTokens } from './run-budget.ts';

export type ChoiceCall = { stage: string; status: string; decisionStatus?: string; requestedModel: string; selected?: string; reason?: string;
  reasonOriginal?: string; responseText?: string; receipt?: Receipt; error?: object; promptHash: string; utc: string };
/** Picks exactly one id from a closed list. Implementations never receive or return SQL. */
export interface ActionChooser {
  choose(stage: string, observation: unknown, allowed: readonly string[], options?: { compact?: boolean }): Promise<ChoiceCall>;
  /** Estimated total tokens (input + output allowance) of the call `choose` would make; absent for choosers that cost no tokens. */
  estimateTokens?(stage: string, observation: unknown, allowed: readonly string[], options?: { compact?: boolean }): number;
}

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
  try { value = JSON.parse(text); } catch { throw new SafeError(`${codePrefix}_RESPONSE_NOT_JSON`); }
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

/** Model-backed chooser (Nightshift). Task wording comes from the universe catalog. */
export class NightshiftChooser implements ActionChooser {
  constructor(private readonly nightshift: Nightshift, private readonly runId: string, private readonly task: { productLabel: string; plannerTask: string }, private readonly codePrefix = LEGACY_U2_CODE_PREFIX) {}
  private messages(stage: string, observation: unknown, allowed: readonly string[], compact: boolean) {
    const prompt = JSON.stringify({ task: `Decide one next action for the ${this.task.plannerTask} using only the supplied observations.`,
      stage, observations: observation, allowedActions: allowed,
      constraints: ['Return only JSON: {"action":"one exact allowed action","reason":"brief evidence-based reason"}.',
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
    return estimateCallTokens(built.messages, built.maxTokens);
  }
  async choose(stage: string, observation: unknown, allowed: readonly string[], options: { compact?: boolean } = {}): Promise<ChoiceCall> {
    const compact = Boolean(options.compact), { nightshift, runId } = this;
    const { prompt, messages, maxTokens } = this.messages(stage, observation, allowed, compact);
    const call: ChoiceCall = { stage, status: 'FAILED', requestedModel: nightshift.route, promptHash: sha(prompt), utc: new Date().toISOString() };
    try {
      const generated = await nightshift.chat(messages, { maxTokens, preserveTextOnFailure: true });
      call.status = 'PASS'; call.responseText = generated.text; call.receipt = generated.receipt;
      try { const parsed = parseAdaptiveChoice(generated.text, allowed, compact ? COMPACT_REASON_LIMIT : REASON_LIMIT, compact, this.codePrefix); call.decisionStatus = 'VALID'; call.selected = parsed.action; call.reason = parsed.reason; if (parsed.reasonOriginal) call.reasonOriginal = parsed.reasonOriginal; }
      catch (error) { call.decisionStatus = 'INVALID_RESPONSE'; call.error = failure(error); }
    } catch (error) {
      call.status = 'FAIL'; call.error = failure(error);
      if (error instanceof NightshiftChatError) {
        call.responseText = error.responseText;
        if (error.receipt) call.receipt = error.receipt;
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
