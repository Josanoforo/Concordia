import test from 'node:test';
import assert from 'node:assert/strict';
import { checkKeyContract, validateKeyContractDeclaration } from '../src/relations/key-contract.ts';

const obs = (over: Partial<{ rows: number; nullRows: number; emptyRows: number; duplicateKeys: unknown[] }> = {}) => ({ rows: 10, nullRows: 0, emptyRows: 0, duplicateKeys: [], ...over });

test('E-16: a clean sample satisfies the contract only "in sample"; with no declaration nothing is checked', () => {
  const r = checkKeyContract('id', { unique: true, nullable: false, maxNullRate: 0 }, obs());
  assert.equal(r.status, 'SATISFIED_IN_SAMPLE');
  assert.deepEqual(r.checks.map(check => check.rule), ['unique', 'nullable', 'maxNullRate']);
  assert.equal(checkKeyContract('id', undefined, obs()).status, 'NO_CONTRACT');
  assert.equal(checkKeyContract('id', {}, obs()).status, 'NO_CONTRACT');
});

test('E-16: observed duplicates or nulls violate the declared contract', () => {
  assert.equal(checkKeyContract('id', { unique: true }, obs({ duplicateKeys: [{ key: '1', rows: 2 }] })).status, 'VIOLATED');
  const nulls = checkKeyContract('id', { nullable: false }, obs({ nullRows: 1, emptyRows: 1 }));
  assert.deepEqual({ status: nulls.status, observed: nulls.checks[0].observed }, { status: 'VIOLATED', observed: 2 });
  assert.equal(checkKeyContract('id', { maxNullRate: 0.1 }, obs({ nullRows: 2 })).status, 'VIOLATED');
  assert.equal(checkKeyContract('id', { maxNullRate: 0.2 }, obs({ nullRows: 2 })).status, 'SATISFIED_IN_SAMPLE');
});

test('E-16: an empty sample is UNKNOWN, and a permissive declaration is never "satisfied"', () => {
  assert.equal(checkKeyContract('id', { unique: true, maxNullRate: 0.5 }, obs({ rows: 0 })).status, 'UNKNOWN');
  assert.equal(checkKeyContract('id', { nullable: true }, obs()).status, 'UNKNOWN');
});

test('E-16: declarations are validated and unknown fields rejected', () => {
  assert.deepEqual(validateKeyContractDeclaration(undefined), []);
  assert.deepEqual(validateKeyContractDeclaration({ id: { unique: true, nullable: false, maxNullRate: 0 } }), []);
  const codes = (value: unknown) => validateKeyContractDeclaration(value).map(issue => issue.code);
  assert.deepEqual(codes([]), ['EXPECTED_KEY_CONTRACT_OBJECT']);
  assert.deepEqual(codes({ id: { unique: 'yes' } }), ['KEY_CONTRACT_UNIQUE_NOT_BOOLEAN']);
  assert.deepEqual(codes({ id: { maxNullRate: 2 } }), ['KEY_CONTRACT_MAX_NULL_RATE_OUT_OF_RANGE']);
  assert.deepEqual(codes({ id: { primary: true } }), ['UNKNOWN_KEY_CONTRACT_FIELD']);
  assert.deepEqual(codes({ id: { nullable: false, maxNullRate: 0.1 } }), ['KEY_CONTRACT_NULLABLE_CONTRADICTS_MAX_NULL_RATE']);
});
