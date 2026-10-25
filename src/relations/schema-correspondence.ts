import type { DataOrigin, Decision, EvidenceBundle, ExecutionMode, RelationContract, Unknown } from '../contracts/types.ts';
import { evaluateRelation, type RelationPolicy } from './decision.ts';
import { relationPolicyFromConfig } from './policy.ts';

const known = (value: string): Unknown<string> => ({ state: 'KNOWN', value });
const unknown = (): Unknown<string> => ({ state: 'UNKNOWN' });

export interface SchemaCorrespondenceInput {
  universeId: string; contractVersion: string; relationId: string; source: { db: string; table: string; column: string }; target: { dataset: string; column: string };
  candidate: string | null; rule: string; distinctValues: number; observedRows: number; compatible: boolean;
  minDistinctKeys: number; policyVersion: string; policy?: RelationPolicy; checkedAt: string;
  provenance?: { executionMode?: ExecutionMode | 'UNKNOWN'; dataOrigin?: DataOrigin };
}

/** Shared contract/evaluator path for metadata correspondence; no source or gold reads. */
export function evaluateSchemaCorrespondence(input: SchemaCorrespondenceInput): { contract: RelationContract; evidence: EvidenceBundle; decision: Decision } {
  const from = { sourceId: `${input.source.db}:${input.source.table}:metadata`, namespace: known(input.source.db), objectId: `${input.source.db}.${input.source.table}`, orderedColumns: [input.source.column] };
  const to = { sourceId: `${input.target.dataset}:target-schema`, namespace: known(input.target.dataset), objectId: input.target.dataset, orderedColumns: [input.target.column] };
  const contract: RelationContract = {
    schemaVersion: 1, id: input.relationId, contractVersion: input.contractVersion,
    universeRef: { universeId: input.universeId, universeVersion: unknown(), namespace: unknown(), configFingerprint: unknown() },
    kind: 'SCHEMA_CORRESPONDENCE', from, to, identifierSpace: unknown(),
    normalization: [{ componentIndex: 0, operation: known('text'), version: known('metadata-1'), lossless: { state: 'KNOWN', value: true }, adapterCapability: known('schema-metadata-only') }],
    semanticContext: { grain: unknown(), unit: unknown(), scale: unknown(), period: unknown(), timezone: unknown() }, assertions: [],
    evidencePolicy: { requiredObservationTypes: ['SCHEMA_CORRESPONDENCE'], minimumCompleteness: 'COMPLETE_FOR_SCOPE', nulls: 'UNKNOWN', cardinality: 'UNKNOWN', declarationsAdmissible: 'UNKNOWN', minimumDistinctKeys: input.minDistinctKeys },
    reviewState: 'PENDING'
  };
  const runId = `${input.universeId}:${input.relationId}:${input.checkedAt}`;
  const evidence: EvidenceBundle = {
    schemaVersion: 1, evidenceBundleId: `metadata-evidence:${runId}`, relationRef: contract.id, contractVersion: contract.contractVersion,
    sourceRefs: [from.sourceId, to.sourceId].sort(),
    runRef: { runId, startedAt: unknown(), executionMode: input.provenance?.executionMode ?? 'UNKNOWN', dataOrigin: input.provenance?.dataOrigin ?? 'UNKNOWN', configFingerprint: unknown() },
    observations: [{
      observationId: `metadata-observation:${runId}`, type: 'SCHEMA_CORRESPONDENCE', sourceRef: from.sourceId, adapterId: 'legacy-metadata-pipeline',
      requestId: unknown(), observedAt: unknown(), checkedAt: input.checkedAt, nativeVersion: unknown(), fingerprint: unknown(), projection: [input.source.column], filters: [], limit: 20,
      measuredTuples: [[input.candidate ?? '', input.rule, input.distinctValues, input.observedRows, input.compatible]], nullCount: 0, duplicateCount: 'UNKNOWN', truncated: false, transportStatus: 'OK', protectedPayloadRef: unknown()
    }],
    scope: known('bounded metadata and value compatibility observation; not entity identity'), completeness: 'COMPLETE_FOR_SCOPE', capturedAt: input.checkedAt
  };
  const decision = evaluateRelation(contract, [evidence], input.policy ?? relationPolicyFromConfig({ policyVersion: input.policyVersion, minimumDistinctKeys: input.minDistinctKeys }));
  return { contract, evidence, decision };
}