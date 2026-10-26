import { createHash } from 'node:crypto';
import { identifier, type Cell, type SqlResult, type Zetaris } from '../clients/zetaris.ts';
import { zetarisSourceQuery, type ZetarisTableSpec } from '../relations/adapters/zetaris.ts';
import { SafeError } from '../runtime.ts';
import { recordSkipped, timedRunSql, timingGate, type GlobalTiming } from './global-timing.ts';

/**
 * P2 (Round 9): dispersed key sampling. The discovery sample is the first N rows of a table; on a table clustered by its keys (TPC-DS inventory, catalog_page) those rows
 * carry ONE distinct value of a key column (M12: inv_warehouse_sk, inv_date_sk, cp_end_date_sk), so the policy's minimum of 3 distinct keys can never be met.
 * Here the seeds come from the DISTINCT values of the key column (contract form F4) and a deterministic, seeded stride picks them across the sorted pool.
 * Nothing here decides a verdict: it only chooses which source keys the existing bounded probe will look up.
 */

/** Blind universes (no configured relations) read the source endpoint as distinct keys by default; a declared probeMode or an explicit override wins. */
export type ProbeMode = 'distinct-keys';
export const DEFAULT_BLIND_PROBE_MODE: ProbeMode = 'distinct-keys';
export function resolveProbeMode(input: { override?: string; declared?: string; blind: boolean }): ProbeMode | undefined {
  const chosen = input.override ?? input.declared ?? (input.blind ? DEFAULT_BLIND_PROBE_MODE : undefined);
  if (chosen !== undefined && chosen !== 'distinct-keys') throw new SafeError('PROBE_MODE_INVALID');
  return chosen;
}

/** Transport ceiling of one read (Zetaris.sendSql allows at most 100 rows); the F4 form itself admits LIMIT up to 999. */
export const SEED_POOL_LIMIT = 100;
/** Seeds handed to the probe: one below the 50-value filter cap, as probeUniverse does in distinct-keys mode. */
export const SEED_COUNT = 49;

/** Closed form F4 (RONDA9_CONTRATO_SQL_FULL_EVIDENCE): the distinct non-null values of one key column, bounded by LIMIT. */
export function distinctKeySampleSql(spec: ZetarisTableSpec, column: string, poolLimit = SEED_POOL_LIMIT): string {
  const key = identifier(column);
  if (!spec.columns.some(item => item.name === column)) throw new SafeError('SAMPLING_COLUMN_OUTSIDE_CONFIG');
  if (!Number.isInteger(poolLimit) || poolLimit < 1 || poolLimit > SEED_POOL_LIMIT) throw new SafeError('SAMPLING_POOL_LIMIT_OUT_OF_RANGE');
  return `SELECT DISTINCT ${key} FROM ${zetarisSourceQuery(spec)} WHERE ${key} IS NOT NULL LIMIT ${poolLimit}`;
}

const NUMERIC = /^-?\d+$/;
function compareKeys(a: Cell, b: Cell): number {
  const left = String(a), right = String(b);
  if (NUMERIC.test(left) && NUMERIC.test(right)) { const x = BigInt(left), y = BigInt(right); return x < y ? -1 : x > y ? 1 : 0; }
  return left.localeCompare(right, 'en');
}
/** Same seed, same fraction in [0, 1): the offset of the stride, so a rerun picks the same keys and a different column picks a different phase. */
function seedFraction(seed: string): number {
  return createHash('sha256').update(seed, 'utf8').digest().readUIntBE(0, 6) / 2 ** 48;
}
/**
 * Dispersed pick: the distinct pool is sorted (numbers numerically) and `count` keys are taken at an even stride starting at a seeded offset, so the picks span the whole
 * pool instead of its first rows. A pool no larger than `count` is returned whole. Deterministic for (pool, count, seed); null/undefined cells are dropped.
 */
