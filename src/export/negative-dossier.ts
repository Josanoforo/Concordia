import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, SafeError } from '../runtime.ts';
import { resolveUniverseManifest } from '../registry/universes.ts';
import { loadModelReviewOverlay, modelReviewOf, reviewOriginsOf, MODEL_REVIEW_BASIS } from '../report/review-origin.ts';
import { normalizeArtifactsOrder, normalizeRunOrder } from '../report/order.ts';
import { loadNegativeControl, summarizeNegativeControl, insufficiencyNote, humanContractOf, humanContractSentence, publicHumanContract, HUMAN_CONTRACT_BASIS, type HumanContract } from '../report/human-contract.ts';
import type { ExecutionMode } from '../contracts/types.ts';
import { classifyIncompleteness, type Incompleteness } from '../relations/incompleteness.ts';

/**
 * Negative-knowledge dossier: what a run showed does NOT hold (or could not be established), with the exact counterfactual.
 * Counterpart of the positive export. It is derived only from the run's own artifacts: any value absent from the run is
 * written as NA ("no disponible"), never inferred. It changes no verdict and is not evidence for one.
 */
export const NA = 'no disponible';
export type NegativeKind = 'MISLEADING_PAIR' | 'NO_COMMON_SPACE' | 'LABEL_CONFLICT_OBSERVED' | 'INDETERMINATE' | 'COMA_OUT_OF_SCOPE_NOT_EXECUTABLE' | 'DATA_QUALITY_TARGET_NOT_UNIQUE';
/** schemaVersion 2: entradas con class (DEMONSTRATED / NOT_ESTABLISHED), byClass, warnings, executionMode y dataOrigin en la raiz, y el kind DATA_QUALITY_TARGET_NOT_UNIQUE. La version 1 no los traia. */
/** DEMONSTRATED: una muestra acotada contradice la relacion (veredicto ENGAÑOSA o espacios incompatibles). NOT_ESTABLISHED: no se pudo decidir (INDETERMINADA, conflicto de etiquetas sin veredicto, propuesta COMA sin sonda). */
export type NegativeClass = 'DEMONSTRATED' | 'NOT_ESTABLISHED';
export interface NegativeEntry {
  class: NegativeClass;
  pair: { id: string; from: string; to: string };
  kind: NegativeKind;
  verdict: string;
  reasonCodes: string[];
  incompleteness: Incompleteness | typeof NA;
  evidence: Record<string, unknown>;
  declaredInConfig: Record<string, unknown>;
  critic: unknown;
  counterfactual: string;
  provenance: { runId: string; universeId: string; executionMode: string; dataOrigin: string; utc: string; source: string };
}
export interface NegativeDossier {
  schemaVersion: 2; runId: string; universeId: string; executionMode: string; dataOrigin: string; generatedFrom: string[]; entries: NegativeEntry[]; byKind: Record<string, number>; byClass: Record<NegativeClass, number>; warnings: string[]; humanContract: HumanContract | null; reviewOrigins: { counts: Record<string, number>; total: number; modelReview: { basis: string; relations: number; evaluations: number; attacks: number; tokens: number | null; provenance: string; status: string } | null };
  scope: 'bounded observed samples only; a bounded sample can contradict a relation but never prove one; no verdict is changed by this document';
}

// Valores canonicos de ExecutionMode y DataOrigin (src/contracts/types.ts); lo demas es UNKNOWN.
const EXECUTION_MODES: readonly string[] = ['LIVE', 'REPLAY', 'LOCAL'];
const DATA_ORIGINS: readonly string[] = ['SYNTHETIC', 'PUBLIC', 'USER', 'UNKNOWN'];
const execOf = (v: unknown): ExecutionMode | 'UNKNOWN' => typeof v === 'string' && EXECUTION_MODES.includes(v) ? v as ExecutionMode : 'UNKNOWN';
const originOf = (v: unknown): string => typeof v === 'string' && DATA_ORIGINS.includes(v) ? v : typeof (v as any)?.label === 'string' && (v as any).label ? (v as any).label : 'UNKNOWN';
// DEMONSTRATED solo con un veredicto real distinto de INDETERMINADA; un veredicto no disponible no demuestra nada.
const REAL_DECISION = (verdict: string) => verdict === 'SOSTENIDA' || verdict === 'ENGAÑOSA';
const DEMONSTRATED_KINDS = (kind: NegativeKind, verdict: string) => kind === 'MISLEADING_PAIR' || kind === 'NO_COMMON_SPACE' || (kind === 'LABEL_CONFLICT_OBSERVED' && REAL_DECISION(verdict));
const ep = (e: any) => e ? `${e.db}.${e.table}.${e.column}` : NA;
const val = (v: unknown) => v === undefined || v === null ? NA : v;
const num = (v: unknown) => typeof v === 'number' ? v : NA;
const ratio = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number' ? `${a} de ${b}` : NA;

