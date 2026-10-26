import { identifier, type Cell, type Zetaris } from '../clients/zetaris.ts';
import { zetarisSourceQuery, type ZetarisTableSpec } from '../relations/adapters/zetaris.ts';
import { isTimeoutError, recordSkipped, timedRunSql, timingGate, type GlobalTiming } from './global-timing.ts';

/**
 * Round 10 (E3-05, E1-06): the profile of ONE column over the WHOLE table, as the closed forms F1 / F1x measure it, and the per-run cache that makes each column be
 * scanned once per run.
 *
 * Provenance is never implied: a profile is either measured over the whole table (GLOBAL_WHOLE_TABLE) or NOT_MEASURED with the reason. Nothing here is a sample.
 */
export type ProfileProvenance = 'GLOBAL_WHOLE_TABLE' | 'NOT_MEASURED';
export type ProfileNotMeasuredReason = 'COLUMN_OUTSIDE_CONFIG' | 'QUERY_FAILED' | 'MALFORMED_RESPONSE' | 'QUERY_BUDGET_INSUFFICIENT' | 'TIMEOUT' | 'TIME_BUDGET_EXHAUSTED';
/** F1 = counts only; F1x = counts plus MIN, MAX and the average text length of the key, in the same single scan. */
export type ProfileForm = 'F1' | 'F1x';

export interface MeasuredColumnProfile {
  table: string; column: string;
  provenance: 'GLOBAL_WHOLE_TABLE';
  form: ProfileForm;
  /** COUNT(*) of the table. */
  rows: number;
  /** COUNT(DISTINCT column): NULL is not counted. */
  distinct: number;
  /** Rows where the column is NULL. */
  nulls: number;
  /** F1x only. Absent when the column has no non-null value. Values come back from the engine as it types them (a number or a string). */
  min?: Cell; max?: Cell;
  /** F1x only: AVG(LENGTH(CAST(column AS STRING))) over the non-null values. */
  avgLen?: number;
  /** Present when F1x was asked for and timed out (C3): these are the F1 counts, without min/max/avgLen. The extended profile of this column is NOT measured. */
  fellBackFrom?: 'F1x';
}
export interface NotMeasuredColumnProfile { table: string; column: string; provenance: 'NOT_MEASURED'; reason: ProfileNotMeasuredReason; detail?: string }
export type ColumnProfile = MeasuredColumnProfile | NotMeasuredColumnProfile;

/** Cache key of a per-run profile: `table.column`. */
export const profileCacheKey = (endpoint: { table: string; column: string }) => `${endpoint.table}.${endpoint.column}`;

export interface ProfileEndpoint { table: string; column: string; spec: ZetarisTableSpec }
export interface ProfileQuery { form: ProfileForm; sql: string; requestId: string; queryId: string; durationMs: number; ok: boolean; errorCode?: string; /** True when the answer was served from the per-run cache: no query was sent for this use. */ cached?: true }
/** `failed`: the F1x attempt that timed out before `query` (the F1 that answered) was sent. Both were sent, both are charged and both belong in the report. */
export interface ProfileMeasurement { profile: ColumnProfile; query: ProfileQuery; failed?: ProfileQuery }
export type ProfileClient = Pick<Zetaris, 'runSql'>;
type ProfileCounts = Omit<MeasuredColumnProfile, 'table' | 'column' | 'provenance' | 'form'>;

/**
 * Per-run cache of whole-table column profiles, keyed `table.column` and shared by every consumer of the run (measureFullEvidence, measureTieEvidence). A dimension table
 * (date_dim, item, customer, store) that many fact tables point at is scanned ONCE per run, not once per relation. Only MEASURED profiles are kept: a failed query is not
 * remembered, so a later relation may try again (and pays for it). An F1x profile also answers an F1 request (it holds the same counts); the opposite is a miss.
 * Exception (C3): a column whose F1x timed out is remembered in `f1xTimedOut`; its later F1x requests go straight to F1, and the F1 that answered the first one serves them
 * (it carries `fellBackFrom: 'F1x'`), so the run never pays the same F1x timeout twice.
 */
export interface ProfileCache {
  readonly entries: Map<string, { profile: MeasuredColumnProfile; query: ProfileQuery }>;
  readonly pending: Map<string, Promise<ProfileMeasurement>>;
  readonly f1xTimedOut: Set<string>;
  /** `queries` = scans actually sent; `hits` = uses served without a scan. */
  stats: { queries: number; hits: number };
}
export function createProfileCache(): ProfileCache { return { entries: new Map(), pending: new Map(), f1xTimedOut: new Set(), stats: { queries: 0, hits: 0 } }; }

