import type { Candidate, Decision, EvidenceBundle, RelationContract, RelationKindValue, Unknown } from './types.ts';

export interface ValidationIssue { path: string; code: string; }
export interface ContractAllowlist { tables: Record<string, readonly string[]>; }
const object = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const timestamp = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const knownKinds = new Set<RelationKindValue>(['FOREIGN_KEY', 'IDENTITY', 'ASSOCIATION', 'SCHEMA_CORRESPONDENCE', 'MEASURE_EQUIVALENCE', 'UNKNOWN']);

export function validateUnknown(value: unknown, path = 'value', expectedType: 'string' | 'boolean' | 'any' = 'any'): ValidationIssue[] {
  if (!object(value)) return [{ path, code: 'EXPECTED_UNKNOWN_VALUE' }];
  if (value.state === 'UNKNOWN' && Object.keys(value).every(k => k === 'state')) return [];
  if (value.state === 'NOT_APPLICABLE' && (value.reason === undefined || typeof value.reason === 'string') && Object.keys(value).every(k => ['state', 'reason'].includes(k))) return [];
  if (value.state === 'KNOWN' && 'value' in value && (expectedType === 'any' || typeof value.value === expectedType) && (value.provenance === undefined || typeof value.provenance === 'string') && Object.keys(value).every(k => ['state', 'value', 'provenance'].includes(k))) return [];
  return [{ path, code: 'INVALID_UNKNOWN_VALUE' }];
}

function validateEndpoint(value: unknown, path: string, allowlist?: ContractAllowlist): ValidationIssue[] {
  if (!object(value)) return [{ path, code: 'EXPECTED_ENDPOINT' }];
  const issues: ValidationIssue[] = [];
  for (const key of ['sourceId', 'objectId']) if (!nonempty(value[key])) issues.push({ path: `${path}.${key}`, code: 'REQUIRED_STRING' });
  issues.push(...validateUnknown(value.namespace, `${path}.namespace`, 'string'));
  const columns = value.orderedColumns;
  if (!Array.isArray(columns) || columns.length === 0 || columns.some(c => !nonempty(c))) issues.push({ path: `${path}.orderedColumns`, code: 'ORDERED_COLUMNS_REQUIRED' });
  if (Array.isArray(columns) && allowlist) {
    const allowed = allowlist.tables[value.objectId];
    if (!allowed) issues.push({ path: `${path}.objectId`, code: 'OBJECT_OUTSIDE_ALLOWLIST' });
    else columns.forEach((column: unknown, i: number) => { if (typeof column === 'string' && !allowed.includes(column)) issues.push({ path: `${path}.orderedColumns[${i}]`, code: 'COLUMN_OUTSIDE_ALLOWLIST' }); });
  }
  return issues;
}

