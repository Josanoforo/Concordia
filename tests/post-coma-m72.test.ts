import test from 'node:test';
import assert from 'node:assert/strict';
import { priorFromRun, runPostComa } from '../src/agent/post-coma.ts';
import { RunBudget, budgetedClient, limitsFromBounds } from '../src/agent/run-budget.ts';

const col = (name: string) => ({ name, type: 'string' });
const parent = (n: number) => Array.from({ length: n }, (_, i) => [String(i + 1)]);
const tables: Record<string, string[][]> = { f: Array.from({ length: 6 }, (_, i) => [String(i % 4 + 1), String(i % 4 + 1), String(i % 4 + 1)]), p1: parent(6), p2: parent(6), p3: parent(2), p4: parent(6) };
const cols: Record<string, string[]> = { f: ['x', 'y', 'z'], p1: ['k'], p2: ['k'], p3: ['k'], p4: ['k'] };
const cfg: any = { tables: Object.fromEntries(Object.keys(tables).map(n => [n, { db: 'TPC', physicalTable: n, columns: cols[n].map(col), keyColumns: n === 'f' ? [] : ['k'], labels: [], role: 'table' }])) };
const discovery = { tables: Object.fromEntries(Object.keys(tables).map(n => [n, { columns: cols[n], sample: { rows: tables[n] } }])) };
const proposal = (column: string, target: string, rawScore: number) => ({ providerId: 'p', providerVersion: '1', method: 'COMA', from: { db: 'TPC', table: 'f', column }, to: { db: 'TPC', table: target, column: 'k' }, rawScore, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN' as const, reviewState: 'PENDING' as const, inputHash: 'h', configHash: 'c', evidenceRefs: [] });
const proposals = [proposal('x', 'p1', 0.99), proposal('y', 'p2', 0.98), proposal('z', 'p3', 0.97), proposal('x', 'p4', 0.96)];
const client: any = { async runSql(sql: string, limit = 50) {
  const t = /\bp[1-4]\b/.exec(sql)![0], inList = [...sql.matchAll(/'(\d+)'/g)].map(m => m[1]);
  return { sql, rows: tables[t].filter(r => inList.includes(r[0])).slice(0, limit), requestId: 'r', queryId: 'q', durationMs: 0, utc: 'x' };
} };
const thresholds = { sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8, misleadingLabelAgreement: 0.5 };
const scope = { universeId: 'U', executionMode: 'LIVE', dataOrigin: 'REAL' };
const go = (maxProbes: number, extra: any = {}, bounds: any = {}) => { const budget = new RunBudget(limitsFromBounds(bounds)); return runPostComa({ cfg, catalog: { postComa: { maxProbes, blind: true } } as any, discovery, proposals, client: budgetedClient(client, budget) as any, budget, thresholds, scope, ...extra }); };
const executedIds = (r: any) => r.proposals.filter((p: any) => p.coverageProbe.status === 'EXECUTED').map((p: any) => p.proposalId);

test('M7-2: without a prior run the probes follow the ranking; the plan states estimated and available queries', async () => {
  const r = await go(2);
  assert.equal(executedIds(r).length, 2); assert.equal(r.priorRun, undefined);
  assert.deepEqual([r.policy.estimatedQueries, r.policy.queriesAvailable], [2, 2]);
});

test('M7-2: maxProbes above what the query budget allows is reported up front', async () => {
  const r = await go(4, {}, { maxQueriesPerRun: 2 });
  assert.equal(r.policy.estimatedQueries, 4); assert.equal(r.policy.queriesAvailable, 2);
  assert.ok(r.limitations.some(l => /maxProbes 4 needs up to 4 queries but the run budget allows 2/.test(l)));
});

test('M7-2: a prior run of the same scope only changes selection and order; each probed pair keeps the same result and diagnostic', async () => {
  const first = await go(2), prior = priorFromRun({ postComa: first }, scope);
  const second = await go(2, { prior });
  const skipped = second.priorRun!.skipped.map(s => s.proposalId);
  assert.equal(second.priorRun!.applied, true);
  assert.deepEqual(skipped.sort(), executedIds(first).sort(), 'already demonstrated pairs are not probed again');
  assert.equal(executedIds(second).length, 2); assert.ok(executedIds(second).every((id: string) => !skipped.includes(id)), 'unprobed pairs moved up');
  const withoutPrior = await go(4);
  for (const id of executedIds(second)) {
    const a = withoutPrior.proposals.find(p => p.proposalId === id)!, b = second.proposals.find(p => p.proposalId === id)!;
    assert.deepEqual(b.coverageProbe, a.coverageProbe, `${id} has the same result and diagnostic with and without the prior run`);
    assert.equal(b.verificationStatus, 'NO VERIFICADO/UNKNOWN'); assert.equal(b.reviewState, 'PENDING');
  }
  for (const id of skipped) assert.equal(second.proposals.find(p => p.proposalId === id)!.coverageProbe.status, 'SUGGESTED');
});

test('M7-2: a prior run from another origin-sealed scope is ignored and the output equals the run without one', async () => {
  const first = await go(2), prior = priorFromRun({ postComa: first }, { ...scope, dataOrigin: 'SYNTHETIC' });
  const other = await go(2, { prior }), plain = await go(2);
  assert.deepEqual(other.priorRun, { applied: false, reason: 'PRIOR_RUN_SCOPE_MISMATCH', skipped: [] });
  assert.deepEqual(other.proposals, plain.proposals);
});

test('P1: coverAll probes every executable candidate beyond maxProbes', async () => {
  const r = await go(2, {}).then(() => { const budget = new RunBudget(limitsFromBounds({})); return runPostComa({ cfg, catalog: { postComa: { maxProbes: 2, blind: true, coverAll: true } } as any, discovery, proposals, client: budgetedClient(client, budget) as any, budget, thresholds, scope }); });
  assert.equal(executedIds(r).length, 4); assert.equal(r.notExecutedByBudget.length, 0);
  assert.deepEqual([r.policy.coverAll, r.policy.maxProbes, r.policy.estimatedQueries, r.policy.queriesAvailable, r.policy.budgetShortfall], [true, 4, 4, 4, undefined]);
});

test('P1: when the budget cannot pay for every candidate nothing runs and the budget needed is reported; allowCut runs the best-ranked ones', async () => {
  let calls = 0;
  const counting: any = { runSql: async (sql: string, limit?: number) => { calls++; return client.runSql(sql, limit); } };
  const run = (extra: any) => { const budget = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 2 })); return runPostComa({ cfg, catalog: { postComa: { maxProbes: 2, blind: true, coverAll: true, ...extra } } as any, discovery, proposals, client: budgetedClient(counting, budget) as any, budget, thresholds, scope }); };
  const stopped = await run({});
  assert.equal(stopped.status, 'BUDGET_REQUIRED'); assert.equal(calls, 0, 'no SQL was sent');
  assert.deepEqual(stopped.policy.budgetShortfall, { needed: 4, available: 2, action: 'BUDGET_REQUIRED' });
  assert.ok(stopped.proposals.every(p => p.coverageProbe.status === 'SUGGESTED' && p.coverageProbe.reason === 'BUDGET_REQUIRED'));
  assert.ok(stopped.limitations.some(l => /nothing was probed; raise maxQueriesPerRun to at least 4/.test(l)));
  const cut = await run({ allowCut: true });
  assert.equal(calls, 2); assert.equal(cut.policy.budgetShortfall!.action, 'CUT_TO_AVAILABLE_BY_RANKING'); assert.equal(executedIds(cut).length, 2); assert.equal(cut.status, 'PARTIAL');
});
