import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/runtime.ts';
import { writeAgentRunReport } from '../src/report/agent-run-report.ts';

const base = (): any => ({
  schemaVersion: 1, runId: 'syn-01', universeId: 'UX', manifestId: 'm.x', executionMode: 'SYNTHETIC', dataOrigin: 'SYNTHETIC', utc: '2026-01-01T00:00:00Z', status: 'COMPLETED',
  decisions: [{ relationId: 'r1', verdict: 'INDETERMINADA', reasonCodes: ['endpoint_evidence_missing'] }],
  budget: { limits: { maxQueriesPerRun: 25, maxSteps: 3, readLimit: 20 }, used: { queries: 4, steps: 2 }, exhausted: [] },
  limitations: ['Read-only'],
  phases: {
    discovery: { status: 'PASS', tables: ['t1'], relations: ['r1'] },
    coma: { status: 'RAN', candidates: 1, providerStates: [{ providerId: 'p', status: 'PARTIAL' }], outOfScopeProposals: [{ from: { table: 'a', column: 'b' }, to: { table: 'c', column: 'd' }, rawScore: 0.5, reason: 'OUT', verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING' }] },
    exploration: { actions: [{ step: 1, action: 'READ_X', reason: 'porque <b>si</b>', execution: 'PASS', observation: { rows: 1 } }],
      calls: [{ stage: 's1', status: 'PASS', decisionStatus: 'VALID', selected: 'READ_X', reason: 'porque', receipt: { receiptId: 'rcpt_1', model: 'm', totalTokens: 10 } }], reads: { READ_X: { source: 'DB.t', columns: ['a'], rows: 1 } } },
    probes: { mode: 'ALL_AFFORDABLE', selected: ['r1'], skipped: [], error: null },
    critic: { status: 'EVALUATED', eligible: 2, summary: { confirmed: 1, degraded: 0 } },
  },
});
const tmp = (name: string) => { const d = path.join(ROOT, '.concordia', 'test-agent-report', name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (dir: string, run: any, extra?: Record<string, unknown>) => { const d = path.join(dir, run.runId); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'engine-run.json'), JSON.stringify(run)); for (const [k, v] of Object.entries(extra ?? {})) fs.writeFileSync(path.join(d, k), JSON.stringify(v)); return d; };

test('report without optional fields says not available and labels mode and denominators', () => {
  const dir = tmp('plain'), run = base(); put(dir, run);
  const { files } = writeAgentRunReport('syn-01', dir);
  assert.deepEqual(files, ['report.md', 'report.html']);
  const md = fs.readFileSync(path.join(dir, 'syn-01', 'report.md'), 'utf8'), html = fs.readFileSync(path.join(dir, 'syn-01', 'report.html'), 'utf8');
  assert.match(md, /\*\*SYNTHETIC\*\*/); assert.match(html, /class="badge SYNTHETIC"/);
  assert.match(md, /4 de 25/); assert.match(md, /1 de 2 elegibles/);
  assert.match(md, /Post-COMA: no disponible en este run/); assert.match(md, /Artifacts: no disponible en este run/); assert.match(md, /Modo de seleccion\*\*: no disponible en este run/); assert.match(md, /Ranking de sondas por modelo\*\*: no disponible en este run/);
  assert.match(md, /rcpt_1/); assert.match(md, /endpoint_evidence_missing/);
  assert.ok(!html.includes('<b>si</b>'), 'html escaped');
});

test('report with postComa, probeSelection and artifacts shows them', () => {
  const dir = tmp('full'), run = { ...base(), runId: 'syn-02', artifactsFile: 'C:\\x\\y\\artifacts.json', postComa: { outOfScope: 1, suggestedProbe: { relationId: 'r9', status: 'SUGGESTED' } }, probeSelection: { mode: 'MODEL_CHOOSER', modelRanking: 'USED' } };
  put(dir, run, { 'artifacts.json': { fichas: [1, 2], dossier: { a: 1 } } });
  writeAgentRunReport('syn-02', dir);
  const md = fs.readFileSync(path.join(dir, 'syn-02', 'report.md'), 'utf8');
  assert.match(md, /MODEL_CHOOSER/); assert.match(md, /Ranking de sondas por modelo\*\*: usado/); assert.match(md, /SUGGESTED/); assert.match(md, /fichas \| 2 elementos/);
  assert.ok(!/[A-Za-z]:\\/.test(md), 'no absolute paths');
});

test('report rejects bad run ids and missing runs; real run copy renders', () => {
  const dir = tmp('errs');
  assert.throws(() => writeAgentRunReport('../x', dir), /AGENT_REPORT_RUN_ID_INVALID/);
  assert.throws(() => writeAgentRunReport('nope', dir), /AGENT_REPORT_ENGINE_RUN_NOT_FOUND/);
  const real = path.join(ROOT, '.concordia', 'agent-runs', 'agent-u2-gen-live-01', 'engine-run.json');
  if (!fs.existsSync(real)) return;
  const d = path.join(dir, 'agent-u2-gen-live-01'); fs.mkdirSync(d); fs.copyFileSync(real, path.join(d, 'engine-run.json'));
  writeAgentRunReport('agent-u2-gen-live-01', dir);
  const md = fs.readFileSync(path.join(d, 'report.md'), 'utf8');
  assert.match(md, /\*\*LIVE\*\*/); assert.match(md, /10 de 25/);
});

test('a default run says the model probe ranking was not used (budget)', () => {
  const dir = tmp('norank'), run = { ...base(), runId: 'syn-03', probeSelection: { mode: 'ALL_AFFORDABLE', modelRanking: 'NOT_USED' } };
  put(dir, run, {});
  writeAgentRunReport('syn-03', dir);
  const md = fs.readFileSync(path.join(dir, 'syn-03', 'report.md'), 'utf8');
  assert.match(md, /ALL_AFFORDABLE/); assert.match(md, /Ranking de sondas por modelo\*\*: no usado en esta corrida \(presupuesto\)/);
});

test('3.4: memory field shows claims, conflicts and the human review queue; absent means not available', () => {
  const dir = tmp('memory');
  const none = { ...base(), runId: 'syn-m0' }; put(dir, none); writeAgentRunReport('syn-m0', dir);
  assert.match(fs.readFileSync(path.join(dir, 'syn-m0', 'report.md'), 'utf8'), /Memoria: no disponible en este run/);
  const memory = { schemaVersion: 1, status: 'RECORDED', runId: 'syn-m1', universeId: 'UX', scope: '.concordia/agent-memory/UX',
    claims: [{ id: 'c1', relationId: 'r1', attribute: 'verdict', value: 'INDETERMINADA', source: 'probe', sourceVersion: 'v1', rule: 'endpoint_evidence_missing', firstRunId: 'syn-m1', runIds: ['syn-m1', 'syn-m2'], superseded: false, supersededBy: null },
      { id: 'c0', relationId: 'r1', attribute: 'verdict', value: 'SOSTENIDA', source: 'probe', sourceVersion: 'v0', rule: 'x', firstRunId: 'syn-m0', runIds: ['syn-m0'], superseded: true, supersededBy: 'c1' }],
    conflicts: [{ id: 'k1', entity: 'r1', attribute: 'verdict', status: 'queued', version: 2, claimIds: ['c0', 'c1'], winner: null }, { id: 'k2', entity: 'r2', attribute: 'verdict', status: 'auto_resolved', version: 1, claimIds: ['c3'], winner: 'c3' }],
    reviewQueue: [{ conflictId: 'k1', entity: 'r1', attribute: 'verdict', version: 2, claimIds: ['c0', 'c1'], strategy: 'human_review' }], ledger: { entries: 5, appendOnly: true } };
  put(dir, { ...base(), runId: 'syn-m1', memory, reuse: { hits: 1 } }); writeAgentRunReport('syn-m1', dir);
  const md = fs.readFileSync(path.join(dir, 'syn-m1', 'report.md'), 'utf8');
  assert.match(md, /Claims vigentes\*\*: 1 de 2/); assert.match(md, /Conflictos en cola\*\*: 1 de 2/);
  assert.match(md, /Cola de revision humana: 1 de 2 conflictos esperan decision/);
  assert.match(md, /k1 \| r1 \| verdict \| 2 \| c0, c1 \| human_review/);
  assert.match(md, /c0 \| r1 \| verdict \| SOSTENIDA .* no \(reemplazado por c1\)/); assert.match(md, /5 entradas \(solo anexo\)/); assert.match(md, /reuse\.hits\*\*: 1/);
});