function counterfactual(kind: NegativeKind, p: any, decision: any, incompleteness: Incompleteness | undefined, thresholds: any): string {
  const missing: string[] = decision?.requirementsMissing ?? [];
  if (incompleteness?.kind === 'EXPECTED_SAMPLE_CAP') {
    const caps = incompleteness.detail.cappedEndpoints.map(c => `${c.sourceRef} (${c.rows} filas, tope ${c.limit})`).join('; ');
    const base = `Evidencia no truncada: los extremos ${caps} alcanzaron el tope esperado de la muestra; una lectura completa para el alcance permitiria evaluar la relacion. El tope por si solo no la refuta.`;
    if (kind === 'LABEL_CONFLICT_OBSERVED') return `${base} Aparte, el acuerdo de etiquetas observado (${ratio(p?.evidence?.labelAgreement?.agree, p?.evidence?.labelAgreement?.compared)}) esta por debajo del umbral sostenido ${val(thresholds?.sustainedLabelAgreement)}; con espacio de identificadores revisado y comun y acuerdo sobre ese umbral la relacion podria sostenerse, y con acuerdo bajo ${val(thresholds?.misleadingLabelAgreement)} y semantica revisada seria ENGANOSA.`;
    return base;
  }
  if (incompleteness?.kind === 'EXECUTION_FAILURE') return 'Reintentar las lecturas que fallaron o quedaron parciales (ver incompleteness.detail.failedObservations); sin lecturas completas el veredicto no puede cambiar.';
  if (incompleteness?.kind === 'ENDPOINT_MISSING') return `Obtener una observacion para el extremo faltante (${incompleteness.detail.missingEndpoints.join(', ')}).`;
  if (kind === 'MISLEADING_PAIR') return `El veredicto cambiaria si las claves muestreadas ausentes del destino (${ratio(Number.isFinite(p?.evidence?.overlap?.probed - p?.evidence?.overlap?.matched) ? p.evidence.overlap.probed - p.evidence.overlap.matched : undefined, p?.evidence?.overlap?.probed)}) aparecieran en una muestra acotada del destino, o si la politica declarara un minimumOverlapRatio que la solapacion observada alcance.`;
  if (kind === 'NO_COMMON_SPACE') return 'Requiere que ambos extremos declaren el mismo espacio de identificadores (namespace); mientras difieran, la igualdad de valores no cuenta como evidencia.';
  return missing.length ? `Faltan: ${missing.join(', ')}.` : NA;
}

