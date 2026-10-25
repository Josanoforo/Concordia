import { normalizeKey, type NormalizationMode } from '../universe.ts';

export type InclusionStatus = 'NO_VIOLATION_IN_SAMPLE' | 'VIOLATED_IN_SAMPLE' | 'UNKNOWN';
export type UniquenessStatus = 'NO_DUPLICATES_IN_SAMPLE' | 'DUPLICATES_OBSERVED' | 'UNKNOWN';
/**
 * Two independent rules over the same bounded responses. Inclusion asks whether every sampled source key appears in the
 * target; target uniqueness asks whether any target key appears in more than one row. Neither implies the other, and
 * neither is a global claim. They are evidence for review; the decision policy keeps its own reading of the same signals.
 */
export interface KeyRules {
  inclusion: { status: InclusionStatus; checkedKeys: number; missingCount: number; missingKeys: string[]; reason?: 'NO_SOURCE_KEYS' | 'TARGET_TRUNCATED_ABSENCE_NOT_RELIABLE' };
  targetUniqueness: { status: UniquenessStatus; rows: number; distinctKeys: number; duplicateKeyCount: number; maxRowsPerKey: number; reason?: 'NO_TARGET_KEYS' };
  independent: true;
  scope: 'bounded observed responses only; no global inclusion or uniqueness claim';
}

const MISSING_KEYS_SHOWN = 20;

export function evaluateKeyRules(fromRows: readonly (readonly unknown[])[], toRows: readonly (readonly unknown[])[], mode: NormalizationMode, options: { targetBounded: boolean }): KeyRules {
  const sourceKeys = new Set<string>();
  for (const row of fromRows) { const key = normalizeKey(row[0], mode); if (key !== null) sourceKeys.add(key); }
  const targetCounts = new Map<string, number>(); let targetRows = 0;
  for (const row of toRows) { const key = normalizeKey(row[0], mode); if (key === null) continue; targetRows++; targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1); }
  const missing = [...sourceKeys].filter(key => !targetCounts.has(key)).sort((a, b) => a.localeCompare(b, 'en'));
  const duplicateKeyCount = [...targetCounts.values()].filter(count => count > 1).length;
  const inclusion: KeyRules['inclusion'] = !sourceKeys.size
    ? { status: 'UNKNOWN', checkedKeys: 0, missingCount: 0, missingKeys: [], reason: 'NO_SOURCE_KEYS' }
    : missing.length && options.targetBounded
      ? { status: 'UNKNOWN', checkedKeys: sourceKeys.size, missingCount: missing.length, missingKeys: missing.slice(0, MISSING_KEYS_SHOWN), reason: 'TARGET_TRUNCATED_ABSENCE_NOT_RELIABLE' }
      : { status: missing.length ? 'VIOLATED_IN_SAMPLE' : 'NO_VIOLATION_IN_SAMPLE', checkedKeys: sourceKeys.size, missingCount: missing.length, missingKeys: missing.slice(0, MISSING_KEYS_SHOWN) };
  const targetUniqueness: KeyRules['targetUniqueness'] = !targetCounts.size
    ? { status: 'UNKNOWN', rows: 0, distinctKeys: 0, duplicateKeyCount: 0, maxRowsPerKey: 0, reason: 'NO_TARGET_KEYS' }
    : { status: duplicateKeyCount ? 'DUPLICATES_OBSERVED' : 'NO_DUPLICATES_IN_SAMPLE', rows: targetRows, distinctKeys: targetCounts.size, duplicateKeyCount, maxRowsPerKey: Math.max(...targetCounts.values()) };
  return { inclusion, targetUniqueness, independent: true, scope: 'bounded observed responses only; no global inclusion or uniqueness claim' };
}
