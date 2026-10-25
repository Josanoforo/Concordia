import { identifier, type Zetaris } from '../clients/zetaris.ts';
import { zetarisSourceQuery } from '../relations/adapters/zetaris.ts';
import { failure, SafeError, trace, writeJson } from '../runtime.ts';
import { FORBIDDEN_COLUMN, SAFE_LITERAL, type ActionSpec, type ExplorationCatalog } from './catalog.ts';
import type { ActionChooser, ChoiceCall } from './chooser.ts';
import type { RunBudget } from './run-budget.ts';

export type BoundedTableRows = { source: string; columns: string[]; rows: unknown[][]; queryId: string; requestId: string; executionMode: string; dataOrigin: string };
export type ExplorationRead = BoundedTableRows & { actionId: string; sql: string; utc: string };
export type ExplorationRecord = { step: number; action: string; reason?: string; execution: 'PASS' | 'FAIL' | 'NOT_REQUIRED'; observation?: unknown; sql?: string; error?: object; adaptedFromObservedState: true };
export interface ExplorationResult { calls: ChoiceCall[]; actions: ExplorationRecord[]; reads: Record<string, ExplorationRead>; plannerError?: object }

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
  return [...catalog.actions.filter(action => !attempted.has(action.id) && state[action.observation]?.length && discovery.tables[action.table]).map(action => action.id), 'STOP_EXPLORATION'];
}

/** Compiles one fixed template into SQL. Nothing here comes from a model. */
export function compileReadSql(action: ActionSpec, cfg: any, catalog: ExplorationCatalog, described: ReadonlySet<string>, values: readonly string[], limit: number): { sql: string; columns: string[]; source: string } {
  const spec = cfg.tables[action.table];
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
export function summarizeRead(action: ActionSpec, observed: readonly string[], columns: readonly string[], rows: readonly unknown[][]): unknown {
  if (action.kind === 'KEYED_READ') return undefined;
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
export function compactProposals(proposals: unknown): unknown {
  if (!Array.isArray(proposals)) return [];
  return proposals.map((item: any) => ({ from: `${item?.from?.table}.${item?.from?.column}`, to: `${item?.to?.table}.${item?.to?.column}`, score: typeof item?.rawScore === 'number' ? Math.round(item.rawScore * 100) / 100 : null }));
}

function samples(catalog: ExplorationCatalog, discovery: any, reads: Record<string, ExplorationRead>) {
  const tables = new Set([...catalog.actions.map(action => action.table), ...Object.values(catalog.observations).map(spec => spec.fromTable)]);
  return Object.fromEntries([...tables].filter(table => discovery.tables[table]).map(table => {
    const read = Object.values(reads).find(item => item.rows.length && catalog.actions.find(action => action.id === item.actionId && action.kind === 'KEYED_READ')?.table === table);
    const allColumns: string[] = read ? read.columns : discovery.tables[table].columns ?? [];
    const rows: unknown[][] = read ? read.rows : discovery.tables[table].sample?.rows ?? [];
    const kept = allColumns.map((column, index) => ({ column, index })).filter(item => !FORBIDDEN_COLUMN.test(item.column));
    return [table, { queryId: read ? read.queryId : discovery.tables[table].sample?.queryId ?? null, columns: kept.map(item => item.column),
      rows: rows.slice(0, SAMPLE_ROWS_IN_PROMPT).map(row => Object.fromEntries(kept.map(item => [item.column, row[item.index] ?? null]))) }];
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
    const observation = { scope: cfg.scope, ...state, samples: samples(catalog, discovery, result.reads),
      comaOutOfScopeProposals: compactProposals(o.extraObservation), completedActions: result.actions };
    const stage = `select_bounded_read_${budget.steps + 1}`;
    const estimated = o.chooser.estimateTokens?.(stage, observation, allowed, { compact: o.compact });
    if (estimated !== undefined && !budget.canAfford(estimated)) { result.plannerError = budget.wouldExceed(estimated); trace({ kind: 'agent-adaptive-model-skipped', runId: o.runId, stage, ...result.plannerError }); break; }
    const step = ++budget.steps; newSteps++;
    const call: ChoiceCall = await o.chooser.choose(stage, observation, allowed, { compact: o.compact });
    result.calls.push(call);
    budget.chargeTokens(call.receipt?.totalTokens ?? 0);
    if (call.decisionStatus !== 'VALID' || !call.selected) { result.plannerError = call.error ?? { code: 'U2_ADAPTIVE_DECISION_UNAVAILABLE' }; break; }
    const actionId = call.selected;
    if (actionId === 'STOP_EXPLORATION') { result.actions.push({ step, action: actionId, reason: call.reason, execution: 'NOT_REQUIRED', adaptedFromObservedState: true }); break; }
    const action = catalog.actions.find(item => item.id === actionId);
    if (!action || !allowed.includes(actionId)) { result.plannerError = { code: 'AGENT_ACTION_NOT_PERMITTED' }; break; }
    attempted.add(actionId);
    try {
      const described = new Set((o.sourceColumns[action.table] ?? []).map(column => column.name));
      const compiled = compileReadSql(action, cfg, catalog, described, state[action.observation], limit);
      const queried = await o.client.runSql(compiled.sql, limit);
      const read: ExplorationRead = { actionId, source: compiled.source, columns: compiled.columns, rows: queried.rows, queryId: queried.queryId, requestId: queried.requestId,
        executionMode: o.executionMode, dataOrigin: o.dataOrigin, sql: compiled.sql, utc: queried.utc };
      result.reads[actionId] = read;
      if (o.persistPrefix) writeJson(`${o.persistPrefix}adaptive-read-${actionId.toLowerCase()}.json`, { ...read, limit });
      const observation = { queryId: queried.queryId, requestId: queried.requestId, rows: queried.rows.length, columns: compiled.columns, observedAfter: observedValues(catalog, discovery, result.reads),
        ...(action.kind === 'KEYED_READ' ? {} : { summary: summarizeRead(action, state[action.observation]!, compiled.columns, queried.rows) }) };
      result.actions.push({ step, action: actionId, reason: call.reason, execution: 'PASS', observation, sql: compiled.sql, adaptedFromObservedState: true });
      trace({ kind: 'agent-adaptive-read', runId: o.runId, action: actionId, status: 'PASS', queryId: queried.queryId, requestId: queried.requestId, rows: queried.rows.length, sql: compiled.sql, limit });
    } catch (error) {
      const diagnostic = failure(error);
      result.actions.push({ step, action: actionId, reason: call.reason, execution: 'FAIL', error: diagnostic, adaptedFromObservedState: true });
      trace({ kind: 'agent-adaptive-read', runId: o.runId, action: actionId, status: 'FAIL', ...diagnostic });
      result.plannerError = diagnostic;
    }
  }
  return result;
}
