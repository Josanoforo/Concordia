import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderAgentRunMarkdown, writeAgentRunReport } from '../src/report/agent-run-report.ts';
import { reviewOriginsOf, modelReviewOf, MODEL_REVIEW_BASIS } from '../src/report/review-origin.ts';

/** R-label (ronda 9, R-1): the model review acts on the blind candidates BEFORE the contract probes. MODEL_REVIEWED is "revisado por modelo con pase adversarial", never "validado/validada"; separate from HUMAN_REVIEWED,
 *  with the full trace and denominators. Reads phases.candidateReview, decisions[].reviewOrigin and model-review-overlay.json. */
const FORBIDDEN_MODEL = /valid[oóa]|validad[oa]s?|validaci|validat|descubr|descubiert|\bdiscover/i;
const sec = (md: string, title: string) => { const i = md.indexOf(`## ${title}`); return i < 0 ? '' : md.slice(i, md.indexOf('\n## ', i + 5) < 0 ? undefined : md.indexOf('\n## ', i + 5)); };
const title = 'Revision por modelo con pase adversarial';

const call = (model: string) => ({ status: 'PASS', requestedModel: 'cheap', tokens: 1000, receipt: { receiptId: 'rcpt_fixture_001', provider: 'anthropic', model, inputTokens: 900, outputTokens: 100, totalTokens: 1000 } });
const overlay: any = { schemaVersion: 1, kind: 'MODEL_REVIEW_OVERLAY', origin: 'MODEL_REVIEW', label: MODEL_REVIEW_BASIS, provenance: 'LIVE_MODEL',
  counts: { candidates: 5, reviewed: 2, approved: 1, deferred: 1, rejected: 0, notReviewed: 3, calls: 5, tokens: 4300 },
  notApproved: [{ relationId: 'rel_m2', decision: 'defer', reasons: ['HOMONYM_RISK'], reviewed: true }, { relationId: 'rel_n', decision: 'defer', reasons: ['NO_EVIDENCE'], reviewed: false }],
  reviews: [
    { relationId: 'rel_m1', decision: 'accept', confidence: 'high', reasons: ['KEY_MEMBERSHIP_COMPLETE'], adversarialPass: 'COMPLETED', attacksSurvived: [{}, {}], attacksSustained: [], tokens: 2500, calls: 3,
      evaluations: [{ judgeId: 'judge-a', status: 'VALID', decision: 'accept', confidence: 'high', reasonCodes: ['KEY_MEMBERSHIP_COMPLETE', 'TARGET_UNIQUE_IN_SAMPLE'], promptHash: 'a'.repeat(64), tokens: 1000, call: call('claude-judge') }],
      adversary: { status: 'COMPLETED', promptHash: 'c'.repeat(64), attacks: [{ family: 'HOMONYM', severity: 'none', recommend: 'keep', outcome: 'NO_ATTACK', tokens: 750 }, { family: 'INSUFFICIENT_KEYS', severity: 'minor', recommend: 'keep', outcome: 'SURVIVED', tokens: 750 }] } },
    { relationId: 'rel_m2', decision: 'defer', confidence: 'medium', reasons: ['HOMONYM_RISK'], adversarialPass: 'COMPLETED', attacksSurvived: [], attacksSustained: [{}], tokens: 1800, calls: 2,
      evaluations: [{ judgeId: 'judge-a', status: 'VALID', decision: 'accept', confidence: 'medium', reasonCodes: ['HOMONYM_RISK'], promptHash: 'b'.repeat(64), tokens: 900, call: call('claude-judge') }],
      adversary: { status: 'COMPLETED', promptHash: 'd'.repeat(64), attacks: [{ family: 'HOMONYM', severity: 'blocking', recommend: 'defer', outcome: 'SUSTAINED', tokens: 900 }] } }] };
const section: any = { status: 'APPLIED', mode: 'MODEL_ADVERSARIAL', applied: ['rel_m1'], approved: ['rel_m1'], notApproved: overlay.notApproved, counts: overlay.counts, label: MODEL_REVIEW_BASIS, provenance: 'LIVE_MODEL',
  overlayFile: 'model-review-overlay.json', overlaySha256: 'f'.repeat(64), estimate: { queries: 6 } };