export function validateRelationContract(value: unknown, allowlist?: ContractAllowlist): ValidationIssue[] {
  if (!object(value)) return [{ path: 'value', code: 'EXPECTED_RELATION_CONTRACT' }];
  const issues: ValidationIssue[] = [];
  if (value.schemaVersion !== 1) issues.push({ path: 'schemaVersion', code: 'UNSUPPORTED_SCHEMA_VERSION' });
  for (const key of ['id', 'contractVersion']) if (!nonempty(value[key])) issues.push({ path: key, code: 'REQUIRED_STRING' });
  if (nonempty(value.contractVersion) && !/^\d+\.\d+$/.test(value.contractVersion)) issues.push({ path: 'contractVersion', code: 'INVALID_CONTRACT_VERSION' });
  if (!knownKinds.has(value.kind)) issues.push({ path: 'kind', code: 'UNKNOWN_RELATION_KIND' });
  if (!object(value.universeRef) || !nonempty(value.universeRef.universeId)) issues.push({ path: 'universeRef', code: 'INVALID_UNIVERSE_REF' });
  else {
    for (const key of ['universeVersion', 'namespace', 'configFingerprint']) issues.push(...validateUnknown(value.universeRef[key], `universeRef.${key}`, 'string'));
  }
  issues.push(...validateEndpoint(value.from, 'from', allowlist), ...validateEndpoint(value.to, 'to', allowlist), ...validateUnknown(value.identifierSpace, 'identifierSpace', 'string'));
  if (!Array.isArray(value.normalization)) issues.push({ path: 'normalization', code: 'NORMALIZATION_ARRAY_REQUIRED' });
  else {
    const arity = Array.isArray(value.from?.orderedColumns) && Array.isArray(value.to?.orderedColumns) ? Math.min(value.from.orderedColumns.length, value.to.orderedColumns.length) : -1;
    if (arity < 1 || value.from.orderedColumns.length !== value.to.orderedColumns.length || value.normalization.length !== arity) issues.push({ path: 'normalization', code: 'NORMALIZATION_ARITY_MISMATCH' });
    value.normalization.forEach((part: any, index: number) => {
      const path = `normalization[${index}]`;
      if (!object(part) || part.componentIndex !== index) issues.push({ path: `${path}.componentIndex`, code: 'NORMALIZATION_ORDER_MISMATCH' });
      for (const key of ['operation', 'version', 'adapterCapability']) issues.push(...validateUnknown(part?.[key], `${path}.${key}`, 'string'));
      issues.push(...validateUnknown(part?.lossless, `${path}.lossless`, 'boolean'));
    });
  }
  if (!object(value.semanticContext)) issues.push({ path: 'semanticContext', code: 'SEMANTIC_CONTEXT_REQUIRED' });
  else for (const key of ['grain', 'unit', 'scale', 'period', 'timezone']) issues.push(...validateUnknown(value.semanticContext[key], `semanticContext.${key}`, 'string'));
  if (!Array.isArray(value.assertions)) issues.push({ path: 'assertions', code: 'ASSERTIONS_ARRAY_REQUIRED' });
  else value.assertions.forEach((assertion: any, index: number) => {
    const path = `assertions[${index}]`;
    if (!object(assertion)) { issues.push({ path, code: 'EXPECTED_ASSERTION' }); return; }
    for (const key of ['assertionId', 'claim']) if (!nonempty(assertion[key])) issues.push({ path: `${path}.${key}`, code: 'REQUIRED_STRING' });
    for (const key of ['actor', 'sourceRef', 'assertedAt', 'scope']) issues.push(...validateUnknown(assertion[key], `${path}.${key}`, 'string'));
    if (assertion.assertedAt?.state === 'KNOWN' && !timestamp(assertion.assertedAt.value)) issues.push({ path: `${path}.assertedAt`, code: 'INVALID_TIMESTAMP' });
  });
  if (!object(value.evidencePolicy)) issues.push({ path: 'evidencePolicy', code: 'EVIDENCE_POLICY_REQUIRED' });
  else {
    if (!Array.isArray(value.evidencePolicy.requiredObservationTypes)) issues.push({ path: 'evidencePolicy.requiredObservationTypes', code: 'OBSERVATION_TYPES_REQUIRED' });
    if (!['COMPLETE_FOR_SCOPE', 'UNKNOWN'].includes(value.evidencePolicy.minimumCompleteness)) issues.push({ path: 'evidencePolicy.minimumCompleteness', code: 'INVALID_COMPLETENESS_POLICY' });
    if (!['REQUIRE_MEASUREMENT', 'UNKNOWN'].includes(value.evidencePolicy.nulls)) issues.push({ path: 'evidencePolicy.nulls', code: 'INVALID_NULL_POLICY' });
    if (!['REQUIRE_MEASUREMENT', 'UNKNOWN'].includes(value.evidencePolicy.cardinality)) issues.push({ path: 'evidencePolicy.cardinality', code: 'INVALID_CARDINALITY_POLICY' });
    if (![true, false, 'UNKNOWN'].includes(value.evidencePolicy.declarationsAdmissible)) issues.push({ path: 'evidencePolicy.declarationsAdmissible', code: 'INVALID_DECLARATION_POLICY' });
    if (value.evidencePolicy.minimumDistinctKeys !== 'UNKNOWN' && (!Number.isInteger(value.evidencePolicy.minimumDistinctKeys) || value.evidencePolicy.minimumDistinctKeys < 0)) issues.push({ path: 'evidencePolicy.minimumDistinctKeys', code: 'INVALID_BOUNDED_SAMPLE_MINIMUM' });
  }
  if (!['PENDING', 'REVIEWED', 'UNKNOWN'].includes(value.reviewState)) issues.push({ path: 'reviewState', code: 'INVALID_REVIEW_STATE' });
  return issues;
}

