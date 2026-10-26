import { identifier, type Zetaris } from '../clients/zetaris.ts';
import type { OutOfScopeProposal } from '../discovery/candidates.ts';
import { zetarisSourceQuery } from '../relations/adapters/zetaris.ts';
import { failure, readJson, SafeError, trace } from '../runtime.ts';
import { normalizeKey, type NormalizationMode } from '../universe.ts';
import { FORBIDDEN_COLUMN, SAFE_LITERAL, type ExplorationCatalog } from './catalog.ts';
import { compareLabels, measureContainment, measureMultiplicity, type Containment, type RowMultiplicity } from '../probe/index.ts';
import { evaluateKeyRules, type KeyRules } from '../probe/key-rules.ts';
import type { RunBudget } from './run-budget.ts';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ColumnProfile } from '../probe/column-profile.ts';
import { degenerateSampleColumns, widenSourcePool, type SourcePoolReader, type SourcePoolTrace } from '../probe/sampling.ts';
import type { TieCandidate, TieOrdering } from './tie-break.ts';

/** A coverage probe reads the target once: one bounded SQL statement. The source values come from the discovery sample. */
export const COVERAGE_PROBE_QUERY_COST = 1;
export const DEFAULT_POST_COMA = { maxProbes: 2 } as const;
export type CoverageProbeStatus = 'EXECUTED' | 'SUGGESTED' | 'NOT_EXECUTABLE' | 'SKIPPED_BUDGET' | 'FAILED';
export interface CoverageProbe {
  kind: 'COVERAGE_PROBE'; status: CoverageProbeStatus; reason?: string; sql?: string;
  result?: { sampledSourceValues: number; probedValues: number; targetMatches: number; ratio: number | null; rows: number; queryId: string; requestId: string;
    normalization?: { mode: NormalizationMode; source: 'RELATION' | 'UNIVERSE_DEFAULT'; relationId?: string; unnormalizableValues: number } };
  error?: object;
  /** E3-07a: where the source keys came from when the run has a source-pool reader (the discovery sample or the global F4 read), with the queryIds. */
  sampling?: SourcePoolTrace;
  /** Diagnostic evidence for an executed probe over bounded samples. Never a verdict: the proposal stays a candidate that needs human review. */
  diagnostic?: CandidateDiagnostic;
}
export type LabelSignal = 'LABEL_CONFLICT' | 'LABEL_UNCERTAIN' | 'LABELS_AGREE' | 'NOT_COMPARABLE';
export interface CandidateDiagnostic {
  coverage: { level: 'HIGH' | 'LOW' | 'NONE'; matched: number; probed: number; threshold: number | null };
  labels: { signal: LabelSignal; agree?: number; compared?: number; ratio?: number; fromColumns?: string[]; toColumns?: string[]; reason?: string; examples?: unknown[] };
  multiplicity: { from: RowMultiplicity & { fromBasis: 'DISCOVERY_SAMPLE' | 'GLOBAL_DISTINCT_F4' }; to: RowMultiplicity };
  containment: Containment;
  keyRules: KeyRules;
  suspect: { value: boolean; reasons: ('LABEL_CONFLICT' | 'LABEL_UNCERTAIN' | 'LOW_COVERAGE' | 'NO_COVERAGE' | 'TARGET_NOT_UNIQUE' | 'KEY_TO_KEY' | 'COMPETING_TARGET' | 'RANGE_BIASED')[]; /** COMPETING_TARGET only: the accepted target of the same source column whose name matches better. */ preferredTarget?: string };
  /** Evidence traits that never exclude a candidate from review. ONE_TO_ONE_EXTENSION: both ends are globally unique (EXTENSION_ONE_TO_ONE); judges and adversary weigh it. */
  traits?: 'ONE_TO_ONE_EXTENSION'[];
  /** E2-06, only with whole-table profiles: where the probed source keys fall inside the target's key range. A suspicion with its numbers, never a verdict. */
  rangeBias?: RangeBiasEvidence;
  /** E2-04: the target is a role dimension (several source columns of the same table reference it), so it is never the loser of a homonym competition. */
  roleDimension?: { targetTable: string; sourceColumns: string[] };
  /** X10 tie-break vector, present when it decided a competition between targets. */
  tieBreak?: { decidedBy: string; reason: string };
  governance: 'CANDIDATE_REQUIRES_REVIEW';
  counterfactual: string;
}
/** Fraction of the target's key range (from its minimum) that counts as a short prefix. A tuning parameter, not a measured threshold; it is reported with every flag. */
export const RANGE_PREFIX_FRACTION = 0.1;
export interface RangeBiasEvidence { probedMin: number; probedMax: number; targetMin: number; targetMax: number; prefixFraction: number; provenance: 'GLOBAL_WHOLE_TABLE'; flagged: boolean }
export type GlobalUniqueness = 'UNIQUE' | 'NOT_UNIQUE' | 'NOT_MEASURED';
/** Whole-table reader for one column (X7's cached F1/F1x). Absent: every rule that needs it stays off. */
export type ProfileSource = (endpoint: { db?: string; table: string; column: string }) => Promise<ColumnProfile | undefined>;
/** X10's pure tie-break, injected so post-COMA compiles and tests without it. */
export interface TieBreaker { orderTies: <T extends TieCandidate>(group: readonly T[], context?: { candidates?: readonly TieCandidate[] }) => TieOrdering<T> }
export interface PostComaProposal {
  proposalId: string; from: OutOfScopeProposal['from']; to: OutOfScopeProposal['to']; rawScore: number; reason: string;
  verificationStatus: 'NO VERIFICADO/UNKNOWN'; reviewState: 'PENDING'; coverageProbe: CoverageProbe;
  /** Blind discovery only: what the discovery samples say about each endpoint, and whether the pair was turned so the unique side is the target. */
  structure?: { from: KeyShape; to: KeyShape; rankClass: 'KEY_CANDIDATE' | 'BOTH_SIDES_DUPLICATED' | 'KEY_TO_KEY' | 'ONE_TO_ONE'; targetDeclaredKey: boolean; orientation: 'AS_PROPOSED' | 'SWAPPED_TARGET_UNIQUE' | 'SWAPPED_GLOBAL_UNIQUENESS';
    /** E2-02: set when the sample could not orient the pair and whole-table profiles were consulted. ONE_TO_ONE = both ends globally unique (EXTENSION_ONE_TO_ONE): no FK contract without review. */
    globalUniqueness?: { from: GlobalUniqueness; to: GlobalUniqueness; provenance: 'GLOBAL_WHOLE_TABLE'; relationKind?: 'EXTENSION_ONE_TO_ONE' }; proposedFrom?: OutOfScopeProposal['from']; proposedTo?: OutOfScopeProposal['to'] };
}
/** What a table's discovery sample shows about one column: repeated values, no repeated values over at least two rows, or nothing conclusive. */
export type KeyShape = 'DUPLICATES_OBSERVED' | 'UNIQUE_IN_SAMPLE' | 'UNKNOWN';
export interface PostComaReport {
  status: 'NONE' | 'SUGGESTED_ONLY' | 'EXECUTED' | 'PARTIAL' | typeof COMA_FAILED | typeof BUDGET_REQUIRED;
  /** Present only with status COMA_FAILED: the COMA provider's errors, copied. */
  errors?: { code: string; scope?: string }[];
  /** `estimatedQueries`: SQL this stage plans to spend (probes it can still select x cost); `queriesAvailable`: what the run budget still allows it. */
  policy: { maxProbes: number; ranking: string; costPerProbe: number; equality: string; estimatedQueries: number; queriesAvailable: number; /** E1-03: probes reused from the journal of an interrupted run; their SQL is already subtracted from estimatedQueries. */ resumedProbes?: number; /** E3-07a: F4 reads for degenerate source samples, already included in estimatedQueries. */ f4Reads?: number; coverAll?: boolean; budgetShortfall?: { needed: number; available: number; action: 'BUDGET_REQUIRED' | 'CUT_TO_AVAILABLE_BY_RANKING' } };
  /** Present only when a previous run was offered as ranking input: whether it applied and which pairs it kept out of the probe slots. */
  priorRun?: { applied: boolean; reason?: string; skipped: { proposalId: string; outcome: PriorOutcome }[] };
  proposals: PostComaProposal[]; counts: { proposals: number; executed: number; suggested: number; notExecutable: number; skippedBudget: number; failed: number };
  /** Executable candidates that did not get a probe because of the probe cap or the query budget, in ranking order. */
  notExecutedByBudget: { proposalId: string; rawScore: number; reason: string }[];
  limitations: string[];
}

