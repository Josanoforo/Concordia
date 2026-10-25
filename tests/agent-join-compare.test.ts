import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareDeclaredAlternatives, type JoinAlternativeSpec } from '../src/agent/join-compare.ts';
import { validateJoinAlternatives } from '../src/agent/catalog.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { compareU2Alternatives, U2_JOIN_ALTERNATIVES } from '../src/agent/u2.ts';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/u2/agent-u2-adaptive-20261024-normal-03.alternatives.json', import.meta.url), 'utf8'));

test('R-02 regression: the generic comparator reproduces the historic U2 ficha (run agent-u2-adaptive-20261024-normal-03) field by field', () => {
  const cfg = universeConfig('U2');
  const alternatives = compareU2Alternatives(cfg, fixture.discovery, fixture.secRead, fixture.dnsRead);
  assert.deepEqual(alternatives, fixture.alternatives);
  assert.equal(JSON.stringify(alternatives), JSON.stringify(fixture.alternatives), 'same key order, so any hash over the ficha is unchanged');
  assert.deepEqual(alternatives.map(item => item.choice), ['CIK_TEXT', 'CIK_NORMALIZED', 'SIC_CODE', 'SIC_DESCRIPTION', 'SIC_CODE_AND_DESCRIPTION', 'NO_JOIN']);
});

test('R-02: U2 falls back to the discovery sample when a bounded read has no rows, as before', () => {
  const cfg = universeConfig('U2');
  const empty = { ...fixture.secRead, rows: [] };
  const alternatives = compareU2Alternatives(cfg, fixture.discovery, empty, undefined);
  assert.equal(alternatives.find(item => item.choice === 'SIC_CODE')!.sourceEvidenceRefs[0], fixture.discovery.tables.apple_submissions_raw.sample.queryId);
});

test('R-02: U2 declared alternatives are valid under the generic validator against the U2 config', () => {
  assert.deepEqual(validateJoinAlternatives(U2_JOIN_ALTERNATIVES, universeConfig('U2').tables, 'U2', universeConfig('U2').explorationCatalog.safeOptionalColumns), []);
});

const cfg = { normalizationContract: { modes: { text: {}, integer: {}, 'integer-pad10': {} } } };
const data: Record<string, { rows: unknown[][]; columns: string[]; evidenceRefs: string[] }> = {
  trips: { columns: ['trip_id', 'route_id'], rows: [['t1', '7'], ['t2', '8'], ['t3', '7']], evidenceRefs: ['q-trips'] },
  routes: { columns: ['route_id', 'agency'], rows: [['0007', 'A'], ['9', 'B']], evidenceRefs: ['q-routes'] }
};
const specs: JoinAlternativeSpec[] = [
  { choice: 'ROUTE_TEXT', family: 'route', source: { table: 'trips', columns: ['route_id'] }, target: { table: 'routes', columns: ['route_id'] }, normalization: ['text'] },
  { choice: 'ROUTE_NORMALIZED', family: 'route', source: { table: 'trips', columns: ['route_id'] }, target: { table: 'routes', columns: ['route_id'] }, normalization: ['integer-pad10'] },
  { choice: 'ROUTE_AND_AGENCY', source: { table: 'trips', columns: ['route_id', 'trip_id'] }, target: { table: 'routes', columns: ['route_id', 'agency'] }, normalization: ['integer', 'literal'] }
];

test('R-02: any universe with declared alternatives gets measured matches, ambiguity, nulls and a closing NO_JOIN', () => {
  const result = compareDeclaredAlternatives(cfg, specs, table => data[table]!);
  assert.deepEqual(result.map(item => [item.choice, item.matchPairs]), [['ROUTE_TEXT', 0], ['ROUTE_NORMALIZED', 2], ['ROUTE_AND_AGENCY', 0], ['NO_JOIN', null]]);
  const normalized = result[1]!;
  assert.equal(normalized.from, 'trips.route_id');
  assert.equal(normalized.matchedSourceRows, 2);
  assert.equal(normalized.unmatchedSourceRows, 1);
  assert.equal(normalized.sourceEvidenceRefs[0], 'q-trips');
  assert.equal(result[2]!.from, 'trips.(route_id,trip_id)');
  assert.equal(result[2]!.normalization, 'integer+literal');
  assert.deepEqual([result[3]!.nSource, result[3]!.nTarget], [3, 2]);
  assert.deepEqual(compareDeclaredAlternatives(cfg, [], table => data[table]!), []);
});

test('R-02: a column the sample does not project is NOT_PROJECTED, never a guess', () => {
  const narrow: typeof data = { ...data, routes: { columns: ['agency'], rows: [['A']], evidenceRefs: ['q'] } };
  const [text] = compareDeclaredAlternatives(cfg, specs, table => narrow[table]!);
  assert.equal(text!.fieldAvailability, 'NOT_PROJECTED');
  assert.equal(text!.matchPairs, null);
});

test('R-02: the validator rejects sensitive columns, unknown tables, duplicate choices and bad normalizations', () => {
  const tables = { trips: { columns: [{ name: 'route_id' }, { name: 'email' }] }, routes: { columns: [{ name: 'route_id' }] } };
  const ok = { choice: 'A', source: { table: 'trips', columns: ['route_id'] }, target: { table: 'routes', columns: ['route_id'] }, normalization: ['text'] };
  const code = (specs: unknown) => validateJoinAlternatives(specs, tables, 'p').map(issue => issue.code);
  assert.deepEqual(code([ok]), []);
  assert.deepEqual(code(undefined), []);
  assert.deepEqual(code([]), ['INVALID_JOIN_ALTERNATIVES']);
  assert.deepEqual(code([ok, ok]), ['INVALID_OR_DUPLICATE_JOIN_CHOICE']);
  assert.deepEqual(code([{ ...ok, choice: 'NO_JOIN' }]), ['INVALID_OR_DUPLICATE_JOIN_CHOICE']);
  assert.deepEqual(code([{ ...ok, source: { table: 'trips', columns: ['email'] } }]), ['INVALID_JOIN_SIDE']);
  assert.deepEqual(code([{ ...ok, source: { table: 'nope', columns: ['route_id'] } }]), ['INVALID_JOIN_SIDE']);
  assert.deepEqual(code([{ ...ok, target: { table: 'routes', columns: ['other'] } }]), ['JOIN_OUTSIDE_ALLOWLIST']);
  assert.deepEqual(code([{ ...ok, normalization: ['literal'] }]), ['INVALID_JOIN_NORMALIZATION']);
  assert.deepEqual(code([{ ...ok, normalization: ['text', 'text'] }]), ['INVALID_JOIN_NORMALIZATION']);
});
