import { comaTables } from '../agent/coma-input.ts';
import { keyFamily } from '../universe.ts';
import { createComaProvider, createInstalledComaBridge, type ComaBridge, type ComaPair, type ComaSchemaInput } from './coma-provider.ts';
import type { CandidateProvider, CandidateProviderContext } from './candidates.ts';

type TableMeta = CandidateProviderContext['tableMetadata'][string];

/**
 * Derives COMA's configured scope from the same table roles and key families the deterministic provider uses,
 * so COMA is one more provider in normal discovery. Only schema names and types leave this function.
 * Proposals beyond the declared key mappings are retained by the COMA provider as out-of-scope diagnostics.
 */
export function buildComaDiscoveryInput(tableMetadata: Readonly<Record<string, TableMeta>>, database: string, normalizationMode: string): ComaSchemaInput {
  const tables = comaTables(Object.fromEntries(Object.entries(tableMetadata).map(([name, meta]) => [name, meta.columns])));
  const pairs = new Map<string, ComaPair>();
  const allow = (source: string, sourceColumn: string, target: string, targetColumn: string) => {
    const key = `${source}\0${target}`;
    let pair = pairs.get(key);
    if (!pair) { pair = { source, target, allowed: [] }; pairs.set(key, pair); }
    (pair.allowed as { sourceColumn: string; targetColumn: string; caseIds: string[] }[]).push({ sourceColumn, targetColumn, caseIds: [] });
  };
  const dimensions = Object.entries(tableMetadata).filter(([, meta]) => meta.role === 'dimension');
  for (const [table, meta] of Object.entries(tableMetadata)) {
    if (meta.role === 'dimension') continue;
    for (const column of meta.keyColumns) for (const [target, dim] of dimensions) for (const key of dim.keyColumns) {
      if (keyFamily(column) === keyFamily(key)) allow(table, column, target, key);
    }
  }
  for (let i = 0; i < dimensions.length; i++) for (let j = i + 1; j < dimensions.length; j++) {
    const [at, a] = dimensions[i], [bt, b] = dimensions[j];
    if (a.keyColumns.length && b.keyColumns.length) allow(at, a.keyColumns[0], bt, b.keyColumns[0]);
  }
  return { database, normalizationMode, tables, pairs: [...pairs.values()] };
}

/** COMA as a normal discovery candidate provider; the bridge is injected so tests and replays never need Python. */
export function createComaDiscoveryProvider(options: { bridge: ComaBridge }): CandidateProvider {
  const base = createComaProvider({ input: { normalizationMode: 'text', tables: {}, pairs: [] }, bridge: options.bridge });
  return { descriptor: base.descriptor, produce(context) {
    const normalization = context.metadata.normalizationContract as { defaultMode?: string } | undefined;
    const input = buildComaDiscoveryInput(context.tableMetadata, String(context.metadata.database), normalization?.defaultMode ?? '');
    if (!input.pairs.length) return { contributions: [], abstentions: [{ reason: 'COMA_CONFIGURED_PAIR_SCOPE_EMPTY' }], errors: [], partial: false, limitations: ['COMA had no configured table pairs in this scope'] };
    return createComaProvider({ input, bridge: options.bridge }).produce(context);
  } };
}

export { createInstalledComaBridge };
