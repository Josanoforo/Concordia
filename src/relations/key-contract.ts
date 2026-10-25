/**
 * Declarative uniqueness / null contract for one key column, e.g. `tables.zones.keyContract.LocationID = { unique: true, nullable: false }`.
 * The declaration states what the owner says the column is; the check compares it with a bounded observation. A bounded
 * sample can contradict a declaration (VIOLATED) but never prove it (SATISFIED_IN_SAMPLE). Evidence only: no verdict reads it.
 */
export interface KeyColumnContract { unique?: boolean; nullable?: boolean; maxNullRate?: number }
export type KeyRuleName = 'unique' | 'nullable' | 'maxNullRate';
export type KeyCheckStatus = 'SATISFIED_IN_SAMPLE' | 'VIOLATED' | 'UNKNOWN';
export interface KeyContractCheck { rule: KeyRuleName; declared: boolean | number; status: KeyCheckStatus; observed: number | null }
export interface KeyContractResult { column: string; status: 'NO_CONTRACT' | KeyCheckStatus; checks: KeyContractCheck[]; scope: 'bounded observed response only; a sample cannot prove uniqueness or absence of nulls' }
export interface KeyObservation { rows: number; nullRows: number; emptyRows: number; duplicateKeys: readonly unknown[] }

export function validateKeyContractDeclaration(value: unknown, path = 'keyContract'): { path: string; code: string }[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ path, code: 'EXPECTED_KEY_CONTRACT_OBJECT' }];
  const issues: { path: string; code: string }[] = [];
  for (const [column, declaration] of Object.entries<any>(value)) {
    const at = `${path}.${column}`;
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) { issues.push({ path: at, code: 'EXPECTED_KEY_COLUMN_CONTRACT' }); continue; }
    for (const key of Object.keys(declaration)) if (!['unique', 'nullable', 'maxNullRate'].includes(key)) issues.push({ path: `${at}.${key}`, code: 'UNKNOWN_KEY_CONTRACT_FIELD' });
    if (declaration.unique !== undefined && typeof declaration.unique !== 'boolean') issues.push({ path: `${at}.unique`, code: 'KEY_CONTRACT_UNIQUE_NOT_BOOLEAN' });
    if (declaration.nullable !== undefined && typeof declaration.nullable !== 'boolean') issues.push({ path: `${at}.nullable`, code: 'KEY_CONTRACT_NULLABLE_NOT_BOOLEAN' });
    if (declaration.maxNullRate !== undefined && (typeof declaration.maxNullRate !== 'number' || !Number.isFinite(declaration.maxNullRate) || declaration.maxNullRate < 0 || declaration.maxNullRate > 1)) issues.push({ path: `${at}.maxNullRate`, code: 'KEY_CONTRACT_MAX_NULL_RATE_OUT_OF_RANGE' });
    if (declaration.nullable === false && typeof declaration.maxNullRate === 'number' && declaration.maxNullRate > 0) issues.push({ path: at, code: 'KEY_CONTRACT_NULLABLE_CONTRADICTS_MAX_NULL_RATE' });
  }
  return issues;
}

export function checkKeyContract(column: string, declaration: KeyColumnContract | undefined, observed: KeyObservation): KeyContractResult {
  const scope = 'bounded observed response only; a sample cannot prove uniqueness or absence of nulls' as const;
  if (!declaration) return { column, status: 'NO_CONTRACT', checks: [], scope };
  const checks: KeyContractCheck[] = [];
  const nulls = observed.nullRows + observed.emptyRows, nullRate = observed.rows ? nulls / observed.rows : null;
  const verdict = (violated: boolean, known: boolean): KeyCheckStatus => !known ? 'UNKNOWN' : violated ? 'VIOLATED' : 'SATISFIED_IN_SAMPLE';
  if (declaration.unique !== undefined) checks.push({ rule: 'unique', declared: declaration.unique, observed: observed.duplicateKeys.length, status: declaration.unique ? verdict(observed.duplicateKeys.length > 0, observed.rows > 0) : 'UNKNOWN' });
  if (declaration.nullable !== undefined) checks.push({ rule: 'nullable', declared: declaration.nullable, observed: nulls, status: declaration.nullable ? 'UNKNOWN' : verdict(nulls > 0, observed.rows > 0) });
  if (declaration.maxNullRate !== undefined) checks.push({ rule: 'maxNullRate', declared: declaration.maxNullRate, observed: nullRate, status: verdict(nullRate !== null && nullRate > declaration.maxNullRate, nullRate !== null) });
  const status: KeyContractResult['status'] = !checks.length ? 'NO_CONTRACT' : checks.some(check => check.status === 'VIOLATED') ? 'VIOLATED' : checks.some(check => check.status === 'UNKNOWN') ? 'UNKNOWN' : 'SATISFIED_IN_SAMPLE';
  return { column, status, checks, scope };
}
