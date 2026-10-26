import fs from 'node:fs';
import path from 'node:path';
import type { Zetaris } from '../clients/zetaris.ts';
import { ROOT, SafeError } from '../runtime.ts';
import { ZetarisJson2ProbeAdapter, type Json2LiveBindingDocument, type Json2LiveTableBinding } from '../relations/adapters/zetaris-json2.ts';

type Client = Pick<Zetaris, 'describe' | 'runSql'>;
const BINDING_PATH = /^universes\/[A-Za-z0-9_-]+\.json$/;
const SQL_WORDS = new Set(['select', 'from', 'where', 'in', 'not', 'and', 'limit', 'as', 'or', 'is', 'null', 'concordia_source']);

/**
 * Client guard for universes whose tables are a root-reviewed JSON2 live binding. The generic agent loop does not go through
 * ZetarisJson2ProbeAdapter, so this restores the binding rules: a fresh schema + typed multiset check of every bound table
 * before the first read (anything but COMPLETE refuses all reads), then only bound tables and columns, LIMIT <= readLimit,
 * and no more than maxRowsPerTable rows in any response. It is read-only by construction (a single bounded SELECT shape).
 */
export function guardJson2Client(cfg: any, inner: Client, bindingOverride?: Json2LiveBindingDocument) {
  const bindingPath = cfg?.liveBinding;
  if (!bindingOverride && (typeof bindingPath !== 'string' || !BINDING_PATH.test(bindingPath))) throw new SafeError('JSON2_GUARD_BINDING_PATH_INVALID');
  const full: Json2LiveBindingDocument = bindingOverride ?? JSON.parse(fs.readFileSync(path.join(ROOT, bindingPath), 'utf8'));
  const wanted = new Set(Object.values<any>(cfg.tables).map(spec => `${spec.db ?? cfg.database}.${spec.physicalTable}`));
  const tables: Json2LiveTableBinding[] = full.tables.filter(table => wanted.has(`${table.physicalDatabase}.${table.physicalTable}`));
  if (!tables.length || tables.length !== wanted.size) throw new SafeError('JSON2_GUARD_TABLE_NOT_IN_BINDING');
  for (const spec of Object.values<any>(cfg.tables)) {
    const bound = tables.find(table => table.physicalTable === spec.physicalTable)!;
    if (spec.columns.some((column: any) => !bound.columns.some(allowed => allowed.name === column.name))) throw new SafeError('JSON2_GUARD_COLUMN_NOT_IN_BINDING');
  }
  const binding: Json2LiveBindingDocument = { ...full, tables };
  const allowedTables = new Set(tables.map(table => `${table.physicalDatabase}.${table.physicalTable}`));
  const allowedWords = new Set<string>([...tables.flatMap(table => [table.physicalDatabase, table.physicalTable, ...table.columns.map(column => column.name)]).map(word => word.toLowerCase())]);
  let preflight: Promise<unknown> | undefined, summary: unknown, preflightQueries = 0;
  // Every statement the preflight sends to the source is counted here so the run budget can show it (it is not gated by the cap).
  const counted: Client = { describe: ((...args: any[]) => { preflightQueries++; return (inner.describe as any)(...args); }) as any, runSql: ((...args: any[]) => { preflightQueries++; return (inner.runSql as any)(...args); }) as any };
  const verify = () => preflight ??= (async () => {
    const adapter = new ZetarisJson2ProbeAdapter(binding, counted);
    await adapter.verifyAllTables();
    summary = adapter.getRunSummary();
    if ((summary as { status: string }).status !== 'COMPLETE') throw new SafeError('JSON2_GUARD_PREFLIGHT_INCOMPLETE', undefined, JSON.stringify({ status: (summary as { status: string }).status }));
  })();
  const checkSql = (sql: string, limit: number | undefined) => {
    if (typeof sql !== 'string' || !/^\s*SELECT\s/i.test(sql) || /;|--|\/\*|\*/.test(sql) || /\b(JOIN|UNION|COUNT|GROUP|ORDER|HAVING|OFFSET)\b/i.test(sql)) throw new SafeError('JSON2_GUARD_SQL_REJECTED');
    const bare = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/`/g, '');
    const refs = [...bare.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)].map(match => `${match[1]}.${match[2]}`);
    if (!refs.length || refs.some(ref => !allowedTables.has(ref))) throw new SafeError('JSON2_GUARD_TABLE_OUTSIDE_BINDING');
    const words = bare.replace(/\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/g, ' ').match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    if (words.some(word => !SQL_WORDS.has(word.toLowerCase()) && !allowedWords.has(word.toLowerCase()))) throw new SafeError('JSON2_GUARD_COLUMN_OUTSIDE_BINDING');
    const limits = [...bare.matchAll(/\bLIMIT\s+(\d+)/gi)].map(match => Number(match[1]));
    if (limits.length !== 1 || limits[0] < 1 || limits[0] > full.readLimit || (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > full.readLimit))) throw new SafeError('JSON2_GUARD_LIMIT_OUTSIDE_BINDING');
  };
  const client: Client & { preflightSummary: () => unknown; preflightQueryCount: () => number } = {
    async describe(db: string, table: string, ...rest: any[]) {
      if (!allowedTables.has(`${db}.${table}`)) throw new SafeError('JSON2_GUARD_TABLE_OUTSIDE_BINDING');
      await verify();
      return (inner.describe as any)(db, table, ...rest);
    },
    async runSql(sql: string, limit?: number, ...rest: any[]) {
      checkSql(sql, limit);
      await verify();
      const result = await (inner.runSql as any)(sql, limit, ...rest);
      if (result.rows.length > full.maxRowsPerTable) throw new SafeError('JSON2_GUARD_ROWS_EXCEED_BINDING');
      return result;
    },
    preflightSummary: () => summary,
    preflightQueryCount: () => preflightQueries
  } as any;
  return client;
}
