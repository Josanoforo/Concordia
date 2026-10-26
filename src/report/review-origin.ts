import fs from 'node:fs';
import path from 'node:path';
import { humanContractOf } from './human-contract.ts';

/**
 * Ronda 9 (R-label): el origen de la revision de cada relacion se muestra separado. HUMAN_REVIEWED = contrato aprobado por el humano;
 * MODEL_REVIEWED = "revisado por modelo con pase adversarial" (jueces que evaluan + ataques que intentan refutarlos). Nunca se confunden ni se llaman "validadas".
 *
 * Fuentes reales (R-1: la revision actua ANTES de las sondas de contrato, sobre las candidatas ciegas):
 *   phases.candidateReview = { status, mode, applied[], approved[], notApproved[], counts, label, provenance, overlayFile, overlaySha256, estimate, reason?, error? }   (engine)
 *   model-review-overlay.json (carpeta del run) = { label, provenance, counts, notApproved[], relations[], reviews: [ ModelReview ] }                                 (X8)
 *   decisions[].reviewOrigin = 'MODEL_REVIEWED' | 'HUMAN_REVIEWED'                                                                                                  (sello de X5)
 */
export const MODEL_REVIEW_BASIS = 'revisado por modelo con pase adversarial';

const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const arr = (v: unknown): any[] => Array.isArray(v) ? v : [];
const text = (v: unknown): string => v === undefined || v === null || v === '' ? '-' : typeof v === 'string' ? v : JSON.stringify(v);
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const tokensOf = (v: unknown): number | null => num(v) ?? num(obj(v).total) ?? num(obj(v).totalTokens);

export interface ModelReviewTrace {
  status: string; mode: string; reason: string; label: string; provenance: string;
  overlayFile: string; overlaySha256: string; estimate: unknown; applied: string[]; approved: string[];
  counts: Record<string, number>;
  notApproved: { relationId: string; decision: string; reasons: string[]; reviewed: boolean }[];
  reviews: { relationId: string; decision: string; confidence: string; reasons: string; adversarialPass: string; survived: number; sustained: number; tokens: number | null; calls: number | null;
    evaluations: { judge: string; status: string; decision: string; confidence: string; reasons: string; promptHash: string; requestedModel: string; model: string; tokens: number | null; truncated: boolean | null }[];
    adversaryCall: { status: string; requestedModel: string; model: string; tokens: number | null; truncated: boolean | null } | null;
    /** X10 tie-break of the sibling group (ModelReview.tieBreak): order, whether it decided, the deciding step and its values; centrality is information only. */
    tieBreak: { group: string[]; ordered: string[]; decisive: boolean; winner: string; reason: string; decidedBy: string; values: string; tied: string[]; centrality: string } | null;
    attacks: { family: string; severity: string; recommend: string; outcome: string; tokens: number | null }[] }[];
  tokens: number | null;
}

/** model-review-overlay.json del run, si existe. */
export function loadModelReviewOverlay(runDir: string | undefined): unknown {
  if (!runDir) return undefined;
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'model-review-overlay.json'), 'utf8')); } catch { return undefined; }
}

const numberMap = (v: unknown): Record<string, number> => Object.fromEntries(Object.entries(obj(v)).filter(([, x]) => typeof x === 'number')) as Record<string, number>;
/** Truncada: el campo explicito (truncated / outputTruncated) o un estado TRUNCATED; null si el run no lo registra. */
const truncatedOf = (x: Record<string, any>, call: Record<string, any>): boolean | null => { for (const v of [x.truncated, x.outputTruncated, call.truncated, call.outputTruncated]) if (typeof v === 'boolean') return v; return /TRUNCAT/i.test(text(x.status)) ? true : null; };
const sumTokens = (items: (number | null)[]): number | null => { const t = items.filter((x): x is number => x !== null); return t.length ? t.reduce((a, b) => a + b, 0) : null; };

