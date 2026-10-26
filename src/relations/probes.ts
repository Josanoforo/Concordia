import type { DataOrigin, EvidenceBundle, EvidenceObservation, ExecutionMode, RelationContract, Unknown } from '../contracts/types.ts';
import { validateRelationContract } from '../contracts/validate.ts';
import { failure } from '../runtime.ts';

/** Default per-read ceiling is 50; 51..100 only when the caller passes an explicit maxLimit (the per-run probe-limit override). */
export const PROBE_LIMIT_HARD_MAX = 100;
export interface ProbeFilter { column: string; values: readonly (string | number | boolean)[]; }
/** DISTINCT_KEYS: the endpoint is read as the distinct values of its key among the filter values, not as rows. Opt-in per universe (probeMode "distinct-keys"). */
export type ProbeReadMode = 'DISTINCT_KEYS';
export interface ProbeEndpointPlan { sourceId: string; objectId: string; columns: readonly string[]; keyColumns: readonly string[]; filter?: ProbeFilter; readMode?: ProbeReadMode; }
export const distinctKeysScope = (sampledKeys: number) => `claves origen muestreadas (${sampledKeys}); destino leído completo para esas claves`;
/**
 * Turns the SOURCE endpoint of a plan into a distinct-keys read: only the key column, over the K filter values, with K strictly below the plan limit.
 * The read cannot reach the limit unless the source misbehaves, in which case it is reported as truncated like any other read; nothing is forced.
 */
export function withDistinctKeysSource(plan: ProbePlan): ProbePlan {
  const [source, target] = plan.endpoints;
  if (!source.filter || source.filter.values.length >= plan.limit || source.keyColumns.length !== 1 || source.filter.column !== source.keyColumns[0]) throw new TypeError('DISTINCT_KEYS_REQUIRES_SINGLE_KEY_FILTER_BELOW_LIMIT');
  return { ...plan, endpoints: [{ ...source, columns: [...source.keyColumns], readMode: 'DISTINCT_KEYS' }, target] };
}
export interface ProbePlan { schemaVersion: 1; relationRef: string; contractVersion: string; limit: number; endpoints: readonly [ProbeEndpointPlan, ProbeEndpointPlan]; }
export interface ProbeReadRequest extends ProbeEndpointPlan { limit: number; }
export interface ProbeReadResult { tuples: unknown[][]; requestId?: string; observedAt?: string; requestedAt?: string; truncated?: boolean; statement?: string; queryId?: string; durationMs?: number; nativeVersion?: Unknown<string>; fingerprint?: Unknown<string>; }
export interface ProbeAdapter { adapterId: string; read(request: ProbeReadRequest): Promise<ProbeReadResult>; }
export interface LocalProbeContext { runId: string; checkedAt: string; scope: string; maxLimit?: number; executionMode?: ExecutionMode | 'UNKNOWN'; dataOrigin?: DataOrigin; }
export interface ProbeExecutionResult { status: 'COMPLETE' | 'PARTIAL' | 'ERROR' | 'TRUNCATED'; bundle: EvidenceBundle; errors: { sourceRef: string; code: 'ADAPTER_READ_FAILED'; adapterCode: string; http?: number; retryAfter?: string }[]; reads: { sourceId: string; objectId: string; projection: string[]; tuples: unknown[][]; requestId?: string; observedAt?: string; requestedAt?: string; statement?: string; queryId?: string; durationMs?: number }[]; }

