import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUniverseManifest, validateUniverseConfig } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** N41: the registry validates a table's keyContract declaration and keeps it inside the table's column allowlist. */
const codes = (mutate: (cfg: any) => void, alias = 'U1') => { const cfg = structuredClone(universeConfig(alias)); mutate(cfg); return validateUniverseConfig(resolveUniverseManifest(alias)!, cfg).map(issue => issue.code); };

test('a well-formed keyContract on an allowlisted column is accepted, and its absence changes nothing', () => {
  assert.deepEqual(codes(() => {}), []);
  assert.deepEqual(codes(cfg => { cfg.tables.taxi_zones.keyContract = { LocationID: { unique: true, nullable: false } }; }), []);
  assert.deepEqual(codes(cfg => { cfg.tables.taxi_zones.keyContract = { LocationID: { maxNullRate: 0.05 }, zone: { nullable: true } }; }), []);
});

test('malformed declarations are rejected with the key-contract codes', () => {
  assert.ok(codes(cfg => { cfg.tables.taxi_zones.keyContract = 'unique'; }).includes('EXPECTED_KEY_CONTRACT_OBJECT'));
  assert.ok(codes(cfg => { cfg.tables.taxi_zones.keyContract = { LocationID: true }; }).includes('EXPECTED_KEY_COLUMN_CONTRACT'));
  assert.ok(codes(cfg => { cfg.tables.taxi_zones.keyContract = { LocationID: { primary: true } }; }).includes('UNKNOWN_KEY_CONTRACT_FIELD'));
  assert.ok(codes(cfg => { cfg.tables.taxi_zones.keyContract = { LocationID: { unique: 'yes' } }; }).includes('KEY_CONTRACT_UNIQUE_NOT_BOOLEAN'));
  assert.ok(codes(cfg => { cfg.tables.taxi_zones.keyContract = { LocationID: { nullable: 0 } }; }).includes('KEY_CONTRACT_NULLABLE_NOT_BOOLEAN'));
  assert.ok(codes(cfg => { cfg.tables.taxi_zones.keyContract = { LocationID: { maxNullRate: 2 } }; }).some(code => code.startsWith('KEY_CONTRACT_MAX_NULL_RATE')));
  assert.ok(codes(cfg => { cfg.tables.taxi_zones.keyContract = { LocationID: { nullable: false, maxNullRate: 0.1 } }; }).includes('KEY_CONTRACT_NULLABLE_CONTRADICTS_MAX_NULL_RATE'));
});

test('a keyContract cannot name a column outside the table allowlist', () => {
  assert.ok(codes(cfg => { cfg.tables.taxi_zones.keyContract = { not_a_column: { unique: true } }; }).includes('KEY_CONTRACT_COLUMN_OUTSIDE_ALLOWLIST'));
  assert.ok(codes(cfg => { cfg.tables.taxi_zones.keyContract = { PULocationID: { unique: true } }; }).includes('KEY_CONTRACT_COLUMN_OUTSIDE_ALLOWLIST'), 'a column of another table is outside this one');
});
