import { identifier } from './clients/zetaris.ts';
import { readJson, SafeError } from './runtime.ts';
export type Column = { name: string; type: string };
export type TableSpec = { columns: Column[]; keyColumns: string[]; labels: string[]; role: string };
export type Universe = { id: string; database: string; tables: Record<string, TableSpec>; sampleLimit: number; normalizationContract?: { defaultMode?: NormalizationMode; modes: Partial<Record<NormalizationMode, unknown>> } };
export const universe = () => readJson<Universe>('universes/U1_ny_taxi.json');
export function projection(table: string, names: string[]) {
  const spec = universe().tables[table];
  if (!spec || !names.length || names.some(n => !spec.columns.some(c => c.name === n))) throw new SafeError('COLUMN_OUTSIDE_ALLOWLIST');
  return names.map(identifier).join(', ');
}
export function keyFamily(column: string) {
  const c = column.replace(/_/g, '').toLowerCase();
  return c.includes('locationid') ? 'location' : c.includes('zoneid') ? 'zone' : null;
}
export function canonicalKey(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  return /^-?\d+(?:\.0+)?$/.test(text) ? BigInt(text.split('.')[0]).toString() : text;
}
export type NormalizationMode = 'text' | 'integer' | 'integer-pad10';
export function normalizeKey(value: unknown, mode: NormalizationMode): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (mode === 'text') return text.length ? text : null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (mode === 'integer-pad10') {
    if (!/^\d+$/.test(trimmed)) return null;
    return BigInt(trimmed).toString().padStart(10, '0');
  }
  return /^-?\d+(?:\.0+)?$/.test(trimmed) ? BigInt(trimmed.split('.')[0]).toString() : trimmed;
}
export function quotedValues(values: unknown[]) {
  if (!values.length || values.length > 50) throw new SafeError('INVALID_PROBE_KEYS');
  return values.map(value => "'" + String(value).replace(/'/g, "''") + "'").join(', ');
}
