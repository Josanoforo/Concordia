/**
 * Builds what a judge may see from the post-COMA proposals of a run. The input shapes are structural (the fields read here), so this module does not
 * track changes in post-coma.ts; tests run it against a real run fixture. Only counts and names leave the run: no sampled key values, no row content.
 */
import { ONE_TO_ONE_MEANING, SOURCE_KEYS_BASES, type SourceKeysBasis, type Endpoint, type GlobalUniqueness, type KeyStats, type NegativeControlEntry, type OneToOneTrait, type ReviewPacket, type SiblingInfo, type TieBreakAudit, type TieBreakInfo, type TieBreakMode, type UnprobedCandidate, type WilsonBound } from './types.ts';

interface RowShape { rows?: number; distinctKeys?: number; maxRowsPerKey?: number }
export interface ProbedProposalInput {
  proposalId: string;
  from: Endpoint & { db?: string };
  to: Endpoint & { db?: string };
  rawScore?: number;
  coverageProbe?: {
    status?: string; reason?: string;
    diagnostic?: {
      coverage?: { level?: string; matched?: number; probed?: number; threshold?: number | null };
      labels?: { signal?: string; agree?: number; compared?: number };
      suspect?: { value?: boolean; reasons?: readonly string[]; preferredTarget?: string };
      /** `from.fromBasis` (X4's `diagnose`) says what `from.distinctKeys` counts; absent means the discovery sample. `fromBasis` at this level is read too, as the first agreed name. */
      multiplicity?: { from?: RowShape & { fromBasis?: string }; to?: RowShape; fromBasis?: string };
      keyRules?: { inclusion?: { status?: string; missingCount?: number }; targetUniqueness?: { status?: string; duplicateKeyCount?: number } };
    };
  };
  structure?: { from?: string; to?: string; rankClass?: string; targetDeclaredKey?: boolean; orientation?: string; globalUniqueness?: { from?: string; to?: string; relationKind?: string } };
}
/**
 * What the caller (the engine, with the pure functions of src/agent/tie-break.ts) answers for a group of tied relations: the order, whether it is decisive, and the traits behind it.
 * `decidedBy`, `siblings` and `trace` are X10's `TieOrdering` fields; with them the compact packet block can name the deciding step and the two values.
 */
export interface TieTraceLike { step: string; outcome: string; values: Readonly<Record<string, string>>; eliminated: readonly string[] }
export interface TieBreakAnswer {
  ordered: readonly string[]; decisive: boolean; reason: string;
  decidedBy?: string | null; siblings?: readonly string[]; trace?: readonly TieTraceLike[];
  vectors?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Anything else worth keeping in the audit (X10: raw vectors and trace). Bounded. */
  detail?: unknown;
}
export type TieBreakResolver = (group: readonly string[]) => TieBreakAnswer | undefined;
/** Structural shape of X10's `TieOrdering` (src/agent/tie-break.ts), so the engine can hand it over without importing this module's types. */
export interface TieOrderingLike {
  ordered: readonly { id: string }[]; decisive: boolean; reason: string; decidedBy: string | null; siblings: readonly string[];
  vectors: readonly { candidateId: string }[]; trace: readonly TieTraceLike[];
}
/** Adapter: X10's `orderTies(...)` result as the answer a resolver returns. Features are flattened to their value or NOT_MEASURED; the raw vectors and trace go to the audit detail. */
export function tieBreakFromOrdering(ordering: TieOrderingLike): TieBreakAnswer {
  const flat = (feature: unknown) => { const f = feature as { status?: string; value?: unknown } | null; return f && f.status === 'MEASURED' ? f.value : 'NOT_MEASURED'; };
  const vectors = Object.fromEntries(ordering.vectors.map(vector => [vector.candidateId, Object.fromEntries(Object.entries(vector as Record<string, unknown>).filter(([key]) => key !== 'candidateId').map(([key, feature]) => [key, flat(feature)]))]));
  return { ordered: ordering.ordered.map(item => item.id), decisive: ordering.decisive, reason: ordering.reason, decidedBy: ordering.decidedBy, siblings: ordering.siblings, trace: ordering.trace, vectors, detail: { vectors: ordering.vectors, trace: ordering.trace } };
}
export interface PacketContext {
  universeId?: string;
  minDistinctKeys: number;
  /** Column names per table (metadata only), if the caller has them. */
  tableColumns?: Readonly<Record<string, readonly string[]>>;
  /** Alternative endpoints that were probed for the same source or target (decoys, negative control), keyed by relation id or by `table.column`. */
  negativeControl?: readonly (NegativeControlEntry & { appliesTo: string })[];
  maxSiblings?: number;
  /** Measured whole-table uniqueness of columns, keyed `table.column` (the engine's F1 for HIGH candidates with tied siblings). */
  globalTargetUniqueness?: Readonly<Record<string, GlobalUniqueness>>;
  /** Tie-break of the sibling group (this relation plus the candidates that share its source), by relation ids. Absent or undefined: the tie stands. */
  tieBreak?: TieBreakResolver;
  /** 'compact' (default): winner, decisive, deciding step and its two values, tied siblings. 'full': the whole order and every member's traits in the prompt too (audits). The audit record always keeps the full one. */
  tieBreakMode?: TieBreakMode;
}

