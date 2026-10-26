import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { planWarmStart, recordRunMemory, relationVersion, revalidateWarmStart } from '../src/agent/memory.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const NOW = '2026-10-24T00:00:00Z';
async function offlineRun(alias: string, runId: string, mutate?: (tables: any) => void) {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === alias)!);
  mutate?.(fixture.tables);
  return runAgent(alias, runId, { client: fixtureClient(universeConfig(alias), fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, now: () => NOW }) as Promise<any>;
}
const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

test('3.1 the run writes relation claims stamped with its run id; the ledger only appends', async () => {
  const dir = scratch();
  const report = await offlineRun('AGENTFX', 'agent-mem-a');
  const first = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-mem-a', discovery: report.artifacts.discovery, probes: report.artifacts.probes, dir });
  assert.equal(first.status, 'RECORDED');
  const sustained = report.decisions.filter((item: any) => item.verdict === 'SOSTENIDA').map((item: any) => item.relationId).sort();
  assert.ok(sustained.length >= 1);
  assert.deepEqual(first.claims.map(claim => claim.relationId).sort(), sustained);
  for (const claim of first.claims) { assert.deepEqual(claim.runIds, ['agent-mem-a']); assert.equal(claim.firstRunId, 'agent-mem-a'); assert.equal(claim.superseded, false); }
  const reloaded = new Reconciler('AGENTFX', dir);
  assert.equal(reloaded.claims.length, sustained.length);
  assert.ok(reloaded.hmem.store.all().every(record => record.provenance.label?.includes('[run agent-mem-a]')));
  const ledgerBefore = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8');
  const second = await offlineRun('AGENTFX', 'agent-mem-b');
  const again = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-mem-b', discovery: second.artifacts.discovery, probes: second.artifacts.probes, dir });
  assert.equal(new Reconciler('AGENTFX', dir).claims.length, sustained.length, 're-observation is not a second vote');
  assert.ok(again.claims.every(claim => claim.runIds.join() === 'agent-mem-a,agent-mem-b'));
  assert.ok(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').startsWith(ledgerBefore));
  assert.ok(again.ledger.entries > first.ledger.entries);
  assert.equal(again.reviewQueue.length, 0);
});

test('3.1 a probe-less run is SKIPPED and writes nothing; an unsupported scope surfaces as ERROR, never a throw', () => {
  const dir = scratch();
  const skipped = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-mem-none', discovery: {}, probes: [], dir });
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(fs.existsSync(dir), false, 'a probe-less run creates neither the scope nor its seal');
  const outside = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-mem-out', discovery: {}, probes: [{}], dir: path.join(ROOT, 'out', 'nope') });
  assert.equal(outside.status, 'ERROR');
});

const relationsOf = (alias: string, discovery: any) => universeConfig(alias).relations.filter((relation: any) => discovery.tables[relation.from.table] && discovery.tables[relation.to.table]);

test('3.2 a warm start reuses current SOSTENIDA evidence under its version and re-probes the rest with the reason', async () => {
  const dir = scratch();
  const cold = planWarmStart({ universeId: 'AGENTFX', discovery: {tables:{}}, relations: [], dir });
  assert.equal(cold.mode, 'COLD'); assert.equal(fs.existsSync(dir), false, 'planning never creates memory');
  const first = await offlineRun('AGENTFX', 'agent-warm-a');
  const relations = relationsOf('AGENTFX', first.artifacts.discovery);
  assert.equal(planWarmStart({ universeId: 'AGENTFX', discovery: first.artifacts.discovery, relations, dir, now: () => Date.parse(NOW) }).reused.length, 0);
  recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-warm-a', discovery: first.artifacts.discovery, probes: first.artifacts.probes, dir });
  const sustained = first.decisions.filter((item: any) => item.verdict === 'SOSTENIDA').map((item: any) => item.relationId).sort();
  const plan = planWarmStart({ universeId: 'AGENTFX', discovery: first.artifacts.discovery, relations, dir, now: () => Date.parse(NOW) });
  assert.equal(plan.mode, 'WARM');
  assert.deepEqual(plan.reused.map(item => item.relationId).sort(), sustained);
  assert.ok(plan.reused.every(item => item.reusedFromRunId === 'agent-warm-a' && item.version.startsWith('rv1:') && item.queriesSaved > 0));
  assert.equal(plan.queriesSaved, plan.reused.reduce((sum, item) => sum + item.queriesSaved, 0));
  assert.ok(plan.reprobe.every(item => item.reason === 'NOT_SUSTAINED' || item.reason === 'NO_MEMORY'));
  assert.equal(plan.reused.length + plan.reprobe.length, relations.length);
  // run 2 records its reuse as an observation of the run: no new claim, no new vote
  const claimsBefore = new Reconciler('AGENTFX', dir).claims.length;
  const recorded = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-warm-b', discovery: first.artifacts.discovery, probes: [], dir, warmStart: plan });
  assert.equal(recorded.status, 'RECORDED'); assert.equal(new Reconciler('AGENTFX', dir).claims.length, claimsBefore);
  assert.ok(recorded.claims.every(claim => claim.runIds.join() === 'agent-warm-a,agent-warm-b'));
  assert.deepEqual(recorded.reuse, plan);
});

test('3.2 an altered schema or TTL expiry blocks REUSED', async () => {
  const dir = scratch();
  const first = await offlineRun('AGENTFX', 'agent-warm-c');
  recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-warm-c', discovery: first.artifacts.discovery, probes: first.artifacts.probes, dir });
  const relations = relationsOf('AGENTFX', first.artifacts.discovery);
  const altered = structuredClone(first.artifacts.discovery);
  altered.tables.customers.sourceMetadata.rows.push(['loyalty_tier', 'string']);
  assert.notEqual(relationVersion(altered, relations.find((r: any) => r.to.table === 'customers')), relationVersion(first.artifacts.discovery, relations.find((r: any) => r.to.table === 'customers')));
  const plan = planWarmStart({ universeId: 'AGENTFX', discovery: altered, relations, dir, now: () => Date.parse(NOW) });
  assert.ok(plan.reprobe.some(item => item.reason === 'VERSION_CHANGED' && item.relationId === 'orders_customer' && item.rememberedVersion));
  assert.ok(plan.reused.every(item => item.relationId !== 'orders_customer'));
  assert.ok(plan.reused.some(item => item.relationId === 'orders_region'), 'untouched relations are still reused');
  const expired = planWarmStart({ universeId: 'AGENTFX', discovery: first.artifacts.discovery, relations, dir, ttlMs: 1000, now: () => Date.parse(NOW) + 5000 });
  assert.equal(expired.reused.length, 0); assert.ok(expired.reprobe.some(item => item.reason === 'EXPIRED'));
});

test('3.3 E-10: cold, hot unchanged and hot altered, measured through revalidation inside the budget', async () => {
  const dir = scratch(), alias = 'AGENTFX', cfg = universeConfig(alias);
  const fixture = agentFixtures().find(item => item.alias === alias)!;
  const first = await offlineRun(alias, 'agent-reval-a');
  const relations = relationsOf(alias, first.artifacts.discovery);
  const sustained = first.decisions.filter((item: any) => item.verdict === 'SOSTENIDA').map((item: any) => item.relationId).sort();
  const budgetFor = (queries = 25) => new RunBudget(limitsFromBounds({ maxQueriesPerRun: queries }));
  // COLD: no memory, every relation is probed
  const cold = planWarmStart({ universeId: alias, discovery: first.artifacts.discovery, relations, dir, now: () => Date.parse(NOW) });
  assert.deepEqual({ reused: cold.reused.length, reprobe: cold.reprobe.length }, { reused: 0, reprobe: relations.length });
  recordRunMemory({ universeId: alias, runId: 'agent-reval-a', discovery: first.artifacts.discovery, probes: first.artifacts.probes, dir });
  // HOT, nothing changed: tables re-described once each, REUSED stands
  const plan = planWarmStart({ universeId: alias, discovery: first.artifacts.discovery, relations, dir, now: () => Date.parse(NOW) });
  const unchangedBudget = budgetFor();
  const unchanged = await revalidateWarmStart({ plan, cfg, discovery: first.artifacts.discovery, client: fixtureClient(cfg, fixture.tables) as any, budget: unchangedBudget, relations });
  assert.deepEqual(unchanged.revalidation.confirmed.sort(), sustained);
  assert.equal(unchanged.revalidation.altered.length, 0);
  assert.equal(unchangedBudget.queries, unchanged.revalidation.queriesSpent);
  assert.ok(unchanged.revalidation.queriesSpent <= 3 && unchanged.revalidation.queriesSavedByReuse > unchanged.revalidation.queriesSpent, 'reuse saves more queries than revalidation spends');
  assert.equal(unchanged.plan.reused.length, sustained.length);
  // HOT, a version altered: the touched relation drops out of REUSED and its dependents are invalidated
  const alteredTables = structuredClone(fixture.tables); alteredTables.customers.columns.push({ name: 'loyalty_tier', type: 'string' }); alteredTables.customers.rows.forEach((row: unknown[]) => row.push('gold'));
  const altered = await revalidateWarmStart({ plan, cfg, discovery: first.artifacts.discovery, client: fixtureClient(cfg, alteredTables) as any, budget: budgetFor(), relations });
  assert.deepEqual(altered.revalidation.altered.map(item => item.relationId), ['orders_customer']);
  assert.equal(altered.revalidation.altered[0].invalidated.length, 3);
  assert.ok(altered.plan.reprobe.some(item => item.relationId === 'orders_customer' && item.reason === 'VERSION_CHANGED'));
  assert.ok(altered.plan.reused.every(item => item.relationId !== 'orders_customer') && altered.revalidation.probesSaved === sustained.length - 1);
  // verdicts and stored claims are untouched by revalidation
  assert.equal(new Reconciler(alias, dir).claims.length, sustained.length);
  // an exhausted budget leaves relations unverified, never claimed fresh
  const starved = await revalidateWarmStart({ plan, cfg, discovery: first.artifacts.discovery, client: fixtureClient(cfg, fixture.tables) as any, budget: budgetFor(1), relations });
  assert.ok(starved.revalidation.unverified.length >= 1 && starved.revalidation.unverified.every(item => item.reason === 'QUERY_BUDGET_EXHAUSTED'));
  assert.equal(starved.revalidation.queriesSpent, 1);
  assert.equal(starved.revalidation.confirmed.length + starved.revalidation.unverified.length, sustained.length);
});

test('3.5 full history: run-1 decides, evidence is altered, run-2 degrades with its history; an unchanged run-2 reuses', async () => {
  const dir = scratch(), alias = 'AGENTFX';
  const one = await offlineRun(alias, 'agent-hist-1');
  const relations = relationsOf(alias, one.artifacts.discovery);
  recordRunMemory({ universeId: alias, runId: 'agent-hist-1', discovery: one.artifacts.discovery, probes: one.artifacts.probes, dir });
  const ledgerAfterOne = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8');
  const decided = new Reconciler(alias, dir).claims.find(claim => claim.entity === 'relation:orders_customer')!;
  assert.equal(decided.value, 'SOSTENIDA');

  // branch A: nothing changed -> run 2 reuses and the history shows both runs
  const planA = planWarmStart({ universeId: alias, discovery: one.artifacts.discovery, relations, dir, now: () => Date.parse(NOW) });
  assert.ok(planA.reused.some(item => item.relationId === 'orders_customer'));

  // branch B: customers no longer carry the orders' keys -> run 2 re-probes and the verdict drops
  const two = await offlineRun(alias, 'agent-hist-2', tables => { tables.customers.rows = [['z1', 'Zed', 's1'], ['z2', 'Yan', 's2'], ['z3', 'Xia', 's3']]; });
  const verdictTwo = two.decisions.find((item: any) => item.relationId === 'orders_customer').verdict;
  assert.notEqual(verdictTwo, 'SOSTENIDA');
  const recorded = recordRunMemory({ universeId: alias, runId: 'agent-hist-2', discovery: two.artifacts.discovery, probes: two.artifacts.probes, dir });
  assert.equal(recorded.status, 'RECORDED');
  const after = new Reconciler(alias, dir);
  const history = after.claims.filter(claim => claim.entity === 'relation:orders_customer');
  assert.equal(history.length, 2, 'the earlier claim is kept, not overwritten');
  const old = history.find(claim => claim.id === decided.id)!, next = history.find(claim => claim.id !== decided.id)!;
  assert.equal(after.hmem.store.get(old.id)?.supersededBy, next.id);
  assert.deepEqual(old.observations?.map(item => item.runId), ['agent-hist-1']);
  assert.deepEqual(next.observations?.map(item => item.runId), ['agent-hist-2']);
  assert.match(next.rule!, /^verdict_changed_in_run/);
  const view = recorded.claims.find(claim => claim.id === next.id)!;
  assert.equal(view.value, verdictTwo); assert.equal(view.superseded, false);
  assert.ok(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').startsWith(ledgerAfterOne), 'ledger only appends');
  assert.ok(after.hmem.ledger.all().some(entry => (entry.details as any)?.event === 'verdict_changed_in_run' && (entry.details as any)?.runId === 'agent-hist-2'));
  // the untouched relation keeps both runs; run 3 no longer reuses the degraded relation
  const region = recorded.claims.find(claim => claim.relationId === 'orders_region');
  assert.deepEqual(region?.runIds, ['agent-hist-1', 'agent-hist-2']);
  const planC = planWarmStart({ universeId: alias, discovery: two.artifacts.discovery, relations, dir, now: () => Date.parse(NOW) });
  assert.ok(planC.reprobe.some(item => item.relationId === 'orders_customer' && item.reason === 'NOT_SUSTAINED'));
  assert.ok(planC.reused.some(item => item.relationId === 'orders_region'));
});

test('3.5 U2 fixture: abstentions leave memory without sustained claims, and a second run has nothing to reuse', async () => {
  const dir = scratch();
  const one = await offlineRun('U2', 'agent-hist-u2a');
  const recorded = recordRunMemory({ universeId: 'U2', runId: 'agent-hist-u2a', discovery: one.artifacts.discovery, probes: one.artifacts.probes, dir });
  assert.equal(recorded.status, 'RECORDED'); assert.equal(recorded.claims.length, 0);
  const plan = planWarmStart({ universeId: 'U2', discovery: one.artifacts.discovery, relations: relationsOf('U2', one.artifacts.discovery), dir });
  assert.equal(plan.reused.length, 0); assert.ok(plan.reprobe.length > 0);
});

test('3.1/3.2 engine: two consecutive offline runs, the second REUSES instead of probing (AGENTFX) and U2 shows no reusable evidence', async () => {
  for (const alias of ['AGENTFX', 'U2']) {
    const dir = scratch(), fixture = agentFixtures().find(item => item.alias === alias)!, cfg = universeConfig(alias);
    const run = (runId: string) => runAgent(alias, runId, { client: fixtureClient(cfg, fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, memory: { dir } }) as Promise<any>;
    const a = await run(`agent-eng-${alias.toLowerCase()}-1`), b = await run(`agent-eng-${alias.toLowerCase()}-2`);
    assert.equal(a.memory.status, 'RECORDED'); assert.equal(a.memory.reuse.mode, 'COLD');
    assert.equal(b.memory.reuse.mode, 'WARM');
    const sustained = a.decisions.filter((item: any) => item.verdict === 'SOSTENIDA').map((item: any) => item.relationId).sort();
    assert.deepEqual(b.memory.reuse.reused.map((item: any) => item.relationId).sort(), sustained);
    assert.deepEqual(b.decisions.filter((item: any) => item.reasonCodes.includes('REUSED_FROM_MEMORY')).map((item: any) => item.relationId).sort(), sustained);
    assert.equal(b.phases.probes.selected.every((id: string) => !sustained.includes(id)), true);
    assert.ok(b.budget.used.queries <= a.budget.used.queries);
    if (sustained.length) assert.ok(b.budget.used.queries < a.budget.used.queries, 'reused relations cost no probe queries');
    assert.ok(b.memory.claims.every((claim: any) => claim.runIds.length === 2));
  }
});
