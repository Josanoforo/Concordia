/**
 * Assisted critic (R5-2). One model call per batch of SOSTENIDA relations suggests counterprobe ids from a closed catalog.
 * The model never writes SQL and never decides a verdict: valid ids are run by the injected executor (the existing typed
 * counterprobe) inside the remaining SQL budget, and only a DEGRADED outcome of the existing critic rule has an effect.
 * Nothing here can raise a verdict. Any model failure falls back, labelled and without retry, to today's deterministic critic.
 */
import { createHash } from 'node:crypto';
import { NightshiftChatError, type Nightshift, type Receipt } from '../clients/nightshift.ts';
import { estimateCallTokens } from './run-budget.ts';
import { modelJsonText } from './model-json.ts';
import type { TypedCriticOutcome } from '../critic/adversarial.ts';

export interface CounterprobeSpec { id: string; description: string; /** Upper bound of SQL statements one run of this counterprobe may issue. */ maxSql: number }
export interface SustainedRelation { relationId: string; from: string; to: string }
/** Budget surface used here; RunBudget satisfies it. SQL is charged by the budgeted client of the executor, not here. */
export interface AssistBudget {
  canQuery(count?: number): boolean; canAskModel(): boolean; canAfford(estimatedTokens: number): boolean;
  chargeTokens(count: number): void; wouldExceed(estimatedTokens: number): object;
}
export interface AssistCall { status: string; responseText?: string; receipt?: Receipt; error?: object }
/** Closed-list suggester: receives the prompt messages' pieces and returns raw model text; never SQL. */
export interface AssistChooser {
  estimateTokens?(observation: unknown, allowedIds: readonly string[]): number;
  suggest(observation: unknown, allowedIds: readonly string[]): Promise<AssistCall>;
}
export type CounterprobeExecutor = (relationId: string, counterprobeId: string) => Promise<TypedCriticOutcome>;

/** Default catalog: the single strategy the deterministic critic already runs. */
export const FRINGE_COUNTERPROBE_ID = 'UNSEEN_SOURCE_KEY_FRINGE';
export const DEFAULT_COUNTERPROBE_CATALOG: readonly CounterprobeSpec[] = [
  { id: FRINGE_COUNTERPROBE_ID, description: 'Read source keys not seen in the baseline, then look them up in the target (bounded).', maxSql: 2 }
];

export const MAX_SUGGESTIONS_PER_RELATION = 2;
export const ASSIST_MAX_OUTPUT_TOKENS = 300;
const ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type AssistStatus = 'ASSISTED' | 'NO_SUSTAINED' | 'SKIPPED_BUDGET' | 'FALLBACK_DETERMINISTIC' | 'NO_VALID_SUGGESTION';
export interface Rejected { relationId?: string; id?: unknown; reason: 'UNKNOWN_COUNTERPROBE_ID' | 'UNKNOWN_RELATION' | 'DUPLICATE' | 'OVER_RELATION_LIMIT' | 'MALFORMED_ITEM' }
export interface ExecutedCounterprobe { relationId: string; id: string; status: string; classification?: string; reason: string; degraded: boolean }
export interface CriticAssist {
  status: AssistStatus;
  /** Present when the deterministic critic must run as today (no usable model help). */
  fallback?: { to: 'DETERMINISTIC_CRITIC'; reason: string; detail?: object };
  call: { made: boolean; receipt?: Receipt; decisionStatus?: string; estimatedTokens?: number; promptHash?: string; error?: object };
  suggested: { relationId: string; id: string }[];
  executed: ExecutedCounterprobe[];
  rejected: Rejected[];
  /** Relations whose existing critic rule returned DEGRADED. Verdicts are only ever lowered; this module never raises one. */
  degradedRelationIds: string[];
  labels: readonly string[];
}
const LABELS = ['MODEL_SUGGESTS_IDS_ONLY', 'CRITIC_RULE_DECIDES', 'DEGRADE_ONLY'] as const;

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function parseSuggestions(text: string): { relationId?: unknown; id?: unknown }[] | undefined {
  let value: any;
  try { value = JSON.parse(modelJsonText(text)); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'counterprobes') || !Array.isArray(value.counterprobes)) return undefined;
  if (value.counterprobes.length > 50) return undefined;
  return value.counterprobes;
}

