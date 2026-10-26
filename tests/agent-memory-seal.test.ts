import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { ORIGIN_SEAL_FILE, agentMemoryDir, inferOriginFromDirectory, planWarmStart, recordRunMemory, resolveMemoryScope, sealLegacyAgentMemory } from '../src/agent/memory.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** G0-5 / G0-6: origin is data (sealed per scope, stamped per claim) and a SOSTENIDA needs run id, receipt and a REVIEWED contract before memory accepts it. */
const made: string[] = [];
const scratchRoot = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-seal-')); made.push(dir); return dir; };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const LOCAL = { executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' }, LIVE = { executionMode: 'LIVE', dataOrigin: 'PUBLIC' };
async function offlineRun(runId: string) {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  return runAgent('AGENTFX', runId, { client: fixtureClient(universeConfig('AGENTFX'), fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, now: () => '2026-10-24T00:00:00Z' }) as Promise<any>;
}
const relationsOf = (discovery: any) => universeConfig('AGENTFX').relations.filter((relation: any) => discovery.tables[relation.from.table] && discovery.tables[relation.to.table]);
const claim = (over: Record<string, unknown> = {}) => ({ entity: 'relation:orders_customer', attribute: 'status', value: 'SOSTENIDA', source: 'seal.src', confidence: 0.9, requestIds: ['req-1'], sourceVersion: 'rv1:x', observedAt: '2026-10-25T00:00:00Z', rule: 'bounded_key_overlap', runId: 'run-x', reviewState: 'REVIEWED', ...over });

test('origin is required: a call that names neither an origin nor an origin-named directory is refused, and the directory comes from the origin', () => {
  const root = scratchRoot();
  assert.throws(() => resolveMemoryScope('AGENTFX', { dir: path.join(root, 'plain') }, false), /MEMORY_ORIGIN_REQUIRED/);
  assert.throws(() => resolveMemoryScope('AGENTFX', {}, false), /MEMORY_ORIGIN_REQUIRED/);
  assert.equal(resolveMemoryScope('AGENTFX', { origin: LIVE }, false).dir, agentMemoryDir('AGENTFX', LIVE));
  assert.deepEqual(inferOriginFromDirectory(path.join(root, 'LIVE-PUBLIC')), LIVE);
  assert.throws(() => resolveMemoryScope('AGENTFX', { dir: path.join(root, 'LIVE-PUBLIC'), origin: LOCAL }, false), /STATE_SCOPE_MISMATCH/, 'the directory name and the declared origin must agree');
  assert.throws(() => planWarmStart({ universeId: 'AGENTFX', discovery: { tables: {} }, relations: [], dir: path.join(root, 'plain') }), /MEMORY_ORIGIN_REQUIRED/);
  const skipped = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-seal-none', discovery: {}, probes: [{}], dir: path.join(root, 'plain') });
  assert.deepEqual([skipped.status, (skipped.error as any).code], ['ERROR', 'MEMORY_ORIGIN_REQUIRED']);
});

test('a scope is sealed at creation and a run of another origin is refused on both read and write with STATE_SCOPE_MISMATCH', async () => {
  const dir = path.join(scratchRoot(), 'shared'), report = await offlineRun('agent-seal-a');
  const first = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-seal-a', discovery: report.artifacts.discovery, probes: report.artifacts.probes, dir, origin: LOCAL });
  assert.equal(first.status, 'RECORDED'); assert.deepEqual(first.origin, LOCAL);
  const seal = JSON.parse(fs.readFileSync(path.join(dir, ORIGIN_SEAL_FILE), 'utf8'));
  assert.deepEqual([seal.executionMode, seal.dataOrigin, seal.sealedBy], ['LOCAL', 'SYNTHETIC', 'CREATED']);
  const relations = relationsOf(report.artifacts.discovery);
  assert.throws(() => planWarmStart({ universeId: 'AGENTFX', discovery: report.artifacts.discovery, relations, dir, origin: LIVE }), /STATE_SCOPE_MISMATCH/);
  const write = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-seal-b', discovery: report.artifacts.discovery, probes: report.artifacts.probes, dir, origin: LIVE });
  assert.deepEqual([write.status, (write.error as any).code], ['ERROR', 'STATE_SCOPE_MISMATCH']);
  assert.equal(planWarmStart({ universeId: 'AGENTFX', discovery: report.artifacts.discovery, relations, dir, origin: LOCAL }).mode, 'WARM', 'the sealed origin still reads and reuses');
});

test('every claim and observation written under a strict scope carries the sealed origin and the review state of its contract', async () => {
  const dir = path.join(scratchRoot(), 'LOCAL-SYNTHETIC'), report = await offlineRun('agent-seal-c');
  recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-seal-c', discovery: report.artifacts.discovery, probes: report.artifacts.probes, dir });
  const claims = new Reconciler('AGENTFX', dir).claims.filter(item => item.entity.startsWith('relation:') && item.value === 'SOSTENIDA');
  assert.ok(claims.length >= 1);
  for (const item of claims) {
    assert.deepEqual([item.executionMode, item.dataOrigin, item.reviewState], ['LOCAL', 'SYNTHETIC', 'REVIEWED']);
    assert.ok((item.observations ?? []).every(observation => observation.executionMode === 'LOCAL' && observation.dataOrigin === 'SYNTHETIC'));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ORIGIN_SEAL_FILE), 'utf8')).sealedBy, 'CREATED');
});