/** Pure builder over already loaded run files. `config` and `thresholds` may be undefined: their fields are then NA. */
export function buildNegativeDossier(input: { run: any; artifacts?: any; config?: any; thresholds?: any; warnings?: string[]; negativeControl?: unknown; modelReviewOverlay?: unknown; qualityRuns?: { runId: string; run: any }[] }): NegativeDossier {
  const run = normalizeRunOrder(input.run), artifacts = normalizeArtifactsOrder(input.artifacts), { config, thresholds } = input;
  const prov = (source: string) => ({ runId: String(val(run?.runId)), universeId: String(val(run?.universeId)), executionMode: execOf(run?.executionMode), dataOrigin: originOf(run?.dataOrigin), utc: String(val(run?.utc)), source });
  const critic = run?.phases?.critic;
  const criticFor = (id: string) => {
    const results = Array.isArray(critic?.results) ? critic.results : undefined;
    const found = results?.find((r: any) => r.relationId === id || r.relation?.id === id);
    return found ? { status: found.status ?? NA, verdict: found.decision?.verdict ?? NA } : { perRelation: NA, runLevel: critic ? { status: critic.status ?? NA, eligible: val(critic.eligible), summary: val(critic.summary) } : NA };
  };
  const entries: NegativeEntry[] = [];
  const configRelations: any[] = config?.relations ?? [];
  for (const p of artifacts?.probes ?? []) {
    const e = p.evidence ?? {};
    const decision = e.decision, bundle = e.typedEvidence, contract = e.relationContract;
    const verdict = String(val(p.verdict ?? decision?.verdict));
    const reasonCodes: string[] = decision?.reasonCodes ?? (p.rule ? [p.rule] : []);
    const quality = (bundle?.observations ?? []).filter((o: any) => o.type === 'SAMPLE_QUALITY').flatMap((o: any) => o.measuredTuples.map((t: any[]) => t[0]));
    const labelConflict = quality.includes('LABEL_CONFLICT');
    const incompleteness = contract && bundle && reasonCodes.includes('evidence_incomplete_or_truncated') ? classifyIncompleteness(contract, [bundle]) : undefined;
    const kind: NegativeKind | undefined = verdict === 'ENGAÑOSA' ? 'MISLEADING_PAIR'
      : reasonCodes.includes('incompatible_namespaces') ? 'NO_COMMON_SPACE'
      : labelConflict ? 'LABEL_CONFLICT_OBSERVED'
      : verdict === 'INDETERMINADA' ? 'INDETERMINATE' : undefined;
    if (!kind) continue;
    const cfgRel = configRelations.find(r => r.id === p.relationId);
    const keyObs = (bundle?.observations ?? []).filter((o: any) => o.type === 'KEY_MEMBERSHIP');
    entries.push({
      class: DEMONSTRATED_KINDS(kind, verdict) ? 'DEMONSTRATED' : 'NOT_ESTABLISHED',
      pair: { id: String(p.relationId), from: ep(p.from), to: ep(p.to) },
      kind, verdict, reasonCodes,
      incompleteness: incompleteness ?? NA,
      evidence: {
        keyOverlap: { matched: num(e.overlap?.matched), probed: num(e.overlap?.probed), text: ratio(e.overlap?.matched, e.overlap?.probed) },
        labelAgreement: e.labelAgreement ? { agree: e.labelAgreement.agree, compared: e.labelAgreement.compared, text: ratio(e.labelAgreement.agree, e.labelAgreement.compared), examples: (e.labelAgreement.examples ?? []).slice(0, 3) } : NA,
        rowsRead: { from: num(e.multiplicity?.from?.rows), to: num(e.multiplicity?.to?.rows) },
        bounded: e.multiplicity?.bounded ?? NA,
        limits: keyObs.length ? keyObs.map((o: any) => ({ sourceRef: o.sourceRef, limit: o.limit, truncated: o.truncated, transportStatus: o.transportStatus })) : NA,
        sampleQualitySignals: bundle ? quality : NA,
        contradictions: decision?.contradictions ?? NA, requirementsMissing: decision?.requirementsMissing ?? NA,
        normalization: val(e.normalization)
      },
      declaredInConfig: cfgRel ? { kind: val(cfgRel.kind), reviewState: val(cfgRel.reviewState), identifierSpace: val(cfgRel.identifierSpace), reason: val(cfgRel.reason) } : { config: NA },
      critic: criticFor(String(p.relationId)),
      counterfactual: counterfactual(kind, p, decision, incompleteness, thresholds),
      provenance: prov('artifacts.json')
    });
  }
  for (const proposal of run?.postComa?.proposals ?? []) {
    const cp = proposal.coverageProbe;
    if (cp?.status === 'EXECUTED') continue;
    entries.push({
      class: 'NOT_ESTABLISHED',
      pair: { id: String(proposal.proposalId), from: ep(proposal.from), to: ep(proposal.to) },
      kind: 'COMA_OUT_OF_SCOPE_NOT_EXECUTABLE', verdict: String(val(proposal.verificationStatus)), reasonCodes: [proposal.reason, cp?.reason].filter(Boolean),
      incompleteness: NA,
      evidence: { rawScore: num(proposal.rawScore), coverageProbeStatus: val(cp?.status), coverageProbeReason: val(cp?.reason), reviewState: val(proposal.reviewState), policy: run.postComa?.policy ?? NA },
      declaredInConfig: { config: NA }, critic: NA,
      counterfactual: `La propuesta de COMA queda NO VERIFICADA (${val(cp?.reason ?? cp?.status)}); para evaluarla haria falta que ambos extremos esten en el alcance descubierto/permitido y existan valores muestreados seguros, y entonces pasar por una sonda de cobertura y la politica de relaciones. Una puntuacion de COMA no es evidencia.`,
      provenance: prov('engine-run.json#postComa')
    });
  }
  // Hallazgo de calidad de datos: una columna destino con claves repetidas en la muestra acotada de sondas ejecutadas (una entrada por columna).
  const dup = new Map<string, { fromRun?: string; column: string; sources: Set<string>; probes: number; dupKeys: number; maxRows: number; examples: string[]; rowsRead: number }>();
  // Los runs fuente (p. ej. el run ciego que origino el paquete de revision) aportan hallazgos de calidad que este run no midio; el run propio manda si ambos observan la misma columna.
  const dqSources = [{ id: undefined as string | undefined, r: run }, ...(input.qualityRuns ?? []).map(q => ({ id: q.runId as string | undefined, r: q.run }))];
  for (const { id: fromRun, r: srcRun } of dqSources) for (const proposal of srcRun?.postComa?.proposals ?? []) {
    const cp = proposal.coverageProbe, d = cp?.diagnostic, uq = d?.keyRules?.targetUniqueness;
    if (cp?.status !== 'EXECUTED' || uq?.status !== 'DUPLICATES_OBSERVED') continue;
    const key = ep(proposal.to), prev = dup.get(key);
    if (prev && prev.fromRun !== fromRun) continue;
    const cur = prev ?? { ...(fromRun ? { fromRun } : {}), column: key, sources: new Set<string>(), probes: 0, dupKeys: 0, maxRows: 0, examples: [], rowsRead: 0 };
    cur.sources.add(ep(proposal.from)); cur.probes++; cur.dupKeys = Math.max(cur.dupKeys, Number(uq.duplicateKeyCount) || 0); cur.maxRows = Math.max(cur.maxRows, Number(uq.maxRowsPerKey) || 0); cur.rowsRead = Math.max(cur.rowsRead, Number(uq.rows) || 0);
    for (const k of d?.multiplicity?.to?.duplicateKeys ?? []) if (cur.examples.length < 3 && !cur.examples.includes(String(k.key))) cur.examples.push(String(k.key));
    dup.set(key, cur);
  }
  for (const c of dup.values()) entries.push({
    class: 'DEMONSTRATED',
    pair: { id: `dq:${c.column}`, from: [...c.sources].join(', '), to: c.column },
    kind: 'DATA_QUALITY_TARGET_NOT_UNIQUE', verdict: NA, reasonCodes: ['TARGET_NOT_UNIQUE'], incompleteness: NA,
    evidence: { ...(c.fromRun ? { observedInRun: c.fromRun } : {}), targetColumn: c.column, probesObserving: c.probes, duplicateKeyCount: c.dupKeys, maxRowsPerKey: c.maxRows, rowsRead: c.rowsRead, exampleKeys: c.examples, bounded: true },
    declaredInConfig: { config: NA }, critic: NA,
    counterfactual: `La columna ${c.column} repite claves en una muestra acotada de ${c.rowsRead} filas (${c.dupKeys} claves repetidas, hasta ${c.maxRows} filas por clave), asi que no se comporta como clave unica en esos datos. Es un hallazgo de calidad de datos, no un veredicto sobre las relaciones que la apuntan. Cambiaria si el destino se declarase con una clave compuesta o si una lectura completa mostrase que la repeticion no existe fuera de la muestra.`,
    provenance: prov(c.fromRun ? `engine-run.json#postComa (run fuente ${c.fromRun})` : 'engine-run.json#postComa')
  });
  const byKind: Record<string, number> = {};
  for (const entry of entries) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  const byClass: Record<NegativeClass, number> = { DEMONSTRATED: 0, NOT_ESTABLISHED: 0 };
  for (const entry of entries) byClass[entry.class]++;
  return { schemaVersion: 2, runId: String(val(run?.runId)), universeId: String(val(run?.universeId)), executionMode: execOf(run?.executionMode), dataOrigin: originOf(run?.dataOrigin), generatedFrom: ['engine-run.json', ...(artifacts ? ['artifacts.json'] : []), ...(config ? ['universe config'] : [])], entries, byKind, byClass, warnings: input.warnings ?? [], reviewOrigins: (() => { const o = reviewOriginsOf(run, artifacts), mr = modelReviewOf(run, input.modelReviewOverlay); return { counts: o.counts, total: o.total, modelReview: mr ? { basis: MODEL_REVIEW_BASIS, relations: mr.counts.reviewed ?? mr.reviews.length, evaluations: mr.reviews.reduce((n, r) => n + r.evaluations.length, 0), attacks: mr.reviews.reduce((n, r) => n + r.attacks.length, 0), tokens: mr.tokens, provenance: mr.provenance, status: mr.status } : null }; })(), humanContract: (() => { const hc0 = humanContractOf(run, artifacts), hc = hc0 && publicHumanContract(hc0); return hc && input.negativeControl !== undefined ? { ...hc, negativeControl: input.negativeControl } : hc ?? null; })(),
    scope: 'bounded observed samples only; a bounded sample can contradict a relation but never prove one; no verdict is changed by this document' };
}