const run: any = { runId: 'agent-r9', universeId: 'U', executionMode: 'LIVE', dataOrigin: 'PUBLIC', status: 'COMPLETED', modelParticipation: 'USED', phases: { exploration: { calls: [{ decisionStatus: 'VALID' }] }, candidateReview: section },
  decisions: [{ relationId: 'rel_h', verdict: 'SOSTENIDA', reasonCodes: [], reviewOrigin: 'HUMAN_REVIEWED' }, { relationId: 'rel_m1', verdict: 'SOSTENIDA', reasonCodes: [], reviewOrigin: 'MODEL_REVIEWED' }, { relationId: 'rel_x', verdict: 'INDETERMINADA', reasonCodes: [] }] };

test('origins come from the seal decisions[].reviewOrigin, counted separately with denominators; each origin has its own section', () => {
  assert.deepEqual(reviewOriginsOf(run).counts, { HUMAN_REVIEWED: 1, MODEL_REVIEWED: 1, BOTH: 0, NONE: 1 }); assert.equal(reviewOriginsOf(run).total, 3);
  const md = renderAgentRunMarkdown(run, undefined, { modelReviewOverlay: overlay }), origin = sec(md, 'Origen de la revision');
  assert.match(origin, /\| HUMAN_REVIEWED \| 1 de 3 \|/); assert.match(origin, /\| MODEL_REVIEWED \| 1 de 3 \|/); assert.match(origin, /\| sin revision registrada \| 1 de 3 \|/);
  assert.match(origin, /la revision del modelo nunca ocupa un lugar que exige revision humana/); assert.ok(sec(md, title).length > 0, 'its own section');
  assert.ok(!renderAgentRunMarkdown({ ...run, phases: { exploration: run.phases.exploration }, decisions: run.decisions.map((d: any) => ({ ...d, reviewOrigin: undefined })) }).includes('Origen de la revision'), 'no seal, no section');
  const both = reviewOriginsOf({ decisions: [{ relationId: 'r', verdict: 'SOSTENIDA', reviewOrigin: 'MODEL_REVIEWED' }] }, { probes: [{ relationId: 'r', evidence: { relationContract: { reviewOrigin: 'HUMAN_REVIEWED' } } }] });
  assert.deepEqual(both.counts, { HUMAN_REVIEWED: 0, MODEL_REVIEWED: 0, BOTH: 1, NONE: 0 });
});

test('the model section labels the review and shows every evaluation, every attack with its outcome, the models and the tokens', () => {
  const s = sec(renderAgentRunMarkdown(run, undefined, { modelReviewOverlay: overlay }), title);
  assert.match(s, /Revisado por modelo con pase adversarial \(origen MODEL_REVIEWED\)\./); assert.match(s, /Actua antes de las sondas de contrato y no cambia ningun veredicto/); assert.match(s, /No es revision humana ni sustituye la aprobacion de una persona/);
  assert.match(s, /\*\*Estado de la etapa\*\*: APPLIED/); assert.match(s, /\*\*Modo de revision requerido\*\*: MODEL_ADVERSARIAL/); assert.match(s, /\*\*Procedencia\*\*: LIVE_MODEL/);
  assert.match(s, /\*\*Candidatas revisadas\*\*: 2 de 5/); assert.match(s, /\*\*Aprobadas\*\*: 1 de 5/); assert.match(s, /\*\*Aplazadas\*\*: 1 de 5/); assert.match(s, /\*\*Rechazadas\*\*: 0 de 5/); assert.match(s, /\*\*Sin revisar\*\*: 3 de 5/);
  assert.match(s, /\*\*Aplicadas como contrato de modelo\*\*: 1 de 1/); assert.match(s, /\*\*Evaluaciones de jueces\*\*: 2/); assert.match(s, /\*\*Ataques adversariales\*\*: 3 \(NO_ATTACK 1 de 3; SURVIVED 1 de 3; SUSTAINED 1 de 3\)/);
  assert.match(s, /\*\*Llamadas al modelo\*\*: 5/); assert.match(s, /\*\*Tokens de la revision\*\*: 4300/); assert.match(s, /model-review-overlay\.json \(sha256 ffffffffffff\)/); assert.match(s, /\{"queries":6\}/);
  assert.match(s, /\| rel_m1 \| accept \| high \| COMPLETED \| 2 \| 0 \| KEY_MEMBERSHIP_COMPLETE \| 2500 \|/); assert.match(s, /\| rel_m2 \| defer \| medium \| COMPLETED \| 0 \| 1 \| HOMONYM_RISK \| 1800 \|/);
  assert.match(s, /\| rel_m1 \| judge-a \| VALID \| accept \| high \| KEY_MEMBERSHIP_COMPLETE, TARGET_UNIQUE_IN_SAMPLE \| cheap \/ claude-judge \| aaaaaaaaaaaa \| 1000 \|/);
  assert.match(s, /\| rel_m2 \| HOMONYM \| blocking \| defer \| SUSTAINED \| 900 \|/); assert.match(s, /\| rel_n \| defer \| no \| NO_EVIDENCE \|/);
  assert.ok(!FORBIDDEN_MODEL.test(s), `the model section says validated/discovered: ${s.match(FORBIDDEN_MODEL)?.[0]}`);
  assert.ok(!FORBIDDEN_MODEL.test(sec(renderAgentRunMarkdown(run, undefined, { modelReviewOverlay: overlay }), 'Origen de la revision')), 'origin section');
});

