import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { ingestRunMemory, planWarmStart, readQuarantine, recordRunMemory } from '../src/agent/memory.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** E1-02: two-phase validation + quarantine + declared health threshold (config/memory-batch.json: 3 rejected AND > 10%). */
const NOW = '2026-10-24T00:00:00Z';
const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

async function baseRun(runId: string) {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  return runAgent('AGENTFX', runId, { client: fixtureClient(universeConfig('AGENTFX'), fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, now: () => NOW }) as Promise<any>;
}
/** `total` SOSTENIDA probes cloned from a real one; the first `bad` of them lose their request receipts (the strict gate refuses them). */
async function batch(runId: string, total: number, bad: number) {
  const report = await baseRun(runId), real = report.artifacts.probes.find((probe: any) => probe.verdict === 'SOSTENIDA');
  assert.ok(real, 'the AGENTFX fixture sustains a relation');
  const probes = Array.from({ length: total }, (_, index) => {
    const copy = structuredClone(real); copy.relationId = `${real.relationId}_c${index}`;
    if (index < bad) copy.evidence = { ...copy.evidence, queries: [] };
    return copy;
  });
  return { discovery: report.artifacts.discovery, probes };
}
const claimsOf = (dir: string) => new Reconciler('AGENTFX', dir).claims;

test('0 rejected: everything is written, status RECORDED, no quarantine', async () => {
  const dir = scratch(), { discovery, probes } = await batch('agent-batch-0', 20, 0);
  const memory = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-batch-0', discovery, probes, dir, now: () => NOW });
  assert.equal(memory.status, 'RECORDED');
  assert.deepEqual([memory.batch!.total, memory.batch!.admitted, memory.batch!.rejected, memory.batch!.quarantineFile], [20, 20, 0, null]);
  assert.equal(claimsOf(dir).length, 20);
  assert.deepEqual(readQuarantine(dir), []);
});

test('1 of 20 rejected: 19 written, 1 in quarantine with its reason, run memory DEGRADED with n/N', async () => {
  const dir = scratch(), { discovery, probes } = await batch('agent-batch-1', 20, 1);
  const memory = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-batch-1', discovery, probes, dir, now: () => NOW });
  assert.equal(memory.status, 'DEGRADED');
  assert.deepEqual([memory.batch!.total, memory.batch!.admitted, memory.batch!.rejected, memory.batch!.unhealthy], [20, 19, 1, false]);
  assert.deepEqual(memory.batch!.reasons.map(item => item.code), ['SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW']);
  assert.equal(claimsOf(dir).length, 19);
  const quarantined = readQuarantine(dir);
  assert.equal(quarantined.length, 1); assert.equal(quarantined[0]!.runId, 'agent-batch-1');
  assert.equal(quarantined[0]!.rejected[0]!.runId, 'agent-batch-1');
  assert.deepEqual(quarantined[0]!.rejected[0]!.evidence.requestIds, []);
  assert.ok(memory.reviewQueue.some((item: any) => item.kind === 'QUARANTINED_CLAIM' && item.relationId.endsWith('_c0')));
});

test('3 of 20 rejected (15% and >= 3): nothing is written, not even the valid ones; FAILED MEMORY_BATCH_UNHEALTHY; the rejected go to quarantine', async () => {
  const dir = scratch(), { discovery, probes } = await batch('agent-batch-3', 20, 3);
  const memory = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-batch-3', discovery, probes, dir, now: () => NOW });
  assert.equal(memory.status, 'FAILED');
  assert.equal((memory.error as any).code, 'MEMORY_BATCH_UNHEALTHY');
  assert.deepEqual([memory.batch!.admitted, memory.batch!.rejected, memory.batch!.written], [0, 3, false]);
  assert.equal(claimsOf(dir).length, 0);
  assert.equal(readQuarantine(dir)[0]!.rejected.length, 3);
});

test('a small batch (2 of 5, under the minimum of 3) does not fail the run: it degrades', async () => {
  const dir = scratch(), { discovery, probes } = await batch('agent-batch-s', 5, 2);
  const memory = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-batch-s', discovery, probes, dir, now: () => NOW });
  assert.equal(memory.status, 'DEGRADED'); assert.equal(claimsOf(dir).length, 3);
});

test('the quarantine is never read as claims: warm start and reconcile ignore it', async () => {
  const dir = scratch(), { discovery, probes } = await batch('agent-batch-q', 20, 1);
  recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-batch-q', discovery, probes, dir, now: () => NOW });
  assert.ok(fs.existsSync(path.join(dir, 'quarantine')));
  const rejectedId = readQuarantine(dir)[0]!.rejected[0]!.relationId;
  assert.ok(!claimsOf(dir).some(claim => claim.entity === `relation:${rejectedId}`));
  const cfg = universeConfig('AGENTFX');
  const plan = planWarmStart({ universeId: 'AGENTFX', discovery, dir, relations: [{ id: rejectedId, from: probes[0].from, to: probes[0].to, normalization: cfg.normalizationContract?.defaultMode ?? 'text' } as any] });
  assert.equal(plan.reused.length, 0);
});

test('engine: a healthy run reports memory.batch with 0 rejected and no memory degradation', async () => {
  // Through the engine the probes come from the run itself, so exercise the report mapping with the memory section directly via a run whose memory is healthy.
  const dir = scratch(), fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const report: any = await runAgent('AGENTFX', 'agent-batch-e', { client: fixtureClient(universeConfig('AGENTFX'), fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, now: () => NOW, memory: { dir } });
  assert.equal(report.memory.status, 'RECORDED');
  assert.deepEqual([report.memory.batch.rejected, report.memory.batch.unhealthy], [0, false]);
  assert.ok(!report.degradations.some((item: any) => /^MEMORY_(BATCH|CLAIMS)/.test(item.code)));
});

test('re-ingest from a run directory is idempotent, honours the origin seal, and a dry run writes nothing', async () => {
  const dir = scratch(), runDir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(runDir);
  const { discovery, probes } = await batch('agent-batch-r', 20, 1);
  fs.writeFileSync(path.join(runDir, 'engine-run.json'), JSON.stringify({ runId: 'agent-batch-r', universeId: 'AGENTFX', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' }));
  fs.writeFileSync(path.join(runDir, 'artifacts.json'), JSON.stringify({ runId: 'agent-batch-r', universeId: 'AGENTFX', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', probes }));
  fs.writeFileSync(path.join(runDir, 'discovery.json'), JSON.stringify(discovery));
  const dry = ingestRunMemory({ runDir, universeId: 'AGENTFX', dryRun: true, dir });
  assert.deepEqual([dry.status, dry.wouldWrite], ['DRY_RUN', { total: 20, admitted: 19, rejected: 1 }]);
  assert.equal(fs.existsSync(dir), false, 'a dry run creates nothing');
  const first = ingestRunMemory({ runDir, universeId: 'AGENTFX', dir, now: () => NOW });
  assert.deepEqual([first.status, first.ledgerPrefixPreserved, first.memory!.batch!.admitted], ['INGESTED', true, 19]);
  const ledger = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8');
  const again = ingestRunMemory({ runDir, universeId: 'AGENTFX', dir, now: () => NOW });
  assert.equal(again.status, 'ALREADY_INGESTED');
  assert.equal(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8'), ledger, 'nothing written the second time');
  assert.equal(claimsOf(dir).length, 19);
  assert.throws(() => ingestRunMemory({ runDir, universeId: 'AGENTFX', dir: path.join(path.dirname(dir), 'LIVE-PUBLIC'), now: () => NOW }), /STATE_SCOPE_MISMATCH|MEMORY_ORIGIN/);
});