/** Wilson score interval (95%) of matched/probed: 5/5 and 49/49 have the same rate and very different bounds. Undefined when nothing was probed. */
export function wilsonBound(matched: number, probed: number): WilsonBound | undefined {
  if (!Number.isFinite(matched) || !Number.isFinite(probed) || probed <= 0 || matched < 0 || matched > probed) return undefined;
  const z = 1.96, p = matched / probed, n = probed, z2 = z * z, denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator, margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  return { lower: round(centre - margin), upper: round(centre + margin), confidence: 0.95, method: 'wilson' };
}

const MAX_NAME = 80;
/** Names are data, not instructions: control characters out, bounded length. */
export const cleanName = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NAME);
const endpointKey = (e: Endpoint) => `${e.table}.${e.column}`;
/** Anything but a known basis is the discovery sample: the packet never claims a wider read than the diagnostic says it made. */
const sourceKeysBasis = (value: unknown): SourceKeysBasis => (SOURCE_KEYS_BASES.find(basis => basis === value) ?? 'DISCOVERY_SAMPLE');
const stats = (shape: RowShape | undefined): KeyStats => ({ rows: shape?.rows ?? 0, distinctKeys: shape?.distinctKeys ?? 0, maxRowsPerKey: shape?.maxRowsPerKey ?? 0 });

export const LIMITATIONS = [
  'bounded sample: not a global coverage or uniqueness claim',
  'key membership alone cannot tell a homonym apart from the true relation',
  'a model review is not a human review'
];

/** A step whose winner is not evidence of the entity: it chose a spurious hub in 20 of 20 cases of the TPCDS fixture (X10 is removing it; this keeps an older resolver honest). */
export const NON_DECISIVE_STEPS: readonly string[] = ['TARGET_CENTRALITY'];
const MAX_DETAIL_CHARS = 20_000;
const reasonCode = (reason: string) => cleanName(reason.split(':')[0]);
const scalar = (value: unknown): string | number | boolean | null | undefined => value === null || typeof value === 'number' || typeof value === 'boolean' ? value : typeof value === 'string' ? cleanName(value) : undefined;

/** The resolver's answer, validated against the group: ids outside the group, or a resolver that throws, leave the tie standing (nothing is added to the packet). */
function resolveTie(resolver: TieBreakResolver | undefined, group: readonly string[]): { answer: TieBreakAnswer; decisive: boolean; winnerId?: string; guard?: string; values?: { winner: string; runnerUp: string }; decidedBy?: string } | undefined {
  if (!resolver) return undefined;
  let answer: TieBreakAnswer | undefined;
  try { answer = resolver(group); } catch { return undefined; }
  if (!answer || !Array.isArray(answer.ordered) || !answer.ordered.length || !answer.ordered.every(id => group.includes(id))) return undefined;
  const decidedBy = typeof answer.decidedBy === 'string' ? cleanName(answer.decidedBy) : undefined;
  const guard = answer.decisive === true && decidedBy && NON_DECISIVE_STEPS.includes(decidedBy) ? `${decidedBy}_NOT_DECISIVE` : undefined;
  const decisive = answer.decisive === true && !guard, winnerId = decisive ? answer.ordered[0]! : undefined;
  let values: { winner: string; runnerUp: string } | undefined;
  if (decisive && decidedBy && answer.trace) {
    const step = [...answer.trace].reverse().find(item => item.step === decidedBy && item.outcome === 'SEPARATED'), runnerUp = answer.ordered[1];
    if (step && winnerId && runnerUp && step.values[winnerId] !== undefined && step.values[runnerUp] !== undefined) values = { winner: cleanName(step.values[winnerId]), runnerUp: cleanName(step.values[runnerUp]) };
  }
  return { answer, decisive, ...(winnerId ? { winnerId } : {}), ...(guard ? { guard } : {}), ...(values ? { values } : {}), ...(decidedBy && decisive ? { decidedBy } : {}) };
}