test('the honesty check rejects "validada/validado" for MODEL_REVIEWED (not vacuous)', () => {
  for (const bad of ['La relacion fue validada por el modelo', 'relacion validado', 'validated by the model', 'el modelo descubrio la relacion']) assert.ok(FORBIDDEN_MODEL.test(bad), bad);
  assert.ok(!FORBIDDEN_MODEL.test(MODEL_REVIEW_BASIS));
});

test('STAND_IN_OFFLINE is flagged, a missing adversarial pass is not labelled adversarial, BOTH mode and a missing reviewer say why', () => {
  const standIn = sec(renderAgentRunMarkdown({ ...run, phases: { ...run.phases, candidateReview: { ...section, provenance: 'STAND_IN_OFFLINE' } } }, undefined, { modelReviewOverlay: { ...overlay, provenance: 'STAND_IN_OFFLINE' } }), title);
  assert.match(standIn, /Procedencia STAND_IN_OFFLINE: las respuestas vienen de un guion offline, no de un modelo; no cuenta como revision de modelo en un run LIVE/);
  const noAdv = sec(renderAgentRunMarkdown({ ...run, phases: { ...run.phases, candidateReview: { ...section, label: 'revisado por modelo (sin pase adversarial)' } } }, undefined, { modelReviewOverlay: overlay }), title);
  assert.match(noAdv, /Revisado por modelo \(sin pase adversarial\) \(origen MODEL_REVIEWED\)\. Los jueces evaluan cada candidata ciega; el pase adversarial no se completo/);
  const both = sec(renderAgentRunMarkdown({ ...run, phases: { ...run.phases, candidateReview: { ...section, status: 'RECORDED_NOT_APPLIED', reason: 'BOTH_REQUIRES_HUMAN_CONTRACT', applied: [] } } }, undefined, { modelReviewOverlay: overlay }), title);
  assert.match(both, /RECORDED_NOT_APPLIED \(modo BOTH: el contrato de modelo se registra pero no se aplica, porque exige ademas el contrato humano\)/); assert.match(both, /\*\*Aplicadas como contrato de modelo\*\*: 0 de 1/);
  const none = sec(renderAgentRunMarkdown({ ...run, phases: { ...run.phases, candidateReview: { status: 'SKIPPED_NO_REVIEWER', mode: 'MODEL_ADVERSARIAL', applied: [] } } }), title);
  assert.match(none, /\*\*Estado de la etapa\*\*: SKIPPED_NO_REVIEWER/); assert.match(none, /\*\*Evaluaciones de jueces\*\*: 0/); assert.equal(modelReviewOf({}), undefined);
});

