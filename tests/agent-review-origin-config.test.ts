import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, stampConfiguredReviewOrigin } from '../src/agent/engine.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig, withReviewedRelations } from '../src/universe-pipeline.ts';

/** A relation declared with reviewOrigin MODEL_REVIEWED keeps that origin in its verdict and its memory claim (the probe contract drops unknown fields), so it is never read as human. */
const base = universeConfig('AGENTFX');
const made: string[] = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const relationsWith = (extra: Record<string, Record<string, unknown>>) => base.relations.map((relation: any) => ({ ...structuredClone(relation), ...(extra[relation.id] ?? {}) }));
const run = (runId: string, relations: any[], dir: string) => withReviewedRelations('AGENTFX', relations, () => runAgent('AGENTFX', runId, {
  client: fixtureClient(base, structuredClone(agentFixtures().find(i => i.alias === 'AGENTFX')!).tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, memory: { dir } }) as Promise<any>);
const scratch = () => { const dir = path.join(fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')), 'LOCAL-SYNTHETIC'); made.push(path.dirname(dir)); return dir; };

test('a configured MODEL_REVIEWED relation: verdict, memory claim and ledger carry MODEL_REVIEWED; the others stay human', async () => {
  const report = await run('agent-origin-cfg-1', relationsWith({ orders_customer: { reviewOrigin: 'MODEL_REVIEWED' } }), scratch());
  const origins = Object.fromEntries(report.decisions.map((d: any) => [d.relationId, d.reviewOrigin]));
  assert.equal(origins.orders_customer, 'MODEL_REVIEWED');
  assert.equal(origins.orders_region, 'HUMAN_REVIEWED');
  const claim = report.memory.claims.find((c: any) => c.relationId === 'orders_customer' && c.value === 'SOSTENIDA');
  assert.equal(claim.reviewOrigin, 'MODEL_REVIEWED');
});

test('a model-reviewed memory claim is not reused where the relation now requires a human', async () => {
  const dir = scratch();
  await run('agent-origin-cfg-2', relationsWith({ orders_customer: { reviewOrigin: 'MODEL_REVIEWED' } }), dir);
  const second = await run('agent-origin-cfg-3', relationsWith({ orders_customer: { reviewOrigin: 'HUMAN_REVIEWED', reviewMode: 'HUMAN' } }), dir);
  assert.ok(second.memory.reuse.reprobe.some((item: any) => item.relationId === 'orders_customer' && item.reason === 'REVIEW_ORIGIN_MISMATCH'), JSON.stringify(second.memory.reuse.reprobe));
  const open = await run('agent-origin-cfg-4', relationsWith({ orders_customer: { reviewOrigin: 'MODEL_REVIEWED', reviewMode: 'MODEL_ADVERSARIAL' } }), scratch());
  assert.equal(open.decisions.find((d: any) => d.relationId === 'orders_customer').reviewOrigin, 'MODEL_REVIEWED');
});

test('stampConfiguredReviewOrigin: only declared relations are stamped; an unknown origin fails closed', () => {
  const results: any[] = [{ relationId: 'a' }, { relationId: 'b' }];
  stampConfiguredReviewOrigin(results, [{ id: 'a', reviewOrigin: 'MODEL_REVIEWED' }, { id: 'b' }]);
  assert.deepEqual(results.map(r => r.reviewOrigin), ['MODEL_REVIEWED', undefined]);
  assert.throws(() => stampConfiguredReviewOrigin([{ relationId: 'a' }], [{ id: 'a', reviewOrigin: 'ROBOT' }]), /REVIEW_ORIGIN_INVALID/);
});
