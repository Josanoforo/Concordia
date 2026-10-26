import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_USL_PLAN_LABEL, originateUslPlan, type UslRelationSelector } from '../src/agent/usl-plan.ts';
import { ROOT } from '../src/runtime.ts';

const relation: UslRelationSelector = { fromTable: 'gtfs_trips', fromColumns: ['route_id'], toTable: 'gtfs_routes', toColumns: ['route_id'] };
const target = { namespace: 'lightning.metastore.concordia_l4_agentpub_20261025', model: 'concordia_l4_agent_gtfs_route_v1' };
const snapshot = { fingerprint: 'd'.repeat(64), observedAt: '2026-10-25T12:00:00Z' };
// Minimal sealed envelope (publication input + source binding) of the Level 2 GTFS publication preparation, versioned so the test runs on any copy of the repo.
const envelope = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'usl', 'gtfs-trip-route-sealed-input.json'), 'utf8'));

// SQL hashes from USL_APPLY_DECISION_PACKAGE_20261025 section 4.
const PACKAGE_HASHES = { create_target_namespace: '1f75172cbc4457f9d3ba75c14c343ba1044b7030165d3128e9c2b680e99aea52', compile_versioned_model: '3167468cd0daef4f5353d08928d165b8a8270e0c9a3034a2671c4ed84898595e',
  activate_observed_relation: '9c076eef1639b00ff99750b809298d564a000656f541a55acab7884c54bfd6c4', load_model_for_definition_check: '9fea614cbe8d89893f927aaa17a7085f6814a89b8a3e2eeeeb4f78a065874205',
  verify_observed_relation_sample: '0bb7505275d55be9a1aa1f754b78fff057365af031d409da11ba7d560c7e8be6' };

test('B2: an abstention or another relation is never planned', () => {
  const input: any = { universeId: 'x', target: { namespace: 'lightning.metastore.concordia_l4_json2_20261023', model: 'concordia_l4_x_v1' },
    contract: { kind: 'FOREIGN_KEY', from: { objectId: 'DB.gtfs_trips', orderedColumns: ['route_id'] }, to: { objectId: 'DB.gtfs_routes', orderedColumns: ['route_id'] } }, decision: { verdict: 'INDETERMINADA', status: 'CURRENT' } };
  const out = originateUslPlan({ input, binding: {} as any, relation, target, snapshot });
  assert.equal(out.status, 'NOT_PUBLISHABLE');
  assert.ok(out.reasons.includes('verdict_indeterminada_is_not_publishable'));
  assert.equal(out.lifecyclePlan, undefined);
  assert.equal(out.applyExecuted, false);
  const other = originateUslPlan({ input: { ...input, decision: { verdict: 'SOSTENIDA', status: 'CURRENT' } }, binding: {} as any, relation: { ...relation, toTable: 'gtfs_stops' }, target });
  assert.deepEqual(other.reasons, ['candidate_relation_not_in_evidence']);
  const foreign = originateUslPlan({ input: { ...input, decision: { verdict: 'SOSTENIDA', status: 'CURRENT' } }, binding: {} as any, relation, target: { ...target, namespace: 'lightning.metastore.concordia_u1' } });
  assert.ok(foreign.reasons.includes('target_namespace_not_approved'));
});

test('B2: the GTFS trips.route_id -> routes.route_id candidate becomes a plan-only USL plan whose SQL hashes are exactly the ones in the decision package', () => {
  const out = originateUslPlan({ input: envelope.publicationInput, binding: envelope.sourceBinding, relation, target, snapshot });
  assert.equal(out.status, 'PLAN_PREPARED', JSON.stringify(out.reasons));
  assert.equal(out.lifecyclePlan!.executable, false);
  assert.equal(out.lifecyclePlan!.executionStatus, 'NOT_RUN');
  assert.equal(out.liveSqlExecuted, false);
  assert.equal(out.label, AGENT_USL_PLAN_LABEL);
  assert.equal(out.authorizationState, 'PENDING_HUMAN_EXACT_SCOPE_APPROVAL');
  const hashes = Object.fromEntries(out.lifecyclePlan!.operations.filter(item => item.sqlSha256).map(item => [item.operationId, item.sqlSha256]));
  assert.deepEqual(hashes, PACKAGE_HASHES);
  assert.equal(out.lifecyclePlan!.target.namespace, target.namespace);
  assert.equal(out.lifecyclePlan!.expectedProjection?.rowCount, 11);
  const unready = originateUslPlan({ input: envelope.publicationInput, binding: envelope.sourceBinding, relation, target });
  assert.equal(unready.lifecyclePlan!.inputFingerprints.targetState, null, 'without a fresh catalog snapshot the plan carries no target state, so the executor refuses it (TARGET_STATE_SNAPSHOT_REQUIRED)');
  assert.equal(out.lifecyclePlan!.inputFingerprints.targetState, snapshot.fingerprint);
});

test('B2: agent-usl-plan requires its arguments and is documented in --help', async () => {
  const { spawnSync } = await import('node:child_process');
  const { usageFor } = await import('../src/agent/cli-help.ts');
  assert.match(usageFor(['node', 'cli', 'agent-usl-plan'])!, /Plan-only/);
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tsx.mjs'), path.join(ROOT, 'src', 'cli.ts'), 'agent-usl-plan'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /AGENT_USL_PLAN_ARGUMENTS_REQUIRED/);
});

test('M8-5: the renderer accepts the agent-reviewed exact-text version text-exact-v1 like 1 and refuses any other version, with identical SQL', () => {
  const withVersion = (value: string) => {
    const input = structuredClone(envelope.publicationInput);
    input.contract.normalization = input.contract.normalization.map((component: any) => ({ ...component, version: { state: 'KNOWN', value } }));
    return originateUslPlan({ input, binding: envelope.sourceBinding, relation, target, snapshot });
  };
  const base = withVersion('1'), alias = withVersion('text-exact-v1'), other = withVersion('text-exact-v2');
  assert.equal(base.status, 'PLAN_PREPARED');
  assert.equal(alias.status, 'PLAN_PREPARED', JSON.stringify(alias.reasons));
  assert.deepEqual(alias.lifecyclePlan!.operations.map(item => item.sqlSha256), base.lifecyclePlan!.operations.map(item => item.sqlSha256));
  assert.equal(other.status, 'PLAN_BLOCKED');
  assert.ok(other.reasons.includes('exact_text_v1_contract_required'));
});
