import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyRelationContract } from '../src/relations/legacy.ts';
import { validateRelationContract } from '../src/contracts/validate.ts';

/** R-seal at the contract: the review origin of a configured relation reaches its relation contract with the same rule as the memory seal. */
const relation = (extra: Record<string, unknown> = {}) => ({ id: 'r', from: { db: 'D', table: 'a', column: 'k' }, to: { db: 'D', table: 'b', column: 'k' }, kind: 'FOREIGN_KEY', identifierSpace: 'sp', normalizationVersion: 'v1', normalizationLossless: true, normalizationAdapterCapability: 'exact-text', ...extra }) as any;
const contract = (extra: Record<string, unknown>) => legacyRelationContract(relation(extra), 'U', '1.0', 'text', 1) as any;

test('contract reviewOrigin: MODEL_REVIEWED reaches the contract; REVIEWED with no origin is HUMAN_REVIEWED; without a REVIEWED state there is none', () => {
  assert.equal(contract({ reviewState: 'REVIEWED', reviewOrigin: 'MODEL_REVIEWED' }).reviewOrigin, 'MODEL_REVIEWED');
  assert.equal(contract({ reviewState: 'REVIEWED', reviewOrigin: 'HUMAN_REVIEWED' }).reviewOrigin, 'HUMAN_REVIEWED');
  assert.equal(contract({ reviewState: 'REVIEWED' }).reviewOrigin, 'HUMAN_REVIEWED');
  assert.equal('reviewOrigin' in contract({}), false);
  assert.equal('reviewOrigin' in contract({ reviewState: 'PENDING', reviewOrigin: 'MODEL_REVIEWED' }), false, 'an origin without a REVIEWED state is not an origin');
  assert.throws(() => contract({ reviewState: 'REVIEWED', reviewOrigin: 'ROBOT' }), /REVIEW_ORIGIN_INVALID/);
});

test('contract reviewOrigin: the contract still validates against the relation-contract schema', () => {
  const issues = validateRelationContract(contract({ reviewState: 'REVIEWED', reviewOrigin: 'MODEL_REVIEWED' }));
  assert.deepEqual(issues, []);
});
