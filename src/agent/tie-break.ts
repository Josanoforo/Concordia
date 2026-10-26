/**
 * Round 10 / X10 (E2-01, E2-06, E2-07). Deterministic tie-break vector for sibling candidates (two or more targets reached by the same source column).
 * Pure functions: no I/O, no SQL, no model calls, no gold, no tuned weights. Everything it reads was already measured (names, whole-table profiles, the candidate set);
 * a feature whose inputs are missing is reported NOT_MEASURED and never invented. It decides nothing about a relation: it orders candidates or says the tie stays open.
 *
 * Sources: Rostin 2009 (F6 name, F7 length difference, F8 out-of-range, F10 table-size ratio, F3/F5 referenced-by), Chen/PowerPivot VLDB 2014 (s2 source column vs TARGET TABLE name,
 * s3 distinct ratio), HoPF 2020 (asymmetric token containment), Kokel 2025 (explicit criteria list), and T36 of the Round 10 external research (the order below).
 */

/** A column endpoint. `db` is optional: when present it is part of the node identity. */
export interface Endpoint { db?: string; table: string; column: string }

/**
 * Whole-table profile of one column, STRUCTURALLY compatible with X7's `ColumnProfile` (src/probe/column-profile.ts): any `ColumnProfile` is assignable to `ProfileLike`, so X4 passes X7's
 * objects as they are. Kept local so this file compiles on its own. `rows` is COUNT(*) of the TABLE that holds the column.
 */
export type ProfileLike =
  | { provenance: 'GLOBAL_WHOLE_TABLE'; rows: number; distinct: number; nulls: number; min?: string | number | boolean | null; max?: string | number | boolean | null; avgLen?: number | null }
  | { provenance: 'NOT_MEASURED'; reason: string };

/** One candidate relation `from -> to` with whatever was measured about its endpoints. Nothing here is a verdict. */
export interface TieCandidate {
  id: string;
  from: Endpoint;
  to: Endpoint;
  sourceProfile?: ProfileLike;
  targetProfile?: ProfileLike;
  /** Post-COMA probe reached HIGH coverage (unsuspected). Undefined = unknown; the fan-out feature then reports NOT_MEASURED. */
  reachesHigh?: boolean;
}

/** A feature value with provenance, or NOT_MEASURED with the reason. A missing input is never invented. */
export type Feature<T> =
  | { status: 'MEASURED'; value: T; provenance: 'NAME_ONLY' | 'GLOBAL_WHOLE_TABLE' | 'CANDIDATE_SET'; inputs: string[] }
  | { status: 'NOT_MEASURED'; reason: string };

export type RangeBias = 'OUTSIDE_TARGET_RANGE' | 'SHORT_PREFIX_OF_TARGET_RANGE' | 'WITHIN_TARGET_RANGE';

export interface TieBreakVector {
  candidateId: string;
  /** Asymmetric: entity tokens of the SOURCE column (own-table prefix and key noise dropped) that appear in the TARGET TABLE name. A count. 0 is a measurement (the column names no such entity). */
  nameVsTable: Feature<number>;
  /** Entries of `NAME_ABBREVIATIONS` that fired while tokenizing the source column and the target table name (empty when none). */
  nameExpansions: NameExpansion[];
  /** Asymmetric: fraction (0..1) of the source column's entity tokens found in the target table + target column tokens. NOT_MEASURED when the source names no entity. */
  tokenContainment: Feature<number>;
  /** distinct(source) / distinct(target). */
  distinctRatio: Feature<number>;
  /** rows(source table) / rows(target table). */
  rowRatio: Feature<number>;
  /** INFORMATION ONLY, not a step of the order: distinct source columns that reference this target column within the candidate set given as context. In a set full of overlapping integer surrogates a small hub is referenced by everything (a homonym signal, not an FK signal). */
  targetCentrality: Feature<number>;
  /** Targets of the same source column in the context set that reach HIGH. */
  sourceFanOut: Feature<number>;
  /** |avgLen(source) - avgLen(target)|. */
  avgLenDiff: Feature<number>;
  /** E2-06. A flag for the reviewer and the ranking, never a verdict. */
  rangeBias: Feature<RangeBias>;
}

