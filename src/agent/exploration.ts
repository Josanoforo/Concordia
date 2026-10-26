import { identifier, type Zetaris } from '../clients/zetaris.ts';
import { zetarisSourceQuery } from '../relations/adapters/zetaris.ts';
import { failure, SafeError, trace, writeJson } from '../runtime.ts';
import { FORBIDDEN_COLUMN, SAFE_LITERAL, type ActionSpec, type ExplorationCatalog } from './catalog.ts';
import type { ActionChooser, ChoiceCall } from './chooser.ts';
import type { RunBudget } from './run-budget.ts';

export type BoundedTableRows = { source: string; columns: string[]; rows: unknown[][]; queryId: string; requestId: string; executionMode: string; dataOrigin: string };
export type ExplorationRead = BoundedTableRows & { actionId: string; sql: string; utc: string };
export type ExplorationRecord = { step: number; action: string; reason?: string; execution: 'PASS' | 'FAIL' | 'NOT_REQUIRED'; observation?: unknown; sql?: string; error?: object; adaptedFromObservedState: true };
/** A hint from the model's exploration to the probe ranking: the configured relation an executed read concerned, and why the model chose that read. It orders probes; it never decides a verdict. */
export interface ProbeHint { relationId: string; sourceAction: string; reason: string }
export const PROBE_HINT_REASON_LIMIT = 160;
/** One failed bounded read: exploration keeps going, and every failure is kept (the single `plannerError` only holds the last one). */
export interface ExplorationReadError { step: number; action: string; code: string; message?: string }
export interface ExplorationResult { calls: ChoiceCall[]; actions: ExplorationRecord[]; reads: Record<string, ExplorationRead>; plannerError?: object;
  /** Probe-ranking hints derived from the reads the model chose (absent when there are none). */
  hints?: ProbeHint[];
  /** Every read that failed, in order (absent when none). The run is DEGRADED when there is at least one. */
  explorationErrors?: ExplorationReadError[];
  /** Set only when the observation shown to the model was compacted for a wide universe (so the report can say "observation compacted"). */
  observationCompacted?: ObservationCompaction }
export interface ObservationCompaction { proposals?: { total: number; shown: number; omitted: number }; sampleColumns?: Record<string, { total: number; shown: number; omitted: number }> }

/**
 * Hints for the probe ranking: for every read the model chose and the executor ran (a recorded reason, execution PASS), the configured relations that have the read's
 * table and filter column as an endpoint. One hint per relation (the first read wins), reasons capped and stripped of control characters. Pure: no model call, no SQL.
 */
export function probeHintsFrom(actions: readonly ExplorationRecord[], catalog: ExplorationCatalog, relations: readonly any[]): ProbeHint[] {
  const hints: ProbeHint[] = [], seen = new Set<string>();
  for (const record of actions) {
    if (record.execution !== 'PASS' || !record.reason) continue;
    const spec = catalog.actions.find(item => item.id === record.action);
    if (!spec) continue;
    for (const relation of relations) {
      const touches = [relation.from, relation.to].some((end: any) => end?.table === spec.table && end?.column === spec.filterColumn);
      if (!touches || typeof relation.id !== 'string' || seen.has(relation.id)) continue;
      seen.add(relation.id);
      hints.push({ relationId: relation.id, sourceAction: record.action, reason: record.reason.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, PROBE_HINT_REASON_LIMIT) });
    }
  }
  return hints;
}

export function safeObservedValues(rows: readonly unknown[][], columns: readonly string[], column: string, pattern: RegExp, maximum = 20): string[] {
  const index = columns.indexOf(column); if (index < 0) return [];
  return [...new Set(rows.map(row => row[index]).filter(value => value !== null && value !== undefined).map(String).filter(value => pattern.test(value)))].slice(0, maximum);
}

export function sqlStringList(values: readonly string[], maximum = 50): string {
  if (!values.length || values.length > maximum || values.some(value => !SAFE_LITERAL.test(value))) throw new SafeError('AGENT_FILTER_VALUE_INVALID');
  return values.map(value => `'${value.replace(/'/g, "''")}'`).join(', ');
}

