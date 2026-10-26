import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/runtime.ts';
import { renderAgentRunMarkdown } from '../src/report/agent-run-report.ts';
import { exportOdcs } from '../src/export/odcs.ts';
import { buildNegativeDossier, renderNegativeDossierMarkdown } from '../src/export/negative-dossier.ts';
import { humanContractOf, humanContractSentence } from '../src/report/human-contract.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';

/** Act 3 condition: a SOSTENIDA that came with a human contract is labelled as such everywhere and never presented as found or confirmed by the agent. */
const FORBIDDEN = /descubr|descubiert|valid[oóa]|validaci|validad|confirm[oó]|confirmad[oa]s? por el (agente|modelo)|\bdiscover|\bvalidat/i;
const assertHonest = (text: string, where: string) => assert.ok(!FORBIDDEN.test(text), `${where} attributes the finding to the agent: ${text.match(FORBIDDEN)?.[0]}`);

class Script implements ActionChooser {
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const selected = allowed.includes('READ_ROUTE_REFERENCE') ? 'READ_ROUTE_REFERENCE' : 'STOP_EXPLORATION';
    return { stage, status: 'PASS', decisionStatus: 'VALID', requestedModel: 'scripted', selected, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const overlayAuth = { approver: 'project-owner', approvedAt: '2026-10-25', quote: 'Apruebo las 25 relaciones del paquete', session: 'pkg-act3-tpcds', overlayOrigin: 'HUMAN_REVIEW', overlaySha256: 'a'.repeat(64) };
const runOverlay = { origin: 'HUMAN_REVIEW', sha256: 'a'.repeat(64), approval: { approver: 'project-owner', approvedAt: '2026-10-25', quote: 'Apruebo las 25 relaciones del paquete', session: 'pkg-act3-tpcds' },
  relations: ['rel_a', 'rel_b'], deferred: [{ id: 'rel_d1', reason: 'M12 pendiente' }, { id: 'rel_d2', reason: 'M12 pendiente' }, { id: 'rel_d3', reason: 'M12 pendiente' }], negativeControl: { decoys: 4, rejected: 4, accepted: 0 } };
const fixtureRun = { runId: 'agent-act3', universeId: 'TPCDS', executionMode: 'LIVE', dataOrigin: 'PUBLIC', status: 'COMPLETED', modelParticipation: 'USED', phases: { exploration: { calls: [{ decisionStatus: 'VALID' }] } },
  decisions: [{ relationId: 'rel_a', verdict: 'SOSTENIDA', reasonCodes: [] }, { relationId: 'rel_b', verdict: 'INDETERMINADA', reasonCodes: [] }] };
const probes = ['rel_a', 'rel_b'].map(id => ({ relationId: id, from: { db: 'D', table: 'a', column: 'x' }, to: { db: 'D', table: 'b', column: 'y' }, evidence: { reviewAuthorization: overlayAuth } }));
const section = (md: string) => md.slice(md.indexOf('## Contrato semantico aprobado por el humano'), md.indexOf('\n## ', md.indexOf('## Contrato semantico aprobado por el humano') + 5));

test('the report labels the SOSTENIDA as a human-approved semantic contract, with approver, date, package, deferred relations and negative control', () => {
  const md = renderAgentRunMarkdown({ ...fixtureRun, reviewOverlay: runOverlay }, { probes });
  const sec = section(md);
  assert.ok(md.indexOf('## Contrato semantico aprobado por el humano') > 0 && md.indexOf('## Contrato semantico aprobado por el humano') < md.indexOf('## Estado final'));
  assert.match(sec, /descansan en un contrato semantico aprobado por el humano: lo aprobo project-owner el 2026-10-25 \(paquete: no disponible; sesion: pkg-act3-tpcds; origen HUMAN_REVIEW/);
  assert.match(sec, /no es un hallazgo del agente/); assert.match(sec, /\*\*SOSTENIDA entre ellas\*\*: 1 de 2/);
  assert.match(sec, /Relaciones diferidas, sin aprobar en este contrato: 3\./); assert.match(sec, /\| rel_d2 \| M12 pendiente \|/);
  assert.match(sec, /Control negativo \(senuelos\): \{"decoys":4,"rejected":4,"accepted":0\}/);
  assertHonest(sec, 'report section');
  const derived = renderAgentRunMarkdown(fixtureRun, { probes });
  assert.match(section(derived), /project-owner el 2026-10-25/); assert.match(section(derived), /Control negativo \(senuelos\): no disponible en este run\./);
  assert.ok(!renderAgentRunMarkdown(fixtureRun, { probes: probes.map(p => ({ ...p, evidence: {} })) }).includes('contrato semantico aprobado'), 'no overlay, no label');
});

test('the dossier and the ODCS export carry the same label, deferred relations and negative control', async () => {
  const d = buildNegativeDossier({ run: { ...fixtureRun, reviewOverlay: runOverlay }, artifacts: { probes } });
  assert.equal(d.humanContract?.approver, 'project-owner'); assert.equal(d.humanContract?.deferred.length, 3);
  const md = renderNegativeDossierMarkdown(d), lines = md.split('\n').filter(l => /^- (Base de las SOSTENIDA|Relaciones diferidas|Control negativo)/.test(l));
  assert.equal(lines.length, 3); assert.match(lines[0]!, /contrato semantico aprobado por el humano/); assert.match(lines[1]!, /rel_d1 \(M12 pendiente\); rel_d2/);
  assertHonest(lines.join('\n'), 'dossier');
  assert.equal(buildNegativeDossier({ run: fixtureRun, artifacts: { probes: probes.map(p => ({ ...p, evidence: {} })) } }).humanContract, null);

  const fixture = agentFixtures().find(item => item.alias === 'GTFSAGENT')!, runs = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
  try {
    const report: any = await runAgent('GTFSAGENT', 'agent-hc-1', { client: fixtureClient(universeConfig('GTFSAGENT'), fixture.tables) as any, chooser: new Script(), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false } as any);
    const art = { probes: JSON.parse(JSON.stringify(report.artifacts.probes)) };
    for (const p of art.probes) p.evidence.reviewAuthorization = { ...overlayAuth, approver: 'frozen-approver' };
    const dir = path.join(runs, report.runId); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'engine-run.json'), JSON.stringify({ ...report, reviewOverlay: { ...runOverlay, relations: art.probes.map((p: any) => p.relationId) } }));
    fs.writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify({ schemaVersion: 1, runId: report.runId, universeId: report.universeId, probes: art.probes }));
    const out = exportOdcs({ runId: report.runId, out: path.join(runs, 'c.yaml') }, { runsDir: runs });
    assert.equal(out.relations, 1);
    const yaml = fs.readFileSync(path.join(runs, 'c.yaml'), 'utf8');
    assert.match(yaml, /contrato semantico aprobado por el humano/); assert.match(yaml, /concordiaBasis/); assert.match(yaml, /concordiaDeferredRelations/); assert.match(yaml, /rel_d3/); assert.match(yaml, /concordiaNegativeControl/);
    assert.match(yaml, /overlaySha256/); assert.match(yaml, /pkg-act3-tpcds/);
    const labelled = yaml.split('\n').filter(l => /purpose|concordiaBasis|descansan/.test(l)).join('\n');
    assertHonest(labelled, 'ODCS');
  } finally { fs.rmSync(runs, { recursive: true, force: true }); }
});

