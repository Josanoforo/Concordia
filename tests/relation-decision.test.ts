import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceBundle, RelationContract } from '../src/contracts/types.ts';
import { evaluateRelation } from '../src/relations/index.ts';
import { classify } from '../src/probe/verdicts.ts';
import { evaluateLegacyPipelineProbe, legacyProbeToEvidence, planLegacyProbe } from '../src/relations/legacy.ts';
import { evaluateSchemaCorrespondence } from '../src/relations/schema-correspondence.ts';

function contract(): RelationContract {
  const known = (value: any) => ({ state: 'KNOWN' as const, value });
  return {
    schemaVersion: 1, id: 'fk-example', contractVersion: '1.1',
    universeRef: { universeId: 'fixture', universeVersion: { state: 'UNKNOWN' }, namespace: known('catalog-a'), configFingerprint: { state: 'UNKNOWN' } },
    kind: 'FOREIGN_KEY',
    from: { sourceId: 'source-a', namespace: known('catalog-a'), objectId: 'child', orderedColumns: ['parent_id'] },
    to: { sourceId: 'source-b', namespace: known('catalog-a'), objectId: 'parent', orderedColumns: ['id'] },
    identifierSpace: known('customer-id'),
    normalization: [{ componentIndex: 0, operation: known('text'), version: known('1'), lossless: known(true), adapterCapability: known('exact-text') }],
    semanticContext: { grain: { state: 'UNKNOWN' }, unit: { state: 'UNKNOWN' }, scale: { state: 'UNKNOWN' }, period: { state: 'UNKNOWN' }, timezone: { state: 'UNKNOWN' } },
    assertions: [], evidencePolicy: { requiredObservationTypes: ['KEY_MEMBERSHIP'], minimumCompleteness: 'COMPLETE_FOR_SCOPE', nulls: 'UNKNOWN', cardinality: 'UNKNOWN', declarationsAdmissible: 'UNKNOWN', minimumDistinctKeys: 2 }, reviewState: 'REVIEWED'
  };
}

