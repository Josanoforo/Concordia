import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { AGENT_MEMORY_ACTOR, planWarmStart, recordRunMemory, relationVersion } from '../src/agent/memory.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { buildReconcileSnapshot, reconcileSnapshotPath } from '../src/reconcile/persistence.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/**
 * M8-1: second adversarial poisoning suite, after the sealed origin (G0-5), the write gate (G0-6) and the consumer TTL. Every attack must end in a
 * rejection (write refused, scope refused, or the relation re-probed). The result is reported as n/n; the attacks that are NOT rejected are pinned
 * separately (stated limits, and one open gap), outside the denominator.
 */
const made: string[] = [];
const scratch = (name = 'LOCAL-SYNTHETIC') => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, name); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

const cfg = universeConfig('AGENTFX'), relation = cfg.relations.find((item: any) => item.id === 'orders_customer');
const NOW = Date.parse('2026-10-26T00:00:00Z');
const LOCAL = { executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' }, LIVE = { executionMode: 'LIVE', dataOrigin: 'PUBLIC' }, REPLAY = { executionMode: 'REPLAY', dataOrigin: 'PUBLIC' };
let discovery: any, V = '';
test.before(async () => {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const report: any = await runAgent('AGENTFX', 'agent-poison-m8', { client: fixtureClient(cfg, fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  discovery = report.artifacts.discovery; V = relationVersion(discovery, relation);
});
const claim = (over: Record<string, unknown> = {}) => ({ entity: 'relation:orders_customer', attribute: 'status', value: 'SOSTENIDA', source: 'poison.src', confidence: 0.99, requestIds: ['req-1'], reviewState: 'REVIEWED', sourceVersion: V,
  observedAt: '2026-10-25T00:00:00Z', rule: 'bounded_key_overlap', runId: 'run-x', ...over });
const strict = (dir: string, origin = LOCAL) => new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR, { strictSustained: true, origin });
const plan = (dir: string, origin = LOCAL) => planWarmStart({ universeId: 'AGENTFX', discovery, relations: [relation], dir, origin, now: () => NOW });
const outcome = (fn: () => { reprobe: { reason: string }[] } | string) => { try { const result = fn(); return typeof result === 'string' ? result : result.reprobe[0]?.reason ?? 'REUSED'; } catch (error) { return (error as { code?: string }).code ?? String(error); } };
/** A strict-write attempt followed by a warm start: the write may be refused, otherwise the plan decides. */
const writeThenPlan = (over: Record<string, unknown>) => outcome(() => { const dir = scratch(); strict(dir).addClaim(claim(over)); return plan(dir); });
/** Edits the persisted snapshot, optionally recomputing the checksum like an attacker who can write the file. */
const tamper = (dir: string, edit: (body: any) => void, recompute: boolean) => {
  const file = reconcileSnapshotPath(dir), { checksum, ...body } = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(body); fs.writeFileSync(file, JSON.stringify(recompute ? buildReconcileSnapshot(body) : { ...body, checksum }));
};
const indeterminada = () => { const dir = scratch(); strict(dir).addClaim(claim({ value: 'INDETERMINADA', source: 'ind.src' })); return dir; };
const flipToSostenida = (body: any, review?: string) => {
  const target = body.claims.find((item: any) => item.value === 'INDETERMINADA'); target.value = 'SOSTENIDA';
  const record = body.memoryState.records.find((item: any) => item.id === target.id); record.content = `${target.entity}.${target.attribute} = SOSTENIDA`;
  if (review === undefined) delete target.reviewState; else target.reviewState = review;
};

const ATTACKS: { name: string; expected: string; run: () => string }[] = [
  { name: 'forged evidence: SOSTENIDA with an empty receipt list', expected: 'SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW', run: () => writeThenPlan({ requestIds: [] }) },
  { name: 'receipt without run id', expected: 'SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW', run: () => writeThenPlan({ runId: undefined }) },
  { name: 'SOSTENIDA with reviewState PENDING', expected: 'SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW', run: () => writeThenPlan({ reviewState: 'PENDING' }) },
  { name: 'SOSTENIDA with no reviewState', expected: 'SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW', run: () => writeThenPlan({ reviewState: undefined }) },
  { name: 'mixed origin: lookup as REPLAY inside a scope sealed LIVE-PUBLIC', expected: 'STATE_SCOPE_MISMATCH', run: () => outcome(() => {
    const dir = scratch('LIVE-PUBLIC'); strict(dir, LIVE).addClaim(claim()); plan(dir, LIVE); return plan(dir, REPLAY); }) },
  { name: 'mixed origin: write as REPLAY into a scope sealed LIVE-PUBLIC', expected: 'STATE_SCOPE_MISMATCH', run: () => {
    const dir = scratch('LIVE-PUBLIC'); strict(dir, LIVE).addClaim(claim()); plan(dir, LIVE);
    const result: any = recordRunMemory({ universeId: 'AGENTFX', runId: 'run-y', discovery, probes: [], warmStart: { schemaVersion: 1, mode: 'WARM', reused: [{ relationId: 'orders_customer', claimId: 'x', version: V, reusedFromRunId: null, queriesSaved: 1 }], reprobe: [], queriesSaved: 1 }, dir, origin: REPLAY });
    return result.error?.code ?? result.status; } },
  { name: 'mixed origin: a claim stamped REPLAY-PUBLIC planted in the LIVE-PUBLIC scope', expected: 'UNTRUSTED_PROVENANCE', run: () => outcome(() => {
    const dir = scratch('LIVE-PUBLIC'); strict(dir, LIVE).addClaim(claim({ value: 'INDETERMINADA', source: 'seed.src' })); plan(dir, LIVE);
    new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR).addClaim(claim({ ...REPLAY })); return plan(dir, LIVE); }) },
  { name: 'edited snapshot, checksum NOT recomputed', expected: 'RECONCILE_SNAPSHOT_INVALID', run: () => outcome(() => { const dir = indeterminada(); tamper(dir, body => flipToSostenida(body, 'REVIEWED'), false); return plan(dir); }) },
  { name: 'edited snapshot, checksum recomputed, claim value changed but memory record left alone', expected: 'RECONCILE_SNAPSHOT_INVALID', run: () => outcome(() => {
    const dir = indeterminada(); tamper(dir, body => { body.claims.find((item: any) => item.value === 'INDETERMINADA').value = 'SOSTENIDA'; }, true); return plan(dir); }) },
  { name: 'edited snapshot, checksum recomputed, flipped to SOSTENIDA and stamped PENDING', expected: 'SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW', run: () => outcome(() => { const dir = indeterminada(); tamper(dir, body => flipToSostenida(body, 'PENDING'), true); return plan(dir); }) },
  { name: 'edited snapshot, checksum recomputed, flipped to SOSTENIDA with the review stamp stripped', expected: 'UNTRUSTED_PROVENANCE', run: () => outcome(() => { const dir = indeterminada(); tamper(dir, body => flipToSostenida(body), true); return plan(dir); }) },
  { name: 'placeholder source version "unspecified"', expected: 'UNTRUSTED_PROVENANCE', run: () => writeThenPlan({ sourceVersion: 'unspecified' }) },
  { name: 'placeholder source version "unversioned"', expected: 'UNTRUSTED_PROVENANCE', run: () => writeThenPlan({ sourceVersion: 'unversioned' }) },
  { name: 'placeholder source version "" (empty)', expected: 'UNTRUSTED_PROVENANCE', run: () => writeThenPlan({ sourceVersion: '' }) },
];

test(`M8-1: ${ATTACKS.length} poisoning attacks, each rejected for its own reason (rejection rate n/n)`, () => {
  const outcomes = ATTACKS.map(attack => attack.run());
  const rejected = outcomes.filter((value, index) => value === ATTACKS[index]!.expected && value !== 'REUSED').length;
  const detail = outcomes.map((value, index) => `${ATTACKS[index]!.name}: ${value}`).join('\n');
  assert.equal(rejected, ATTACKS.length, `rejected ${rejected}/${ATTACKS.length}\n${detail}`);
});

test('M8-1 controls and stated limits: a genuine claim is REUSED (1/1); a fully forged claim and a fully forged snapshot are NOT detected (0/2 rejected)', () => {
  const dir = scratch(); strict(dir).addClaim(claim());
  assert.equal(outcome(() => plan(dir)), 'REUSED', 'the harness distinguishes reuse from rejection');
  // Limit 1: a writer that holds the scope and supplies a run id, receipts and REVIEWED is trusted: the receipts are not checked against any source.
  assert.equal(writeThenPlan({ source: 'forged.src', runId: 'run-forged', requestIds: ['req-fake'] }), 'REUSED');
  // Limit 2: whoever can rewrite the snapshot AND recompute its unkeyed checksum, with every field consistent, produces a state the loader accepts.
  // The flipped claim keeps the run id and receipts of the genuine claim it was, so flipping the value and stamping REVIEWED is enough.
  const edited = indeterminada(); tamper(edited, body => flipToSostenida(body, 'REVIEWED'), true);
  assert.equal(outcome(() => plan(edited)), 'REUSED');
});

test('M8-1 closed: re-sustaining the identical SOSTENIDA over an invalidated claim is refused with REVIVAL_WITHOUT_NEW_EVIDENCE and the invalidation holds', () => {
  const dir = scratch(), r = strict(dir), first = r.addClaim(claim());
  r.invalidate(first.id, 'upstream correction');
  assert.equal(outcome(() => plan(dir)), 'INVALIDATED', 'before the replay the invalidation holds');
  assert.throws(() => r.addClaim(claim()), /REVIVAL_WITHOUT_NEW_EVIDENCE/, 'same source, run id, receipts and observation time as the invalidated evidence');
  assert.throws(() => r.addClaim(claim({ runId: 'run-relabelled' })), /REVIVAL_WITHOUT_NEW_EVIDENCE/, 'a new run label over the old receipts is not new evidence');
  assert.throws(() => r.addClaim(claim({ requestIds: ['req-new'] })), /REVIVAL_WITHOUT_NEW_EVIDENCE/, 'new receipts under the old run id are not new evidence');
  assert.equal(outcome(() => plan(dir)), 'INVALIDATED', 'after the refused replays the claim is still invalidated and not reusable');
});

test('M8-1 closed: a genuinely new observation (new run id and a receipt never seen) may re-sustain the value as a new claim, and the invalidated one stays closed', () => {
  const dir = scratch(), r = strict(dir), first = r.addClaim(claim());
  r.invalidate(first.id, 'upstream correction');
  const revived = r.addClaim(claim({ runId: 'run-fresh', requestIds: ['req-fresh'], observedAt: '2026-10-25T06:00:00Z' }));
  assert.notEqual(revived.id, first.id);
  assert.notEqual(new Reconciler('AGENTFX', dir).claims.find(item => item.id === first.id)!.invalidatedAt, undefined, 'the invalidated claim stays invalidated');
});