/** Values the executor may use as filters, derived only from rows already observed (discovery samples or earlier reads). */
export function observedValues(catalog: ExplorationCatalog, discovery: any, reads: Record<string, ExplorationRead>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, spec] of Object.entries(catalog.observations)) {
    const read = spec.supersededBy ? reads[spec.supersededBy] : undefined;
    const useRead = Boolean(read?.rows.length);
    const rows = useRead ? read!.rows : discovery.tables[spec.fromTable]?.sample?.rows ?? [];
    const columns = useRead ? read!.columns : discovery.tables[spec.fromTable]?.columns ?? [];
    const maximum = spec.max ?? 20;
    let values = safeObservedValues(rows, columns, spec.column, new RegExp(spec.pattern), maximum);
    if (spec.transform === 'integer-pad10-variants') values = values.flatMap(value => { const canonical = BigInt(value).toString(); return [canonical, canonical.padStart(10, '0')]; });
    out[name] = [...new Set(values)].slice(0, maximum);
  }
  return out;
}

export function allowedActionIds(catalog: ExplorationCatalog, discovery: any, state: Record<string, string[]>, attempted: ReadonlySet<string>): string[] {
  return [...catalog.actions.filter(action => !attempted.has(action.id) && (action.observation === undefined || state[action.observation]?.length) && discovery.tables[action.table]).map(action => action.id), 'STOP_EXPLORATION'];
}

/** Compiles one fixed template into SQL. Nothing here comes from a model. */
export function compileReadSql(action: ActionSpec, cfg: any, catalog: ExplorationCatalog, described: ReadonlySet<string>, values: readonly string[], limit: number): { sql: string; columns: string[]; source: string } {
  const spec = cfg.tables[action.table];
  if (action.kind === 'BOUNDED_PROFILE') return compileProfileSql(action, spec, described, limit);
  const list = sqlStringList(values);
  if (action.kind !== 'KEYED_READ') return compileKeyedSummarySql(action, spec, described, list, limit);
  if (spec.baseSql) {
    const columns: string[] = spec.columns.map((column: any) => column.name);
    return { sql: `SELECT ${columns.map(identifier).join(', ')} FROM (${zetarisSourceQuery(spec)}) concordia_source WHERE ${identifier(action.filterColumn)} IN (${list}) LIMIT ${limit}`, columns, source: `${spec.db}.${spec.physicalTable}` };
  }
  const selected = [...new Set([...spec.columns.map((column: any) => column.name), ...(catalog.safeOptionalColumns?.[action.table] ?? [])])]
    .filter(column => described.has(column) && !FORBIDDEN_COLUMN.test(column));
  if ((action.requiredColumns ?? []).some(column => !selected.includes(column))) throw new SafeError('AGENT_REQUIRED_COLUMN_UNAVAILABLE');
  return { sql: `SELECT ${selected.map(column => `\`${identifier(column)}\``).join(', ')} FROM ${identifier(spec.db)}.${identifier(spec.physicalTable)} WHERE ${identifier(action.filterColumn)} IN (${list}) LIMIT ${limit}`, columns: selected, source: `${spec.db}.${spec.physicalTable}` };
}

export const AGGREGATE_COUNT_COLUMN = 'concordia_count';
export const PROFILE_COLUMNS = ['concordia_rows', 'concordia_distinct', 'concordia_nulls'] as const;

/** BOUNDED_PROFILE: aggregates over the key column of at most `limit` rows. Only counts leave the source, never a value. */
function compileProfileSql(action: ActionSpec, spec: any, described: ReadonlySet<string>, limit: number): { sql: string; columns: string[]; source: string } {
  const key = identifier(action.filterColumn);
  if (FORBIDDEN_COLUMN.test(action.filterColumn)) throw new SafeError('AGENT_REQUIRED_COLUMN_UNAVAILABLE');
  let from: string;
  if (spec.baseSql) from = `(${zetarisSourceQuery(spec)}) concordia_source`;
  else {
    if (!described.has(action.filterColumn)) throw new SafeError('AGENT_REQUIRED_COLUMN_UNAVAILABLE');
    from = `${identifier(spec.db)}.${identifier(spec.physicalTable)}`;
  }
  const projection = spec.baseSql ? key : `\`${key}\``;
  const [rows, distinct, nulls] = PROFILE_COLUMNS;
  return { sql: `SELECT COUNT(*) AS ${rows}, COUNT(DISTINCT ${key}) AS ${distinct}, SUM(CASE WHEN ${key} IS NULL THEN 1 ELSE 0 END) AS ${nulls} FROM (SELECT ${projection} FROM ${from} LIMIT ${limit}) concordia_bounded`,
    columns: [...PROFILE_COLUMNS], source: `${spec.db}.${spec.physicalTable}` };
}

