import type { DataOrigin, Decision, EvidenceBundle, EvidenceObservation, ExecutionMode, RelationContract, RelationKindValue, Unknown } from '../contracts/types.ts';
import type { NormalizationMode } from '../universe.ts';
import { executeProbe, planProbe, type ProbeFilter, type ProbePlan, type ProbeReadRequest } from './probes.ts';
import { evaluateRelation } from './decision.ts';
import { relationPolicyFromConfig } from './policy.ts';

type LegacyEndpoint = { db: string; table: string; column: string };
type LegacyRelation = { id: string; from: LegacyEndpoint; to: LegacyEndpoint; minDistinctKeys?: number; kind?: RelationKindValue; identifierSpace?: string; normalizationVersion?: string; normalizationLossless?: boolean; normalizationAdapterCapability?: string; reviewState?: 'PENDING' | 'REVIEWED' | 'UNKNOWN' };
type LegacyProbe = {
  relation: LegacyRelation; utc: string; status: string; normalization?: string;
  typeCompat?: { normalization?: string; castable?: boolean };
  queries: { rows: unknown[][]; requestId?: string; utc?: string }[];
  alerts?: string[]; multiplicity?: { manyToManyKeys?: unknown[]; to?: { duplicateKeys?: unknown[] }; bounded?: { from?: boolean; to?: boolean } };
  labelAgreement?: { ratio: number };
};
type LegacyPolicy = { minDistinctKeys?: number; misleadingLabelAgreement?: number; sustainedLabelAgreement?: number; sustainedOverlap?: number; relationPolicyVersion?: string; probeLimit?: number };
type LegacyProvenance = { contractVersion: string; executionMode?: ExecutionMode | 'UNKNOWN'; dataOrigin?: DataOrigin };

const known = (value: string): Unknown<string> => ({ state: 'KNOWN', value });
const unknown = <T = string>(): Unknown<T> => ({ state: 'UNKNOWN' });
const timestamp = (value: unknown): string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : new Date(0).toISOString();

export function legacyRelationContract(relation: LegacyRelation, universeId: string, contractVersion: string, mode: NormalizationMode, minimumDistinctKeys: number): RelationContract {
  if (!universeId || !/^[0-9]+[.][0-9]+$/.test(contractVersion) || !['text', 'integer', 'integer-pad10'].includes(mode) || !Number.isInteger(minimumDistinctKeys) || minimumDistinctKeys < 0) throw new TypeError('LEGACY_RELATION_CONTRACT_CONTEXT_INVALID');
  const endpoint = (value: LegacyEndpoint, role: string) => ({ sourceId: `${value.db}:${value.table}:${role}`, namespace: known(value.db), objectId: `${value.db}.${value.table}`, orderedColumns: [value.column] });
  const from = endpoint(relation.from, 'from'), to = endpoint(relation.to, 'to');
  return {
    schemaVersion: 1, id: relation.id, contractVersion,
    universeRef: { universeId, universeVersion: unknown(), namespace: unknown(), configFingerprint: unknown() },
    kind: relation.kind && ['FOREIGN_KEY', 'IDENTITY', 'ASSOCIATION', 'SCHEMA_CORRESPONDENCE', 'MEASURE_EQUIVALENCE', 'UNKNOWN'].includes(relation.kind) ? relation.kind : 'UNKNOWN',
    from, to,
    identifierSpace: typeof relation.identifierSpace === 'string' && relation.identifierSpace.length ? known(relation.identifierSpace) : unknown(),
    normalization: [{
      componentIndex: 0, operation: known(mode),
      version: typeof relation.normalizationVersion === 'string' && relation.normalizationVersion.length ? known(relation.normalizationVersion) : unknown(),
      lossless: typeof relation.normalizationLossless === 'boolean' ? { state: 'KNOWN', value: relation.normalizationLossless } : unknown<boolean>(),
      adapterCapability: typeof relation.normalizationAdapterCapability === 'string' && relation.normalizationAdapterCapability.length ? known(relation.normalizationAdapterCapability) : unknown()
    }],
    semanticContext: { grain: unknown(), unit: unknown(), scale: unknown(), period: unknown(), timezone: unknown() }, assertions: [],
    evidencePolicy: { requiredObservationTypes: ['KEY_MEMBERSHIP'], minimumCompleteness: 'COMPLETE_FOR_SCOPE', nulls: 'UNKNOWN', cardinality: 'UNKNOWN', declarationsAdmissible: 'UNKNOWN', minimumDistinctKeys },
    reviewState: relation.reviewState && ['PENDING', 'REVIEWED', 'UNKNOWN'].includes(relation.reviewState) ? relation.reviewState : 'PENDING'
  };
}