/** Build a bounded key projection only after checking every component against a caller supplied allowlist. */
export function planProbe(contract: RelationContract, allowlist: Record<string, readonly string[]>, limit: number, maxLimit = 50, additionalColumns: Record<string, readonly string[]> = {}, filters: Record<string, ProbeFilter> = {}): ProbePlan {
  const issues = validateRelationContract(contract);
  if (issues.length) throw new TypeError(`Invalid relation contract: ${issues.map(issue => `${issue.path}:${issue.code}`).join(', ')}`);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit || maxLimit > PROBE_LIMIT_HARD_MAX) throw new TypeError('INVALID_PROBE_LIMIT');
  const endpoints = [contract.from, contract.to].map(endpoint => {
    const allowed = allowlist[endpoint.objectId];
    if (!allowed) throw new TypeError(`OBJECT_OUTSIDE_ALLOWLIST:${endpoint.objectId}`);
    // Contract key columns stay first; supplemental label columns follow in a stable order.
    const columns = [...new Set([...endpoint.orderedColumns, ...(additionalColumns[endpoint.objectId] ?? [])])];
    for (const column of columns) if (!allowed.includes(column)) throw new TypeError(`COLUMN_OUTSIDE_ALLOWLIST:${endpoint.objectId}.${column}`);
    const filter = filters[endpoint.objectId];
    if (filter) {
      if (!endpoint.orderedColumns.includes(filter.column) || !allowed.includes(filter.column)) throw new TypeError(`FILTER_COLUMN_OUTSIDE_KEY_ALLOWLIST:${endpoint.objectId}.${filter.column}`);
      if (!Array.isArray(filter.values) || filter.values.length < 1 || filter.values.length > 50 || filter.values.some(value => !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) throw new TypeError('INVALID_PROBE_FILTER_VALUES');
    }
    return { sourceId: endpoint.sourceId, objectId: endpoint.objectId, columns, keyColumns: [...endpoint.orderedColumns], ...(filter ? { filter: { column: filter.column, values: [...filter.values] } } : {}) };
  }) as unknown as ProbePlan['endpoints'];
  return { schemaVersion: 1, relationRef: contract.id, contractVersion: contract.contractVersion, limit, endpoints };
}

/** Executes only through an injected adapter; this layer has no built-in network or filesystem adapter. */
export async function executeProbe(plan: ProbePlan, adapter: ProbeAdapter, context: LocalProbeContext): Promise<ProbeExecutionResult> {
  const ceiling = context.maxLimit ?? 50;
  if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > PROBE_LIMIT_HARD_MAX || !Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > ceiling) throw new TypeError('INVALID_PROBE_LIMIT');
  if (!context.runId || !context.checkedAt || !context.scope) throw new TypeError('INVALID_PROBE_CONTEXT');
  const observations: EvidenceObservation[] = [], errors: ProbeExecutionResult['errors'] = [], reads: ProbeExecutionResult['reads'] = [];
  let anyTruncated = false;
  for (let index = 0; index < plan.endpoints.length; index++) {
    const endpoint = plan.endpoints[index];
    try {
      const result = await adapter.read({ ...endpoint, limit: plan.limit });
      if (!Array.isArray(result.tuples) || result.tuples.some(tuple => !Array.isArray(tuple))) throw new TypeError('ADAPTER_RESULT_SHAPE');
      const truncated = Boolean(result.truncated || result.tuples.length > plan.limit);
      const tuples = result.tuples.slice(0, plan.limit);
      const keyIndexes = endpoint.keyColumns.map(column => endpoint.columns.indexOf(column));
      if (keyIndexes.some(index => index < 0)) throw new TypeError('PROBE_KEY_PROJECTION_MISSING');
      reads.push({ sourceId: endpoint.sourceId, objectId: endpoint.objectId, projection: [...endpoint.columns], tuples, requestId: result.requestId, observedAt: result.observedAt, requestedAt: result.requestedAt, statement: result.statement, queryId: result.queryId, durationMs: result.durationMs });
      anyTruncated ||= truncated;
      observations.push({
        observationId: `${context.runId}:${index}:${endpoint.sourceId}:${endpoint.objectId}`,
        type: 'KEY_MEMBERSHIP', sourceRef: endpoint.sourceId, adapterId: adapter.adapterId,
        requestId: result.requestId ? { state: 'KNOWN', value: result.requestId } : { state: 'UNKNOWN' },
        observedAt: result.observedAt ? { state: 'KNOWN', value: result.observedAt } : { state: 'UNKNOWN' },
        checkedAt: context.checkedAt, nativeVersion: result.nativeVersion ?? { state: 'UNKNOWN' }, fingerprint: result.fingerprint ?? { state: 'UNKNOWN' },
        projection: [...endpoint.columns], filters: endpoint.filter ? [`${endpoint.filter.column} IN (${endpoint.filter.values.length} bounded values)`, ...(endpoint.readMode ? ['distinct-keys'] : [])] : [], limit: plan.limit, measuredTuples: tuples,
        nullCount: tuples.filter(tuple => keyIndexes.some(index => tuple[index] === null || tuple[index] === undefined)).length,
        duplicateCount: 'UNKNOWN', truncated, transportStatus: 'OK', protectedPayloadRef: { state: 'UNKNOWN' }
      });
    } catch (error) {
      const diagnostic = failure(error);
      errors.push({ sourceRef: endpoint.sourceId, code: 'ADAPTER_READ_FAILED', adapterCode: diagnostic.code, http: diagnostic.http, retryAfter: diagnostic.retryAfter });
      observations.push({
        observationId: `${context.runId}:${index}:${endpoint.sourceId}:${endpoint.objectId}`,
        type: 'KEY_MEMBERSHIP', sourceRef: endpoint.sourceId, adapterId: adapter.adapterId,
        requestId: { state: 'UNKNOWN' }, observedAt: { state: 'UNKNOWN' }, checkedAt: context.checkedAt,
        nativeVersion: { state: 'UNKNOWN' }, fingerprint: { state: 'UNKNOWN' }, projection: [...endpoint.columns], filters: endpoint.filter ? [`${endpoint.filter.column} IN (${endpoint.filter.values.length} bounded values)`] : [],
        limit: plan.limit, measuredTuples: [], nullCount: 'UNKNOWN', duplicateCount: 'UNKNOWN', truncated: 'UNKNOWN',
        transportStatus: 'ERROR', protectedPayloadRef: { state: 'UNKNOWN' }
      });
    }
  }
  const successes = observations.filter(observation => observation.transportStatus === 'OK').length;
  const completeness = anyTruncated ? 'TRUNCATED' : successes === observations.length ? 'COMPLETE_FOR_SCOPE' : successes > 0 ? 'PARTIAL' : 'TRANSPORT_FAILED';
  const bundle: EvidenceBundle = {
    schemaVersion: 1, evidenceBundleId: `evidence:${context.runId}:${plan.relationRef}`, relationRef: plan.relationRef, contractVersion: plan.contractVersion,
    sourceRefs: [...new Set(plan.endpoints.map(endpoint => endpoint.sourceId))].sort(),
    runRef: { runId: context.runId, startedAt: { state: 'UNKNOWN' }, executionMode: context.executionMode ?? 'LOCAL', dataOrigin: context.dataOrigin ?? 'SYNTHETIC', configFingerprint: { state: 'UNKNOWN' } },
    observations, scope: { state: 'KNOWN', value: context.scope }, completeness, capturedAt: context.checkedAt
  };
  const status = completeness === 'COMPLETE_FOR_SCOPE' ? 'COMPLETE' : completeness === 'TRUNCATED' ? 'TRUNCATED' : successes ? 'PARTIAL' : 'ERROR';
  return { status, bundle, errors, reads };
}

