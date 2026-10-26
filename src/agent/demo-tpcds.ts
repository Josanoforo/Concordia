/**
 * `concordia demo-tpcds`: one command that replays the existing pieces in the order of the video and writes a shot script
 * (step, command, what to look at, evidence path, mode/origin). It adds no engine logic: every act calls an existing entry point.
 * Offline only: synthetic fixtures, no network, no .env, no budget ledger. A shot is never labeled LIVE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SafeError } from '../runtime.ts';
import { exportOdcs } from '../export/odcs.ts';
import { exportNegativeDossier } from '../export/negative-dossier.ts';
import { writeAgentRunReport } from '../report/agent-run-report.ts';
import { runOfflineAgent } from './cli-run.ts';
import { readReviewOverlayFile } from './review-overlay.ts';

export interface DemoShot { step: string; command: string; look: string; evidence: string[]; mode: string; origin: string }
export interface DemoAct { id: string; title: string; status: 'DONE' | 'PENDING'; note?: string; shots: DemoShot[] }

/** Extension point: acts that do not exist yet. TPCDS act 3 is real when the caller names the human review overlay (`reviewFile`); without it the act stays pending and the memory act uses GTFSAGENT. */
export const PENDING_ACTS: { id: string; title: string; note: string }[] = [
  { id: 'TPCDS_ACT3', title: 'TPCDS: revision humana, SOSTENIDA y REUSED sobre TPCDS', note: 'No existe todavia (M7-3). Hasta entonces el acto de memoria usa GTFSAGENT, el unico universo con el ciclo REVIEWED -> SOSTENIDA -> REUSED offline.' }
];

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
const runPath = (runId: string, file = '') => `.concordia/agent-runs/${runId}/${file}`.replace(/\/$/, '');

/** Gold-trap homonyms that are NOT among the approved contracts (same set as tests/act3-negative-control.test.ts): the negative control of act 3. */
export const NEGATIVE_CONTROL_DECOYS = [
  { from: 'store_sales.ss_store_sk', to: 'web_site.web_site_sk' },
  { from: 'inventory.inv_warehouse_sk', to: 'ship_mode.sm_ship_mode_sk' },
  { from: 'store_sales.ss_promo_sk', to: 'reason.r_reason_sk' }
];

