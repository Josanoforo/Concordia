import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCandidateMethods, type CandidateComparisonInput, type FrozenCandidateCase, type FrozenCandidateSnapshot } from '../src/eval/candidate-comparison.ts';

const hash = (letter: string) => letter.repeat(64);
function snapshot(): FrozenCandidateSnapshot {
  const table = (columns: string[], rows: (string | number | boolean | null)[][], labels: string[], role: string, keyColumns: string[]) => ({
    schema: columns.map(name => ({ name, type: 'integer' })), columns, sample: { requestId: `request-${columns[0]}`, queryId: `query-${columns[0]}`, durationMs: 1,
      utc: '2026-10-23T12:00:00.000Z', sql: 'SELECT allowlisted_columns LIMIT 2', rows }, labels, role, keyColumns
  });
  return { schemaVersion: 1, universeId: 'U-SYNTH', database: 'fixture_db', normalizationContract: { defaultMode: 'integer', modes: { integer: { version: 'fixture' } } },
    tables: {
      taxi_trips: table(['pickup_zone_id'], [[1], [2]], [], 'fact', ['pickup_zone_id']),
      yellow_taxi: table(['pickup_zone_id'], [[1], [3]], [], 'fact', ['pickup_zone_id']),
      taxi_zones: table(['LocationID', 'Zone'], [[1, 'Alpha'], [2, 'Beta']], ['Zone'], 'dimension', ['LocationID']),
      zones: table(['zone_id', 'zone'], [[1, 'Alpha'], [2, 'Beta']], ['zone'], 'dimension', ['zone_id'])
    }, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC',
    provenance: { sourcePath: 'fixture-only', sourceSha256: hash('e'), captureUtc: '2026-10-23T12:00:00.000Z', sourceDataOrigin: 'SYNTHETIC', excludedTables: ['hvv'], projection: 'keys-and-labels', knownDataset: false, blind: true } };
}
function testCase(caseId: string, taskId: string, fromTable: string, fromColumn: string, toTable: string, toColumn: string): FrozenCandidateCase {
  return { caseId, taskId, universeId: 'U-SYNTH', fromEndpoint: { db: 'fixture_db', table: fromTable, column: fromColumn }, toEndpoint: { db: 'fixture_db', table: toTable, column: toColumn } };
}
function input(): CandidateComparisonInput {
  const cases = [
    testCase('case-a-fact', 'fact-dimension-candidate', 'taxi_trips', 'pickup_zone_id', 'zones', 'zone_id'),
    testCase('case-b-fact', 'fact-dimension-candidate', 'yellow_taxi', 'pickup_zone_id', 'zones', 'zone_id'),
    testCase('case-c-out-of-family', 'fact-dimension-candidate', 'taxi_trips', 'pickup_zone_id', 'taxi_zones', 'LocationID'),
    testCase('case-z-catalog', 'catalog-candidate', 'taxi_zones', 'LocationID', 'zones', 'zone_id')
  ];
  return { snapshot: snapshot(), caseUniverse: { schemaVersion: 1, enumerationBasis: 'synthetic frozen endpoint pairs', cases },
    inputFreeze: { inputSha256: hash('a'), caseUniverseSha256: hash('b'), originalSourceSha256: hash('c'), configSha256: hash('d'), costExclusionsSha256: hash('f'),
      tables: 4, rows: 8, caseCount: cases.length, budget: { candidateLimit: 2, reviewMinutes: 15 }, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', timeHumanMeasured: false },
    freeze: { codeHash: hash('1'), policyHash: hash('2'), frozenAt: '2026-10-23T12:01:00.000Z' },
    policy: { policyVersion: '1.0', minimumDistinctKeys: 1, minimumOverlapRatio: 1 } };
}

test('E05D compares the existing solo rules and real provider union over the same frozen case universe and budget', async () => {
  const fixture = input(), before = structuredClone(fixture), originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network access must remain blocked'); }) as typeof fetch;
  try {
    const result = await compareCandidateMethods(fixture);
    assert.deepEqual(fixture, before, 'the pure comparison must not mutate its inputs');
    assert.deepEqual(result.caseIds, fixture.caseUniverse.cases.map(item => item.caseId).sort());
    assert.deepEqual(result.methods.map(method => method.methodId), ['key-family', 'paired-label-catalog', 'key-family+paired-label-catalog']);
    const [keys, labels, combined] = result.methods;
    assert.deepEqual(keys.proposedCaseIds, ['case-a-fact', 'case-b-fact']);
    assert.deepEqual(labels.proposedCaseIds, ['case-z-catalog']);
    assert.deepEqual(combined.proposedCaseIds, ['case-a-fact', 'case-b-fact', 'case-z-catalog']);
    assert.equal(keys.counts.eligibleCases, 3); assert.equal(labels.counts.eligibleCases, 1); assert.equal(combined.counts.eligibleCases, 4);
    assert.equal(keys.counts.proposedCases, 2); assert.equal(keys.counts.notProposed, 1);
    assert.deepEqual([keys.budget, labels.budget, combined.budget], Array(3).fill(fixture.inputFreeze.budget));
    assert.equal(combined.counts.proposals, 3); assert.equal(combined.counts.consulted, 2);
    assert.equal(combined.counts.candidateLimitNotConsulted, 1);
    assert.equal(combined.results.find(item => item.reasonCodes.includes('candidate_limit_reached'))?.status, 'NOT_CONSULTED');
    const unproposedFamilyCase = keys.results.find(item => item.caseId === 'case-c-out-of-family');
    assert.equal(unproposedFamilyCase?.status, 'NOT_CONSULTED');assert.deepEqual(unproposedFamilyCase?.reasonCodes, ['method_did_not_propose']);
    assert.equal(labels.results.find(item => item.caseId === 'case-a-fact')?.status, 'NOT_IN_SCOPE');
    assert.deepEqual(combined.rates.proposalCoverage, { numerator: 3, denominator: 4, value: 0.75 });
    assert.equal(combined.counts.providerAbstentions, 0);assert.equal(combined.counts.decisionAbstentions, 2);
    assert.equal(combined.byTask.find(task => task.taskId === 'fact-dimension-candidate')?.counts.eligibleCases, 3);
    assert.equal(combined.byTask.find(task => task.taskId === 'catalog-candidate')?.counts.eligibleCases, 1);
    assert.equal(result.semanticTruthAvailable, false);
    assert.deepEqual(combined.semanticMetrics, { precision: null, falseAcceptanceRate: null, recall: null, truth: 'UNKNOWN' });
    assert.equal(result.fullHeuristicEquivalence.matchesByCandidateIdentityAndReason, true);
    assert.equal(combined.production.executionMode, 'LOCAL'); assert.equal(combined.production.dataOrigin, 'SYNTHETIC');
    assert.deepEqual(combined.production.providers.map(provider => provider.providerId).sort(), ['concordia.e05d.key-family', 'concordia.e05d.paired-label-catalog']);
    assert.equal(combined.production.contributions.length, combined.production.candidates.length);
    assert.ok(combined.production.contributions.every(item => item.methodIds?.length && item.candidate.provenance.some(source => source.includes('concordia.e05d.'))));
    assert.deepEqual(result.inputFreeze, fixture.inputFreeze);assert.equal(result.runFreeze.inputSha256, fixture.inputFreeze.inputSha256);
  } finally { globalThis.fetch = originalFetch; }
});

test('E05D output is stable when the pre-enumerated manifest order changes', async () => {
  const firstInput = input(), secondInput = input();
  secondInput.caseUniverse.cases = [...secondInput.caseUniverse.cases].reverse();
  const first = await compareCandidateMethods(firstInput), second = await compareCandidateMethods(secondInput);
  assert.equal(first.comparisonHash, second.comparisonHash);
  assert.deepEqual(first.methods, second.methods);
});
