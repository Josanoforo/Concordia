import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { AGENT_MEMORY_ACTOR, planWarmStart, relationVersion } from '../src/agent/memory.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/**
 * R6-M2: adversarial poisoning with an explicit denominator. Each attack writes a false or inconsistent claim through the Reconciler facade for relation
 * orders_customer and then asks the warm start whether the relation would be REUSED. The count is reported, never inferred.
 */
const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

const cfg = universeConfig('AGENTFX'), relation = cfg.relations.find((item: any) => item.id === 'orders_customer');
const NOW = Date.parse('2026-10-26T00:00:00Z');
let discovery: any, V = '';
test.before(async () => {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const report: any = await runAgent('AGENTFX', 'agent-poison-base', { client: fixtureClient(cfg, fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  discovery = report.artifacts.discovery; V = relationVersion(discovery, relation);
});
const plan = (dir: string, extra: object = {}) => planWarmStart({ universeId: 'AGENTFX', discovery, relations: [relation], dir, now: () => NOW, ...extra });
/** The reason a relation was re-probed, or the error code when the strict scope refuses to even load the poisoned state. */
const outcomeOf = (dir: string, extra: object = {}) => { try { return plan(dir, extra).reprobe[0]?.reason ?? 'REUSED'; } catch (error) { return (error as { code?: string }).code ?? 'THROWS'; } };
const claim = (over: Record<string, unknown> = {}) => ({ entity: 'relation:orders_customer', attribute: 'status', value: 'SOSTENIDA', source: 'poison.src', confidence: 0.99, requestIds: ['req-1'], reviewState: 'REVIEWED', sourceVersion: V,
  observedAt: '2026-10-25T00:00:00Z', rule: 'bounded_key_overlap', runId: 'run-x', ...over });
const seed = (write: (r: Reconciler) => void) => { const dir = scratch(); write(new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR)); return dir; };

const ATTACKS: { name: string; expected: string; run: () => Promise<string> | string }[] = [
  { name: 'stale source version', expected: 'VERSION_CHANGED', run: () => plan(seed(r => r.addClaim(claim({ sourceVersion: 'rv1:000000000000000000000000' })))).reprobe[0]?.reason ?? 'REUSED' },
  { name: 'contradiction: SOSTENIDA at an old version, INDETERMINADA at the current one', expected: 'VERSION_CHANGED', run: () => plan(seed(r => { r.addClaim(claim({ sourceVersion: 'rv1:old' })); r.addClaim(claim({ value: 'INDETERMINADA', source: 'other.src' })); })).reprobe[0]?.reason ?? 'REUSED' },
  { name: 'SOSTENIDA superseded by a later INDETERMINADA', expected: 'NOT_SUSTAINED', run: () => plan(seed(r => { const old = r.addClaim(claim()); const next = r.addClaim(claim({ value: 'INDETERMINADA', source: 'other.src' })); r.hmem.store.update(old.id, { supersededBy: next.id }); r.persist(); })).reprobe[0]?.reason ?? 'REUSED' },
  { name: 'no run-id provenance', expected: 'SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW', run: () => outcomeOf(seed(r => r.addClaim(claim({ runId: undefined })))) },
  { name: 'no request receipts', expected: 'SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW', run: () => outcomeOf(seed(r => r.addClaim(claim({ requestIds: [] })))) },
  { name: 'review state PENDING', expected: 'SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW', run: () => outcomeOf(seed(r => r.addClaim(claim({ reviewState: 'PENDING' })))) },
  { name: 'legacy claim with no review state at all', expected: 'UNTRUSTED_PROVENANCE', run: () => plan(seed(r => r.addClaim(claim({ reviewState: undefined })))).reprobe[0]?.reason ?? 'REUSED' },
  { name: 'claim stamped with another origin (LIVE-PUBLIC claim inside a LOCAL-SYNTHETIC scope)', expected: 'UNTRUSTED_PROVENANCE', run: () => plan(seed(r => r.addClaim(claim({ executionMode: 'LIVE', dataOrigin: 'PUBLIC' })))).reprobe[0]?.reason ?? 'REUSED' },
  { name: 'old observation with a TTL', expected: 'EXPIRED', run: () => plan(seed(r => r.addClaim(claim({ observedAt: '2026-01-01T00:00:00Z' }))), { ttlMs: 7 * 24 * 3600 * 1000 }).reprobe[0]?.reason ?? 'REUSED' },
  { name: 'unparseable observation time with a TTL', expected: 'EXPIRED', run: () => plan(seed(r => r.addClaim(claim({ observedAt: 'not-a-date' }))), { ttlMs: 1000 }).reprobe[0]?.reason ?? 'REUSED' },
  { name: 'claim about another relation', expected: 'NO_MEMORY', run: () => plan(seed(r => r.addClaim(claim({ entity: 'relation:orders_region' })))).reprobe[0]?.reason ?? 'REUSED' },
  { name: 'wrong attribute', expected: 'NO_MEMORY', run: () => plan(seed(r => r.addClaim(claim({ attribute: 'verdict' })))).reprobe[0]?.reason ?? 'REUSED' },
  { name: 'spoofed value (case / whitespace)', expected: 'NOT_SUSTAINED', run: () => plan(seed(r => { r.addClaim(claim({ value: 'sostenida' })); r.addClaim(claim({ value: 'SOSTENIDA ', source: 'b' })); })).reprobe[0]?.reason ?? 'REUSED' },
  { name: 'claim stored in another origin scope (SYNTHETIC claim, LIVE lookup)', expected: 'NO_MEMORY', run: () => { seed(r => r.addClaim(claim())); return plan(path.join(scratch(), 'LIVE-PUBLIC')).reprobe[0]?.reason ?? 'REUSED'; } },
  { name: 'scope of another universe', expected: 'THROWS', run: () => { const dir = scratch(); new Reconciler('U9', dir, AGENT_MEMORY_ACTOR).addClaim(claim()); try { return plan(dir).reprobe[0]?.reason ?? 'REUSED'; } catch { return 'THROWS'; } } },
];

test(`R6-M2: ${ATTACKS.length} poisoning attacks, 0 of ${ATTACKS.length} reach REUSED, each for its own reason`, async () => {
  const outcomes: string[] = [];
  for (const attack of ATTACKS) outcomes.push(await attack.run());
  const reused = outcomes.filter(outcome => outcome === 'REUSED').length;
  assert.equal(ATTACKS.length, 15);
  assert.deepEqual(outcomes, ATTACKS.map(attack => attack.expected), outcomes.map((o, i) => `${ATTACKS[i]!.name}: ${o}`).join('; '));
  assert.equal(reused, 0, `${reused} of ${ATTACKS.length} poisoned claims reached REUSED`);
});

test('R6-M2 control and stated residual: a genuine claim is REUSED (1 of 1), and a forgery that carries every field is NOT detectable by the warm start', () => {
  const genuine = plan(seed(r => r.addClaim(claim())));
  assert.deepEqual(genuine.reused.map(item => item.relationId), ['orders_customer'], 'the test can tell reuse from rejection');
  // Residual risk, measured and not hidden: whoever can write to the scope through the facade with the right version, run id and receipts is trusted.
  // The scope itself is protected by the writer lock, CAS snapshot, checksum and manifest, not by this check.
  const forged = plan(seed(r => r.addClaim(claim({ source: 'forged.src', runId: 'run-forged', requestIds: ['req-fake'] }))));
  assert.equal(forged.reused.length, 1);
});