test('legacy scopes are sealed once from their directory name, keep every claim byte for byte, and an unnamed legacy directory is quarantined as UNKNOWN', () => {
  const root = scratchRoot(), named = path.join(root, 'GTFSAGENT', 'LIVE-PUBLIC'), bare = path.join(root, 'U2');
  for (const dir of [named, bare]) new Reconciler('AGENTFX', dir, 'concordia-agent').addClaim(claim({ reviewState: undefined }));
  const before = Object.fromEntries([named, bare].map(dir => [dir, fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')]));
  const first = sealLegacyAgentMemory(root);
  assert.deepEqual(first.map(item => [path.relative(root, item.dir).split(path.sep).join('/'), item.sealedBy, item.origin.executionMode, item.origin.dataOrigin]).sort(),
    [['GTFSAGENT/LIVE-PUBLIC', 'INFERRED_FROM_DIRECTORY', 'LIVE', 'PUBLIC'], ['U2', 'LEGACY_UNSCOPED', 'UNKNOWN', 'UNKNOWN']].sort());
  for (const dir of [named, bare]) assert.equal(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'), before[dir], 'sealing never rewrites a claim');
  assert.ok(sealLegacyAgentMemory(root).every(item => item.sealedBy === 'ALREADY_SEALED'), 'idempotent: the seal is written once');
  assert.throws(() => planWarmStart({ universeId: 'AGENTFX', discovery: { tables: {} }, relations: [], dir: bare, origin: LIVE }), /STATE_SCOPE_MISMATCH/, 'the unnamed legacy scope is never read as LIVE-PUBLIC');
  assert.equal(planWarmStart({ universeId: 'AGENTFX', discovery: { tables: {} }, relations: [], dir: named, origin: LIVE }).mode, 'WARM');
});

test('a legacy scope met by a plan is sealed on first touch from its directory name', () => {
  const dir = path.join(scratchRoot(), 'LIVE-PUBLIC');
  new Reconciler('AGENTFX', dir, 'concordia-agent').addClaim(claim());
  assert.equal(fs.existsSync(path.join(dir, ORIGIN_SEAL_FILE)), false);
  planWarmStart({ universeId: 'AGENTFX', discovery: { tables: {} }, relations: [], dir });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ORIGIN_SEAL_FILE), 'utf8')).sealedBy, 'INFERRED_FROM_DIRECTORY');
});

