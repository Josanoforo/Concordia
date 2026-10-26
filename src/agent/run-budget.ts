import { SafeError } from '../runtime.ts';

export interface RunBudgetLimits { maxQueriesPerRun: number; readLimit: number; maxTokensPerRun: number; maxSteps: number }
/** Defaults mirror the measured U2 run: ~25 SQL queries, 50 rows per read, ~15k tokens, 3 exploration steps. */
export const DEFAULT_RUN_BUDGET: RunBudgetLimits = { maxQueriesPerRun: 25, readLimit: 50, maxTokensPerRun: 15000, maxSteps: 3 };
/**
 * Hard ceilings a manifest or flag may ask for (P7). The defaults above stay small; a universe that needs a full run (cover every candidate, model review with an adversarial pass)
 * declares its own values in capabilityBounds.AGENT_EXPLORATION, up to these ceilings. The registry validates the same declaration, so its ceilings must equal these (single source: import this constant).
 */
export const RUN_BUDGET_CEILINGS: RunBudgetLimits = { maxQueriesPerRun: 5000, readLimit: 1000, maxTokensPerRun: 4_000_000, maxSteps: 50 };

/** Pre-run cost estimate of N units of work (coverage probes, model calls ...) against what a budget has left. It reports; it never cuts anything by itself. */
export interface CostEstimate {
  units: number; perUnit: { queries: number; tokens: number };
  estimatedQueries: number; estimatedTokens: number; queriesAvailable: number; tokensAvailable: number;
  fits: boolean; fitsQueries: boolean; fitsTokens: boolean; queryShortfall: number; tokenShortfall: number;
  /** How many of the units the remaining budget could pay, whichever resource runs out first (never above `units`). */
  affordableUnits: number; phase: BudgetPhase;
}

/**
 * Phase budget (R5-3). The query and token ceilings are split by share across discovery, exploration, probes and critic; what a phase does not use
 * flows to the next one, and a phase that reaches its (carried-over) allowance stops cleanly with PHASE_BUDGET_EXHAUSTED while the global ceiling stays intact.
 * Post-COMA and the model review are not shared: each runs on whatever the global ceiling still has left. It is opt-in (deps.phaseBudget or bounds.phaseShares): the default split below
 * is documented but not applied unless asked, because U1 spends 10 SQL in discovery alone and a 30 % share of 25 queries would starve it.
 */
