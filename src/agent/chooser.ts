import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Nightshift, NightshiftChatError, type Receipt } from '../clients/nightshift.ts';
import { failure, ROOT, SafeError, trace } from '../runtime.ts';

export type ChoiceCall = { stage: string; status: string; decisionStatus?: string; requestedModel: string; selected?: string; reason?: string;
  responseText?: string; receipt?: Receipt; error?: object; promptHash: string; utc: string };
/** Picks exactly one id from a closed list. Implementations never receive or return SQL. */
export interface ActionChooser {
  choose(stage: string, observation: unknown, allowed: readonly string[], options?: { compact?: boolean }): Promise<ChoiceCall>;
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function parseAdaptiveChoice(text: string, allowed: readonly string[], maxReasonLength = 500): { action: string; reason: string } {
  let value: any;
  try { value = JSON.parse(text); } catch { throw new SafeError('U2_ADAPTIVE_RESPONSE_NOT_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['action', 'reason'].includes(key)) ||
    typeof value.action !== 'string' || !allowed.includes(value.action) || typeof value.reason !== 'string' || value.reason.trim().length < 8 || value.reason.length > maxReasonLength) {
    throw new SafeError('U2_ADAPTIVE_RESPONSE_INVALID');
  }
  return { action: value.action, reason: value.reason.trim() };
}

function appendJsonLine(relative: string, value: unknown) {
  const file = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

/** Model-backed chooser (Nightshift). Task wording comes from the universe catalog. */
export class NightshiftChooser implements ActionChooser {
  constructor(private readonly nightshift: Nightshift, private readonly runId: string, private readonly task: { productLabel: string; plannerTask: string }) {}
  async choose(stage: string, observation: unknown, allowed: readonly string[], options: { compact?: boolean } = {}): Promise<ChoiceCall> {
    const compact = Boolean(options.compact), { nightshift, runId } = this;
    const prompt = JSON.stringify({ task: `Decide one next action for the ${this.task.plannerTask} using only the supplied observations.`,
      stage, observations: observation, allowedActions: allowed,
      constraints: ['Return only JSON: {"action":"one exact allowed action","reason":"brief evidence-based reason"}.',
        'Never write SQL or invent values; the executor derives all query parameters from observed rows.',
        'A schema hypothesis is not acceptance or authorization. Bounded matches are not global claims.',
        'Choose STOP_EXPLORATION only when further permitted reads are not useful; do not request approval for routine uncertainty.',
        ...(compact ? ['Keep reason under 60 characters so the JSON fits a short response.'] : [])] });
    const call: ChoiceCall = { stage, status: 'FAILED', requestedModel: nightshift.route, promptHash: sha(prompt), utc: new Date().toISOString() };
    try {
      const generated = await nightshift.chat([{ role: 'system', content: compact
        ? `Choose one listed ${this.task.productLabel} action. Return compact valid JSON; reason must be factual, bounded, and under 60 characters.`
        : `You are the adaptive planner inside the ${this.task.productLabel} product. Select exactly one allowed action from observed evidence. Keep the reason factual and bounded.` },
        { role: 'user', content: prompt }], { maxTokens: compact ? 120 : 500, preserveTextOnFailure: true });
      call.status = 'PASS'; call.responseText = generated.text; call.receipt = generated.receipt;
      try { const parsed = parseAdaptiveChoice(generated.text, allowed, compact ? 60 : 500); call.decisionStatus = 'VALID'; call.selected = parsed.action; call.reason = parsed.reason; }
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
