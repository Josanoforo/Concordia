import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import type { CandidateReview, CandidateReviewRequest } from '../src/agent/model-review-contract.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { findTies, measureTieEvidence } from '../src/agent/tie-evidence.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** R-1 tie evidence: HIGH candidates that share a source column get the global uniqueness (F1) of their targets, counted in the budget, handed to the reviewer, never blocking. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'NWCH')!);
const high = (proposal: any) => proposal.coverageProbe?.status === 'EXECUTED' && proposal.coverageProbe.diagnostic?.coverage?.level === 'HIGH' && !proposal.coverageProbe.diagnostic?.suspect?.value;
const key = (e: any) => `${e.table}.${e.column}`;
const nothing: CandidateReview = async request => ({ overlay: { origin: 'MODEL_REVIEW', counts: { approved: 0 }, notApproved: [] }, contracts: [] });
/** Profile of one column straight from the fixture rows, independent of the engine. */
function profile(table: string, column: string) {
  const t = (fixture().tables as any)[table], index = t.columns.findIndex((c: any) => c.name === column), values = t.rows.map((row: unknown[]) => row[index]);
  const present = values.filter((v: unknown) => v !== null && v !== undefined);
  return { rows: values.length, distinct: new Set(present).size, nulls: values.length - present.length };
}

test('tie evidence: the tie among HIGH candidates produces exactly the F1 of each distinct target column, equal to the fixture and handed to the reviewer', async () => {
  const seen: CandidateReviewRequest[] = [], f = fixture();
  const base = offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), cfg = universeConfig('NWCH'), physical = Object.fromEntries(Object.entries<any>(cfg.tables).map(([name, spec]) => [spec.physicalTable, name]));
  // The offline fixture client answers the BOUNDED profile only; the whole-table F1 form is answered here from the same fixture rows.
  const client = { ...base.client, runSql: async (sql: string, limit?: number) => {
    const whole = /^SELECT COUNT\(\*\) AS concordia_rows, COUNT\(DISTINCT `?(\w+)`?\) AS concordia_distinct, SUM\(CASE WHEN `?\w+`? IS NULL THEN 1 ELSE 0 END\) AS concordia_nulls FROM (.+)$/i.exec(sql);
    if (!whole || /LIMIT \d+\) concordia_bounded$/i.test(sql)) return (base.client as any).runSql(sql, limit);
    const table = Object.keys(physical).map(name => physical[name]!).find(name => whole[2]!.includes(cfg.tables[name].physicalTable))!, p = profile(table, whole[1]!);
    return { sql, rows: [[p.rows, p.distinct, p.nulls]], requestId: 'fx-f1', queryId: 'fx-f1', durationMs: 0, utc: 'x' };
  } };
  const report: any = await runAgent('NWCH', 'agent-tie-1', { ...base, client: client as any, persist: false, critic: false, candidateReview: async request => { seen.push(request); return nothing(request); } });
  const request = seen[0]!, proposals = request.proposals as any[], { ties, targets } = findTies(proposals);
  assert.ok(ties.length > 0 && targets.length >= 2, 'the NWCH fixture overlaps keys on purpose: there is at least one tie with two targets');
  assert.deepEqual(Object.keys(request.targetGlobalUniqueness ?? {}).sort(), [...targets].sort(), 'exactly the targets of the ties, once each');
  for (const target of targets) {
    const [table, column] = target.split('.') as [string, string], expected = profile(table, column);
    assert.deepEqual(request.targetGlobalUniqueness![target], { ...expected, unique: expected.distinct === expected.rows - expected.nulls }, target);
  }
  assert.deepEqual(request.globalTargetUniqueness, Object.fromEntries(targets.map(target => [target, request.targetGlobalUniqueness![target]!.unique ? 'UNIQUE' : 'NOT_UNIQUE'])), 'the same measurement as a verdict per measured column');
  const noTie = proposals.filter(high).filter(item => !ties.some(tie => tie.candidates.includes(item.proposalId)));
  for (const item of noTie) assert.equal(request.targetGlobalUniqueness![key(item.to)] === undefined || targets.includes(key(item.to)), true, 'a target only gets F1 if some tie reaches it');
  const section = report.phases.candidateReview.tieEvidence;
  assert.deepEqual([section.targets, section.queries + section.cached.length, section.estimate.units, section.estimate.perUnit.queries], [targets, targets.length, targets.length, 1], 'each target was scanned or served from the per-run cache (post-COMA profiles it first)');
  assert.deepEqual(section.notMeasured, []);
});

test('tie evidence: a budget that does not reach skips the F1 of the targets it cannot pay, says so, and does not block the review', () => {
  const proposal = (id: string, from: [string, string], to: [string, string]) => ({ proposalId: id, from: { table: from[0], column: from[1] }, to: { table: to[0], column: to[1] }, coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH' }, suspect: { value: false } } } });
  const cfg = universeConfig('NWCH'), tables = Object.keys(cfg.tables), [a, b, c] = tables as [string, string, string];
  const col = (t: string) => cfg.tables[t].columns[0].name as string;
  const proposals = [proposal('p1', [a, col(a)], [b, col(b)]), proposal('p2', [a, col(a)], [c, col(c)]), proposal('p3', [b, col(b)], [c, col(c)])];
  const found = findTies(proposals);
  assert.deepEqual(found.ties.map(t => [t.source, t.candidates]), [[`${a}.${col(a)}`, ['p1', 'p2']]], 'only candidates sharing a source column tie');
  assert.deepEqual(found.targets, [`${b}.${col(b)}`, `${c}.${col(c)}`].sort((x, y) => x.localeCompare(y, 'en')));
});

test('tie evidence: without a tie there is no query; an unreachable budget is reported per target', async () => {
  const cfg = universeConfig('NWCH'), [a, b] = Object.keys(cfg.tables) as [string, string], col = (t: string) => cfg.tables[t].columns[0].name as string;
  const lone = [{ proposalId: 'p1', from: { table: a, column: col(a) }, to: { table: b, column: col(b) }, coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH' }, suspect: { value: false } } } }];
  let calls = 0;
  const client = { runSql: async () => { calls++; return { rows: [[3, 3, 0]] }; } };
  const budget = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 5 }));
  const none = await measureTieEvidence({ cfg, client, budget, proposals: lone });
  assert.deepEqual([none.targets, none.queries, calls], [[], 0, 0]);
  const tied = [...lone, { ...lone[0], proposalId: 'p2', to: { table: Object.keys(cfg.tables)[2], column: col(Object.keys(cfg.tables)[2]!) } }];
  const empty = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 1 })); empty.chargeQuery();
  const starved = await measureTieEvidence({ cfg, client, budget: empty, proposals: tied });
  assert.deepEqual([starved.queries, calls, Object.keys(starved.measured)], [0, 0, []]);
  assert.deepEqual(starved.notMeasured.map(item => item.reason), ['QUERY_BUDGET_INSUFFICIENT', 'QUERY_BUDGET_INSUFFICIENT']);
});
