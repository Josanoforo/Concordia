import { identifier, type Cell, type Zetaris } from '../clients/zetaris.ts';
import type { EvidenceBundle, EvidenceObservation } from '../contracts/types.ts';
import { GLOBAL_COVERAGE_OBSERVATION, GLOBAL_COVERAGE_PROJECTION, GLOBAL_UNIQUENESS_OBSERVATION, GLOBAL_UNIQUENESS_PROJECTION } from '../relations/decision.ts';
import { zetarisSourceQuery, type ZetarisTableSpec } from '../relations/adapters/zetaris.ts';
import { measureColumnProfile, parseCount, profileSql, type MeasuredColumnProfile, type ProfileCache } from './column-profile.ts';
import { isTimeoutError, recordSkipped, timedRunSql, timingGate, type GlobalTiming } from './global-timing.ts';

/**
 * P3 (Round 9): full-evidence mode. Read-only aggregate queries over the WHOLE tables of one relation that turn the two declared caveats of a SOSTENIDA verdict
 * (global_coverage_not_established, global_uniqueness_not_established) into measurements. The SQL is exactly the closed forms F1/F2/F3a/F3b of
 * RONDA9_CONTRATO_SQL_FULL_EVIDENCE, accepted by the read guard in src/clients/zetaris.ts; nothing leaves the source but counts (and, only on request, a bounded
 * sample of offending keys).
 *
 * Honest by construction: a dimension that was not fully measured is reported NOT_MEASURED with a reason and produces NO observation, so the policy keeps its caveat.
 * Nothing here decides a verdict; src/relations/decision.ts reads the observations built here.
 */
/** The observation types and projections are defined next to the policy that reads them (decision.ts accepts only these exact shapes). */
export { GLOBAL_COVERAGE_OBSERVATION, GLOBAL_UNIQUENESS_OBSERVATION, GLOBAL_COVERAGE_PROJECTION, GLOBAL_UNIQUENESS_PROJECTION };
export { profileSql };
export const DUPLICATE_SAMPLE_DEFAULT = 20, MISSING_SAMPLE_DEFAULT = 20;

export type FullEvidenceForm = 'F1_SOURCE' | 'F1_TARGET' | 'F2' | 'F3A' | 'F3B' | 'F3C';
/** TIMEOUT: the query timed out. TIME_BUDGET_EXHAUSTED: it was not sent because the table or the run is over its global-evidence time limits (C3, see global-timing.ts). */
export type NotMeasuredReason = 'TYPE_MISMATCH' | 'TYPE_UNKNOWN' | 'COLUMN_OUTSIDE_CONFIG' | 'SOURCE_EMPTY' | 'MALFORMED_RESPONSE' | 'QUERY_FAILED' | 'TIMEOUT' | 'TIME_BUDGET_EXHAUSTED';
export interface FullEvidenceQuery { form: FullEvidenceForm; sql: string; requestId: string; queryId: string; durationMs: number; ok: boolean; errorCode?: string; /** Served from the per-run profile cache: no query was sent for this relation. */ cached?: true }
/** Counts of one column over the whole table; min/max/avgLen only when the manifest asked for the extended profile (F1x). */
export type GlobalProfile = Pick<MeasuredColumnProfile, 'rows' | 'distinct' | 'nulls' | 'min' | 'max' | 'avgLen'>;
export type DimensionResult<T> = ({ status: 'MEASURED' } & T) | { status: 'NOT_MEASURED'; reason: NotMeasuredReason; detail?: string };
/**
 * Orphans counted in ROWS (F3c) next to the orphans counted in distinct keys (F3b): missingRows over the source rows whose key is not NULL. Measured and reported, not used by
 * the policy in Round 10 (the tolerance still reads the distinct-key ratio). With F3b = 0 there are no orphan rows either, so F3c is not sent (measuredBy DERIVED_FROM_F3B_ZERO).
 */
