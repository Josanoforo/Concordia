import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSingleJoinComparisonOwner, OWN_JOIN_COMPARISON_UNIVERSES } from '../src/agent/engine.ts';
import { catalogOf } from '../src/agent/catalog.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** N30: U2 owns its join comparison; a catalog that also declares joinAlternatives for it fails closed. */
const spec = [{ choice: 'X', family: 'f', source: { table: 'a', columns: ['c'] }, target: { table: 'b', columns: ['c'] }, normalization: ['literal'], fromLabel: 'a.c', toLabel: 'b.c' }] as any;

test('N30: U2 is the declared owner; its real catalog declares no joinAlternatives, so nothing changes today', () => {
  assert.ok(OWN_JOIN_COMPARISON_UNIVERSES.has('U2'));
  assert.equal(catalogOf(universeConfig('U2'))?.joinAlternatives, undefined);
  assert.doesNotThrow(() => assertSingleJoinComparisonOwner('U2', catalogOf(universeConfig('U2'))));
});

test('N30: a U2 catalog that also declares joinAlternatives is refused; other universes may declare them', () => {
  assert.throws(() => assertSingleJoinComparisonOwner('U2', { joinAlternatives: spec }), /JOIN_COMPARISON_OWNER_AMBIGUOUS/);
  assert.doesNotThrow(() => assertSingleJoinComparisonOwner('TPCDS', { joinAlternatives: spec }));
  assert.doesNotThrow(() => assertSingleJoinComparisonOwner('U2', { joinAlternatives: [] }));
});