/** In-memory adapter for offline tests and fixtures. No source, network or environment access. */
export class LocalFixtureAdapter implements ProbeAdapter {
  readonly adapterId = 'local-fixture';
  constructor(private readonly fixtures: Readonly<Record<string, readonly unknown[][]>>) {}
  async read(request: ProbeReadRequest): Promise<ProbeReadResult> {
    const key = `${request.sourceId}:${request.objectId}`;
    if (!Object.hasOwn(this.fixtures, key)) throw new Error('FIXTURE_NOT_FOUND');
    const rows = this.fixtures[key];
    const truncated = rows.length > request.limit;
    return { tuples: rows.slice(0, request.limit).map(tuple => [...tuple]), requestId: `local:${key}:${request.limit}`, truncated };
  }
}

/** Preserve legacy sample-quality measurements as typed evidence for the common evaluator. */
export function addSampleQualitySignals(bundle: EvidenceBundle, signals: readonly string[], checkedAt: string): void {
  const unique = [...new Set(signals)].sort((a, b) => a.localeCompare(b, 'en'));
  if (!unique.length) return;
  bundle.observations.push({
    observationId: `${bundle.evidenceBundleId}:quality`, type: 'SAMPLE_QUALITY', sourceRef: bundle.sourceRefs[0] ?? 'unknown', adapterId: 'bounded-probe-quality',
    requestId: { state: 'UNKNOWN' }, observedAt: { state: 'UNKNOWN' }, checkedAt, nativeVersion: { state: 'UNKNOWN' }, fingerprint: { state: 'UNKNOWN' },
    projection: ['signal'], filters: [], limit: unique.length, measuredTuples: unique.map(signal => [signal]), nullCount: 0, duplicateCount: 0,
    truncated: false, transportStatus: 'OK', protectedPayloadRef: { state: 'UNKNOWN' }
  });
}