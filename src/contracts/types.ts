/** Shared, versioned DTOs. UNKNOWN is data, never a compatibility default. */
export type Unknown<T> =
  | { state: 'KNOWN'; value: T; provenance?: string }
  | { state: 'UNKNOWN' }
  | { state: 'NOT_APPLICABLE'; reason?: string };

export type ExecutionMode = 'LIVE' | 'REPLAY' | 'LOCAL';
export type DataOrigin = 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN' | { label: string };
export type RelationKind = 'FOREIGN_KEY' | 'IDENTITY' | 'ASSOCIATION' | 'SCHEMA_CORRESPONDENCE' | 'MEASURE_EQUIVALENCE';
export type RelationKindValue = RelationKind | 'UNKNOWN';
export type Verdict = 'SOSTENIDA' | 'ENGAÑOSA' | 'INDETERMINADA';

export interface UniverseRef {
  universeId: string;
  universeVersion: Unknown<string>;
  namespace: Unknown<string>;
  configFingerprint: Unknown<string>;
}

export interface SourceRef {
  sourceId: string;
  universeId: string;
  adapterId: string;
  sourceVersion: Unknown<string>;
  snapshotId: Unknown<string>;
  identifierSpace: Unknown<string>;
  observedAt: Unknown<string>;
}

export interface RunRef {
  runId: string;
  startedAt: Unknown<string>;
  executionMode: ExecutionMode | 'UNKNOWN';
  dataOrigin: DataOrigin;
  configFingerprint: Unknown<string>;
}

export interface RelationEndpoint {
  sourceId: string;
  namespace: Unknown<string>;
  objectId: string;
  /** Ordered components; order and arity are contractual. */
  orderedColumns: string[];
}

export interface NormalizationComponent {
  componentIndex: number;
  operation: Unknown<string>;
  version: Unknown<string>;
  lossless: Unknown<boolean>;
  adapterCapability: Unknown<string>;
}

export interface SemanticContext {
  grain: Unknown<string>;
  unit: Unknown<string>;
  scale: Unknown<string>;
  period: Unknown<string>;
  timezone: Unknown<string>;
  properties?: Record<string, Unknown<unknown>>;
}

export interface RelationAssertion {
  assertionId: string;
  claim: string;
  actor: Unknown<string>;
  sourceRef: Unknown<string>;
  assertedAt: Unknown<string>;
  scope: Unknown<string>;
}

export interface EvidencePolicy {
  requiredObservationTypes: string[];
  minimumCompleteness: 'COMPLETE_FOR_SCOPE' | 'UNKNOWN';
  nulls: 'REQUIRE_MEASUREMENT' | 'UNKNOWN';
  cardinality: 'REQUIRE_MEASUREMENT' | 'UNKNOWN';
  declarationsAdmissible: boolean | 'UNKNOWN';
  /** A bounded distinct-key threshold is not a global uniqueness requirement. */
  minimumDistinctKeys: number | 'UNKNOWN';
}

export interface RelationContract {
  schemaVersion: 1;
  id: string;
  contractVersion: string;
  universeRef: UniverseRef;
  kind: RelationKindValue;
  from: RelationEndpoint;
  to: RelationEndpoint;
  identifierSpace: Unknown<string>;
  normalization: NormalizationComponent[];
  semanticContext: SemanticContext;
  assertions: RelationAssertion[];
  evidencePolicy: EvidencePolicy;
  reviewState: 'PENDING' | 'REVIEWED' | 'UNKNOWN';
}

export interface Candidate {
  schemaVersion: 1;
  candidateId: string;
  relationDraft: RelationContract;
  proposedBy: string;
  provenance: string[];
  createdAt: Unknown<string>;
  status: 'PROPOSED' | 'DUPLICATE' | 'CONFLICTED' | 'INCOMPLETE' | 'UNKNOWN';
}

export type EvidenceCompleteness = 'COMPLETE_FOR_SCOPE' | 'PARTIAL' | 'TRUNCATED' | 'TRANSPORT_FAILED' | 'UNKNOWN';
export interface EvidenceObservation {
  observationId: string;
  type: string;
  sourceRef: string;
  adapterId: string;
  requestId: Unknown<string>;
  observedAt: Unknown<string>;
  checkedAt: string;
  nativeVersion: Unknown<string>;
  fingerprint: Unknown<string>;
  projection: string[];
  filters: string[];
  limit: number | 'UNKNOWN';
  measuredTuples: unknown[][];
  nullCount: number | 'UNKNOWN';
  duplicateCount: number | 'UNKNOWN';
  truncated: boolean | 'UNKNOWN';
  transportStatus: 'OK' | 'PARTIAL' | 'ERROR' | 'UNKNOWN';
  protectedPayloadRef: Unknown<string>;
}

export interface EvidenceBundle {
  schemaVersion: 1;
  evidenceBundleId: string;
  relationRef: string;
  contractVersion: string;
  sourceRefs: string[];
  runRef: RunRef;
  observations: EvidenceObservation[];
  scope: Unknown<string>;
  completeness: EvidenceCompleteness;
  capturedAt: string;
}

export interface Decision {
  schemaVersion: 1;
  decisionId: string;
  relationRef: string;
  contractVersion: string;
  verdict: Verdict;
  reasonCodes: string[];
  requirementsMet: string[];
  requirementsMissing: string[];
  contradictions: string[];
  scope: Unknown<string>;
  evidenceBundleRefs: string[];
  policyVersion: string;
  evaluatedAt: Unknown<string>;
  requiresReview: boolean;
  status: 'CURRENT' | 'INCOMPLETE' | 'UNKNOWN';
}

export type ContractCompatibility = 'EXACT' | 'BACKWARD_READ' | 'MIGRATED' | 'UNSUPPORTED';
export interface MigrationResult<T> {
  compatibility: ContractCompatibility;
  sourceVersion: string;
  targetVersion: string;
  idMap: Record<string, string>;
  warnings: string[];
  value: T;
}