/** Declared constants. Rationale, not fitting: none was tuned on TPCDS or on any gold. */
export const TIE_BREAK_CONSTANTS = {
  /** Chen 2014 LP2: distinct(source)/distinct(target) must not exceed 1 + epsilon. */
  DISTINCT_RATIO_EPSILON: 0.05,
  /** A cardinality or row-ratio goodness separates two candidates only when one is at least this many times the other (an order-of-magnitude-agnostic "clearly closer" test). */
  FOLD: 2,
  /** Source max within this fraction of the target's span above the target min = a short prefix of the target range (Zhang 2010: Broker 1..100 inside Trade 1..10000). */
  RANGE_PREFIX_FRACTION: 0.1,
  /** E2-07: containment counted as 1 in both directions. */
  DERIVED_COPY_MIN_CONTAINMENT: 0.99,
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- names

const NOISE = new Set(['id', 'sk', 'key', 'no', 'num', 'number', 'fk', 'code', 'dim', 'fact', 'tbl', 'table', 'ref']);
/**
 * Closed, versioned abbreviation map used by NAME_VS_TABLE. GENERIC: common data-modelling abbreviations of column names (cdemo, hdemo, addr, cust, ...), not tied to TPCDS or to any gold; an
 * entry is added only when an abbreviation that spans several words (or is too short for the prefix rule) is common in schemas. A token is expanded only on an exact match. Which entry fired
 * is reported in `TieBreakVector.nameExpansions`. Bump the version on any change to the entries.
 */
export const NAME_ABBREVIATIONS = {
  version: 'abbr-v1',
  entries: {
    cdemo: ['customer', 'demographics'], hdemo: ['household', 'demographics'], addr: ['address'], cust: ['customer'], dept: ['department'], emp: ['employee'], mgr: ['manager'],
    prod: ['product'], acct: ['account'], txn: ['transaction'], loc: ['location'], ctry: ['country'], org: ['organization'], supp: ['supplier'], ord: ['order'], dt: ['date'],
  } as Readonly<Record<string, readonly string[]>>,
} as const;
export interface NameExpansion { side: 'SOURCE' | 'TARGET'; token: string; expandedTo: string[]; version: string }
const rawTokens = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const stem = (token: string): string => token.length > 4 && token.endsWith('ies') ? `${token.slice(0, -3)}y` : token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
const expand = (tokens: readonly string[], side: NameExpansion['side'], fired: NameExpansion[]): string[] => tokens.flatMap(token => {
  const entry = Object.hasOwn(NAME_ABBREVIATIONS.entries, token) ? NAME_ABBREVIATIONS.entries[token] : undefined;
  if (!entry) return [token];
  fired.push({ side, token, expandedTo: [...entry], version: NAME_ABBREVIATIONS.version });
  return [...entry];
});
const entityTokens = (tokens: readonly string[], side: NameExpansion['side'], fired: NameExpansion[]): string[] => [...new Set(expand(tokens.filter(token => !NOISE.has(token)), side, fired).map(stem))];
/** Equal after stemming, or one is a prefix of the other (promo / promotion), prefixes of at least 4 characters. */
const tokenMatch = (a: string, b: string): boolean => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
const matched = (tokens: readonly string[], pool: readonly string[]): number => tokens.filter(token => pool.some(candidate => tokenMatch(token, candidate))).length;

/** The column's tokens without the leading abbreviation of its OWN table (ss_ in store_sales, d_ in date_dim, inv_ in inventory) when something else is left. */
function columnTokens(column: string, table: string): string[] {
  const all = rawTokens(column), tableTokens = rawTokens(table), joined = tableTokens.join('');
  const initials = tableTokens.map(token => token[0]).join('');
  const first = all[0];
  if (first && all.length > 1 && first.length <= 4 && (first === initials || joined.startsWith(first)) && all.slice(1).some(token => !NOISE.has(token))) return all.slice(1);
  return all;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- features

const nodeKey = (e: Endpoint): string => `${e.db ? `${e.db}.` : ''}${e.table}.${e.column}`;
const profileOf = (p: ProfileLike | undefined): Extract<ProfileLike, { provenance: 'GLOBAL_WHOLE_TABLE' }> | undefined => p && p.provenance === 'GLOBAL_WHOLE_TABLE' ? p : undefined;
const notMeasured = (reason: string): { status: 'NOT_MEASURED'; reason: string } => ({ status: 'NOT_MEASURED', reason });
const missingProfile = (candidate: TieCandidate): string => {
  const missing = [profileOf(candidate.sourceProfile) ? '' : 'SOURCE', profileOf(candidate.targetProfile) ? '' : 'TARGET'].filter(Boolean).join('+');
  const why = [candidate.sourceProfile, candidate.targetProfile].flatMap(p => p && p.provenance === 'NOT_MEASURED' ? [p.reason] : []);
  return `PROFILE_NOT_MEASURED:${missing}${why.length ? `:${why.join(',')}` : ''}`;
};
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : null;

function rangeBiasOf(candidate: TieCandidate): TieBreakVector['rangeBias'] {
  const s = profileOf(candidate.sourceProfile), t = profileOf(candidate.targetProfile);
  if (!s || !t) return notMeasured(missingProfile(candidate));
  const bounds = [s.min, s.max, t.min, t.max];
  if (bounds.some(value => value === undefined || value === null)) return notMeasured('MIN_MAX_NOT_AVAILABLE');
  const inputs = [`${nodeKey(candidate.from)} min/max`, `${nodeKey(candidate.to)} min/max`];
  const [sMin, sMax, tMin, tMax] = bounds.map(numeric);
  if (sMin !== null && sMax !== null && tMin !== null && tMax !== null) {
    if (sMin < tMin || sMax > tMax) return { status: 'MEASURED', value: 'OUTSIDE_TARGET_RANGE', provenance: 'GLOBAL_WHOLE_TABLE', inputs };
    const span = tMax - tMin;
    return { status: 'MEASURED', value: span > 0 && (sMax - tMin) / span <= TIE_BREAK_CONSTANTS.RANGE_PREFIX_FRACTION ? 'SHORT_PREFIX_OF_TARGET_RANGE' : 'WITHIN_TARGET_RANGE', provenance: 'GLOBAL_WHOLE_TABLE', inputs };
  }
  if (bounds.every(value => typeof value === 'string' && numeric(value) === null)) {
    const [a, b, c, d] = bounds as string[];
    return { status: 'MEASURED', value: a! < c! || b! > d! ? 'OUTSIDE_TARGET_RANGE' : 'WITHIN_TARGET_RANGE', provenance: 'GLOBAL_WHOLE_TABLE', inputs };
  }
  return notMeasured('MIN_MAX_TYPES_NOT_COMPARABLE');
}

/**
 * The tie-break vector of one candidate. `context.candidates` is the candidate set that centrality and fan-out are counted over (X4: the HIGH unsuspected proposals; X5: the approved edges);
 * the candidate itself is always counted. Without a context both report NOT_MEASURED.
 */
export function tieBreakVector(candidate: TieCandidate, context?: { candidates?: readonly TieCandidate[] }): TieBreakVector {
  const nameExpansions: NameExpansion[] = [];
  const sourceTokens = entityTokens(columnTokens(candidate.from.column, candidate.from.table), 'SOURCE', nameExpansions);
  const targetTableTokens = entityTokens(rawTokens(candidate.to.table), 'TARGET', nameExpansions);
  const targetPool = [...targetTableTokens, ...entityTokens(columnTokens(candidate.to.column, candidate.to.table), 'TARGET', [])];
  const nameInputs = [`${nodeKey(candidate.from)} (column name)`, `${candidate.to.table} (table name)`];
  const nameVsTable: TieBreakVector['nameVsTable'] = { status: 'MEASURED', value: matched(sourceTokens, targetTableTokens), provenance: 'NAME_ONLY', inputs: nameInputs };
  const tokenContainment: TieBreakVector['tokenContainment'] = sourceTokens.length === 0 ? notMeasured('SOURCE_COLUMN_NAMES_NO_ENTITY')
    : { status: 'MEASURED', value: matched(sourceTokens, targetPool) / sourceTokens.length, provenance: 'NAME_ONLY', inputs: [...nameInputs.slice(0, 1), `${nodeKey(candidate.to)} (table and column name)`] };

  const s = profileOf(candidate.sourceProfile), t = profileOf(candidate.targetProfile);
  const profileInputs = [`profile ${nodeKey(candidate.from)}`, `profile ${nodeKey(candidate.to)}`];
  const ratio = (num: number | undefined, den: number | undefined, what: string): Feature<number> => !s || !t ? notMeasured(missingProfile(candidate))
    : num === undefined || den === undefined ? notMeasured(`${what}_NOT_AVAILABLE`) : den <= 0 ? notMeasured(`${what}_DENOMINATOR_ZERO`)
    : { status: 'MEASURED', value: num / den, provenance: 'GLOBAL_WHOLE_TABLE', inputs: profileInputs };
  const distinctRatio = ratio(s?.distinct, t?.distinct, 'DISTINCT');
  const rowRatio = ratio(s?.rows, t?.rows, 'ROWS');
  const avgLenDiff: Feature<number> = !s || !t ? notMeasured(missingProfile(candidate))
    : typeof s.avgLen !== 'number' || typeof t.avgLen !== 'number' ? notMeasured('AVG_LEN_NOT_AVAILABLE')
    : { status: 'MEASURED', value: Math.abs(s.avgLen - t.avgLen), provenance: 'GLOBAL_WHOLE_TABLE', inputs: profileInputs };

  const set = [...(context?.candidates ?? [])];
  if (context?.candidates && !set.some(item => item.id === candidate.id)) set.push(candidate);
  let targetCentrality: Feature<number> = notMeasured('NO_CANDIDATE_SET'), sourceFanOut: Feature<number> = notMeasured('NO_CANDIDATE_SET');
  if (context?.candidates) {
    const sources = new Set(set.filter(item => nodeKey(item.to) === nodeKey(candidate.to)).map(item => nodeKey(item.from)));
    targetCentrality = { status: 'MEASURED', value: sources.size, provenance: 'CANDIDATE_SET', inputs: [`${set.length} candidates in the set`] };
    sourceFanOut = candidate.reachesHigh === undefined ? notMeasured('REACH_NOT_PROVIDED')
      : { status: 'MEASURED', value: new Set(set.filter(item => nodeKey(item.from) === nodeKey(candidate.from) && item.reachesHigh === true).map(item => nodeKey(item.to))).size, provenance: 'CANDIDATE_SET', inputs: [`${set.length} candidates in the set`] };
  }
  return { candidateId: candidate.id, nameVsTable, nameExpansions, tokenContainment, distinctRatio, rowRatio, targetCentrality, sourceFanOut, avgLenDiff, rangeBias: rangeBiasOf(candidate) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- order

/**
 * The fixed, declared order of the tie-break (T36). Each step eliminates the candidates another survivor clearly beats; the first step to leave one survivor decides.
 * A step is skipped (and traced) when any survivor lacks its input. There are no weights: a step either separates or it does not.
 *   1. NAME_VS_TABLE        source column names the target entity: more shared entity tokens beats fewer (asymmetric; Chen s2, HoPF). Abbreviations expand through NAME_ABBREVIATIONS.
 *   2a. CARDINALITY_DISTINCT distinct(src)/distinct(tgt) inside 1+epsilon and closer to 1 beats farther by FOLD; above 1+epsilon is the worst (Chen LP2/s3).
 *   2b. CARDINALITY_ROWS    rows(src table)/rows(tgt table) capped at 1: a source table at least as large as the target beats a smaller one by FOLD (Rostin F10).
 *   3. otherwise            not decisive: the tie stays deferred and the sibling list is returned.
 * TARGET_CENTRALITY (Rostin F3/F5) is NOT a step: replayed over the 77 TPCDS tie groups of the Round 10 A/B integration it decided 20 groups and picked a non-gold hub (income_band) in 20 of 20,
 * because in a candidate set full of overlapping integer surrogates the smallest table is referenced by everything. It stays in the vector as information.
 */
export const TIE_STEP_ORDER = ['NAME_VS_TABLE', 'CARDINALITY_DISTINCT', 'CARDINALITY_ROWS'] as const;
export type TieStepId = typeof TIE_STEP_ORDER[number];
export interface TieTraceStep { step: TieStepId; outcome: 'SEPARATED' | 'EQUAL' | 'SKIPPED_NOT_MEASURED'; values: Record<string, string>; eliminated: string[] }
export interface TieOrdering<T extends TieCandidate = TieCandidate> {
  ordered: T[];
  decisive: boolean;
  /** Stable code first (`DECIDED_BY_<STEP>`, `NO_TIE`, `NOT_DECISIVE`, `EMPTY_GROUP`), then a readable sentence. */
  reason: string;
  decidedBy: TieStepId | null;
  /** The ids that remain tied after every step (the sibling list that stays deferred). Empty when decisive. */
  siblings: string[];
  vectors: TieBreakVector[];
  trace: TieTraceStep[];
}

const goodnessRatio = (feature: Feature<number>): number | null => feature.status === 'MEASURED' ? Math.min(feature.value, 1) : null;
const STEPS: { id: TieStepId; pick: (v: TieBreakVector) => number | null; beats: (a: number, b: number) => boolean }[] = [
  { id: 'NAME_VS_TABLE', pick: v => v.nameVsTable.status === 'MEASURED' ? v.nameVsTable.value : null, beats: (a, b) => a > b },
  { id: 'CARDINALITY_DISTINCT', pick: v => v.distinctRatio.status === 'MEASURED' ? (v.distinctRatio.value > 1 + TIE_BREAK_CONSTANTS.DISTINCT_RATIO_EPSILON ? 0 : Math.min(v.distinctRatio.value, 1)) : null, beats: (a, b) => a > b && a >= TIE_BREAK_CONSTANTS.FOLD * b },
  { id: 'CARDINALITY_ROWS', pick: v => goodnessRatio(v.rowRatio), beats: (a, b) => a > b && a >= TIE_BREAK_CONSTANTS.FOLD * b },
];
const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id, 'en');
const fmt = (value: number | null): string => value === null ? 'NOT_MEASURED' : String(Math.round(value * 1000) / 1000);

interface Elimination { survivors: number[]; trace: TieTraceStep[]; decidedBy: TieStepId | null; rounds: number[][] }
/** mode 'best': drop whoever another survivor beats. mode 'worst': drop whoever beats another survivor (what remains is the weakest). */
function eliminate(ids: readonly string[], vectors: readonly TieBreakVector[], mode: 'best' | 'worst'): Elimination {
  let survivors = vectors.map((_, index) => index);
  const trace: TieTraceStep[] = [], rounds: number[][] = [];
  let decidedBy: TieStepId | null = null;
  for (const step of STEPS) {
    if (survivors.length <= 1) break;
    const values = new Map(survivors.map(index => [index, step.pick(vectors[index]!)] as const));
    const shown = Object.fromEntries(survivors.map(index => [ids[index]!, fmt(values.get(index)!)]));
    if ([...values.values()].some(value => value === null)) { trace.push({ step: step.id, outcome: 'SKIPPED_NOT_MEASURED', values: shown, eliminated: [] }); continue; }
    const out = survivors.filter(x => survivors.some(y => y !== x && (mode === 'best' ? step.beats(values.get(y)!, values.get(x)!) : step.beats(values.get(x)!, values.get(y)!))));
    if (!out.length) { trace.push({ step: step.id, outcome: 'EQUAL', values: shown, eliminated: [] }); continue; }
    trace.push({ step: step.id, outcome: 'SEPARATED', values: shown, eliminated: out.map(index => ids[index]!) });
    rounds.push(out);
    survivors = survivors.filter(index => !out.includes(index));
    if (survivors.length === 1) decidedBy = step.id;
  }
  return { survivors, trace, decidedBy, rounds };
}

const contextOf = (group: readonly TieCandidate[], context?: { candidates?: readonly TieCandidate[] }): { candidates: TieCandidate[] } => {
  const set = [...(context?.candidates ?? [])];
  for (const item of group) if (!set.some(other => other.id === item.id)) set.push(item);
  return { candidates: set };
};

/**
 * Orders sibling candidates (same source column) with the declared steps. `context.candidates` extends the set centrality is counted over; the group itself is always included.
 * `decisive` is true only when exactly one candidate survives every step; otherwise the tie stays deferred and `siblings` lists the candidates still tied.
 */
export function orderTies<T extends TieCandidate>(group: readonly T[], context?: { candidates?: readonly TieCandidate[] }): TieOrdering<T> {
  if (group.length === 0) return { ordered: [], decisive: false, reason: 'EMPTY_GROUP: no candidates to order', decidedBy: null, siblings: [], vectors: [], trace: [] };
  const ctx = contextOf(group, context), items = [...group].sort(byId);
  const vectors = items.map(item => tieBreakVector(item, ctx)), ids = items.map(item => item.id);
  if (items.length === 1) return { ordered: items, decisive: true, reason: `NO_TIE: ${ids[0]} has no sibling`, decidedBy: null, siblings: [], vectors, trace: [] };
  const result = eliminate(ids, vectors, 'best');
  const rest = result.rounds.slice().reverse().flatMap(round => round.sort((a, b) => ids[a]!.localeCompare(ids[b]!, 'en')));
  const ordered = [...result.survivors, ...rest].map(index => items[index]!);
  if (result.survivors.length === 1) {
    const step = result.decidedBy!, winner = ids[result.survivors[0]!]!;
    const last = result.trace.filter(item => item.step === step && item.outcome === 'SEPARATED').at(-1)!;
    return { ordered, decisive: true, reason: `DECIDED_BY_${step}: ${winner} (${last.values[winner]}) over ${last.eliminated.map(id => `${id} (${last.values[id]})`).join(', ')}`, decidedBy: step, siblings: [], vectors, trace: result.trace };
  }
  const siblings = result.survivors.map(index => ids[index]!);
  const skipped = result.trace.filter(item => item.outcome === 'SKIPPED_NOT_MEASURED').map(item => item.step);
  return { ordered, decisive: false, reason: `NOT_DECISIVE: ${siblings.join(', ')} stay tied after ${TIE_STEP_ORDER.join(' > ')}${skipped.length ? ` (not measured: ${skipped.join(', ')})` : ''}`, decidedBy: null, siblings, vectors, trace: result.trace };
}

/** The weakest candidates of a set under the same declared steps; `decisive` when exactly one is the weakest (used to break a cycle). */
export function weakestOf<T extends TieCandidate>(items: readonly T[], context?: { candidates?: readonly TieCandidate[] }): { survivors: T[]; decisive: boolean; decidedBy: TieStepId | null; trace: TieTraceStep[] } {
  const sorted = [...items].sort(byId), ctx = contextOf(sorted, context);
  const vectors = sorted.map(item => tieBreakVector(item, ctx)), result = eliminate(sorted.map(item => item.id), vectors, 'worst');
  return { survivors: result.survivors.map(index => sorted[index]!), decisive: result.survivors.length === 1, decidedBy: result.decidedBy, trace: result.trace };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- E2-07

/** E2-07. Containment between two columns (`table.column` keys), both directions, as fractions of distinct keys (1 = all contained). */
export interface ColumnContainment { a: string; b: string; aInB: number | null; bInA: number | null }
export interface DerivedCopyFlag { a: string; b: string; rows: number; aInB: number; bInA: number; reason: 'DERIVED_COPY_EQUAL_ROWS_MUTUAL_CONTAINMENT' }
export interface DerivedCopies { copies: DerivedCopyFlag[]; notMeasured: { a: string; b: string; reason: string }[] }

const tableOf = (key: string): string => key.slice(0, key.lastIndexOf('.'));
const codePoint = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/**
 * E2-07. A table that duplicates another table's key column: containment of about 1 in both directions and the same number of rows. It is a FEATURE for the ranking and the reviewer
 * (a relation to a derived copy is not an FK); it never decides a verdict. Pairs inside one table are ignored; a pair with a missing profile or containment is listed as not measured.
 */
export function detectDerivedCopies(profiles: Readonly<Record<string, ProfileLike>>, containment: readonly ColumnContainment[]): DerivedCopies {
  const copies = new Map<string, DerivedCopyFlag>(), unmeasured = new Map<string, { a: string; b: string; reason: string }>();
  for (const pair of containment) {
    if (tableOf(pair.a) === tableOf(pair.b)) continue;
    const [a, b] = codePoint(pair.a, pair.b) <= 0 ? [pair.a, pair.b] : [pair.b, pair.a], key = `${a}|${b}`;
    const pa = profileOf(profiles[pair.a]), pb = profileOf(profiles[pair.b]);
    if (!pa || !pb) { unmeasured.set(key, { a, b, reason: `PROFILE_NOT_MEASURED:${!pa ? pair.a : pair.b}` }); continue; }
    if (pair.aInB === null || pair.bInA === null || !Number.isFinite(pair.aInB) || !Number.isFinite(pair.bInA)) { unmeasured.set(key, { a, b, reason: 'CONTAINMENT_NOT_MEASURED' }); continue; }
    if (pa.rows > 0 && pa.rows === pb.rows && pair.aInB >= TIE_BREAK_CONSTANTS.DERIVED_COPY_MIN_CONTAINMENT && pair.bInA >= TIE_BREAK_CONSTANTS.DERIVED_COPY_MIN_CONTAINMENT)
      copies.set(key, { a, b, rows: pa.rows, aInB: a === pair.a ? pair.aInB : pair.bInA, bInA: a === pair.a ? pair.bInA : pair.aInB, reason: 'DERIVED_COPY_EQUAL_ROWS_MUTUAL_CONTAINMENT' });
  }
  const order = (x: { a: string; b: string }, y: { a: string; b: string }) => codePoint(`${x.a}|${x.b}`, `${y.a}|${y.b}`);
  return { copies: [...copies.values()].sort(order), notMeasured: [...unmeasured.values()].filter(item => !copies.has(`${item.a}|${item.b}`)).sort(order) };
}