export interface RowCoverage { sourceNonNullRows: number; /** Source rows whose key is NULL: never orphans, reported on their own. */ sourceNulls: number; missingRows: number; ratio: number; measuredBy: 'F3C' | 'DERIVED_FROM_F3B_ZERO' }
export interface CoverageMeasure { sourceDistinct: number; missing: number; ratio: number; complete: boolean; missingSample?: Cell[]; rows?: RowCoverage; rowsNotMeasured?: { reason: NotMeasuredReason } }
export interface UniquenessMeasure { rows: number; distinct: number; nulls: number; unique: boolean; duplicateSample?: { key: Cell; count: Cell }[] }
export interface FullEvidence {
  schemaVersion: 1; relationId: string; scope: 'GLOBAL_WHOLE_TABLE'; checkedAt: string;
  coverage: DimensionResult<CoverageMeasure>;
  uniqueness: DimensionResult<UniquenessMeasure>;
  source?: GlobalProfile; target?: GlobalProfile;
  queries: FullEvidenceQuery[];
  /** Reads NOT sent because the global-evidence time policy blocked them (no query, no budget charge). */
  skipped?: { form: FullEvidenceForm; reason: 'TABLE_TIMEOUT_LIMIT' | 'TIME_BUDGET_EXHAUSTED'; detail: string }[];
}
export interface FullEvidenceEndpoint { table: string; column: string; /** Declared type from the universe config (or DESCRIBE). Both sides must declare the same one. */ type?: string; spec: ZetarisTableSpec; sourceId: string }
export type FullEvidenceClient = Pick<Zetaris, 'runSql'>;

/** Queries per relation, for the budget pre-estimation (P1/P7): F1 on each side and F3b always; F2 only when the target repeats a key; F3c (orphans by rows) only when F3b found orphans; F3a/F2 samples are opt-in. A cached F1 (same table.column in the run) costs no query. */
export const FULL_EVIDENCE_MIN_QUERIES = 3, FULL_EVIDENCE_MAX_QUERIES = 6;

// --- SQL (the closed forms; the guard in zetaris.ts matches them part by part) ---
const source = (endpoint: FullEvidenceEndpoint) => zetarisSourceQuery(endpoint.spec);
const assertColumn = (endpoint: FullEvidenceEndpoint) => { identifier(endpoint.column); return endpoint.spec.columns.some(column => column.name === endpoint.column); };
export const duplicateKeysSql = (endpoint: FullEvidenceEndpoint, limit: number) => {
  const k = identifier(endpoint.column);
  return `SELECT ${k}, COUNT(*) AS concordia_count FROM ${source(endpoint)} GROUP BY ${k} HAVING COUNT(*) > 1 LIMIT ${boundedSample(limit)}`;
};
const antiJoin = (from: FullEvidenceEndpoint, to: FullEvidenceEndpoint) =>
  `FROM (SELECT DISTINCT ${identifier(from.column)} AS k FROM ${source(from)} WHERE ${identifier(from.column)} IS NOT NULL) concordia_s LEFT JOIN (SELECT DISTINCT ${identifier(to.column)} AS k FROM ${source(to)}) concordia_t ON concordia_s.k = concordia_t.k WHERE concordia_t.k IS NULL`;
export const missingCountSql = (from: FullEvidenceEndpoint, to: FullEvidenceEndpoint) => `SELECT COUNT(*) AS concordia_missing ${antiJoin(from, to)}`;
/** F3c. The source carries the alias concordia_s itself (a subquery cannot take a second alias), the target side is the distinct key set, and no NOT IN: a NULL in the target would hide every orphan. */
export const missingRowsSql = (from: FullEvidenceEndpoint, to: FullEvidenceEndpoint) => {
  const s = identifier(from.column), t = identifier(to.column);
  return `SELECT COUNT(*) AS concordia_missing_rows FROM ${source(from).replace(/ concordia_source$/, ' concordia_s')} LEFT JOIN (SELECT DISTINCT ${t} AS k FROM ${source(to)}) concordia_t ON concordia_s.${s} = concordia_t.k WHERE concordia_s.${s} IS NOT NULL AND concordia_t.k IS NULL`;
};
export const missingSampleSql = (from: FullEvidenceEndpoint, to: FullEvidenceEndpoint, limit: number) => `SELECT concordia_s.k ${antiJoin(from, to)} LIMIT ${boundedSample(limit)}`;
function boundedSample(limit: number): number { if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('FULL_EVIDENCE_SAMPLE_LIMIT_OUT_OF_RANGE'); return limit; }