/** Common allowlist/LIMIT planning used before U1 and U2 legacy source reads. */
export function planLegacyProbe(relation: LegacyRelation, universeId: string, contractVersion: string, mode: NormalizationMode, minimumDistinctKeys: number, allowlist: Record<string, readonly string[]>, limit: number, additionalColumns: Record<string, readonly string[]> = {}, filters: Record<string, ProbeFilter> = {}): ProbePlan {
  return planProbe(legacyRelationContract(relation, universeId, contractVersion, mode, minimumDistinctKeys), allowlist, limit, 50, additionalColumns, filters);
}

/** Converts a captured legacy probe into common DTOs; callers supply identity and provenance explicitly. */
export function legacyProbeToEvidence(probe: LegacyProbe, universeId: string, policy: LegacyPolicy, provenance: LegacyProvenance): { contract: RelationContract; evidence: EvidenceBundle } {
  const relation = probe.relation;
  if (!universeId || !/^[0-9]+[.][0-9]+$/.test(provenance.contractVersion) || !relation?.from || !relation?.to || !Array.isArray(probe.queries)) throw new TypeError('LEGACY_PROBE_SHAPE_UNSUPPORTED');
  const mode = (probe.normalization ?? probe.typeCompat?.normalization) as NormalizationMode;
  if (!['text', 'integer', 'integer-pad10'].includes(mode)) throw new TypeError('LEGACY_NORMALIZATION_UNSUPPORTED');
  const minimum = relation.minDistinctKeys ?? policy.minDistinctKeys ?? 1;
  const contract = legacyRelationContract(relation, universeId, provenance.contractVersion, mode, minimum);
  const limit = policy.probeLimit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('INVALID_PROBE_LIMIT');
  const from = contract.from, to = contract.to;
  const runId = `${universeId}:${relation.id}:${timestamp(probe.utc)}`;
  const endpointRows = [0, 1].map(index => {
    const rows = probe.queries[index]?.rows;
    return Array.isArray(rows) ? rows.map(row => [row?.[0]]) : [];
  });
  const transportComplete = probe.status === 'PASS' && probe.queries.length >= 2;
  const observations: EvidenceObservation[] = [from, to].map((ref, index) => {
    const source = index === 0 ? relation.from : relation.to;
    const query = probe.queries[index];
    const truncated = Boolean(query && (query.rows.length >= limit || probe.multiplicity?.bounded?.[index === 0 ? 'from' : 'to']));
    return {
      observationId: `${runId}:${index}`, type: 'KEY_MEMBERSHIP', sourceRef: ref.sourceId, adapterId: 'legacy-pipeline',
      requestId: query?.requestId ? known(query.requestId) : unknown(), observedAt: unknown(), checkedAt: timestamp(probe.utc), nativeVersion: unknown(), fingerprint: unknown(),
      projection: [source.column], filters: [], limit, measuredTuples: endpointRows[index], nullCount: endpointRows[index].filter(tuple => tuple[0] === null || tuple[0] === undefined).length, duplicateCount: 'UNKNOWN', truncated: query ? truncated : 'UNKNOWN',
      transportStatus: query ? 'OK' : 'ERROR', protectedPayloadRef: unknown()
    };
  });
  const signals: string[] = [];
  if (probe.labelAgreement && probe.labelAgreement.ratio < (policy.misleadingLabelAgreement ?? 0)) signals.push('LABEL_CONFLICT');
  else if (probe.labelAgreement && probe.labelAgreement.ratio < (policy.sustainedLabelAgreement ?? 1)) signals.push('LABEL_UNCERTAIN');
  if (probe.multiplicity?.manyToManyKeys?.length) signals.push('MANY_TO_MANY');
  if (probe.multiplicity?.to?.duplicateKeys?.length) signals.push('DUPLICATE_REFERENCED_KEYS');
  if (probe.typeCompat?.castable === false) signals.push('TYPE_INCOMPATIBLE');
  if (probe.alerts?.length) signals.push('SAMPLE_ALERT');
  if (signals.length) observations.push({
    observationId: `${runId}:quality`, type: 'SAMPLE_QUALITY', sourceRef: from.sourceId, adapterId: 'legacy-pipeline', requestId: unknown(), observedAt: unknown(),
    checkedAt: timestamp(probe.utc), nativeVersion: unknown(), fingerprint: unknown(), projection: ['signal'], filters: [], limit,
    measuredTuples: signals.map(signal => [signal]), nullCount: 0, duplicateCount: 0, truncated: false, transportStatus: 'OK', protectedPayloadRef: unknown()
  });
  const capturedAt = timestamp(probe.utc);
  const evidence: EvidenceBundle = {
    schemaVersion: 1, evidenceBundleId: `legacy-evidence:${runId}`, relationRef: contract.id, contractVersion: contract.contractVersion,
    sourceRefs: [from.sourceId, to.sourceId].sort(), runRef: { runId, startedAt: unknown(), executionMode: provenance.executionMode ?? 'UNKNOWN', dataOrigin: provenance.dataOrigin ?? 'UNKNOWN', configFingerprint: unknown() },
    observations, scope: known('legacy bounded probe response'), completeness: transportComplete && !observations.some(item => item.truncated === true) ? 'COMPLETE_FOR_SCOPE' : 'PARTIAL', capturedAt
  };
  return { contract, evidence };
}
/** Route already captured legacy reads through the common bounded probe executor and evaluator. */
export async function evaluateLegacyPipelineProbe(probe: LegacyProbe, universeId: string, policy: LegacyPolicy, provenance: LegacyProvenance, allowlist?: Record<string, readonly string[]>): Promise<{ contract: RelationContract; evidence: EvidenceBundle; decision: Decision }> {
  if (!policy.relationPolicyVersion) throw new TypeError('RELATION_POLICY_VERSION_REQUIRED');
  const adapted = legacyProbeToEvidence(probe, universeId, policy, provenance);
  const mode = (probe.normalization ?? probe.typeCompat?.normalization) as NormalizationMode;
  const allowed = allowlist ?? Object.fromEntries([[`${probe.relation.from.db}.${probe.relation.from.table}`, [probe.relation.from.column]], [`${probe.relation.to.db}.${probe.relation.to.table}`, [probe.relation.to.column]]]);
  const plan = planLegacyProbe(probe.relation, universeId, provenance.contractVersion, mode, probe.relation.minDistinctKeys ?? policy.minDistinctKeys ?? 1, allowed, policy.probeLimit ?? 50);
  const keyObservations = adapted.evidence.observations.filter(observation => observation.type === 'KEY_MEMBERSHIP');
  let index = 0;
  const adapter = {
    adapterId: 'legacy-captured-response',
    async read(_request: ProbeReadRequest) {
      const observation = keyObservations[index++];
      if (!observation || observation.transportStatus !== 'OK') throw new Error('LEGACY_TRANSPORT_INCOMPLETE');
      return {
        tuples: observation.measuredTuples,
        requestId: observation.requestId.state === 'KNOWN' ? observation.requestId.value : undefined,
        observedAt: probe.queries[index - 1]?.utc,
        truncated: observation.truncated === true
      };
    }
  };
  const runId = adapted.evidence.runRef.runId;
  const checkedAt = probe.queries.map(query => query.utc).filter((value): value is string => Boolean(value && !Number.isNaN(Date.parse(value)))).sort().at(-1) ?? adapted.evidence.capturedAt;
  const replay = await executeProbe(plan, adapter, {
    runId, checkedAt, scope: 'legacy bounded probe response',
    executionMode: provenance.executionMode ?? 'UNKNOWN', dataOrigin: provenance.dataOrigin ?? 'UNKNOWN'
  });
  replay.bundle.evidenceBundleId = adapted.evidence.evidenceBundleId;
  replay.bundle.completeness = probe.status === 'PASS' ? replay.bundle.completeness : 'PARTIAL';
  replay.bundle.observations.push(...adapted.evidence.observations.filter(observation => observation.type === 'SAMPLE_QUALITY'));
  const decision = evaluateRelation(adapted.contract, [replay.bundle], relationPolicyFromConfig(policy));
  return { contract: adapted.contract, evidence: replay.bundle, decision };
}
