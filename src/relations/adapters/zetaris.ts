import { Zetaris, identifier } from '../../clients/zetaris.ts';
import type { ProbeAdapter, ProbeReadRequest, ProbeReadResult } from '../probes.ts';
import { quotedValues } from '../../universe.ts';
import { SafeError } from '../../runtime.ts';

export interface ZetarisTableSpec {
  db: string;
  physicalTable: string;
  columns: readonly { name: string; type?: string }[];
  baseSql?: string;
}

export function zetarisTableSpecs(config: any): Record<string, ZetarisTableSpec> {
  if (!config || !config.tables || typeof config.tables !== 'object') throw new SafeError('UNIVERSE_TABLE_CONFIG_REQUIRED');
  return Object.fromEntries(Object.entries<any>(config.tables).map(([table, spec]) => [table, {
    db: spec.db ?? config.database,
    physicalTable: spec.physicalTable ?? table,
    columns: spec.columns,
    ...(spec.baseSql ? { baseSql: spec.baseSql } : {})
  }]));
}

export function zetarisSourceQuery(spec: ZetarisTableSpec): string {
  if (spec.baseSql) {
    if (!/^SELECT\s/i.test(spec.baseSql) || /;|\b(?:JOIN|COUNT\s*\(|ORDER\s+BY|GROUP\s+BY)\b/i.test(spec.baseSql) || /SELECT\s+\*/i.test(spec.baseSql)) throw new SafeError('UNSAFE_UNIVERSE_BASE_QUERY');
    return `(${spec.baseSql}) concordia_source`;
  }
  const columns = spec.columns.map(column => identifier(column.name)).join(', ');
  return `(SELECT ${columns} FROM ${identifier(spec.db)}.${identifier(spec.physicalTable)}) concordia_source`;
}

/** Executes only the request's validated projection, key filter, and LIMIT. */
export class ZetarisProbeAdapter implements ProbeAdapter {
  readonly adapterId = 'zetaris';
  constructor(private readonly tables: Readonly<Record<string, ZetarisTableSpec>>, private readonly client: Pick<Zetaris, 'runSql'>) {}

  async read(request: ProbeReadRequest): Promise<ProbeReadResult> {
    const match = Object.entries(this.tables).find(([table, spec]) => `${spec.db}.${table}` === request.objectId);
    if (!match) throw new SafeError('PROBE_OBJECT_OUTSIDE_CONFIG');
    const [, spec] = match;
    const allowed = new Set(spec.columns.map(column => column.name));
    if (!request.columns.length || request.columns.some(column => !allowed.has(column))) throw new SafeError('PROBE_COLUMN_OUTSIDE_CONFIG');
    if (!request.filter || !request.keyColumns.includes(request.filter.column) || !allowed.has(request.filter.column)) throw new SafeError('PROBE_KEY_FILTER_REQUIRED');
    if (!request.filter.values.length || request.filter.values.length > 50) throw new SafeError('INVALID_PROBE_KEYS');
    const projection = request.columns.map(identifier).join(', ');
    const where = ` WHERE ${identifier(request.filter.column)} IN (${quotedValues([...request.filter.values])})`;
    const sql = `SELECT ${projection} FROM ${zetarisSourceQuery(spec)}${where} LIMIT ${request.limit}`;
    const result = await this.client.runSql(sql, request.limit);
    return {
      tuples: result.rows,
      requestId: result.requestId,
      queryId: result.queryId,
      requestedAt: result.utc,
      statement: result.sql,
      durationMs: result.durationMs,
      truncated: result.rows.length >= request.limit
    };
  }
}