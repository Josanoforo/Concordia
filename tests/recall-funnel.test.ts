import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FUNNEL_STAGES, buildRecallFunnel, loadRunForFunnel, relationIdOf, renderRecallFunnel } from '../src/eval/recall-funnel.ts';
import { loadTpcdsGold } from '../src/eval/tpcds-gold.ts';
import { ROOT } from '../src/runtime.ts';

/** E4-01: the offline recall funnel classifies every gold edge by the first stage that lost it. Evaluation only. */
const gold = loadTpcdsGold();
const ref = (item: { table: string; column: string }) => ({ db: 'TPCDS_DB', table: item.table, column: item.column });
const proposal = (edge: typeof gold.edges[number], probe: any, flip = false) => ({ proposalId: flip ? `${edge.to.table}.${edge.to.column}__${edge.from.table}.${edge.from.column}` : relationIdOf(edge), from: ref(flip ? edge.to : edge.from), to: ref(flip ? edge.from : edge.to), coverageProbe: probe });
const executed = (level: string, suspect?: string[]) => ({ status: 'EXECUTED', diagnostic: { coverage: { level }, suspect: { value: !!suspect, reasons: suspect ?? [] } } });

test('every stage is reachable and the first stage that stops an edge wins', () => {
  const [e0, e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, e11] = gold.edges;
  const report: any = {
    runId: 'synthetic', universeId: 'TPCDS', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC',
    postComa: { proposals: [
      proposal(e1, undefined, true),
      proposal(e2, { status: 'SUGGESTED', reason: 'NOT_SELECTED_MAX_PROBES' }),
      proposal(e3, { status: 'NOT_EXECUTABLE', reason: 'NO_SAFE_SAMPLED_VALUES' }),
      proposal(e4, executed('LOW')),
      proposal(e5, executed('HIGH', ['TARGET_NOT_UNIQUE'])),
      proposal(e6, executed('HIGH')), proposal(e7, executed('HIGH')), proposal(e8, executed('HIGH')),
      proposal(e9, executed('HIGH')), proposal(e10, executed('HIGH')), proposal(e11, executed('HIGH'))
    ] },
    phases: { candidateReview: { status: 'APPLIED', approved: [relationIdOf(e9), relationIdOf(e10), relationIdOf(e11)], notApproved: [
      { relationId: relationIdOf(e6), decision: 'defer', reasons: ['SKIPPED_BUDGET'], reviewed: true },
      { relationId: relationIdOf(e7), decision: 'defer', reasons: ['HOMONYM_RISK'], reviewed: true },
      { relationId: relationIdOf(e8), decision: 'reject', reasons: ['NAME_ENTITY_MISMATCH'], reviewed: true }] } },
    decisions: [{ relationId: relationIdOf(e9), verdict: 'SOSTENIDA', reasonCodes: ['REUSED_FROM_MEMORY'] }, { relationId: relationIdOf(e10), verdict: 'INDETERMINADA', reasonCodes: ['x'] }, { relationId: relationIdOf(e11), verdict: 'ENGAÑOSA', reasonCodes: [] }]
  };
  const funnel = buildRecallFunnel({ report, gold });
  const stageOf = (edge: typeof e0) => funnel.edges.find(item => item.id === edge.id)!;
  assert.equal(stageOf(e0).stage, 'NOT_PROPOSED_BY_COMA');
  assert.deepEqual([stageOf(e1).stage, stageOf(e2).stage, stageOf(e3).stage, stageOf(e4).stage], ['REVERSED', 'NOT_PROBED_BUDGET', 'NOT_EXECUTABLE', 'COVERAGE_NOT_HIGH']);
  assert.deepEqual([stageOf(e5).stage, stageOf(e5).detail], ['FLAGGED', 'TARGET_NOT_UNIQUE']);
  assert.deepEqual([stageOf(e6).stage, stageOf(e7).stage, stageOf(e8).stage], ['NOT_REVIEWED_BUDGET', 'REVIEW_DEFER', 'REVIEW_REJECT']);
  assert.deepEqual([stageOf(e9).stage, stageOf(e9).detail, stageOf(e10).stage, stageOf(e11).stage], ['SOSTENIDA', 'REUSED_FROM_MEMORY', 'PROBE_INDETERMINADA', 'PROBE_ENGANOSA']);
  assert.equal(funnel.reviewStage, 'REPORT_SECTION');
  assert.equal(funnel.edges.length, gold.edges.length);
  assert.equal(Object.values(funnel.byStage).reduce((sum, value) => sum + value, 0), gold.edges.length, 'every gold edge lands in exactly one stage');
  assert.deepEqual(Object.keys(funnel.byStage), [...FUNNEL_STAGES]);
});

test('an overlay file wins over the report section and a run without a review reports NOT_REVIEWED_NO_REVIEW', () => {
  const edge = gold.edges[0];
  const base: any = { runId: 'r', universeId: 'TPCDS', postComa: { proposals: [proposal(edge, executed('HIGH'))] }, decisions: [] };
  assert.equal(buildRecallFunnel({ report: base, gold }).edges[0].stage, 'NOT_REVIEWED_NO_REVIEW');
  const overlay = { relations: [], notApproved: [{ relationId: relationIdOf(edge), decision: 'defer', reasons: ['x'], reviewed: true }], reviews: [{ relationId: relationIdOf(edge), evaluations: [{ status: 'SKIPPED_BUDGET' }, { status: 'SKIPPED_BUDGET' }] }] };
  const funnel = buildRecallFunnel({ report: base, overlay, gold });
  assert.equal(funnel.reviewStage, 'OVERLAY_FILE');
  assert.equal(funnel.edges[0].stage, 'NOT_REVIEWED_BUDGET', 'all judge calls skipped for budget in the overlay reviews');
});

test('the funnel of the live-04 fixture adds up to the 103 gold edges, has no SOSTENIDA and renders denominators', () => {
  const run = loadRunForFunnel(path.join(ROOT, 'tests', 'fixtures', 'agent-runs', 'agent-tpcds-live-04'));
  const funnel = buildRecallFunnel({ report: run.report, ...(run.overlay ? { overlay: run.overlay } : {}) });
  assert.equal(funnel.goldEdges, 103);
  assert.equal(Object.values(funnel.byStage).reduce((sum, value) => sum + value, 0), 103);
  assert.equal(funnel.byStage.SOSTENIDA, 0);
  assert.ok(funnel.reach.proposed <= 103 && funnel.reach.probed <= funnel.reach.proposed && funnel.reach.sostenida <= funnel.reach.probed);
  assert.match(renderRecallFunnel(funnel), /\| \*\*Total\*\* \| 103 \| 100\.0% \|/);
});

test('the funnel is evaluation-only: no runtime module names it', () => {
  for (const dir of ['agent', 'probe', 'discovery', 'registry', 'relations', 'critic', 'reconcile', 'report', 'export', 'clients']) {
    const root = path.join(ROOT, 'src', dir); if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root, { recursive: true })) {
      const file = path.join(root, String(name)); if (!file.endsWith('.ts') || !fs.statSync(file).isFile()) continue;
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /recall-funnel/, path.relative(ROOT, file));
    }
  }
});
