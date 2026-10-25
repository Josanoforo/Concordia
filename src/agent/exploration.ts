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
  if (spec.baseSql) {
    const columns: string[] = spec.columns.map((column: any) => column.name);
    return { sql: `SELECT ${columns.map(identifier).join(', ')} FROM (${zetarisSourceQuery(spec)}) concordia_source WHERE ${identifier(action.filterColumn)} IN (${list}) LIMIT ${limit}`, columns, source: `${spec.db}.${spec.physicalTable}` };
  }
  const selected = [...new Set([...spec.columns.map((column: any) => column.name), ...(catalog.safeOptionalColumns?.[action.table] ?? [])])]
    .filter(column => described.has(column) && !FORBIDDEN_COLUMN.test(column));
  if ((action.requiredColumns ?? []).some(column => !selected.includes(column))) throw new SafeError('AGENT_REQUIRED_COLUMN_UNAVAILABLE');
  return { sql: `SELECT ${selected.map(column => `\`${identifier(column)}\``).join(', ')} FROM ${identifier(spec.db)}.${identifier(spec.physicalTable)} WHERE ${identifier(action.filterColumn)} IN (${list}) LIMIT ${limit}`, columns: selected, source: `${spec.db}.${spec.physicalTable}` };
}

function samples(catalog: ExplorationCatalog, discovery: any, reads: Record<string, ExplorationRead>) {
  const tables = new Set([...catalog.actions.map(action => action.table), ...Object.values(catalog.observations).map(spec => spec.fromTable)]);
  return Object.fromEntries([...tables].filter(table => discovery.tables[table]).map(table => {
    const read = Object.values(reads).find(item => item.rows.length && catalog.actions.find(action => action.id === item.actionId)?.table === table);
    const columns: string[] = read ? read.columns : discovery.tables[table].columns ?? [];
    const rows: unknown[][] = read ? read.rows : discovery.tables[table].sample?.rows ?? [];
    return [table, { queryId: read ? read.queryId : discovery.tables[table].sample?.queryId ?? null, columns,
      rows: rows.slice(0, 10).map(row => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null]))) }];
  }));
}

export async function runExploration(o: { runId: string; cfg: any; catalog: ExplorationCatalog; discovery: any; sourceColumns: Record<string, { name: string; type: string }[]>;
  client: Pick<Zetaris, 'runSql'>; chooser?: ActionChooser; budget: RunBudget; extraObservation?: unknown; executionMode: string; dataOrigin: string; persistPrefix?: string }): Promise<ExplorationResult> {
  const { catalog, cfg, discovery, budget } = o, limit = budget.limits.readLimit;
  const result: ExplorationResult = { calls: [], actions: [], reads: {} };
  const attempted = new Set<string>();
  if (!o.chooser) return { ...result, plannerError: { code: 'AGENT_CHOOSER_UNAVAILABLE' } };
  while (budget.canStep()) {
    const state = observedValues(catalog, discovery, result.reads);
    const allowed = allowedActionIds(catalog, discovery, state, attempted);
    if (!budget.canAskModel()) { result.plannerError = { code: 'AGENT_TOKEN_BUDGET_EXHAUSTED' }; break; }
    const step = ++budget.steps;
    const call: ChoiceCall = await o.chooser.choose(`select_bounded_read_${step}`, { scope: cfg.scope, ...state, samples: samples(catalog, discovery, result.reads),
      comaOutOfScopeProposals: o.extraObservation ?? [], completedActions: result.actions }, allowed);
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
      const observation = { queryId: queried.queryId, requestId: queried.requestId, rows: queried.rows.length, columns: compiled.columns, observedAfter: observedValues(catalog, discovery, result.reads) };
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