/** `reviewFile`: the human review overlay for act 3 (the caller supplies it; this module never looks for one by itself). */
export async function runDemoTpcds(options: { outDir?: string; runPrefix?: string; reviewFile?: string } = {}) {
  const outDir = options.outDir ?? path.join(ROOT, 'out', 'demo-tpcds'), prefix = options.runPrefix ?? 'agent-demo-tpcds', workDir = path.join(ROOT, '.concordia', 'demo-tpcds');
  const ids = { blind: `${prefix}-1-blind`, gtfs1: `${prefix}-3-gtfs-pass1`, gtfs2: `${prefix}-3-gtfs-pass2`, review1: `${prefix}-3-tpcds-review-pass1`, review2: `${prefix}-3-tpcds-review-pass2` };
  // A clean slate each time: the isolated memory store must start empty or pass 1 would already be a reuse.
  fs.rmSync(workDir, { recursive: true, force: true });
  for (const id of Object.values(ids)) fs.rmSync(path.join(ROOT, '.concordia', 'agent-runs', id), { recursive: true, force: true });
  const memoryDir = path.join(workDir, 'memory', 'LOCAL-SYNTHETIC');
  const label = (report: any) => {
    if (report.executionMode === 'LIVE') throw new SafeError('DEMO_REFUSES_LIVE');
    return { mode: String(report.executionMode ?? 'LOCAL'), origin: String(report.dataOrigin ?? 'SYNTHETIC') };
  };
  const verdicts = (report: any) => Object.entries((report.decisions ?? []).reduce((acc: Record<string, number>, item: any) => ({ ...acc, [item.verdict]: (acc[item.verdict] ?? 0) + 1 }), {})).map(([k, v]) => `${k}=${v}`).join(', ') || 'sin veredictos';
  const facts: Record<string, unknown> = {};
  const acts: DemoAct[] = [];

  // Acts 1 and 2: blind discovery and verdicts over the TPCDS fixture.
  const blind = await runOfflineAgent('TPCDS', { runId: ids.blind });
  const blindLabel = label(blind.report);
  const blindReport = writeAgentRunReport(ids.blind);
  facts.blind = { status: blind.report.status, coma: blind.report.phases?.coma?.status, postComa: blind.report.postComa?.counts ?? null, verdicts: verdicts(blind.report), decisions: (blind.report.decisions ?? []).length };
  acts.push({ id: 'ACT1_BLIND_DISCOVERY', title: 'Descubrimiento ciego sobre TPCDS (fixture)', status: 'DONE', shots: [{
    step: '1. Correr el agente sobre TPCDS sin relaciones configuradas', command: `concordia agent --universe TPCDS --offline --run-id ${ids.blind}`,
    look: `status ${blind.report.status}; COMA ${blind.report.phases?.coma?.status}; propuestas post-COMA ejecutadas ${blind.report.postComa?.counts?.executed ?? 0}. El resumen es una linea JSON.`, evidence: [runPath(ids.blind, 'engine-run.json')], ...blindLabel }] });
  acts.push({ id: 'ACT2_VERDICTS', title: 'Veredictos y reporte', status: 'DONE', shots: [{
    step: '2. Generar y abrir el reporte humano', command: `concordia agent-report --run-id ${ids.blind}`,
    look: (blind.report.decisions ?? []).length ? `Veredictos: ${verdicts(blind.report)}. Banner de modo/origen arriba; cada veredicto con su evidencia y denominador.`
      : `TPCDS ciego no configura relaciones, asi que no hay veredictos SOSTENIDA/ENGAÑOSA: el reporte muestra ${blind.report.postComa?.counts?.proposals ?? 0} propuestas de COMA y ${blind.report.postComa?.counts?.executed ?? 0} ejecutadas como diagnostico de cobertura (nunca veredicto). Banner de modo/origen arriba.`, evidence: blindReport.files.map(file => runPath(ids.blind, file)), ...blindLabel }] });

  // Act 3: with the human review overlay, TPCDS gets SOSTENIDA and an origin-sealed write, then REUSED. Without it, memory and reuse are shown on GTFSAGENT and act 3 stays pending.
  let exportTargets: [string, string, { mode: string; origin: string }][] = [[ids.blind, 'TPCDS', blindLabel]];
  if (options.reviewFile) {
    const reviewFile = options.reviewFile, { overlay } = readReviewOverlayFile(reviewFile) as { overlay: any };
    const memoryDirTpcds = path.join(workDir, 'memory-tpcds', 'LOCAL-SYNTHETIC');
    const passA = await runOfflineAgent('TPCDS', { runId: ids.review1, review: reviewFile, memory: { dir: memoryDirTpcds } });
    const passB = await runOfflineAgent('TPCDS', { runId: ids.review2, review: reviewFile, memory: { dir: memoryDirTpcds } });
    const reviewLabel = label(passB.report), reviewReport = writeAgentRunReport(ids.review1);
    const decoyIds = new Set(NEGATIVE_CONTROL_DECOYS.map(item => `${item.from}__${item.to}`));
    const decoyDecisions = (passA.report.decisions ?? []).filter((item: any) => decoyIds.has(item.relationId)).length;
    const decoyCandidates = (passA.report.postComa?.proposals ?? []).filter((item: any) => decoyIds.has(item.proposalId));
    const decoysPending = decoyCandidates.filter((item: any) => item.reviewState === 'PENDING').length;
    const reusedB = (passB.report.decisions ?? []).filter((item: any) => (item.reasonCodes ?? []).includes('REUSED_FROM_MEMORY')).length;
    const sealed = fs.existsSync(path.join(memoryDirTpcds, 'origin-seal.json'));
    const approved = `aprobado por ${overlay.approval.approver} el ${overlay.approval.approvedAt}`;
    facts.review = { overlay: reviewFile, approval: overlay.approval, passA: { status: passA.report.status, decisions: (passA.report.decisions ?? []).length, verdicts: verdicts(passA.report), memory: passA.report.memory?.status },
      passB: { status: passB.report.status, reused: reusedB, probes: (passB.report.phases?.probes?.selected ?? []).length }, originSealed: sealed, deferred: overlay.deferred,
      negativeControl: { decoys: NEGATIVE_CONTROL_DECOYS.length, withDecision: decoyDecisions, candidatesFound: decoyCandidates.length, candidatesPending: decoysPending } };
    acts.push({ id: 'ACT3_TPCDS_REVIEW', title: 'Acto 3 TPCDS: contrato semantico aprobado por el humano, SOSTENIDA, memoria y REUSED', status: 'DONE',
      note: `Las ${overlay.relations.length} relaciones son un contrato semantico aprobado por el humano (${approved}); el agente no las descubrio ni las valido: mide con evidencia acotada si cada una se sostiene sobre el fixture sintetico. La memoria de la demo es aislada (.concordia/demo-tpcds/memory-tpcds) y queda sellada con su origen LOCAL/SYNTHETIC.`, shots: [
      { step: '3a. Primera pasada con el contrato aprobado por el humano: SOSTENIDA y escritura sellada por origen', command: `concordia agent --universe TPCDS --offline --review ${reviewFile} --memory --run-id ${ids.review1}`,
        look: `${(passA.report.decisions ?? []).length} decisiones (${verdicts(passA.report)}) con razon bounded_sample_key_membership sobre el fixture; la autorizacion humana viaja en cada decision. memory.status ${passA.report.memory?.status}; sello de origen ${sealed ? 'presente' : 'AUSENTE'}.`,
        evidence: [runPath(ids.review1, 'engine-run.json'), rel(path.join(memoryDirTpcds, 'origin-seal.json'))], ...reviewLabel },
      { step: '3b. Reporte de la pasada 1: el rotulado dice contrato aprobado por el humano', command: `concordia agent-report --run-id ${ids.review1}`,
        look: 'El reporte rotula cada SOSTENIDA como apoyada en un contrato semantico aprobado por el humano, nunca como descubierta ni validada por el agente.', evidence: reviewReport.files.map(file => runPath(ids.review1, file)), ...reviewLabel },
      { step: '3c. Segunda pasada: las mismas relaciones salen REUSED desde la memoria aislada', command: `concordia agent --universe TPCDS --offline --review ${reviewFile} --memory --run-id ${ids.review2}`,
        look: `${reusedB} de ${(passB.report.decisions ?? []).length} decisiones con REUSED_FROM_MEMORY; sondas en esta pasada: ${(passB.report.phases?.probes?.selected ?? []).length}.`, evidence: [runPath(ids.review2, 'engine-run.json'), rel(memoryDirTpcds)], ...reviewLabel },
      { step: '3d. Control negativo: los senuelos no entran en ninguna decision', command: 'node scripts/run-tsx.mjs --test tests/act3-negative-control.test.ts',
        look: `${decoyDecisions} de ${NEGATIVE_CONTROL_DECOYS.length} senuelos con decision en la pasada 1; ${decoysPending} de ${decoyCandidates.length} candidatos senuelo quedan PENDING. Honesto: si alguien pusiera un contrato REVIEWED sobre un senuelo, la politica sola (pertenencia de claves) lo sostendria; la proteccion es el conjunto de contratos humanos, no la evidencia.`,
        evidence: ['tests/act3-negative-control.test.ts', runPath(ids.review1, 'engine-run.json')], ...reviewLabel },
      { step: '3e. Las 3 relaciones aplazadas quedan fuera', command: `node -e "console.log(require('./${reviewFile}').deferred)"`,
        look: `Aplazadas por el humano (no son decisiones del agente): ${overlay.deferred.map((item: any) => `${item.id} (${item.reason})`).join('; ')}.`, evidence: [reviewFile], ...reviewLabel }] });
    exportTargets = [[ids.blind, 'TPCDS (ciego, sin contrato)', blindLabel], [ids.review1, 'TPCDS (contrato aprobado por el humano)', reviewLabel]];
  } else {
    // Memory and reuse on GTFSAGENT, the only universe with the full cycle offline. Isolated store, never the real memory.
    const pass1 = await runOfflineAgent('GTFSAGENT', { runId: ids.gtfs1, memory: { dir: memoryDir } });
    const pass2 = await runOfflineAgent('GTFSAGENT', { runId: ids.gtfs2, memory: { dir: memoryDir } });
    const gtfsLabel = label(pass2.report);
    exportTargets = [[ids.blind, 'TPCDS', blindLabel], [ids.gtfs2, 'GTFSAGENT', gtfsLabel]];
    const reused = (pass2.report.memory?.reuse?.reused ?? []).length;
    facts.memory = { universe: 'GTFSAGENT', pass1: pass1.report.memory?.status, pass2: pass2.report.memory?.status, reusedRelations: reused, pass2Probes: (pass2.report.phases?.probes?.selected ?? []).length };
    acts.push({ id: 'ACT3_MEMORY_GTFS', title: 'Memoria y reuso (GTFSAGENT: el acto 3 de TPCDS aun no existe)', status: 'DONE',
      note: 'Se usa GTFSAGENT porque es el unico universo con el ciclo REVIEWED -> SOSTENIDA -> REUSED offline. El almacen de la demo es aislado (.concordia/demo-tpcds/memory), no la memoria real.', shots: [
      { step: '3a. Primera pasada con memoria: la relacion sostenida se registra', command: `concordia agent --universe GTFSAGENT --offline --memory --run-id ${ids.gtfs1}`,
        look: `memory.status ${pass1.report.memory?.status}; reuse.mode ${pass1.report.memory?.reuse?.mode}; la relacion se sondea.`, evidence: [runPath(ids.gtfs1, 'engine-run.json')], ...gtfsLabel },
      { step: '3b. Segunda pasada: la misma relacion sale REUSED sin volver a sondear', command: `concordia agent --universe GTFSAGENT --offline --memory --run-id ${ids.gtfs2}`,
        look: `${reused} relacion(es) reutilizadas (razon REUSED_FROM_MEMORY); sondas en esta pasada: ${(pass2.report.phases?.probes?.selected ?? []).length}.`, evidence: [runPath(ids.gtfs2, 'engine-run.json'), rel(memoryDir)], ...gtfsLabel }] });
    for (const pending of PENDING_ACTS) acts.push({ id: pending.id, title: pending.title, status: 'PENDING', note: pending.note, shots: [] });
  }

  // Act 4: exports of the runs above.
  const exportShots: DemoShot[] = [];
  const attempt = <T>(fn: () => T) => { try { return { ok: true as const, value: fn() }; } catch (error) { return { ok: false as const, code: error instanceof SafeError ? error.code : 'EXPORT_FAILED' }; } };
  for (const [runId, name, runLabel] of exportTargets) {
    const odcs = attempt(() => exportOdcs({ runId })), negative = attempt(() => exportNegativeDossier({ runId }));
    facts[`export_${runId}`] = { odcs: odcs.ok ? { relations: odcs.value.relations, skipped: odcs.value.skipped?.length ?? 0 } : odcs.code, negative: negative.ok ? { entries: negative.value.entries, byKind: negative.value.byKind } : negative.code };
    exportShots.push({ step: `4. Contrato ODCS de ${name}`, command: `concordia export-odcs --run-id ${runId}`,
      look: odcs.ok ? `${odcs.value.relations} relacion(es) exportadas, ${odcs.value.skipped?.length ?? 0} omitidas con razon; la procedencia viaja en el contrato.` : `Sin contrato: ${odcs.code}.`, evidence: odcs.ok ? [rel(odcs.value.path)] : [runPath(runId, 'engine-run.json')], ...runLabel });
    exportShots.push({ step: `4. Dossier negativo de ${name} (lo que el run descarto)`, command: `concordia export-negative --run-id ${runId}`,
      look: negative.ok ? `${negative.value.entries} entrada(s): ${Object.entries(negative.value.byKind).map(([k, v]) => `${k}=${v}`).join(', ') || 'ninguna'}.` : `Sin dossier: ${negative.code}.`, evidence: negative.ok ? [rel(negative.value.path)] : [runPath(runId, 'engine-run.json')], ...runLabel });
  }
  acts.push({ id: 'ACT4_EXPORTS', title: 'Exports: ODCS y dossier negativo', status: 'DONE', shots: exportShots });

  fs.mkdirSync(outDir, { recursive: true });
  const scriptPath = path.join(outDir, 'GUION_TOMAS.md'), summaryPath = path.join(outDir, 'summary.json');
  fs.writeFileSync(scriptPath, renderScript(acts));
  fs.writeFileSync(summaryPath, JSON.stringify({ schemaVersion: 1, mode: 'LOCAL', dataOrigin: 'SYNTHETIC', live: false, runs: ids, facts, acts: acts.map(act => ({ id: act.id, status: act.status, shots: act.shots.length })) }, null, 2) + '\n');
  return { scriptPath, summaryPath, acts, facts, runs: ids };
}

export function renderScript(acts: readonly DemoAct[]): string {
  const lines = ['# Guion de tomas: demo-tpcds', '', 'Todo corre offline sobre fixtures sinteticas (sin red, sin .env, sin ledger). Ninguna toma es LIVE. Cada toma lleva su modo y origen reales.', ''];
  for (const act of acts) {
    lines.push(`## ${act.title}${act.status === 'PENDING' ? ' (PENDIENTE)' : ''}`, '');
    if (act.note) lines.push(`> ${act.note}`, '');
    for (const shot of act.shots) lines.push(`### ${shot.step}`, `- **Modo / origen:** ${shot.mode} / ${shot.origin}`, `- **Comando:** \`${shot.command}\``, `- **Que mirar:** ${shot.look}`, `- **Evidencia:** ${shot.evidence.map(item => `\`${item}\``).join(', ')}`, '');
  }
  return lines.join('\n');
}
