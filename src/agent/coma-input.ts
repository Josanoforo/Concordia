import { createHash } from 'node:crypto';
import { produceCandidates, type CandidateProductionEnvelope } from '../discovery/candidates.ts';
import { createComaProvider, type ComaBridge, type ComaSchemaInput } from '../discovery/coma-provider.ts';
import { SafeError, trace } from '../runtime.ts';
import { FORBIDDEN_COLUMN, type ExplorationCatalog } from './catalog.ts';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Column = { name: string; type: string };

/** The single place that turns column metadata into COMA's schema-only table input. */
export function comaTables(columnsByTable: Record<string, readonly Column[]>): ComaSchemaInput['tables'] {
  return Object.fromEntries(Object.entries(columnsByTable).map(([name, columns]) => [name, {
    columns: columns.map(column => column.name), types: Object.fromEntries(columns.map(column => [column.name, column.type]))
  }]));
}

/** Allowlisted, non-sensitive columns of each discovered table (config allowlist + catalog safe optionals). */
export function allowlistedColumns(cfg: any, catalog: ExplorationCatalog | undefined, discovery: any, sourceColumns: Record<string, Column[]>): Record<string, Column[]> {
  const out: Record<string, Column[]> = {};
  for (const name of Object.keys(discovery.tables)) {
    const spec = cfg.tables[name];
    if (!spec) continue;
    const allowed = new Set<string>([...spec.columns.map((column: any) => column.name), ...(catalog?.safeOptionalColumns?.[name] ?? [])]);
    const schema = (sourceColumns[name] ?? []).filter(column => allowed.has(column.name) && !FORBIDDEN_COLUMN.test(column.name));
    if (spec.baseSql) for (const column of spec.columns) if (!schema.some(item => item.name === column.name)) schema.push(column);
    out[name] = schema;
  }
  return out;
}

/** COMA scope = the universe's configured relations whose endpoint tables were discovered. */
export function comaInputFromRelations(cfg: any, relations: readonly any[], tables: ComaSchemaInput['tables']): ComaSchemaInput {
  const tableDatabases = Object.fromEntries(Object.keys(tables).map(name => [name, cfg.tables[name].db]));
  return { tableDatabases, normalizationMode: 'text', tables,
    pairs: relations.map(relation => ({ source: relation.from.table, target: relation.to.table, sourceDb: relation.from.db, targetDb: relation.to.db,
      normalizationMode: relation.normalization, allowed: [{ sourceColumn: relation.from.column, targetColumn: relation.to.column, caseIds: [relation.id] }] })) };
}

export interface ComaPhaseResult { status: 'NOT_CONFIGURED' | 'RAN'; inputHash?: string; input?: ComaSchemaInput; production?: CandidateProductionEnvelope }

/** Runs COMA as a normal candidate provider for any universe. No bridge means the phase is recorded as not configured. */
export async function runComaPhase(o: { universeId: string; cfg: any; catalog?: ExplorationCatalog; discovery: any; sourceColumns: Record<string, Column[]>;
  relations: readonly any[]; bridge?: ComaBridge; expectedInputHash?: string; executionMode: 'LIVE' | 'REPLAY' | 'LOCAL'; dataOrigin: 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN' }): Promise<ComaPhaseResult> {
  if (!o.bridge) return { status: 'NOT_CONFIGURED' };
  const tables = comaTables(allowlistedColumns(o.cfg, o.catalog, o.discovery, o.sourceColumns));
  const input = comaInputFromRelations(o.cfg, o.relations, tables);
  if (!input.pairs.length) return { status: 'NOT_CONFIGURED' };
  const inputHash = sha({ tables, tableDatabases: input.tableDatabases, pairs: input.pairs });
  if (o.expectedInputHash && inputHash !== o.expectedInputHash) throw new SafeError('U2_COMA_RECOVERY_INPUT_HASH_MISMATCH');
  const provider = createComaProvider({ input, bridge: o.bridge });
  const databases = [...new Set(Object.values(input.tableDatabases ?? {}))];
  const production = await produceCandidates({ universeId: o.universeId, sourceId: `zetaris:${databases.join('+')}`, sourceVersion: { state: 'UNKNOWN' },
    configFingerprint: sha(o.cfg), inputHash, scope: { tables: Object.keys(tables), columns: [...new Set(Object.values(tables).flatMap(table => table.columns))] },
    executionMode: o.executionMode, dataOrigin: o.dataOrigin,
    tableMetadata: Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, { columns: table.columns.map(column => ({ name: column, type: table.types[column] ?? 'unknown' })),
      keyColumns: o.cfg.tables[name].keyColumns ?? [], role: o.cfg.tables[name].role ?? 'dimension' }])),
    evidenceRefs: Object.values<any>(o.discovery.tables).flatMap((table: any) => [table.sourceMetadata?.requestId, table.sample?.requestId].filter(Boolean)),
    metadata: { databases, scope: `${o.universeId} configured relations`, schemaOnly: true } }, [provider]);
  trace({ kind: 'agent-coma', universeId: o.universeId, providerState: production.providerStates, candidates: production.candidates.length, inputHash });
  return { status: 'RAN', inputHash, input, production };
}