/** A cached profile answers an F1x request when it is an F1x, or an F1 that already stands for a timed-out F1x of that column. */
const answersExtended = (profile: MeasuredColumnProfile) => profile.form === 'F1x' || profile.fellBackFrom === 'F1x';
/** The profile this run already measured for the endpoint and form (an F1x also serves an F1), or undefined. Reading it spends nothing. */
export function cachedProfile(cache: ProfileCache | undefined, endpoint: { table: string; column: string }, extended: boolean): MeasuredColumnProfile | undefined {
  const hit = cache?.entries.get(profileCacheKey(endpoint));
  return hit && (!extended || answersExtended(hit.profile)) ? hit.profile : undefined;
}

/** The manifest declares F1x with its own boolean field, `fullEvidenceExtendedProfile: true` (X3 f56e041; engine.ts `extendedProfileOf` reads the same field). Anything else (absent, "true", 1, the old nested `fullEvidence.extendedProfile`) is off. */
export const extendedProfileDeclared = (manifest: { fullEvidenceExtendedProfile?: unknown } | undefined | null): boolean => manifest?.fullEvidenceExtendedProfile === true;

const source = (endpoint: ProfileEndpoint) => zetarisSourceQuery(endpoint.spec);
export const profileSql = (endpoint: ProfileEndpoint) => {
  const k = identifier(endpoint.column);
  return `SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT ${k}) AS concordia_distinct, SUM(CASE WHEN ${k} IS NULL THEN 1 ELSE 0 END) AS concordia_nulls FROM ${source(endpoint)}`;
};
export const extendedProfileSql = (endpoint: ProfileEndpoint) => {
  const k = identifier(endpoint.column);
  return `SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT ${k}) AS concordia_distinct, SUM(CASE WHEN ${k} IS NULL THEN 1 ELSE 0 END) AS concordia_nulls, MIN(${k}) AS concordia_min, MAX(${k}) AS concordia_max, AVG(LENGTH(CAST(${k} AS STRING))) AS concordia_avg_len FROM ${source(endpoint)}`;
};

