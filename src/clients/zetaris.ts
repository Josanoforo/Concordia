import { randomUUID } from 'node:crypto';
import { failure, jsonRequest, localUrl, required, SafeError, sanitize, trace } from '../runtime.ts';

export type Cell = string | number | boolean | null;
export type SqlResult = { sql: string; requestId: string; queryId: string; rows: Cell[][]; durationMs: number; utc: string };
export const identifier = (value: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new SafeError('INVALID_SQL_IDENTIFIER');
  return value;
};
export function parseSqlResponse(body: any): Cell[][] {
  if (!body || typeof body !== 'object' || body.error || body.errors?.length || body.success === false || /error|fail/i.test(String(body.status ?? '')) || (typeof body.code === 'number' && body.code >= 400)) {
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message ?? body?.errors?.[0]?.message;
    throw new SafeError('ZETARIS_APPLICATION_ERROR', undefined, typeof message === 'string' ? sanitize(message.slice(0, 2000)) : undefined);
  }
  if (!Array.isArray(body.data) || !body.data.every((row: unknown) => Array.isArray(row) && row.every(cell => cell === null || ['string', 'number', 'boolean'].includes(typeof cell)))) throw new SafeError('ZETARIS_RESPONSE_SHAPE');
  return body.data;
}
export class Zetaris {
  private base: string; private key: string; private org: string;
  constructor(options?: { base: string; key: string; org: string }) {
    this.base = localUrl(options?.base ?? required('ZETARIS_REST_URL'));
    this.key = options?.key ?? required('ZETARIS_API_KEY');
    this.org = options?.org ?? required('ZETARIS_ORG_ID');
    if (!/^\d+$/.test(this.org)) throw new SafeError('INVALID_ORG_ID');
  }
  async runSql(sql: string, limit = 20, options?: { timeoutMs: number }): Promise<SqlResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new SafeError('INVALID_SQL_LIMIT');
    const timeoutMs = options?.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new SafeError('INVALID_SQL_TIMEOUT');
    if (/\b(?:COUNT\s*\(|ORDER\s+BY|GROUP\s+BY|JOIN\b)/i.test(sql)) throw new SafeError('FORBIDDEN_SQL');
    const requestId = randomUUID(), queryId = randomUUID(), start = performance.now(), utc = new Date().toISOString();
    try {
      const body = await jsonRequest(this.base + '/sql-editor/sqls/run', {
        method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'X-Org-ID': this.org, 'X-Request-ID': requestId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryId, sql, source: 'SqlEditor', limit })
      }, timeoutMs, true);
      const rows = parseSqlResponse(body).slice(0, limit);
      const result = { sql, requestId, queryId, rows, durationMs: Math.round(performance.now() - start), utc };
      trace({ kind: 'zetaris', status: 'PASS', sql, requestId, queryId, rows: rows.length, durationMs: result.durationMs, timeoutMs });
      return result;
    } catch (error) {
      trace({ kind: 'zetaris', status: 'FAIL', sql, requestId, queryId, rows: 0, durationMs: Math.round(performance.now() - start), timeoutMs, ...failure(error) });
      throw error;
    }
  }
  listDatabases() { return this.runSql('SHOW LIGHTNING DATABASES', 50); }
  listTables(db: string) { return this.runSql('SHOW LIGHTNING TABLES ' + identifier(db), 50); }
  describe(db: string, table: string) { return this.runSql(`DESCRIBE DATASOURCE TABLE ${identifier(db)}.${identifier(table)}`, 50); }
}
