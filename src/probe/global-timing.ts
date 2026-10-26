import type { Zetaris } from '../clients/zetaris.ts';

/**
 * R10 live, correction C3: five Zetaris TIMEOUTs at 60 s. Two were on tiny tables (a transient stall: F1x over web_page, a coverage read over store); three were global evidence
 * over large fact tables (SELECT DISTINCT ... LIMIT 100 on store_returns and catalog_returns, the anti-join of store_sales against customer), where the cost is plausible.
 *
 * Global evidence gets a time policy of its own, separate from the 60 s every other read has:
 *   - `queryTimeoutMs`: the timeout of each global-evidence query (the client accepts up to 120 000). Absent = the client default (60 000), the previous behaviour.
 *   - `maxTimeoutsPerTable`: after that many timeouts on one table, its remaining heavy global reads are SKIPPED for the run (a table that timed out twice will not answer the next
 *     form either, and each attempt costs a full timeout). The skipped dimension is NOT_MEASURED with reason TIME_BUDGET_EXHAUSTED: the caveat stays, nothing is guessed.
 *   - `budgetMs`: wall time the whole run may spend on global evidence. Once spent, the remaining heavy reads are skipped the same way. Absent = unlimited.
 * Nothing here decides a verdict and nothing samples: what could not be measured in time is reported as not measured, with its reason.
 */
export const GLOBAL_TIMEOUT_MIN_MS = 1_000, GLOBAL_TIMEOUT_MAX_MS = 120_000, DEFAULT_MAX_TIMEOUTS_PER_TABLE = 2;

export interface GlobalTimingPolicy { queryTimeoutMs?: number; budgetMs?: number; maxTimeoutsPerTable: number }
export type GlobalTimingBlock = 'TABLE_TIMEOUT_LIMIT' | 'TIME_BUDGET_EXHAUSTED';
export interface GlobalTimingState {
  /** Wall time spent in global-evidence queries (failed ones included). */
  spentMs: number;
  /** Timeouts per table. */
  timeouts: Map<string, number>;
  /** Queries sent, queries that timed out, queries skipped by the gate. */
  sent: number; timedOut: number; skipped: number;
}
export interface GlobalTiming { readonly policy: GlobalTimingPolicy; readonly state: GlobalTimingState }

const validMs = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Validates the policy; an invalid field is an error (a typo must not silently run without a limit). */
export function createGlobalTiming(policy: Partial<GlobalTimingPolicy> = {}): GlobalTiming {
  if (policy.queryTimeoutMs !== undefined && !validMs(policy.queryTimeoutMs, GLOBAL_TIMEOUT_MIN_MS, GLOBAL_TIMEOUT_MAX_MS)) throw new RangeError('GLOBAL_TIMEOUT_MS_INVALID');
  if (policy.budgetMs !== undefined && !validMs(policy.budgetMs, 1, Number.MAX_SAFE_INTEGER)) throw new RangeError('GLOBAL_TIME_BUDGET_MS_INVALID');
  const maxTimeoutsPerTable = policy.maxTimeoutsPerTable ?? DEFAULT_MAX_TIMEOUTS_PER_TABLE;
  if (!Number.isInteger(maxTimeoutsPerTable) || maxTimeoutsPerTable < 1) throw new RangeError('GLOBAL_MAX_TIMEOUTS_PER_TABLE_INVALID');
  return { policy: { ...(policy.queryTimeoutMs !== undefined ? { queryTimeoutMs: policy.queryTimeoutMs } : {}), ...(policy.budgetMs !== undefined ? { budgetMs: policy.budgetMs } : {}), maxTimeoutsPerTable },
    state: { spentMs: 0, timeouts: new Map(), sent: 0, timedOut: 0, skipped: 0 } };
}

/**
 * The manifest declares the policy with three optional numeric fields next to `fullEvidence`: `fullEvidenceTimeoutMs`, `fullEvidenceBudgetMs`, `fullEvidenceMaxTimeoutsPerTable`.
 * None declared = no timing object (undefined): global evidence behaves as before. A declared but invalid value throws (see createGlobalTiming).
 */
export function globalTimingDeclared(manifest: { fullEvidenceTimeoutMs?: unknown; fullEvidenceBudgetMs?: unknown; fullEvidenceMaxTimeoutsPerTable?: unknown } | undefined | null): GlobalTiming | undefined {
  if (!manifest) return undefined;
  const { fullEvidenceTimeoutMs: timeout, fullEvidenceBudgetMs: budget, fullEvidenceMaxTimeoutsPerTable: max } = manifest;
  if (timeout === undefined && budget === undefined && max === undefined) return undefined;
  return createGlobalTiming({ queryTimeoutMs: timeout as number | undefined, budgetMs: budget as number | undefined, maxTimeoutsPerTable: max as number | undefined });
}

export const isTimeoutError = (error: unknown) => (error as { code?: unknown } | null | undefined)?.code === 'TIMEOUT';

/** Why a heavy read must not be sent now, or undefined when it may be. `ignoreTableLimit` is for the F1 fallback of a timed-out F1x (cheap, and the whole point of the fallback). */
export function timingGate(timing: GlobalTiming | undefined, tables: readonly string[], options: { ignoreTableLimit?: boolean } = {}): { block: GlobalTimingBlock; detail: string } | undefined {
  if (!timing) return undefined;
  const { policy, state } = timing;
  if (policy.budgetMs !== undefined && state.spentMs >= policy.budgetMs) return { block: 'TIME_BUDGET_EXHAUSTED', detail: `global evidence spent ${state.spentMs} of ${policy.budgetMs} ms` };
  if (!options.ignoreTableLimit) {
    for (const table of tables) {
      const timeouts = state.timeouts.get(table) ?? 0;
      if (timeouts >= policy.maxTimeoutsPerTable) return { block: 'TABLE_TIMEOUT_LIMIT', detail: `${table}: ${timeouts} timeouts (limit ${policy.maxTimeoutsPerTable})` };
    }
  }
  return undefined;
}
export function recordSkipped(timing: GlobalTiming | undefined) { if (timing) timing.state.skipped++; }

export type TimedClient = Pick<Zetaris, 'runSql'>;
/**
 * One global-evidence read through the client, with the policy's timeout and its clock. The error of a failed read is rethrown unchanged (callers keep their own handling);
 * a TIMEOUT also counts against every table the read touched. Without a timing object this is exactly `client.runSql(sql, limit)` (no third argument, as before).
 */
export async function timedRunSql(timing: GlobalTiming | undefined, client: TimedClient, sql: string, limit: number, tables: readonly string[], extra?: { limitCeiling?: number }) {
  const timeoutMs = timing?.policy.queryTimeoutMs, options = timeoutMs !== undefined || extra ? { ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...extra } : undefined;
  const started = performance.now();
  if (timing) timing.state.sent++;
  try { return await (client.runSql as (sql: string, limit: number, options?: unknown) => ReturnType<TimedClient['runSql']>)(sql, limit, ...(options ? [options] : [])); } catch (error) {
    if (timing && isTimeoutError(error)) { timing.state.timedOut++; for (const table of new Set(tables)) timing.state.timeouts.set(table, (timing.state.timeouts.get(table) ?? 0) + 1); }
    throw error;
  } finally { if (timing) timing.state.spentMs += Math.round(performance.now() - started); }
}