/** A count is a non-negative safe integer, as a number or a digit string; anything else is a malformed response. */
export function parseCount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}
function parseLength(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Reads the one-row answer of F1 or F1x. Null is a malformed response (wrong shape, impossible counts, an F1x answer without its extra columns). */
export function parseProfile(rows: Cell[][], extended: boolean): ProfileCounts | null {
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (extended && row.length < 6) return null;
  const r = parseCount(row[0]), d = parseCount(row[1]), n = parseCount(row[2] ?? 0);
  // SUM over an empty table is NULL: that is 0 nulls only when there are no rows.
  const nulls = row[2] === null && r === 0 ? 0 : n;
  if (r === null || d === null || nulls === null || nulls > r || d > r - nulls) return null;
  const counts: ProfileCounts = { rows: r, distinct: d, nulls };
  if (!extended || r - nulls === 0) return counts; // no non-null value: MIN/MAX/AVG are NULL by definition, nothing to report
  const [min, max] = [row[3], row[4]], avgLen = parseLength(row[5]);
  if (min === null || min === undefined || max === null || max === undefined || avgLen === null) return null;
  return { ...counts, min, max, avgLen };
}

/**
 * Measures (or serves from the cache) the whole-table profile of one column. `extended` selects F1x. Never throws: a query that fails or answers something malformed is a
 * NOT_MEASURED profile with the reason, and the caller's caveat stays. A cache hit is reported with `query.cached = true` (the original request/query ids are kept for provenance).
 *
 * C3 (R10 live): an F1x that times out is retried ONCE as the plain F1 (counts only: no MIN, MAX or CAST/LENGTH, so a cheaper scan). The F1 that answers carries
 * `fellBackFrom: 'F1x'` (the extended profile of the column is not measured, and says so), the timed-out attempt comes back in `failed`, and the cache remembers the column so
 * no later request of the run pays that timeout again. An F1 that times out is not retried. With a `timing` policy the reads use its timeout and are skipped once the table or
 * the run is over its limits (reason TIME_BUDGET_EXHAUSTED); the fallback ignores the per-table limit but not the run's time budget.
 */
export async function measureColumnProfile(input: { client: ProfileClient; endpoint: ProfileEndpoint; extended?: boolean; cache?: ProfileCache; timing?: GlobalTiming }): Promise<ProfileMeasurement> {
  const { client, endpoint, cache, timing } = input, key = profileCacheKey(endpoint);
  // A column whose F1x already timed out in this run is asked as F1 from the start.
  const extended = input.extended === true && !cache?.f1xTimedOut.has(key), form: ProfileForm = extended ? 'F1x' : 'F1';
  const notMeasured = (reason: ProfileNotMeasuredReason, query: ProfileQuery, detail?: string, failed?: ProfileQuery): ProfileMeasurement => ({ profile: { table: endpoint.table, column: endpoint.column, provenance: 'NOT_MEASURED', reason, ...(detail ? { detail } : {}) }, query, ...(failed ? { failed } : {}) });
  const empty: ProfileQuery = { form, sql: '', requestId: '', queryId: '', durationMs: 0, ok: false };
  let sql: string;
  try {
    if (!endpoint.spec.columns.some(column => column.name === endpoint.column)) return notMeasured('COLUMN_OUTSIDE_CONFIG', empty);
    sql = extended ? extendedProfileSql(endpoint) : profileSql(endpoint);
  } catch { return notMeasured('COLUMN_OUTSIDE_CONFIG', empty); }

  const reused = (measurement: ProfileMeasurement): ProfileMeasurement => ({ profile: measurement.profile, query: { ...measurement.query, cached: true } });
  if (cache) {
    const hit = cache.entries.get(key);
    if (hit && (!extended || hit.profile.form === 'F1x')) { cache.stats.hits++; return reused(hit); }
    // The same column asked for twice at once shares the one query already in flight (an F1x in flight also answers an F1 request).
    const inflight = cache.pending.get(`${key}|F1x`) ?? (extended ? undefined : cache.pending.get(`${key}|F1`));
    if (inflight) {
      const shared = await inflight;
      if (shared.profile.provenance !== 'GLOBAL_WHOLE_TABLE') return shared;
      cache.stats.hits++;
      return reused(shared);
    }
  }
  const blocked = timingGate(timing, [endpoint.table]);
  if (blocked) { recordSkipped(timing); return notMeasured('TIME_BUDGET_EXHAUSTED', { ...empty, errorCode: blocked.block }, blocked.detail); }

  type Attempt = { answer: Awaited<ReturnType<ProfileClient['runSql']>> } | { failed: ProfileQuery; timedOut: boolean };
  const attempt = async (attemptForm: ProfileForm, text: string): Promise<Attempt> => {
    try { const answer = await timedRunSql(timing, client, text, 1, [endpoint.table]); if (cache) cache.stats.queries++; return { answer }; } catch (error) {
      if (cache) cache.stats.queries++;
      return { timedOut: isTimeoutError(error), failed: { form: attemptForm, sql: text, requestId: '', queryId: '', durationMs: 0, ok: false, errorCode: String((error as { code?: unknown })?.code ?? (error as Error)?.message ?? 'QUERY_FAILED') } };
    }
  };
  const run = async (): Promise<ProfileMeasurement> => {
    let usedForm = form, usedSql = sql, first = await attempt(form, sql), timedOutExtended: ProfileQuery | undefined;
    if ('failed' in first && extended && first.timedOut) {
      cache?.f1xTimedOut.add(key);
      timedOutExtended = first.failed;
      const budgetGate = timingGate(timing, [], { ignoreTableLimit: true });
      if (budgetGate) { recordSkipped(timing); return notMeasured('TIMEOUT', timedOutExtended, `F1x timed out; F1 fallback skipped: ${budgetGate.detail}`); }
      usedForm = 'F1'; usedSql = profileSql(endpoint); first = await attempt('F1', usedSql);
    }
    if ('failed' in first) return notMeasured(first.timedOut ? 'TIMEOUT' : 'QUERY_FAILED', first.failed, undefined, timedOutExtended);
    const { answer } = first;
    const query: ProfileQuery = { form: usedForm, sql: usedSql, requestId: answer.requestId, queryId: answer.queryId, durationMs: answer.durationMs, ok: true };
    const parsed = parseProfile(answer.rows, usedForm === 'F1x');
    if (!parsed) return notMeasured('MALFORMED_RESPONSE', query, undefined, timedOutExtended);
    const profile: MeasuredColumnProfile = { table: endpoint.table, column: endpoint.column, provenance: 'GLOBAL_WHOLE_TABLE', form: usedForm, ...parsed, ...(timedOutExtended ? { fellBackFrom: 'F1x' as const } : {}) };
    cache?.entries.set(key, { profile, query });
    return { profile, query, ...(timedOutExtended ? { failed: timedOutExtended } : {}) };
  };
  if (!cache) return run();
  const slot = `${key}|${form}`, promise = run().finally(() => { cache.pending.delete(slot); });
  cache.pending.set(slot, promise);
  return promise;
}