export function renderNegativeDossierMarkdown(d: NegativeDossier): string {
  const cell = (v: unknown) => String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [`# Dossier de conocimiento negativo · ${d.runId}`, '', `- Universo: ${d.universeId}`, `- Modo de ejecucion: ${d.executionMode}; origen de datos: ${d.dataOrigin}`, `- Entradas: ${d.entries.length} (${Object.entries(d.byKind).map(([k, n]) => `${k}: ${n}`).join(', ') || 'ninguna'})`, `- Demostradas por muestra acotada: ${d.byClass.DEMONSTRATED} de ${d.entries.length}; no establecidas (INDETERMINATE, conflicto sin veredicto o fuera de alcance): ${d.byClass.NOT_ESTABLISHED} de ${d.entries.length}`, `- Alcance: ${d.scope}`, ...d.warnings.map(w => `- Aviso: ${w}`), ...(d.reviewOrigins.counts.HUMAN_REVIEWED + d.reviewOrigins.counts.MODEL_REVIEWED + d.reviewOrigins.counts.BOTH ? [`- Origen de la revision: HUMAN_REVIEWED ${d.reviewOrigins.counts.HUMAN_REVIEWED} de ${d.reviewOrigins.total}; MODEL_REVIEWED ${d.reviewOrigins.counts.MODEL_REVIEWED} de ${d.reviewOrigins.total}${d.reviewOrigins.counts.BOTH ? `; ambos ${d.reviewOrigins.counts.BOTH} de ${d.reviewOrigins.total}` : ''}; sin revision ${d.reviewOrigins.counts.NONE} de ${d.reviewOrigins.total}`] : []), ...(d.reviewOrigins.modelReview ? [`- MODEL_REVIEWED: ${d.reviewOrigins.modelReview.basis} (${d.reviewOrigins.modelReview.relations} relaciones, ${d.reviewOrigins.modelReview.evaluations} evaluaciones, ${d.reviewOrigins.modelReview.attacks} ataques, ${d.reviewOrigins.modelReview.tokens ?? 'tokens no disponibles'} tokens)${d.reviewOrigins.modelReview.provenance.includes('STAND_IN') ? '; procedencia STAND_IN_OFFLINE: guion offline, no un modelo' : ''}; no es revision humana`] : []), ...(d.humanContract ? [`- Base de las SOSTENIDA: ${HUMAN_CONTRACT_BASIS}. ${humanContractSentence(d.humanContract)}`, `- Relaciones diferidas: ${d.humanContract.deferred.length ? d.humanContract.deferred.map(x => `${x.id} (${x.reason})`).join('; ') : 'ninguna declarada en este run'}`, `- Control negativo (senuelos): ${d.humanContract.negativeControl === undefined ? NA : (d.humanContract.negativeControl as any)?.artifact === null ? 'pendiente de aprobacion live' : Array.isArray((d.humanContract.negativeControl as any)?.decoys) && (d.humanContract.negativeControl as any).decoys.length && (d.humanContract.negativeControl as any).decoys.every((x: any) => typeof x?.outcome === 'string') ? `${(d.humanContract.negativeControl as any).label}; ${(d.humanContract.negativeControl as any).decoys.map((x: any) => `${x.id} ${x.outcome}${insufficiencyNote(x)}`).join('; ')}` : JSON.stringify(d.humanContract.negativeControl)}`] : []), ''];
  const ordered = [...d.entries.filter(e => e.class === 'DEMONSTRATED'), ...d.entries.filter(e => e.class === 'NOT_ESTABLISHED')];
  let section = '';
  for (const entry of ordered) {
    if (entry.class !== section) { section = entry.class; lines.push(section === 'DEMONSTRATED' ? '# Demostrado: la muestra acotada contradice la relacion' : '# No establecido: no se pudo decidir, no es una refutacion', ''); }
    const ev: any = entry.evidence;
    lines.push(`## ${entry.pair.id} · ${entry.kind}`, '', `- Par: ${entry.pair.from} -> ${entry.pair.to}`, `- Veredicto: ${entry.verdict} (${entry.reasonCodes.join(', ') || NA})`);
    if (entry.incompleteness !== NA) lines.push(`- Incompletitud: ${(entry.incompleteness as Incompleteness).kind}`);
    if (entry.kind === 'DATA_QUALITY_TARGET_NOT_UNIQUE') lines.push(`- Hallazgo de calidad de datos${ev.observedInRun ? ` (medido en el run fuente ${cell(ev.observedInRun)}, no en este)` : ''}: ${cell(ev.targetColumn)} repite claves (${ev.duplicateKeyCount} claves repetidas, hasta ${ev.maxRowsPerKey} filas por clave, ${ev.rowsRead} filas leidas; observada en ${ev.probesObserving} sondas; claves de ejemplo: ${cell(ev.exampleKeys)})`);
    else if (entry.kind === 'COMA_OUT_OF_SCOPE_NOT_EXECUTABLE') lines.push(`- Sonda de cobertura: ${cell(ev.coverageProbeStatus)} (${cell(ev.coverageProbeReason)}); puntuacion COMA ${cell(ev.rawScore)}`);
    else lines.push(`- Claves: ${cell(ev.keyOverlap?.text)}; etiquetas: ${cell(ev.labelAgreement === NA ? NA : ev.labelAgreement.text)}; filas leidas: origen ${cell(ev.rowsRead?.from)}, destino ${cell(ev.rowsRead?.to)}`, `- Declarado en config: ${cell(entry.declaredInConfig)}`, `- Critica: ${cell(entry.critic)}`);
    lines.push(`- Contrafactual: ${entry.counterfactual}`, `- Procedencia: ${entry.provenance.runId} (${entry.provenance.source}; ${entry.provenance.executionMode}/${entry.provenance.dataOrigin})`, '');
  }
  return lines.join('\n');
}

