import { SafeError } from '../runtime.ts';

export interface RunBudgetLimits { maxQueriesPerRun: number; readLimit: number; maxTokensPerRun: number; maxSteps: number }
/** Defaults mirror the measured U2 run: ~25 SQL queries, 50 rows per read, ~15k tokens, 3 exploration steps. */
export const DEFAULT_RUN_BUDGET: RunBudgetLimits = { maxQueriesPerRun: 25, readLimit: 50, maxTokensPerRun: 15000, maxSteps: 3 };
export const RUN_BUDGET_CEILINGS: RunBudgetLimits = { maxQueriesPerRun: 200, readLimit: 1000, maxTokensPerRun: 200000, maxSteps: 20 };

export const MIN_TOKEN_CAP = 1000, RECOMMENDED_LIVE_TOKEN_CAP = 50000;
let tokenCapOverride: number | undefined;
/**
 * Per-process override of the token cap (the CLI's --max-tokens), so a run does not need a manifest edit. It is a guardrail, not a gate:
 * the per-call pre-estimate and charge are unchanged. Valid range is MIN_TOKEN_CAP..the hard ceiling; undefined clears it.
 */
export function setTokenCapOverride(value: number | undefined) {
  if (value !== undefined && (!Number.isInteger(value) || value < MIN_TOKEN_CAP || value > RUN_BUDGET_CEILINGS.maxTokensPerRun)) throw new SafeError('RUN_TOKEN_CAP_INVALID');
  tokenCapOverride = value;
}

export function limitsFromBounds(bounds?: Partial<RunBudgetLimits>): RunBudgetLimits {
  const merged = { ...DEFAULT_RUN_BUDGET, ...(bounds ?? {}), ...(tokenCapOverride !== undefined ? { maxTokensPerRun: tokenCapOverride } : {}) };
  for (const key of Object.keys(DEFAULT_RUN_BUDGET) as (keyof RunBudgetLimits)[]) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1 || merged[key] > RUN_BUDGET_CEILINGS[key]) throw new SafeError('RUN_BUDGET_INVALID');
  }
  return merged;
}

/**
 * Conservative estimate: characters / 2 (rounded up) plus the full output allowance. Calibrated on L1: a ~16k-character prompt full of hashes and UUIDs cost 11.8k input tokens
 * (about 1.4 characters per token), so characters / 3 would have under-estimated it; /2 is the loosest ratio that still leaves room for ordinary prompts.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 2;
export const estimateCallTokens = (messages: readonly { content: string }[], maxOutputTokens: number) => Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / ESTIMATE_CHARS_PER_TOKEN) + maxOutputTokens;

/** Counts every SQL statement and model token of one agent run; exhaustion is an explicit, recorded stop. */
export class RunBudget {
  queries = 0; tokens = 0; steps = 0;
  /** Where the token cap came from, recorded in the run so the effective cap is never ambiguous. */
  readonly tokenCapSource: 'flag' | 'manifest' = tokenCapOverride !== undefined ? 'flag' : 'manifest';
  constructor(readonly limits: RunBudgetLimits) {}
  canQuery(count = 1) { return this.queries + count <= this.limits.maxQueriesPerRun; }
  chargeQuery() { if (!this.canQuery()) throw new SafeError('AGENT_QUERY_BUDGET_EXCEEDED'); this.queries++; }
  chargeTokens(count: number) { if (Number.isFinite(count) && count > 0) this.tokens += count; }
  canAskModel() { return this.tokens < this.limits.maxTokensPerRun; }
  remainingTokens() { return Math.max(0, this.limits.maxTokensPerRun - this.tokens); }
  /** True only if used + estimated stays within the cap: the next call's cost is checked BEFORE it is made. */
  canAfford(estimatedTokens: number) { return this.tokens + estimatedTokens <= this.limits.maxTokensPerRun; }
  /** Explicit, recordable cause for a call that was not made because its estimated cost would exceed the cap. */
  wouldExceed(estimatedTokens: number) { return { code: 'TOKEN_BUDGET_WOULD_EXCEED', used: this.tokens, estimated: estimatedTokens, limit: this.limits.maxTokensPerRun }; }
  canStep() { return this.steps < this.limits.maxSteps; }
  snapshot() {
    return { limits: this.limits, tokenCap: { value: this.limits.maxTokensPerRun, source: this.tokenCapSource }, used: { queries: this.queries, tokens: this.tokens, steps: this.steps },
      exhausted: [...(this.queries >= this.limits.maxQueriesPerRun ? ['queries'] : []), ...(this.tokens >= this.limits.maxTokensPerRun ? ['tokens'] : []), ...(this.steps >= this.limits.maxSteps ? ['steps'] : [])] };
  }
}

/** Wraps a Zetaris-like client so every runSql is charged against the run budget before it is sent. */
export function budgetedClient<T extends { runSql: (...args: any[]) => Promise<any> }>(client: T, budget: RunBudget): T {
  return new Proxy(client, { get(target, property, receiver) {
    if (property === 'runSql') return (...args: any[]) => { try { budget.chargeQuery(); } catch (error) { return Promise.reject(error); } return target.runSql(...args); };
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
