import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceBundle, RelationContract } from '../src/contracts/types.ts';
import { createEvaluationProtocol, evaluateDevelopment, type EvaluationCase, type MethodRun } from '../src/eval/protocol.ts';

const known = <T extends string | boolean>(value: T) => ({ state: 'KNOWN' as const, value });
function contract(id: string, compatible = true): RelationContract {
  return { schemaVersion: 1, id, contractVersion: '1.0', universeRef: { universeId: 'U-SYNTH', universeVersion: { state: 'UNKNOWN' }, namespace: known('fixture-catalog'), configFingerprint: { state: 'UNKNOWN' } },
    kind: 'FOREIGN_KEY', from: { sourceId: `${id}-from`, namespace: known('fixture-catalog'), objectId: 'child', orderedColumns: ['key'] },
    to: { sourceId: `${id}-to`, namespace: known(compatible ? 'fixture-catalog' : 'other-catalog'), objectId: 'parent', orderedColumns: ['key'] }, identifierSpace: known('synthetic-id'),
    normalization: [{ componentIndex: 0, operation: known('text'), version: known('1'), lossless: known(true), adapterCapability: known('exact-text') }],
    semanticContext: { grain: { state: 'UNKNOWN' }, unit: { state: 'UNKNOWN' }, scale: { state: 'UNKNOWN' }, period: { state: 'UNKNOWN' }, timezone: { state: 'UNKNOWN' } }, assertions: [],
    evidencePolicy: { requiredObservationTypes: ['KEY_MEMBERSHIP'], minimumCompleteness: 'COMPLETE_FOR_SCOPE', nulls: 'UNKNOWN', cardinality: 'UNKNOWN', declarationsAdmissible: 'UNKNOWN', minimumDistinctKeys: 1 }, reviewState: 'REVIEWED' };
}
function evidence(c: RelationContract): EvidenceBundle {
  const observation = (id: string, sourceRef: string, tuples: unknown[][]) => ({ observationId: id, type: 'KEY_MEMBERSHIP', sourceRef, adapterId: 'local-fixture', requestId: known(id), observedAt: known('2026-01-01T00:00:00Z'), checkedAt: '2026-01-01T00:01:00Z', nativeVersion: { state: 'UNKNOWN' as const }, fingerprint: { state: 'UNKNOWN' as const }, projection: ['key'], filters: [], limit: 5, measuredTuples: tuples, nullCount: 0, duplicateCount: 'UNKNOWN' as const, truncated: false, transportStatus: 'OK' as const, protectedPayloadRef: { state: 'UNKNOWN' as const } });
  return { schemaVersion: 1, evidenceBundleId: `evidence-${c.id}`, relationRef: c.id, contractVersion: c.contractVersion, sourceRefs: [c.from.sourceId, c.to.sourceId],
    runRef: { runId: 'local-synthetic-run', startedAt: known('2026-01-01T00:00:00Z'), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', configFingerprint: { state: 'UNKNOWN' } },
    observations: [observation('obs-from', c.from.sourceId, [['01']]), observation('obs-to', c.to.sourceId, [['01']])], scope: known('bounded synthetic fixture'), completeness: 'COMPLETE_FOR_SCOPE', capturedAt: '2026-01-01T00:01:00Z' };
}
function testCase(caseId: string, positive: boolean, compatible: boolean): EvaluationCase {
  const relation = contract(caseId, compatible);
  return { caseId, split: 'DEVELOPMENT', taskId: 'relation-support', universeId: 'U-SYNTH', inputSetHash: 'source-input-hash', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', contract: relation, evidence: [evidence(relation)],
    adjudication: { truth: positive ? 'APPROVABLE' : 'NONAPPROVABLE', basis: 'SYNTHETIC_FIXTURE', adjudicatorId: 'synthetic-fixture-curator', referenceHash: `label-hash-${caseId}`, adjudicatedAt: '2026-01-02T00:00:00Z' } };
}
const protocol = createEvaluationProtocol({ protocolVersion: '1.0', evaluatorVersion: '1.0.0', policyVersion: '1.0', codeHash: 'code-hash', policyHash: 'policy-hash', frozenAt: '2026-01-03T00:00:00Z',
  developmentCaseIds: ['positive-1', 'negative-1'], positiveEnumerationComplete: true, reservedHoldout: { manifestId: 'reserved-v1', version: '1', contentHash: 'holdout-hash', caseCount: 12, accessState: 'NOT_READ' } });

test('E development protocol uses the shared evaluator and reports explicit task denominators', () => {
  const methodA: MethodRun = { methodId: 'rules-a', providerVersion: '1', inputSetHash: 'source-input-hash', budget: { candidateLimit: 20, reviewMinutes: 10 }, cases: [testCase('positive-1', true, true), testCase('negative-1', false, false)] };
  const methodB: MethodRun = { ...methodA, methodId: 'rules-b', cases: [testCase('positive-1', true, true), testCase('negative-1', false, true)] };
  const run = evaluateDevelopment(protocol, [methodA, methodB], { policyVersion: '1.0' });
  assert.equal(run.split, 'DEVELOPMENT'); assert.deepEqual(run.holdout, protocol.reservedHoldout);
  assert.equal(run.metricDefinitionVersion, 'e05a-enumerated-denominators-v2');
  assert.equal(run.results.length, 4);
  const a = run.metrics.find(metric => metric.methodId === 'rules-a')!, b = run.metrics.find(metric => metric.methodId === 'rules-b')!;
  assert.deepEqual(a.denominator, { allCases: 2, consulted: 2, evaluated: 2, notConsulted: 0, accepts: 1, adjudicatedAccepts: 1, nonapprovable: 1, positives: 1 });
  assert.equal(a.precisionAccept, 1); assert.equal(a.falseAcceptanceRate, 0); assert.equal(a.recallPositive, 1);
  assert.equal(a.notConsultedRate, 0);
  assert.equal(b.precisionAccept, 0.5); assert.equal(b.falseAcceptanceRate, 1);
  for (const metric of run.metrics) { assert.equal(metric.dataOrigin, 'SYNTHETIC'); assert.equal(metric.executionMode, 'LOCAL'); }
});

test('E precision includes accepted UNKNOWN cases in the denominator and reports uncertainty separately', () => {
  const unknown = { ...testCase('unknown-1', false, true), adjudication: { ...testCase('unknown-1', false, true).adjudication, truth: 'UNKNOWN' as const } };
  const selectedProtocol = createEvaluationProtocol({ ...protocol, developmentCaseIds: ['positive-1', 'unknown-1'] });
  const method: MethodRun = { methodId: 'known-plus-unknown', providerVersion: '1', inputSetHash: 'source-input-hash', budget: { candidateLimit: 2, reviewMinutes: 5 }, cases: [testCase('positive-1', true, true), unknown] };
  const metric = evaluateDevelopment(selectedProtocol, [method], { policyVersion: '1.0' }).metrics[0];
  assert.equal(metric.denominator.accepts, 2);
  assert.equal(metric.denominator.adjudicatedAccepts, 1);
  assert.equal(metric.counts.unknownAdjudications, 1);
  assert.equal(metric.precisionAccept, 0.5);

  const unknown2 = { ...unknown, caseId: 'unknown-2', inputSetHash: 'source-input-hash', adjudication: { ...unknown.adjudication, referenceHash: 'label-hash-unknown-2' } };
  const allUnknownProtocol = createEvaluationProtocol({ ...protocol, developmentCaseIds: ['unknown-1', 'unknown-2'] });
  const allUnknownMethod: MethodRun = { ...method, methodId: 'unknown-only', cases: [unknown, unknown2] };
  const allUnknownMetric = evaluateDevelopment(allUnknownProtocol, [allUnknownMethod], { policyVersion: '1.0' }).metrics[0];
  assert.equal(allUnknownMetric.denominator.accepts, 2);
  assert.equal(allUnknownMetric.denominator.adjudicatedAccepts, 0);
  assert.equal(allUnknownMetric.counts.unknownAdjudications, 2);
  assert.equal(allUnknownMetric.precisionAccept, 0);
});

test('E leaves undefined denominators null and does not infer recall without enumerated positives', () => {
  const f = testCase('negative-1', false, false);
  const noAccept: MethodRun = { methodId: 'abstaining', providerVersion: '1', inputSetHash: 'source-input-hash', budget: { candidateLimit: 1, reviewMinutes: 1 }, cases: [f] };
  const noPositiveProtocol = createEvaluationProtocol({ ...protocol, developmentCaseIds: ['negative-1'], positiveEnumerationComplete: false });
  const metric = evaluateDevelopment(noPositiveProtocol, [noAccept], { policyVersion: '1.0' }).metrics[0];
  assert.equal(metric.precisionAccept, null); assert.equal(metric.recallPositive, null);
  assert.equal(metric.denominator.accepts, 0); assert.equal(metric.denominator.positives, 0);
});

test('E rejects holdout cases, split drift, and incomparable ablation budgets or inputs', () => {
  const holdout = { ...testCase('positive-1', true, true), split: 'RESERVED_HOLDOUT' as const };
  const method: MethodRun = { methodId: 'm1', providerVersion: '1', inputSetHash: 'source-input-hash', budget: { candidateLimit: 2, reviewMinutes: 5 }, cases: [testCase('positive-1', true, true), testCase('negative-1', false, false)] };
  assert.throws(() => evaluateDevelopment(protocol, [{ ...method, cases: [holdout, method.cases[1]] }], { policyVersion: '1.0' }), /DEVELOPMENT_CASE_INVALID/);
  assert.throws(() => evaluateDevelopment(protocol, [{ ...method, cases: [method.cases[0]] }], { policyVersion: '1.0' }), /DEVELOPMENT_SPLIT_MISMATCH/);
  assert.throws(() => evaluateDevelopment(protocol, [method, { ...method, methodId: 'm2', budget: { ...method.budget, reviewMinutes: 6 } }], { policyVersion: '1.0' }), /ABLATION_INPUT_OR_BUDGET_MISMATCH/);
  assert.throws(() => evaluateDevelopment(protocol, [method, { ...method, methodId: 'm2', inputSetHash: 'other-input' }], { policyVersion: '1.0' }), /DEVELOPMENT_CASE_INVALID/);
});

test('E enforces candidateLimit deterministically and reports cases not consulted outside scored denominators', () => {
  const method: MethodRun = { methodId: 'bounded-review', providerVersion: '1', inputSetHash: 'source-input-hash', budget: { candidateLimit: 1, reviewMinutes: 5 }, cases: [testCase('positive-1', true, true), testCase('negative-1', false, false)] };
  const run = evaluateDevelopment(protocol, [method], { policyVersion: '1.0' });
  const metric = run.metrics[0];
  assert.deepEqual(metric.denominator, { allCases: 2, consulted: 1, evaluated: 1, notConsulted: 1, accepts: 0, adjudicatedAccepts: 0, nonapprovable: 1, positives: 1 });
  assert.equal(metric.counts.notConsulted, 1);
  assert.equal(metric.notConsultedRate, 0.5);
  assert.equal(metric.recallPositive, 0);
  assert.deepEqual(run.results.find(result => result.caseId === 'positive-1'), { methodId: 'bounded-review', caseId: 'positive-1', verdict: 'NOT_CONSULTED', reasonCodes: ['candidate_limit_reached'] });
});

test('E recall and FAR use complete enumerated reference denominators under a one-candidate budget', () => {
  const positiveProtocol = createEvaluationProtocol({ ...protocol, developmentCaseIds: ['positive-1', 'positive-2'] });
  const positiveMethod: MethodRun = { methodId: 'bounded-positive', providerVersion: '1', inputSetHash: 'source-input-hash', budget: { candidateLimit: 1, reviewMinutes: 5 }, cases: [testCase('positive-1', true, true), testCase('positive-2', true, true)] };
  const positiveMetric = evaluateDevelopment(positiveProtocol, [positiveMethod], { policyVersion: '1.0' }).metrics[0];
  assert.equal(positiveMetric.counts.correctAccept, 1);
  assert.equal(positiveMetric.denominator.positives, 2);
  assert.equal(positiveMetric.recallPositive, 0.5);

  const negativeProtocol = createEvaluationProtocol({ ...protocol, developmentCaseIds: ['negative-1', 'negative-2'] });
  const negativeMethod: MethodRun = { methodId: 'bounded-negative', providerVersion: '1', inputSetHash: 'source-input-hash', budget: { candidateLimit: 1, reviewMinutes: 5 }, cases: [testCase('negative-1', false, true), testCase('negative-2', false, true)] };
  const negativeMetric = evaluateDevelopment(negativeProtocol, [negativeMethod], { policyVersion: '1.0' }).metrics[0];
  assert.equal(negativeMetric.counts.falseAccept, 1);
  assert.equal(negativeMetric.denominator.nonapprovable, 2);
  assert.equal(negativeMetric.falseAcceptanceRate, 0.5);
});

test('E keeps task and universe metrics in separate buckets', () => {
  const base = testCase('identity-1', true, true);
  const secondScope: EvaluationCase = { ...base, taskId: 'identity-match', universeId: 'U-SYNTH-2', contract: { ...base.contract, universeRef: { ...base.contract.universeRef, universeId: 'U-SYNTH-2' } } };
  const selectedProtocol = createEvaluationProtocol({ ...protocol, developmentCaseIds: ['identity-1', 'positive-1'] });
  const method: MethodRun = { methodId: 'separated-tasks', providerVersion: '1', inputSetHash: 'source-input-hash', budget: { candidateLimit: 2, reviewMinutes: 5 }, cases: [testCase('positive-1', true, true), secondScope] };
  const metrics = evaluateDevelopment(selectedProtocol, [method], { policyVersion: '1.0' }).metrics;
  assert.equal(metrics.length, 2);
  assert.deepEqual(new Set(metrics.map(metric => `${metric.universeId}:${metric.taskId}`)), new Set(['U-SYNTH:relation-support', 'U-SYNTH-2:identity-match']));
});
