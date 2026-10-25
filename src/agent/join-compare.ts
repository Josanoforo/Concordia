/**
 * Generic bounded join comparison. A universe declares its join alternatives (which columns on which tables, how each is normalized)
 * and this module measures every one over the rows already observed. It never reads anything: callers hand in the bounded rows.
 * U2 declares its alternatives in code and goes through the same path; its historical ficha must stay byte-identical.
 */
import { normalizeKey } from '../universe-pipeline.ts';

export type JoinNormalization = 'text' | 'integer' | 'integer-pad10';
/** 'literal' compares the stored text as is (empty or missing is null); only valid inside a composite alternative. */
export type JoinPartNormalization = JoinNormalization | 'literal';
export interface JoinSideSpec { table: string; columns: string[] }
export interface JoinAlternativeSpec {
  choice: string;
  /** Alternatives of one family are offered to the model together; it picks one option per family or NO_JOIN. */
  family?: string;
  source: JoinSideSpec;
  target: JoinSideSpec;
  /** One entry per column. */
  normalization: JoinPartNormalization[];
  fromLabel?: string;
  toLabel?: string;
  normalizationLabel?: string;
}

export type JoinMatch = { sourceRow: unknown[]; targetRow: unknown[]; sourceEvidence: string; targetEvidence: string };
export type JoinAlternative<C extends string = string> = { choice: C; from: string; to: string; normalization: string; nSource: number; nTarget: number; sourceNulls: number | null; targetNulls: number | null;
  matchedSourceRows: number | null; unmatchedSourceRows: number | null; matchPairs: number | null; ambiguousSourceRows: number | null; duplicateTargetValues: number | null; sampleBounded: true;
  fieldAvailability: 'AVAILABLE' | 'NOT_PROJECTED' | 'NOT_APPLICABLE'; sourceEvidenceRefs: string[]; targetEvidenceRefs: string[]; matches: JoinMatch[] };
export interface TableRowsView { rows: readonly unknown[][]; columns: readonly string[]; evidenceRefs: string[] }

export function compareBoundedRows(input: { choice: string; from: string; to: string; normalization: JoinNormalization;
  sourceRows: readonly unknown[][]; sourceColumns: readonly string[]; targetRows: readonly unknown[][]; targetColumns: readonly string[];
  sourceColumn: string; targetColumn: string; sourceEvidence: string[]; targetEvidence: string[]; cfg: any }): JoinAlternative {
  const sourceIndex = input.sourceColumns.indexOf(input.sourceColumn), targetIndex = input.targetColumns.indexOf(input.targetColumn);
  if (sourceIndex < 0 || targetIndex < 0) return { choice: input.choice, from: input.from, to: input.to, normalization: input.normalization,
    nSource: input.sourceRows.length, nTarget: input.targetRows.length, sourceNulls: null, targetNulls: null, matchedSourceRows: null, unmatchedSourceRows: null, matchPairs: null, ambiguousSourceRows: null,
    duplicateTargetValues: 0, sampleBounded: true, fieldAvailability: 'NOT_PROJECTED', sourceEvidenceRefs: input.sourceEvidence, targetEvidenceRefs: input.targetEvidence, matches: [] };
  const normalize = (value: unknown) => normalizeKey(value, input.normalization, input.cfg.normalizationContract);
  const targetKeyCounts = new Map<string, number>();
  for (const row of input.targetRows) { const key = normalize(row[targetIndex]); if (key !== null) targetKeyCounts.set(key, (targetKeyCounts.get(key) ?? 0) + 1); }
  const matches: JoinMatch[] = []; let matchedSourceRows = 0, ambiguousSourceRows = 0;
  for (const sourceRow of input.sourceRows) {
    const sourceKey = normalize(sourceRow[sourceIndex]); if (sourceKey === null) continue;
    const hits = input.targetRows.filter(targetRow => normalize(targetRow[targetIndex]) === sourceKey);
    if (hits.length) matchedSourceRows++;
    if (hits.length > 1) ambiguousSourceRows++;
    for (const targetRow of hits) matches.push({ sourceRow: [...sourceRow], targetRow: [...targetRow], sourceEvidence: input.sourceEvidence[0] ?? 'unknown', targetEvidence: input.targetEvidence[0] ?? 'unknown' });
  }
  return { choice: input.choice, from: input.from, to: input.to, normalization: input.normalization, nSource: input.sourceRows.length, nTarget: input.targetRows.length,
    sourceNulls: input.sourceRows.filter(row => normalize(row[sourceIndex]) === null).length, targetNulls: input.targetRows.filter(row => normalize(row[targetIndex]) === null).length,
    matchedSourceRows, unmatchedSourceRows: input.sourceRows.length - matchedSourceRows, matchPairs: matches.length, ambiguousSourceRows,
    duplicateTargetValues: [...targetKeyCounts.values()].filter(count => count > 1).length, sampleBounded: true, fieldAvailability: 'AVAILABLE',
    sourceEvidenceRefs: input.sourceEvidence, targetEvidenceRefs: input.targetEvidence, matches };
}

