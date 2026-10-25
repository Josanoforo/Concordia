import { createHash, randomUUID } from 'node:crypto';
import { failure, jsonRequest, localUrl, required, SafeError, sanitize, trace } from '../runtime.ts';

export type Cell = string | number | boolean | null;
export type PublicationSqlGrant = { schemaVersion: 1; grantId: string; scope: 'LIVE_USL_PUBLICATION'; planFingerprint: string; targetRef: string; sourceBindingSha256: string; operationSqlSha256s: string[]; approvedBy: string; approvedAt: string; expiresAt: string; };
export type PublicationSqlOperation = { operationId: string; objectRef: string; sql: string; sqlSha256: string; };
export type SqlResult = {
  sql: string; requestId: string; queryId: string; rows: Cell[][]; durationMs: number; utc: string;
  /** Optional transport diagnostics for bounded consumers; legacy callers may ignore them. */
  rawRowsReceived?: number; reportedTotal?: number; totalReported?: boolean; continuationPresent?: boolean;
};
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
function sqlPaginationMetadata(body: any, rawRowsReceived: number): Pick<SqlResult, 'rawRowsReceived' | 'reportedTotal' | 'totalReported' | 'continuationPresent'> {
  const candidates = [body?.total, body?.totalCount, body?.totalRows, body?.recordsTotal];
  const rawTotal = candidates.find(value => value !== undefined);
  const totalReported = rawTotal !== undefined;
  const reportedTotal = typeof rawTotal === 'number' && Number.isSafeInteger(rawTotal) && rawTotal >= 0 ? rawTotal : undefined;
  const continuationPresent = Boolean(body?.next || body?.nextPage || body?.nextPageToken || body?.continuation || body?.continuationToken || body?.hasMore === true || body?.has_more === true);
  return { rawRowsReceived, totalReported, ...(reportedTotal !== undefined ? { reportedTotal } : {}), continuationPresent };
}
export class Zetaris {
  private base: string; private key: string; private org: string;
  constructor(options?: { base: string; key: string; org: string }) {
    this.base = localUrl(options?.base ?? required('ZETARIS_REST_URL'));
    this.key = options?.key ?? required('ZETARIS_API_KEY');
    this.org = options?.org ?? required('ZETARIS_ORG_ID');
    if (!/^\d+$/.test(this.org)) throw new SafeError('INVALID_ORG_ID');
  }
  async runSql(sql: string, limit = 20, options?: { timeoutMs?: number; trace?: boolean }): Promise<SqlResult> {
    if (/\b(?:COUNT\s*\(|ORDER\s+BY|GROUP\s+BY|JOIN\b)/i.test(sql)) throw new SafeError('FORBIDDEN_SQL');
    return this.sendSql(sql, limit, options);
  }
  /** Exact plan/grant-scoped SQL path. The ordinary runSql JOIN guard remains unchanged. */
  async runAuthorizedPublicationSql(operation: PublicationSqlOperation, grant: PublicationSqlGrant, plan: { fingerprint: string; status: 'PREPARED' | 'BLOCKED'; executable: false; target: { namespace: string; model: string }; sourceBinding: { bindingSha256: string }; operations: readonly { operationId: string; objectRef: string; sql: string | null; sqlSha256: string | null }[] }, limit = 1, options?: { timeoutMs?: number; trace?: boolean }): Promise<SqlResult> {
    const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    const targetRef = `${plan?.target?.namespace}.${plan?.target?.model}`;
    const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => !item || typeof item !== 'object' || Array.isArray(item) ? item : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))));
    const { fingerprint, ...planBody } = plan ?? {} as any;
    const planValid = plan?.status === 'PREPARED' && plan.executable === false && /^[a-f0-9]{64}$/i.test(plan.fingerprint) && hash(stable(planBody)) === plan.fingerprint;
    const plannedOperations = plan?.operations?.flatMap(item => item.sqlSha256 ? [item.sqlSha256] : []) ?? [];
    const listedOperation = plan?.operations?.some(item => item.operationId === operation?.operationId && item.objectRef === operation.objectRef && item.sql === operation.sql && item.sqlSha256 === operation.sqlSha256) ?? false;
    const now = Date.now();
    const exactGrant = planValid && listedOperation && grant?.schemaVersion === 1 && grant.scope === 'LIVE_USL_PUBLICATION' && typeof grant.grantId === 'string' && Boolean(grant.grantId) &&
      grant.planFingerprint === plan?.fingerprint && /^[a-f0-9]{64}$/i.test(grant.planFingerprint ?? '') && grant.targetRef === targetRef &&
      /^[a-f0-9]{64}$/i.test(grant.sourceBindingSha256 ?? '') && grant.sourceBindingSha256 === plan.sourceBinding.bindingSha256 && Array.isArray(grant.operationSqlSha256s) && JSON.stringify(grant.operationSqlSha256s) === JSON.stringify(plannedOperations) &&
      typeof grant.approvedBy === 'string' && Boolean(grant.approvedBy) && Number.isFinite(Date.parse(grant.approvedAt)) && Date.parse(grant.approvedAt) <= now &&
      Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > now && Date.parse(grant.expiresAt) > Date.parse(grant.approvedAt);
    const expectedObject = operation?.operationId === 'create_target_namespace' ? plan?.target?.namespace : operation?.operationId === 'compile_versioned_model' ? targetRef : operation?.operationId === 'activate_observed_relation' ? `${targetRef}.ObservedRelation` : '';
    const exactOperation = operation && typeof operation.operationId === 'string' && ['create_target_namespace', 'compile_versioned_model', 'activate_observed_relation'].includes(operation.operationId) &&
      operation.objectRef === expectedObject && typeof operation.sql === 'string' && /^[a-f0-9]{64}$/i.test(operation.sqlSha256 ?? '') &&
      hash(operation.sql) === operation.sqlSha256 && grant?.operationSqlSha256s?.includes(operation.sqlSha256) === true;
    if (!exactGrant || !exactOperation || (operation.operationId === 'activate_observed_relation' ? !/\bINNER\s+JOIN\b/i.test(operation.sql) : /\bJOIN\b/i.test(operation.sql))) throw new SafeError('EXACT_LIVE_PUBLICATION_GRANT_REQUIRED');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new SafeError('INVALID_SQL_LIMIT');
    return this.sendSql(operation.sql, limit, { ...options, trace: options?.trace ?? false });
  }
  private async sendSql(sql: string, limit: number, options?: { timeoutMs?: number; trace?: boolean }): Promise<SqlResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new SafeError('INVALID_SQL_LIMIT');
    const timeoutMs = options?.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new SafeError('INVALID_SQL_TIMEOUT');
    const requestId = randomUUID(), queryId = randomUUID(), start = performance.now(), utc = new Date().toISOString();
    try {
      const body = await jsonRequest(this.base + '/sql-editor/sqls/run', {
        method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'X-Org-ID': this.org, 'X-Request-ID': requestId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryId, sql, source: 'SqlEditor', limit })
      }, timeoutMs, true);
      const rawRows = parseSqlResponse(body);
      const rows = rawRows.slice(0, limit);
      const result = { sql, requestId, queryId, rows, ...sqlPaginationMetadata(body, rawRows.length), durationMs: Math.round(performance.now() - start), utc };
      if (options?.trace !== false) trace({ kind: 'zetaris', status: 'PASS', sql, requestId, queryId, rows: rows.length, durationMs: result.durationMs, timeoutMs });
      return result;
    } catch (error) {
      if (options?.trace !== false) trace({ kind: 'zetaris', status: 'FAIL', sql, requestId, queryId, rows: 0, durationMs: Math.round(performance.now() - start), timeoutMs, ...failure(error) });
      throw error;
    }
  }
  listDatabases() { return this.runSql('SHOW LIGHTNING DATABASES', 50); }
  listTables(db: string) { return this.runSql('SHOW LIGHTNING TABLES ' + identifier(db), 50); }
  describe(db: string, table: string, options?: { timeoutMs?: number; trace?: boolean }) { return this.runSql(`DESCRIBE DATASOURCE TABLE ${identifier(db)}.${identifier(table)}`, 50, options); }
}