/**
 * Ranking input from a previous run of the SAME origin-sealed scope (universe, execution mode, data origin). It decides only which pairs are probed and in which order:
 * a pair that run already demonstrated (accepted or negative) is not probed again and unprobed pairs move up. It never reaches a probe result, a diagnostic or a verdict.
 */
export type PriorOutcome = 'ACCEPTED' | 'NEGATIVE';
export interface PostComaScope { universeId: string; executionMode: string; dataOrigin: string }
export interface PostComaPrior { scope: PostComaScope; pairs: { from: { db: string; table: string; column: string }; to: { db: string; table: string; column: string }; outcome: PriorOutcome }[] }
/** The previous run's own post-COMA report as ranking input: executed probes only, accepted when HIGH and unsuspected, negative otherwise. No gold, no verdict. */
export function priorFromRun(run: { postComa?: { proposals?: readonly PostComaProposal[] } }, scope: PostComaScope): PostComaPrior {
  const pairs: PostComaPrior['pairs'] = [];
  for (const item of run.postComa?.proposals ?? []) {
    const d = item.coverageProbe?.status === 'EXECUTED' ? item.coverageProbe.diagnostic : undefined;
    if (d) pairs.push({ from: item.from, to: item.to, outcome: d.coverage.level === 'HIGH' && !d.suspect.value ? 'ACCEPTED' : 'NEGATIVE' });
  }
  return { scope, pairs };
}
const sameScope = (a: PostComaScope, b: PostComaScope) => a.universeId === b.universeId && a.executionMode === b.executionMode && a.dataOrigin === b.dataOrigin;

/** COMA itself failed (bridge down, contract broken): different from COMA finding nothing, which is NONE. The engine degrades the run on it. */
export const COMA_FAILED = 'COMA_FAILED' as const;
/** Cover-all mode and the run budget cannot pay for every candidate: nothing was probed and the budget needed is reported. */
export const BUDGET_REQUIRED = 'BUDGET_REQUIRED' as const;
export interface ComaProductionOutcome { providerStates: readonly { providerId: string; status: string }[]; errors: readonly { providerId: string; code: string; scope?: string; partial: boolean }[] }
/** A provider that ended in ERROR with a non-partial error. Expected out-of-scope matches are partial issues and never count. */
const NAME_NOISE = new Set(['sk', 'id', 'key', 'no', 'num', 'number']);
const nameTokens = (name: string) => name.toLowerCase().split('_').filter(token => token && !NAME_NOISE.has(token));
/** How many name tokens of the source column (table prefix dropped) appear in the target's table name. Column names are left out: abbreviations (addr, cdemo) would reward the wrong table. */
export function nameAffinity(sourceColumn: string, target: { table: string; column: string }): number {
  const source = new Set(nameTokens(sourceColumn).slice(1)), pool = new Set(nameTokens(target.table));
  return [...source].filter(token => pool.has(token)).length;
}
/**
 * Homonym guard (blind, opt-in): when one source column is accepted (HIGH, unsuspected) against several targets, the target whose name matches the column better is kept and the others are
 * marked COMPETING_TARGET. A strict winner is required: equal name affinity decides nothing. Evidence only; no verdict.
 */
async function guardHomonyms(proposals: PostComaProposal[], vector?: { tieBreak: TieBreaker; profileOf: (endpoint: { db?: string; table: string; column: string }) => Promise<ColumnProfile | undefined> }): Promise<void> {
  const accepted = proposals.filter(item => { const d = item.coverageProbe.diagnostic; return item.coverageProbe.status === 'EXECUTED' && d && d.coverage.level === 'HIGH' && !d.suspect.value; });
  const groups = new Map<string, PostComaProposal[]>();
  for (const item of accepted) { const key = `${item.from.db}.${item.from.table}.${item.from.column}`; groups.set(key, [...(groups.get(key) ?? []), item]); }
  // E2-04: a target table referenced by two or more different columns of the same source table is a role dimension (sold/ship/return date -> date_dim), not a rival of another target.
  const roleColumns = new Map<string, Set<string>>();
  for (const item of accepted) { const key = `${item.from.db}.${item.from.table}>${item.to.db}.${item.to.table}.${item.to.column}`; roleColumns.set(key, (roleColumns.get(key) ?? new Set()).add(item.from.column)); }
  const roleOf = (item: PostComaProposal) => { const columns = roleColumns.get(`${item.from.db}.${item.from.table}>${item.to.db}.${item.to.table}.${item.to.column}`); return columns && columns.size >= 2 ? [...columns].sort() : undefined; };
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let winner: PostComaProposal | undefined, decidedBy: { decidedBy: string; reason: string } | undefined;
    if (vector) {
      const candidates: (TieCandidate & { item: PostComaProposal })[] = await Promise.all(group.map(async item => ({ id: item.proposalId, item, from: item.from, to: item.to, reachesHigh: true, sourceProfile: await vector.profileOf(item.from), targetProfile: await vector.profileOf(item.to) })));
      const ordering = vector.tieBreak.orderTies(candidates, { candidates });
      if (ordering.decisive && ordering.decidedBy) { winner = ordering.ordered[0].item; decidedBy = { decidedBy: ordering.decidedBy, reason: ordering.reason }; }
    }
    if (!winner) {
      const scored = group.map(item => ({ item, affinity: nameAffinity(item.from.column, item.to) })).sort((a, b) => b.affinity - a.affinity || b.item.rawScore - a.item.rawScore || a.item.proposalId.localeCompare(b.item.proposalId, 'en'));
      if (scored[0].affinity === scored[1].affinity) continue;
      winner = scored[0].item;
      for (const { item, affinity } of scored.slice(1)) if (affinity !== scored[0].affinity) markLoser(item, winner, roleOf(item));
      continue;
    }
    for (const item of group) if (item !== winner) markLoser(item, winner, roleOf(item), decidedBy);
  }
}
function markLoser(item: PostComaProposal, winner: PostComaProposal, role: string[] | undefined, tieBreak?: { decidedBy: string; reason: string }): void {
  const d = item.coverageProbe.diagnostic!;
  if (role) { d.roleDimension = { targetTable: item.to.table, sourceColumns: role }; return; }
  d.suspect = { value: true, reasons: [...d.suspect.reasons, 'COMPETING_TARGET'], preferredTarget: winner.proposalId };
  if (tieBreak) d.tieBreak = tieBreak;
}
export function comaFailureOf(production?: ComaProductionOutcome): { code: typeof COMA_FAILED; errors: { code: string; scope?: string }[] } | undefined {
  if (!production) return undefined;
  const failed = production.providerStates.filter(item => (item.providerId === 'valentine.coma' || item.providerId === 'fixture.coma-standin') && item.status === 'ERROR');
  const errors = production.errors.filter(item => (item.providerId === 'valentine.coma' || item.providerId === 'fixture.coma-standin') && !item.partial);
  return failed.length && errors.length ? { code: COMA_FAILED, errors: errors.map(item => ({ code: item.code, ...(item.scope ? { scope: item.scope } : {}) })) } : undefined;
}