export function pickDispersed(pool: readonly Cell[], count: number, seed: string): Cell[] {
  if (!Number.isInteger(count) || count < 1) throw new SafeError('SAMPLING_COUNT_INVALID');
  const unique = [...new Map(pool.filter(value => value !== null && value !== undefined).map(value => [String(value), value])).values()].sort(compareKeys);
  if (unique.length <= count) return unique;
  const stride = unique.length / count, offset = seedFraction(seed) * stride;
  return Array.from({ length: count }, (_, index) => unique[Math.floor(offset + index * stride)]);
}

const specsOf = (cfg: any): Record<string, ZetarisTableSpec> => Object.fromEntries(Object.entries<any>(cfg.tables).map(([table, spec]) => [table, { db: spec.db ?? cfg.database, physicalTable: spec.physicalTable ?? table, columns: spec.columns, ...(spec.baseSql ? { baseSql: spec.baseSql } : {}) } as ZetarisTableSpec]));

export interface DispersedKeySeed {
  table: string; column: string; method: 'DISTINCT_POOL_STRIDE'; seed: string;
  /** Where the pool came from: the closed form F4 over the WHOLE table, never the first rows of the discovery sample. */
  source: 'GLOBAL_DISTINCT_F4';
  keys: Cell[];
  /** Distinct values read (at most SEED_POOL_LIMIT). */
  poolSize: number;
  /** True when the pool was smaller than the limit: the pool IS the whole distinct set of the column. */
  poolExhausted: boolean;
  sql: string; requestId: string; queryId: string;
}
export interface SeedFailure { table: string; column: string; code: string }
export type SeedClient = Pick<Zetaris, 'runSql'>;

/** One F4 read for one column, then the seeded stride. The seed is `<scope>:<table>.<column>` so every column gets its own phase. */
export async function sampleDistinctKeys(client: SeedClient, input: { table: string; column: string; spec: ZetarisTableSpec; scope: string; count?: number; poolLimit?: number; /** C3: the global-evidence time policy; F4 over a large fact table is the read that timed out live. */ timing?: GlobalTiming }): Promise<DispersedKeySeed> {
  const count = input.count ?? SEED_COUNT, poolLimit = input.poolLimit ?? SEED_POOL_LIMIT;
  const sql = distinctKeySampleSql(input.spec, input.column, poolLimit);
  const blocked = timingGate(input.timing, [input.table]);
  if (blocked) { recordSkipped(input.timing); throw new SafeError('TIME_BUDGET_EXHAUSTED', undefined, blocked.detail); }
  const result: SqlResult = await timedRunSql(input.timing, client, sql, poolLimit, [input.table], poolLimit > 50 ? { limitCeiling: poolLimit } : undefined);
  const pool = result.rows.map(row => row[0]);
  const seed = `${input.scope}:${input.table}.${input.column}`;
  return { table: input.table, column: input.column, method: 'DISTINCT_POOL_STRIDE', source: 'GLOBAL_DISTINCT_F4', seed, keys: pickDispersed(pool, count, seed), poolSize: new Set(pool.filter(value => value !== null && value !== undefined).map(String)).size,
    poolExhausted: result.rows.length < poolLimit, sql: result.sql ?? sql, requestId: result.requestId, queryId: result.queryId };
}

/** The distinct (table, column) source endpoints of a relation list: one F4 read each, never one per relation. */
export function seedTargetsOf(relations: readonly { from: { table: string; column: string } }[]): { table: string; column: string }[] {
  return [...new Map(relations.map(relation => [`${relation.from.table}.${relation.from.column}`, { table: relation.from.table, column: relation.from.column }])).values()];
}
/** Queries the dispersal costs, for the budget pre-estimation (P1/P7): exactly one F4 read per distinct source endpoint. */
export const estimateSeedQueries = (relations: readonly { from: { table: string; column: string } }[]) => seedTargetsOf(relations).length;

export interface DispersedSeedsResult { seeds: DispersedKeySeed[]; failures: SeedFailure[]; queries: number }
/**
 * Reads the dispersed seeds for the given source endpoints and records them on the discovery inventory (`tables[table].dispersedKeySeeds[column]`), where probeUniverse's
 * `seedValues` finds them. A failed read leaves the first-N-rows sample for that column untouched and is reported, never hidden. Sequential: each read is budgeted by the caller's client.
 */