function bundle(left: unknown[][], right: unknown[][], overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  const observation = (observationId: string, sourceRef: string, rows: unknown[][]) => ({
    observationId, type: 'KEY_MEMBERSHIP', sourceRef, adapterId: 'fake-local', requestId: { state: 'UNKNOWN' as const }, observedAt: { state: 'UNKNOWN' as const },
    checkedAt: '2026-01-01T00:00:00Z', nativeVersion: { state: 'UNKNOWN' as const }, fingerprint: { state: 'UNKNOWN' as const }, projection: sourceRef === 'source-a' ? ['parent_id'] : ['id'], filters: [], limit: 20,
    measuredTuples: rows, nullCount: 0, duplicateCount: 'UNKNOWN' as const, truncated: false, transportStatus: 'OK' as const, protectedPayloadRef: { state: 'UNKNOWN' as const }
  });
  return {
    schemaVersion: 1, evidenceBundleId: 'bundle-1', relationRef: 'fk-example', contractVersion: '1.1', sourceRefs: ['source-a', 'source-b'],
    runRef: { runId: 'local-synthetic-1', startedAt: { state: 'UNKNOWN' }, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', configFingerprint: { state: 'UNKNOWN' } },
    observations: [observation('obs-a', 'source-a', left), observation('obs-b', 'source-b', right)],
    scope: { state: 'KNOWN', value: 'fixture sample' }, completeness: 'COMPLETE_FOR_SCOPE', capturedAt: '2026-01-01T00:00:00Z', ...overrides
  };
}

test('A2 returns canonically ordered deterministic decisions regardless of evidence order', () => {
  const c = contract(), e = bundle([['01'], ['2']], [['01'], ['2']]);
  const first = evaluateRelation(c, [e], { policyVersion: '1.1' });
  const second = evaluateRelation(c, [{ ...e, observations: [...e.observations].reverse() }], { policyVersion: '1.1' });
  assert.deepEqual(first, second);
  assert.deepEqual(first.reasonCodes, ['bounded_sample_key_membership']);
  assert.deepEqual(first.evidenceBundleRefs, ['bundle-1']);
});

test('A2 leaves missing and partial evidence explicitly incomplete', () => {
  const c = contract();
  const absent = evaluateRelation(c, [], { policyVersion: '1.1' });
  assert.equal(absent.verdict, 'INDETERMINADA');
  assert.equal(absent.status, 'INCOMPLETE');
  const partial = bundle([['a'], ['b']], [['a'], ['b']], { completeness: 'PARTIAL' });
  const incomplete = evaluateRelation(c, [partial], { policyVersion: '1.1' });
  assert.equal(incomplete.status, 'INCOMPLETE');
  assert.ok(incomplete.requirementsMissing.includes('complete_untruncated_transport'));
});

test('A2 refuses to mix evidence from different contract versions', () => {
  const c = contract();
  const matching = bundle([['a'], ['b']], [['a'], ['b']]);
  const stale = { ...matching, evidenceBundleId: 'bundle-old', contractVersion: '0.9' };
  const result = evaluateRelation(c, [matching, stale], { policyVersion: '1.1' });
  assert.equal(result.status, 'UNKNOWN');
  assert.deepEqual(result.reasonCodes, ['contract_version_mismatch']);
  assert.deepEqual(result.evidenceBundleRefs, ['bundle-1', 'bundle-old']);
  assert.equal(result.contractVersion, c.contractVersion);
});

test('A2 policy override cannot weaken the contract distinct sample minimum', () => {
  const c = contract();
  const result = evaluateRelation(c, [bundle([['a']], [['a']])], { policyVersion: '1.1', minimumDistinctKeys: 0 });
  assert.deepEqual(result.reasonCodes, ['insufficient_distinct_sample_keys']);
  assert.ok(result.requirementsMissing.includes('at_least_2_distinct_keys'));
});

test('A2 requires compatible known namespaces and explicit identifier space', () => {
  const c = contract(), e = bundle([['a'], ['b']], [['a'], ['b']]);
  assert.equal(evaluateRelation(c, [e], { policyVersion: '1.1' }).verdict, 'SOSTENIDA');
  c.to.namespace = { state: 'KNOWN', value: 'other-catalog' };
  const incompatible = evaluateRelation(c, [e], { policyVersion: '1.1' });
  assert.equal(incompatible.verdict, 'INDETERMINADA');
  assert.deepEqual(incompatible.contradictions, ['namespace_mismatch']);
  c.to.namespace = { state: 'KNOWN', value: 'catalog-a' };
  c.identifierSpace = { state: 'UNKNOWN' };
  assert.equal(evaluateRelation(c, [e], { policyVersion: '1.1' }).status, 'UNKNOWN');
});

test('A2 treats text 01 and 1 as distinct and never infers global uniqueness from sample tuples', () => {
  const c = contract();
  const distinct = evaluateRelation(c, [bundle([['01'], ['2']], [['1'], ['2']])], { policyVersion: '1.1' });
  assert.equal(distinct.verdict, 'ENGAÑOSA');
  const duplicateTargetSample = evaluateRelation(c, [bundle([['a'], ['b']], [['a'], ['a'], ['b']])], { policyVersion: '1.1' });
  assert.equal(duplicateTargetSample.verdict, 'SOSTENIDA');
  assert.ok(duplicateTargetSample.requirementsMissing.includes('global_uniqueness_not_established'));
});

test('A2 retains nonnumeric text under integer mode so malformed values cannot inflate bounded overlap', () => {
  const c = contract();
  c.normalization[0].operation = { state: 'KNOWN', value: 'integer' };
  const result = evaluateRelation(c, [bundle([['1'], ['not-a-number']], [['1'], ['different-text']])], { policyVersion: '1.1', minimumDistinctKeys: 2, minimumOverlapRatio: 1 });
  assert.equal(result.verdict, 'ENGAÑOSA');
  assert.deepEqual(result.reasonCodes, ['observed_key_missing_from_referenced_sample']);
});test('A2 unknown relation semantics cannot be promoted from matching values', () => {
  const c = contract(), e = bundle([['a'], ['b']], [['a'], ['b']]);
  c.kind = 'UNKNOWN';
  const result = evaluateRelation(c, [e], { policyVersion: '1.1' });
  assert.equal(result.verdict, 'INDETERMINADA');
  assert.deepEqual(result.requirementsMissing, ['reviewed_relation_kind']);
});

test('A2 unreviewed relation semantics remain UNKNOWN even with matching samples', () => {
  const c = contract(), e = bundle([['a'], ['b']], [['a'], ['b']]);
  c.reviewState = 'PENDING';
  const result = evaluateRelation(c, [e], { policyVersion: '1.1' });
  assert.equal(result.verdict, 'INDETERMINADA');
  assert.deepEqual(result.reasonCodes, ['relation_contract_not_reviewed']);
});test('A2 legacy verdict consumer accepts typed contracts through the shared evaluator', () => {
  const result = classify(contract(), { evidence: [bundle([['a'], ['b']], [['a'], ['b']])], policyVersion: '1.1' });
  assert.deepEqual(result, { verdict: 'SOSTENIDA', rule: 'bounded_sample_key_membership' });
});

test('L1 legacy pipeline bridge preserves raw evidence and does not infer run provenance', () => {
  const probe: any = {
    relation: { id: 'legacy-cik', from: { db: 'SEC_DATA', table: 'child', column: 'cik' }, to: { db: 'SEC_DATA', table: 'parent', column: 'cik' }, minDistinctKeys: 1 },
    utc: '2026-10-22T00:00:00.000Z', status: 'PASS', normalization: 'integer-pad10',
    typeCompat: { normalization: 'integer-pad10', castable: true }, alerts: [],
    queries: [{ requestId: 'request-a', rows: [['0000320193']] }, { requestId: 'request-b', rows: [['320193']] }]
  };
  const plan = planLegacyProbe(probe.relation, 'U2', '1.1', 'integer-pad10', 1, { 'SEC_DATA.child': ['cik'], 'SEC_DATA.parent': ['cik'] }, 4);
  assert.equal(plan.limit, 4);
  assert.deepEqual(plan.endpoints.map(endpoint => endpoint.columns), [['cik'], ['cik']]);
  assert.throws(() => planLegacyProbe(probe.relation, 'U2', '1.1', 'integer-pad10', 1, { 'SEC_DATA.child': ['other'], 'SEC_DATA.parent': ['cik'] }, 4), /COLUMN_OUTSIDE_ALLOWLIST/);
  const projectionPlan = planLegacyProbe(probe.relation, 'U2', '1.1', 'integer-pad10', 1, { 'SEC_DATA.child': ['cik', 'label'], 'SEC_DATA.parent': ['cik', 'label'] }, 4, { 'SEC_DATA.child': ['label'], 'SEC_DATA.parent': ['label'] });
  assert.deepEqual(projectionPlan.endpoints.map(endpoint => endpoint.columns), [['cik', 'label'], ['cik', 'label']]);
  assert.throws(() => planLegacyProbe(probe.relation, 'U2', '1.1', 'integer-pad10', 1, { 'SEC_DATA.child': ['cik'], 'SEC_DATA.parent': ['cik'] }, 4, { 'SEC_DATA.child': ['label'] }), /COLUMN_OUTSIDE_ALLOWLIST/);
  const adapted = legacyProbeToEvidence(probe, 'U2', { minDistinctKeys: 1 }, { contractVersion: '2.0' });
  assert.equal(adapted.evidence.runRef.executionMode, 'UNKNOWN');
  assert.equal(adapted.evidence.runRef.dataOrigin, 'UNKNOWN');
  assert.deepEqual(adapted.evidence.observations[0].measuredTuples, [['0000320193']]);
  const evaluatorResult = evaluateRelation(adapted.contract, [adapted.evidence], { policyVersion: '1.1', minimumDistinctKeys: 1 });
  assert.equal(adapted.contract.kind, 'UNKNOWN');
  assert.deepEqual(adapted.contract.identifierSpace, { state: 'UNKNOWN' });
  assert.deepEqual(adapted.contract.normalization[0].lossless, { state: 'UNKNOWN' });
  assert.equal(evaluatorResult.verdict, 'INDETERMINADA');
  assert.ok(evaluatorResult.reasonCodes.includes('identifier_space_or_namespace_unknown'));

  const declaredProbe = { ...probe, relation: { ...probe.relation, kind: 'FOREIGN_KEY' as const, identifierSpace: 'sec-cik-v1', normalizationVersion: 'integer-pad10-v1', normalizationLossless: true, normalizationAdapterCapability: 'integer-pad10-exact', reviewState: 'REVIEWED' } };
  const explicit = legacyProbeToEvidence(declaredProbe, 'U2', { minDistinctKeys: 1 }, { contractVersion: '2.0', executionMode: 'REPLAY', dataOrigin: 'PUBLIC' });
  assert.equal(explicit.evidence.runRef.executionMode, 'REPLAY');
  assert.equal(explicit.evidence.runRef.dataOrigin, 'PUBLIC');
  const cliPath = classify(declaredProbe, { universeId: 'U2', contractVersion: '2.0', relationPolicyVersion: '1.1', minDistinctKeys: 1, sustainedOverlap: 1 });
  assert.deepEqual(cliPath, { verdict: 'SOSTENIDA', rule: 'bounded_sample_key_membership' });
  const explicitDecision = evaluateRelation(explicit.contract, [explicit.evidence], { policyVersion: '1.1', minimumDistinctKeys: 1, minimumOverlapRatio: 1 });
  assert.equal(cliPath.verdict, explicitDecision.verdict);

  const historical = legacyProbeToEvidence(declaredProbe, 'U2', { minDistinctKeys: 1 }, { contractVersion: '1.0', executionMode: 'REPLAY', dataOrigin: 'PUBLIC' });
  const currentContract = { ...historical.contract, contractVersion: '2.0' };
  const versioned = evaluateRelation(currentContract, [historical.evidence], { policyVersion: '1.1', minimumDistinctKeys: 1 });
  assert.deepEqual(versioned.reasonCodes, ['contract_version_mismatch']);
});
test('L1 label conflict stays UNKNOWN when relation semantics are not established', async () => {
  const probe: any = {
    relation: { id: 'legacy-label-conflict', from: { db: 'CATALOG_A', table: 'child', column: 'id' }, to: { db: 'CATALOG_A', table: 'parent', column: 'id' } },
    utc: '2026-10-22T00:00:00.000Z', status: 'PASS', normalization: 'text',
    labelAgreement: { ratio: 0 }, queries: [{ rows: [['x']] }, { rows: [['x']] }]
  };
  const result = await evaluateLegacyPipelineProbe(probe, 'U2', { relationPolicyVersion: '1.1', misleadingLabelAgreement: 0.5 }, { contractVersion: '2.0', executionMode: 'REPLAY', dataOrigin: 'PUBLIC' });
  assert.equal(result.decision.verdict, 'INDETERMINADA');
  assert.deepEqual(result.decision.reasonCodes, ['observed_label_conflict_under_unknown_semantics']);
  assert.deepEqual(result.decision.requirementsMet, []);
  assert.deepEqual(result.decision.contradictions, ['sampled_labels_contradict']);
});
test('L1 U3 schema correspondence uses the shared evaluator with explicit provenance context', () => {
  const input = { universeId: 'U3', contractVersion: '1.0', relationId: 'forbes.company__target_schema.revenue', source: { db: 'MADI_COMPANIES', table: 'forbes', column: 'sales_figure' }, target: { dataset: 'target_schema', column: 'revenue' }, candidate: 'revenue', rule: 'unique_metadata_concept', distinctValues: 5, observedRows: 5, compatible: true, minDistinctKeys: 3, policyVersion: '1.1', checkedAt: '2026-10-22T00:00:00.000Z', provenance: { executionMode: 'LOCAL' as const, dataOrigin: 'SYNTHETIC' as const } };
  const evaluated = evaluateSchemaCorrespondence(input);
  assert.equal(evaluated.decision.verdict, 'INDETERMINADA');
  assert.deepEqual(evaluated.decision.reasonCodes, ['candidate_requires_adjudication']);
  assert.ok(evaluated.decision.requirementsMissing.includes('adjudicated_schema_correspondence'));
  assert.equal(evaluated.evidence.runRef.executionMode, 'LOCAL');
  assert.equal(evaluated.evidence.runRef.dataOrigin, 'SYNTHETIC');
  const unresolved = evaluateSchemaCorrespondence({ ...input, candidate: null, rule: 'ambiguous_or_unknown_metadata', compatible: false });
  assert.equal(unresolved.decision.verdict, 'INDETERMINADA');
  assert.notEqual(unresolved.decision.reasonCodes[0], 'candidate_requires_adjudication');
});

test('L1 U1 probes use the shared evaluator for exact text, declared integer mode and partial transport', () => {
  const thresholds = { universeId: 'U1', contractVersion: '2.0', relationPolicyVersion: '1.1', minDistinctKeys: 1, sustainedOverlap: 1, misleadingLabelAgreement: 0.5, sustainedLabelAgreement: 0.8 };
  const probe: any = { relation: { id: 'u1-zone', kind: 'FOREIGN_KEY', identifierSpace: 'taxi-zone-id-v1', normalizationVersion: 'integer-v1', normalizationLossless: true, normalizationAdapterCapability: 'integer-exact', reviewState: 'REVIEWED', from: { db: 'NY_TAXI', table: 'source', column: 'zone_id' }, to: { db: 'NY_TAXI', table: 'target', column: 'id' } }, utc: '2026-10-22T00:00:00.000Z', status: 'PASS', typeCompat: { normalization: 'integer', castable: true }, alerts: [], queries: [{ rows: [['01']] }, { rows: [['1']] }] };
  assert.equal(classify(probe, thresholds).verdict, 'SOSTENIDA');
  const literal = { ...probe, typeCompat: { normalization: 'text', castable: true } };
  assert.equal(classify(literal, thresholds).verdict, 'ENGAÑOSA');
  const partial = { ...probe, status: 'FAIL', queries: [{ rows: [['1']] }] };
  assert.deepEqual(classify(partial, thresholds), { verdict: 'INDETERMINADA', rule: 'evidence_incomplete_or_truncated' });
});
test('L1 U2 captured responses execute through the common typed probe path and preserve explicit provenance', async () => {
  const probe: any = {
    relation: { id: 'legacy-cik', kind: 'FOREIGN_KEY', identifierSpace: 'sec-cik-v1', normalizationVersion: 'integer-pad10-v1', normalizationLossless: true, normalizationAdapterCapability: 'integer-pad10-exact', reviewState: 'REVIEWED', from: { db: 'SEC_DATA', table: 'child', column: 'cik' }, to: { db: 'SEC_DATA', table: 'parent', column: 'cik' }, minDistinctKeys: 1 },
    utc: '2026-10-22T00:00:00.000Z', status: 'PASS', normalization: 'integer-pad10', alerts: [],
    queries: [{ requestId: 'request-a', rows: [['0000320193']] }, { requestId: 'request-b', rows: [['320193']] }]
  };
  const result = await evaluateLegacyPipelineProbe(probe, 'U2', { minDistinctKeys: 1, relationPolicyVersion: '1.1', sustainedOverlap: 1, probeLimit: 10 }, { contractVersion: '2.0', executionMode: 'REPLAY', dataOrigin: 'PUBLIC' }, { 'SEC_DATA.child': ['cik'], 'SEC_DATA.parent': ['cik'] });
  assert.equal(result.evidence.runRef.executionMode, 'REPLAY');
  assert.equal(result.evidence.runRef.dataOrigin, 'PUBLIC');
  assert.deepEqual(result.evidence.observations[0].measuredTuples, [['0000320193']]);
  assert.equal(result.evidence.observations[0].limit, 10);
  assert.equal(result.decision.verdict, 'SOSTENIDA');
});
test('L1 typed probe replay preserves partial fragments and error status', async () => {
  const probe: any = {
    relation: { id: 'legacy-partial', from: { db: 'SEC_DATA', table: 'child', column: 'cik' }, to: { db: 'SEC_DATA', table: 'parent', column: 'cik' }, minDistinctKeys: 1 },
    utc: '2026-10-22T00:00:00.000Z', status: 'INCOMPLETE', normalization: 'integer-pad10', alerts: [],
    queries: [{ requestId: 'request-a', rows: [['0000320193']] }]
  };
  const partial = await evaluateLegacyPipelineProbe(probe, 'U2', { minDistinctKeys: 1, relationPolicyVersion: '1.1', sustainedOverlap: 1, probeLimit: 10 }, { contractVersion: '2.0', executionMode: 'REPLAY', dataOrigin: 'PUBLIC' }, { 'SEC_DATA.child': ['cik'], 'SEC_DATA.parent': ['cik'] });
  assert.equal(partial.evidence.completeness, 'PARTIAL');
  assert.deepEqual(partial.evidence.observations[0].measuredTuples, [['0000320193']]);
  assert.equal(partial.evidence.observations[1].transportStatus, 'ERROR');
  assert.equal(partial.decision.status, 'INCOMPLETE');
});
test('legacy evidence preserves null tuples and uses the configured limit for truncation', () => {
  const probe: any = { relation: { id: 'legacy-null', from: { db: 'SEC_DATA', table: 'child', column: 'cik' }, to: { db: 'SEC_DATA', table: 'parent', column: 'cik' } }, utc: '2026-10-22T00:00:00.000Z', status: 'PASS', normalization: 'text', queries: [{ rows: [[null]] }, { rows: [['1']] }] };
  const { evidence } = legacyProbeToEvidence(probe, 'U2', { probeLimit: 1 }, { contractVersion: '2.0' });
  assert.deepEqual(evidence.observations[0].measuredTuples, [[null]]);
  assert.equal(evidence.observations[0].nullCount, 1);
  assert.equal(evidence.observations[0].limit, 1);
  assert.equal(evidence.observations[0].truncated, true);
  assert.equal(evidence.observations[1].truncated, true);
  const unboundedForNullCheck = legacyProbeToEvidence(probe, 'U2', { probeLimit: 2 }, { contractVersion: '2.0' });
  const nullDecision = evaluateRelation(unboundedForNullCheck.contract, [unboundedForNullCheck.evidence], { policyVersion: '1.1', minimumDistinctKeys: 1 });
  assert.deepEqual(nullDecision.reasonCodes, ['null_or_malformed_tuple_observed']);
});
test('L1 legacy probe consumers preserve bounded quality decisions through the shared evaluator', async () => {
  const makeProbe = (left: unknown[][], right: unknown[][], mode: 'text' | 'integer' = 'text', extra: any = {}) => ({
    relation: { id: 'typed-quality', kind: 'FOREIGN_KEY' as const, identifierSpace: 'sec-cik-v2', normalizationVersion: `${mode}-v1`, normalizationLossless: true, normalizationAdapterCapability: `exact-${mode}`, reviewState: 'REVIEWED' as const, minDistinctKeys: 2,
      from: { db: 'SEC_DATA', table: 'child', column: 'cik' }, to: { db: 'SEC_DATA', table: 'parent', column: 'cik' } },
    utc: '2026-10-22T00:00:00.000Z', status: 'PASS', normalization: mode, alerts: [], queries: [{ rows: left }, { rows: right }], ...extra
  });
  const policy = { minDistinctKeys: 2, relationPolicyVersion: '1.1', sustainedOverlap: 1, misleadingLabelAgreement: 0.5, sustainedLabelAgreement: 0.8, probeLimit: 10 };
  const provenance = { contractVersion: '2.0', executionMode: 'REPLAY' as const, dataOrigin: 'PUBLIC' as const };
  const evaluate = async (probe: any) => (await evaluateLegacyPipelineProbe(probe, 'U2', policy, provenance)).decision;

  assert.equal((await evaluate(makeProbe([['01'], ['2']], [['1'], ['2']], 'text'))).verdict, 'ENGAÑOSA');
  assert.equal((await evaluate(makeProbe([['01'], ['2']], [['1'], ['2']], 'integer'))).verdict, 'SOSTENIDA');
  assert.deepEqual((await evaluate(makeProbe([[''], ['2']], [[''], ['2']]))).reasonCodes, ['normalization_rejected_observed_value']);
  assert.deepEqual((await evaluate(makeProbe([['1'], ['2']], [['1'], ['2']], 'text', { multiplicity: { manyToManyKeys: ['1'] } }))).reasonCodes, ['many_to_many']);
  assert.deepEqual((await evaluate(makeProbe([['1'], ['2']], [['1'], ['2']], 'text', { multiplicity: { to: { duplicateKeys: [{ key: '1', rows: 2 }] } } }))).reasonCodes, ['duplicate_referenced_keys']);
  assert.equal((await evaluate(makeProbe([['1'], ['2']], [['1'], ['2']], 'text', { labelAgreement: { ratio: 0 } }))).verdict, 'ENGAÑOSA');
  assert.equal((await evaluate(makeProbe([['1'], ['2']], [['1'], ['2']]))).verdict, 'SOSTENIDA', 'absent label evidence remains unknown, not conflict');
});
