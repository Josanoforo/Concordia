import { Zetaris, type SqlResult } from '../clients/zetaris.ts';
import { failure, writeJson, SafeError } from '../runtime.ts';
import { normalizeKey, keyFamily, projection, universe, type Column, type NormalizationMode } from '../universe.ts';
import { legacyRelationContract } from '../relations/legacy.ts';
import type { Candidate as SharedCandidate, Unknown } from '../contracts/types.ts';
import { createComaDiscoveryProvider } from './coma-discovery-provider.ts';
import type { ComaBridge } from './coma-provider.ts';
import { fingerprint, produceCandidates, withUniverseContext, type CandidateProvider, type CandidateProviderContext, type CandidateProductionEnvelope, type LegacyCandidateContribution } from './candidates.ts';
export type Endpoint = { db: string; table: string; column: string };
export type Candidate = LegacyCandidateContribution;
export type LiveTable = { schema: Column[]; columns: string[]; sample: SqlResult; labels: string[]; role: string; keyColumns: string[] };
export type Discovery = { utc: string; live: boolean; pending_llm: boolean; llm?: any; tables: Record<string, LiveTable>; candidates: Candidate[]; candidateProduction?: CandidateProductionEnvelope; errors: object[]; discoveryRequests: string[] };
export { candidateIdentity, deduplicateContributions, fingerprint, produceCandidates, withUniverseContext } from './candidates.ts';
export type { CandidateContribution, CandidateProvider, CandidateProviderContext, CandidateProviderDescriptor, CandidateProductionEnvelope } from './candidates.ts';
export function candidateId(from: Endpoint, to: Endpoint) { return `${from.table}.${from.column}__${to.table}.${to.column}`; }
type GeneratedCandidate = Candidate & { methodId: string };
function generateCandidatesWithConfiguration(tables: Record<string, LiveTable>, db: string, normalizationContract: NonNullable<ReturnType<typeof universe>['normalizationContract']>): GeneratedCandidate[] {
  const candidates: GeneratedCandidate[] = [];
  const normalization = normalizationContract?.defaultMode;
  if (!normalization || !normalizationContract) throw new SafeError('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
  if (!normalizationContract.modes[normalization]) throw new SafeError('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
  const dimensions = Object.entries(tables).filter(([, t]) => t.role === 'dimension');
  function add(from: Endpoint, to: Endpoint, methodId: string, reason: string[]) {
    const a = tables[from.table], b = tables[to.table];
    const keys = (t: LiveTable, c: string) => new Set(t.sample.rows.map(r => normalizeKey(r[t.columns.indexOf(c)], normalization as NormalizationMode)).filter(k => k !== null));
    const ak = keys(a, from.column), bk = keys(b, to.column);
    const matched = [...ak].filter(k => bk.has(k)).length;
    const typeA = a.schema.find(c => c.name === from.column)?.type, typeB = b.schema.find(c => c.name === to.column)?.type;
    candidates.push({ id: candidateId(from, to), from, to, reason: [...reason, `declared types ${typeA}/${typeB}`, `discovery sample overlap ${matched}/${ak.size}; not a coverage estimate`], proposedBy: 'heuristic', confidence: matched > 0 ? 0.7 : 0.5, methodId });
  }
  for (const [table, t] of Object.entries(tables)) {
    if (t.role === 'dimension') continue;
    for (const column of t.keyColumns) for (const [target, d] of dimensions) for (const key of d.keyColumns) {
      if (keyFamily(column) === keyFamily(key)) add({ db, table, column }, { db, table: target, column: key }, 'key-family', ['matching zone/location key family; lookup needed']);
    }
  }
  for (let i = 0; i < dimensions.length; i++) for (let j = i + 1; j < dimensions.length; j++) {
    const [at, a] = dimensions[i], [bt, b] = dimensions[j];
    // Comparable zone catalogs can expose different key names. Labels test identity.
    if (a.labels.length && b.labels.length) add({ db, table: at, column: a.keyColumns[0] }, { db, table: bt, column: b.keyColumns[0] }, 'paired-label-catalog', ['two zone catalogs; labels must establish whether numeric IDs identify the same entity']);
  }
  return candidates;
}
export function generateCandidates(tables: Record<string, LiveTable>, db: string): Candidate[] {
  const config = universe();
  if (!config.normalizationContract) throw new SafeError('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
  return generateCandidatesWithConfiguration(tables, db, config.normalizationContract).map(({ methodId: _methodId, ...candidate }) => candidate);
}

type DiscoveryClient = Pick<Zetaris, 'listDatabases' | 'listTables' | 'describe' | 'runSql'>;
function u1HeuristicProvider(): CandidateProvider {
  return { descriptor: { providerId: 'concordia.u1.deterministic', version: '1.0.0', method: 'key-family+paired-label-catalog', capability: 'SUPPORTED' },
    produce(context: CandidateProviderContext) {
      const tables = context.metadata.liveTables as Record<string, LiveTable>;
      const config = context.metadata.normalizationContract as NonNullable<ReturnType<typeof universe>['normalizationContract']>;
      const db = String(context.metadata.database);
      const output = generateCandidatesWithConfiguration(tables, db, config);
      const configFingerprint = context.descriptor.configFingerprint;
      const contributions = output.map(generated => {
        const { methodId, ...legacyCandidate } = generated;
        const relationDraft = withUniverseContext(legacyRelationContract({ id: legacyCandidate.id, from: legacyCandidate.from, to: legacyCandidate.to,
          kind: 'UNKNOWN', reviewState: 'PENDING' }, context.descriptor.universeId, '1.0', config.defaultMode!, 1), { id: context.descriptor.universeId, configFingerprint });
        const sourceVersion = context.descriptor.sourceVersion.state === 'KNOWN' ? context.descriptor.sourceVersion.value : 'UNKNOWN';
        relationDraft.from.sourceId = `${context.descriptor.sourceId}:${legacyCandidate.from.table}@${sourceVersion}:from`;
        relationDraft.to.sourceId = `${context.descriptor.sourceId}:${legacyCandidate.to.table}@${sourceVersion}:to`;
        const fromType = tables[legacyCandidate.from.table].schema.find(column => column.name === legacyCandidate.from.column)?.type;
        const toType = tables[legacyCandidate.to.table].schema.find(column => column.name === legacyCandidate.to.column)?.type;
        relationDraft.semanticContext.properties = { fromDeclaredType: fromType ? { state: 'KNOWN', value: fromType } : { state: 'UNKNOWN' }, toDeclaredType: toType ? { state: 'KNOWN', value: toType } : { state: 'UNKNOWN' } };
        const candidate: SharedCandidate = { schemaVersion: 1, candidateId: legacyCandidate.id, relationDraft, proposedBy: 'candidate-provider', provenance: [], createdAt: { state: 'UNKNOWN' }, status: 'INCOMPLETE' };
        const evidenceRefs = [tables[legacyCandidate.from.table].sample.requestId, tables[legacyCandidate.to.table].sample.requestId].filter((id): id is string => typeof id === 'string' && id.length > 0);
        return { candidate, methodId, reasons: legacyCandidate.reason, evidenceRefs: evidenceRefs.length ? evidenceRefs : [...context.evidenceRefs], legacyCandidate };
      });
      return { contributions, abstentions: contributions.length ? [] : [{ reason: 'NO_CANDIDATES_FOR_CONFIGURED_SCOPE' }], errors: [], partial: false,
        limitations: ['sample overlap describes only bounded discovery rows and is not a coverage estimate', 'candidate generation does not establish relation semantics or a verdict'] };
    } };
}

/** Exposes the existing deterministic factory for controlled comparisons without running discovery. */
export function createU1HeuristicProvider(): CandidateProvider { return u1HeuristicProvider(); }

export async function discover(options?: { excludedTables?: string[]; cached?: Discovery; client?: DiscoveryClient; provider?: CandidateProvider; providers?: CandidateProvider[]; coma?: ComaBridge; persist?: boolean; executionMode?: 'LIVE' | 'REPLAY' | 'LOCAL'; dataOrigin?: 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN' }) {
  const u = universe(), z = options?.client ?? new Zetaris();
  const executionMode = options?.executionMode ?? 'LIVE', dataOrigin = options?.dataOrigin ?? 'UNKNOWN';
  const result: Discovery = { utc: new Date().toISOString(), live: executionMode === 'LIVE', pending_llm: true, tables: {}, candidates: [], errors: [], discoveryRequests: [] };
  try {
    const dbs = await z.listDatabases(), listed = await z.listTables(u.database);
    result.discoveryRequests.push(dbs.requestId, listed.requestId);
    if (!dbs.rows.some(r => r[0] === u.database)) throw new SafeError('U1_DATABASE_NOT_FOUND');
    const names = new Set(listed.rows.flat().map(String));
    for (const [table, spec] of Object.entries(u.tables)) {
      if (options?.excludedTables?.includes(table)) {
        const saved=options.cached?.tables[table];
        if(saved) result.tables[table]={...saved,cached:true,cacheLabel:'CACHED '+saved.sample.utc,costExcluded:true} as LiveTable;
        console.log('CACHED',saved?.sample.utc,table,'excluded by authorized cost policy');
        continue;
      }
      try {
        if (!names.has(table)) throw new SafeError('ALLOWLIST_TABLE_NOT_DISCOVERED');
        const described = await z.describe(u.database, table);
        result.discoveryRequests.push(described.requestId);
        const liveSchema = described.rows.map(r => ({ name: String(r[0]), type: String(r[1]).replace(/["']/g, '') }));
        const columns = spec.columns.map(c => c.name);
        if (columns.some(c => !liveSchema.some(s => s.name === c))) throw new SafeError('ALLOWLIST_COLUMN_MISSING_LIVE');
        const sample = await z.runSql(`SELECT ${projection(table, columns)} FROM ${u.database}.${table} LIMIT ${u.sampleLimit}`, u.sampleLimit);
        result.tables[table] = { schema: liveSchema.filter(c => columns.includes(c.name)), columns, sample, labels: spec.labels, role: spec.role, keyColumns: spec.keyColumns };
        console.log('PASS discover', table, sample.rows.length, 'rows');
      } catch (error) { result.errors.push({ table, ...failure(error) }); console.log('FAIL discover', table, failure(error).code); }
      if (options?.persist !== false) writeJson('out/U1/discovery.json', result);
    }
    const configFingerprint = fingerprint(u), inputHash = fingerprint({ configFingerprint, tables: Object.fromEntries(Object.entries(result.tables).map(([name, table]) => [name, { schema: table.schema, columns: table.columns, labels: table.labels, role: table.role, keyColumns: table.keyColumns, rows: table.sample.rows }])) });
    const scope = { tables: Object.keys(result.tables).sort(), columns: [...new Set(Object.values(result.tables).flatMap(table => table.columns))].sort() };
    const evidenceRefs = [...new Set(Object.values(result.tables).map(table => table.sample.requestId).filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
    const providers = [options?.provider ?? u1HeuristicProvider(), ...(options?.providers ?? []), ...(options?.coma ? [createComaDiscoveryProvider({ bridge: options.coma })] : [])];
    const production = await produceCandidates({ universeId: u.id, sourceId: `zetaris:${u.database}`, sourceVersion: { state: 'UNKNOWN' } as Unknown<string>, configFingerprint, inputHash, scope,
      executionMode, dataOrigin, tableMetadata: Object.fromEntries(Object.entries(result.tables).map(([name, table]) => [name, { columns: table.schema, keyColumns: table.keyColumns, role: table.role }])), evidenceRefs,
      metadata: { liveTables: result.tables, normalizationContract: u.normalizationContract, database: u.database } }, providers);
    if (result.errors.length) {
      production.status = 'PARTIAL';
      production.errors.push(...result.errors.map((error: any) => ({ providerId: 'zetaris-discovery', code: String(error.code ?? error.message ?? 'DISCOVERY_READ_ERROR'), partial: true })));
      production.providerStates.push({ providerId: 'zetaris-discovery', status: 'PARTIAL' });
    }
    result.candidateProduction = production;
    result.candidates = production.legacyCandidates as Candidate[];
  } catch (error) { result.errors.push(failure(error)); }
  if (options?.persist !== false) writeJson('out/U1/discovery.json', result);
  console.log('Discovery:', Object.keys(result.tables).length, 'tables;', result.candidates.length, 'candidates;', result.errors.length, 'errors; pending_llm');
  if (result.errors.length) process.exitCode = 1;
  return result;
}