export interface SuggestInput {
  sustained: readonly SustainedRelation[];
  catalog: readonly CounterprobeSpec[];
  budget: AssistBudget;
  chooser: AssistChooser;
  execute: CounterprobeExecutor;
  maxPerRelation?: number;
}

export async function suggestCounterProbes(input: SuggestInput): Promise<CriticAssist> {
  const { sustained, catalog, budget, chooser, execute } = input;
  const maxPerRelation = input.maxPerRelation ?? MAX_SUGGESTIONS_PER_RELATION;
  const out: CriticAssist = { status: 'NO_SUSTAINED', call: { made: false }, suggested: [], executed: [], rejected: [], degradedRelationIds: [], labels: LABELS };
  if (!sustained.length) return out;
  const ids = catalog.map(spec => spec.id);
  if (!ids.length || ids.some(id => !ID.test(id)) || new Set(ids).size !== ids.length) {
    return { ...out, status: 'FALLBACK_DETERMINISTIC', fallback: { to: 'DETERMINISTIC_CRITIC', reason: 'COUNTERPROBE_CATALOG_INVALID' } };
  }
  const observation = { task: 'For each sustained relation, pick counterprobe ids that could contradict it. Use only the allowed ids.',
    relations: sustained.map(({ relationId, from, to }) => ({ relationId, from, to })),
    counterprobes: catalog.map(({ id, description }) => ({ id, description })), maxPerRelation,
    constraints: ['Return only JSON: {"counterprobes":[{"relationId":"...","id":"..."}]}.', 'Never write SQL. A sustained verdict is a bounded sample, not a global claim.'] };
  const promptHash = sha({ observation, ids });
  const estimated = chooser.estimateTokens?.(observation, ids)
    ?? estimateCallTokens([{ content: JSON.stringify(observation) }], ASSIST_MAX_OUTPUT_TOKENS);
  if (!budget.canAskModel() || !budget.canAfford(estimated)) {
    return { ...out, status: 'SKIPPED_BUDGET', call: { made: false, estimatedTokens: estimated, promptHash, decisionStatus: 'TOKEN_BUDGET_WOULD_EXCEED' },
      fallback: { to: 'DETERMINISTIC_CRITIC', reason: 'TOKEN_BUDGET_WOULD_EXCEED', detail: budget.wouldExceed(estimated) } };
  }

  let call: AssistCall;
  try { call = await chooser.suggest(observation, ids); }
  catch (error) { call = { status: 'FAIL', error: { code: error instanceof Error ? error.name : 'ASSIST_CHOOSER_THROWN' } }; }
  budget.chargeTokens(call.receipt?.totalTokens ?? 0);
  const made = { made: true, estimatedTokens: estimated, promptHash, ...(call.receipt ? { receipt: call.receipt } : {}) };
  const suggestions = call.status === 'PASS' && typeof call.responseText === 'string' ? parseSuggestions(call.responseText) : undefined;
  if (!suggestions) {
    const decisionStatus = call.status === 'PASS' ? 'INVALID_RESPONSE' : 'MODEL_CALL_FAILED';
    return { ...out, status: 'FALLBACK_DETERMINISTIC', call: { ...made, decisionStatus, ...(call.error ? { error: call.error } : {}) },
      fallback: { to: 'DETERMINISTIC_CRITIC', reason: decisionStatus } };
  }

  const known = new Set(sustained.map(item => item.relationId)), catalogIds = new Set(ids), seen = new Set<string>(), perRelation = new Map<string, number>();
  for (const item of suggestions) {
    if (!item || typeof item !== 'object' || typeof item.relationId !== 'string' || typeof item.id !== 'string') { out.rejected.push({ reason: 'MALFORMED_ITEM' }); continue; }
    const { relationId, id } = item;
    if (!known.has(relationId)) { out.rejected.push({ relationId, id, reason: 'UNKNOWN_RELATION' }); continue; }
    if (!catalogIds.has(id)) { out.rejected.push({ relationId, id, reason: 'UNKNOWN_COUNTERPROBE_ID' }); continue; }
    if (seen.has(`${relationId}|${id}`)) { out.rejected.push({ relationId, id, reason: 'DUPLICATE' }); continue; }
    if ((perRelation.get(relationId) ?? 0) >= maxPerRelation) { out.rejected.push({ relationId, id, reason: 'OVER_RELATION_LIMIT' }); continue; }
    seen.add(`${relationId}|${id}`); perRelation.set(relationId, (perRelation.get(relationId) ?? 0) + 1);
    out.suggested.push({ relationId, id });
  }
  out.call = { ...made, decisionStatus: 'VALID' };
  if (!out.suggested.length) {
    return { ...out, status: 'NO_VALID_SUGGESTION', fallback: { to: 'DETERMINISTIC_CRITIC', reason: 'NO_VALID_SUGGESTION' } };
  }

  const specs = new Map(catalog.map(spec => [spec.id, spec]));
  for (const { relationId, id } of out.suggested) {
    if (out.degradedRelationIds.includes(relationId)) { out.executed.push({ relationId, id, status: 'SKIPPED', reason: 'already_degraded_by_earlier_counterprobe', degraded: false }); continue; }
    if (!budget.canQuery(specs.get(id)!.maxSql)) { out.executed.push({ relationId, id, status: 'SKIPPED_BUDGET', reason: 'SQL_BUDGET_WOULD_EXCEED', degraded: false }); continue; }
    let outcome: TypedCriticOutcome;
    try { outcome = await execute(relationId, id); }
    catch (error) { outcome = { status: 'ERROR', reason: error instanceof Error ? error.message : 'COUNTERPROBE_EXECUTION_FAILED' }; }
    // Existing critic rule: only DEGRADED lowers a verdict. CONFIRMED / INSUFFICIENT / ERROR leave it untouched; nothing raises it.
    const degraded = outcome.status === 'DEGRADED';
    out.executed.push({ relationId, id, status: outcome.status, ...(outcome.classification ? { classification: outcome.classification } : {}), reason: outcome.reason, degraded });
    if (degraded) out.degradedRelationIds.push(relationId);
  }
  out.status = 'ASSISTED';
  return out;
}

