import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PublicationSqlGrant, PublicationSqlOperation, Zetaris } from '../clients/zetaris.ts';
import { ZetarisJson2ProbeAdapter, validateJson2LiveBinding, type Json2LiveBindingDocument } from '../relations/adapters/zetaris-json2.ts';
import { executeProbe, planProbe } from '../relations/probes.ts';
import { SafeError, ROOT } from '../runtime.ts';
import type { UslLifecycleAuditRead, UslLifecycleExecutionAdapter, UslSimulationSnapshot, UslSimulationOperationResult } from './lifecycle-simulator.ts';
import { readNamespacePublicationEvents } from './publication-executor.ts';
import { isUslLifecyclePlanFingerprintValid } from './lifecycle-plan.ts';
import type { UslLifecycleOperation, UslLifecyclePlan } from './lifecycle-plan.ts';
import type { PublicationPlanInput } from './publication-plan.ts';

export type SourceKeyProjection = { transportStatus: string; truncated: boolean | 'UNKNOWN'; measuredTuples: readonly unknown[][] };
export function sourceKeyProjectionMatches(expected: SourceKeyProjection, actual: SourceKeyProjection): boolean {
  const tupleHash = (tuples: readonly unknown[][]) => stableHash([...tuples].map(tuple => [...tuple]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')));
  return expected.transportStatus === 'OK' && actual.transportStatus === 'OK' && expected.truncated === false && actual.truncated === false && tupleHash(expected.measuredTuples) === tupleHash(actual.measuredTuples);
}export type ZetarisLifecycleClient = Pick<Zetaris, 'describe' | 'runSql' | 'runAuthorizedPublicationSql'>;
const stableHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) => !item || typeof item !== 'object' || Array.isArray(item) ? item : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))))).digest('hex');
export interface ZetarisLifecycleReaders {
  readTargetSnapshot?(): Promise<Omit<UslSimulationSnapshot, 'localClientPointer'>>;
  decodeLoadedModel?(rows: readonly (readonly unknown[])[], plan: UslLifecyclePlan): unknown;
  readObservedRows?(plan: UslLifecyclePlan): Promise<readonly (readonly unknown[])[]>;
  recheckInputs?(plan: UslLifecyclePlan): Promise<{ status: 'CURRENT' | 'STALE'; staleInputs?: string[] }>;
}

function requireCompleteRead(result: { rows: readonly unknown[]; rawRowsReceived?: number; reportedTotal?: number; totalReported?: boolean; continuationPresent?: boolean }, limit: number, incompleteCode: string, requireTotalAtLimit = false): void {
  if (!result || !Array.isArray(result.rows) || result.rawRowsReceived !== result.rows.length || result.continuationPresent === true ||
      (result.totalReported === true && (typeof result.reportedTotal !== 'number' || result.reportedTotal !== result.rows.length)) ||
      (requireTotalAtLimit && result.rows.length >= limit && result.totalReported !== true)) throw new SafeError(incompleteCode);
}
/** Parser for the observed `SHOW NAMESPACES OR TABLES IN ...` response shape. */
export function parseNamespaceCatalogRows(rows: readonly (readonly unknown[])[]): { name: string; kind: string }[] {
  if (!Array.isArray(rows) || rows.length > 50 || rows.some(row => !Array.isArray(row) || row.length < 2 || typeof row[0] !== 'string' || typeof row[1] !== 'string')) throw new SafeError('USL_NAMESPACE_CATALOG_SHAPE_INVALID');
  const entries = rows.map(row => ({ name: row[0] as string, kind: row[1] as string }));
  if (entries.some(item => !item.name || !['namespace', 'usl', 'table'].includes(item.kind)) || new Set(entries.map(item => `${item.kind}:${item.name}`)).size !== entries.length) throw new SafeError('USL_NAMESPACE_CATALOG_SHAPE_INVALID');
  return entries;
}