const TEXT_EQUALITY = 'literal text equality of sampled values';
const sameEndpoint = (a: { table: string; column: string }, b: { table: string; column: string }) => a.table === b.table && a.column === b.column;

/**
 * The normalization a coverage probe compares under is the one the universe declares: the mode of a configured relation
 * over the same endpoints (either direction) when there is one, otherwise the universe's default mode. Never inferred.
 */
export function coverageNormalization(cfg: any, proposal: Pick<OutOfScopeProposal, 'from' | 'to'>): { mode: NormalizationMode; source: 'RELATION' | 'UNIVERSE_DEFAULT'; relationId?: string } {
  const declared = (mode: unknown): mode is NormalizationMode => typeof mode === 'string' && Boolean(cfg?.normalizationContract?.modes?.[mode]);
  const relation = (cfg?.relations ?? []).find((item: any) => declared(item?.normalization) && item.from && item.to
    && ((sameEndpoint(item.from, proposal.from) && sameEndpoint(item.to, proposal.to)) || (sameEndpoint(item.from, proposal.to) && sameEndpoint(item.to, proposal.from))));
  if (relation) return { mode: relation.normalization, source: 'RELATION', relationId: relation.id };
  const fallback = cfg?.normalizationContract?.defaultMode;
  return { mode: declared(fallback) ? fallback : 'text', source: 'UNIVERSE_DEFAULT' };
}

/** Literals to send for one normalized source key: the raw sampled forms plus the normalized form, so a padded or unpadded target can still match. */
function literalVariants(raws: string[], key: string, mode: NormalizationMode) {
  const forms = new Set(raws.filter(raw => SAFE_LITERAL.test(raw)));
  forms.add(key);
  if (mode === 'integer-pad10') forms.add(BigInt(key).toString());
  return [...forms];
}

export interface Thresholds { /** Minimum distinct source keys a probe needs; below it the source pool is widened (E3-07a). */ minDistinctKeys?: number; sustainedOverlap?: number; sustainedLabelAgreement?: number; misleadingLabelAgreement?: number }
/** The label and overlap thresholds are required: a missing file or key must never turn into a permissive default. */
function readThresholds(): Thresholds { try { return readJson('config/thresholds.json'); } catch { throw new SafeError('THRESHOLDS_UNAVAILABLE'); } }
function requireThresholds(thresholds: Thresholds): Thresholds {
  if (typeof thresholds?.sustainedOverlap !== 'number' || typeof thresholds?.sustainedLabelAgreement !== 'number') throw new SafeError('THRESHOLDS_UNAVAILABLE');
  return thresholds;
}

/** Comparable label columns: both tables declare labels, equally many, allowlisted, not sensitive, and the source labels were sampled. */
function labelColumns(fromSpec: any, toSpec: any, sampled: readonly string[], sourceColumn?: string): { columns?: { from: string[]; to: string[] }; reason?: string } {
  const usable = (spec: any) => (spec.labels ?? []).filter((name: string) => spec.columns?.some((c: any) => c.name === name) && !FORBIDDEN_COLUMN.test(name));
  const from: string[] = usable(fromSpec), to: string[] = usable(toSpec);
  if (!from.length || !to.length) return { reason: 'NO_LABEL_COLUMNS_DECLARED' };
  // Blind discovery only (sourceColumn given): the labels of a table describe the entity of its own key. When the source column is a foreign-key-like column of that table, its labels describe another entity than the target's and cannot be compared.
  if (sourceColumn !== undefined && Array.isArray(fromSpec.keyColumns) && fromSpec.keyColumns.length && !fromSpec.keyColumns.includes(sourceColumn)) return { reason: 'SOURCE_LABELS_DESCRIBE_ANOTHER_ENTITY' };
  if (from.length !== to.length) return { reason: 'LABEL_COLUMN_COUNT_DIFFERS' };
  if (from.some(name => !sampled.includes(name))) return { reason: 'SOURCE_LABELS_NOT_SAMPLED' };
  return { columns: { from, to } };
}

/** Sample-only reading of one column: needs the column in the sample; no extra query. */
function keyShape(discovery: any, endpoint: { table: string; column: string }, mode: NormalizationMode): KeyShape {
  const table = discovery?.tables?.[endpoint.table], index = table?.columns?.indexOf(endpoint.column) ?? -1;
  if (index < 0) return 'UNKNOWN';
  const m = measureMultiplicity(table.sample?.rows ?? [], index, mode);
  return m.duplicateKeys.length ? 'DUPLICATES_OBSERVED' : m.nonNullRows >= 2 ? 'UNIQUE_IN_SAMPLE' : 'UNKNOWN';
}