function tieVectors(answer: TieBreakAnswer, group: readonly string[]): Record<string, Record<string, string | number | boolean | null>> {
  const vectors: Record<string, Record<string, string | number | boolean | null>> = {};
  for (const [id, traits] of Object.entries(answer.vectors ?? {})) {
    if (!group.includes(id)) continue;
    const entries = Object.entries(traits).map(([key, value]) => [cleanName(key), scalar(value)] as const).filter((entry): entry is readonly [string, string | number | boolean | null] => entry[1] !== undefined).slice(0, 16);
    vectors[id] = Object.fromEntries(entries);
  }
  return vectors;
}
const boundedDetail = (detail: unknown): unknown => { try { const text = JSON.stringify(detail); return text !== undefined && text.length <= MAX_DETAIL_CHARS ? JSON.parse(text) : text === undefined ? undefined : { truncated: true, chars: text.length }; } catch { return undefined; } };

/** The block the prompt carries (compact unless `mode` is 'full'), from the siblings as they appear in the packet. */
function compactTie(resolved: NonNullable<ReturnType<typeof resolveTie>>, relationId: string, group: readonly string[], siblings: readonly SiblingInfo[], mode: TieBreakMode): TieBreakInfo {
  const { answer } = resolved, indexOf = (id: string) => siblings.findIndex(sibling => sibling.relationId === id);
  const winner = resolved.winnerId === undefined ? undefined : resolved.winnerId === relationId ? 'THIS' : indexOf(resolved.winnerId) >= 0 ? `siblings[${indexOf(resolved.winnerId)}]` : 'OTHER';
  const tied = resolved.decisive ? [] : (answer.siblings ?? []).filter(id => id !== relationId).map(indexOf).filter(index => index >= 0);
  return {
    decisive: resolved.decisive, ...(winner ? { winner } : {}), reason: resolved.guard ?? reasonCode(answer.reason),
    ...(resolved.decidedBy ? { decidedBy: resolved.decidedBy } : {}), ...(resolved.values ? { values: resolved.values } : {}), ...(tied.length ? { tiedWith: tied } : {}), mode,
    ...(mode === 'full' ? { full: { group: [...group], ordered: [...answer.ordered], sentence: cleanName(answer.reason), ...(Object.keys(tieVectors(answer, group)).length ? { vectors: tieVectors(answer, group) } : {}) } } : {})
  };
}
function auditTie(resolved: NonNullable<ReturnType<typeof resolveTie>>, group: readonly string[]): TieBreakAudit {
  const { answer } = resolved, vectors = tieVectors(answer, group), detail = boundedDetail(answer.detail);
  return { group: [...group], ordered: [...answer.ordered], decisive: resolved.decisive, ...(resolved.winnerId ? { winner: resolved.winnerId } : {}), reason: String(answer.reason ?? '').slice(0, 300),
    ...(resolved.decidedBy ? { decidedBy: resolved.decidedBy } : {}), ...(resolved.values ? { values: resolved.values } : {}), ...(!resolved.decisive && answer.siblings?.length ? { tied: [...answer.siblings] } : {}),
    ...(Object.keys(vectors).length ? { vectors } : {}), ...(detail !== undefined ? { detail } : {}), ...(resolved.guard ? { guard: resolved.guard } : {}) };
}

