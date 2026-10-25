/** Minimal JSON Schema documents kept beside the DTOs without a runtime dependency. */
const unknownSchema = {
  oneOf: [
    { type: 'object', required: ['state', 'value'], properties: { state: { const: 'KNOWN' }, value: {}, provenance: { type: 'string' } }, additionalProperties: false },
    { type: 'object', required: ['state'], properties: { state: { const: 'UNKNOWN' } }, additionalProperties: false },
    { type: 'object', required: ['state'], properties: { state: { const: 'NOT_APPLICABLE' }, reason: { type: 'string' } }, additionalProperties: false }
  ]
} as const;
const unknownStringSchema = { oneOf: [
  { type: 'object', required: ['state', 'value'], properties: { state: { const: 'KNOWN' }, value: { type: 'string' }, provenance: { type: 'string' } }, additionalProperties: false },
  { type: 'object', required: ['state'], properties: { state: { const: 'UNKNOWN' } }, additionalProperties: false },
  { type: 'object', required: ['state'], properties: { state: { const: 'NOT_APPLICABLE' }, reason: { type: 'string' } }, additionalProperties: false }
] } as const;
const unknownBooleanSchema = { oneOf: [
  { type: 'object', required: ['state', 'value'], properties: { state: { const: 'KNOWN' }, value: { type: 'boolean' }, provenance: { type: 'string' } }, additionalProperties: false },
  { type: 'object', required: ['state'], properties: { state: { const: 'UNKNOWN' } }, additionalProperties: false },
  { type: 'object', required: ['state'], properties: { state: { const: 'NOT_APPLICABLE' }, reason: { type: 'string' } }, additionalProperties: false }
] } as const;

export const relationContractSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'concordia://contracts/relation-contract-v1',
  type: 'object',
  required: ['schemaVersion', 'id', 'contractVersion', 'universeRef', 'kind', 'from', 'to', 'identifierSpace', 'normalization', 'semanticContext', 'assertions', 'evidencePolicy', 'reviewState'],
  properties: {
    schemaVersion: { const: 1 }, id: { type: 'string', minLength: 1 }, contractVersion: { type: 'string', pattern: '^\\d+\\.\\d+$' },
    universeRef: { type: 'object', required: ['universeId', 'universeVersion', 'namespace', 'configFingerprint'], properties: { universeId: { type: 'string' }, universeVersion: unknownStringSchema, namespace: unknownStringSchema, configFingerprint: unknownStringSchema } },
    kind: { enum: ['FOREIGN_KEY', 'IDENTITY', 'ASSOCIATION', 'SCHEMA_CORRESPONDENCE', 'MEASURE_EQUIVALENCE', 'UNKNOWN'] },
    from: { $ref: '#/$defs/endpoint' }, to: { $ref: '#/$defs/endpoint' }, identifierSpace: unknownSchema,
    normalization: { type: 'array', items: { type: 'object', required: ['componentIndex', 'operation', 'version', 'lossless', 'adapterCapability'], properties: { operation: unknownStringSchema, version: unknownStringSchema, lossless: unknownBooleanSchema, adapterCapability: unknownStringSchema } } },
    semanticContext: { type: 'object', required: ['grain', 'unit', 'scale', 'period', 'timezone'], properties: { grain: unknownStringSchema, unit: unknownStringSchema, scale: unknownStringSchema, period: unknownStringSchema, timezone: unknownStringSchema } },
    assertions: { type: 'array', items: { type: 'object', required: ['assertionId', 'claim', 'actor', 'sourceRef', 'assertedAt', 'scope'], properties: { actor: unknownStringSchema, sourceRef: unknownStringSchema, assertedAt: unknownStringSchema, scope: unknownStringSchema } } },
    evidencePolicy: { type: 'object', required: ['requiredObservationTypes', 'minimumCompleteness', 'nulls', 'cardinality', 'declarationsAdmissible', 'minimumDistinctKeys'] },
    reviewState: { enum: ['PENDING', 'REVIEWED', 'UNKNOWN'] }
  },
  $defs: { unknown: unknownSchema, unknownString: unknownStringSchema, unknownBoolean: unknownBooleanSchema, endpoint: { type: 'object', required: ['sourceId', 'namespace', 'objectId', 'orderedColumns'], properties: { sourceId: { type: 'string', minLength: 1 }, namespace: unknownStringSchema, objectId: { type: 'string', minLength: 1 }, orderedColumns: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } } } }
} as const;

export const candidateSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'concordia://contracts/candidate-v1', type: 'object', required: ['schemaVersion', 'candidateId', 'relationDraft', 'proposedBy', 'provenance', 'createdAt', 'status'], properties: { schemaVersion: { const: 1 }, candidateId: { type: 'string', minLength: 1 }, relationDraft: { $ref: 'concordia://contracts/relation-contract-v1' }, proposedBy: { type: 'string', minLength: 1 }, provenance: { type: 'array', items: { type: 'string' } }, createdAt: { $ref: 'concordia://contracts/relation-contract-v1#/$defs/unknown' }, status: { enum: ['PROPOSED', 'DUPLICATE', 'CONFLICTED', 'INCOMPLETE', 'UNKNOWN'] } } } as const;
export const evidenceBundleSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'concordia://contracts/evidence-bundle-v1', type: 'object', required: ['schemaVersion', 'evidenceBundleId', 'relationRef', 'contractVersion', 'sourceRefs', 'runRef', 'observations', 'scope', 'completeness', 'capturedAt'], properties: { schemaVersion: { const: 1 }, evidenceBundleId: { type: 'string', minLength: 1 }, relationRef: { type: 'string', minLength: 1 }, contractVersion: { type: 'string', pattern: '^\\d+\\.\\d+$' }, sourceRefs: { type: 'array', items: { type: 'string' } }, observations: { type: 'array' }, completeness: { enum: ['COMPLETE_FOR_SCOPE', 'PARTIAL', 'TRUNCATED', 'TRANSPORT_FAILED', 'UNKNOWN'] } } } as const;
export const decisionSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'concordia://contracts/decision-v1', type: 'object', required: ['schemaVersion', 'decisionId', 'relationRef', 'contractVersion', 'verdict', 'reasonCodes', 'requirementsMet', 'requirementsMissing', 'contradictions', 'scope', 'evidenceBundleRefs', 'policyVersion', 'evaluatedAt', 'requiresReview', 'status'], properties: { schemaVersion: { const: 1 }, decisionId: { type: 'string', minLength: 1 }, relationRef: { type: 'string', minLength: 1 }, contractVersion: { type: 'string', pattern: '^\\d+\\.\\d+$' }, verdict: { enum: ['SOSTENIDA', 'ENGAÑOSA', 'INDETERMINADA'] }, policyVersion: { type: 'string', pattern: '^\\d+\\.\\d+$' }, requiresReview: { type: 'boolean' }, status: { enum: ['CURRENT', 'INCOMPLETE', 'UNKNOWN'] } } } as const;