export function validateCandidate(value: unknown): ValidationIssue[] {
  if (!object(value)) return [{ path: 'value', code: 'EXPECTED_CANDIDATE' }];
  const issues: ValidationIssue[] = [];
  if (value.schemaVersion !== 1) issues.push({ path: 'schemaVersion', code: 'UNSUPPORTED_SCHEMA_VERSION' });
  for (const key of ['candidateId', 'proposedBy']) if (!nonempty(value[key])) issues.push({ path: key, code: 'REQUIRED_STRING' });
  issues.push(...validateRelationContract(value.relationDraft));
  if (!Array.isArray(value.provenance) || value.provenance.some((x: unknown) => !nonempty(x))) issues.push({ path: 'provenance', code: 'INVALID_PROVENANCE' });
  issues.push(...validateUnknown(value.createdAt, 'createdAt', 'string'));
  if (value.createdAt?.state === 'KNOWN' && !timestamp(value.createdAt.value)) issues.push({ path: 'createdAt', code: 'INVALID_TIMESTAMP' });
  if (!['PROPOSED', 'DUPLICATE', 'CONFLICTED', 'INCOMPLETE', 'UNKNOWN'].includes(value.status)) issues.push({ path: 'status', code: 'INVALID_CANDIDATE_STATUS' });
  return issues;
}

export function validateEvidenceBundle(value: unknown): ValidationIssue[] {
  if (!object(value)) return [{ path: 'value', code: 'EXPECTED_EVIDENCE_BUNDLE' }];
  const issues: ValidationIssue[] = [];
  if (value.schemaVersion !== 1) issues.push({ path: 'schemaVersion', code: 'UNSUPPORTED_SCHEMA_VERSION' });
  for (const key of ['evidenceBundleId', 'relationRef', 'contractVersion', 'capturedAt']) if (!nonempty(value[key])) issues.push({ path: key, code: 'REQUIRED_STRING' });
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.some((x: unknown) => !nonempty(x))) issues.push({ path: 'sourceRefs', code: 'INVALID_SOURCE_REFS' });
  if (!['COMPLETE_FOR_SCOPE', 'PARTIAL', 'TRUNCATED', 'TRANSPORT_FAILED', 'UNKNOWN'].includes(value.completeness)) issues.push({ path: 'completeness', code: 'INVALID_COMPLETENESS' });
  if (!Array.isArray(value.observations)) issues.push({ path: 'observations', code: 'OBSERVATIONS_ARRAY_REQUIRED' });
  else value.observations.forEach((observation: any, index: number) => {
    const path = `observations[${index}]`;
    if (!object(observation)) { issues.push({ path, code: 'EXPECTED_OBSERVATION' }); return; }
    for (const key of ['observationId', 'type', 'sourceRef', 'adapterId', 'checkedAt']) if (!nonempty(observation[key])) issues.push({ path: `${path}.${key}`, code: 'REQUIRED_STRING' });
    for (const key of ['requestId', 'observedAt', 'nativeVersion', 'fingerprint', 'protectedPayloadRef']) issues.push(...validateUnknown(observation[key], `${path}.${key}`, 'string'));
    for (const key of ['projection', 'filters']) if (!Array.isArray(observation[key]) || observation[key].some((v: unknown) => !nonempty(v))) issues.push({ path: `${path}.${key}`, code: 'STRING_ARRAY_REQUIRED' });
    if (!Array.isArray(observation.measuredTuples) || observation.measuredTuples.some((tuple: unknown) => !Array.isArray(tuple))) issues.push({ path: `${path}.measuredTuples`, code: 'TUPLE_ARRAY_REQUIRED' });
    for (const key of ['nullCount', 'duplicateCount', 'limit']) if (observation[key] !== 'UNKNOWN' && (!Number.isInteger(observation[key]) || observation[key] < 0)) issues.push({ path: `${path}.${key}`, code: 'NONNEGATIVE_INTEGER_OR_UNKNOWN_REQUIRED' });
    if (observation.truncated !== 'UNKNOWN' && typeof observation.truncated !== 'boolean') issues.push({ path: `${path}.truncated`, code: 'BOOLEAN_OR_UNKNOWN_REQUIRED' });
    if (!['OK', 'PARTIAL', 'ERROR', 'UNKNOWN'].includes(observation.transportStatus)) issues.push({ path: `${path}.transportStatus`, code: 'INVALID_TRANSPORT_STATUS' });
  });
  issues.push(...validateUnknown(value.scope, 'scope', 'string'));
  if (!object(value.runRef) || !nonempty(value.runRef.runId) || !['LIVE', 'REPLAY', 'LOCAL', 'UNKNOWN'].includes(value.runRef.executionMode)) issues.push({ path: 'runRef', code: 'INVALID_RUN_REF' });
  else {
    if (!nonempty(value.runRef.runId)) issues.push({ path: 'runRef.runId', code: 'REQUIRED_STRING' });
    if (value.runRef.startedAt?.state === 'KNOWN' && !timestamp(value.runRef.startedAt.value)) issues.push({ path: 'runRef.startedAt', code: 'INVALID_TIMESTAMP' });
    issues.push(...validateUnknown(value.runRef.startedAt, 'runRef.startedAt', 'string'), ...validateUnknown(value.runRef.configFingerprint, 'runRef.configFingerprint', 'string'));
    if (!['SYNTHETIC', 'PUBLIC', 'USER', 'UNKNOWN'].includes(value.runRef.dataOrigin) && !(object(value.runRef.dataOrigin) && nonempty(value.runRef.dataOrigin.label))) issues.push({ path: 'runRef.dataOrigin', code: 'INVALID_DATA_ORIGIN' });
  }
  if (!timestamp(value.capturedAt)) issues.push({ path: 'capturedAt', code: 'INVALID_TIMESTAMP' });
  if (Array.isArray(value.observations)) value.observations.forEach((observation: any, index: number) => {
    if (!object(observation)) return;
    const path = `observations[${index}]`;
    if (!timestamp(observation.checkedAt)) issues.push({ path: `${path}.checkedAt`, code: 'INVALID_TIMESTAMP' });
    if (observation.observedAt?.state === 'KNOWN' && !timestamp(observation.observedAt.value)) issues.push({ path: `${path}.observedAt`, code: 'INVALID_TIMESTAMP' });
  });
  return issues;
}