/** ONE_TO_ONE_EXTENSION as a packet trait: X4's rank class or relation kind, or (until X4 moves it) the old suspect reason. */
export function oneToOneTraitOf(proposal: ProbedProposalInput): OneToOneTrait | undefined {
  const structure = proposal.structure, reasons = proposal.coverageProbe?.diagnostic?.suspect?.reasons ?? [];
  if (structure?.rankClass !== 'ONE_TO_ONE' && structure?.globalUniqueness?.relationKind !== 'EXTENSION_ONE_TO_ONE' && !reasons.includes('ONE_TO_ONE_EXTENSION')) return undefined;
  const side = (value: string | undefined): GlobalUniqueness | 'NOT_MEASURED' => value === 'UNIQUE' || value === 'NOT_UNIQUE' ? value : 'NOT_MEASURED';
  return { globalUniqueness: { source: side(structure?.globalUniqueness?.from ?? 'UNIQUE'), target: side(structure?.globalUniqueness?.to ?? 'UNIQUE') }, meaning: ONE_TO_ONE_MEANING };
}

/** The suspect reasons that exclude a candidate from the review: everything except the 1:1 trait. */
export const suspicionReasons = (reasons: readonly string[] | undefined): string[] => (reasons ?? []).filter(reason => reason !== 'ONE_TO_ONE_EXTENSION');

/** True when the proposal has a probe with a diagnostic, i.e. real evidence to judge. */
export function hasProbeEvidence(proposal: ProbedProposalInput): boolean {
  return proposal.coverageProbe?.status === 'EXECUTED' && Boolean(proposal.coverageProbe.diagnostic?.coverage && proposal.coverageProbe.diagnostic.multiplicity);
}

