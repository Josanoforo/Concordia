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

/**
 * COMA input versions are forward-only. v1 is the implicit legacy input: an entry without a version is read as v1 and its serialization and hash stay
 * byte-identical (the frozen U2 recovery hash depends on it). Newer entries carry an explicit comaInputVersion that is part of their hash.
 */
export type ComaInputVersion = 1 | 2;
export const COMA_INPUT_VERSIONS: readonly ComaInputVersion[] = [1, 2];
export const normalizeComaInputVersion = (version?: number): ComaInputVersion => {
  if (version === undefined) return 1;
  if (!COMA_INPUT_VERSIONS.includes(version as ComaInputVersion)) throw new SafeError('COMA_INPUT_VERSION_UNSUPPORTED');
  return version as ComaInputVersion;
};

/** v1 hashes exactly the legacy payload; v2+ adds the explicit version so versions never collide. */
export function comaInputHash(input: Pick<ComaSchemaInput, 'tableDatabases' | 'pairs'> & { tables: ComaSchemaInput['tables'] }, version?: number): string {
  const v = normalizeComaInputVersion(version);
  const legacy = { tables: input.tables, tableDatabases: input.tableDatabases, pairs: input.pairs };
  return sha(v === 1 ? legacy : { comaInputVersion: v, ...legacy });
}

/** What the blind input covered: recorded so a capped candidate search is never mistaken for an exhaustive one. */
export interface BlindComaCoverage { tablePairs: number; pairs: number; cap: number; capped: boolean; order: 'source<target lexicographic' }
/** Upper bound of table pairs sent to COMA in blind discovery (the bridge itself accepts 1000). 24 tables make 276 pairs, inside it. */
export const BLIND_COMA_MAX_PAIRS = 300;

/**
 * Blind discovery (catalog.postComa.blind with no configured relations): COMA is asked about every pair of discovered tables with NOTHING in scope
 * (allowed: []), so every column match it returns is an out-of-scope proposal, never a contribution. Pairs are ordered source<target lexicographically
 * and cut deterministically at `cap`; the cut is reported in BlindComaCoverage. Relation-configured universes never take this path.
 */
export function comaInputBlind(cfg: any, tables: ComaSchemaInput['tables'], cap = BLIND_COMA_MAX_PAIRS): { input: ComaSchemaInput; coverage: BlindComaCoverage } {
  const names = Object.keys(tables).sort((x, y) => x.localeCompare(y, 'en')), all: [string, string][] = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) all.push([names[i], names[j]]);
  const chosen = all.slice(0, cap), mode = cfg.normalizationContract?.defaultMode ?? 'text';
  const tableDatabases = Object.fromEntries(Object.keys(tables).map(name => [name, cfg.tables[name].db]));
  const input: ComaSchemaInput = { tableDatabases, normalizationMode: 'text', tables,
    pairs: chosen.map(([source, target]) => ({ source, target, sourceDb: cfg.tables[source].db, targetDb: cfg.tables[target].db, normalizationMode: mode, allowed: [] })) };
  return { input, coverage: { tablePairs: all.length, pairs: chosen.length, cap, capped: chosen.length < all.length, order: 'source<target lexicographic' } };
}

export interface ComaPhaseResult { status: 'NOT_CONFIGURED' | 'RAN'; comaInputVersion?: ComaInputVersion; inputHash?: string; input?: ComaSchemaInput; production?: CandidateProductionEnvelope; blind?: BlindComaCoverage }

/** Runs COMA as a normal candidate provider for any universe. No bridge means the phase is recorded as not configured. */
export async function runComaPhase(o: { universeId: string; cfg: any; catalog?: ExplorationCatalog; discovery: any; sourceColumns: Record<string, Column[]>;
  relations: readonly any[]; bridge?: ComaBridge; expectedInputHash?: string; comaInputVersion?: number; executionMode: 'LIVE' | 'REPLAY' | 'LOCAL'; dataOrigin: 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN' }): Promise<ComaPhaseResult> {
  const blindMode = o.catalog?.postComa?.blind === true && (o.cfg.relations ?? []).length === 0;
  // Blind discovery always uses the explicit v2 input; every other universe keeps the version its caller asked for (v1 is the frozen legacy form).
  const comaInputVersion = blindMode ? 2 as ComaInputVersion : normalizeComaInputVersion(o.comaInputVersion);
  if (!o.bridge) return { status: 'NOT_CONFIGURED' };
  const tables = comaTables(allowlistedColumns(o.cfg, o.catalog, o.discovery, o.sourceColumns));
  const blind = blindMode ? comaInputBlind(o.cfg, tables) : undefined;
  const input = blind ? blind.input : comaInputFromRelations(o.cfg, o.relations, tables);
  if (!input.pairs.length) return { status: 'NOT_CONFIGURED' };
  const inputHash = comaInputHash(input, comaInputVersion);
  if (o.expectedInputHash && inputHash !== o.expectedInputHash) throw new SafeError('U2_COMA_RECOVERY_INPUT_HASH_MISMATCH');
  const provider = createComaProvider({ input, bridge: o.bridge });
  const databases = [...new Set(Object.values(input.tableDatabases ?? {}))];
  const production = await produceCandidates({ universeId: o.universeId, sourceId: `zetaris:${databases.join('+')}`, sourceVersion: { state: 'UNKNOWN' },
    configFingerprint: sha(o.cfg), inputHash, scope: { tables: Object.keys(tables), columns: [...new Set(Object.values(tables).flatMap(table => table.columns))] },
    executionMode: o.executionMode, dataOrigin: o.dataOrigin,
    tableMetadata: Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, { columns: table.columns.map(column => ({ name: column, type: table.types[column] ?? 'unknown' })),
      keyColumns: o.cfg.tables[name].keyColumns ?? [], role: o.cfg.tables[name].role ?? 'dimension' }])),
    evidenceRefs: Object.values<any>(o.discovery.tables).flatMap((table: any) => [table.sourceMetadata?.requestId, table.sample?.requestId].filter(Boolean)),
    metadata: { databases, scope: blind ? `${o.universeId} blind discovery: ${blind.coverage.pairs} of ${blind.coverage.tablePairs} table pairs${blind.coverage.capped ? ' (capped)' : ''}, nothing in scope` : `${o.universeId} configured relations`, schemaOnly: true } }, [provider]);
  trace({ kind: 'agent-coma', universeId: o.universeId, providerState: production.providerStates, candidates: production.candidates.length, inputHash });
  return { status: 'RAN', comaInputVersion, inputHash, input, production, ...(blind ? { blind: blind.coverage } : {}) };
}