export function validateDecision(value: unknown): ValidationIssue[] {
  if (!object(value)) return [{ path: 'value', code: 'EXPECTED_DECISION' }];
  const issues: ValidationIssue[] = [];
  if (value.schemaVersion !== 1) issues.push({ path: 'schemaVersion', code: 'UNSUPPORTED_SCHEMA_VERSION' });
  for (const key of ['decisionId', 'relationRef', 'contractVersion', 'policyVersion']) if (!nonempty(value[key])) issues.push({ path: key, code: 'REQUIRED_STRING' });
  if (nonempty(value.policyVersion) && !/^\d+\.\d+$/.test(value.policyVersion)) issues.push({ path: 'policyVersion', code: 'INVALID_POLICY_VERSION' });
  if (!['SOSTENIDA', 'ENGAÑOSA', 'INDETERMINADA'].includes(value.verdict)) issues.push({ path: 'verdict', code: 'INVALID_VERDICT' });
  for (const key of ['reasonCodes', 'requirementsMet', 'requirementsMissing', 'contradictions', 'evidenceBundleRefs']) if (!Array.isArray(value[key]) || value[key].some((x: unknown) => !nonempty(x))) issues.push({ path: key, code: 'STRING_ARRAY_REQUIRED' });
  issues.push(...validateUnknown(value.scope, 'scope', 'string'), ...validateUnknown(value.evaluatedAt, 'evaluatedAt', 'string'));
  if (value.evaluatedAt?.state === 'KNOWN' && !timestamp(value.evaluatedAt.value)) issues.push({ path: 'evaluatedAt', code: 'INVALID_TIMESTAMP' });
  if (typeof value.requiresReview !== 'boolean') issues.push({ path: 'requiresReview', code: 'BOOLEAN_REQUIRED' });
  if (!['CURRENT', 'INCOMPLETE', 'UNKNOWN'].includes(value.status)) issues.push({ path: 'status', code: 'INVALID_DECISION_STATUS' });
  return issues;
}

export function assertValid<T>(value: unknown, issues: ValidationIssue[], label: string): asserts value is T {
  if (issues.length) throw new TypeError(`${label}: ${issues.map(issue => `${issue.path}:${issue.code}`).join(', ')}`);
}

export type { Candidate, Decision, EvidenceBundle, RelationContract };
