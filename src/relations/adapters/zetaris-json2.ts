import { createHash } from 'node:crypto';
import { identifier, type Zetaris } from '../../clients/zetaris.ts';
import type { Unknown } from '../../contracts/types.ts';
import { SafeError } from '../../runtime.ts';
import type { ProbeAdapter, ProbeReadRequest, ProbeReadResult } from '../probes.ts';

export type Json2Column = { name: string; kind: 'string' | 'integer' };
export type Json2LiveTableBinding = {
  manifestId: string; profileAlias: string; tableId: string; sourceId: string; logicalObjectId: string;
  physicalDatabase: string; physicalTable: string; columns: Json2Column[]; expectedRows: number;
  maxRows: number; readLimit: number; observedSchemaSha256: string; typedMultisetSha256: string;
  fingerprintAlgorithm: 'CANONICAL_TYPED_ROWS_MULTISET_V1'; dataOrigin: 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN';
};
export type Json2LiveBindingDocument = {
  schemaVersion: 1; bindingId: string; bindingVersion: string;
  status: 'ROOT_REVIEWED_FOR_BOUNDED_READ_ONLY_CONSUMPTION'; reviewedAtUtc: string;
  registrationPlanFingerprint: string; packageSealSha256: string; registrationJournalSha256: string;
  backendEngineVersion: string; profileConfigPath: string; wireEncoding: 'SQL_EDITOR_STRING_CELLS_CANONICAL_INTEGER_V1';
  wireEvidenceSha256: string; readLimit: 50; maxRowsPerTable: 20;
  requiresFreshSchemaAndTypedMultisetCheckBeforeUse: true; sqlMutationAllowed: false; uslAllowed: false;
  tables: Json2LiveTableBinding[];
};
type Json2Client = Pick<Zetaris, 'describe' | 'runSql'>;
type AdapterFailure = { sourceId: string; code: string; http?: number; retryAfter?: string };
type LoadedTable = { rows: unknown[][]; rawRowsReceived: number; reportedTotal?: number; totalReported: boolean; continuationPresent: boolean; describeRequestId?: string; describeQueryId?: string; describeRequestedAt?: string; describeRawRowsReceived: number; describeRequestedLimit: number; describeTotalReported: boolean; describeReportedTotal?: number; describeContinuationPresent: boolean; describePaginationStatus: 'TOTAL_MATCHED' | 'TOTAL_UNREPORTED'; describeStatement?: string; describeDurationMs?: number; selectRequestId?: string; selectQueryId?: string; selectRequestedAt?: string; selectStatement?: string; selectDurationMs?: number; actualSchemaSha256: string; actualTypedMultisetSha256: string; actualRows: number; requestedLimit: number; paginationScope: 'CLOSED_BINDING'; paginationStatus: 'TOTAL_MATCHED' | 'TOTAL_UNREPORTED'; }

const idPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const safeIdPattern = /^[a-z0-9][a-z0-9._:-]*$/i;
const hashPattern = /^[a-f0-9]{64}$/;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value as Record<string, unknown>).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
};