/** Reads a run (engine-run.json, artifacts.json, universe config) and writes negative-dossier.json + .md. `out` is the output directory (default: the run directory). */
export function exportNegativeDossier(input: { runId: string; out?: string; runsDir?: string }): { path: string; entries: number; byKind: Record<string, number> } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.runId)) throw new SafeError('NEGATIVE_DOSSIER_INVALID_RUN_ID');
  const runDir = path.join(input.runsDir ?? path.join(ROOT, '.concordia', 'agent-runs'), input.runId);
  const read = (file: string) => fs.existsSync(path.join(runDir, file)) ? JSON.parse(fs.readFileSync(path.join(runDir, file), 'utf8')) : undefined;
  const run = read('engine-run.json');
  if (!run) throw new SafeError('NEGATIVE_DOSSIER_RUN_NOT_FOUND');
  const artifacts = read('artifacts.json');
  const configPath = resolveUniverseManifest(String(run.universeId ?? ''))?.source.configPath;
  let config: any, thresholds: any;
  const warnings: string[] = [];
  if (!configPath) warnings.push('config del universo no resoluble: los campos declaredInConfig salen como no disponible');
  else try { config = readJson(configPath); } catch (e) { warnings.push(`config del universo ilegible (${(e as Error).name}): los campos declaredInConfig salen como no disponible`); }
  try { thresholds = readJson('config/thresholds.json'); } catch (e) { warnings.push(`config/thresholds.json ilegible (${(e as Error).name}): los umbrales de los contrafactuales salen como no disponible`); }
  const nc = loadNegativeControl(runDir, run?.reviewOverlay?.negativeControl);
  const srcId = typeof (nc as any)?.sourceRun === 'string' ? (nc as any).sourceRun : undefined, srcRun = srcId && srcId !== input.runId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(srcId) ? (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(runDir), srcId, 'engine-run.json'), 'utf8')); } catch { return undefined; } })() : undefined;
  const dossier = buildNegativeDossier({ run, artifacts, config, thresholds, warnings, ...(srcRun ? { qualityRuns: [{ runId: srcId!, run: srcRun }] } : {}), modelReviewOverlay: loadModelReviewOverlay(runDir), ...(nc === undefined ? {} : { negativeControl: summarizeNegativeControl(nc) }) });
  const outDir = input.out ? path.resolve(input.out) : runDir;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'negative-dossier.json');
  fs.writeFileSync(file, JSON.stringify(dossier, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'negative-dossier.md'), renderNegativeDossierMarkdown(dossier) + '\n');
  const relative = path.relative(ROOT, file);
  const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  return { path: inside ? relative.split(path.sep).join('/') : file, entries: dossier.entries.length, byKind: dossier.byKind };
}
