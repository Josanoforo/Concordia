import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { loadTpcdsGold, scoreTpcdsCandidates } from '../src/eval/tpcds-gold.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { ROOT } from '../src/runtime.ts';

/** P5: the TPC-DS foreign-key gold lives in eval/, is read only by the evaluator, and is checked against the synthetic fixture. */
const fixture = () => agentFixtures().find(item => item.alias === 'TPCDS')!;
const values = (table: string, column: string) => { const t = fixture().tables[table], index = t.columns.findIndex(c => c.name === column); return t.rows.map(row => row[index]); };

test('the gold lists the TPC-DS foreign keys among allowlisted columns only, with composite keys and homonym traps apart', () => {
  const gold = loadTpcdsGold(), cfg = universeConfig('TPCDS');
  assert.equal(gold.edges.length, 103); assert.equal(gold.compositeEdges.length, 3); assert.ok(gold.homonymTraps.length >= 8);
  assert.equal(new Set(gold.edges.map(edge => edge.id)).size, gold.edges.length);
  const allowed = (table: string, column: string) => cfg.tables[table]?.columns.some((c: any) => c.name === column);
  for (const edge of gold.edges) assert.ok(allowed(edge.from.table, edge.from.column) && allowed(edge.to.table, edge.to.column), edge.id);
  for (const edge of gold.compositeEdges) assert.ok(edge.from.columns.every(c => allowed(edge.from.table, c)) && edge.to.columns.every(c => allowed(edge.to.table, c)), edge.id);
  const edgeKeys = new Set(gold.edges.flatMap(edge => [`${edge.from.table}.${edge.from.column}~${edge.to.table}.${edge.to.column}`, `${edge.to.table}.${edge.to.column}~${edge.from.table}.${edge.from.column}`]));
  for (const trap of gold.homonymTraps) {
    assert.ok(allowed(trap.a.table, trap.a.column) && allowed(trap.b.table, trap.b.column), trap.id);
    assert.ok(!edgeKeys.has(`${trap.a.table}.${trap.a.column}~${trap.b.table}.${trap.b.column}`), `${trap.id} is not a foreign key`);
  }
});

test('the fixture satisfies every gold foreign key and the homonym traps are mixed (overlapping and disjoint) without being keys', () => {
  const gold = loadTpcdsGold();
  for (const edge of gold.edges) {
    const parent = new Set(values(edge.to.table, edge.to.column));
    assert.ok(values(edge.from.table, edge.from.column).every(value => parent.has(value)), `${edge.id} holds in the fixture`);
  }
  const tuples = (table: string, columns: string[]) => fixture().tables[table].rows.map(row => columns.map(column => row[fixture().tables[table].columns.findIndex(c => c.name === column)]).join('|'));
  for (const edge of gold.compositeEdges) { const parent = new Set(tuples(edge.to.table, edge.to.columns)); assert.ok(tuples(edge.from.table, edge.from.columns).every(t => parent.has(t)), edge.id); }
  const overlapping = gold.homonymTraps.filter(trap => { const b = new Set(values(trap.b.table, trap.b.column)); return values(trap.a.table, trap.a.column).some(value => b.has(value)); });
  assert.ok(overlapping.length >= 6 && gold.homonymTraps.length - overlapping.length >= 3, 'the fixture has traps that overlap numerically and traps whose key ranges are disjoint');
  const cfg = universeConfig('TPCDS'), labelled = (table: string) => cfg.tables[table].labels.length > 0;
  assert.ok(gold.homonymTraps.filter(trap => labelled(trap.a.table) && labelled(trap.b.table)).length >= 4, 'dimension-to-dimension traps carry labels on both sides');
});

