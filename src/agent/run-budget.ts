import { SafeError } from '../runtime.ts';

export interface RunBudgetLimits { maxQueriesPerRun: number; readLimit: number; maxTokensPerRun: number; maxSteps: number }
/** Defaults mirror the measured U2 run: ~25 SQL queries, 50 rows per read, ~15k tokens, 3 exploration steps. */
export const DEFAULT_RUN_BUDGET: RunBudgetLimits = { maxQueriesPerRun: 25, readLimit: 50, maxTokensPerRun: 15000, maxSteps: 3 };
export const RUN_BUDGET_CEILINGS: RunBudgetLimits = { maxQueriesPerRun: 200, readLimit: 1000, maxTokensPerRun: 200000, maxSteps: 20 };

export function limitsFromBounds(bounds?: Partial<RunBudgetLimits>): RunBudgetLimits {
  const merged = { ...DEFAULT_RUN_BUDGET, ...(bounds ?? {}) };
  for (const key of Object.keys(DEFAULT_RUN_BUDGET) as (keyof RunBudgetLimits)[]) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1 || merged[key] > RUN_BUDGET_CEILINGS[key]) throw new SafeError('RUN_BUDGET_INVALID');
  }
  return merged;
}

/** Counts every SQL statement and model token of one agent run; exhaustion is an explicit, recorded stop. */
export class RunBudget {
  queries = 0; tokens = 0; steps = 0;
  constructor(readonly limits: RunBudgetLimits) {}
  canQuery(count = 1) { return this.queries + count <= this.limits.maxQueriesPerRun; }
  chargeQuery() { if (!this.canQuery()) throw new SafeError('AGENT_QUERY_BUDGET_EXCEEDED'); this.queries++; }
  chargeTokens(count: number) { if (Number.isFinite(count) && count > 0) this.tokens += count; }
  canAskModel() { return this.tokens < this.limits.maxTokensPerRun; }
  canStep() { return this.steps < this.limits.maxSteps; }
  snapshot() {
    return { limits: this.limits, used: { queries: this.queries, tokens: this.tokens, steps: this.steps },
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