export const BUDGET_PHASES = ['discovery', 'exploration', 'probes', 'critic', 'modelReview', 'postComa'] as const;
export type BudgetPhase = typeof BUDGET_PHASES[number];
export type PhaseShares = Record<'discovery' | 'exploration' | 'probes' | 'critic', number>;
export const DEFAULT_PHASE_SHARES: PhaseShares = { discovery: 0.4, exploration: 0.2, probes: 0.3, critic: 0.1 };
export function validatePhaseShares(shares: unknown): PhaseShares {
  const value = shares as PhaseShares, keys = Object.keys(DEFAULT_PHASE_SHARES) as (keyof PhaseShares)[];
  if (!value || typeof value !== 'object' || keys.some(key => !Number.isFinite(value[key]) || value[key] < 0) || Math.abs(keys.reduce((sum, key) => sum + value[key], 0) - 1) > 1e-9) throw new SafeError('PHASE_SHARES_INVALID');
  return Object.fromEntries(keys.map(key => [key, value[key]])) as PhaseShares;
}

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
  /** Source statements that reach the source but are not gated by the cap: the JSON2 guard's preflight and the schema DESCRIBEs of discovery. Visible, and part of totalSourceQueries. */
  preflightQueries = 0; discoveryQueries = 0;
  /** Where the token cap came from, recorded in the run so the effective cap is never ambiguous. */
  readonly tokenCapSource: 'flag' | 'manifest' = tokenCapOverride !== undefined ? 'flag' : 'manifest';
  private shares?: PhaseShares; private current: BudgetPhase = 'discovery';
  private phaseUsed: Record<BudgetPhase, { queries: number; tokens: number }> = Object.fromEntries(BUDGET_PHASES.map(phase => [phase, { queries: 0, tokens: 0 }])) as any;
  constructor(readonly limits: RunBudgetLimits, shares?: PhaseShares) { if (shares) this.shares = validatePhaseShares(shares); }
  get phase() { return this.current; }
  enterPhase(phase: BudgetPhase) { this.current = phase; }
  /** Allowance of a phase for one resource: cumulative share up to it, minus what earlier phases consumed (so unused budget carries over). */
  private phaseAllowance(phase: BudgetPhase, resource: 'queries' | 'tokens') {
    const limit = resource === 'queries' ? this.limits.maxQueriesPerRun : this.limits.maxTokensPerRun;
    const index = BUDGET_PHASES.indexOf(phase), before = BUDGET_PHASES.slice(0, index).reduce((sum, name) => sum + this.phaseUsed[name][resource], 0);
    if (!this.shares || phase === 'postComa' || phase === 'modelReview') return { allocated: limit, cap: limit - before };
    const keys = Object.keys(DEFAULT_PHASE_SHARES) as (keyof PhaseShares)[];
    const cumulative = keys.slice(0, index + 1).reduce((sum, key) => sum + this.shares![key], 0);
    return { allocated: Math.floor(limit * this.shares[phase]), cap: Math.min(limit, Math.floor(limit * cumulative + 1e-9)) - before };
  }
  private phaseHas(resource: 'queries' | 'tokens', extra: number) { return !this.shares || this.phaseUsed[this.current][resource] + extra <= this.phaseAllowance(this.current, resource).cap; }
  canQuery(count = 1) { return this.queries + count <= this.limits.maxQueriesPerRun && this.phaseHas('queries', count); }
  chargeQuery() {
    if (this.queries + 1 > this.limits.maxQueriesPerRun) throw new SafeError('AGENT_QUERY_BUDGET_EXCEEDED');
    if (!this.phaseHas('queries', 1)) throw new SafeError('PHASE_BUDGET_EXHAUSTED');
    this.queries++; this.phaseUsed[this.current].queries++;
  }
  noteDiscoveryQuery() { this.discoveryQueries++; }
  notePreflightQueries(count: number) { if (Number.isInteger(count) && count > 0) this.preflightQueries = count; }
  /** Every statement that reached the source in this run: gated reads + preflight + discovery DESCRIBEs; equals the SQL events of the run's trace. */
  totalSourceQueries() { return this.queries + this.preflightQueries + this.discoveryQueries; }
  chargeTokens(count: number) { if (Number.isFinite(count) && count > 0) { this.tokens += count; this.phaseUsed[this.current].tokens += count; } }
  canAskModel() { return this.tokens < this.limits.maxTokensPerRun && this.phaseHas('tokens', 1); }
  remainingTokens() { return Math.max(0, this.limits.maxTokensPerRun - this.tokens); }
  /** True only if used + estimated stays within the cap: the next call's cost is checked BEFORE it is made. */
  canAfford(estimatedTokens: number) { return this.tokens + estimatedTokens <= this.limits.maxTokensPerRun && this.phaseHas('tokens', estimatedTokens); }
  /** Explicit, recordable cause for a call that was not made because its estimated cost would exceed the cap. */
  wouldExceed(estimatedTokens: number) {
    if (this.tokens + estimatedTokens <= this.limits.maxTokensPerRun) return { code: 'PHASE_BUDGET_EXHAUSTED', phase: this.current, used: this.phaseUsed[this.current].tokens, estimated: estimatedTokens, limit: this.phaseAllowance(this.current, 'tokens').cap };
    return { code: 'TOKEN_BUDGET_WOULD_EXCEED', used: this.tokens, estimated: estimatedTokens, limit: this.limits.maxTokensPerRun };
  }
  canStep() { return this.steps < this.limits.maxSteps; }
  /** What is left for the current phase: the global ceiling and, when phase shares are on, the phase allowance, whichever is tighter. */
  available(resource: 'queries' | 'tokens') {
    const limit = resource === 'queries' ? this.limits.maxQueriesPerRun : this.limits.maxTokensPerRun, used = resource === 'queries' ? this.queries : this.tokens;
    const global = Math.max(0, limit - used);
    return this.shares ? Math.max(0, Math.min(global, this.phaseAllowance(this.current, resource).cap - this.phaseUsed[this.current][resource])) : global;
  }
  /** P7/P1: estimates the cost of `units` of work before running it, against the budget that is left right now. Pure read: nothing is charged. */
  estimate(units: number, perUnit: { queries?: number; tokens?: number } = {}): CostEstimate {
    if (!Number.isInteger(units) || units < 0) throw new SafeError('COST_ESTIMATE_INVALID');
    const queries = perUnit.queries ?? 0, tokens = perUnit.tokens ?? 0;
    if (!Number.isFinite(queries) || !Number.isFinite(tokens) || queries < 0 || tokens < 0) throw new SafeError('COST_ESTIMATE_INVALID');
    const estimatedQueries = Math.ceil(units * queries), estimatedTokens = Math.ceil(units * tokens), queriesAvailable = this.available('queries'), tokensAvailable = this.available('tokens');
    const fitsQueries = estimatedQueries <= queriesAvailable, fitsTokens = estimatedTokens <= tokensAvailable;
    const by = (available: number, each: number) => each > 0 ? Math.floor(available / each) : units;
    return { units, perUnit: { queries, tokens }, estimatedQueries, estimatedTokens, queriesAvailable, tokensAvailable, fits: fitsQueries && fitsTokens, fitsQueries, fitsTokens,
      queryShortfall: Math.max(0, estimatedQueries - queriesAvailable), tokenShortfall: Math.max(0, estimatedTokens - tokensAvailable),
      affordableUnits: Math.min(units, by(queriesAvailable, queries), by(tokensAvailable, tokens)), phase: this.current };
  }
  /** Per phase: allocated (its own share), carried in from earlier phases, used and the allowance left; enabled=false means usage is only observed. */
  phaseSnapshot() {
    return { enabled: Boolean(this.shares), shares: this.shares ?? null, byPhase: Object.fromEntries(BUDGET_PHASES.map(phase => {
      const q = this.phaseAllowance(phase, 'queries'), t = this.phaseAllowance(phase, 'tokens'), used = this.phaseUsed[phase];
      return [phase, this.shares && phase !== 'postComa' && phase !== 'modelReview'
        ? { allocated: { queries: q.allocated, tokens: t.allocated }, transferredIn: { queries: Math.max(0, q.cap - q.allocated), tokens: Math.max(0, t.cap - t.allocated) }, used: { ...used } }
        : { used: { ...used } }];
    })) };
  }
  snapshot() {
    return { limits: this.limits, tokenCap: { value: this.limits.maxTokensPerRun, source: this.tokenCapSource }, used: { queries: this.queries, tokens: this.tokens, steps: this.steps, preflightQueries: this.preflightQueries, discoveryQueries: this.discoveryQueries, totalSourceQueries: this.totalSourceQueries() },
      phases: this.phaseSnapshot(),
      exhausted: [...(this.queries >= this.limits.maxQueriesPerRun ? ['queries'] : []), ...(this.tokens >= this.limits.maxTokensPerRun ? ['tokens'] : []), ...(this.steps >= this.limits.maxSteps ? ['steps'] : [])] };
  }
}

/** Wraps a Zetaris-like client so every runSql is charged against the run budget before it is sent. */
export function budgetedClient<T extends { runSql: (...args: any[]) => Promise<any> }>(client: T, budget: RunBudget): T {
  return new Proxy(client, { get(target, property, receiver) {
    if (property === 'runSql') return (...args: any[]) => { try { budget.chargeQuery(); } catch (error) { return Promise.reject(error); } return target.runSql(...args); };
    if (property === 'describe') return (...args: any[]) => { budget.noteDiscoveryQuery(); return (target as any).describe(...args); };
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
