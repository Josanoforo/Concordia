import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { loadTpcdsGold, scoreTpcdsCandidates, type CandidateEdge } from '../src/eval/tpcds-gold.ts';
import { createInstalledComaBridge, type ComaBridge, type ComaSchemaInput } from '../src/discovery/coma-provider.ts';
import { FORBIDDEN_COLUMN } from '../src/agent/catalog.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { ROOT } from '../src/runtime.ts';

/** TPCDS end to end, offline: no relation is configured, COMA proposes over every table pair, the post-COMA diagnostics measure coverage, and the result is scored against the gold OUTSIDE the runtime. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => agentFixtures().find(item => item.alias === 'TPCDS')!;
async function run(bridge: ComaBridge, runId: string) {
  const cfg = universeConfig('TPCDS');
  return runAgent('TPCDS', runId, { client: fixtureClient(cfg, fixture().tables) as any, chooser: new Script([...fixture().chooserScript]), comaBridge: bridge, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false }) as Promise<any>;
}
const tokens = (name: string) => new Set(name.split('_').slice(1));
/** Deterministic schema-name stand-in for COMA: Jaccard of the name tokens after the table prefix. */
const nameBridge: ComaBridge = (input: ComaSchemaInput) => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: input.pairs.map(pair => ({ source: pair.source, target: pair.target,
  matches: input.tables[pair.source].columns.flatMap(a => input.tables[pair.target].columns.flatMap(b => { const x = tokens(a), y = tokens(b), shared = [...x].filter(t => y.has(t)).length, score = shared / (x.size + y.size - shared); return score >= 0.5 ? [{ sourceColumn: a, targetColumn: b, rawScore: score }] : []; })) })) });
/** A bridge that answers only the listed column pairs, in the orientation of the (source < target) pair it is asked about. */
const targetedBridge = (wanted: [string, string, string, string, number][]): ComaBridge => input => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: input.pairs.flatMap(pair => {
  const matches = wanted.filter(([ta, , tb]) => ta === pair.source && tb === pair.target).map(([, a, , b, score]) => ({ sourceColumn: a, targetColumn: b, rawScore: score }));
  return matches.length ? [{ source: pair.source, target: pair.target, matches }] : [];
}) });
const executed = (report: any) => report.postComa.proposals.filter((item: any) => item.coverageProbe?.status === 'EXECUTED');
const edgeOf = (item: any): CandidateEdge => ({ from: { table: item.from.table, column: item.from.column }, to: { table: item.to.table, column: item.to.column } });
const accepted = (report: any) => executed(report).filter((item: any) => item.coverageProbe.diagnostic.coverage.level === 'HIGH' && !item.coverageProbe.diagnostic.suspect.value);

test('end to end without configured relations: COMA over 276 table pairs, bounded coverage probes, candidates that need review, and no verdict', async () => {
  const report = await run(nameBridge, 'agent-tpcds-e2e-1');
  assert.equal(report.status, 'COMPLETED'); assert.deepEqual(report.decisions, []);
  assert.equal(report.phases.coma.status, 'RAN'); assert.equal(report.phases.coma.candidates, 0, 'nothing is in scope, so every COMA match is an out-of-scope proposal');
  assert.ok(report.phases.coma.outOfScopeProposals.length > 100);
  assert.deepEqual(report.phases.probes.selected, []);
  const counts = report.postComa.counts;
  assert.ok(counts.executed >= 1 && counts.proposals >= counts.executed, JSON.stringify(counts));
  assert.equal(report.postComa.policy.coverAll, true, 'the shipped config covers every candidate (Round 9), no longer a 30-probe cap');
  assert.equal(counts.executed + counts.notExecutable, counts.proposals, 'nothing left out by a cap');
  assert.equal(counts.executed + counts.suggested + counts.notExecutable + counts.skippedBudget + counts.failed, counts.proposals, 'every proposal is accounted for');
  assert.ok(report.budget.used.queries <= 4000 && report.budget.used.discoveryQueries === 24, 'within the declared full-run budget');
  for (const item of executed(report)) {
    assert.equal(item.verificationStatus, 'NO VERIFICADO/UNKNOWN'); assert.equal(item.reviewState, 'PENDING'); assert.equal(item.coverageProbe.diagnostic.governance, 'CANDIDATE_REQUIRES_REVIEW');
    assert.ok(!JSON.stringify(item).includes('"verdict"'));
  }
});

test('evaluation against the P5 gold, outside the runtime: precision and recall with their denominators', async () => {
  const report = await run(nameBridge, 'agent-tpcds-e2e-2'), score = scoreTpcdsCandidates(accepted(report).map(edgeOf), loadTpcdsGold());
  process.stderr.write(`TPCDS_E2E_SCORE ${JSON.stringify({ candidates: score.candidates, truePositives: score.truePositives, precision: score.precision, recall: score.recall, goldEdges: score.goldEdges, reversed: score.reversed.length, traps: score.trapsProposed.length, executed: executed(report).length, proposals: report.postComa.counts.proposals })}\n`);
  assert.equal(score.goldEdges, 103); assert.equal(score.candidates, accepted(report).length);
  assert.ok(score.precision === null || (score.precision >= 0 && score.precision <= 1)); assert.ok(score.recall! >= 0 && score.recall! <= 1);
  for (const item of executed(report)) {
    const s = scoreTpcdsCandidates([edgeOf(item)], loadTpcdsGold());
    if (s.truePositives === 1) assert.ok(accepted(report).includes(item), `${item.proposalId} is a true foreign key and must stay a high-coverage, unsuspected candidate`);
  }
});

