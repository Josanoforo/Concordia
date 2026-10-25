import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateLegacyUniverseConfig, validateCandidate, validateDecision, validateEvidenceBundle, validateRelationContract } from '../src/contracts/index.ts';

const legacy = (id: string) => JSON.parse(readFileSync(`universes/${id === 'U2' ? 'U2_companies' : id === 'U1' ? 'U1_ny_taxi' : 'U3_madi_companies'}.json`, 'utf8'));

test('A1 migrates only declared U1/U2/U3 edges and preserves unknown semantics', () => {
  const u1 = migrateLegacyUniverseConfig(legacy('U1'));
  const u2 = migrateLegacyUniverseConfig(legacy('U2'));
  const u3 = migrateLegacyUniverseConfig(legacy('U3'));
  assert.equal(u1.value.length, 6);
  assert.ok(u1.value.every(edge => edge.kind === 'UNKNOWN'));
  assert.equal(u3.value.length, 0);
  assert.equal(u2.value.length, 3);
  assert.equal(u2.compatibility, 'MIGRATED');
  assert.equal(u2.value[0].kind, 'UNKNOWN');
  assert.deepEqual(u2.value[0].normalization[0].operation, { state: 'KNOWN', value: 'text', provenance: 'legacy-config' });
  assert.deepEqual(u2.value[0].normalization[0].lossless, { state: 'UNKNOWN' });
  assert.deepEqual(u2.value[0].semanticContext.grain, { state: 'UNKNOWN' });
  assert.ok(u2.warnings.length === 3);
});

test('A1 validates ordered components, namespaces and allowlisted columns', () => {
  const contract = migrateLegacyUniverseConfig(legacy('U2')).value[0];
  const allowlist = { tables: Object.fromEntries(Object.entries(legacy('U2').tables).map(([name, spec]: [string, any]) => [name, spec.columns.map((column: any) => column.name)])) };
  assert.deepEqual(validateRelationContract(contract, allowlist), []);
  const bad = structuredClone(contract);
  bad.from.orderedColumns = ['absent'];
  assert.ok(validateRelationContract(bad, allowlist).some(issue => issue.code === 'COLUMN_OUTSIDE_ALLOWLIST'));
  bad.from.orderedColumns = ['cik', 'sic'];
  assert.ok(validateRelationContract(bad).some(issue => issue.code === 'NORMALIZATION_ARITY_MISMATCH'));
  bad.from.orderedColumns = ['cik'];
  bad.normalization[0].componentIndex = 1;
  assert.ok(validateRelationContract(bad).some(issue => issue.code === 'NORMALIZATION_ORDER_MISMATCH'));
});

test('A1 DTO validators reject undeclared execution mode and malformed versioned refs', () => {
  const migrated = migrateLegacyUniverseConfig(legacy('U2')).value[0];
  const candidate = { schemaVersion: 1, candidateId: 'candidate-1', relationDraft: migrated, proposedBy: 'fixture-rule', provenance: ['fixture'], createdAt: { state: 'UNKNOWN' }, status: 'PROPOSED' };
  assert.deepEqual(validateCandidate(candidate), []);
  assert.ok(validateCandidate({ ...candidate, createdAt: 'not-explicit' }).some(issue => issue.code === 'EXPECTED_UNKNOWN_VALUE'));
  const evidence: any = { schemaVersion: 1, evidenceBundleId: 'ev-1', relationRef: migrated.id, contractVersion: migrated.contractVersion, sourceRefs: [], runRef: { runId: 'run-local', startedAt: { state: 'UNKNOWN' }, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', configFingerprint: { state: 'UNKNOWN' } }, observations: [], scope: { state: 'UNKNOWN' }, completeness: 'PARTIAL', capturedAt: '2026-01-01T00:00:00Z' };
  assert.deepEqual(validateEvidenceBundle(evidence), []);
  evidence.runRef.executionMode = 'UNDECLARED';
  assert.ok(validateEvidenceBundle(evidence).some(issue => issue.code === 'INVALID_RUN_REF'));
  const decision = { schemaVersion: 1, decisionId: 'd-1', relationRef: migrated.id, contractVersion: migrated.contractVersion, verdict: 'INDETERMINADA', reasonCodes: [], requirementsMet: [], requirementsMissing: [], contradictions: [], scope: { state: 'UNKNOWN' }, evidenceBundleRefs: [], policyVersion: '1.0', evaluatedAt: { state: 'UNKNOWN' }, requiresReview: true, status: 'INCOMPLETE' };
  assert.deepEqual(validateDecision(decision), []);
});

test('A1 rejects known values that do not match their declared field type', () => {
  const contract = migrateLegacyUniverseConfig(legacy('U2')).value[0];
  const badNamespace = structuredClone(contract);
  (badNamespace.from.namespace as any) = { state: 'KNOWN', value: 12 };
  assert.ok(validateRelationContract(badNamespace).some(issue => issue.path === 'from.namespace' && issue.code === 'INVALID_UNKNOWN_VALUE'));
  const badLossless = structuredClone(contract);
  (badLossless.normalization[0].lossless as any) = { state: 'KNOWN', value: 'true' };
  assert.ok(validateRelationContract(badLossless).some(issue => issue.path === 'normalization[0].lossless' && issue.code === 'INVALID_UNKNOWN_VALUE'));
  const evidence: any = { schemaVersion: 1, evidenceBundleId: 'ev-1', relationRef: contract.id, contractVersion: contract.contractVersion, sourceRefs: [], runRef: { runId: 'run-local', startedAt: { state: 'KNOWN', value: 12 }, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', configFingerprint: { state: 'UNKNOWN' } }, observations: [], scope: { state: 'KNOWN', value: 42 }, completeness: 'PARTIAL', capturedAt: '2026-01-01T00:00:00Z' };
  assert.ok(validateEvidenceBundle(evidence).some(issue => issue.path === 'runRef.startedAt'));
  assert.ok(validateEvidenceBundle(evidence).some(issue => issue.path === 'scope'));
  evidence.runRef.startedAt = { state: 'KNOWN', value: 'not-a-date' };
  assert.ok(validateEvidenceBundle(evidence).some(issue => issue.path === 'runRef.startedAt' && issue.code === 'INVALID_TIMESTAMP'));
  const badDecision = { schemaVersion: 1, decisionId: 'd-2', relationRef: contract.id, contractVersion: contract.contractVersion, verdict: 'INDETERMINADA', reasonCodes: [], requirementsMet: [], requirementsMissing: [], contradictions: [], scope: { state: 'KNOWN', value: 2 }, evidenceBundleRefs: [], policyVersion: '1.0', evaluatedAt: { state: 'KNOWN', value: 'not-a-date' }, requiresReview: true, status: 'UNKNOWN' };
  assert.ok(validateDecision(badDecision).some(issue => issue.path === 'scope'));
  assert.ok(validateDecision(badDecision).some(issue => issue.path === 'evaluatedAt' && issue.code === 'INVALID_TIMESTAMP'));
});