test('the honesty check itself catches text that credits the agent (guards against a vacuous test)', () => {
  for (const bad of ['El agente descubrio la relacion', 'La relacion fue validada por el agente', 'discovered by the agent', 'validated by the model', 'confirmada por el modelo'])
    assert.ok(FORBIDDEN.test(bad), bad);
  assertHonest(humanContractSentence(humanContractOf({ reviewOverlay: runOverlay })!), 'sentence');
  assert.ok(ROOT.length > 0);
});

test('with the frozen overlay hash, package, the 25 contract relations and the 3 deferred (M12) come from the matching universes/reviews file; a hash that matches nothing adds nothing', async () => {
  const { createHash } = await import('node:crypto');
  const file = path.join(ROOT, 'universes', 'reviews', 'TPCDS.review.json'), sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const overlay = JSON.parse(fs.readFileSync(file, 'utf8'));
  const withSha = (hash: string) => ({ probes: probes.map(p => ({ ...p, evidence: { reviewAuthorization: { ...overlayAuth, overlaySha256: hash, session: overlay.approval.session } } })) });
  const hc = humanContractOf(fixtureRun, withSha(sha))!;
  assert.equal(hc.source, 'overlay-file'); assert.equal(hc.package, overlay.approval.package);
  assert.equal(hc.relations.length, overlay.relations.length); assert.equal(hc.deferred.length, 3);
  assert.ok(hc.deferred.every(d => /^M12/.test(d.reason)));
  const md = renderAgentRunMarkdown(fixtureRun, withSha(sha)), sec = section(md);
  assert.match(sec, /Relaciones diferidas, sin aprobar en este contrato: 3\./); assert.match(sec, /M12; catalog_page duplicates/);
  assert.ok(sec.includes(`paquete: ${overlay.approval.package};`));
  assert.ok(!/[A-Za-z]:[\/]/.test(md), 'no absolute path');
  assertHonest(sec, 'report section from the overlay file');
  const none = humanContractOf(fixtureRun, withSha('f'.repeat(64)))!;
  assert.equal(none.source, 'probes'); assert.equal(none.deferred.length, 0); assert.equal(none.package, 'no disponible');
});