/** LOAD USL returns one JSON model document in a single string cell. */
export function decodeLoadedUslModelRows(rows: readonly (readonly unknown[])[]): unknown {
  if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 1 || typeof rows[0][0] !== 'string') throw new SafeError('USL_LOAD_RESPONSE_SHAPE_INVALID');
  let model: unknown;
  try { model = JSON.parse(rows[0][0] as string); } catch { throw new SafeError('USL_LOAD_MODEL_JSON_INVALID'); }
  if (!model || typeof model !== 'object' || Array.isArray(model) || typeof (model as any).name !== 'string' || !Array.isArray((model as any).namespace) || !Array.isArray((model as any).tables)) throw new SafeError('USL_LOAD_MODEL_SHAPE_INVALID');
  return model;
}

/** Shared namespace-scoped compare-and-set pointer across publication runs and model versions. */
export class FileUslClientPointerStore {
  readonly root: string;
  readonly filePath: string;
  readonly namespace: string;
  constructor(namespace: string, projectRoot = ROOT) {
    if (!/^[-A-Za-z0-9._]{1,180}$/.test(namespace)) throw new TypeError('USL_POINTER_NAMESPACE_INVALID');
    this.root = path.resolve(projectRoot);
    this.namespace = namespace;
    this.filePath = path.join(this.root, '.concordia', 'publication-runs', 'usl-client-pointers', `${createHash('sha256').update(namespace).digest('hex')}.json`);
  }
  private ensureSafe(create: boolean): void {
    const project = this.root, concordia = path.join(project, '.concordia'), runs = path.join(concordia, 'publication-runs'), pointers = path.join(runs, 'usl-client-pointers'), run = path.dirname(this.filePath);
    const projectStat = fs.lstatSync(project);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new TypeError('USL_POINTER_ROOT_UNSAFE');
    for (const dir of [concordia, runs, pointers]) {
      if (!fs.existsSync(dir)) {
        if (!create) return;
        fs.mkdirSync(dir);
      }
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('USL_POINTER_DIRECTORY_UNSAFE');
    }
    const realRuns = fs.realpathSync(runs), realRun = fs.realpathSync(run), relative = path.relative(realRuns, realRun);
    if (relative !== 'usl-client-pointers') throw new TypeError('USL_POINTER_PATH_OUTSIDE_RUNS');
    if (fs.existsSync(this.filePath)) { const stat = fs.lstatSync(this.filePath); if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError('USL_POINTER_FILE_UNSAFE'); }
  }
  read(): string | null {
    this.ensureSafe(false);
    if (!fs.existsSync(this.filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { schemaVersion?: number; namespace?: string; versionRef?: string | null };
    if (!parsed || parsed.schemaVersion !== 1 || parsed.namespace !== this.namespace || !(parsed.versionRef === null || typeof parsed.versionRef === 'string')) throw new SafeError('USL_POINTER_STATE_INVALID');
    return parsed.versionRef ?? null;
  }
  compareAndSet(expected: string | null, next: string | null): boolean {
    this.ensureSafe(true);
    const parsed = fs.existsSync(this.filePath) ? JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { schemaVersion?: number; namespace?: string; versionRef?: string | null } : { schemaVersion: 1, namespace: this.namespace, versionRef: null };
    if (!parsed || parsed.schemaVersion !== 1 || parsed.namespace !== this.namespace || (parsed.versionRef ?? null) !== expected) return false;
    parsed.versionRef = next;
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600); created = true;
      try { fs.writeFileSync(fd, JSON.stringify(parsed) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.ensureSafe(false);
      fs.renameSync(temp, this.filePath);
      created = false;
      return true;
    } finally { if (created && fs.existsSync(temp) && fs.lstatSync(temp).isFile() && !fs.lstatSync(temp).isSymbolicLink()) fs.unlinkSync(temp); }
  }

}
/** Concrete SQL adapter for the common lifecycle machine. Construction is deferred until grant checks pass. */
export class ZetarisUslLifecycleAdapter implements UslLifecycleExecutionAdapter {
  readonly adapterId = 'zetaris-usl-plan-scoped-v1';
  readonly executionMode = 'LIVE' as const;
  readonly dataOrigin: 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN';
  private lastOperationResult?: { planFingerprint: string; operationId: string; rows: readonly (readonly unknown[])[] };
  private readonly auditReads: UslLifecycleAuditRead[] = [];
  private readonly pointer: FileUslClientPointerStore;
  private readonly readers: ZetarisLifecycleReaders;
  constructor(
    private readonly plan: UslLifecyclePlan,
    private readonly grant: PublicationSqlGrant,
    private readonly client: ZetarisLifecycleClient,
    readers: ZetarisLifecycleReaders,
    runId: string,
    projectRoot = ROOT,
    private readonly approvedBindingDocument?: Json2LiveBindingDocument,
    private readonly publicationInput?: PublicationPlanInput
  ) {
    this.dataOrigin = ['SYNTHETIC', 'PUBLIC', 'USER', 'UNKNOWN'].includes(plan.dataOrigin) ? plan.dataOrigin as ZetarisUslLifecycleAdapter['dataOrigin'] : 'UNKNOWN';
    if (!/^[-A-Za-z0-9._]{1,64}$/.test(runId)) throw new TypeError('USL_POINTER_RUN_ID_INVALID');
    this.pointer = new FileUslClientPointerStore(plan.target.namespace, projectRoot);
    this.readers = readers;
  }
  private recordRead(operationId: string, sql: string | undefined, result: { requestId?: string; queryId?: string }): void {
    if (!sql) return;
    this.auditReads.push({ operationId, sql, requestId: result.requestId ?? 'UNKNOWN', queryId: result.queryId ?? 'UNKNOWN', status: result.requestId && result.queryId ? 'OK' : 'UNKNOWN' });
  }
  drainAuditReads(): UslLifecycleAuditRead[] { return this.auditReads.splice(0); }
  async readSnapshot(): Promise<UslSimulationSnapshot> {
    const target = this.readers.readTargetSnapshot ? await this.readers.readTargetSnapshot() : await this.readCatalogTargetSnapshot();
    return { ...target, localClientPointer: this.pointer.read() };
  }
  async recheckInputs(plan: UslLifecyclePlan) { return this.readers.recheckInputs ? this.readers.recheckInputs(plan) : this.recheckApprovedSources(plan); }
  private async readCatalogTargetSnapshot(): Promise<Omit<UslSimulationSnapshot, 'localClientPointer'>> {
    const namespace = this.plan.target.namespace;
    const separator = namespace.lastIndexOf('.');
    const parent = namespace.slice(0, separator), name = namespace.slice(separator + 1);
    if (parent !== 'lightning.metastore' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new SafeError('USL_TARGET_NAMESPACE_OUTSIDE_APPROVED_CATALOG');
    const parentSql = `SHOW NAMESPACES OR TABLES IN ${parent}`;
    const parentResult = await this.client.runSql(parentSql, 50, { trace: false });
    this.recordRead('preflight_parent_namespace_catalog', parentSql, parentResult);
    requireCompleteRead(parentResult, 50, 'USL_PARENT_CATALOG_INCOMPLETE', true);
    const parentEntries = parseNamespaceCatalogRows(parentResult.rows);
    if (!parentEntries.some(entry => entry.kind === 'namespace' && entry.name === name)) {
      const targetStateFingerprint = stableHash({ parent, parentEntries, namespace, childEntries: [], namespaceState: 'ABSENT', receipts: [] });
      return { targetStateFingerprint, observedAt: new Date().toISOString(), namespaceState: 'ABSENT', namespaceOwnerFingerprint: null, activeVersionRef: this.pointer.read(), versions: [] };
    }
    const childSql = `SHOW NAMESPACES OR TABLES IN ${namespace}`;
    const childResult = await this.client.runSql(childSql, 50, { trace: false });
    this.recordRead('preflight_target_namespace_catalog', childSql, childResult);
    requireCompleteRead(childResult, 50, 'USL_CHILD_CATALOG_INCOMPLETE', true);
    const childEntries = parseNamespaceCatalogRows(childResult.rows);
    const events = readNamespacePublicationEvents(namespace, this.pointer.root).filter(event => event.adapterId === this.adapterId && event.lifecyclePlanSnapshot && ['prepared', 'applied', 'verified', 'failed'].includes(event.state));
    const validReceipt = (event: typeof events[number]): event is typeof event & { lifecyclePlanSnapshot: UslLifecyclePlan } => isUslLifecyclePlanFingerprintValid(event.lifecyclePlanSnapshot) && event.lifecyclePlanSnapshot.fingerprint === event.fingerprint && event.lifecyclePlanSnapshot.target.namespace === namespace;
    const verifiedByVersion = new Map<string, typeof events[number]>(), activatedByVersion = new Map<string, typeof events[number]>();
    const namespaceCreationReceipts = events.filter(event => event.state === 'applied' && event.operationId === 'create_target_namespace' && event.operationStatus === 'OK' && validReceipt(event));
    for (const event of events) {
      if (!validReceipt(event) || !event.versionId) continue;
      if (`${event.lifecyclePlanSnapshot!.target.namespace}.${event.lifecyclePlanSnapshot!.target.model}` !== event.versionId) continue;
      if (event.state === 'verified') verifiedByVersion.set(event.versionId, event);
      if (event.state === 'applied' && event.operationId === 'activate_observed_relation' && event.operationStatus === 'OK') activatedByVersion.set(event.versionId, event);
    }
    // Names and prepared events do not establish ownership. A version can be
    // exposed provisionally only after a confirmed activation; verification is
    // recorded separately once LOAD and bounded SELECT both pass.
    const ownedByVersion = new Map([...activatedByVersion, ...verifiedByVersion]);
    const catalogObjects = childEntries.filter(entry => entry.kind !== 'namespace');
    const unownedCatalogObject = catalogObjects.some(entry => entry.kind !== 'usl' || !ownedByVersion.has(`${namespace}.${entry.name}`));
    const versions = catalogObjects.flatMap(entry => {
      if (entry.kind !== 'usl') return [];
      const versionId = `${namespace}.${entry.name}`, receipt = ownedByVersion.get(versionId);
      return receipt?.contentFingerprint ? [{ versionId, planFingerprint: receipt.fingerprint, contentFingerprint: receipt.contentFingerprint, servable: true }] : [];
    });
    const hasOwnershipReceipt = namespaceCreationReceipts.length > 0 || verifiedByVersion.size > 0;
    const namespaceState = !unownedCatalogObject && hasOwnershipReceipt && versions.length === catalogObjects.length
      ? 'OWNED' as const : 'FOREIGN' as const;
    const owner = [...verifiedByVersion.values(), ...namespaceCreationReceipts].sort((a, b) => a.at.localeCompare(b.at, 'en')).at(-1);
    const pointer = this.pointer.read();
    const latestActivation = events.filter(event => event.state === 'applied' && event.operationId === 'activate_observed_relation' && event.operationStatus === 'OK').at(-1);
    const activeVersionRef = latestActivation?.versionId ?? pointer;
    const targetStateFingerprint = stableHash({ parent, parentEntries, namespace, childEntries, receipts: [...ownedByVersion.values(), ...namespaceCreationReceipts].map(event => event.fingerprint).sort(), pointer, namespaceState });
    return { targetStateFingerprint, observedAt: new Date().toISOString(), namespaceState, namespaceOwnerFingerprint: owner?.fingerprint ?? null,
      activeVersionRef, versions };
  }
  private async recheckApprovedSources(plan: UslLifecyclePlan): Promise<{ status: 'CURRENT' | 'STALE'; staleInputs?: string[] }> {
    const binding = this.approvedBindingDocument, input = this.publicationInput;
    if (!binding || validateJson2LiveBinding(binding).length) return { status: 'STALE', staleInputs: ['approved_json2_binding_missing_or_invalid'] };
    if (!input || input.contract.id !== plan.relationRef || input.contract.contractVersion !== plan.contractVersion || input.decision.decisionId !== plan.decisionRef) return { status: 'STALE', staleInputs: ['sealed_publication_evidence_missing_or_mismatched'] };
    const requiredRefs = new Set(plan.sourceBinding.mappingRefs);
    const selected = binding.tables.filter(table => requiredRefs.has(`${table.sourceId}:${table.logicalObjectId}`));
    if (selected.length !== requiredRefs.size) return { status: 'STALE', staleInputs: ['source_binding_mapping_missing'] };
    try {
      const subset = { ...binding, tables: selected }, adapter = new ZetarisJson2ProbeAdapter(subset, this.client);
      const schemaCheck = await adapter.verifyAllTables();
      for (const table of schemaCheck.tables as any[]) {
        this.recordRead(`source_describe:${table.sourceId}:${table.logicalObjectId}`, table.describeStatement, { requestId: table.describeRequestId, queryId: table.describeQueryId });
        this.recordRead(`source_snapshot:${table.sourceId}:${table.logicalObjectId}`, table.selectStatement, { requestId: table.selectRequestId, queryId: table.selectQueryId });
      }
      if (schemaCheck.status !== 'COMPLETE') return { status: 'STALE', staleInputs: ['source_schema_or_typed_multiset_changed'] };
      const expectedBundles = input.evidence.filter(bundle => input.decision.evidenceBundleRefs.includes(bundle.evidenceBundleId) && bundle.relationRef === input.contract.id && bundle.contractVersion === input.contract.contractVersion && bundle.completeness === 'COMPLETE_FOR_SCOPE');
      const expectedForEndpoint = (endpoint: typeof input.contract.from) => {
        const matches = expectedBundles.flatMap(bundle => bundle.observations.filter(observation => observation.type === 'KEY_MEMBERSHIP' && observation.sourceRef === endpoint.sourceId && observation.transportStatus === 'OK' && observation.truncated === false && JSON.stringify(observation.projection) === JSON.stringify(endpoint.orderedColumns)));
        return matches.length === 1 && matches[0].filters.length === 0 ? matches[0] : undefined;
      };
      const expectedFrom = expectedForEndpoint(input.contract.from), expectedTo = expectedForEndpoint(input.contract.to);
      if (!expectedFrom || !expectedTo || ![expectedFrom, expectedTo].every(observation => observation.measuredTuples.every(tuple => Array.isArray(tuple) && tuple.length > 0 && tuple.every(value => typeof value === 'string')))) return { status: 'STALE', staleInputs: ['sealed_key_projection_unavailable'] };
      const allowlist: Record<string, string[]> = {};
      for (const endpoint of [input.contract.from, input.contract.to]) {
        const table = selected.find(item => item.sourceId === endpoint.sourceId && item.logicalObjectId === endpoint.objectId);
        if (!table) return { status: 'STALE', staleInputs: ['source_binding_mapping_missing'] };
        allowlist[endpoint.objectId] = table.columns.map(column => column.name);
      }
      const limit = expectedFrom.limit;
      if (typeof limit !== 'number' || limit < 1 || limit > 50 || expectedTo.limit !== limit) return { status: 'STALE', staleInputs: ['sealed_key_projection_scope_mismatch'] };
      const probePlan = planProbe(input.contract, allowlist, limit, Math.min(50, binding.readLimit));
      const fresh = await executeProbe(probePlan, adapter, { runId: `preflight:${plan.fingerprint}`, checkedAt: new Date().toISOString(), scope: 'exact lifecycle source projection recheck', executionMode: 'LIVE', dataOrigin: plan.dataOrigin as 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN' });
      for (const read of fresh.reads) this.recordRead(`source_key_projection:${read.sourceId}:${read.objectId}`, read.statement, { requestId: read.requestId, queryId: read.queryId });
      const freshFrom = fresh.bundle.observations.find(observation => observation.type === 'KEY_MEMBERSHIP' && observation.sourceRef === input.contract.from.sourceId);
      const freshTo = fresh.bundle.observations.find(observation => observation.type === 'KEY_MEMBERSHIP' && observation.sourceRef === input.contract.to.sourceId);
      if (fresh.status !== 'COMPLETE' || !freshFrom || !freshTo || !sourceKeyProjectionMatches(expectedFrom, freshFrom) || !sourceKeyProjectionMatches(expectedTo, freshTo)) return { status: 'STALE', staleInputs: ['source_key_projection_changed_or_incomplete'] };
      return { status: 'CURRENT' };
    } catch { return { status: 'STALE', staleInputs: ['source_preflight_failed'] }; }
  }
  async runOperation(operation: UslLifecycleOperation, plan: UslLifecyclePlan): Promise<UslSimulationOperationResult> {
    const req = (): PublicationSqlOperation => ({ operationId: operation.operationId, objectRef: operation.objectRef, sql: operation.sql!, sqlSha256: operation.sqlSha256! });
    if (!operation.sql || !operation.sqlSha256) return { status: 'ERROR', requestId: 'NOT_SENT', queryId: 'NOT_SENT', diagnostic: 'LIFECYCLE_SQL_MISSING' };
    const bindings = (this.grant as { operationBindings?: { operationId: string; sqlSha256: string }[] }).operationBindings;
    if ((operation.role === 'DDL' || operation.role === 'ACTIVATION') && Array.isArray(bindings) && !bindings.some(item => item.operationId === operation.operationId && item.sqlSha256 === operation.sqlSha256)) return { status: 'ERROR', requestId: 'NOT_SENT', queryId: 'NOT_SENT', diagnostic: 'GRANT_OPERATION_BINDING_MISMATCH' };
    try {
      const result = operation.role === 'DDL' || operation.role === 'ACTIVATION'
        ? await this.client.runAuthorizedPublicationSql(req(), this.grant, plan)
        : await this.client.runSql(operation.sql, operation.operationId === 'verify_observed_relation_sample' ? 50 : 1, { trace: false });
      if (operation.operationId === 'load_model_for_definition_check' || operation.operationId === 'verify_observed_relation_sample') requireCompleteRead(result, operation.operationId === 'verify_observed_relation_sample' ? 50 : 1, 'USL_VERIFICATION_READ_INCOMPLETE');
      if (operation.operationId === 'load_model_for_definition_check' || operation.operationId === 'verify_observed_relation_sample') this.lastOperationResult = { planFingerprint: plan.fingerprint, operationId: operation.operationId, rows: result.rows };
      return { status: 'OK', requestId: result.requestId, queryId: result.queryId };
    } catch (error) { return { status: 'UNKNOWN', requestId: 'UNKNOWN', queryId: 'UNKNOWN', diagnostic: error instanceof Error ? error.name : 'SQL_OPERATION_UNKNOWN' }; }
  }
  async readLoadedModel(plan: UslLifecyclePlan): Promise<unknown> {
    const cached = this.consumeOperationRows(plan, 'load_model_for_definition_check');
    if (cached) return (this.readers.decodeLoadedModel ?? decodeLoadedUslModelRows)(cached, plan);
    const operation = plan.operations.find(item => item.operationId === 'load_model_for_definition_check');
    if (!operation?.sql) return null;
    const result = await this.client.runSql(operation.sql, 1, { trace: false });
    requireCompleteRead(result, 1, 'USL_LOAD_READ_INCOMPLETE');
    return (this.readers.decodeLoadedModel ?? decodeLoadedUslModelRows)(result.rows, plan);
  }
  async readObservedRows(plan: UslLifecyclePlan): Promise<readonly (readonly unknown[])[]> {
    const cached = this.consumeOperationRows(plan, 'verify_observed_relation_sample');
    if (cached) return cached;
    const operation = plan.operations.find(item => item.operationId === 'verify_observed_relation_sample');
    if (!operation?.sql) return [];
    const result = await this.client.runSql(operation.sql, 50, { trace: false });
    requireCompleteRead(result, 50, 'USL_OUTPUT_READ_INCOMPLETE');
    return result.rows;
  }
  private consumeOperationRows(plan: UslLifecyclePlan, operationId: string): readonly (readonly unknown[])[] | undefined {
    if (this.lastOperationResult?.planFingerprint !== plan.fingerprint || this.lastOperationResult.operationId !== operationId) { this.lastOperationResult = undefined; return undefined; }
    const rows = this.lastOperationResult.rows;
    this.lastOperationResult = undefined;
    return rows;
  }
  async setLocalClientPointer(expectedCurrent: string | null, next: string | null): Promise<boolean> {
    return this.pointer.compareAndSet(expectedCurrent, next);
  }
}