/** COMPARE_KEYS and AGGREGATE_COUNT: the projection is only the key (and its COUNT), so no other column can leave the source. */
function compileKeyedSummarySql(action: ActionSpec, spec: any, described: ReadonlySet<string>, list: string, limit: number): { sql: string; columns: string[]; source: string } {
  const key = identifier(action.filterColumn), aggregate = action.kind === 'AGGREGATE_COUNT';
  if (FORBIDDEN_COLUMN.test(action.filterColumn)) throw new SafeError('AGENT_REQUIRED_COLUMN_UNAVAILABLE');
  let from: string;
  if (spec.baseSql) from = `(${zetarisSourceQuery(spec)}) concordia_source`;
  else {
    if (!described.has(action.filterColumn)) throw new SafeError('AGENT_REQUIRED_COLUMN_UNAVAILABLE');
    from = `${identifier(spec.db)}.${identifier(spec.physicalTable)}`;
  }
  const projection = spec.baseSql ? key : `\`${key}\``;
  const sql = aggregate
    ? `SELECT ${projection}, COUNT(*) AS ${AGGREGATE_COUNT_COLUMN} FROM ${from} WHERE ${key} IN (${list}) GROUP BY ${projection} LIMIT ${limit}`
    : `SELECT DISTINCT ${projection} FROM ${from} WHERE ${key} IN (${list}) LIMIT ${limit}`;
  return { sql, columns: aggregate ? [action.filterColumn, AGGREGATE_COUNT_COLUMN] : [action.filterColumn], source: `${spec.db}.${spec.physicalTable}` };
}

/** What the executor derived from a COMPARE_KEYS / AGGREGATE_COUNT read; undefined for KEYED_READ so existing records do not change. */
export function summarizeRead(action: ActionSpec, observed: readonly string[], columns: readonly string[], rows: readonly unknown[][], limit = Infinity): unknown {
  if (action.kind === 'KEYED_READ') return undefined;
  if (action.kind === 'BOUNDED_PROFILE') {
    const at = (name: string) => { const value = Number(rows[0]?.[columns.indexOf(name)] ?? 0); return Number.isFinite(value) ? value : 0; };
    const total = at(PROFILE_COLUMNS[0]);
    return { kind: action.kind, rows: total, distinct: at(PROFILE_COLUMNS[1]), nulls: at(PROFILE_COLUMNS[2]), limit, bounded: total >= limit };
  }
  const keyIndex = columns.indexOf(action.filterColumn), keys = rows.map(row => String(row[keyIndex]));
  if (action.kind === 'COMPARE_KEYS') {
    return { kind: action.kind, observedKeys: observed.length, present: observed.filter(value => keys.includes(value)), missing: observed.filter(value => !keys.includes(value)) };
  }
  const countIndex = columns.indexOf(AGGREGATE_COUNT_COLUMN);
  return { kind: action.kind, counts: Object.fromEntries(rows.map(row => [String(row[keyIndex]), Number(row[countIndex])])), keysWithRows: rows.length,
    keysWithoutRows: observed.filter(value => !keys.includes(value)) };
}

/** Rows of each catalog table shown to the model; the full bounded sample stays in discovery.json. */
export const SAMPLE_ROWS_IN_PROMPT = 3;

/** COMA out-of-scope proposals reduced to what a planner can use (endpoints and score); hashes, evidence ids and provider metadata stay in engine-run.json. */
export function compactProposals(proposals: unknown, relevantTables?: ReadonlySet<string>): unknown { return compactProposalsView(proposals, relevantTables).list; }