test('the negative control shows pending live approval for {artifact:null}, the artifact name, and per-decoy verdicts', () => {
  const sec = (nc: unknown) => section(renderAgentRunMarkdown({ ...fixtureRun, reviewOverlay: { ...runOverlay, negativeControl: nc } }, { probes }));
  assert.match(sec({ artifact: null }), /Control negativo \(senuelos\): pendiente de aprobacion live; todavia no hay resultado en este run\./);
  assert.match(sec({ artifact: 'negative-control.json' }), /Control negativo \(senuelos\): resultado en negative-control\.json\./);
  const withDecoys = sec({ artifact: 'negative-control.json', decoys: [{ id: 'd1', verdict: 'REJECTED_BY_EVIDENCE', basis: 'cobertura NONE' }, { id: 'd2', verdict: 'OUT_OF_CONTRACT_ONLY', basis: 'fuera del contrato' }] });
  assert.match(withDecoys, /2 senuelos evaluados\./); assert.match(withDecoys, /\| d1 \| REJECTED_BY_EVIDENCE \| cobertura NONE \|/); assert.match(withDecoys, /\| d2 \| OUT_OF_CONTRACT_ONLY \|/);
  assertHonest(withDecoys, 'negative control');
  const d = buildNegativeDossier({ run: { ...fixtureRun, reviewOverlay: { ...runOverlay, negativeControl: { artifact: null } } }, artifacts: { probes } });
  assert.match(renderNegativeDossierMarkdown(d), /Control negativo \(senuelos\): pendiente de aprobacion live/);
});