test('X7 full-evidence measurements and the P1 probe pre-estimate render when present and are absent otherwise', () => {
  const probes = [{ relationId: 'rel_m1', evidence: { fullEvidence: { matchedRows: 980, totalRows: 1000, distinctKeys: 1000, duplicateKeys: 0 } } }, { relationId: 'rel_x', evidence: {} }];
  const fe = sec(renderAgentRunMarkdown(run, { probes }), 'Evidencia completa (medicion global)');
  assert.match(fe, /1 de 2 relaciones/); assert.match(fe, /\| rel_m1 \| matchedRows: 980; totalRows: 1000; distinctKeys: 1000; duplicateKeys: 0 \|/);
  assert.ok(!renderAgentRunMarkdown(run, { probes: [{ relationId: 'rel_x', evidence: {} }] }).includes('Evidencia completa (medicion global)'));
  const pc = { status: 'EXECUTED', policy: { maxProbes: 30, ranking: 'x', costPerProbe: 1, equality: 'y' }, counts: { proposals: 1, executed: 0 }, proposals: [], preEstimate: { candidates: 120, estimatedQueries: 120, budgetAvailable: 80, action: 'WARN_ONLY' } };
  const pe = renderAgentRunMarkdown({ ...run, postComa: pc });
  assert.match(pe, /Pre-estimacion del presupuesto de sondas/); assert.match(pe, /\*\*estimatedQueries\*\*: 120/); assert.match(pe, /\*\*action\*\*: WARN_ONLY/);
  assert.ok(!renderAgentRunMarkdown({ ...run, postComa: { ...pc, preEstimate: undefined } }).includes('Pre-estimacion'));
});