/** Above this many out-of-scope proposals the observation keeps only the most structurally relevant ones; narrower universes are untouched (byte-identical prompt). */
export const COMPACT_PROPOSALS_THRESHOLD = 40, COMPACT_PROPOSALS_SHOWN = 25, MAX_COLUMNS_IN_PROMPT = 30;
export interface ProposalsView { list: unknown[]; summary?: { compacted: true; total: number; shown: number; omitted: number; scoreMin: number | null; scoreMax: number | null; topTables: { table: string; count: number }[]; note: string } }
export function compactProposalsView(proposals: unknown, relevantTables: ReadonlySet<string> = new Set()): ProposalsView {
  if (!Array.isArray(proposals)) return { list: [] };
  const all = proposals.map((item: any) => ({ from: `${item?.from?.table}.${item?.from?.column}`, to: `${item?.to?.table}.${item?.to?.column}`, score: typeof item?.rawScore === 'number' ? Math.round(item.rawScore * 100) / 100 : null, ft: String(item?.from?.table), tt: String(item?.to?.table) }));
  const plain = (item: typeof all[number]) => ({ from: item.from, to: item.to, score: item.score });
  if (all.length <= COMPACT_PROPOSALS_THRESHOLD) return { list: all.map(plain) };
  const relevance = (item: typeof all[number]) => (relevantTables.has(item.ft) || relevantTables.has(item.tt) ? 0 : 1);
  const ranked = [...all].sort((a, b) => relevance(a) - relevance(b) || (b.score ?? -1) - (a.score ?? -1) || (a.from + '|' + a.to).localeCompare(b.from + '|' + b.to, 'en'));
  const shown = ranked.slice(0, COMPACT_PROPOSALS_SHOWN), counts = new Map<string, number>();
  for (const item of all) for (const table of new Set([item.ft, item.tt])) counts.set(table, (counts.get(table) ?? 0) + 1);
  const scores = all.flatMap(item => item.score === null ? [] : [item.score]);
  return { list: shown.map(plain), summary: { compacted: true, total: all.length, shown: shown.length, omitted: all.length - shown.length,
    scoreMin: scores.length ? Math.min(...scores) : null, scoreMax: scores.length ? Math.max(...scores) : null,
    topTables: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en')).slice(0, 10).map(([table, count]) => ({ table, count })),
    note: `Only ${shown.length} of ${all.length} out-of-scope proposals are shown (${all.length - shown.length} omitted), ranked by relevance to the catalog tables and then by score.` } };
}

function samples(catalog: ExplorationCatalog, discovery: any, reads: Record<string, ExplorationRead>, compaction?: ObservationCompaction) {
  const tables = new Set([...catalog.actions.map(action => action.table), ...Object.values(catalog.observations).map(spec => spec.fromTable)]);
  return Object.fromEntries([...tables].filter(table => discovery.tables[table]).map(table => {
    const read = Object.values(reads).find(item => item.rows.length && catalog.actions.find(action => action.id === item.actionId && action.kind === 'KEYED_READ')?.table === table);
    const allColumns: string[] = read ? read.columns : discovery.tables[table].columns ?? [];
    const rows: unknown[][] = read ? read.rows : discovery.tables[table].sample?.rows ?? [];
    const kept = allColumns.map((column, index) => ({ column, index })).filter(item => !FORBIDDEN_COLUMN.test(item.column));
    const wide = kept.length > MAX_COLUMNS_IN_PROMPT, shownColumns = wide ? kept.slice(0, MAX_COLUMNS_IN_PROMPT) : kept;
    if (wide && compaction) (compaction.sampleColumns ??= {})[table] = { total: kept.length, shown: shownColumns.length, omitted: kept.length - shownColumns.length };
    return [table, { queryId: read ? read.queryId : discovery.tables[table].sample?.queryId ?? null, columns: shownColumns.map(item => item.column),
      rows: rows.slice(0, SAMPLE_ROWS_IN_PROMPT).map(row => Object.fromEntries(shownColumns.map(item => [item.column, row[item.index] ?? null]))),
      ...(wide ? { columnsOmitted: kept.length - shownColumns.length } : {}) }];
  }));
}