test('the negative-control.json named by the run is read from the run folder and rendered in the report and the dossier; other names are never opened', async () => {
  const { writeAgentRunReport } = await import('../src/report/agent-run-report.ts'), { exportNegativeDossier } = await import('../src/export/negative-dossier.ts'), { loadNegativeControl } = await import('../src/report/human-contract.ts');
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-')), id = 'agent-nc-1', dir = path.join(runs, id);
  const artifact = { schemaVersion: 1, kind: 'ACT3_NEGATIVE_CONTROL', label: 'LIVE_READ_ONLY', sqlSent: 6, sqlCeiling: 6, decoys: [
    { id: 'store_sales.ss_store_sk__web_site.web_site_sk', outcome: 'REJECTED_BY_EVIDENCE', hypotheticalVerdict: 'ENGAÑOSA', reasonCodes: ['low_overlap'], inContract: false, sql: [{ side: 'from', sql: 'SELECT 1' }] },
    { id: 'inventory.inv_warehouse_sk__ship_mode.sm_ship_mode_sk', outcome: 'OUT_OF_CONTRACT_ONLY', hypotheticalVerdict: 'SOSTENIDA', reasonCodes: [], inContract: false, sql: [] }] };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'engine-run.json'), JSON.stringify({ ...fixtureRun, runId: id, reviewOverlay: { ...runOverlay, negativeControl: { artifact: 'negative-control.json' } }, artifactsFile: 'artifacts.json' }));
    fs.writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify({ schemaVersion: 1, runId: id, probes }));
    fs.writeFileSync(path.join(dir, 'negative-control.json'), JSON.stringify(artifact));
    writeAgentRunReport(id, runs);
    const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), sec = section(md);
    assert.match(sec, /Control negativo \(senuelos\): 2 senuelos evaluados \(LIVE_READ_ONLY; 6 de 6 SQL del tope\)\./);
    assert.match(sec, /\| store_sales\.ss_store_sk__web_site\.web_site_sk \| REJECTED_BY_EVIDENCE \| veredicto hipotetico ENGAÑOSA \(low_overlap\); fuera del contrato \|/);
    assert.match(sec, /\| inventory\.inv_warehouse_sk__ship_mode\.sm_ship_mode_sk \| OUT_OF_CONTRACT_ONLY \|/); assert.match(sec, /solo el contrato humano lo deja fuera/);
    assert.ok(!sec.includes('SELECT 1'), 'the SQL stays in the artifact');
    assertHonest(sec, 'negative control section');
    exportNegativeDossier({ runId: id, runsDir: runs });
    const dmd = fs.readFileSync(path.join(dir, 'negative-dossier.md'), 'utf8');
    assert.match(dmd, /Control negativo \(senuelos\): LIVE_READ_ONLY; store_sales\.ss_store_sk__web_site\.web_site_sk REJECTED_BY_EVIDENCE; inventory\.inv_warehouse_sk__ship_mode\.sm_ship_mode_sk OUT_OF_CONTRACT_ONLY/);
    assert.equal(loadNegativeControl(dir, { artifact: '../engine-run.json' }), undefined); assert.equal(loadNegativeControl(dir, { artifact: 'sub/x.json' }), undefined); assert.equal(loadNegativeControl(dir, { artifact: null }), undefined);
  } finally { fs.rmSync(runs, { recursive: true, force: true }); }
});

test('the real LIVE negative-control.json (3 decoys, 6 SQL) renders in the report and the dossier, flagging insufficient evidence', async () => {
  const { writeAgentRunReport } = await import('../src/report/agent-run-report.ts'), { exportNegativeDossier } = await import('../src/export/negative-dossier.ts');
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'ncreal-')), id = 'agent-tpcds-negative-control', dir = path.join(runs, id);
  try {
    fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'agent-runs', id), dir, { recursive: true });
    writeAgentRunReport(id, runs);
    const sec = section(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'));
    assert.match(sec, /Control negativo \(senuelos\): 3 senuelos evaluados \(LIVE_READ_ONLY; 6 de 6 SQL del tope\)\./);
    assert.match(sec, /\| store_sales\.ss_store_sk__web_site\.web_site_sk \| OUT_OF_CONTRACT_ONLY \| veredicto hipotetico SOSTENIDA \(bounded_sample_key_membership\); fuera del contrato \|/);
    assert.match(sec, /\| inventory\.inv_warehouse_sk__ship_mode\.sm_ship_mode_sk \| REJECTED_BY_EVIDENCE \(evidencia insuficiente: 1 clave\) \| veredicto hipotetico INDETERMINADA \(insufficient_distinct_sample_keys\)/);
    assert.match(sec, /\| store_sales\.ss_promo_sk__reason\.r_reason_sk \| REJECTED_BY_EVIDENCE \| veredicto hipotetico ENGAÑOSA \(observed_key_missing_from_referenced_sample\)/);
    assert.ok(!/evidencia insuficiente/.test(sec.split('\n').find(l => l.includes('ss_promo_sk__reason'))!), 'only the under-sampled decoy carries the note');
    assert.match(sec, /Relaciones diferidas, sin aprobar en este contrato: 3\./); assert.match(sec, /\*\*Relaciones del contrato\*\*: 25/);
    assertHonest(sec, 'real negative control section');
    exportNegativeDossier({ runId: id, runsDir: runs });
    assert.match(fs.readFileSync(path.join(dir, 'negative-dossier.md'), 'utf8'), /inventory\.inv_warehouse_sk__ship_mode\.sm_ship_mode_sk REJECTED_BY_EVIDENCE \(evidencia insuficiente: 1 clave\)/);
  } finally { fs.rmSync(runs, { recursive: true, force: true }); }
});
