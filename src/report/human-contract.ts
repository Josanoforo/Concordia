import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from '../runtime.ts';

/**
 * Etiqueta honesta de un run que uso un overlay de revision (F-04): las relaciones SOSTENIDA descansan en un contrato semantico aprobado por el humano,
 * no en un hallazgo ni una confirmacion del agente. Un solo lector para reporte, ODCS y dossier negativo, para que los tres digan lo mismo.
 * Lee run.reviewOverlay si el run lo trae; si no, lo deriva de la autorizacion congelada en las sondas (probe.evidence.reviewAuthorization con overlaySha256).
 */
export const HUMAN_CONTRACT_BASIS = 'contrato semantico aprobado por el humano';

export interface HumanContract {
  source: 'run' | 'probes' | 'overlay-file';
  package: string;
  origin: string; sha256: string; approver: string; approvedAt: string; session: string; quote: string;
  relations: string[]; deferred: { id: string; reason: string }[]; negativeControl: unknown;
}
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const arr = (v: unknown): any[] => Array.isArray(v) ? v : [];
const s = (v: unknown): string => typeof v === 'string' && v ? v : 'no disponible';

/** Texto de la cita tal como esta en la config; si quedo con doble codificacion (UTF-8 leido como latin1) se repara solo cuando el resultado es limpio. */
export function repairText(text: string): string {
  if (!/[ÂÃâ]/.test(text)) return text;
  const fixed = Buffer.from(text, 'latin1').toString('utf8');
  return fixed.includes('�') ? text : fixed;
}

/** El overlay de universes/reviews cuyo sha256 coincide con el que congelaron las sondas: de ahi salen paquete, relaciones del contrato y diferidas. Sin coincidencia exacta no se usa. */
function overlayBySha(sha256: string, dir = path.join(ROOT, 'universes', 'reviews')): any | undefined {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.review.json')) continue;
      const bytes = fs.readFileSync(path.join(dir, name));
      if (createHash('sha256').update(bytes).digest('hex') === sha256) return JSON.parse(bytes.toString('utf8'));
    }
  } catch { /* sin carpeta o archivo ilegible: no hay datos adicionales */ }
  return undefined;
}

export function humanContractOf(run: any, artifacts?: unknown): HumanContract | undefined {
  const base = humanContractBase(run, artifacts);
  if (!base) return undefined;
  const file = base.sha256 !== 'no disponible' && (base.package === 'no disponible' || !base.deferred.length || !base.relations.length) ? overlayBySha(base.sha256) : undefined;
  if (!file) return base;
  const ap = obj(file.approval);
  return { ...base, source: base.source === 'run' ? 'run' : 'overlay-file', package: base.package === 'no disponible' ? s(ap.package) : base.package,
    relations: base.relations.length && base.source !== 'probes' ? base.relations : arr(file.relations).map(r => String(obj(r).id)),
    deferred: base.deferred.length ? base.deferred : arr(file.deferred).map(d => ({ id: s(obj(d).id), reason: s(obj(d).reason) })) };
}
function humanContractBase(run: any, artifacts?: unknown): HumanContract | undefined {
  const ro = obj(run?.reviewOverlay);
  if (Object.keys(ro).length) {
    const ap = obj(ro.approval);
    return { source: 'run', package: s(ap.package), origin: s(ro.origin), sha256: s(ro.sha256), approver: s(ap.approver), approvedAt: s(ap.approvedAt), session: s(ap.session), quote: repairText(s(ap.quote)),
      relations: arr(ro.relations).map(String), deferred: arr(ro.deferred).map(d => ({ id: s(obj(d).id ?? d), reason: s(obj(d).reason) })), negativeControl: ro.negativeControl };
  }
  const probes = arr(obj(artifacts).probes).filter(p => obj(obj(p.evidence).reviewAuthorization).overlaySha256 !== undefined || obj(obj(p.evidence).reviewAuthorization).overlayOrigin !== undefined);
  if (!probes.length) return undefined;
  const ap = obj(obj(probes[0].evidence).reviewAuthorization);
  return { source: 'probes', package: s(ap.package), origin: s(ap.overlayOrigin), sha256: s(ap.overlaySha256), approver: s(ap.approver), approvedAt: s(ap.approvedAt), session: s(ap.session), quote: repairText(s(ap.quote)),
    relations: probes.map(p => String(p.relationId)), deferred: [], negativeControl: undefined };
}

/** negative-control.json del run (X4): se lee solo si el run lo nombra (negativeControl.artifact) como nombre de archivo simple dentro de la carpeta del run. */
export function loadNegativeControl(runDir: string | undefined, ref: unknown): any | undefined {
  const name = obj(ref).artifact;
  if (!runDir || typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,80}\.json$/.test(name)) return undefined;
  try { return JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8')); } catch { return undefined; }
}

/** Un senuelo que la evidencia "rechaza" porque no alcanzaron las claves distintas no esta refutado: se dice. */
export function insufficiencyNote(decoy: any): string {
  const d = obj(decoy);
  if (!arr(d.reasonCodes).includes('insufficient_distinct_sample_keys')) return '';
  const n = typeof d.distinctKeys === 'number' ? ` ${d.distinctKeys} clave${d.distinctKeys === 1 ? '' : 's'}` : '';
  return ` (evidencia insuficiente:${n || ' claves distintas por debajo del minimo'})`;
}

/** Resumen sin SQL del artefacto: etiqueta LIVE/OFFLINE, presupuesto de SQL y resultado por senuelo. */
export function summarizeNegativeControl(artifact: any): unknown {
  const a = obj(artifact);
  return { artifact: 'negative-control.json', label: s(a.label), sqlSent: a.sqlSent ?? null, sqlCeiling: a.sqlCeiling ?? null,
    decoys: arr(a.decoys).map(d => ({ id: s(obj(d).id), outcome: s(obj(d).outcome), hypotheticalVerdict: s(obj(d).hypotheticalVerdict), reasonCodes: arr(obj(d).reasonCodes).map(String), inContract: obj(d).inContract === true,
      distinctKeys: (() => { const n = arr(obj(d).sql).map(x => obj(x).distinctKeys).filter((v): v is number => typeof v === 'number'); return n.length ? Math.min(...n) : null; })() })) };
}

/** En exportaciones publicas el nombre de quien aprobo no sale: se conserva fecha, paquete y sha256 del overlay para trazabilidad. */
export const PUBLIC_APPROVER = 'project-owner';
export const publicHumanContract = <T extends { approver: string }>(c: T): T => ({ ...c, approver: PUBLIC_APPROVER });

/** Frase unica de procedencia, sin atribuir el hallazgo ni la confirmacion al agente. */
export function humanContractSentence(c: HumanContract): string {
  return `Las relaciones SOSTENIDA de este run descansan en un ${HUMAN_CONTRACT_BASIS}: lo aprobo ${c.approver} el ${c.approvedAt} (paquete: ${c.package}; sesion: ${c.session}; origen ${c.origin}; overlay sha256 ${c.sha256.slice(0, 12)}). La politica determinista solo comprueba esa declaracion con evidencia acotada; no es un hallazgo del agente.`;
}