function diagnose(i: { proposal: OutOfScopeProposal; norm: NormalizationMode; sourceRows: unknown[][]; sourceColumns: string[]; sourceIndex: number; targetRows: unknown[][];
  labelPlan: ReturnType<typeof labelColumns>; matched: number; probed: number; readLimit: number; thresholds: Thresholds; blind: boolean; keyToKey: boolean; widenedKeys?: string[] }): CandidateDiagnostic {
  const { thresholds } = i, sustainedOverlap = typeof thresholds.sustainedOverlap === 'number' ? thresholds.sustainedOverlap : null;
  const ratio = i.probed ? i.matched / i.probed : 0;
  const level: CandidateDiagnostic['coverage']['level'] = !i.matched ? 'NONE' : sustainedOverlap !== null && ratio >= sustainedOverlap ? 'HIGH' : 'LOW';
  let labels: CandidateDiagnostic['labels'] = { signal: 'NOT_COMPARABLE', reason: i.labelPlan.reason ?? 'NO_COMPARABLE_KEYS' };
  if (i.labelPlan.columns) {
    const { from, to } = i.labelPlan.columns, toCols = [i.proposal.to.column, ...to];
    const agreement = compareLabels(i.sourceRows as any[][], i.targetRows as any[][], i.sourceColumns, toCols, i.proposal.from, i.proposal.to, from, to, i.norm);
    // Agreement is only ever claimed against a declared threshold; without the misleading threshold the signal stays not comparable.
    if (agreement && typeof thresholds.misleadingLabelAgreement !== 'number') labels = { signal: 'NOT_COMPARABLE', reason: 'LABEL_THRESHOLD_UNAVAILABLE' };
    else if (agreement) {
      const signal: LabelSignal = agreement.ratio < thresholds.misleadingLabelAgreement! ? 'LABEL_CONFLICT'
        : agreement.ratio < thresholds.sustainedLabelAgreement! ? 'LABEL_UNCERTAIN' : 'LABELS_AGREE';
      labels = { signal, agree: agreement.agree, compared: agreement.compared, ratio: agreement.ratio, fromColumns: from, toColumns: to, examples: agreement.examples.slice(0, 3) };
    }
  }
  const sourceKeys = i.sourceRows.map(row => [row[i.sourceIndex]]), targetKeys = i.targetRows.map(row => [row[0]]);
  const reasons: CandidateDiagnostic['suspect']['reasons'] = [];
  if (labels.signal === 'LABEL_CONFLICT' || labels.signal === 'LABEL_UNCERTAIN') reasons.push(labels.signal);
  if (level === 'NONE') reasons.push('NO_COVERAGE'); else if (level === 'LOW') reasons.push('LOW_COVERAGE');
  // A foreign key points at a unique key. Blind discovery has no configured relation to lean on, so a target that repeats its keys is suspect.
  const keyRules = evaluateKeyRules(sourceKeys, targetKeys, i.norm, { targetBounded: i.targetRows.length >= i.readLimit });
  if (i.blind && keyRules.targetUniqueness.status === 'DUPLICATES_OBSERVED') reasons.push('TARGET_NOT_UNIQUE');
  // Two tables each declaring this column as their own single-column key, both unique in the sample: a key does not reference another table's key.
  if (i.blind && i.keyToKey) reasons.push('KEY_TO_KEY');
  const counterfactual = reasons.includes('KEY_TO_KEY') && !reasons.includes('LABEL_CONFLICT') && !reasons.includes('LABEL_UNCERTAIN')
    ? `Ambos extremos son la clave unica declarada de su propia tabla (${i.proposal.from.table}.${i.proposal.from.column}, ${i.proposal.to.table}.${i.proposal.to.column}) y unicos en la muestra; cobertura ${i.matched} de ${i.probed}. Con una columna del origen que no sea su clave propia, o un espacio de identificadores declarado y revisado, podria proponerse como relacion.`
    : reasons.includes('TARGET_NOT_UNIQUE') && !reasons.includes('LABEL_CONFLICT') && !reasons.includes('LABEL_UNCERTAIN')
    ? `El destino repite ${keyRules.targetUniqueness.duplicateKeyCount} de ${keyRules.targetUniqueness.distinctKeys} claves observadas (hasta ${keyRules.targetUniqueness.maxRowsPerKey} filas por clave) y ninguno de los dos lados es una clave unica observada; con un destino de claves unicas en una muestra no truncada podria proponerse como relacion.`
    : reasons.includes('LABEL_CONFLICT') || reasons.includes('LABEL_UNCERTAIN')
    ? `Las claves coinciden (${i.matched} de ${i.probed}) pero las etiquetas concuerdan ${labels.agree} de ${labels.compared}; con acuerdo de etiquetas >= ${thresholds.sustainedLabelAgreement ?? 'umbral no disponible'} y un espacio de identificadores declarado y revisado podria proponerse como relacion.`
    : reasons.length ? `Cobertura ${i.matched} de ${i.probed}${sustainedOverlap !== null ? ` (umbral ${sustainedOverlap})` : ''}; con cobertura sostenida en una muestra no truncada y sin conflicto de etiquetas podria proponerse como relacion.`
    : `Cobertura ${i.matched} de ${i.probed}${labels.signal === 'LABELS_AGREE' ? ` y etiquetas ${labels.agree} de ${labels.compared}` : ' (etiquetas no comparables)'}: candidata para revision humana. No es veredicto: SOSTENIDA exige un contrato REVIEWED.`;
  return { coverage: { level, matched: i.matched, probed: i.probed, threshold: sustainedOverlap }, labels,
    multiplicity: { from: { ...(i.widenedKeys ? measureMultiplicity(i.widenedKeys.map(k => [k]), 0, i.norm) : measureMultiplicity(i.sourceRows as any[][], i.sourceIndex, i.norm)), fromBasis: i.widenedKeys ? 'GLOBAL_DISTINCT_F4' as const : 'DISCOVERY_SAMPLE' as const }, to: measureMultiplicity(i.targetRows as any[][], 0, i.norm) },
    containment: measureContainment(i.sourceRows as any[][], i.sourceIndex, i.targetRows as any[][], 0, i.norm, { targetFilteredBySource: true }),
    keyRules,
    suspect: { value: reasons.length > 0, reasons }, governance: 'CANDIDATE_REQUIRES_REVIEW', counterfactual };
}