export async function ensureDispersedSeeds(client: SeedClient, input: { cfg: any; discovery: any; targets: readonly { table: string; column: string }[]; scope: string; count?: number; poolLimit?: number; timing?: GlobalTiming }): Promise<DispersedSeedsResult> {
  const out: DispersedSeedsResult = { seeds: [], failures: [], queries: 0 };
  const specs = specsOf(input.cfg);
  for (const target of input.targets) {
    const entry = input.discovery.tables?.[target.table], spec = specs[target.table];
    if (!entry || !spec) { out.failures.push({ ...target, code: 'SAMPLING_TABLE_NOT_DISCOVERED' }); continue; }
    if (entry.dispersedKeySeeds?.[target.column]) continue;
    out.queries++;
    try {
      const seed = await sampleDistinctKeys(client, { ...target, spec, scope: input.scope, count: input.count, poolLimit: input.poolLimit, timing: input.timing });
      (entry.dispersedKeySeeds ??= {})[target.column] = seed; out.seeds.push(seed);
    } catch (error) { out.failures.push({ ...target, code: String((error as { code?: unknown })?.code ?? (error as Error)?.message ?? 'SAMPLING_READ_FAILED') }); }
  }
  return out;
}

/**
 * The seed values probeUniverse filters with: the dispersed distinct keys when they were read for this column, otherwise the non-null values of the first-N-rows discovery
 * sample (the previous behaviour, unchanged). Returns the raw cells; normalization stays the pipeline's.
 */
export function seedValues(table: { columns: readonly string[]; sample: { rows: readonly (readonly Cell[])[] }; dispersedKeySeeds?: Record<string, { keys: readonly Cell[] }> }, column: string): Cell[] {
  const dispersed = table.dispersedKeySeeds?.[column];
  if (dispersed?.keys.length) return [...dispersed.keys];
  const index = table.columns.indexOf(column);
  return index < 0 ? [] : table.sample.rows.map(row => row[index]).filter((value): value is Cell => value !== null && value !== undefined);
}

// --- E3-07a (Round 10): a source column whose discovery sample is degenerate gets its pool from F4 -------------------------------------------------------------------
/**
 * Post-COMA seeds the coverage probe of a candidate with the distinct values of the 20-row discovery sample. On tables stored in key order (inventory, catalog_page,
 * catalog_sales, store_sales: sorted by date or warehouse) those rows carry ONE value, below the policy minimum of distinct keys, and the probe cannot conclude (M12 again).
 * When the sample holds fewer than `minDistinctKeys` distinct values, the pool is read with the closed form F4 over the whole table and dispersed with the same seeded stride
 * as P2. A sample that is already enough is NOT replaced and costs nothing. The reader is injected (the same pattern as the column profiles): one per run, F4 once per column.
 */
export type PoolSource = 'DISCOVERY_SAMPLE' | 'GLOBAL_DISTINCT_F4';
export type PoolReason = 'SAMPLE_SUFFICIENT' | 'SAMPLE_BELOW_MINIMUM' | 'F4_FAILED' | 'F4_NOT_LARGER' | 'READER_ABSENT';
export interface SourcePoolTrace {
  source: PoolSource; reason: PoolReason;
  /** Distinct non-null values of the discovery sample, and the minimum that triggers the F4 read. */
  sampleDistinct: number; minDistinctKeys: number;
  /** Present when F4 was read for this column (here or earlier in the run). */
  f4?: { poolSize: number; poolExhausted: boolean; keysPicked: number; seed: string; sql: string; requestId: string; queryId: string; /** Served from the run's reader: no query for this use. */ cached?: true };
  failureCode?: string;
}
export interface WidenedPool { keys: Cell[]; trace: SourcePoolTrace }
export interface SourcePoolReader {
  widen(endpoint: { table: string; column: string }, sampled: readonly Cell[], minDistinctKeys: number): Promise<WidenedPool>;
  /** queries = F4 reads sent (failed ones too); hits = uses served without a read. */
  readonly stats: { queries: number; hits: number; failures: number };
}
const distinctCount = (values: readonly Cell[]) => new Set(values.filter(value => value !== null && value !== undefined).map(String)).size;