export function canonicalJson2SchemaSha256(describeRows: readonly (readonly unknown[])[]): string {
  const pairs = describeRows.map(row => {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') throw new SafeError('JSON2_DESCRIBE_SHAPE_INVALID');
    return [row[0], row[1]] as const;
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return digest(canonicalJson(pairs));
}

/** Hash the canonical typed token/count multiset used by the reviewed JSON2 receipt driver. */
export function canonicalJson2TypedMultisetSha256(rows: readonly (readonly unknown[])[], columns: readonly Json2Column[]): string {
  if (rows.some(row => !Array.isArray(row) || row.length !== columns.length)) throw new SafeError('JSON2_ROW_SHAPE_INVALID');
  const counts = new Map<string, number>();
  for (const row of rows) {
    row.forEach((value, index) => {
      const column = columns[index];
      if (column.kind === 'string' ? typeof value !== 'string' : typeof value !== 'number' || !Number.isSafeInteger(value)) throw new SafeError('JSON2_TYPED_VALUE_INVALID');
    });
    const token = canonicalJson(row.map((value, index) => [columns[index].kind === 'string' ? 'str' : 'int', value]));
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const sorted = [...counts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return digest(canonicalJson(sorted));
}
export function validateJson2LiveBinding(input: unknown, expected?: {
  manifestId: string; profileAlias: string; sourceId: string; logicalObjectId: string;
  tableId: string; columns: readonly Json2Column[]; expectedRows: number; rowLimit: number;
  dataOrigin: Json2LiveTableBinding['dataOrigin'];
}): { path: string; code: string }[] {
  const issues: { path: string; code: string }[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [{ path: 'binding', code: 'EXPECTED_BINDING_OBJECT' }];
  const binding = input as Json2LiveBindingDocument;
  if (binding.schemaVersion !== 1) issues.push({ path: 'binding.schemaVersion', code: 'UNSUPPORTED_BINDING_SCHEMA' });
  if (!safeIdPattern.test(binding.bindingId ?? '') || !/^\d+\.\d+\.\d+$/.test(binding.bindingVersion ?? '')) issues.push({ path: 'binding', code: 'INVALID_BINDING_IDENTITY' });
  if (binding.status !== 'ROOT_REVIEWED_FOR_BOUNDED_READ_ONLY_CONSUMPTION') issues.push({ path: 'binding.status', code: 'BINDING_NOT_REVIEWED' });
  if (!Number.isFinite(Date.parse(binding.reviewedAtUtc ?? ''))) issues.push({ path: 'binding.reviewedAtUtc', code: 'INVALID_REVIEW_TIME' });
  for (const key of ['registrationPlanFingerprint', 'packageSealSha256', 'registrationJournalSha256', 'wireEvidenceSha256'] as const) {
    if (!hashPattern.test(binding[key] ?? '')) issues.push({ path: 'binding.' + key, code: 'INVALID_RECEIPT_HASH' });
  }
  if (binding.wireEncoding !== 'SQL_EDITOR_STRING_CELLS_CANONICAL_INTEGER_V1') issues.push({ path: 'binding.wireEncoding', code: 'UNSUPPORTED_WIRE_ENCODING' });
  if (binding.readLimit !== 50 || binding.maxRowsPerTable !== 20 || binding.requiresFreshSchemaAndTypedMultisetCheckBeforeUse !== true || binding.sqlMutationAllowed !== false || binding.uslAllowed !== false) issues.push({ path: 'binding', code: 'UNSAFE_BINDING_BOUNDS' });
  if (!Array.isArray(binding.tables) || binding.tables.length === 0) return [...issues, { path: 'binding.tables', code: 'TABLE_BINDINGS_REQUIRED' }];
  if (binding.tables.length > 10 || binding.tables.length * 2 > 20 || binding.tables.reduce((total, table) => total + (Number.isInteger(table?.expectedRows) ? table.expectedRows : 0), 0) > 145) issues.push({ path: 'binding.tables', code: 'TOTAL_LIVE_BOUNDS_EXCEEDED' });
  const sources = new Set<string>(), objects = new Set<string>(), physical = new Set<string>();
  binding.tables.forEach((table, index) => {
    const at = 'binding.tables[' + index + ']';
    if (!table || typeof table !== 'object' || Array.isArray(table)) { issues.push({ path: at, code: 'EXPECTED_TABLE_BINDING' }); return; }
    if (!safeIdPattern.test(table.manifestId ?? '') || !safeIdPattern.test(table.profileAlias ?? '') || !safeIdPattern.test(table.tableId ?? '')) issues.push({ path: at, code: 'INVALID_TABLE_IDENTITY' });
    if (!safeIdPattern.test(table.sourceId ?? '') || !safeIdPattern.test(table.logicalObjectId ?? '')) issues.push({ path: at, code: 'INVALID_LOGICAL_REFERENCE' });
    if (sources.has(table.sourceId)) issues.push({ path: at + '.sourceId', code: 'DUPLICATE_SOURCE_ID' });
    if (objects.has(table.logicalObjectId)) issues.push({ path: at + '.logicalObjectId', code: 'DUPLICATE_LOGICAL_OBJECT' });
    sources.add(table.sourceId); objects.add(table.logicalObjectId);
    if (!idPattern.test(table.physicalDatabase ?? '') || !idPattern.test(table.physicalTable ?? '')) issues.push({ path: at, code: 'INVALID_PHYSICAL_IDENTIFIER' });
    const physicalId = (table.physicalDatabase ?? '') + '.' + (table.physicalTable ?? '');
    if (physical.has(physicalId)) issues.push({ path: at, code: 'DUPLICATE_PHYSICAL_OBJECT' });
    physical.add(physicalId);
    if (!Array.isArray(table.columns) || table.columns.length === 0 || table.columns.some(column => !column || !idPattern.test(column.name ?? '') || !['string', 'integer'].includes(column.kind)) || new Set(table.columns.map(column => column.name)).size !== table.columns.length) issues.push({ path: at + '.columns', code: 'INVALID_COLUMN_ALLOWLIST' });
    if (!Number.isInteger(table.expectedRows) || table.expectedRows < 0 || !Number.isInteger(table.maxRows) || table.maxRows < 1 || table.maxRows > 20 || table.expectedRows > table.maxRows) issues.push({ path: at, code: 'INVALID_ROW_BOUND' });
    if (table.readLimit !== binding.readLimit) issues.push({ path: at + '.readLimit', code: 'READ_LIMIT_MISMATCH' });
    if (!hashPattern.test(table.observedSchemaSha256 ?? '') || !hashPattern.test(table.typedMultisetSha256 ?? '') || table.fingerprintAlgorithm !== 'CANONICAL_TYPED_ROWS_MULTISET_V1') issues.push({ path: at, code: 'INVALID_CONTENT_RECEIPT' });
    if (!['SYNTHETIC', 'PUBLIC', 'USER', 'UNKNOWN'].includes(table.dataOrigin)) issues.push({ path: at + '.dataOrigin', code: 'INVALID_DATA_ORIGIN' });
    if (expected) {
      if (table.manifestId !== expected.manifestId || table.profileAlias !== expected.profileAlias || table.sourceId !== expected.sourceId || table.logicalObjectId !== expected.logicalObjectId || table.tableId !== expected.tableId) issues.push({ path: at, code: 'BINDING_PROFILE_REFERENCE_MISMATCH' });
      if (JSON.stringify(table.columns) !== JSON.stringify(expected.columns)) issues.push({ path: at + '.columns', code: 'BINDING_PROFILE_SCHEMA_MISMATCH' });
      if (table.expectedRows !== expected.expectedRows || table.maxRows !== expected.rowLimit || table.dataOrigin !== expected.dataOrigin) issues.push({ path: at, code: 'BINDING_PROFILE_SNAPSHOT_MISMATCH' });
    }
  });
  return issues;
}

function normalizedKind(value: unknown): Json2Column['kind'] | undefined {
  if (typeof value !== 'string') return undefined;
  let decoded = value;
  if (value.startsWith('"') || value.endsWith('"')) {
    try { decoded = JSON.parse(value); } catch { return undefined; }
    if (typeof decoded !== 'string') return undefined;
  }
  if (decoded === 'string') return 'string';
  if (['tinyint', 'smallint', 'int', 'integer', 'bigint', 'long'].includes(decoded)) return 'integer';
  return undefined;
}function typeCell(value: unknown, column: Json2Column): unknown {
  if (value === null) throw new SafeError('JSON2_WIRE_NULL_UNSUPPORTED');
  if (column.kind === 'string') {
    if (typeof value !== 'string') throw new SafeError('JSON2_WIRE_STRING_REQUIRED');
    return value;
  }
  if (typeof value !== 'string' || !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value)) throw new SafeError('JSON2_CANONICAL_INTEGER_REQUIRED');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || String(number) !== value) throw new SafeError('JSON2_SAFE_INTEGER_REQUIRED');
  return number;
}

function assertSqlAuditMetadata(result: { requestId?: unknown; queryId?: unknown; utc?: unknown; rows?: unknown }): void {
  if (typeof result.requestId !== 'string' || !result.requestId.trim() || typeof result.queryId !== 'string' || !result.queryId.trim()) throw new SafeError('JSON2_AUDIT_IDS_REQUIRED');
  if (typeof result.utc !== 'string' || !Number.isFinite(Date.parse(result.utc))) throw new SafeError('JSON2_AUDIT_TIMESTAMP_REQUIRED');
  if (!Array.isArray(result.rows)) throw new SafeError('JSON2_AUDIT_ROWS_REQUIRED');
}
function verifiedPage(result: { rows: unknown[]; rawRowsReceived?: number; reportedTotal?: number; totalReported?: boolean; continuationPresent?: boolean }) {
  const rawRowsReceived = Number.isSafeInteger(result.rawRowsReceived) && (result.rawRowsReceived as number) >= 0 ? result.rawRowsReceived as number : result.rows.length;
  const totalReported = result.totalReported === true || result.reportedTotal !== undefined;
  const continuationPresent = Boolean(result.continuationPresent);
  if (continuationPresent || totalReported && (typeof result.reportedTotal !== 'number' || result.reportedTotal !== rawRowsReceived)) throw new SafeError('JSON2_RESULT_PAGINATION_INCOMPLETE');
  if (rawRowsReceived !== result.rows.length) throw new SafeError('JSON2_RESULT_ROWS_TRUNCATED');
  return { rawRowsReceived, totalReported, ...(typeof result.reportedTotal === 'number' ? { reportedTotal: result.reportedTotal } : {}), continuationPresent };
}
/** Cached, bounded, read-only adapter for the exact reviewed JSON2 bindings. It performs fresh DESCRIBE before each object's first read. */
export class ZetarisJson2ProbeAdapter implements ProbeAdapter {
  readonly adapterId = 'zetaris-json2-live';
  private readonly tableByRef: Map<string, Json2LiveTableBinding>;
  private readonly loaded = new Map<string, Promise<LoadedTable>>();
  private readonly completed = new Map<string, LoadedTable>();
  private failed = false;
  private failureSummary: AdapterFailure | undefined;

  constructor(private readonly binding: Json2LiveBindingDocument, private readonly client: Json2Client) {
    const issues = validateJson2LiveBinding(binding);
    if (issues.length) throw new SafeError('JSON2_BINDING_INVALID', undefined, JSON.stringify(issues));
    this.tableByRef = new Map(binding.tables.map(table => [table.sourceId + ':' + table.logicalObjectId, table]));
  }

  async verifyAllTables(): Promise<{ status: 'COMPLETE' | 'PARTIAL' | 'ERROR'; tables: unknown[]; failure?: AdapterFailure }> {
    for (const table of this.binding.tables) {
      if (this.failed) break;
      const key = table.sourceId + ':' + table.logicalObjectId;
      let loaded = this.loaded.get(key);
      if (!loaded) { loaded = this.loadTable(table); this.loaded.set(key, loaded); }
      try { this.completed.set(key, await loaded); } catch (error) {
        this.failed = true;
        this.failureSummary = this.failureFor(table.sourceId, error);
        break;
      }
    }
    return this.getRunSummary();
  }

  getRunSummary(): { status: 'COMPLETE' | 'PARTIAL' | 'ERROR'; tables: unknown[]; failure?: AdapterFailure } {
    const tables = this.binding.tables.map(table => {
      const result = this.completed.get(table.sourceId + ':' + table.logicalObjectId);
      const status = result ? 'VERIFIED' : this.failureSummary?.sourceId === table.sourceId ? 'ERROR' : 'NOT_REQUESTED';
      return { sourceId: table.sourceId, logicalObjectId: table.logicalObjectId, status,
        ...(result ? { expectedRows: table.expectedRows, actualRows: result.actualRows, describeRawRowsReceived: result.describeRawRowsReceived, describeRequestedLimit: result.describeRequestedLimit, describeTotalReported: result.describeTotalReported, ...(result.describeReportedTotal !== undefined ? { describeReportedTotal: result.describeReportedTotal } : {}), describeContinuationPresent: result.describeContinuationPresent, describePaginationStatus: result.describePaginationStatus, rawRowsReceived: result.rawRowsReceived,
          requestedLimit: result.requestedLimit, paginationScope: result.paginationScope, paginationStatus: result.paginationStatus,
          totalReported: result.totalReported, ...(result.reportedTotal !== undefined ? { reportedTotal: result.reportedTotal } : {}),
          continuationPresent: result.continuationPresent, describeRequestId: result.describeRequestId, describeQueryId: result.describeQueryId,
          describeRequestedAt: result.describeRequestedAt, describeStatement: result.describeStatement,
          describeDurationMs: result.describeDurationMs, selectRequestId: result.selectRequestId,
          selectQueryId: result.selectQueryId, selectRequestedAt: result.selectRequestedAt,
          selectStatement: result.selectStatement, selectDurationMs: result.selectDurationMs,
          observedSchemaSha256: result.actualSchemaSha256, observedTypedMultisetSha256: result.actualTypedMultisetSha256 } : {}) };
    });
    const status = this.failureSummary ? (this.completed.size ? 'PARTIAL' : 'ERROR') : this.completed.size === this.binding.tables.length ? 'COMPLETE' : 'PARTIAL';
    return { status, tables, ...(this.failureSummary ? { failure: this.failureSummary } : {}) };
  }
  async read(request: ProbeReadRequest): Promise<ProbeReadResult> {
    const table = this.tableByRef.get(request.sourceId + ':' + request.objectId);
    if (!table) throw new SafeError('JSON2_OBJECT_OUTSIDE_ALLOWLIST');
    if (request.filter) throw new SafeError('JSON2_FILTER_UNSUPPORTED_FOR_VERIFIED_SNAPSHOT');
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > this.binding.readLimit) throw new SafeError('JSON2_LIMIT_OUTSIDE_BINDING');
    if (!request.columns.length || request.columns.some(column => !table.columns.some(allowed => allowed.name === column))) throw new SafeError('JSON2_COLUMN_OUTSIDE_ALLOWLIST');
    if (!request.keyColumns.length || request.keyColumns.some(column => !request.columns.includes(column))) throw new SafeError('JSON2_KEY_PROJECTION_MISSING');
    const key = table.sourceId + ':' + table.logicalObjectId;
    let loaded = this.loaded.get(key);
    if (!loaded && this.failed && !this.completed.has(key)) throw new SafeError('JSON2_SESSION_ABORTED_AFTER_FAILURE');
    if (!loaded) { loaded = this.completed.has(key) ? Promise.resolve(this.completed.get(key)!) : this.loadTable(table); this.loaded.set(key, loaded); }
    try {
      const result = await loaded;
      this.completed.set(key, result);

      const indexes = request.columns.map(column => table.columns.findIndex(allowed => allowed.name === column));
      return { tuples: result.rows.slice(0, request.limit).map(row => indexes.map(index => row[index])),
        requestId: result.selectRequestId, requestedAt: result.selectRequestedAt, statement: result.selectStatement,
        queryId: result.selectQueryId, durationMs: result.selectDurationMs,
        truncated: result.rows.length > request.limit || result.rows.length >= this.binding.readLimit,
        nativeVersion: { state: 'UNKNOWN' }, fingerprint: { state: 'KNOWN', value: table.typedMultisetSha256, provenance: 'verified-json2-bounded-typed-multiset' } };
    } catch (error) {
      this.failed = true;
      this.failureSummary ??= this.failureFor(table.sourceId, error);
      throw error;
    }
  }

  private failureFor(sourceId: string, error: unknown): AdapterFailure {
    if (!(error instanceof SafeError)) return { sourceId, code: 'UNEXPECTED_ERROR' };
    return { sourceId, code: error.code, ...(Number.isInteger(error.http) ? { http: error.http } : {}), ...(typeof error.retryAfter === 'string' && error.retryAfter.length <= 128 && !error.retryAfter.includes(String.fromCharCode(10)) && !error.retryAfter.includes(String.fromCharCode(13)) ? { retryAfter: error.retryAfter } : {}) };
  }
  private async loadTable(table: Json2LiveTableBinding): Promise<LoadedTable> {
    const described = await this.client.describe(table.physicalDatabase, table.physicalTable, { trace: true });
    assertSqlAuditMetadata(described);
    const describePage = verifiedPage(described);
    const actualColumns: Json2Column[] = [];
    for (const row of described.rows) {
      if (!Array.isArray(row) || row.length < 2) throw new SafeError('JSON2_DESCRIBE_SHAPE_INVALID');
      const kind = normalizedKind(row[1]);
      if (!kind) throw new SafeError('JSON2_DESCRIBE_TYPE_UNSUPPORTED');
      actualColumns.push({ name: String(row[0]), kind });
    }
    if (actualColumns.length !== table.columns.length || table.columns.some(column => !actualColumns.some(actual => actual.name === column.name && actual.kind === column.kind))) throw new SafeError('JSON2_SCHEMA_MISMATCH');
    const actualSchemaHash = canonicalJson2SchemaSha256(described.rows);
    if (actualSchemaHash !== table.observedSchemaSha256) throw new SafeError('JSON2_SCHEMA_RECEIPT_MISMATCH');
    const projection = table.columns.map(column => identifier(column.name)).join(', ');
    const sql = 'SELECT ' + projection + ' FROM ' + identifier(table.physicalDatabase) + '.' + identifier(table.physicalTable) + ' LIMIT ' + this.binding.readLimit;
    const result = await this.client.runSql(sql, this.binding.readLimit, { trace: true });
    assertSqlAuditMetadata(result);
    const selectPage = verifiedPage(result);
    const { rawRowsReceived, totalReported, continuationPresent } = selectPage;
    if (result.rows.length >= this.binding.readLimit || result.rows.length !== table.expectedRows || result.rows.length > table.maxRows) throw new SafeError('JSON2_ROW_COUNT_MISMATCH');
    const rows = result.rows.map(row => {
      if (!Array.isArray(row) || row.length !== table.columns.length) throw new SafeError('JSON2_ROW_SHAPE_INVALID');
      return row.map((cell, index) => typeCell(cell, table.columns[index]));
    });
    const actualTypedMultisetSha256 = canonicalJson2TypedMultisetSha256(rows, table.columns);
    if (actualTypedMultisetSha256 !== table.typedMultisetSha256) throw new SafeError('JSON2_TYPED_MULTISET_MISMATCH');
    return { rows, rawRowsReceived, ...(selectPage.reportedTotal !== undefined ? { reportedTotal: selectPage.reportedTotal } : {}), totalReported, continuationPresent, describeRawRowsReceived: describePage.rawRowsReceived, describeRequestedLimit: 50, describeTotalReported: describePage.totalReported, ...(describePage.reportedTotal !== undefined ? { describeReportedTotal: describePage.reportedTotal } : {}), describeContinuationPresent: describePage.continuationPresent, describePaginationStatus: describePage.totalReported ? 'TOTAL_MATCHED' : 'TOTAL_UNREPORTED', describeRequestId: described.requestId, describeQueryId: described.queryId,
      describeRequestedAt: described.utc, describeStatement: described.sql, describeDurationMs: described.durationMs,
      selectRequestId: result.requestId, selectQueryId: result.queryId, selectRequestedAt: result.utc,
      selectStatement: result.sql, selectDurationMs: result.durationMs, actualSchemaSha256: actualSchemaHash,
      actualTypedMultisetSha256, actualRows: rows.length, requestedLimit: this.binding.readLimit, paginationScope: 'CLOSED_BINDING', paginationStatus: totalReported ? 'TOTAL_MATCHED' : 'TOTAL_UNREPORTED' };
  }
}