export function buildPackets(proposals: readonly ProbedProposalInput[], context: PacketContext): { packets: ReviewPacket[]; unprobed: UnprobedCandidate[]; audits: Record<string, TieBreakAudit> } {
  const packets: ReviewPacket[] = [], unprobed: UnprobedCandidate[] = [], audits: Record<string, TieBreakAudit> = {};
  const maxSiblings = context.maxSiblings ?? 6;
  for (const proposal of proposals) {
    const source: Endpoint = { table: cleanName(proposal.from.table), column: cleanName(proposal.from.column) }, target: Endpoint = { table: cleanName(proposal.to.table), column: cleanName(proposal.to.column) };
    if (!hasProbeEvidence(proposal)) { unprobed.push({ relationId: proposal.proposalId, source, target, reason: proposal.coverageProbe?.reason ?? proposal.coverageProbe?.status ?? 'NO_PROBE' }); continue; }
    const diagnostic = proposal.coverageProbe!.diagnostic!;
    const coverage = diagnostic.coverage!;
    const level = coverage.level === 'HIGH' || coverage.level === 'LOW' ? coverage.level : 'NONE';
    const inclusionStatus = diagnostic.keyRules?.inclusion?.status, missingCount = diagnostic.keyRules?.inclusion?.missingCount ?? 0;
    const uniquenessStatus = diagnostic.keyRules?.targetUniqueness?.status;
    const siblings: SiblingInfo[] = [];
    const sameSourceTable = (other: ProbedProposalInput) => cleanName(other.from.table) === source.table && cleanName(other.from.column) !== source.column;
    for (const other of proposals) {
      if (other === proposal || other.proposalId === proposal.proposalId) continue;
      const shares = endpointKey(other.from) === endpointKey(source) ? 'SOURCE' : endpointKey(other.to) === endpointKey(target) ? 'TARGET' : undefined;
      if (!shares) continue;
      const cov = other.coverageProbe?.diagnostic?.coverage;
      const otherEnd = shares === 'SOURCE' ? other.to : other.from;
      const otherGlobal = shares === 'SOURCE' ? context.globalTargetUniqueness?.[endpointKey(otherEnd)] : undefined;
      siblings.push({ relationId: other.proposalId, shares, ...(shares === 'TARGET' && sameSourceTable(other) ? { role: true as const } : {}), ...(otherGlobal ? { otherGlobalUniqueness: otherGlobal } : {}), other: shares === 'SOURCE' ? { table: cleanName(other.to.table), column: cleanName(other.to.column) } : { table: cleanName(other.from.table), column: cleanName(other.from.column) },
        executed: hasProbeEvidence(other), ...(cov && typeof cov.matched === 'number' && typeof cov.probed === 'number' ? { coverage: { matched: cov.matched, probed: cov.probed } } : {}) });
    }
    // Executed siblings first (they carry evidence), then the rest in input order; capped so a hub column does not blow the prompt.
    siblings.sort((a, b) => Number(b.executed) - Number(a.executed));
    // E2-04: other columns of the source table that point at the same target column are roles of one dimension, not alternatives.
    const roleColumns = siblings.filter(sibling => sibling.role).map(sibling => sibling.other.column);
    const tied = [proposal.proposalId, ...siblings.filter(sibling => sibling.shares === 'SOURCE').map(sibling => sibling.relationId)];
    const resolvedTie = tied.length > 1 ? resolveTie(context.tieBreak, tied) : undefined;
    // An entry about the relation's own other endpoint is the relation itself (the decoy under review), not a control for it.
    const negativeControl = (context.negativeControl ?? []).filter(item => item.appliesTo === proposal.proposalId || ((item.appliesTo === endpointKey(source) || item.appliesTo === endpointKey(target))
      && endpointKey(item.other) !== endpointKey(item.shares === 'SOURCE' ? target : source)))
      .map(({ appliesTo: _appliesTo, ...entry }) => entry);
    const shownSiblings = siblings.slice(0, maxSiblings), oneToOne = oneToOneTraitOf(proposal);
    if (resolvedTie) audits[proposal.proposalId] = auditTie(resolvedTie, tied);
    const columnsOf = (endpoint: Endpoint) => context.tableColumns?.[endpoint.table]?.map(cleanName);
    const orientation = proposal.structure?.orientation === 'AS_PROPOSED' || proposal.structure?.orientation === 'SWAPPED_TARGET_UNIQUE' ? proposal.structure.orientation : 'UNKNOWN';
    packets.push({
      relationId: proposal.proposalId,
      ...(context.universeId ? { universeId: context.universeId } : {}),
      source: { ...source, ...(columnsOf(source) ? { tableColumns: columnsOf(source) } : {}) },
      target: { ...target, ...(columnsOf(target) ? { tableColumns: columnsOf(target) } : {}), ...(context.globalTargetUniqueness?.[endpointKey(target)] ? { globalUniqueness: context.globalTargetUniqueness[endpointKey(target)] } : {}) },
      orientation,
      coverage: { level, matched: coverage.matched ?? 0, probed: coverage.probed ?? 0, threshold: coverage.threshold ?? null, ...(wilsonBound(coverage.matched ?? 0, coverage.probed ?? 0) ? { wilson: wilsonBound(coverage.matched ?? 0, coverage.probed ?? 0)! } : {}) },
      sourceKeys: { ...stats(diagnostic.multiplicity!.from), basis: sourceKeysBasis(diagnostic.multiplicity!.from?.fromBasis ?? diagnostic.multiplicity!.fromBasis) }, targetKeys: stats(diagnostic.multiplicity!.to),
      keyRules: {
        inclusion: inclusionStatus === 'NO_VIOLATION_IN_SAMPLE' ? 'NO_VIOLATION_IN_SAMPLE' : inclusionStatus === 'VIOLATED_IN_SAMPLE' || missingCount > 0 ? 'VIOLATION_OBSERVED' : 'UNKNOWN', missingCount,
        targetUniqueness: uniquenessStatus === 'NO_DUPLICATES_IN_SAMPLE' ? 'NO_DUPLICATES_IN_SAMPLE' : uniquenessStatus === 'DUPLICATES_OBSERVED' ? 'DUPLICATES_OBSERVED' : 'UNKNOWN',
        duplicateKeyCount: diagnostic.keyRules?.targetUniqueness?.duplicateKeyCount ?? 0
      },
      ...(proposal.structure ? { structure: { sourceShape: String(proposal.structure.from ?? 'UNKNOWN'), targetShape: String(proposal.structure.to ?? 'UNKNOWN'), rankClass: String(proposal.structure.rankClass ?? 'UNKNOWN'), targetDeclaredKey: proposal.structure.targetDeclaredKey === true } } : {}),
      labels: { signal: (['LABEL_CONFLICT', 'LABEL_UNCERTAIN', 'LABELS_AGREE'] as const).find(signal => signal === diagnostic.labels?.signal) ?? 'NOT_COMPARABLE',
        ...(typeof diagnostic.labels?.agree === 'number' ? { agree: diagnostic.labels.agree } : {}), ...(typeof diagnostic.labels?.compared === 'number' ? { compared: diagnostic.labels.compared } : {}) },
      ...(diagnostic.suspect?.value && suspicionReasons(diagnostic.suspect.reasons).length ? { suspect: { reasons: suspicionReasons(diagnostic.suspect.reasons).map(cleanName), ...(diagnostic.suspect.preferredTarget ? { preferredTarget: cleanName(diagnostic.suspect.preferredTarget) } : {}) } } : {}),
      minDistinctKeys: context.minDistinctKeys,
      siblings: shownSiblings,
      ...(roleColumns.length ? { roles: { target, sourceColumns: [source.column, ...roleColumns] } } : {}),
      ...(resolvedTie ? { tieBreak: compactTie(resolvedTie, proposal.proposalId, tied, shownSiblings, context.tieBreakMode ?? 'compact') } : {}),
      ...(oneToOne ? { oneToOne } : {}),
      negativeControl,
      limitations: [...LIMITATIONS]
    });
  }
  return { packets, unprobed, audits };
}

