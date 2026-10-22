import { Zetaris, type SqlResult } from '../clients/zetaris.ts';
import { failure, writeJson, SafeError } from '../runtime.ts';
import { normalizeKey, keyFamily, projection, universe, type Column, type NormalizationMode } from '../universe.ts';
export type Endpoint = { db: string; table: string; column: string };
export type Candidate = { id: string; from: Endpoint; to: Endpoint; reason: string[]; proposedBy: 'heuristic' | 'llm'; proposedBySources?: string[]; llmReceiptId?: string; confidence: number };
export type LiveTable = { schema: Column[]; columns: string[]; sample: SqlResult; labels: string[]; role: string; keyColumns: string[] };
export type Discovery = { utc: string; live: true; pending_llm: boolean; llm?: any; tables: Record<string, LiveTable>; candidates: Candidate[]; errors: object[]; discoveryRequests: string[] };
export function candidateId(from: Endpoint, to: Endpoint) { return `${from.table}.${from.column}__${to.table}.${to.column}`; }
export function generateCandidates(tables: Record<string, LiveTable>, db: string): Candidate[] {
  const candidates: Candidate[] = [];
  const normalizationContract = universe().normalizationContract;
  const normalization = normalizationContract?.defaultMode;
  if (!normalization || !normalizationContract) throw new SafeError('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
  if (!normalizationContract.modes[normalization]) throw new SafeError('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
  const dimensions = Object.entries(tables).filter(([, t]) => t.role === 'dimension');
  function add(from: Endpoint, to: Endpoint, reason: string[]) {
    const a = tables[from.table], b = tables[to.table];
    const keys = (t: LiveTable, c: string) => new Set(t.sample.rows.map(r => normalizeKey(r[t.columns.indexOf(c)], normalization as NormalizationMode)).filter(k => k !== null));
    const ak = keys(a, from.column), bk = keys(b, to.column);
    const matched = [...ak].filter(k => bk.has(k)).length;
    const typeA = a.schema.find(c => c.name === from.column)?.type, typeB = b.schema.find(c => c.name === to.column)?.type;
    candidates.push({ id: candidateId(from, to), from, to, reason: [...reason, `declared types ${typeA}/${typeB}`, `discovery sample overlap ${matched}/${ak.size}; not a coverage estimate`], proposedBy: 'heuristic', confidence: matched > 0 ? 0.7 : 0.5 });
  }
  for (const [table, t] of Object.entries(tables)) {
    if (t.role === 'dimension') continue;
    for (const column of t.keyColumns) for (const [target, d] of dimensions) for (const key of d.keyColumns) {
      if (keyFamily(column) === keyFamily(key)) add({ db, table, column }, { db, table: target, column: key }, ['matching zone/location key family; lookup needed']);
    }
  }
  for (let i = 0; i < dimensions.length; i++) for (let j = i + 1; j < dimensions.length; j++) {
    const [at, a] = dimensions[i], [bt, b] = dimensions[j];
    // Comparable zone catalogs can expose different key names. Labels test identity.
    if (a.labels.length && b.labels.length) add({ db, table: at, column: a.keyColumns[0] }, { db, table: bt, column: b.keyColumns[0] }, ['two zone catalogs; labels must establish whether numeric IDs identify the same entity']);
  }
  return candidates;
}
export async function discover(options?: { excludedTables: string[]; cached: Discovery }) {
  const u = universe(), z = new Zetaris();
  const result: Discovery = { utc: new Date().toISOString(), live: true, pending_llm: true, tables: {}, candidates: [], errors: [], discoveryRequests: [] };
  try {
    const dbs = await z.listDatabases(), listed = await z.listTables(u.database);
    result.discoveryRequests.push(dbs.requestId, listed.requestId);
    if (!dbs.rows.some(r => r[0] === u.database)) throw new SafeError('U1_DATABASE_NOT_FOUND');
    const names = new Set(listed.rows.flat().map(String));
    for (const [table, spec] of Object.entries(u.tables)) {
      if (options?.excludedTables.includes(table)) {
        const saved=options.cached.tables[table];
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
      writeJson('out/U1/discovery.json', result);
    }
    result.candidates = generateCandidates(result.tables, u.database);
  } catch (error) { result.errors.push(failure(error)); }
  writeJson('out/U1/discovery.json', result);
  console.log('Discovery:', Object.keys(result.tables).length, 'tables;', result.candidates.length, 'candidates;', result.errors.length, 'errors; pending_llm');
  if (result.errors.length) process.exitCode = 1;
  return result;
}