test('the scorer reports precision, recall and traps with their denominators; reversed edges and the absence of candidates are not hidden', () => {
  const gold = loadTpcdsGold(), edge = (id: string) => gold.edges.find(item => item.id === id)!;
  const good = edge('store_sales.ss_item_sk->item.i_item_sk'), also = edge('store_sales.ss_customer_sk->customer.c_customer_sk');
  const trap: any = { from: { table: 'store_sales', column: 'ss_customer_sk' }, to: { table: 'item', column: 'i_item_sk' } };
  const score = scoreTpcdsCandidates([good, also, trap, { from: good.to, to: good.from }], gold);
  assert.deepEqual([score.candidates, score.truePositives, score.falsePositives, score.goldEdges], [4, 2, 2, 103]);
  assert.equal(score.precision, 0.5); assert.equal(score.recall, 2 / 103);
  assert.deepEqual(score.reversed, ['item.i_item_sk->store_sales.ss_item_sk']);
  assert.deepEqual(score.trapsProposed, ['store_sales.ss_customer_sk~item.i_item_sk']);
  const late = gold.homonymTraps.find(trap => trap.addedAfter)!, predeclared = gold.homonymTraps.find(trap => !trap.addedAfter)!;
  assert.deepEqual([late.id, late.addedAfter], ['customer_demographics.cd_demo_sk~household_demographics.hd_demo_sk', 'agent-tpcds-live-01']);
  const both = scoreTpcdsCandidates([{ from: late.a, to: late.b }, { from: predeclared.a, to: predeclared.b }], gold);
  assert.deepEqual([both.trapsProposed.length, both.trapsProposedAddedAfter, both.trapsProposedPredeclared, both.trapsInGold, both.trapsPredeclared], [2, [late.id], [predeclared.id], gold.homonymTraps.length, gold.homonymTraps.length - 1], 'a trap added after a live run is counted apart, never as predicted');
  assert.equal(score.missed.length, 101); assert.equal(score.composite.goldEdges, 3);
  const none = scoreTpcdsCandidates([], gold);
  assert.deepEqual([none.precision, none.precisionReason, none.recall], [null, 'NO_CANDIDATES', 0]);
  assert.equal(scoreTpcdsCandidates([good, good], gold).candidates, 1, 'duplicate candidates count once');
});

class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}

test('the runtime never reads the gold: no gold path is opened during a run, no runtime source references it, and neither the universe config nor the catalog can name it', async () => {
  const cfg = universeConfig('TPCDS'), opened: string[] = [];
  const originals = { readFileSync: fs.readFileSync, openSync: fs.openSync, existsSync: fs.existsSync };
  const note = (target: unknown) => { opened.push(String(target)); };
  (fs as any).readFileSync = (target: any, ...rest: any[]) => { note(target); return (originals.readFileSync as any)(target, ...rest); };
  (fs as any).openSync = (target: any, ...rest: any[]) => { note(target); return (originals.openSync as any)(target, ...rest); };
  (fs as any).existsSync = (target: any) => { note(target); return originals.existsSync(target); };
  try { await runAgent('TPCDS', 'agent-tpcds-gold-guard-1', { client: fixtureClient(cfg, fixture().tables) as any, chooser: new Script([...fixture().chooserScript]), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: true }); }
  finally { Object.assign(fs, originals); }
  assert.ok(opened.length > 0, 'the spy observed the run');
  assert.deepEqual(opened.filter(target => /gold/i.test(target)), []);
  const runtimeDirs = ['src/agent', 'src/relations', 'src/probe', 'src/discovery', 'src/registry', 'src/clients', 'src/critic', 'src/contracts'];
  const files = [...runtimeDirs.flatMap(dir => fs.readdirSync(path.join(ROOT, dir), { recursive: true }).map(name => path.join(dir, String(name)))).filter(file => file.endsWith('.ts')), 'src/universe-pipeline.ts', 'src/runtime.ts'];
  assert.ok(files.length > 30);
  for (const file of files) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /TPCDS_fk_gold|tpcds-gold|eval\/gold/, file);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'universes/TPCDS.json'), 'utf8'), /gold|TPCDS_fk/i);
  assert.doesNotMatch(JSON.stringify(cfg.explorationCatalog), /gold/i);
});