/** Two or more columns compared together: the key is the list of normalized parts, null when any part is null. */
export function compareCompositeRows(input: { choice: string; from: string; to: string; normalization: string; modes: readonly JoinPartNormalization[]; cfg: any;
  sourceRows: readonly unknown[][]; sourceColumns: readonly string[]; targetRows: readonly unknown[][]; targetColumns: readonly string[];
  sourceColumnNames: readonly string[]; targetColumnNames: readonly string[]; sourceEvidence: string[]; targetEvidence: string[] }): JoinAlternative {
  const si = input.sourceColumnNames.map(name => input.sourceColumns.indexOf(name)), ti = input.targetColumnNames.map(name => input.targetColumns.indexOf(name));
  const base = { choice: input.choice, from: input.from, to: input.to, normalization: input.normalization, sampleBounded: true as const,
    sourceEvidenceRefs: input.sourceEvidence, targetEvidenceRefs: input.targetEvidence };
  if ([...si, ...ti].some(index => index < 0)) return { ...base, nSource: input.sourceRows.length, nTarget: input.targetRows.length, sourceNulls: null, targetNulls: null, matchedSourceRows: null,
    unmatchedSourceRows: null, matchPairs: null, ambiguousSourceRows: null, duplicateTargetValues: null, fieldAvailability: 'NOT_PROJECTED', matches: [] };
  const part = (value: unknown, mode: JoinPartNormalization) => mode === 'literal'
    ? (value === null || value === undefined || String(value) === '' ? null : String(value))
    : normalizeKey(value, mode, input.cfg.normalizationContract);
  const composite = (row: readonly unknown[], indexes: readonly number[]) => {
    const parts = indexes.map((index, position) => part(row[index], input.modes[position]!));
    return parts.some(value => value === null) ? null : JSON.stringify(parts);
  };
  const targetCounts = new Map<string, number>();
  for (const row of input.targetRows) { const key = composite(row, ti); if (key !== null) targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1); }
  const matches: JoinMatch[] = []; let matchedSourceRows = 0, ambiguousSourceRows = 0;
  for (const sourceRow of input.sourceRows) {
    const key = composite(sourceRow, si); if (key === null) continue;
    const hits = input.targetRows.filter(targetRow => composite(targetRow, ti) === key);
    if (hits.length) matchedSourceRows++;
    if (hits.length > 1) ambiguousSourceRows++;
    for (const targetRow of hits) matches.push({ sourceRow: [...sourceRow], targetRow: [...targetRow], sourceEvidence: input.sourceEvidence[0] ?? 'unknown', targetEvidence: input.targetEvidence[0] ?? 'unknown' });
  }
  return { ...base, nSource: input.sourceRows.length, nTarget: input.targetRows.length,
    sourceNulls: input.sourceRows.filter(row => composite(row, si) === null).length,
    targetNulls: input.targetRows.filter(row => composite(row, ti) === null).length, matchedSourceRows,
    unmatchedSourceRows: input.sourceRows.length - matchedSourceRows, matchPairs: matches.length, ambiguousSourceRows,
    duplicateTargetValues: [...targetCounts.values()].filter(count => count > 1).length, fieldAvailability: 'AVAILABLE', matches };
}

const sideLabel = (side: JoinSideSpec) => side.columns.length === 1 ? `${side.table}.${side.columns[0]}` : `${side.table}.(${side.columns.join(',')})`;

/**
 * Measures every declared alternative over the rows `view` returns for each table, then appends NO_JOIN
 * (sized by the first alternative's source table and the last alternative's target table).
 */
export function compareDeclaredAlternatives(cfg: any, specs: readonly JoinAlternativeSpec[], view: (table: string) => TableRowsView): JoinAlternative[] {
  if (!specs.length) return [];
  const measured = specs.map((spec): JoinAlternative => {
    const source = view(spec.source.table), target = view(spec.target.table);
    const labels = { from: spec.fromLabel ?? sideLabel(spec.source), to: spec.toLabel ?? sideLabel(spec.target) };
    const common = { choice: spec.choice, ...labels, cfg, sourceRows: source.rows, sourceColumns: source.columns, targetRows: target.rows, targetColumns: target.columns,
      sourceEvidence: source.evidenceRefs, targetEvidence: target.evidenceRefs };
    if (spec.source.columns.length === 1) return compareBoundedRows({ ...common, normalization: spec.normalization[0] as JoinNormalization,
      sourceColumn: spec.source.columns[0]!, targetColumn: spec.target.columns[0]! });
    return compareCompositeRows({ ...common, modes: spec.normalization, normalization: spec.normalizationLabel ?? spec.normalization.join('+'),
      sourceColumnNames: spec.source.columns, targetColumnNames: spec.target.columns });
  });
  const first = view(specs[0]!.source.table), last = view(specs[specs.length - 1]!.target.table);
  return [...measured, { choice: 'NO_JOIN', from: 'none', to: 'none', normalization: 'none', nSource: first.rows.length, nTarget: last.rows.length, sourceNulls: null, targetNulls: null,
    matchedSourceRows: null, unmatchedSourceRows: null, matchPairs: null, ambiguousSourceRows: null, duplicateTargetValues: null, sampleBounded: true, fieldAvailability: 'NOT_APPLICABLE',
    sourceEvidenceRefs: first.evidenceRefs, targetEvidenceRefs: last.evidenceRefs, matches: [] }];
}