test('G0-6 write gate: a SOSTENIDA without run id, receipt or a REVIEWED contract is refused with SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW; a complete one is stored', () => {
  const strict = new Reconciler('AGENTFX', path.join(scratchRoot(), 'LOCAL-SYNTHETIC'), 'concordia-agent', { strictSustained: true, origin: LOCAL });
  for (const bad of [{ runId: undefined }, { requestIds: [] }, { reviewState: 'PENDING' }, { reviewState: undefined }, { reviewState: 'UNKNOWN' }]) {
    assert.throws(() => strict.addClaim(claim(bad) as any), /SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW/, JSON.stringify(bad));
  }
  assert.equal(strict.claims.length, 0, 'nothing was stored by the refused writes');
  const stored = strict.addClaim(claim() as any);
  assert.deepEqual([stored.executionMode, stored.dataOrigin, stored.reviewState, stored.runId], ['LOCAL', 'SYNTHETIC', 'REVIEWED', 'run-x']);
  strict.addClaim(claim({ value: 'INDETERMINADA', source: 'other.src', requestIds: [], reviewState: undefined, runId: undefined }) as any);
  assert.equal(strict.claims.length, 2, 'only SOSTENIDA relation status claims are gated');
  const legacy = new Reconciler('AGENTFX', path.join(scratchRoot(), 'legacy-scope'), 'concordia');
  assert.doesNotThrow(() => legacy.addClaim(claim({ runId: undefined, requestIds: [], reviewState: undefined }) as any), 'the legacy pipeline keeps its behaviour');
});

test('G0-6 ingest: a SOSTENIDA relation whose contract is not REVIEWED never reaches the strict memory', () => {
  const strict = new Reconciler('AGENTFX', path.join(scratchRoot(), 'LOCAL-SYNTHETIC'), 'concordia-agent', { strictSustained: true, origin: LOCAL });
  const relation = (reviewState: string) => ({ relationId: 'orders_customer', verdict: 'SOSTENIDA', rule: 'bounded_sample_key_membership', from: { db: 'D', table: 'orders', column: 'customer_id' }, to: { db: 'D', table: 'customers', column: 'customer_id' },
    relationContract: { reviewState }, evidence: { overlap: { ratio: 1 }, typeCompat: { castable: true }, queries: [{ requestId: 'req-1' }], utc: '2026-10-25T00:00:00Z', sourceVersion: 'rv1:x' } });
  const inventory = { tables: { orders: { sourceVersion: 'v' } } };
  // E1-02: the gate still refuses the claim, but it no longer aborts the batch: the rejection is reported (for quarantine) and nothing is written for it.
  strict.ingest(inventory, { relations: [relation('PENDING')] }, { runId: 'agent-gate-1' });
  assert.deepEqual([strict.claims.length, strict.lastBatch!.rejected.map(item => item.code)], [0, ['SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW']]);
  strict.ingest(inventory, { relations: [relation('REVIEWED')] });
  assert.deepEqual([strict.claims.length, strict.lastBatch!.rejected.map(item => item.code)], [0, ['SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW']], 'no run id');
  strict.ingest(inventory, { relations: [relation('REVIEWED')] }, { runId: 'agent-gate-2' });
  assert.equal(strict.claims.filter(item => item.value === 'SOSTENIDA').length, 1);
});

test('a persisted strict snapshot with a SOSTENIDA that declares PENDING review is refused on load', () => {
  const dir = path.join(scratchRoot(), 'LOCAL-SYNTHETIC');
  new Reconciler('AGENTFX', dir, 'concordia-agent').addClaim(claim({ reviewState: 'PENDING' }) as any);
  assert.throws(() => new Reconciler('AGENTFX', dir, 'concordia-agent', { strictSustained: true, origin: LOCAL }), /SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW/);
  assert.doesNotThrow(() => new Reconciler('AGENTFX', dir, 'concordia-agent'), 'the legacy reader is untouched');
});
