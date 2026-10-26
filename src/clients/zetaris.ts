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
/**
 * Read path allowlist (R6-S1, hardened G0-1): the MAIN statement must be SELECT, DESCRIBE or SHOW, a WITH whose CTE list is followed by a SELECT, LOAD USL <model>
 * (read-only load of USL metadata) or LIST DQ USL <model>. Literals and comments are removed first, parentheses must balance, and a mutation verb in any position
 * outside literals refuses the statement, so a CTE cannot carry an INSERT/UPDATE/DELETE/MERGE. Any statement chain is refused before it is sent.
 */
const MUTATION_VERBS = /\b(?:INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|OVERWRITE|MATERIALIZE|COMPILE|ACTIVATE|OUTFILE|DUMPFILE)\b/i;
/**
 * Replaces string literals and quoted identifiers with an inert token. Comments are NOT interpreted: the guard cannot know how the backend closes or nests them
 * (a `--` ended by \r, nested block comments), so any comment marker outside a literal is refused by the callers (fail-closed). Returns null for an unterminated
 * literal or a literal with a backslash (backend escape rules are unknown, so the guard cannot know where the literal ends).
 */
export function stripSqlLiterals(sql: string): string | null {
  let out = '', i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length || sql[j] === '\\') return null;
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      out += c === '`' ? ' _q_ ' : " '' "; i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
/** Fail-closed lexical gate shared by the read path and the non-COMPILE legacy forms: returns the literal-free text, or null when the statement is ambiguous. */
function unambiguousStatement(sql: unknown): string | null {
  // Control characters other than \n and \t (\r, NUL, VT, FF, NEL, U+2028/9 ...) may end a line comment or split a statement differently in the backend.
  if (typeof sql !== 'string' || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(sql)) return null;
  const bare = stripSqlLiterals(sql);
  if (bare === null || /--|\/\*|\*\//.test(bare)) return null;
  const body = bare.trim().replace(/;$/, '');
  return body.includes(';') ? null : body.trim();
}
/** Collapses every parenthesised group to "()" so the depth-0 shape of the statement can be matched. Returns null when parentheses do not balance. */
function collapseParens(text: string): string | null {
  let depth = 0, out = '';
  for (const c of text) {
    if (c === '(') { if (depth++ === 0) out += '()'; continue; }
    if (c === ')') { if (--depth < 0) return null; continue; }
    if (depth === 0) out += c;
  }
  return depth === 0 ? out : null;
}
export function assertReadPathSql(sql: string): void {
  const single = unambiguousStatement(sql);
  const shape = single === null ? null : collapseParens(single);
  const ok = single !== null && shape !== null && !MUTATION_VERBS.test(single) && (
    /^(?:SELECT|DESCRIBE|SHOW)\b/i.test(single)
    || /^WITH\s+(?:RECURSIVE\s+)?[A-Za-z_]\w*\s*(?:\(\)\s*)?AS\s*\(\)(?:\s*,\s*[A-Za-z_]\w*\s*(?:\(\)\s*)?AS\s*\(\))*\s*SELECT\b/i.test(shape)
    || /^LOAD\s+USL\s+[A-Za-z0-9_.]+(?:\s+NAMESPACE\s+[A-Za-z0-9_.]+)?$/i.test(single)
    || /^LIST\s+DQ\s+USL\s+[A-Za-z0-9_.]+$/i.test(single));
  if (!ok) throw new SafeError('READ_PATH_MUTATION_FORBIDDEN');
}
/**
 * Closed bounded-aggregate form (L3-1): the one aggregate the exploration compiler emits for BOUNDED_PROFILE. COUNT/COUNT DISTINCT/SUM CASE over a single key
 * column, taken from a LIMITed subquery, with the concordia_* aliases. Everything else with COUNT(, GROUP BY, ORDER BY or JOIN stays vetoed. Checked on the
 * literal-free text, after the same fail-closed lexical gate as the read path.
 */
const RUN_SQL_VETO = /\b(?:COUNT\s*\(|ORDER\s+BY|GROUP\s+BY|JOIN\b|NOT\s+IN\s*\(\s*SELECT\b)/i;
const SUBQUERY_VETO = /\b(?:COUNT\s*\(|ORDER\s+BY|GROUP\s+BY|JOIN|UNION\b|NOT\s+IN\s*\(\s*SELECT\b)/i;
const BOUNDED_PROFILE_HEAD = /^SELECT COUNT\(\*\) AS concordia_rows, COUNT\(DISTINCT ([A-Za-z_]\w*)\) AS concordia_distinct, SUM\(CASE WHEN ([A-Za-z_]\w*) IS NULL THEN 1 ELSE 0 END\) AS concordia_nulls FROM \(/;
export function isBoundedAggregateSql(sql: string): boolean {
  const single = unambiguousStatement(sql);
  const head = single === null ? null : BOUNDED_PROFILE_HEAD.exec(single);
  if (single === null || head === null || head[1] !== head[2]) return false;
  let depth = 1, index = head[0].length;
  for (; index < single.length && depth > 0; index++) { if (single[index] === '(') depth++; else if (single[index] === ')') depth--; }
  if (depth !== 0 || single.slice(index) !== ' concordia_bounded') return false;
  const inner = single.slice(head[0].length, index - 1);
  return /^SELECT [^;]+ LIMIT [0-9]{1,4}$/.test(inner) && !SUBQUERY_VETO.test(inner);
}
/**
 * Closed keyed aggregate (AGGREGATE_COUNT): SELECT <key>, COUNT(*) AS concordia_count FROM <db.table | (source query) concordia_source> WHERE <key> IN ('safe', ...) GROUP BY <key> LIMIT n.
 * The key is one identifier (optionally backticked) repeated in all three places, the IN list holds only SAFE_LITERAL strings (at most 50), LIMIT is mandatory, and the
 * source query is a balanced subquery without COUNT(/GROUP BY/ORDER BY/JOIN/UNION. Any other GROUP BY stays vetoed.
 */
const KEYED_LIST = "'[A-Za-z0-9._-]{1,64}'(?:, '[A-Za-z0-9._-]{1,64}'){0,49}";
const KEYED_HEAD = "^SELECT (`?)([A-Za-z_]\\w*)\\1, COUNT\\(\\*\\) AS concordia_count FROM ";
const KEYED_TAIL = " WHERE \\2 IN \\((" + KEYED_LIST + ")\\) GROUP BY \\1\\2\\1 LIMIT [0-9]{1,4}$";
const KEYED_TABLE = new RegExp(KEYED_HEAD + "[A-Za-z_]\\w*\\.[A-Za-z_]\\w*" + KEYED_TAIL);
const KEYED_SUBQUERY = new RegExp(KEYED_HEAD + "\\(([\\s\\S]+)\\) concordia_source" + KEYED_TAIL);
export function isBoundedKeyedAggregateSql(sql: string): boolean {
  if (unambiguousStatement(sql) === null || typeof sql !== 'string') return false;
  const text = sql.trim();
  if (KEYED_TABLE.test(text)) return true;
  const inner = KEYED_SUBQUERY.exec(text)?.[3];
  if (inner === undefined) return false;
  const bare = stripSqlLiterals(inner);
  return bare !== null && collapseParens(bare) !== null && !SUBQUERY_VETO.test(bare) && !bare.includes(';');
}
/**
 * Full-evidence forms (Ronda 9, contract RONDA9_CONTRATO_SQL_FULL_EVIDENCE): F1 global profile, F2 duplicated keys (GROUP BY ... HAVING COUNT(*) > 1 LIMIT n<=50),
 * F3a/F3b anti-join of source keys missing from the target (the only JOIN allowed, and only in this exact LEFT JOIN form; F3a has LIMIT n<=50), F4 distinct sample.
 * <src> is DB.table or a balanced `(SELECT ...) concordia_source` subquery without COUNT(/GROUP BY/ORDER BY/JOIN/UNION/`;`. Each key is one identifier (optionally
 * backticked) repeated identically. Matched part by part, over the whole statement; anything else keeps the veto.
 */
type FormPart = string | RegExp;
const KEY = Symbol('KEY'), SRC = Symbol('SRC'), SRCS = Symbol('SRCS'), LIMIT = Symbol('LIMIT');
type Token = FormPart | typeof KEY | typeof SRC | typeof SRCS | typeof LIMIT;
const FE_IDENT = String.raw`[A-Za-z_]\w*`;
/** Matches the whole statement against the parts; returns the KEY texts in order, or null. */
function matchFullEvidence(text: string, parts: readonly Token[], maxLimit = 50): string[] | null {
  let pos = 0; const keys: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string') { if (!text.startsWith(part, pos)) return null; pos += part.length; continue; }
    if (part instanceof RegExp) { const sticky = new RegExp(part.source, 'y'); sticky.lastIndex = pos; if (!sticky.exec(text)) return null; pos = sticky.lastIndex; continue; }
    if (part === KEY) {
      const key = new RegExp('(`?)' + FE_IDENT + '\\1', 'y'); key.lastIndex = pos;
      const hit = key.exec(text); if (!hit) return null;
      keys.push(hit[0]); pos = key.lastIndex; continue;
    }
    if (part === LIMIT) {
      const tail = /[0-9]{1,3}$/y; tail.lastIndex = pos;
      const hit = tail.exec(text); const n = hit ? Number(hit[0]) : 0;
      if (!hit || n < 1 || n > maxLimit) return null;
      pos = text.length; continue;
    }
    // SRC: DB.table, or a balanced (SELECT ...) concordia_source subquery. SRCS: the same source carrying the alias concordia_s itself (no concordia_source suffix).
    const alias = part === SRCS ? ' concordia_s' : null, aliasAt = (at: number) => text.startsWith(alias!, at) && !/\w/.test(text[at + alias!.length] ?? '');
    const plain = new RegExp(`${FE_IDENT}\\.${FE_IDENT}`, 'y'); plain.lastIndex = pos;
    if (plain.exec(text) && text[plain.lastIndex] !== '(') { if (alias && !aliasAt(plain.lastIndex)) return null; pos = plain.lastIndex + (alias ? alias.length : 0); continue; }
    if (text[pos] !== '(') return null;
    let depth = 0, end = -1;
    for (let i = pos; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) { end = i; break; } }
    if (end < 0 || (alias ? !aliasAt(end + 1) : !text.startsWith(' concordia_source', end + 1))) return null;
    const inner = text.slice(pos + 1, end), bare = stripSqlLiterals(inner);
    if (!inner.startsWith('SELECT ') || bare === null || collapseParens(bare) === null || SUBQUERY_VETO.test(bare) || bare.includes(';')) return null;
    pos = end + 1 + (alias ?? ' concordia_source').length;
  }
  return pos === text.length ? keys : null;
}
const ANTIJOIN_MID: Token[] = [' AS k FROM ', SRC, ' WHERE ', KEY, ' IS NOT NULL) concordia_s LEFT JOIN (SELECT DISTINCT ', KEY, ' AS k FROM ', SRC, ') concordia_t ON concordia_s.k = concordia_t.k WHERE concordia_t.k IS NULL'];
const FULL_EVIDENCE_FORMS: { parts: Token[]; same: number[]; maxLimit?: number }[] = [
  { parts: ['SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT ', KEY, ') AS concordia_distinct, SUM(CASE WHEN ', KEY, ' IS NULL THEN 1 ELSE 0 END) AS concordia_nulls FROM ', SRC], same: [0, 1] },
  // F1x: extended profile, one scan (MIN, MAX, AVG of the text length of the key).
  { parts: ['SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT ', KEY, ') AS concordia_distinct, SUM(CASE WHEN ', KEY, ' IS NULL THEN 1 ELSE 0 END) AS concordia_nulls, MIN(', KEY, ') AS concordia_min, MAX(', KEY, ') AS concordia_max, AVG(LENGTH(CAST(', KEY, ' AS STRING))) AS concordia_avg_len FROM ', SRC], same: [0, 1, 2, 3, 4] },
  // F3c: orphans by rows (F3b counts distinct keys); keys are [target, source join, source filter]. No NOT IN: a NULL in the target would hide every orphan.
  { parts: ['SELECT COUNT(*) AS concordia_missing_rows FROM ', SRCS, ' LEFT JOIN (SELECT DISTINCT ', KEY, ' AS k FROM ', SRC, ') concordia_t ON concordia_s.', KEY, ' = concordia_t.k WHERE concordia_s.', KEY, ' IS NOT NULL AND concordia_t.k IS NULL'], same: [1, 2] },
  { parts: ['SELECT ', KEY, ', COUNT(*) AS concordia_count FROM ', SRC, ' GROUP BY ', KEY, ' HAVING COUNT(*) > 1 LIMIT ', LIMIT], same: [0, 1] },
  { parts: ['SELECT concordia_s.k FROM (SELECT DISTINCT ', KEY, ...ANTIJOIN_MID, ' LIMIT ', LIMIT], same: [0, 1] },
  { parts: ['SELECT COUNT(*) AS concordia_missing FROM (SELECT DISTINCT ', KEY, ...ANTIJOIN_MID], same: [0, 1] },
  { parts: ['SELECT DISTINCT ', KEY, ' FROM ', SRC, ' WHERE ', KEY, ' IS NOT NULL LIMIT ', LIMIT], same: [0, 1], maxLimit: 999 }
];
export function isFullEvidenceSql(sql: string): boolean {
  if (typeof sql !== 'string' || unambiguousStatement(sql) === null) return false;
  const text = sql.trim();
  return FULL_EVIDENCE_FORMS.some(form => { const keys = matchFullEvidence(text, form.parts, form.maxLimit); return keys !== null && form.same.every(index => keys[index] === keys[form.same[0]]); });
}
/** The whole runSql gate: the veto (unless the SQL is exactly one of the closed bounded aggregates or full-evidence forms) and the read-path allowlist. */
export function assertRunSqlAllowed(sql: string): void {
  if (RUN_SQL_VETO.test(sql) && !isBoundedAggregateSql(sql) && !isBoundedKeyedAggregateSql(sql) && !isFullEvidenceSql(sql)) throw new SafeError('FORBIDDEN_SQL');
  assertReadPathSql(sql);
}
/**
 * Legacy mutation allowlist (G0-2): each legacy caller may send only the closed statement shapes below; anything else is LEGACY_MUTATION_NOT_ALLOWED before the transport.
 * CREATE LIGHTNING / CREATE NAMESPACE, COMPILE USL, ACTIVATE USL TABLE, LOAD USL are the only forms; no UPDATE USL (it replaces a published model and goes only through runAuthorizedPublicationSql)/DROP/ALTER/INSERT/DELETE and no chain of statements
 * (the COMPILE DDL payload is the single place where the sent block carries semicolons, as the backend requires).
 */
const LEGACY_FORMS = {
  create_lightning: /^CREATE LIGHTNING (?:DATABASE|FILESTORE TABLE|REST TABLE) [^;]*$/i,
  create_namespace: /^CREATE NAMESPACE IF NOT EXISTS [A-Za-z0-9_.]+;?$/i,
  compile: /^COMPILE USL (?:IF NOT EXISTS )?[A-Za-z0-9_]+ (?:DEPLOY )?NAMESPACE [A-Za-z0-9_.]+ DDL\n[\s\S]+$/i,
  activate: /^ACTIVATE USL TABLE [A-Za-z0-9_.]+ AS SELECT [^;]*$/i,
  load: /^LOAD USL [A-Za-z0-9_]+(?: NAMESPACE [A-Za-z0-9_.]+)?$/i,
  schemastore_container: /^CREATE SCHEMASTORE CONTAINER [A-Za-z0-9_.]+$/i,
  schemastore_view: /^CREATE SCHEMASTORE VIEW [A-Za-z0-9_.]+ WITH CONTAINER [A-Za-z0-9_.]+ AS\s+(?:SELECT|WITH)\b[^;]*$/i,
  cache_table: /^CACHE TABLE [A-Za-z0-9_.]+$/i
} as const;
export const LEGACY_MUTATION_CALLERS = {
  decisions: ['create_lightning'], 'register-madi': ['create_lightning'], 'register-madi-domains': ['create_lightning'], 'p4-live-freshness': ['create_lightning'], register: ['create_lightning', 'schemastore_container', 'schemastore_view', 'cache_table'],
  'usl-complete': ['create_namespace', 'load', 'compile', 'activate'], 'usl-index': ['create_namespace', 'compile', 'activate'],
  'usl-resume': ['load', 'activate'], 'usl-demo': ['create_namespace', 'compile', 'activate']
} as const satisfies Record<string, readonly (keyof typeof LEGACY_FORMS)[]>;
export type LegacyMutationCaller = keyof typeof LEGACY_MUTATION_CALLERS;
/**
 * Lint of the legacy COMPILE payload (HR-3), the one place where semicolons are allowed. Same spirit as usl/ddl-lint.ts, for the legacy multi-table shape:
 * printable ASCII and LF only, no comments, no mutation verbs, only `CREATE TABLE <id> (` + column lines `<id> varchar(n)` with optional `NOT NULL PRIMARY KEY` and
 * `FOREIGN KEY REFERENCES <id>(<id>)`, and a cap on size, tables and columns. Returns a reason, or null when the payload is acceptable.
 */
export const LEGACY_COMPILE_MAX_CHARS = 20_000, LEGACY_COMPILE_MAX_TABLES = 30, LEGACY_COMPILE_MAX_COLUMNS = 200;
export function legacyCompilePayloadProblem(payload: string): string | null {
  if (payload.length > LEGACY_COMPILE_MAX_CHARS) return 'DDL payload exceeds the size cap';
  if (/[^\x20-\x7E\n]/.test(payload)) return 'DDL payload is not printable ASCII';
  if (/--|\/\*|\bCOMMENT\b/i.test(payload)) return 'DDL payload carries a comment';
  if (/\b(?:DROP|ALTER|TRUNCATE|DELETE|UPDATE|INSERT|MERGE|GRANT|REVOKE|RENAME|REPLACE|OVERWRITE)\b/i.test(payload)) return 'DDL payload carries a mutation verb';
  const ident = '[A-Za-z_][A-Za-z0-9_]*', column = String.raw`  ${ident} varchar\([0-9]{1,4}\)(?: NOT NULL PRIMARY KEY)?(?: FOREIGN KEY REFERENCES ${ident}\(${ident}\))?`;
  const table = new RegExp(String.raw`CREATE TABLE ${ident} \(\n((?:${column},\n)*${column}\n)\);`, 'y');
  let index = 0, tables = 0;
  const text = payload.replace(/\n+$/, '');
  while (index < text.length) {
    table.lastIndex = index;
    const match = table.exec(text);
    if (!match) return 'DDL payload is not a sequence of simple CREATE TABLE statements';
    if (++tables > LEGACY_COMPILE_MAX_TABLES) return 'DDL payload exceeds the table cap';
    if (match[1].split('\n').length - 1 > LEGACY_COMPILE_MAX_COLUMNS) return 'DDL payload exceeds the column cap';
    index = table.lastIndex;
    if (text[index] === '\n') index++;
  }
  return tables === 0 ? 'DDL payload has no table' : null;
}
/**
 * Trace redaction (N71): CREATE LIGHTNING REST TABLE statements carry request headers, bodies, OPTIONS and URL query strings that may hold credentials, which sanitize()
 * (env secrets and key prefixes) cannot know. The trace keeps the statement shape and the sha256 of the original; HEADER(...), BODY(...), OPTIONS(...) contents and
 * endpoint query strings are replaced by [REDACTED]. The SQL sent to the backend is never changed.
 */
export function redactSqlForTrace(sql: string): string {
  const group = String.raw`\s*\((?:[^()"']|"[^"]*"|'[^']*')*\)`;
  return String(sql)
    .replace(new RegExp(String.raw`\b(HEADER|BODY|OPTIONS)` + group, 'gi'), (_all, keyword: string) => `${keyword} ([REDACTED])`)
    .replace(/(endpoint\s+["'][^"'?]*)\?[^"']*(["'])/gi, '$1?[REDACTED]$2');
}
export function assertLegacyMutationSql(sql: string, caller: string): void {
  const forms = (LEGACY_MUTATION_CALLERS as Record<string, readonly (keyof typeof LEGACY_FORMS)[]>)[caller];
  const text = typeof sql === 'string' ? sql.trim() : '';
  const form = forms && (Object.keys(LEGACY_FORMS) as (keyof typeof LEGACY_FORMS)[]).find(name => forms.includes(name) && LEGACY_FORMS[name].test(text));
  if (!form) throw new SafeError('LEGACY_MUTATION_NOT_ALLOWED', undefined, forms ? 'statement shape not allowed for this caller' : 'unknown caller');
  if (form === 'compile') {
    const problem = legacyCompilePayloadProblem(text.slice(text.indexOf('DDL' + String.fromCharCode(10))+4));
    if (problem) throw new SafeError('LEGACY_MUTATION_NOT_ALLOWED', undefined, problem);
  } else {
    const bare = unambiguousStatement(sql);
    if (bare === null || /\b(?:DROP|ALTER|TRUNCATE|DELETE|INSERT|UPDATE|MERGE|GRANT|REVOKE)\b/i.test(bare)) throw new SafeError('LEGACY_MUTATION_NOT_ALLOWED', undefined, 'ambiguous statement, chain or forbidden verb');
  }
}
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
  async runSql(sql: string, limit = 20, options?: { timeoutMs?: number; trace?: boolean; limitCeiling?: number }): Promise<SqlResult> {
    assertRunSqlAllowed(sql);
    return this.sendSql(sql, limit, options);
  }
  /**
   * LEGACY. Explicit path for the pre-agent pipelines that still create databases/tables or compile/activate USL models (decisions, register*, usl/*). Each caller names
   * itself and may only send its closed statement forms (assertLegacyMutationSql); every call is traced with the full SQL and its own kind. It is never reachable from the
   * agent loop, which only holds read clients. Authorized USL publication DDL does not use it: that goes through runAuthorizedPublicationSql with a grant and operationBindings.
   */
  async runLegacyMutationSql(sql: string, limit: number, options: { caller: LegacyMutationCaller; timeoutMs?: number; limitCeiling?: number }): Promise<SqlResult> {
    if (/\b(?:COUNT\s*\(|ORDER\s+BY|GROUP\s+BY|JOIN\b)/i.test(sql)) throw new SafeError('FORBIDDEN_SQL');
    assertLegacyMutationSql(sql, options?.caller);
    const { caller, ...transport } = options;
    trace({ kind: 'zetaris-legacy-mutation-sql', caller, sql: redactSqlForTrace(String(sql).trim()), sqlSha256: createHash('sha256').update(String(sql).trim(), 'utf8').digest('hex') });
    return this.sendSql(sql, limit ?? 1, { ...transport, trace: true });
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
  private async sendSql(sql: string, limit: number, options?: { timeoutMs?: number; trace?: boolean; limitCeiling?: number }): Promise<SqlResult> {
    // 50 unless the caller passes an explicit per-call ceiling (the per-run probe-limit override, at most 100).
    const ceiling = options?.limitCeiling ?? 50;
    if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 100 || !Number.isInteger(limit) || limit < 1 || limit > ceiling) throw new SafeError('INVALID_SQL_LIMIT');
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
      if (options?.trace !== false) trace({ kind: 'zetaris', status: 'PASS', sql: redactSqlForTrace(sql), requestId, queryId, rows: rows.length, durationMs: result.durationMs, timeoutMs });
      return result;
    } catch (error) {
      if (options?.trace !== false) trace({ kind: 'zetaris', status: 'FAIL', sql: redactSqlForTrace(sql), requestId, queryId, rows: 0, durationMs: Math.round(performance.now() - start), timeoutMs, ...failure(error) });
      throw error;
    }
  }
  listDatabases() { return this.runSql('SHOW LIGHTNING DATABASES', 50); }
  listTables(db: string) { return this.runSql('SHOW LIGHTNING TABLES ' + identifier(db), 50); }
  describe(db: string, table: string, options?: { timeoutMs?: number; trace?: boolean }) { return this.runSql(`DESCRIBE DATASOURCE TABLE ${identifier(db)}.${identifier(table)}`, 50, options); }
}
