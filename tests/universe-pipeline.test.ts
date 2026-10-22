import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKey, sourceQuery } from '../src/universe-pipeline.ts';
import { readJson } from '../src/runtime.ts';
test('CIK text remains distinct while explicit integer normalization removes padding without precision loss',()=>{
  const contract=readJson<any>('universes/U2_companies.json').normalizationContract;
  assert.notEqual(normalizeKey('0000012345','text',contract),normalizeKey(12345,'text',contract));
  assert.equal(normalizeKey('0000012345','integer-pad10',contract),normalizeKey(12345,'integer-pad10',contract));
  assert.equal(normalizeKey('9007199254740993123','integer',contract),'9007199254740993123');
  assert.notEqual(normalizeKey('  ACME','text',contract),normalizeKey('ACME','text',contract));
  assert.throws(()=>normalizeKey('1','integer',{}));
  assert.throws(()=>sourceQuery({baseSql:'SELECT * FROM private'}));
});