test('true foreign keys come out HIGH without suspicion; labelled homonyms of different entities come out LABEL_CONFLICT; unrelated key ranges come out NONE', async () => {
  const keys: [string, string, string, string, number][] = [
    ['catalog_sales', 'cs_sold_date_sk', 'date_dim', 'd_date_sk', 0.99], ['catalog_returns', 'cr_reason_sk', 'reason', 'r_reason_sk', 0.98], ['catalog_sales', 'cs_ship_mode_sk', 'ship_mode', 'sm_ship_mode_sk', 0.97],
    ['catalog_sales', 'cs_warehouse_sk', 'warehouse', 'w_warehouse_sk', 0.96], ['call_center', 'cc_open_date_sk', 'date_dim', 'd_date_sk', 0.95], ['catalog_page', 'cp_start_date_sk', 'date_dim', 'd_date_sk', 0.94]];
  const homonyms: [string, string, string, string, number][] = [
    ['call_center', 'cc_call_center_sk', 'ship_mode', 'sm_ship_mode_sk', 0.9], ['store', 's_store_sk', 'warehouse', 'w_warehouse_sk', 0.88], ['warehouse', 'w_warehouse_sk', 'web_site', 'web_site_sk', 0.87]];
  const disjoint: [string, string, string, string, number][] = [['customer', 'c_customer_sk', 'item', 'i_item_sk', 0.86], ['item', 'i_item_sk', 'reason', 'r_reason_sk', 0.85]];
  const report = await run(targetedBridge([...keys, ...homonyms, ...disjoint]), 'agent-tpcds-e2e-3'), byId = Object.fromEntries(report.postComa.proposals.map((item: any) => [item.proposalId, item]));
  const diag = (row: [string, string, string, string, number]) => { const item = byId[`${row[0]}.${row[1]}__${row[2]}.${row[3]}`]; assert.ok(item, `proposal ${row[1]} -> ${row[3]} exists (${Object.keys(byId).length} proposals)`); return item.coverageProbe.diagnostic; };
  for (const row of keys) { const d = diag(row); assert.deepEqual([d.coverage.level, d.suspect.value], ['HIGH', false], `${row[1]} -> ${row[3]}`); }
  for (const row of homonyms) { const d = diag(row); assert.equal(d.labels.signal, 'LABEL_CONFLICT', `${row[1]} ~ ${row[3]}`); assert.equal(d.suspect.value, true); }
  for (const row of disjoint) { const d = diag(row); assert.equal(d.coverage.level, 'NONE'); assert.ok(d.suspect.reasons.includes('NO_COVERAGE') && d.suspect.value); /* key-to-key pairs also carry KEY_TO_KEY */ }
  const score = scoreTpcdsCandidates(accepted(report).map(edgeOf), loadTpcdsGold());
  assert.deepEqual([score.candidates, score.truePositives, score.falsePositives, score.trapsProposed], [6, 6, 0, []], 'the accepted candidates are exactly the true keys');
  assert.equal(score.goldEdges, 103); assert.equal(score.recall, 6 / 103);
});

test('fact-to-fact siblings with duplicated keys are not accepted as foreign keys', async () => {
  const report = await run(targetedBridge([['catalog_sales', 'cs_bill_customer_sk', 'web_sales', 'ws_bill_customer_sk', 0.99]]), 'agent-tpcds-e2e-4');
  const d = report.postComa.proposals[0].coverageProbe.diagnostic;
  assert.equal(d.suspect.value, true);
});

test('measured with the installed COMA (skipped where it is not installed): what the blind loop proposes and accepts on the fixture', async t => {
  const python = path.join(ROOT, '.concordia', 'python', 'coma-valentine-1.1.0', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) { t.skip('COMA interpreter not installed'); return; }
  const report = await run(createInstalledComaBridge(python, ROOT), 'agent-tpcds-e2e-5'), score = scoreTpcdsCandidates(accepted(report).map(edgeOf), loadTpcdsGold());
  process.stderr.write(`TPCDS_E2E_REAL_COMA ${JSON.stringify({ proposals: report.postComa.counts.proposals, executed: executed(report).length, accepted: score.candidates, truePositives: score.truePositives, reversed: score.reversed.length, precision: score.precision, recall: score.recall, goldEdges: score.goldEdges })}\n`);
  assert.equal(report.status, 'COMPLETED'); assert.deepEqual(report.decisions, []); assert.ok(report.postComa.counts.proposals > 1000);
});

test('recall ceiling lifted (P4): the name filter exempts key columns, so the 11 customer_address key foreign keys are inside the COMA scope and the gold denominator is the whole 103', () => {
  const gold = loadTpcdsGold(), hidden = gold.edges.filter(edge => FORBIDDEN_COLUMN.test(edge.from.column) || FORBIDDEN_COLUMN.test(edge.to.column));
  assert.deepEqual(hidden, []);
  assert.equal(gold.edges.filter(edge => edge.to.column === 'ca_address_sk').length, 11);
  assert.equal(gold.edges.length, 103);
});