/** Whole-table reading of one column: every non-null value distinct, or a repeated one. An unmeasured or all-null column says nothing. */
function globalUniqueness(profile: ColumnProfile | undefined): GlobalUniqueness {
  if (!profile || profile.provenance !== 'GLOBAL_WHOLE_TABLE') return 'NOT_MEASURED';
  const nonNull = profile.rows - profile.nulls;
  return nonNull <= 0 ? 'NOT_MEASURED' : profile.distinct === nonNull ? 'UNIQUE' : profile.distinct < nonNull ? 'NOT_UNIQUE' : 'NOT_MEASURED';
}
/** E2-06: do all probed numeric keys sit in a short prefix of the target's [min, max]? Needs F1x of the target; non-numeric keys or a degenerate range give no reading. */
export function rangeBiasOf(probedKeys: readonly string[], target: ColumnProfile | undefined): RangeBiasEvidence | undefined {
  if (!target || target.provenance !== 'GLOBAL_WHOLE_TABLE' || target.min === undefined || target.max === undefined || probedKeys.length < 2) return undefined;
  const numbers = probedKeys.map(Number), lo = Number(target.min), hi = Number(target.max);
  if (!numbers.every(Number.isFinite) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return undefined;
  const probedMin = Math.min(...numbers), probedMax = Math.max(...numbers);
  return { probedMin, probedMax, targetMin: lo, targetMax: hi, prefixFraction: RANGE_PREFIX_FRACTION, provenance: 'GLOBAL_WHOLE_TABLE', flagged: probedMax <= lo + (hi - lo) * RANGE_PREFIX_FRACTION };
}
/**
 * Journal of the probe loop (E1-03). One JSON line per executed probe, appended as soon as it lands, after a header that pins the code, the manifest and the run. A resume reuses
 * those results exactly and sends no SQL for them; a header that differs in any field refuses the whole resume. Failed probes are not journaled: they are probed again.
 */
export interface PostComaJournalHeader { kind: 'HEADER'; schemaVersion: 1; codeSha: string; manifestHash: string; runId: string }
export interface PostComaJournalEntry { kind: 'PROBE'; proposalId: string; sampledKeys: string[]; queryIds: string[]; utc: string; coverageProbe: CoverageProbe }
export interface PostComaJournalTarget { /** post-coma-journal.jsonl in the run folder. */ path: string; header: PostComaJournalHeader }
export const POST_COMA_RESUME_MISMATCH = 'POST_COMA_RESUME_MISMATCH';
export const POST_COMA_JOURNAL_FILE = 'post-coma-journal.jsonl';
const headerFields = ['codeSha', 'manifestHash', 'runId'] as const;
/** Reads a journal for resume. A last line that does not parse (power cut while writing) is dropped; a bad line anywhere else, or any header difference, refuses. */
export function readPostComaJournal(target: PostComaJournalTarget): PostComaJournalEntry[] {
  const lines = readFileSync(target.path, 'utf8').split('\n').filter(line => line.length > 0);
  const mismatch = (detail: string) => new SafeError(POST_COMA_RESUME_MISMATCH, 409, detail);
  let header: any; try { header = JSON.parse(lines[0] ?? ''); } catch { throw mismatch('JOURNAL_HEADER_UNREADABLE'); }
  const differing = headerFields.filter(field => header?.[field] !== target.header[field]);
  if (header?.kind !== 'HEADER' || differing.length) throw mismatch(differing.length ? `HEADER_DIFFERS:${differing.join(',')}` : 'JOURNAL_HEADER_MISSING');
  const entries: PostComaJournalEntry[] = [];
  for (let index = 1; index < lines.length; index++) {
    try { const entry = JSON.parse(lines[index]); if (entry?.kind !== 'PROBE') throw new Error('x'); entries.push(entry); }
    catch { if (index === lines.length - 1) break; throw mismatch(`JOURNAL_LINE_UNREADABLE:${index + 1}`); }
  }
  return entries;
}
const endpointOf = (e: { db?: string; table: string; column: string }, withDb: boolean) => withDb ? `${e.db ?? ''}.${e.table}.${e.column}` : `${e.table}.${e.column}`;
const pairOf = (proposal: Pick<OutOfScopeProposal, 'from' | 'to'>, withDb: boolean) => `${endpointOf(proposal.from, withDb)}__${endpointOf(proposal.to, withDb)}`;

/**
 * Post-COMA step. COMA proposals outside the configured scope are never evaluated as relations; instead each one gets a
 * coverage probe that the agent may run inside the remaining budget: how many of the sampled source values appear in the
 * target column. The result is a bounded diagnostic with the proposal still NO VERIFICADO/UNKNOWN and PENDING; it never
 * produces or changes a verdict. Probes run by raw score, up to the catalog's postComa.maxProbes (default 2), one query each.
 */
export async function runPostComa(o: { cfg: any; catalog?: ExplorationCatalog; discovery: any; proposals: readonly OutOfScopeProposal[]; client: Pick<Zetaris, 'runSql'>; budget: RunBudget; thresholds?: Thresholds; production?: ComaProductionOutcome; scope?: PostComaScope; prior?: PostComaPrior; profile?: ProfileSource; tieBreak?: TieBreaker; journal?: PostComaJournalTarget; resume?: { journal: PostComaJournalTarget }; /** E3-07a: per-run reader (X5) that widens a degenerate discovery sample with the global F4 read. Absent: the sample is used as before. */ sourcePool?: SourcePoolReader; minDistinctKeys?: number }): Promise<PostComaReport> {
  const maxProbes = o.catalog?.postComa?.maxProbes ?? DEFAULT_POST_COMA.maxProbes;
  const blind = o.catalog?.postComa?.blind === true;
  const comaFailure = comaFailureOf(o.production);
  const thresholds = o.proposals.length ? requireThresholds(o.thresholds ?? readThresholds()) : (o.thresholds ?? {});
  // The proposal id stays table.column__table.column; it carries the database only when two proposals would otherwise share an id.
  const dbsOfId = new Map<string, Set<string>>();
  for (const proposal of o.proposals) { const key = pairOf(proposal, false); dbsOfId.set(key, (dbsOfId.get(key) ?? new Set()).add(pairOf(proposal, true))); }
  const idOf = (proposal: Pick<OutOfScopeProposal, 'from' | 'to'>) => (dbsOfId.get(pairOf(proposal, false))?.size ?? 0) > 1 ? pairOf(proposal, true) : pairOf(proposal, false);
  const byId = new Map<string, OutOfScopeProposal>(), structureOf = new Map<string, NonNullable<PostComaProposal['structure']>>();
  // Blind discovery only. The target of a candidate is the side with unique observed keys (child -> parent), decided from the discovery samples with no extra read.
  const profiles = new Map<string, Promise<ColumnProfile | undefined>>();
  const profileOf = (endpoint: { db?: string; table: string; column: string }) => o.profile ? profiles.get(`${endpoint.table}.${endpoint.column}`) ?? (profiles.set(`${endpoint.table}.${endpoint.column}`, o.profile(endpoint).catch(() => undefined)), profiles.get(`${endpoint.table}.${endpoint.column}`)!) : Promise.resolve(undefined);
  const proposals: OutOfScopeProposal[] = [];
  for (const proposal of blind ? o.proposals : []) {
    const mode = coverageNormalization(o.cfg, proposal).mode, from = keyShape(o.discovery, proposal.from, mode), to = keyShape(o.discovery, proposal.to, mode);
    // E2-02: only a pair the sample cannot orient (neither end repeats a value) consults the whole-table profile of both ends.
    const ambiguous = Boolean(o.profile) && from !== 'DUPLICATES_OBSERVED' && to !== 'DUPLICATES_OBSERVED';
    const [fromProfile, toProfile] = ambiguous ? await Promise.all([profileOf(proposal.from), profileOf(proposal.to)]) : [undefined, undefined];
    const fromGlobal = globalUniqueness(fromProfile), toGlobal = globalUniqueness(toProfile);
    const globalSwap = fromGlobal === 'UNIQUE' && toGlobal === 'NOT_UNIQUE', oneToOne = fromGlobal === 'UNIQUE' && toGlobal === 'UNIQUE' && proposal.from.table !== proposal.to.table;
    const swap = (to === 'DUPLICATES_OBSERVED' && from === 'UNIQUE_IN_SAMPLE') || globalSwap;
    const oriented = swap ? { ...proposal, from: proposal.to, to: proposal.from } : proposal;
    const declaredKey = (e: { table: string; column: string }) => { const keys = o.cfg.tables?.[e.table]?.keyColumns; return Array.isArray(keys) && keys.length === 1 && keys[0] === e.column; };
    const keyToKey = from === 'UNIQUE_IN_SAMPLE' && to === 'UNIQUE_IN_SAMPLE' && declaredKey(proposal.from) && declaredKey(proposal.to) && proposal.from.table !== proposal.to.table;
    structureOf.set(idOf(oriented), { from: swap ? to : from, to: swap ? from : to, targetDeclaredKey: declaredKey(oriented.to),
      rankClass: from === 'DUPLICATES_OBSERVED' && to === 'DUPLICATES_OBSERVED' || (fromGlobal === 'NOT_UNIQUE' && toGlobal === 'NOT_UNIQUE') ? 'BOTH_SIDES_DUPLICATED' : oneToOne ? 'ONE_TO_ONE' : keyToKey ? 'KEY_TO_KEY' : 'KEY_CANDIDATE',
      orientation: globalSwap ? 'SWAPPED_GLOBAL_UNIQUENESS' : swap ? 'SWAPPED_TARGET_UNIQUE' : 'AS_PROPOSED', ...(swap ? { proposedFrom: proposal.from, proposedTo: proposal.to } : {}),
      ...(ambiguous && (fromGlobal !== 'NOT_MEASURED' || toGlobal !== 'NOT_MEASURED') ? { globalUniqueness: { from: swap ? toGlobal : fromGlobal, to: swap ? fromGlobal : toGlobal, provenance: 'GLOBAL_WHOLE_TABLE' as const, ...(oneToOne ? { relationKind: 'EXTENSION_ONE_TO_ONE' as const } : {}) } } : {}) });
    proposals.push(oriented);
  }
  if (!blind) proposals.push(...o.proposals);
  // One probe per pair, always by the same rule: the higher score, then the lexicographic id. In blind discovery the two directions of a pair count as one.
  const kept = new Map<string, { id: string; proposal: OutOfScopeProposal }>();
  for (const proposal of proposals) {
    const id = idOf(proposal), key = blind ? [pairOf(proposal, true), pairOf({ from: proposal.to, to: proposal.from }, true)].sort().join('|') : pairOf(proposal, true), current = kept.get(key);
    if (!current || proposal.rawScore > current.proposal.rawScore || (proposal.rawScore === current.proposal.rawScore && id.localeCompare(current.id, 'en') < 0)) kept.set(key, { id, proposal });
  }
  for (const { id, proposal } of kept.values()) byId.set(id, proposal);
  // Blind discovery: a pair whose two endpoints both repeat their values cannot be a key reference in either direction, so it goes after every other candidate (never dropped).
  // Tiers: a candidate whose target is a declared single-column key first, other candidates next, pairs that cannot be key references (values repeated on both sides, key to key) last.
  const demoted = (id: string) => { const st = structureOf.get(id); return !st ? 0 : st.rankClass === 'BOTH_SIDES_DUPLICATED' || st.rankClass === 'KEY_TO_KEY' ? 2 : st.targetDeclaredKey ? 0 : 1; };
  // Previous run of the same origin-sealed scope: ranking input only. Without a matching scope it is ignored and said so.
  const undirected = (e: Pick<OutOfScopeProposal, 'from' | 'to'>) => [pairOf(e, true), pairOf({ from: e.to, to: e.from }, true)].sort().join('|');
  const priorApplies = Boolean(o.prior && o.scope && sameScope(o.prior.scope, o.scope));
  const priorOutcome = new Map<string, PriorOutcome>(priorApplies ? o.prior!.pairs.map(pair => [undirected(pair), pair.outcome] as [string, PriorOutcome]) : []);
  const demonstrated = (id: string) => priorOutcome.get(undirected(byId.get(id)!));
  const coverAll = o.catalog?.postComa?.coverAll === true, allowCut = o.catalog?.postComa?.allowCut === true;
  // C5: the prior run only orders the probes and, outside coverAll, skips pairs it already demonstrated. With coverAll it never skips: the review needs this run's coverage of every pair, including those reusable from memory.
  const skippable = (id: string) => coverAll ? undefined : demonstrated(id);
  const rankedBase = [...byId.entries()].sort(([a, pa], [b, pb]) => Number(Boolean(demonstrated(a))) - Number(Boolean(demonstrated(b))) || demoted(a) - demoted(b) || pb.rawScore - pa.rawScore || a.localeCompare(b, 'en'));
  // X10 tie-break: siblings of one source column that tie on tier and raw score are ordered by its vector when it is decisive; otherwise the order above stays.
  const ranked = [...rankedBase];
  if (o.tieBreak) {
    const sourceKey = (id: string) => `${byId.get(id)!.from.table}.${byId.get(id)!.from.column}`, same = (a: string, b: string) => sourceKey(a) === sourceKey(b) && demoted(a) === demoted(b) && byId.get(a)!.rawScore === byId.get(b)!.rawScore && !demonstrated(a) && !demonstrated(b);
    for (let start = 0; start < ranked.length;) {
      let end = start + 1; while (end < ranked.length && same(ranked[start][0], ranked[end][0])) end++;
      if (end - start > 1) {
        const slice = ranked.slice(start, end);
        const candidates: TieCandidate[] = await Promise.all(slice.map(async ([id, p]) => ({ id, from: p.from, to: p.to, sourceProfile: await profileOf(p.from), targetProfile: await profileOf(p.to) })));
        const ordering = o.tieBreak.orderTies(candidates, { candidates });
        if (ordering.decisive) ordering.ordered.forEach((candidate, offset) => { ranked[start + offset] = slice.find(([id]) => id === candidate.id)!; });
      }
      start = end;
    }
  }
  const defaultMode = coverageNormalization(o.cfg, { from: { table: '', column: '' }, to: { table: '', column: '' } } as any).mode;
  const defaultEquality = defaultMode === 'text' ? TEXT_EQUALITY : `equality of sampled values under the declared normalization (${defaultMode}); a configured relation over the same columns overrides it per proposal`;
  const report: PostComaReport = { status: 'NONE', policy: { maxProbes, ranking: blind ? 'declared-key target first; pairs with duplicated values on both sides or key to key last; then rawScore desc, then proposalId' : 'rawScore desc, then proposalId', costPerProbe: COVERAGE_PROBE_QUERY_COST, equality: defaultEquality, estimatedQueries: 0, queriesAvailable: 0 },
    proposals: [], notExecutedByBudget: [], counts: { proposals: ranked.length, executed: 0, suggested: 0, notExecutable: 0, skippedBudget: 0, failed: 0 },
    limitations: [defaultMode === 'text' ? 'Coverage compares literal text of bounded sampled values; it does not apply normalization and says nothing about the whole table.'
        : 'Coverage compares bounded sampled values under the normalization the universe declares (per proposal: mode and source in the result); it says nothing about the whole table.',
      'A coverage probe is a diagnostic: the proposal stays NO VERIFICADO/UNKNOWN and PENDING, and no verdict is produced or changed.'] };
  // Pre-estimate: the SQL the probe cap could spend against what the run budget still allows. A shortfall is reported up front, not discovered probe by probe.
  const candidates = ranked.filter(([id]) => !skippable(id)).length;
  let affordable = 0; while (affordable < maxProbes && o.budget.canQuery((affordable + 1) * COVERAGE_PROBE_QUERY_COST)) affordable++;
  report.policy.estimatedQueries = Math.min(maxProbes, candidates) * COVERAGE_PROBE_QUERY_COST; report.policy.queriesAvailable = affordable * COVERAGE_PROBE_QUERY_COST;
  if (report.policy.estimatedQueries > report.policy.queriesAvailable) report.limitations.push(`postComa.maxProbes ${maxProbes} needs up to ${report.policy.estimatedQueries} queries but the run budget allows ${report.policy.queriesAvailable}: at most ${affordable} probes can run`);
  if (o.prior) report.priorRun = { applied: priorApplies, ...(priorApplies ? {} : { reason: 'PRIOR_RUN_SCOPE_MISMATCH' }), skipped: [] };
  // Shared by the pre-estimate and the loop: whether a proposal can be probed at all, and with which sampled keys.
  const inAllowlist = (spec: any, column: string) => Boolean(spec?.columns?.some((item: any) => item.name === column));
  const seedsOf = (sampled: readonly string[], mode: NormalizationMode) => {
    const values = [...new Set<string>(sampled)], rawsByKey = new Map<string, string[]>(); let unnormalizable = 0;
    for (const raw of values) { const key = normalizeKey(raw, mode); if (key === null) { unnormalizable++; continue; } rawsByKey.set(key, [...(rawsByKey.get(key) ?? []), raw]); }
    return { values, rawsByKey, unnormalizable, safe: [...rawsByKey.keys()].filter(key => SAFE_LITERAL.test(key)).slice(0, o.budget.limits.readLimit) };
  };
  const prepare = (proposal: OutOfScopeProposal): { reason: string } | { norm: ReturnType<typeof coverageNormalization>; values: string[]; rawsByKey: Map<string, string[]>; unnormalizable: number; safe: string[]; sampled: string[]; fromSpec: any; toSpec: any; fromTable: any; sampleIndex: number } => {
    const fromSpec = o.cfg.tables[proposal.from.table], toSpec = o.cfg.tables[proposal.to.table], fromTable = o.discovery.tables[proposal.from.table];
    const sampleIndex = fromTable?.columns?.indexOf(proposal.from.column) ?? -1;
    if (!fromSpec || !toSpec || !inAllowlist(fromSpec, proposal.from.column) || !inAllowlist(toSpec, proposal.to.column) || !o.discovery.tables[proposal.to.table]) return { reason: 'ENDPOINT_OUTSIDE_ALLOWLIST_OR_UNDISCOVERED' };
    if (sampleIndex < 0) return { reason: 'SOURCE_COLUMN_NOT_SAMPLED' };
    const norm = coverageNormalization(o.cfg, proposal);
    const sampled = (fromTable.sample?.rows ?? []).map((row: unknown[]) => row[sampleIndex]).filter((value: unknown) => value !== null && value !== undefined).map(String);
    const seeds = seedsOf(sampled, norm.mode);
    if (!seeds.safe.length) return { reason: 'NO_SAFE_SAMPLED_VALUES' };
    return { norm, ...seeds, sampled, fromSpec, toSpec, fromTable, sampleIndex };
  };
  // Journal: with a resume the file is validated first (a mismatch throws before any SQL), rewritten without a torn tail, and the probes it holds are reused.
  const journalTarget = o.resume?.journal ?? o.journal;
  const resumed = new Map<string, PostComaJournalEntry>();
  if (o.resume) {
    if (!existsSync(o.resume.journal.path)) throw new SafeError(POST_COMA_RESUME_MISMATCH, 409, 'JOURNAL_MISSING');
    const entries = readPostComaJournal(o.resume.journal);
    for (const entry of entries) if (entry.coverageProbe?.status === 'EXECUTED') resumed.set(entry.proposalId, entry);
    writeFileSync(o.resume.journal.path, [JSON.stringify(o.resume.journal.header), ...entries.map(entry => JSON.stringify(entry))].join('\n') + '\n');
  } else if (o.journal) writeFileSync(o.journal.path, JSON.stringify(o.journal.header) + '\n');
  const reusable = (id: string) => resumed.has(id) && !skippable(id);
  // E3-07a: every source column whose discovery sample is below the minimum costs one extra F4 read, which the estimate counts.
  const minKeys = o.minDistinctKeys ?? thresholds.minDistinctKeys;
  const f4Reads = (list: readonly [string, OutOfScopeProposal][]) => o.sourcePool && typeof minKeys === 'number'
    ? degenerateSampleColumns(o.discovery, [...new Map(list.map(([, p]) => [`${p.from.table}.${p.from.column}`, p.from])).values()], minKeys).length : 0;
  // Cover-all mode (postComa.coverAll): every executable candidate gets a probe. If the run budget cannot pay for all of them, nothing runs and the shortfall is reported, unless the catalog allows a cut.
  if (coverAll) {
    const executable = ranked.filter(([id, proposal]) => !skippable(id) && !reusable(id) && !('reason' in prepare(proposal))), units = executable.length, estimate = o.budget.estimate(units, { queries: COVERAGE_PROBE_QUERY_COST });
    const f4 = f4Reads(executable), needed = estimate.estimatedQueries + f4, available = Math.min(needed, estimate.queriesAvailable);
    report.policy.maxProbes = units; if (f4) report.policy.f4Reads = f4; report.policy.coverAll = true; report.policy.estimatedQueries = needed; report.policy.queriesAvailable = available;
    if (needed > available) {
      report.policy.budgetShortfall = { needed, available, action: allowCut ? 'CUT_TO_AVAILABLE_BY_RANKING' : 'BUDGET_REQUIRED' };
      report.limitations.push(`coverAll needs ${needed} queries and the run budget allows ${available}: ${allowCut ? 'only the best-ranked candidates are probed (allowCut)' : 'nothing was probed; raise maxQueriesPerRun to at least ' + needed + ' or allow a cut explicitly'}`);
      if (!allowCut) {
        for (const [proposalId, proposal] of ranked) {
          const item: PostComaProposal = { proposalId, from: proposal.from, to: proposal.to, rawScore: proposal.rawScore, reason: proposal.reason, verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING', coverageProbe: { kind: 'COVERAGE_PROBE', status: 'SUGGESTED', reason: 'BUDGET_REQUIRED' } };
          const structure = structureOf.get(proposalId); if (structure) item.structure = structure;
          report.proposals.push(item); report.counts.suggested++;
        }
        report.status = BUDGET_REQUIRED;
        return report;
      }
    }
  }
  if (!coverAll && resumed.size) {
    const reused = ranked.filter(([id]) => reusable(id)).length;
    report.policy.estimatedQueries = Math.max(0, report.policy.estimatedQueries - reused * COVERAGE_PROBE_QUERY_COST);
    report.policy.resumedProbes = reused;
  } else if (coverAll && resumed.size) report.policy.resumedProbes = ranked.filter(([id]) => reusable(id)).length;
  if (!coverAll) {
    const f4 = f4Reads(ranked.filter(([id, proposal]) => !skippable(id) && !reusable(id) && !('reason' in prepare(proposal))).slice(0, maxProbes));
    if (f4) {
      report.policy.estimatedQueries += f4; report.policy.f4Reads = f4;
      let affordableNow = 0; while (affordableNow < report.policy.estimatedQueries && o.budget.canQuery(affordableNow + 1)) affordableNow++;
      report.policy.queriesAvailable = affordableNow;
      if (report.policy.estimatedQueries > affordableNow) report.limitations.push(`with ${f4} F4 reads for degenerate source samples the run needs up to ${report.policy.estimatedQueries} queries and the budget allows ${affordableNow}`);
    }
  }
  const probeCap = coverAll ? Number.POSITIVE_INFINITY : maxProbes;
  let executed = 0;
  for (const [proposalId, proposal] of ranked) {
    const item: PostComaProposal = { proposalId, from: proposal.from, to: proposal.to, rawScore: proposal.rawScore, reason: proposal.reason, verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING',
      coverageProbe: { kind: 'COVERAGE_PROBE', status: 'SUGGESTED' } };
    const structure = structureOf.get(proposalId);
    if (structure) item.structure = structure;
    report.proposals.push(item);
    const probe = item.coverageProbe;
    const prepared = prepare(proposal);
    if ('reason' in prepared) { probe.status = 'NOT_EXECUTABLE'; probe.reason = prepared.reason; continue; }
    const { norm, sampled, fromSpec, toSpec, fromTable, sampleIndex } = prepared;
    let { values, rawsByKey, unnormalizable, safe } = prepared;
    const prior = skippable(proposalId);
    if (prior) { probe.reason = 'PRIOR_RUN_DEMONSTRATED'; report.priorRun!.skipped.push({ proposalId, outcome: prior }); continue; }
    if (reusable(proposalId)) {
      const entry = resumed.get(proposalId)!;
      // Keys widened by F4 came from a query this run no longer sends: the journal is their only source, so only sample-seeded probes can be re-checked.
      if (entry.coverageProbe.sampling?.source !== 'GLOBAL_DISTINCT_F4' && JSON.stringify(entry.sampledKeys) !== JSON.stringify(safe)) throw new SafeError(POST_COMA_RESUME_MISMATCH, 409, `SAMPLED_KEYS_DIFFER:${proposalId}`);
      Object.assign(probe, entry.coverageProbe); executed++;
      trace({ kind: 'agent-post-coma-coverage', proposalId, status: 'PASS', resumed: true, probed: safe.length, queryIds: entry.queryIds });
      continue;
    }
    if (executed >= probeCap) { probe.reason = 'NOT_SELECTED_MAX_PROBES'; report.notExecutedByBudget.push({ proposalId, rawScore: proposal.rawScore, reason: probe.reason }); continue; }
    // E3-07a: a degenerate discovery sample (fewer distinct keys than the policy minimum) is replaced by the global F4 pool; a sufficient one costs nothing.
    if (o.sourcePool && typeof minKeys === 'number') {
      const widened = await widenSourcePool(o.sourcePool, proposal.from, sampled, minKeys);
      probe.sampling = widened.trace;
      if (widened.trace.source === 'GLOBAL_DISTINCT_F4') { const wide = seedsOf(widened.keys.map(String), norm.mode); if (wide.safe.length) ({ values, rawsByKey, unnormalizable, safe } = wide); else probe.sampling = { ...widened.trace, source: 'DISCOVERY_SAMPLE', reason: 'F4_NOT_LARGER' }; }
    }
    if (!o.budget.canQuery(COVERAGE_PROBE_QUERY_COST)) { probe.status = 'SKIPPED_BUDGET'; probe.reason = 'QUERY_BUDGET_INSUFFICIENT'; report.notExecutedByBudget.push({ proposalId, rawScore: proposal.rawScore, reason: probe.reason }); continue; }
    const labelPlan = labelColumns(fromSpec, toSpec, fromTable.columns ?? [], blind ? proposal.from.column : undefined);
    const literals = [...new Set(safe.flatMap(key => literalVariants(rawsByKey.get(key)!, key, norm.mode)))].map(value => `'${value.replace(/'/g, "''")}'`).join(', ');
    const projection = [proposal.to.column, ...(labelPlan.columns ? labelPlan.columns.to : [])].map(identifier).join(', ');
    const sql = `SELECT ${projection} FROM ${zetarisSourceQuery({ ...toSpec, columns: toSpec.columns })} WHERE ${identifier(proposal.to.column)} IN (${literals}) LIMIT ${o.budget.limits.readLimit}`;
    probe.sql = sql; executed++;
    try {
      const result = await o.client.runSql(sql, o.budget.limits.readLimit);
      const found = new Set(result.rows.map((row: unknown[]) => normalizeKey(row[0], norm.mode)).filter((key: string | null): key is string => key !== null));
      const matches = safe.filter(value => found.has(value)).length;
      probe.status = 'EXECUTED';
      probe.result = { sampledSourceValues: values.length, probedValues: safe.length, targetMatches: matches, ratio: safe.length ? matches / safe.length : null, rows: result.rows.length, queryId: result.queryId, requestId: result.requestId,
        normalization: { mode: norm.mode, source: norm.source, ...(norm.relationId ? { relationId: norm.relationId } : {}), unnormalizableValues: unnormalizable } };
      probe.diagnostic = diagnose({ proposal, norm: norm.mode, sourceRows: fromTable.sample?.rows ?? [], sourceColumns: fromTable.columns ?? [], sourceIndex: sampleIndex, targetRows: result.rows, labelPlan,
        matched: matches, probed: safe.length, readLimit: o.budget.limits.readLimit, thresholds, blind, keyToKey: structure?.rankClass === 'KEY_TO_KEY', ...(probe.sampling?.source === 'GLOBAL_DISTINCT_F4' ? { widenedKeys: safe } : {}) });
      if (structure?.rankClass === 'ONE_TO_ONE') {
        probe.diagnostic.traits = ['ONE_TO_ONE_EXTENSION'];
        probe.diagnostic.counterfactual += ` Rasgo: ambos extremos son unicos en toda la tabla (perfil global, EXTENSION_ONE_TO_ONE); no excluye la revision, pero sin revision no se emite contrato FK.`;
      }
      const bias = o.profile ? rangeBiasOf(safe, await profileOf(proposal.to)) : undefined;
      if (bias) { probe.diagnostic.rangeBias = bias; if (bias.flagged) probe.diagnostic.suspect = { ...probe.diagnostic.suspect, value: true, reasons: [...probe.diagnostic.suspect.reasons, 'RANGE_BIASED'] }; }
      if (journalTarget) appendFileSync(journalTarget.path, JSON.stringify({ kind: 'PROBE', proposalId, sampledKeys: safe, queryIds: [result.queryId], utc: new Date().toISOString(), coverageProbe: probe } satisfies PostComaJournalEntry) + '\n');
      trace({ kind: 'agent-post-coma-coverage', proposalId, status: 'PASS', probed: safe.length, matches, queryId: result.queryId, requestId: result.requestId, sql });
    } catch (error) {
      probe.status = 'FAILED'; probe.error = failure(error);
      trace({ kind: 'agent-post-coma-coverage', proposalId, status: 'FAIL', ...failure(error) });
    }
  }
  if (blind && o.catalog?.postComa?.homonymGuard === true) await guardHomonyms(report.proposals, o.tieBreak && o.profile ? { tieBreak: o.tieBreak, profileOf } : undefined);
  for (const item of report.proposals) {
    const status = item.coverageProbe.status;
    if (status === 'EXECUTED') report.counts.executed++; else if (status === 'SUGGESTED') report.counts.suggested++; else if (status === 'NOT_EXECUTABLE') report.counts.notExecutable++; else if (status === 'SKIPPED_BUDGET') report.counts.skippedBudget++; else report.counts.failed++;
  }
  if (comaFailure) { report.status = COMA_FAILED; report.errors = comaFailure.errors; return report; }
  report.status = !ranked.length ? 'NONE' : report.counts.failed || report.counts.skippedBudget ? 'PARTIAL' : report.counts.executed ? 'EXECUTED' : 'SUGGESTED_ONLY';
  return report;
}
