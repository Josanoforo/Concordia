import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST_COMA_JOURNAL_FILE, POST_COMA_RESUME_MISMATCH, runPostComa, type PostComaJournalHeader } from '../src/agent/post-coma.ts';
import { RunBudget, budgetedClient, limitsFromBounds } from '../src/agent/run-budget.ts';

const col = (name: string) => ({ name, type: 'string' });
const targets = ['t1', 't2', 't3', 't4'];
const tables: Record<string, { cols: string[]; rows: string[][] }> = { src: { cols: ['s_a', 's_b', 's_c', 's_d'], rows: [['1', '1', '1', '1'], ['2', '2', '2', '2'], ['3', '3', '3', '3']] },
  ...Object.fromEntries(targets.map((t, i) => [t, { cols: [`${t}_sk`], rows: [['1'], ['2'], ['3']] }])) };
const cfg: any = { tables: Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, { db: 'T', physicalTable: n, columns: t.cols.map(col), keyColumns: [], labels: [], role: 'table' }])) };
const discovery = { tables: Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, { columns: t.cols, sample: { rows: t.rows } }])) };
const proposals = targets.map((t, i) => ({ providerId: 'p', providerVersion: '1', method: 'COMA', from: { db: 'T', table: 'src', column: tables.src.cols[i] }, to: { db: 'T', table: t, column: `${t}_sk` }, rawScore: 0.9 - i / 100, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN' as const, reviewState: 'PENDING' as const, inputHash: 'h', configHash: 'c', evidenceRefs: [] }));
const thresholds = { sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8, misleadingLabelAgreement: 0.5 };
const header: PostComaJournalHeader = { kind: 'HEADER', schemaVersion: 1, codeSha: 'abc123', manifestHash: 'mh1', runId: 'run-1' };
const dir = () => join(mkdtempSync(join(tmpdir(), 'pcj-')), POST_COMA_JOURNAL_FILE);
let counter = 0;
const go = async (extra: { journal?: any; resume?: any; failAfter?: number; maxBudget?: number } = {}) => {
  const sqls: string[] = [], budget = new RunBudget(limitsFromBounds({}));
  const client: any = { async runSql(sql: string) {
    if (extra.failAfter !== undefined && sqls.length >= extra.failAfter) throw new Error('POWER_CUT');
    sqls.push(sql);
    const name = targets.find(t => new RegExp(`\\b${t}\\b`).test(sql.slice(sql.indexOf(' FROM '))))!;
    return { sql, rows: tables[name].rows.filter(r => [...sql.matchAll(/'(\d+)'/g)].some(m => m[1] === r[0])), requestId: `r${counter}`, queryId: `q${counter++}`, durationMs: 0, utc: 'x' };
  } };
  const report = await runPostComa({ cfg, catalog: { postComa: { maxProbes: 10 } } as any, discovery, proposals, client: budgetedClient(client, budget) as any, budget, thresholds, ...(extra.journal ? { journal: extra.journal } : {}), ...(extra.resume ? { resume: extra.resume } : {}) });
  return { report, sqls };
};
const strip = (r: any) => JSON.stringify(r.proposals.map((p: any) => ({ ...p, coverageProbe: { ...p.coverageProbe, result: p.coverageProbe.result && { ...p.coverageProbe.result, queryId: 'Q', requestId: 'R' } } })));

test('E1-03: every executed probe is journaled right away after a header with the code, manifest and run', async () => {
  const path = dir();
  const { report, sqls } = await go({ journal: { path, header } });
  const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines[0], header);
  assert.equal(lines.length, 1 + sqls.length); assert.equal(sqls.length, 4);
  assert.deepEqual(lines.slice(1).map(l => l.proposalId), report.proposals.map(p => p.proposalId));
  assert.ok(lines[1].sampledKeys.length && lines[1].queryIds.length === 1 && typeof lines[1].utc === 'string');
});

test('E1-03: interrupted after k of N probes, the resume reuses them with no SQL and ends exactly like an uninterrupted run', async () => {
  const whole = await go();
  const path = dir();
  const cut = await go({ journal: { path, header }, failAfter: 2 });
  assert.equal(cut.report.counts.failed, 2, 'the run lost its last probes');
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 3, 'header + the two probes that landed (failed probes are not journaled)');
  const resumed = await go({ resume: { journal: { path, header } } });
  assert.equal(resumed.sqls.length, 2, 'only the two missing probes are sent');
  assert.equal(strip(resumed.report), strip(whole.report));
  assert.equal(resumed.report.policy.resumedProbes, 2);
  assert.equal(resumed.report.policy.estimatedQueries, 2, 'the pre-estimate subtracts the resumed probes');
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 5, 'the resumed run completes the same journal');
  const again = await go({ resume: { journal: { path, header } } });
  assert.equal(again.sqls.length, 0); assert.equal(strip(again.report), strip(whole.report));
});

test('E1-03: any header difference refuses the resume and sends no SQL', async () => {
  const path = dir();
  await go({ journal: { path, header }, failAfter: 2 });
  for (const field of ['codeSha', 'manifestHash', 'runId'] as const) {
    const other = { ...header, [field]: 'different' };
    await assert.rejects(go({ resume: { journal: { path, header: other } } }), (error: any) => error.code === POST_COMA_RESUME_MISMATCH && error.detail === `HEADER_DIFFERS:${field}`);
  }
  await assert.rejects(go({ resume: { journal: { path: dir(), header } } }), (error: any) => error.code === POST_COMA_RESUME_MISMATCH);
});

test('E1-03: a truncated last line (power cut while writing) is discarded and that proposal is probed again', async () => {
  const path = dir();
  const whole = await go();
  await go({ journal: { path, header } });
  const text = readFileSync(path, 'utf8'), lines = text.trim().split('\n');
  writeFileSync(path, lines.slice(0, 3).join('\n') + '\n' + lines[3].slice(0, lines[3].length / 2));
  const resumed = await go({ resume: { journal: { path, header } } });
  assert.equal(resumed.sqls.length, 2, 'the torn probe and the missing one are probed again');
  assert.equal(strip(resumed.report), strip(whole.report));
  assert.ok(readFileSync(path, 'utf8').split('\n').filter(Boolean).every(line => JSON.parse(line)), 'the journal is whole again');
  appendFileSync(path, '{"kind":"PROBE"');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/\n.*\n/, '\nGARBAGE\n'));
  await assert.rejects(go({ resume: { journal: { path, header } } }), (error: any) => error.code === POST_COMA_RESUME_MISMATCH, 'a bad line that is not the last one is not a power cut');
});