export function modelReviewOf(run: any, overlay?: unknown): ModelReviewTrace | undefined {
  const sec = obj(obj(run?.phases).candidateReview), ov = obj(overlay);
  if (!Object.keys(sec).length && !Object.keys(ov).length) return undefined;
  const reviews = arr(ov.reviews).map(r => {
    const rv = obj(r), adv = obj(rv.adversary);
    const evaluations = arr(rv.evaluations).map(e => { const x = obj(e), call = obj(x.call); return { judge: text(x.judgeId), status: text(x.status), decision: text(x.decision), confidence: text(x.confidence),
      reasons: arr(x.reasonCodes).length ? arr(x.reasonCodes).map(String).join(', ') : '-', promptHash: text(x.promptHash), requestedModel: text(call.requestedModel ?? x.requestedModel), model: text(obj(call.receipt).model ?? obj(x.receipt).model), tokens: tokensOf(x.tokens) ?? tokensOf(call.tokens), truncated: truncatedOf(x, call) }; });
    const acall = obj(adv.call), adversaryCall = Object.keys(adv).length ? { status: text(adv.status ?? acall.status), requestedModel: text(acall.requestedModel ?? adv.requestedModel), model: text(obj(acall.receipt).model ?? obj(adv.receipt).model), tokens: tokensOf(adv.tokens) ?? tokensOf(acall.tokens), truncated: truncatedOf(adv, acall) } : null;
    const tb = obj(rv.tieBreak), tv = obj(obj(tb.vectors)[text(rv.relationId)]);
    const tieBreak = Object.keys(tb).length ? { group: arr(tb.group).map(String), ordered: arr(tb.ordered).map(String), decisive: tb.decisive === true, winner: text(tb.winner), reason: text(tb.reason), decidedBy: text(tb.decidedBy),
      values: tb.values ? `${text(obj(tb.values).winner)} contra ${text(obj(tb.values).runnerUp)}` : '-', tied: arr(tb.tied).map(String), centrality: text(tv.targetCentrality) } : null;
    const attacks = arr(adv.attacks).map(a => { const x = obj(a); return { family: text(x.family), severity: text(x.severity), recommend: text(x.recommend), outcome: text(x.outcome), tokens: tokensOf(x.tokens) }; });
    return { relationId: text(rv.relationId), decision: text(rv.decision), confidence: text(rv.confidence), reasons: arr(rv.reasons).length ? arr(rv.reasons).map(String).join(', ') : '-', adversarialPass: text(rv.adversarialPass),
      survived: arr(rv.attacksSurvived).length, sustained: arr(rv.attacksSustained).length, tokens: tokensOf(rv.tokens) ?? sumTokens([...evaluations.map(e => e.tokens), ...attacks.map(a => a.tokens)]), calls: num(rv.calls), evaluations, attacks, adversaryCall, tieBreak };
  });
  const counts = Object.keys(numberMap(sec.counts)).length ? numberMap(sec.counts) : numberMap(ov.counts);
  const notApproved = arr(sec.notApproved).length ? arr(sec.notApproved) : arr(ov.notApproved);
  return { status: text(sec.status), mode: text(sec.mode), reason: text(sec.reason ?? obj(sec.error).code), label: text(sec.label ?? ov.label ?? MODEL_REVIEW_BASIS), provenance: text(sec.provenance ?? ov.provenance),
    overlayFile: text(sec.overlayFile), overlaySha256: text(sec.overlaySha256), estimate: sec.estimate, applied: arr(sec.applied).map(String), approved: arr(sec.approved).map(String), counts,
    notApproved: notApproved.map(n => ({ relationId: text(obj(n).relationId), decision: text(obj(n).decision), reasons: arr(obj(n).reasons).map(String), reviewed: obj(n).reviewed === true })),
    reviews, tokens: num(counts.tokens) ?? sumTokens(reviews.map(r => r.tokens)) };
}

export type ReviewOrigin = 'HUMAN_REVIEWED' | 'MODEL_REVIEWED' | 'BOTH' | 'NONE';
/** Origen de la revision de cada decision del run, segun el sello decisions[].reviewOrigin (o el del contrato de la sonda). BOTH solo se reporta como tal, nunca se resuelve en silencio. */
export function reviewOriginsOf(run: any, artifacts?: unknown): { byRelation: Map<string, ReviewOrigin>; counts: Record<ReviewOrigin, number>; total: number } {
  const hc = humanContractOf(run, artifacts);
  const probes = new Map(arr(obj(artifacts).probes).map(p => [text(p.relationId), obj(p)]));
  const byRelation = new Map<string, ReviewOrigin>(), counts: Record<ReviewOrigin, number> = { HUMAN_REVIEWED: 0, MODEL_REVIEWED: 0, BOTH: 0, NONE: 0 };
  for (const d of arr(run?.decisions)) {
    const id = text(d.relationId), ev = obj(obj(probes.get(id)).evidence);
    const isModel = d.reviewOrigin === 'MODEL_REVIEWED' || obj(ev.relationContract).reviewOrigin === 'MODEL_REVIEWED';
    const isHuman = d.reviewOrigin === 'HUMAN_REVIEWED' || obj(ev.relationContract).reviewOrigin === 'HUMAN_REVIEWED' || (!isModel && hc !== undefined && (hc.relations.length ? hc.relations.includes(id) : obj(ev.reviewAuthorization).approver !== undefined));
    const origin: ReviewOrigin = isModel && isHuman ? 'BOTH' : isModel ? 'MODEL_REVIEWED' : isHuman ? 'HUMAN_REVIEWED' : 'NONE';
    byRelation.set(id, origin); counts[origin]++;
  }
  return { byRelation, counts, total: arr(run?.decisions).length };
}