/**
 * A decoy from the live negative-control artifact (`negative-control.json`) as a NegativeControlEntry for the real relation it shares an endpoint with.
 * `passedMembership` is true when the hypothetical verdict came from key membership (SOSTENIDA): the evidence did not discriminate.
 */
export function negativeControlEntries(artifact: { decoys?: readonly { id: string; from: string; to: string; hypotheticalVerdict?: string; outcome?: string; sql?: readonly { side: string; rows: number; distinctKeys: number }[] }[] } | undefined): (NegativeControlEntry & { appliesTo: string })[] {
  const out: (NegativeControlEntry & { appliesTo: string })[] = [];
  for (const decoy of artifact?.decoys ?? []) {
    const split = (text: string) => { const index = text.indexOf('.'); return { table: cleanName(text.slice(0, index)), column: cleanName(text.slice(index + 1)) }; };
    const from = split(decoy.from), to = split(decoy.to);
    const passed = decoy.hypotheticalVerdict === undefined ? undefined : decoy.hypotheticalVerdict === 'SOSTENIDA';
    // The decoy shares its SOURCE column with the real relation(s) of that column, and records the alternative TARGET it also reached.
    out.push({ id: cleanName(decoy.id), shares: 'SOURCE', other: to, appliesTo: endpointKey(from), ...(passed !== undefined ? { passedMembership: passed } : {}), ...(decoy.hypotheticalVerdict ? { hypotheticalVerdict: decoy.hypotheticalVerdict } : {}), ...(decoy.outcome ? { outcome: decoy.outcome } : {}) });
  }
  return out;
}

/**
 * Decision R-1: the model review acts on blind candidates BEFORE the contract probes, as the human F-04 did: executed probe, HIGH coverage, no suspicion.
 * Anything else is not sent to a model and gets no contract; the reason is returned so it is recorded rather than silently skipped.
 */
export function reviewEligibility(proposal: ProbedProposalInput): { eligible: true } | { eligible: false; reason: string } {
  if (!hasProbeEvidence(proposal)) return { eligible: false, reason: proposal.coverageProbe?.reason ?? proposal.coverageProbe?.status ?? 'NO_PROBE' };
  const diagnostic = proposal.coverageProbe!.diagnostic!;
  if (diagnostic.coverage?.level !== 'HIGH') return { eligible: false, reason: `COVERAGE_${diagnostic.coverage?.level ?? 'UNKNOWN'}` };
  // ONE_TO_ONE_EXTENSION is an evidence trait, not a suspicion (X4): it reaches the review with its explanation. Any other reason still excludes.
  if (diagnostic.suspect?.value && (suspicionReasons(diagnostic.suspect.reasons).length || !(diagnostic.suspect.reasons ?? []).length)) return { eligible: false, reason: `SUSPECT:${suspicionReasons(diagnostic.suspect.reasons).join(',') || 'UNSPECIFIED'}` };
  return { eligible: true };
}
