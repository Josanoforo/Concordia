/**
 * Exploration catalog: the fixed action templates a universe lets the agent choose from.
 * It lives in the universe config (validated by the registry together with the AGENT_EXPLORATION bound).
 * The model only ever selects an action id; columns, filters and SQL come from here and from observed rows.
 */
import type { JoinAlternativeSpec } from './join-compare.ts';

export interface ObservationSpec {
  /** Table whose bounded rows provide the values (discovery sample, or the read of `supersededBy` once it has rows). */
  fromTable: string;
  column: string;
  /** Regular expression every observed value must match. */
  pattern: string;
  transform?: 'identity' | 'integer-pad10-variants';
  max?: number;
  supersededBy?: string;
}
/**
 * Fixed action kinds, all compiled by the executor from the allowlist (the model only picks an id):
 * - KEYED_READ: the table's allowlisted columns where filterColumn IN (observed values).
 * - COMPARE_KEYS: only filterColumn, DISTINCT, where it IN (observed values); the executor reports which observed keys are present and which are missing.
 * - AGGREGATE_COUNT: filterColumn and COUNT(*) per key, grouped, for the observed values.
 * All three carry a LIMIT; COMPARE_KEYS and AGGREGATE_COUNT never project anything but the key and the count.
 */
export const ACTION_KINDS = ['KEYED_READ', 'COMPARE_KEYS', 'AGGREGATE_COUNT'] as const;
export type ActionKind = typeof ACTION_KINDS[number];
export interface ActionSpec {
  id: string;
  kind: ActionKind;
  table: string;
  requiredColumns?: string[];
  filterColumn: string;
  /** Name of the observation whose values fill the IN (...) list. */
  observation: string;
  description?: string;
}
export interface ExplorationCatalog {
  /** Optional declared join alternatives the generic comparator (join-compare.ts) measures over observed rows. */
  joinAlternatives?: JoinAlternativeSpec[];
  /** Extra non-sensitive columns per table that reads and schema matching may use when actually described. */
  safeOptionalColumns?: Record<string, string[]>;
  productLabel: string;
  plannerTask: string;
  /** Optional post-COMA policy: how many coverage probes the agent may run for out-of-scope COMA proposals (default 2; 0 disables execution). */
  postComa?: { maxProbes: number };
  observations: Record<string, ObservationSpec>;
  actions: ActionSpec[];
}
export interface CatalogIssue { path: string; code: string }

export const FORBIDDEN_COLUMN = /address|officer|contact|phone|email|street|city|state|zip|postal/i;
export const SAFE_LITERAL = /^[A-Za-z0-9._-]{1,64}$/;
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const safeColumn = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

export function catalogOf(config: any): ExplorationCatalog | undefined { return config?.explorationCatalog; }