export async function runExploration(o: { runId: string; cfg: any; catalog: ExplorationCatalog; discovery: any; sourceColumns: Record<string, { name: string; type: string }[]>;
  client: Pick<Zetaris, 'runSql'>; chooser?: ActionChooser; budget: RunBudget; extraObservation?: unknown; executionMode: string; dataOrigin: string; persistPrefix?: string;
  /** Continue a stopped exploration: earlier reads and attempted actions are kept, only `maxNewSteps` model decisions are made, in compact form. */
  resume?: { reads: Record<string, ExplorationRead>; actions: ExplorationRecord[]; attempted: string[]; firstStep: number }; maxNewSteps?: number; compact?: boolean }): Promise<ExplorationResult> {
  const { catalog, cfg, discovery, budget } = o, limit = budget.limits.readLimit;
  const result: ExplorationResult = { calls: [], actions: [...(o.resume?.actions ?? [])], reads: { ...(o.resume?.reads ?? {}) } };
  const attempted = new Set<string>(o.resume?.attempted ?? []);
  let newSteps = 0;
  if (!o.chooser) return { ...result, plannerError: { code: 'AGENT_CHOOSER_UNAVAILABLE' } };
  while (budget.canStep() && newSteps < (o.maxNewSteps ?? Infinity)) {
    const state = observedValues(catalog, discovery, result.reads);
    const allowed = allowedActionIds(catalog, discovery, state, attempted);
    if (!budget.canAskModel()) { result.plannerError = { code: 'AGENT_TOKEN_BUDGET_EXHAUSTED' }; break; }
    const compaction: ObservationCompaction = {};
    const catalogTables = new Set([...catalog.actions.map(action => action.table), ...Object.values(catalog.observations).map(spec => spec.fromTable)]);
    const proposalView = compactProposalsView(o.extraObservation, catalogTables);
    if (proposalView.summary) compaction.proposals = { total: proposalView.summary.total, shown: proposalView.summary.shown, omitted: proposalView.summary.omitted };
    const observation = { scope: cfg.scope, ...state, samples: samples(catalog, discovery, result.reads, compaction),
      comaOutOfScopeProposals: proposalView.list, ...(proposalView.summary ? { comaOutOfScopeSummary: proposalView.summary } : {}), completedActions: result.actions };
    if (compaction.proposals || compaction.sampleColumns) { result.observationCompacted = compaction; trace({ kind: 'agent-observation-compacted', runId: o.runId, ...compaction }); }
    const stage = `select_bounded_read_${budget.steps + 1}`;
    const estimated = o.chooser.estimateTokens?.(stage, observation, allowed, { compact: o.compact });
    if (estimated !== undefined && !budget.canAfford(estimated)) { result.plannerError = budget.wouldExceed(estimated); trace({ kind: 'agent-adaptive-model-skipped', runId: o.runId, stage, ...result.plannerError }); break; }
    const step = ++budget.steps; newSteps++;
    const call: ChoiceCall = await o.chooser.choose(stage, observation, allowed, { compact: o.compact, canRetry: tokens => budget.canAfford(tokens) });
    call.allowed = [...allowed];
    result.calls.push(call);
    budget.chargeTokens(call.tokensCharged ?? call.receipt?.totalTokens ?? 0);
    if (call.decisionStatus !== 'VALID' || !call.selected) { result.plannerError = call.error ?? { code: 'MODEL_DECISION_UNAVAILABLE' }; break; }
    const actionId = call.selected;
    if (actionId === 'STOP_EXPLORATION') { result.actions.push({ step, action: actionId, reason: call.reason, execution: 'NOT_REQUIRED', adaptedFromObservedState: true }); break; }
    const action = catalog.actions.find(item => item.id === actionId);
    if (!action || !allowed.includes(actionId)) { result.plannerError = { code: 'AGENT_ACTION_NOT_PERMITTED' }; break; }
    attempted.add(actionId);
    try {
      const described = new Set((o.sourceColumns[action.table] ?? []).map(column => column.name));
      const compiled = compileReadSql(action, cfg, catalog, described, action.observation ? state[action.observation] : [], limit);
      const queried = await o.client.runSql(compiled.sql, limit);
      const read: ExplorationRead = { actionId, source: compiled.source, columns: compiled.columns, rows: queried.rows, queryId: queried.queryId, requestId: queried.requestId,
        executionMode: o.executionMode, dataOrigin: o.dataOrigin, sql: compiled.sql, utc: queried.utc };
      result.reads[actionId] = read;
      if (o.persistPrefix) writeJson(`${o.persistPrefix}adaptive-read-${actionId.toLowerCase()}.json`, { ...read, limit });
      const observation = { queryId: queried.queryId, requestId: queried.requestId, rows: queried.rows.length, columns: compiled.columns, observedAfter: observedValues(catalog, discovery, result.reads),
        ...(action.kind === 'KEYED_READ' ? {} : { summary: summarizeRead(action, action.observation ? state[action.observation]! : [], compiled.columns, queried.rows, limit) }) };
      result.actions.push({ step, action: actionId, reason: call.reason, execution: 'PASS', observation, sql: compiled.sql, adaptedFromObservedState: true });
      trace({ kind: 'agent-adaptive-read', runId: o.runId, action: actionId, status: 'PASS', queryId: queried.queryId, requestId: queried.requestId, rows: queried.rows.length, sql: compiled.sql, limit });
    } catch (error) {
      const diagnostic = failure(error);
      result.actions.push({ step, action: actionId, reason: call.reason, execution: 'FAIL', error: diagnostic, adaptedFromObservedState: true });
      trace({ kind: 'agent-adaptive-read', runId: o.runId, action: actionId, status: 'FAIL', ...diagnostic });
      result.plannerError = diagnostic;
      (result.explorationErrors ??= []).push({ step, action: actionId, code: diagnostic.code, ...(diagnostic.detail ? { message: diagnostic.detail } : {}) });
    }
  }
  const hints = probeHintsFrom(result.actions, catalog, cfg.relations ?? []);
  if (hints.length) result.hints = hints;
  return result;
}
