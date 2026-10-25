import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relationPolicyFromConfig } from '../src/relations/policy.ts';
import { expectedDecisionMatches, selectExpectedDecision } from '../src/eval/expected-decisions.ts';

test('relation policy resolver maps config aliases and rejects discordant aliases', () => {
  assert.deepEqual(relationPolicyFromConfig({ relationPolicyVersion: '1.1', minDistinctKeys: 3, sustainedOverlap: 0.8 }), {
    policyVersion: '1.1', minimumDistinctKeys: 3, minimumOverlapRatio: 0.8
  });
  assert.deepEqual(relationPolicyFromConfig({ policyVersion: '2.0', minimumDistinctKeys: 2 }), {
    policyVersion: '2.0', minimumDistinctKeys: 2
  });
  assert.throws(() => relationPolicyFromConfig({ relationPolicyVersion: 'latest' }), /RELATION_POLICY_VERSION_REQUIRED/);
  assert.throws(() => relationPolicyFromConfig({ relationPolicyVersion: '1.0', minDistinctKeys: -1 }), /RELATION_POLICY_MINIMUM_DISTINCT_KEYS_INVALID/);
  assert.throws(() => relationPolicyFromConfig({ relationPolicyVersion: '1.0', policyVersion: '2.0' }), /RELATION_POLICY_CONFIG_ALIAS_CONFLICT/);
});

test('U2 policy-regression fixture preserves historical failure and selects 1.0, 2.0, or incomplete by evidence version', () => {
  const fixture = JSON.parse(readFileSync('eval/cases/U2.json', 'utf8'));
  assert.deepEqual(fixture.legacyRegressionBaseline, {
    status: 'FAIL', correct: 1, total: 3,
    runRef: '.concordia/level2-runs/L4-current-head-live-u2-retry-20261023T115252-b1104024/live-validation-summary.json',
    meaning: 'Historical result against the unversioned legacy expectations, preserved before versioned expectations. It is a regression comparison, not adjudicated truth or accuracy.'
  });
  const caseConfig = fixture.cases.find((item: any) => item.id === 'canonical_integer_cik');
  const legacy = selectExpectedDecision(caseConfig, '1.0');
  assert.equal(legacy.source, 'CONTRACT_VERSION');
  assert.deepEqual(legacy.expected, ['SOSTENIDA']);
  const current = selectExpectedDecision(caseConfig, '2.0');
  assert.deepEqual(current.expected, ['INDETERMINADA']);
  assert.deepEqual(expectedDecisionMatches(current, 'INDETERMINADA', ['identifier_space_or_namespace_unknown']), { pass: true, reasonCodesMet: true });
  assert.deepEqual(expectedDecisionMatches(current, 'INDETERMINADA', ['transport_incomplete']), { pass: false, reasonCodesMet: false });
  const unmapped = selectExpectedDecision(caseConfig, '3.0');
  assert.deepEqual(unmapped, { expected: [], contractVersion: '3.0', source: 'UNCONFIGURED_CONTRACT_VERSION', provenance: null });
  assert.deepEqual(expectedDecisionMatches(unmapped, 'INDETERMINADA', ['identifier_space_or_namespace_unknown']), { pass: false, reasonCodesMet: true });
});