const count = parseCount;
const sameType = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Measures global coverage (every distinct non-null source key exists in the target) and global target uniqueness for ONE relation.
 * Preconditions that keep a dimension NOT_MEASURED (the caveat stays): the two declared types differ or are missing (never CAST); a column is outside the configured
 * allowlist; a query fails or answers something other than the closed form's shape. Each query goes through `client.runSql`, so the run budget charges it.
 */
export async function measureFullEvidence(input: { client: FullEvidenceClient; relationId: string; from: FullEvidenceEndpoint; to: FullEvidenceEndpoint; checkedAt: string; duplicateSample?: number; missingSample?: number; sampleMissingKeys?: boolean; /** Per-run profile cache (E1-06): a target scanned for another relation of the run is not scanned again. */ cache?: ProfileCache; /** Manifest `fullEvidence.extendedProfile: true`: F1x (MIN, MAX, average length) replaces F1 in the same single scan. */ extendedProfile?: boolean; /** F3c, orphans counted in rows, when F3b found orphans. On by default; false saves that query. */ orphanRows?: boolean; /** C3: the global-evidence time policy (timeout of its own, per-table timeout limit, run time budget). Absent = the client's default timeout and no limits, as before. */ timing?: GlobalTiming }): Promise<FullEvidence> {
  const { client, from, to } = input, queries: FullEvidenceQuery[] = [], extended = input.extendedProfile === true;
  const result: FullEvidence = { schemaVersion: 1, relationId: input.relationId, scope: 'GLOBAL_WHOLE_TABLE', checkedAt: input.checkedAt, coverage: { status: 'NOT_MEASURED', reason: 'QUERY_FAILED' }, uniqueness: { status: 'NOT_MEASURED', reason: 'QUERY_FAILED' }, queries };
  const notMeasured = (reason: NotMeasuredReason, detail?: string) => { result.coverage = { status: 'NOT_MEASURED', reason, ...(detail ? { detail } : {}) }; result.uniqueness = { status: 'NOT_MEASURED', reason, ...(detail ? { detail } : {}) }; return result; };
  if (!assertColumn(from) || !assertColumn(to)) return notMeasured('COLUMN_OUTSIDE_CONFIG');
  if (!from.type || !to.type) return notMeasured('TYPE_UNKNOWN', `${from.type ?? 'unknown'}/${to.type ?? 'unknown'}`);
  if (!sameType(from.type, to.type)) return notMeasured('TYPE_MISMATCH', `${from.type}/${to.type}`);

  const { timing } = input, tables = [from.table, to.table];
  /** Why the last heavy read produced no rows: the NOT_MEASURED reason of the dimension that needed it. */
  let lastFailure: NotMeasuredReason = 'QUERY_FAILED';
  const run = async (form: FullEvidenceForm, sql: string): Promise<Cell[][] | null> => {
    const blocked = timingGate(timing, tables);
    if (blocked) { recordSkipped(timing); (result.skipped ??= []).push({ form, reason: blocked.block, detail: blocked.detail }); lastFailure = 'TIME_BUDGET_EXHAUSTED'; return null; }
    try {
      const answer = await timedRunSql(timing, client, sql, form === 'F2' || form === 'F3A' ? 50 : 1, tables);
      queries.push({ form, sql, requestId: answer.requestId, queryId: answer.queryId, durationMs: answer.durationMs, ok: true });
      return answer.rows;
    } catch (error) {
      queries.push({ form, sql, requestId: '', queryId: '', durationMs: 0, ok: false, errorCode: String((error as { code?: unknown })?.code ?? (error as Error)?.message ?? 'QUERY_FAILED') });
      lastFailure = isTimeoutError(error) ? 'TIMEOUT' : 'QUERY_FAILED';
      return null;
    }
  };
  /** F1 / F1x of one endpoint, through the per-run cache. A cached answer is recorded with `cached: true` so the report shows that no query was sent. */
  const profile = async (form: 'F1_SOURCE' | 'F1_TARGET', endpoint: FullEvidenceEndpoint) => {
    const measurement = await measureColumnProfile({ client, endpoint, extended, cache: input.cache, timing });
    // An F1x that timed out and fell back to F1 sent two queries: both are reported (the first as a failed F1x).
    if (measurement.failed) queries.push({ ...measurement.failed, form });
    queries.push({ ...measurement.query, form });
    return measurement.profile;
  };
  const globalOf = (measured: MeasuredColumnProfile): GlobalProfile => ({ rows: measured.rows, distinct: measured.distinct, nulls: measured.nulls, ...(measured.min !== undefined ? { min: measured.min } : {}), ...(measured.max !== undefined ? { max: measured.max } : {}), ...(measured.avgLen !== undefined ? { avgLen: measured.avgLen } : {}) });
  const failure = (measured: Extract<Awaited<ReturnType<typeof profile>>, { provenance: 'NOT_MEASURED' }>, detail: string) => ({ status: 'NOT_MEASURED' as const, reason: (measured.reason === 'MALFORMED_RESPONSE' || measured.reason === 'TIMEOUT' || measured.reason === 'TIME_BUDGET_EXHAUSTED' ? measured.reason : 'QUERY_FAILED') as NotMeasuredReason, detail });

  // Uniqueness: F1 over the target. Target keys are unique when every non-null row carries a different key.
  const targetProfile = await profile('F1_TARGET', to);
  if (targetProfile.provenance === 'NOT_MEASURED') result.uniqueness = failure(targetProfile, 'F1_TARGET');
  else {
    const global = globalOf(targetProfile);
    result.target = global;
    const unique = targetProfile.rows - targetProfile.nulls === targetProfile.distinct;
    let duplicateSample: UniquenessMeasure['duplicateSample'];
    if (!unique) {
      const duplicates = await run('F2', duplicateKeysSql(to, input.duplicateSample ?? DUPLICATE_SAMPLE_DEFAULT));
      if (duplicates) duplicateSample = duplicates.map(row => ({ key: row[0], count: row[1] }));
    }
    result.uniqueness = { status: 'MEASURED', rows: targetProfile.rows, distinct: targetProfile.distinct, nulls: targetProfile.nulls, unique, ...(duplicateSample ? { duplicateSample } : {}) };
  }

  // Coverage: F1 over the source (its distinct key count), F3b (source keys with no match in the target) and F3c (the same orphans counted in rows).
  const sourceProfile = await profile('F1_SOURCE', from);
  if (sourceProfile.provenance === 'NOT_MEASURED') result.coverage = failure(sourceProfile, 'F1_SOURCE');
  else {
    result.source = globalOf(sourceProfile);
    if (sourceProfile.distinct === 0) result.coverage = { status: 'NOT_MEASURED', reason: 'SOURCE_EMPTY' };
    else {
      const missingRows = await run('F3B', missingCountSql(from, to));
      const missing = missingRows && missingRows.length === 1 ? count(missingRows[0][0]) : null;
      if (!missingRows) result.coverage = { status: 'NOT_MEASURED', reason: lastFailure, detail: 'F3B' };
      else if (missing === null || missing > sourceProfile.distinct) result.coverage = { status: 'NOT_MEASURED', reason: 'MALFORMED_RESPONSE', detail: 'F3B' };
      else {
        let missingSample: Cell[] | undefined;
        if (missing > 0 && input.sampleMissingKeys) { const sample = await run('F3A', missingSampleSql(from, to, input.missingSample ?? MISSING_SAMPLE_DEFAULT)); if (sample) missingSample = sample.map(row => row[0]); }
        const coverage: CoverageMeasure = { sourceDistinct: sourceProfile.distinct, missing, ratio: (sourceProfile.distinct - missing) / sourceProfile.distinct, complete: missing === 0 };
        if (missingSample) coverage.missingSample = missingSample;
        // Orphans by rows. No orphan key means no orphan row, so that case needs no query. Every orphan key holds at least one row, and no more than the non-null source rows.
        const nonNull = sourceProfile.rows - sourceProfile.nulls;
        if (missing === 0) coverage.rows = { sourceNonNullRows: nonNull, sourceNulls: sourceProfile.nulls, missingRows: 0, ratio: 1, measuredBy: 'DERIVED_FROM_F3B_ZERO' };
        else if (input.orphanRows !== false) {
          const rowsAnswer = await run('F3C', missingRowsSql(from, to));
          const orphanRows = rowsAnswer && rowsAnswer.length === 1 ? count(rowsAnswer[0][0]) : null;
          if (!rowsAnswer) coverage.rowsNotMeasured = { reason: lastFailure };
          else if (orphanRows === null || orphanRows < missing || orphanRows > nonNull) coverage.rowsNotMeasured = { reason: 'MALFORMED_RESPONSE' };
          else coverage.rows = { sourceNonNullRows: nonNull, sourceNulls: sourceProfile.nulls, missingRows: orphanRows, ratio: (nonNull - orphanRows) / nonNull, measuredBy: 'F3C' };
        }
        result.coverage = { status: 'MEASURED', ...coverage };
      }
    }
  }
  return result;
}