test('writeAgentRunReport loads model-review-overlay.json from the run folder; the dossier and the ODCS export carry the origin counts and the label without the forbidden verbs', async () => {
  const { exportNegativeDossier } = await import('../src/export/negative-dossier.ts'), { exportOdcs } = await import('../src/export/odcs.ts');
  const { agentFixtures } = await import('../src/eval/agent-eval.ts'), { fixtureClient } = await import('../src/eval/fixture-client.ts'), { runAgent } = await import('../src/agent/engine.ts'), { universeConfig } = await import('../src/universe-pipeline.ts');
  class Script { async choose(stage: string, _o: unknown, allowed: readonly string[]) { return { stage, status: 'PASS', decisionStatus: 'VALID', requestedModel: 's', selected: allowed.includes('READ_ROUTE_REFERENCE') ? 'READ_ROUTE_REFERENCE' : 'STOP_EXPLORATION', reason: 's', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' }; } }
  const fixture = agentFixtures().find(item => item.alias === 'GTFSAGENT')!, runs = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'));
  try {
    const report: any = await runAgent('GTFSAGENT', 'agent-ro-1', { client: fixtureClient(universeConfig('GTFSAGENT'), fixture.tables) as any, chooser: new Script() as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false } as any);
    const dir = path.join(runs, report.runId); fs.mkdirSync(dir, { recursive: true });
    const sealed = { ...report, decisions: report.decisions.map((d: any, i: number) => i === 0 ? { ...d, reviewOrigin: 'MODEL_REVIEWED' } : d), phases: { ...report.phases, candidateReview: section } };
    fs.writeFileSync(path.join(dir, 'engine-run.json'), JSON.stringify(sealed));
    fs.writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify({ schemaVersion: 1, runId: report.runId, universeId: report.universeId, probes: JSON.parse(JSON.stringify(report.artifacts.probes)).map((p: any) => { if (p.evidence?.relationContract) delete p.evidence.relationContract.reviewOrigin; return p; }) }));
    fs.writeFileSync(path.join(dir, 'model-review-overlay.json'), JSON.stringify(overlay));
    writeAgentRunReport(report.runId, runs);
    const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
    assert.match(sec(md, title), /\| rel_m1 \| judge-a \| VALID \| accept/); assert.match(sec(md, 'Origen de la revision'), /\| MODEL_REVIEWED \| 1 de 1 \|/);
    exportNegativeDossier({ runId: report.runId, runsDir: runs });
    const lines = fs.readFileSync(path.join(dir, 'negative-dossier.md'), 'utf8').split('\n').filter(l => /^- (Origen de la revision|MODEL_REVIEWED)/.test(l));
    assert.equal(lines.length, 2); assert.match(lines[0]!, /MODEL_REVIEWED 1 de 1/);
    assert.match(lines[1]!, /revisado por modelo con pase adversarial \(2 relaciones, 2 evaluaciones, 3 ataques, 4300 tokens\); no es revision humana/); assert.ok(!FORBIDDEN_MODEL.test(lines.join('\n')));
    const out = exportOdcs({ runId: report.runId, out: path.join(runs, 'm.yaml') }, { runsDir: runs });
    assert.ok(out.relations >= 0);
    const yaml = fs.readFileSync(path.join(runs, 'm.yaml'), 'utf8');
    assert.match(yaml, /concordiaModelReview/); assert.match(yaml, /revisado por modelo con pase adversarial/); assert.match(yaml, /reviewedByHuman: false/); assert.match(yaml, /provenance: "LIVE_MODEL"/); assert.match(yaml, /concordiaReviewOrigins/);
    assert.ok(!FORBIDDEN_MODEL.test(yaml.split('\n').filter(l => /concordiaModelReview|basis|reviewedByHuman/.test(l)).join('\n')));
  } finally { fs.rmSync(runs, { recursive: true, force: true }); }
});

test('P6: reordering decisions[], probes.selected and the stored probes gives the same report, dossier, N-run table and ODCS', async () => {
  const { exportOdcs } = await import('../src/export/odcs.ts'), { buildNegativeDossier, renderNegativeDossierMarkdown } = await import('../src/export/negative-dossier.ts'), { renderAgentRunsComparisonMarkdown } = await import('../src/report/agent-run-multi-compare.ts');
  const { agentFixtures } = await import('../src/eval/agent-eval.ts'), { fixtureClient } = await import('../src/eval/fixture-client.ts'), { runAgent } = await import('../src/agent/engine.ts'), { universeConfig } = await import('../src/universe-pipeline.ts');
  const reorder = (r: any) => ({ ...r, decisions: [...r.decisions].reverse(), phases: { ...r.phases, probes: { ...(r.phases?.probes ?? {}), selected: [...(r.phases?.probes?.selected ?? [])].reverse() } } });
  const base = { ...run, phases: { ...run.phases, probes: { selected: ['rel_h', 'rel_m1', 'rel_x'], skipped: [] } } };
  const arts = { probes: ['rel_x', 'rel_h', 'rel_m1'].map(id => ({ relationId: id, from: { db: 'D', table: 't_' + id, column: 'x' }, to: { db: 'D', table: 'u_' + id, column: 'y' }, evidence: {} })) };
  const shuffled = { probes: [...arts.probes].reverse() };
  assert.equal(renderAgentRunMarkdown(base, arts, { modelReviewOverlay: overlay }), renderAgentRunMarkdown(reorder(base), shuffled, { modelReviewOverlay: overlay }), 'report');
  assert.equal(renderNegativeDossierMarkdown(buildNegativeDossier({ run: base, artifacts: arts })), renderNegativeDossierMarkdown(buildNegativeDossier({ run: reorder(base), artifacts: shuffled })), 'dossier');
  assert.equal(renderAgentRunsComparisonMarkdown([{ run: base, artifacts: arts }, { run: { ...base, runId: 'b' }, artifacts: arts }]), renderAgentRunsComparisonMarkdown([{ run: reorder(base), artifacts: shuffled }, { run: reorder({ ...base, runId: 'b' }), artifacts: shuffled }]), 'N-run table');
  class Script { async choose(stage: string, _o: unknown, allowed: readonly string[]) { return { stage, status: 'PASS', decisionStatus: 'VALID', requestedModel: 's', selected: allowed.includes('READ_ROUTE_REFERENCE') ? 'READ_ROUTE_REFERENCE' : 'STOP_EXPLORATION', reason: 's', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' }; } }
  const fixture = agentFixtures().find(item => item.alias === 'GTFSAGENT')!, runs = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-'));
  try {
    const report: any = await runAgent('GTFSAGENT', 'agent-ord-1', { client: fixtureClient(universeConfig('GTFSAGENT'), fixture.tables) as any, chooser: new Script() as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false } as any);
    const probes = report.artifacts.probes.map((p: any) => ({ ...p, evidence: { ...p.evidence, reviewAuthorization: { approver: 'a', approvedAt: '2026-10-25', quote: 'q', session: 's' } } }));
    const write = (id: string, r: any, ps: any[]) => { const d = path.join(runs, id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'engine-run.json'), JSON.stringify({ ...r, runId: id })); fs.writeFileSync(path.join(d, 'artifacts.json'), JSON.stringify({ schemaVersion: 1, runId: id, universeId: r.universeId, probes: ps })); };
    write('agent-ord-a', { ...report }, probes); write('agent-ord-b', reorder({ ...report }), [...probes].reverse());
    exportOdcs({ runId: 'agent-ord-a', out: path.join(runs, 'a.yaml') }, { runsDir: runs }); exportOdcs({ runId: 'agent-ord-b', out: path.join(runs, 'b.yaml') }, { runsDir: runs });
    const norm = (f: string) => fs.readFileSync(path.join(runs, f), 'utf8').split('agent-ord-a').join('R').split('agent-ord-b').join('R');
    assert.equal(norm('a.yaml'), norm('b.yaml'), 'ODCS');
  } finally { fs.rmSync(runs, { recursive: true, force: true }); }
});

test('E5-07 and E1-01: a model table per role (real id, calls, INVALID, truncated, tokens) and a degraded review is not read as clean', () => {
  const run: any = { runId: 'agent-r10', universeId: 'U', executionMode: 'LIVE', dataOrigin: 'PUBLIC', status: 'DEGRADED', phases: { candidateReview: { status: 'PARTIAL', mode: 'MODEL_ADVERSARIAL' } },
    degradations: [{ phase: 'candidateReview', code: 'MODEL_REVIEW_CALLS_INVALID', detail: 'x', counts: { invalid: 1, calls: 3 } }], decisions: [] };
  const call = (model: string) => ({ requestedModel: 'req-model', receipt: { model } });
  const overlay = { counts: { candidates: 2, reviewed: 2 }, reviews: [
    { relationId: 'r1', decision: 'accept', evaluations: [{ judgeId: 'judge-a', status: 'VALID', call: call('real-a'), tokens: 100 }, { judgeId: 'judge-b', status: 'INVALID', call: call('real-b'), tokens: 50, truncated: true }], adversary: { status: 'VALID', call: call('real-adv'), tokens: 70, attacks: [] } },
    { relationId: 'r2', decision: 'defer', evaluations: [{ judgeId: 'judge-a', status: 'VALID', call: call('real-a'), tokens: 40 }, { judgeId: 'judge-b', status: 'VALID', call: call('real-b'), tokens: 30, truncated: false }] }] };
  const md = renderAgentRunMarkdown(run, undefined, { modelReviewOverlay: overlay });
  assert.match(md, /\| judge-a \| req-model \| real-a \| 2 \| 0 de 2 \| no disponible en este run \| 140 \|/);
  assert.match(md, /\| judge-b \| req-model \| real-b \| 2 \| 1 de 2 \| 1 de 2 \| 80 \|/);
  assert.match(md, /\| adversary \| req-model \| real-adv \| 1 \| 0 de 1 \| no disponible en este run \| 70 \|/);
  assert.match(md, /ATENCION: la revision por modelo de este run quedo degradada \(MODEL_REVIEW_CALLS_INVALID \[invalid: 1, calls: 3\]\)\. Este run no se lee como limpio/);
});

test('X5 health and consistency fields: counts with denominators, OFF stated, every demoted edge with rule and winner', () => {
  const base: any = { runId: 'agent-h', universeId: 'U', executionMode: 'LIVE', dataOrigin: 'PUBLIC', status: 'DEGRADED', decisions: [], degradations: [{ phase: 'candidateReview', code: 'MODEL_REVIEW_PARTIAL_BUDGET', detail: 'x' }] };
  const health = { calls: 10, invalidCalls: 2, truncatedCalls: 1, skippedBudgetCalls: 3, invalidCallShare: 0.2, adversary: { attempted: 4, incomplete: 1 }, thresholds: { maxInvalidCallShare: 0.25 }, codes: ['MODEL_REVIEW_PARTIAL_BUDGET'] };
  const md = renderAgentRunMarkdown({ ...base, phases: { candidateReview: { status: 'PARTIAL', mode: 'MODEL_ADVERSARIAL', health, consistency: { status: 'ENFORCED', kept: ['a', 'b'], demoted: [{ id: 'c', rule: 'FK_ONCE', winner: 'a', reason: 'same source column' }], unresolved: [] } } } });
  assert.match(md, /llamadas 10; INVALID 2 de 10; truncadas 1 de 10; omitidas por presupuesto 3 de 10; proporcion INVALID 0\.2 \(maximo 0\.25\); adversario incompleto 1 de 4/);
  assert.match(md, /MODEL_REVIEW_PARTIAL_BUDGET \[calls: 10, invalidCalls: 2, truncatedCalls: 1, skippedBudgetCalls: 3\]/);
  assert.match(md, /1 de 3 aristas degradadas a sin contrato, 2 conservadas, 0 sin resolver/); assert.match(md, /\| c \| FK_ONCE \| a \| same source column \|/);
  assert.match(renderAgentRunMarkdown({ ...base, phases: { candidateReview: { status: 'COMPLETED', consistency: { status: 'OFF' } } } }), /consistencia: OFF/);
});

test('N74 memory batch: admitted/quarantined with denominators; quarantined items are a review queue, never claims', () => {
  const run: any = { runId: 'agent-m', universeId: 'U', executionMode: 'LIVE', dataOrigin: 'PUBLIC', status: 'FAILED', decisions: [], memory: { status: 'FAILED', scope: 's', claims: [{ id: 'c1', relationId: 'r1' }], conflicts: [], error: { code: 'MEMORY_BATCH_UNHEALTHY' },
    batch: { total: 10, admitted: 6, rejected: 4, rejectedShare: 0.4, threshold: { minRejected: 3, maxRejectedShare: 0.3 }, unhealthy: true, written: 0, reasons: [{ relationId: 'r9', code: 'ORIGIN_MISSING', reason: 'sin origen' }],
    },
    reviewQueue: [{ kind: 'QUARANTINED_CLAIM', relationId: 'r9', entity: 'e', code: 'ORIGIN_MISSING', reason: 'sin origen', runId: 'agent-m' }] } };
  const md = renderAgentRunMarkdown(run);
  assert.match(md, /memoria: admitidos 6 de 10, en cuarentena 4 de 10 \(razones: ORIGIN_MISSING\); proporcion rechazada 0\.4 \(maximo 0\.3, minimo de rechazados 3\); escritos 0 de 10\. El lote esta NO SANO/);
  assert.match(md, /1 claims en cuarentena esperan revision\. Nunca son claims de la memoria\./); assert.match(md, /\| r9 \| e \| ORIGIN_MISSING \| sin origen \| agent-m \|/);
  assert.ok(!/Conflictos? .*r9/.test(md.split('\n').filter(l => /Conflicto \|/.test(l)).join('\n')), 'not listed as a conflict');
});

test('exploration read failures are listed with step, action and code; nothing is shown when there are none', () => {
  const run: any = { runId: 'agent-e', universeId: 'U', executionMode: 'LIVE', dataOrigin: 'PUBLIC', status: 'DEGRADED', decisions: [], phases: { exploration: { explorationErrors: [{ step: 2, action: 'READ_ROUTE_REFERENCE', code: 'READ_TIMEOUT', message: 'timeout' }] } } };
  const md = renderAgentRunMarkdown(run);
  assert.match(md, /lecturas fallidas: 1\./); assert.match(md, /\| 2 \| READ_ROUTE_REFERENCE \| READ_TIMEOUT \| timeout \|/);
  assert.ok(!/lecturas fallidas/i.test(renderAgentRunMarkdown({ ...run, phases: { exploration: { explorationErrors: [] } } })));
});

test('resume and the M12 global-distinct pool are rendered with counts', () => {
  const prop = (t: string, src?: string) => ({ proposalId: t, to: { table: t, column: 'k' }, coverageProbe: { status: 'EXECUTED', ...(src ? { sampling: { source: src } } : {}) } });
  const run: any = { runId: 'agent-p', universeId: 'U', executionMode: 'LIVE', dataOrigin: 'PUBLIC', status: 'COMPLETED', decisions: [], resume: { resumedFrom: 'j', resumedProbes: 7, newProbes: 3, interruptions: 2, journalFound: true, limits: 'x' },
    postComa: { sourcePool: { queries: 4, hits: 3, failures: 1 }, proposals: [prop('a', 'GLOBAL_DISTINCT_F4'), prop('a', 'GLOBAL_DISTINCT_F4'), prop('b', 'GLOBAL_DISTINCT_F4'), prop('c')] } };
  const md = renderAgentRunMarkdown(run);
  assert.match(md, /reanudada tras 2 interrupciones: 7 sondas reusadas, 3 nuevas\. Limite declarado: solo se reanuda el post-COMA/);
  assert.match(md, /muestra ampliada con claves distintas globales en 2 columnas \(4 SQL\); 3 de 4 sondas ejecutadas usan esa muestra; aciertos 3, fallos 1\./);
});

test('E3-03 orphans in two semantics, tie-break vector (centrality is information only), key basis and the redacted approver in the report', () => {
  const fe = (cov: any) => ({ relationId: 'rel_o', evidence: { fullEvidence: { coverage: cov } } });
  const md = renderAgentRunMarkdown(run, { probes: [fe({ status: 'MEASURED', sourceDistinct: 100, missing: 4, ratio: 0.96, complete: false, rows: { sourceNonNullRows: 1000, sourceNulls: 5, missingRows: 37, ratio: 0.963, measuredBy: 'F3C' } }), { ...fe({ status: 'MEASURED', sourceDistinct: 50, missing: 0, ratio: 1, complete: true, rows: { sourceNonNullRows: 80, sourceNulls: 0, missingRows: 0, ratio: 1, measuredBy: 'DERIVED_FROM_F3B_ZERO' } }), relationId: 'rel_p' }, { ...fe({ status: 'NOT_MEASURED', reason: 'QUERY_FAILED' }), relationId: 'rel_q' }] });
  assert.match(md, /rel_o: huerfanos: 4 de 100 claves distintas; 37 de 1000 filas \(mas 5 filas con clave NULL, no huerfanas\)/);
  assert.match(md, /rel_p: huerfanos: 0 de 50 claves distintas; 0 de 80 filas/); assert.match(md, /rel_q: huerfanos: no disponible en este run/);
  const tie = (decisive: boolean) => ({ relationId: 'r1', decision: 'accept', tieBreak: { group: ['r1', 'r2'], ordered: ['r1', 'r2'], decisive, winner: 'r1', reason: decisive ? 'DECIDED_BY_NAME_VS_TABLE' : 'NOT_DECISIVE', ...(decisive ? { decidedBy: 'NAME_VS_TABLE', values: { winner: '1', runnerUp: '0' } } : { tied: ['r1', 'r2'] }), vectors: { r1: { targetCentrality: 7 } } } });
  const base: any = { runId: 'agent-t', universeId: 'U', executionMode: 'LIVE', dataOrigin: 'PUBLIC', status: 'COMPLETED', decisions: [], phases: { candidateReview: { status: 'COMPLETED', mode: 'MODEL_ADVERSARIAL' } } };
  const dec = renderAgentRunMarkdown(base, undefined, { modelReviewOverlay: { reviews: [tie(true)] } });
  assert.match(dec, /1 de 1 grupos de empate se resuelven/); assert.match(dec, /\| r1 \| 2 \| r1 > r2 \| decisivo, gana r1 \| NAME_VS_TABLE: 1 contra 0 \| 7 \|/);
  assert.match(renderAgentRunMarkdown(base, undefined, { modelReviewOverlay: { reviews: [tie(false)] } }), /no decisivo \(empatadas: r1, r2\)/);
  const hcRun: any = { ...base, reviewOverlay: { origin: 'HUMAN_REVIEW', sha256: 'a'.repeat(64), approval: { approver: 'Nombre Persona', approvedAt: '2026-10-25', quote: 'ok', session: 's', package: 'p.md' }, deferred: [] } };
  const hcMd = renderAgentRunMarkdown(hcRun); assert.ok(!hcMd.includes('Nombre Persona'), 'approver name not in the report'); assert.match(hcMd, /project-owner/);
  const diag = (b?: string) => ({ coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH' }, multiplicity: { from: { maxRowsPerKey: 1, ...(b ? { fromBasis: b } : {}) }, to: { maxRowsPerKey: 1 } } } } });
  assert.match(renderAgentRunMarkdown({ ...base, postComa: { proposals: [diag('GLOBAL_DISTINCT_F4')] } }), /claves base: claves distintas globales \(F4\)/);
  assert.match(renderAgentRunMarkdown({ ...base, postComa: { proposals: [diag('DISCOVERY_SAMPLE')] } }), /claves base: muestra de descubrimiento/);
  assert.ok(!/claves base/.test(renderAgentRunMarkdown({ ...base, postComa: { proposals: [diag()] } })));
});