/** Prompt builder shared by a model-backed chooser: closed ids, JSON-only answer. */
export function assistMessages(observation: unknown) {
  return [{ role: 'system' as const, content: 'You assist a read-only critic. Pick counterprobe ids from the allowed list only. Return only the requested JSON.' },
    { role: 'user' as const, content: JSON.stringify(observation) }];
}

/** Model-backed chooser (Nightshift): one chat call, raw text back; SQL is never requested or accepted. */
export class NightshiftAssistChooser implements AssistChooser {
  constructor(private readonly nightshift: Nightshift) {}
  estimateTokens(observation: unknown): number { return estimateCallTokens(assistMessages(observation), ASSIST_MAX_OUTPUT_TOKENS); }
  async suggest(observation: unknown): Promise<AssistCall> {
    try {
      const generated = await this.nightshift.chat(assistMessages(observation), { maxTokens: ASSIST_MAX_OUTPUT_TOKENS, preserveTextOnFailure: true });
      return { status: 'PASS', responseText: generated.text, receipt: generated.receipt };
    } catch (error) {
      const base: AssistCall = { status: 'FAIL', error: { code: error instanceof Error ? error.name : 'ASSIST_CALL_FAILED' } };
      return error instanceof NightshiftChatError ? { ...base, ...(error.receipt ? { receipt: error.receipt } : {}) } : base;
    }
  }
}