function observation(bundle: EvidenceBundle, kind: typeof GLOBAL_COVERAGE_OBSERVATION | typeof GLOBAL_UNIQUENESS_OBSERVATION, sourceRef: string, column: string, projection: readonly string[], tuple: number[], used: FullEvidenceQuery[], checkedAt: string): EvidenceObservation {
  const last = used[used.length - 1];
  return {
    observationId: `${bundle.evidenceBundleId}:${kind.toLowerCase()}`, type: kind, sourceRef, adapterId: 'full-evidence-aggregate',
    requestId: last?.requestId ? { state: 'KNOWN', value: used.map(query => query.requestId).join('+') } : { state: 'UNKNOWN' }, observedAt: { state: 'UNKNOWN' }, checkedAt,
    nativeVersion: { state: 'UNKNOWN' }, fingerprint: { state: 'UNKNOWN' }, projection: [...projection], filters: [`column=${column}`, `forms=${used.map(query => query.form).join(',')}`, 'scope=whole table'],
    limit: 'UNKNOWN', measuredTuples: [tuple], nullCount: 'UNKNOWN', duplicateCount: 'UNKNOWN', truncated: false, transportStatus: 'OK', protectedPayloadRef: { state: 'UNKNOWN' }
  };
}
/**
 * Appends one observation per MEASURED dimension to the bundle (coverage anchored on the source endpoint, uniqueness on the target endpoint). A dimension that is
 * NOT_MEASURED adds nothing: the policy then keeps its caveat. Returns the observation types added.
 */