/** Pure validation of a universe config's catalog against its own table allowlist. */
export function validateExplorationCatalog(config: any, path: string): CatalogIssue[] {
  const issues: CatalogIssue[] = [], catalog = catalogOf(config);
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return [{ path, code: 'EXPLORATION_CATALOG_REQUIRED' }];
  const tables: Record<string, any> = config.tables ?? {};
  if (typeof catalog.productLabel !== 'string' || !/^[A-Za-z0-9 _.-]{1,40}$/.test(catalog.productLabel)) issues.push({ path: `${path}.productLabel`, code: 'INVALID_PRODUCT_LABEL' });
  if (typeof catalog.plannerTask !== 'string' || !/^[A-Za-z0-9 _.,-]{1,120}$/.test(catalog.plannerTask)) issues.push({ path: `${path}.plannerTask`, code: 'INVALID_PLANNER_TASK' });
  for (const [table, columns] of Object.entries<any>(catalog.safeOptionalColumns ?? {})) {
    if (!tables[table] || !Array.isArray(columns) || columns.some((column: unknown) => !safeColumn(column) || FORBIDDEN_COLUMN.test(column as string))) issues.push({ path: `${path}.safeOptionalColumns.${table}`, code: 'INVALID_SAFE_OPTIONAL_COLUMNS' });
  }
  if (catalog.postComa !== undefined && (!catalog.postComa || typeof catalog.postComa !== 'object' || !Number.isInteger(catalog.postComa.maxProbes) || catalog.postComa.maxProbes < 0 || catalog.postComa.maxProbes > 5)) issues.push({ path: `${path}.postComa`, code: 'INVALID_POST_COMA_POLICY' });
  const observations = catalog.observations;
  if (!observations || typeof observations !== 'object' || Array.isArray(observations)) issues.push({ path: `${path}.observations`, code: 'EXPECTED_OBSERVATION_MAP' });
  const actions = Array.isArray(catalog.actions) ? catalog.actions : [];
  if (!Array.isArray(catalog.actions) || !actions.length) issues.push({ path: `${path}.actions`, code: 'EXPECTED_ACTION_LIST' });
  const actionIds = actions.map((action: any) => action?.id);
  if (actionIds.some((id: unknown) => !safeId(id) || id === 'STOP_EXPLORATION') || new Set(actionIds).size !== actionIds.length) issues.push({ path: `${path}.actions`, code: 'INVALID_OR_DUPLICATE_ACTION_ID' });
  const observationEntries = observations && typeof observations === 'object' ? Object.entries<any>(observations) : [];
  for (const [name, spec] of observationEntries) {
    const here = `${path}.observations.${name}`;
    if (!safeId(name) || !spec || typeof spec !== 'object') { issues.push({ path: here, code: 'INVALID_OBSERVATION' }); continue; }
    if (!tables[spec.fromTable] || !(tables[spec.fromTable].columns ?? []).some((column: any) => column?.name === spec.column) || !safeColumn(spec.column)) issues.push({ path: here, code: 'OBSERVATION_OUTSIDE_ALLOWLIST' });
    try { new RegExp(spec.pattern); } catch { issues.push({ path: `${here}.pattern`, code: 'INVALID_OBSERVATION_PATTERN' }); }
    if (spec.transform !== undefined && !['identity', 'integer-pad10-variants'].includes(spec.transform)) issues.push({ path: `${here}.transform`, code: 'INVALID_OBSERVATION_TRANSFORM' });
    if (spec.max !== undefined && (!Number.isInteger(spec.max) || spec.max < 1 || spec.max > 50)) issues.push({ path: `${here}.max`, code: 'INVALID_OBSERVATION_MAX' });
    if (spec.supersededBy !== undefined && !actionIds.includes(spec.supersededBy)) issues.push({ path: `${here}.supersededBy`, code: 'UNKNOWN_SUPERSEDING_ACTION' });
  }
  actions.forEach((action: any, index: number) => {
    const here = `${path}.actions[${index}]`;
    if (!action || typeof action !== 'object' || !(ACTION_KINDS as readonly unknown[]).includes(action.kind)) { issues.push({ path: here, code: 'UNSUPPORTED_ACTION_KIND' }); return; }
    const table = tables[action.table];
    if (!table) { issues.push({ path: `${here}.table`, code: 'ACTION_OUTSIDE_ALLOWLIST' }); return; }
    const allowed = new Set<string>((table.columns ?? []).map((column: any) => column?.name));
    if (!allowed.has(action.filterColumn)) issues.push({ path: `${here}.filterColumn`, code: 'ACTION_OUTSIDE_ALLOWLIST' });
    if (!observationEntries.some(([name]) => name === action.observation)) issues.push({ path: `${here}.observation`, code: 'UNKNOWN_OBSERVATION' });
    if (action.kind !== 'KEYED_READ') {
      if (action.requiredColumns !== undefined || FORBIDDEN_COLUMN.test(String(action.filterColumn))) issues.push({ path: here, code: 'FORBIDDEN_OR_INVALID_COLUMN' });
      return;
    }
    const optional: string[] = catalog.safeOptionalColumns?.[action.table] ?? [];
    for (const column of [...optional, ...(action.requiredColumns ?? [])]) if (!safeColumn(column) || FORBIDDEN_COLUMN.test(column)) issues.push({ path: here, code: 'FORBIDDEN_OR_INVALID_COLUMN' });
    if (table.baseSql && optional.length > 0) issues.push({ path: `${here}.table`, code: 'DERIVED_TABLE_HAS_NO_OPTIONAL_COLUMNS' });
    for (const column of action.requiredColumns ?? []) if (!allowed.has(column) && !optional.includes(column)) issues.push({ path: `${here}.requiredColumns`, code: 'ACTION_OUTSIDE_ALLOWLIST' });
  });
  issues.push(...validateJoinAlternatives(catalog.joinAlternatives, tables, `${path}.joinAlternatives`, catalog.safeOptionalColumns));
  return issues;
}

/** Declared join alternatives: known tables, allowlisted and non-sensitive columns, one normalization per column, unique choices. */
export function validateJoinAlternatives(specs: unknown, tables: Record<string, any>, path: string, safeOptional: Record<string, string[]> = {}): CatalogIssue[] {
  if (specs === undefined) return [];
  if (!Array.isArray(specs) || !specs.length || specs.length > 12) return [{ path, code: 'INVALID_JOIN_ALTERNATIVES' }];
  const issues: CatalogIssue[] = [], choices = new Set<string>();
  const modes = ['text', 'integer', 'integer-pad10'];
  specs.forEach((spec: any, index: number) => {
    const here = `${path}[${index}]`;
    if (!spec || typeof spec !== 'object' || !safeId(spec.choice) || spec.choice === 'NO_JOIN' || choices.has(spec.choice) || (spec.family !== undefined && !safeId(spec.family))) { issues.push({ path: here, code: 'INVALID_OR_DUPLICATE_JOIN_CHOICE' }); return; }
    choices.add(spec.choice);
    const sides = [spec.source, spec.target];
    for (const side of sides) {
      const columns = side?.columns, table = tables[side?.table];
      if (!table || !Array.isArray(columns) || columns.length < 1 || columns.length > 4 || columns.some((column: unknown) => !safeColumn(column) || FORBIDDEN_COLUMN.test(column as string))) { issues.push({ path: here, code: 'INVALID_JOIN_SIDE' }); return; }
      const allowed = new Set<string>([...(table.columns ?? []).map((column: any) => column?.name), ...(safeOptional[side.table] ?? [])]);
      if (columns.some((column: string) => !allowed.has(column))) { issues.push({ path: here, code: 'JOIN_OUTSIDE_ALLOWLIST' }); return; }
    }
    const count = spec.source.columns.length;
    const parts: unknown[] = Array.isArray(spec.normalization) ? spec.normalization : [];
    if (spec.target.columns.length !== count || parts.length !== count || parts.some(mode => ![...modes, 'literal'].includes(mode as string) || (count === 1 && mode === 'literal'))) issues.push({ path: here, code: 'INVALID_JOIN_NORMALIZATION' });
  });
  return issues;
}