/** The reader for one run. `client` is the budgeted one: every F4 counts against the run. A failure is remembered for the run (one attempt per column) and leaves the sample. */
export function createSourcePoolReader(input: { client: SeedClient; cfg: any; scope: string; count?: number; poolLimit?: number; timing?: GlobalTiming }): SourcePoolReader {
  const specs = specsOf(input.cfg), reads = new Map<string, Promise<{ seed: DispersedKeySeed } | { code: string }>>(), stats = { queries: 0, hits: 0, failures: 0 };
  return {
    stats,
    async widen(endpoint, sampled, minDistinctKeys) {
      const sampleDistinct = distinctCount(sampled), base = { sampleDistinct, minDistinctKeys };
      if (sampleDistinct >= minDistinctKeys) return { keys: [...sampled], trace: { source: 'DISCOVERY_SAMPLE', reason: 'SAMPLE_SUFFICIENT', ...base } };
      const key = `${endpoint.table}.${endpoint.column}`, spec = specs[endpoint.table];
      if (!spec) return { keys: [...sampled], trace: { source: 'DISCOVERY_SAMPLE', reason: 'F4_FAILED', failureCode: 'SAMPLING_TABLE_NOT_DISCOVERED', ...base } };
      let read = reads.get(key), cached = true;
      if (!read) {
        cached = false; stats.queries++;
        read = sampleDistinctKeys(input.client, { ...endpoint, spec, scope: input.scope, count: input.count, poolLimit: input.poolLimit, timing: input.timing }).then(seed => ({ seed }), error => { stats.failures++; return { code: String((error as { code?: unknown })?.code ?? (error as Error)?.message ?? 'SAMPLING_READ_FAILED') }; });
        reads.set(key, read);
      } else stats.hits++;
      const answer = await read;
      if ('code' in answer) return { keys: [...sampled], trace: { source: 'DISCOVERY_SAMPLE', reason: 'F4_FAILED', failureCode: answer.code, ...base } };
      const { seed } = answer, f4 = { poolSize: seed.poolSize, poolExhausted: seed.poolExhausted, keysPicked: seed.keys.length, seed: seed.seed, sql: seed.sql, requestId: seed.requestId, queryId: seed.queryId, ...(cached ? { cached: true as const } : {}) };
      // F4 answering with no more distinct values than the sample means the column really is that narrow (or the engine cannot disperse): keep the sample, say so.
      if (distinctCount(seed.keys) < sampleDistinct) return { keys: [...sampled], trace: { source: 'DISCOVERY_SAMPLE', reason: 'F4_NOT_LARGER', f4, ...base } };
      return { keys: [...seed.keys], trace: { source: 'GLOBAL_DISTINCT_F4', reason: 'SAMPLE_BELOW_MINIMUM', f4, ...base } };
    }
  };
}
/** With no reader (the feature off) the sample is used as it is and the trace says so. */
export async function widenSourcePool(reader: SourcePoolReader | undefined, endpoint: { table: string; column: string }, sampled: readonly Cell[], minDistinctKeys: number): Promise<WidenedPool> {
  return reader ? reader.widen(endpoint, sampled, minDistinctKeys) : { keys: [...sampled], trace: { source: 'DISCOVERY_SAMPLE', reason: 'READER_ABSENT', sampleDistinct: distinctCount(sampled), minDistinctKeys } };
}
/** Source columns whose discovery sample is below the minimum: each costs +1 F4 read. For the budget pre-estimation. */
export function degenerateSampleColumns(discovery: any, targets: readonly { table: string; column: string }[], minDistinctKeys: number): { table: string; column: string }[] {
  return targets.filter(target => {
    const table = discovery?.tables?.[target.table], index = table?.columns?.indexOf(target.column) ?? -1;
    return index >= 0 && distinctCount((table.sample?.rows ?? []).map((row: Cell[]) => row[index])) < minDistinctKeys;
  });
}