export function attachFullEvidence(bundle: EvidenceBundle, evidence: FullEvidence, endpoints: { from: FullEvidenceEndpoint; to: FullEvidenceEndpoint }): string[] {
  const added: string[] = [], forms = (...wanted: FullEvidenceForm[]) => evidence.queries.filter(query => query.ok && wanted.includes(query.form));
  bundle.observations = bundle.observations.filter(item => item.type !== GLOBAL_COVERAGE_OBSERVATION && item.type !== GLOBAL_UNIQUENESS_OBSERVATION);
  bundle.observations = bundle.observations.filter(item => item.type !== GLOBAL_COVERAGE_OBSERVATION && item.type !== GLOBAL_UNIQUENESS_OBSERVATION);
  if (evidence.coverage.status === 'MEASURED') {
    bundle.observations.push(observation(bundle, GLOBAL_COVERAGE_OBSERVATION, endpoints.from.sourceId, endpoints.from.column, GLOBAL_COVERAGE_PROJECTION, [evidence.coverage.sourceDistinct, evidence.coverage.missing], forms('F1_SOURCE', 'F3B'), evidence.checkedAt));
    added.push(GLOBAL_COVERAGE_OBSERVATION);
  }
  if (evidence.uniqueness.status === 'MEASURED') {
    bundle.observations.push(observation(bundle, GLOBAL_UNIQUENESS_OBSERVATION, endpoints.to.sourceId, endpoints.to.column, GLOBAL_UNIQUENESS_PROJECTION, [evidence.uniqueness.rows, evidence.uniqueness.distinct, evidence.uniqueness.nulls], forms('F1_TARGET'), evidence.checkedAt));
    added.push(GLOBAL_UNIQUENESS_OBSERVATION);
  }
  return added;
}
