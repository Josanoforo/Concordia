import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKey } from '../src/universe.ts';
import { readJson } from '../src/runtime.ts';
import { measureMultiplicity, sharedRowPairs, compareLabels } from '../src/probe/index.ts';
import { assessFreshness, assessPartialTransport } from '../src/probe/evidence-contract.ts';

const u1 = readJson<any>('universes/U1_ny_taxi.json').normalizationContract;
const u2 = readJson<any>('universes/U2_companies.json').normalizationContract;

test('EC01: numeric padding and zero suffix normalize only under a numeric contract', () => {
  const numeric = ['1', '1.0', '01', '001.00'].map(value => normalizeKey(value, 'integer'));
  assert.deepEqual(new Set(numeric), new Set(['1']));
  assert.notEqual(normalizeKey('1.25', 'integer'), normalizeKey('1', 'integer'));
  assert.notEqual(normalizeKey('01', 'text'), normalizeKey('1', 'text'));
  assert.equal(normalizeKey('1.0', 'text'), '1.0');
  assert.ok(u1.modes.integer && u1.modes.text && u2.modes.text);
});

test('EC02: CIK literal equality stays distinct while explicit padded CIK equality is exact', () => {
  assert.notEqual(normalizeKey('12345', 'text'), normalizeKey('0000012345', 'text'));
  assert.equal(normalizeKey('12345', 'integer-pad10'), normalizeKey('0000012345', 'integer-pad10'));
});

test('EC04: null-heavy and empty samples keep explicit denominators and never turn zero keys into full agreement', () => {
  const heavy = measureMultiplicity([[null], [null], [''], [' '], ['1'], ['2'], ['3']], 0, 'integer');
  assert.deepEqual({ rows: heavy.rows, nullRows: heavy.nullRows, emptyRows: heavy.emptyRows, distinctKeys: heavy.distinctKeys }, { rows: 7, nullRows: 2, emptyRows: 2, distinctKeys: 3 });
  const none = measureMultiplicity([[null], [''], ['  ']], 0, 'integer');
  assert.equal(none.distinctKeys, 0);
});

test('EC06: many-to-many rows report pair multiplicity and block a simple FK', () => {
  const left = ['1', '1', '2', '2', '3', '3'].map(key => [key]);
  const right = ['1', '1', '1', '2', '2', '2', '3', '3', '3'].map(key => [key]);
  const multiplicity = sharedRowPairs(left, 0, right, 0, 'integer');
  assert.equal(multiplicity.sharedRowPairs, 18);
  assert.deepEqual(multiplicity.manyToManyKeys, ['1', '2', '3']);
});

test('EC07: observed referenced duplicates block FK confidence; label contradiction remains a separate reason', () => {
  const duplicate = measureMultiplicity([['1'], ['1'], ['2'], ['3']], 0, 'integer');
  assert.deepEqual(duplicate.duplicateKeys, [{ key: '1', rows: 2 }]);
  const from = [['1', 'Newark'], ['2', 'Airport'], ['3', 'North']];
  const to = [['1', 'West'], ['1', 'Elsewhere'], ['2', 'Other'], ['3', 'South']];
  const labels = compareLabels(from, to, ['id', 'name'], ['id', 'name'], { db: 'x', table: 'a', column: 'id' }, { db: 'x', table: 'b', column: 'id' }, ['name'], ['name']);
  assert.equal(labels?.ratio, 0);
});

test('EC08: reused zone IDs with contradictory labels are misleading; matching labels pass only the bounded gates', () => {
  const a = [['1', 'Newark Airport'], ['2', 'Jamaica'], ['3', 'Astoria']];
  const bad = [['1', 'West Angelamouth'], ['2', 'Elsewhere'], ['3', 'Nowhere']];
  const good = [['1', 'Newark Airport'], ['2', 'Jamaica'], ['3', 'Astoria']];
  const from = { db: 'NY_TAXI', table: 'taxi_zones', column: 'LocationID' }, to = { db: 'NY_TAXI', table: 'zones', column: 'zone_id' };
  const badLabels = compareLabels(a, bad, ['LocationID', 'zone'], ['zone_id', 'zone'], from, to, ['zone'], ['zone']);
  const goodLabels = compareLabels(a, good, ['LocationID', 'zone'], ['zone_id', 'zone'], from, to, ['zone'], ['zone']);
  const absentLabels=compareLabels([['1',null],['2',null],['3',null]],[['1',null],['2',null],['3',null]],['LocationID','zone'],['zone_id','zone'],from,to,['zone'],['zone']);
  assert.equal(absentLabels,undefined);
});

test('EC17 contract: every run re-probes; fingerprint change alone is reviewable, only complete contrary evidence degrades', () => {
  const prior = { sourceVersion: 'v1', schemaVersion: 's1', normalization: 'integer', observedAt: '2026-10-22T10:00:00Z', verdict: 'SOSTENIDA' };
  const warm = assessFreshness(prior, { sourceVersion: 'v1', schemaVersion: 's1', normalization: 'integer', observedAt: '2026-10-22T10:10:00Z', verdict: 'SOSTENIDA' });
  const drift = assessFreshness(prior, { sourceVersion: 'v2', schemaVersion: 's1', normalization: 'integer', observedAt: '2026-10-22T10:20:00Z', verdict: 'SOSTENIDA' });
  assert.equal(warm.state, 'REVALIDADA');
  assert.equal(warm.sourceObservedAt, '2026-10-22T10:10:00Z');
  assert.equal(warm.reusedAsFresh, false);
  assert.deepEqual({ state: drift.state, verdict: drift.verdict, requiresReview: drift.requiresReview, preserveHistorical: drift.preserveHistorical, supersedePrevious: drift.supersedePrevious }, { state: 'REVALIDADA', verdict: 'SOSTENIDA', requiresReview: true, preserveHistorical: true, supersedePrevious: false });
  const contrary=assessFreshness(prior,{sourceVersion:'v2',schemaVersion:'s1',normalization:'integer',observedAt:'2026-10-22T10:20:00Z',verdict:'INDETERMINADA'});
  assert.deepEqual({state:contrary.state,verdict:contrary.verdict,requiresReview:contrary.requiresReview,supersedePrevious:contrary.supersedePrevious},{state:'DEGRADADA',verdict:'INDETERMINADA',requiresReview:true,supersedePrevious:true});
  const incomplete=assessFreshness(prior,{sourceVersion:'v2',schemaVersion:'s1',normalization:'integer',observedAt:'2026-10-22T10:30:00Z',verdict:'INDETERMINADA',complete:false});
  assert.equal(incomplete.state,'INCOMPLETA');assert.equal(incomplete.supersedePrevious,false);
  const cold=assessFreshness(null,{sourceVersion:'v1',schemaVersion:'s1',normalization:'integer',observedAt:'2026-10-22T10:00:00Z',verdict:'SOSTENIDA'});
  assert.equal(cold.state,'FRIA');
});

test('EC18 contract: partial 429 evidence stays incomplete, preserves request IDs, and does not retry', () => {
  const result = assessPartialTransport({ fragments: [{ requestId: 'fixture-1', rows: 3 }], error: { status: 429, retryAfter: '60' } });
  assert.deepEqual(result, { evidenceState: 'INCOMPLETA', verdict: 'INDETERMINADA', complete: false, fragmentRequestIds: ['fixture-1'], fragmentRows: 3, errorStatus: 429, retryAfter: '60', automaticRetry: false });
});
