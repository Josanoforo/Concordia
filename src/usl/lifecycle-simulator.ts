import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { failure, ROOT } from '../runtime.ts';
import type { PublicationManifest, PublicationPlanInput } from './publication-plan.ts';
import { lintUslLifecyclePlan } from './ddl-lint.ts';
import { checkPublicationPlanPreconditions } from './publication-plan.ts';
import { readNamespacePublicationEvents, type LockedPublicationJournal, type PublicationBaselineVersion, type PublicationJournalEvent, type PublicationJournalStore } from './publication-executor.ts';
import { checkUslLifecyclePlan, verifyLoadedUslModel, verifyObservedRelationRows, isUslLifecyclePlanFingerprintValid, type PublicationSourceBinding, type UslLifecycleOperation, type UslLifecyclePlan, verifyPublicationSourceBindingBytes, uslOperationBindings, uslPlanSqlIntegrityIssue } from './lifecycle-plan.ts';

export interface UslSimulationGrant {
  schemaVersion: 1;
  grantId: string;
  scope: 'LOCAL_SYNTHETIC_SIMULATION';
  planFingerprint: string;
  targetRef: string;
  sourceBindingSha256: string;
  sourceBindingFingerprint: string;
  operationSqlSha256s: string[];
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}
export interface UslSimulationVersion extends PublicationBaselineVersion { servable: boolean; }
export interface UslLifecycleAuditRead { operationId: string; sql: string; requestId: string; queryId: string; status: 'OK' | 'ERROR' | 'UNKNOWN'; }
export interface UslSimulationSnapshot {
  targetStateFingerprint: string;
  observedAt: string;
  namespaceState: 'ABSENT' | 'OWNED' | 'FOREIGN';
  namespaceOwnerFingerprint: string | null;
  activeVersionRef: string | null;
  localClientPointer: string | null;
  versions: UslSimulationVersion[];
}
export interface UslSimulationOperationResult { status: 'OK' | 'ERROR' | 'UNKNOWN'; requestId: string; queryId: string; diagnostic?: string; }
export interface UslLifecycleExecutionAdapter {
  readonly adapterId: string;
  readonly executionMode: 'LOCAL' | 'LIVE';
  readonly dataOrigin: 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN';
  readSnapshot(): Promise<UslSimulationSnapshot>;
  runOperation(operation: UslLifecycleOperation, plan: UslLifecyclePlan): Promise<UslSimulationOperationResult>;
  readLoadedModel(plan: UslLifecyclePlan): Promise<unknown>;
  readObservedRows(plan: UslLifecyclePlan): Promise<readonly (readonly unknown[])[]>;
  recheckInputs?(plan: UslLifecyclePlan): Promise<{ status: 'CURRENT' | 'STALE'; staleInputs?: string[] }>;
  drainAuditReads?(): UslLifecycleAuditRead[];
  setLocalClientPointer(expectedCurrent: string | null, next: string | null): Promise<boolean>;
}
/** Offline fake adapter retained as the compatibility surface for LOCAL rehearsal. */
export interface UslLifecycleSimulationAdapter extends UslLifecycleExecutionAdapter {
  readonly executionMode: 'LOCAL';
  readonly dataOrigin: 'SYNTHETIC';
}
export interface UslLiveExecutionGrant {
  schemaVersion: 1; grantId: string; scope: 'LIVE_USL_PUBLICATION'; planFingerprint: string; targetRef: string;
  sourceBindingSha256: string; sourceBindingFingerprint: string; operationSqlSha256s: string[]; approvedBy: string; approvedAt: string; expiresAt: string;
  dialectId: string; dialectEvidenceSha256: string;
  /** Which statement each hash belongs to (R6-Z1): approval is bound to operationId + SQL hash, not just to a list of hashes. */
  operationBindings: { operationId: string; sqlSha256: string }[];
}
export interface UslBackendDialectEvidence { schemaVersion: 1; status: 'CONFIRMED'; dialectId: string; backendEngineVersion: string; supportedOperationIds: string[]; reviewedBy: string; reviewedAt: string; }
export type UslSimulationResult =
  | { status: 'VERIFIED' | 'REUSED'; passed: true; fingerprint: string; versionRef: string; liveSqlExecuted: boolean }
  | { status: 'RECOVERED'; passed: true; fingerprint: string; versionRef: string; liveSqlExecuted: boolean }
  | { status: 'RECOVERED' | 'REJECTED' | 'FAILED'; passed: false; fingerprint: string; reason: string; liveSqlExecuted: boolean };

const canon = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en')));
});
const hash = (value: unknown) => createHash('sha256').update(canon(value)).digest('hex');
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const targetRef = (plan: UslLifecyclePlan) => `${plan.target.namespace}.${plan.target.model}`;
export const simulationContentFingerprint = (plan: UslLifecyclePlan) => hash({ lifecyclePlan: plan.fingerprint, projection: plan.expectedProjection });
const baseline = (snapshot: UslSimulationSnapshot): PublicationBaselineVersion[] => snapshot.versions.map(({ versionId, planFingerprint, contentFingerprint }) => ({ versionId, planFingerprint, contentFingerprint })).sort((a, b) => a.versionId.localeCompare(b.versionId, 'en'));
const baselineFingerprint = (versions: readonly PublicationBaselineVersion[]) => hash(versions);

function grantIssue(grant: UslSimulationGrant, plan: UslLifecyclePlan, binding: PublicationSourceBinding, now: number): string | null {
  const expectedOperations = plan.operations.flatMap(operation => operation.sqlSha256 ? [operation.sqlSha256] : []);
  if (!grant || grant.schemaVersion !== 1 || grant.scope !== 'LOCAL_SYNTHETIC_SIMULATION' || typeof grant.grantId !== 'string' || !grant.grantId ||
      typeof grant.approvedBy !== 'string' || !grant.approvedBy || !fingerprint(grant.planFingerprint) || grant.planFingerprint !== plan.fingerprint ||
      grant.targetRef !== targetRef(plan) || grant.sourceBindingSha256 !== binding.bindingSha256 || grant.sourceBindingFingerprint !== plan.inputFingerprints.binding ||
      !Array.isArray(grant.operationSqlSha256s) || JSON.stringify(grant.operationSqlSha256s) !== JSON.stringify(expectedOperations) ||
      typeof grant.approvedAt !== 'string' || Number.isNaN(Date.parse(grant.approvedAt)) || Date.parse(grant.approvedAt) > now || typeof grant.expiresAt !== 'string' || Number.isNaN(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now || Date.parse(grant.expiresAt) <= Date.parse(grant.approvedAt)) return 'EXACT_LOCAL_SYNTHETIC_GRANT_REQUIRED';
  return null;
}
export function validateUslLiveExecutionRequest(
  plan: UslLifecyclePlan, publicationManifest: PublicationManifest, input: PublicationPlanInput, binding: PublicationSourceBinding,
  rawBindingBytes: Uint8Array, grant: UslLiveExecutionGrant, dialectBytes: Uint8Array, now = Date.now()
): string | null {
  if (!isUslLifecyclePlanFingerprintValid(plan) || plan.status !== 'PREPARED') return 'PREPARED_LIFECYCLE_PLAN_REQUIRED';
  const current = checkUslLifecyclePlan(plan, publicationManifest, input, binding);
  if (current.status !== 'CURRENT' || checkPublicationPlanPreconditions(publicationManifest, input).status !== 'CURRENT') return 'STALE_LIVE_PUBLICATION_INPUTS';
  const bindingCheck = verifyPublicationSourceBindingBytes(rawBindingBytes, binding);
  if (bindingCheck.status !== 'VERIFIED' || bindingCheck.sha256 !== plan.sourceBinding.bindingSha256 || binding.bindingSha256 !== plan.sourceBinding.bindingSha256 ||
      hash(binding) !== plan.inputFingerprints.binding) return 'SEALED_SOURCE_BINDING_BYTES_REQUIRED';
  let dialect: UslBackendDialectEvidence;
  try { dialect = JSON.parse(Buffer.from(dialectBytes).toString('utf8')) as UslBackendDialectEvidence; }
  catch { return 'BACKEND_DIALECT_EVIDENCE_INVALID'; }
  const dialectHash = createHash('sha256').update(dialectBytes).digest('hex');
  const requiredOperationIds = plan.operations.filter(operation => operation.sql).map(operation => operation.operationId);
  if (!dialect || dialect.schemaVersion !== 1 || dialect.status !== 'CONFIRMED' || !dialect.dialectId || dialect.dialectId !== grant?.dialectId ||
      !dialect.backendEngineVersion || !Array.isArray(dialect.supportedOperationIds) || requiredOperationIds.some(id => !dialect.supportedOperationIds.includes(id)) ||
      !dialect.reviewedBy || Number.isNaN(Date.parse(dialect.reviewedAt)) || dialectHash !== grant?.dialectEvidenceSha256) return 'BACKEND_DIALECT_EVIDENCE_INVALID';
  const integrity = uslPlanSqlIntegrityIssue(plan);
  if (integrity) return integrity;
  if (lintUslLifecyclePlan(plan).status === 'FAIL') return 'DDL_LINT_FAILED';
  const expectedOperations = plan.operations.flatMap(operation => operation.sqlSha256 ? [operation.sqlSha256] : []);
  if (!grant || grant.schemaVersion !== 1 || grant.scope !== 'LIVE_USL_PUBLICATION' || JSON.stringify(grant.operationBindings) !== JSON.stringify(uslOperationBindings(plan)) || typeof grant.grantId !== 'string' || !grant.grantId ||
      grant.planFingerprint !== plan.fingerprint || grant.targetRef !== targetRef(plan) || grant.sourceBindingSha256 !== bindingCheck.sha256 ||
      grant.sourceBindingFingerprint !== plan.inputFingerprints.binding || !Array.isArray(grant.operationSqlSha256s) || JSON.stringify(grant.operationSqlSha256s) !== JSON.stringify(expectedOperations) ||
      typeof grant.approvedBy !== 'string' || !grant.approvedBy.trim() || Number.isNaN(Date.parse(grant.approvedAt)) || Date.parse(grant.approvedAt) > now ||
      Number.isNaN(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now || Date.parse(grant.expiresAt) <= Date.parse(grant.approvedAt)) return 'EXACT_LIVE_PUBLICATION_GRANT_REQUIRED';
  return null;
}

function journalEvent(locked: LockedPublicationJournal, plan: UslLifecyclePlan, adapter: UslLifecycleExecutionAdapter, runId: string, state: PublicationJournalEvent['state'], extra: Partial<PublicationJournalEvent> = {}): PublicationJournalEvent {
  const prior = locked.readEvents().filter(event => event.fingerprint === plan.fingerprint).at(-1);
  const sequence = (prior?.sequence ?? 0) + 1;
  const event: PublicationJournalEvent = {
    schemaVersion: 1, eventId: `${plan.fingerprint}:${sequence}:${state}`, sequence, runId, state,
    manifestId: `publication:${plan.fingerprint.slice(0, 24)}`, fingerprint: plan.fingerprint, idempotencyToken: plan.fingerprint,
    universeId: plan.universeId, targetKey: targetRef(plan), sourceExecutionMode: plan.executionMode, adapterId: adapter.adapterId, executionMode: adapter.executionMode, dataOrigin: adapter.dataOrigin, at: new Date().toISOString(), ...extra
  };
  locked.append(event);
  return event;
}
function verifiedEvents(events: readonly PublicationJournalEvent[], namespace: string): PublicationJournalEvent[] {
  return events.filter(event => event.state === 'verified' && event.targetKey.startsWith(namespace + '.') && event.versionId);
}
async function withTargetLock<T>(journal: PublicationJournalStore, target: string, work: () => Promise<T>): Promise<T> {
  if (typeof journal.withTargetLock !== 'function') throw new Error('PUBLICATION_TARGET_LOCK_REQUIRED');
  return journal.withTargetLock(target, work);
}
type ReadOperationLogger = (operation: UslLifecycleOperation, result: UslSimulationOperationResult, plan: UslLifecyclePlan) => void;
async function verifyExisting(plan: UslLifecyclePlan, adapter: UslLifecycleExecutionAdapter, logRead?: ReadOperationLogger): Promise<boolean> {
  const load = plan.operations.find(operation => operation.operationId === 'load_model_for_definition_check');
  if (!load) return false;
  let outcome: UslSimulationOperationResult;
  try { outcome = await adapter.runOperation(load, plan); } catch { outcome = { status: 'UNKNOWN', requestId: 'UNKNOWN', queryId: 'UNKNOWN' }; }
  logRead?.(load, outcome, plan);
  if (outcome.status !== 'OK') return false;
  const loaded = await adapter.readLoadedModel(plan);
  if (verifyLoadedUslModel(plan, loaded).status !== 'PASS') return false;
  const sample = plan.operations.find(operation => operation.operationId === 'verify_observed_relation_sample');
  if (!sample) return false;
  try { outcome = await adapter.runOperation(sample, plan); } catch { outcome = { status: 'UNKNOWN', requestId: 'UNKNOWN', queryId: 'UNKNOWN' }; }
  logRead?.(sample, outcome, plan);
  if (outcome.status !== 'OK') return false;
  const rows = await adapter.readObservedRows(plan);
  return verifyObservedRelationRows(plan, rows).status === 'PASS';
}
/** Exported for tests. A journal failure while logging a read is never reported as an unverifiable prior version (N70). */
export async function verifyPriorVersion(events: readonly PublicationJournalEvent[], versionRef: string, adapter: UslLifecycleExecutionAdapter, logRead?: ReadOperationLogger): Promise<{ plan: UslLifecyclePlan; contentFingerprint: string } | undefined> {
  const receipt = events.filter(event => event.state === 'verified' && event.versionId === versionRef && event.targetKey === versionRef && event.adapterId === adapter.adapterId).at(-1);
  if (!receipt?.contentFingerprint || !receipt.lifecyclePlanSnapshot) return undefined;
  const plan = receipt.lifecyclePlanSnapshot as unknown as UslLifecyclePlan;
  if (!isUslLifecyclePlanFingerprintValid(plan) || plan.fingerprint !== receipt.fingerprint || targetRef(plan) !== versionRef) return undefined;
  // The read log is a journal write: its failure must surface (as JournalWriteError), not look like an unverifiable prior version.
  const journaledRead: ReadOperationLogger | undefined = logRead && ((operation, outcome, readPlan) => {
    try { logRead(operation, outcome, readPlan); } catch (error) { throw error instanceof JournalWriteError ? error : new JournalWriteError(failure(error).code); }
  });
  try {
    if (!await verifyExisting(plan, adapter, journaledRead)) return undefined;
  } catch (error) { if (error instanceof JournalWriteError) throw error; return undefined; }
  return { plan, contentFingerprint: receipt.contentFingerprint };
}

/** A journal append that failed; the code is the sanitized one from `failure`. Thrown by the post-SQL append wrapper and never swallowed by the inner catches. */
class JournalWriteError extends Error { constructor(readonly code: string) { super(`JOURNAL_WRITE_FAILED:${code}`); this.name = 'JournalWriteError'; } }

/** Runs the lifecycle state machine only against an injected LOCAL+SYNTHETIC adapter. It never constructs a network client. */
async function executeUslLifecycleCore(
  plan: UslLifecyclePlan, publicationManifest: PublicationManifest, input: PublicationPlanInput, binding: PublicationSourceBinding,
  grant: UslSimulationGrant | UslLiveExecutionGrant, adapter: UslLifecycleExecutionAdapter, journal: PublicationJournalStore,
  runId: string, now = Date.now(), mode: 'APPLY' | 'REUSE' = 'APPLY', rawBindingBytes?: Uint8Array, dialectBytes?: Uint8Array
): Promise<UslSimulationResult> {
  let liveSqlExecuted = false;
  const rejected = (reason: string): UslSimulationResult => ({ status: 'REJECTED', passed: false, fingerprint: plan?.fingerprint ?? '', reason, liveSqlExecuted });
  if (!adapter || !['LOCAL', 'LIVE'].includes(adapter.executionMode) || typeof adapter.dataOrigin !== 'string' || !adapter.dataOrigin || typeof adapter.readSnapshot !== 'function' || typeof adapter.runOperation !== 'function' || typeof adapter.readLoadedModel !== 'function' || typeof adapter.readObservedRows !== 'function' || typeof adapter.setLocalClientPointer !== 'function') return rejected('LOCAL_SYNTHETIC_ADAPTER_REQUIRED');
  if (!plan || plan.status !== 'PREPARED' || plan.executable !== false || !fingerprint(plan.fingerprint)) return rejected('PREPARED_LIFECYCLE_PLAN_REQUIRED');
  const preconditions = checkUslLifecyclePlan(plan, publicationManifest, input, binding);
  if (preconditions.status !== 'CURRENT' || checkPublicationPlanPreconditions(publicationManifest, input).status !== 'CURRENT') return rejected(`STALE_INPUTS:${preconditions.staleInputs.join(',')}`);
  const authorizationIssue = adapter.executionMode === 'LOCAL' && adapter.dataOrigin === 'SYNTHETIC'
    ? grantIssue(grant as UslSimulationGrant, plan, binding, now)
    : (!rawBindingBytes || !dialectBytes || !publicationManifest || !input ? 'LIVE_BINDING_AND_DIALECT_EVIDENCE_REQUIRED' : validateUslLiveExecutionRequest(plan, publicationManifest, input, binding, rawBindingBytes, grant as UslLiveExecutionGrant, dialectBytes, now));
  if (authorizationIssue) return rejected(authorizationIssue);
  if (!/^[-A-Za-z0-9._]{1,64}$/.test(runId)) return rejected('SIMULATION_RUN_ID_INVALID');
  const expectedTargetFingerprint = plan.inputFingerprints.targetState;
  if (!expectedTargetFingerprint) return rejected('TARGET_STATE_SNAPSHOT_REQUIRED');

  return withTargetLock(journal, plan.target.namespace, () => journal.withExclusiveLock(async locked => {
    // The namespace lock makes this aggregate a coherent ownership/recovery view across run journals.
    const journalRoot = (journal as PublicationJournalStore & { projectRoot?: string }).projectRoot ?? ROOT;
    const flushAuditReads = () => {
      for (const read of adapter.drainAuditReads?.() ?? []) {
        const operationSha256 = createHash('sha256').update(read.sql, 'utf8').digest('hex');
        journalEvent(locked, plan, adapter, runId, 'read', { versionId: targetRef(plan), operationId: read.operationId, operationSha256,
          requestId: read.requestId, queryId: read.queryId, operationStatus: read.status, lifecyclePlanSnapshot: plan });
      }
    };
    const readSnapshot = async () => { try { return await adapter.readSnapshot(); } finally { flushAuditReads(); } };
    const recheckInputs = async () => { try { return await adapter.recheckInputs!(plan); } finally { flushAuditReads(); } };
    const readLifecycleEvents = () => {
      const combined = [...readNamespacePublicationEvents(plan.target.namespace, journalRoot), ...locked.readEvents()];
      const seen = new Set<string>();
      return combined.filter(event => {
        const key = event.runId + ':' + event.eventId;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    let snapshot: UslSimulationSnapshot;
    try { snapshot = await readSnapshot(); } catch (error) { return rejected(`SIMULATED_TARGET_PREFLIGHT_FAILED:${failure(error).code}`); }
    if (!snapshot || !fingerprint(snapshot.targetStateFingerprint) || !Array.isArray(snapshot.versions)) return rejected('SIMULATED_TARGET_STATE_STALE');
    if (adapter.recheckInputs) {
      try { const check = await recheckInputs(); if (check.status !== 'CURRENT') return rejected(`STALE_SOURCE_INPUTS:${(check.staleInputs ?? []).join(',')}`); }
      catch (error) { return rejected(`SOURCE_RECHECK_FAILED:${failure(error).code}`); }
    }
    const events = readLifecycleEvents(), own = events.filter(event => event.fingerprint === plan.fingerprint);
    if (own.some(event => event.adapterId !== adapter.adapterId || event.targetKey !== targetRef(plan) || event.universeId !== plan.universeId)) return rejected('SIMULATION_JOURNAL_IDENTITY_COLLISION');
    const active = snapshot.versions.find(version => version.versionId === snapshot.localClientPointer && version.servable);
    const previousRef = snapshot.localClientPointer;
    const expectedContentFingerprint = simulationContentFingerprint(plan);
    const versionRef = targetRef(plan);
    let sqlStarted = false, pointerMoved = false;
    const append = (state: PublicationJournalEvent['state'], extra: Partial<PublicationJournalEvent> = {}) => { try { return appendRaw(state, extra); } catch (error) { throw new JournalWriteError(failure(error).code); } };
    const appendRaw = (state: PublicationJournalEvent['state'], extra: Partial<PublicationJournalEvent> = {}) => journalEvent(locked, plan, adapter, runId, state, { targetStateFingerprint: snapshot.targetStateFingerprint, ...(state === 'planned' ? {} : { versionId: versionRef, contentFingerprint: expectedContentFingerprint, previousVersionId: previousRef }), ...extra });
    const logRead: ReadOperationLogger = (operation, outcome, manifestPlan) => append('read', { versionId: `${manifestPlan.target.namespace}.${manifestPlan.target.model}`, operationId: operation.operationId, operationSha256: operation.sqlSha256 ?? undefined, requestId: outcome.requestId, queryId: outcome.queryId, operationStatus: outcome.status, lifecyclePlanSnapshot: manifestPlan });

    try {
    const ownTransitions = own.filter(event => event.state !== 'read');
    if (ownTransitions.at(-1)?.state === 'verified') {
      const verified = ownTransitions.at(-1)!;
      const baselineCurrent = Array.isArray(verified.baselineVersions) && JSON.stringify(baseline(snapshot)) === JSON.stringify(verified.baselineVersions);
      const ownershipCurrent = snapshot.namespaceState === 'OWNED' && verifiedEvents(events, plan.target.namespace).some(event => event.adapterId === adapter.adapterId && event.fingerprint === snapshot.namespaceOwnerFingerprint);
      if (!baselineCurrent || !ownershipCurrent || snapshot.activeVersionRef !== versionRef || snapshot.localClientPointer !== versionRef || !snapshot.versions.some(version => version.versionId === versionRef && version.planFingerprint === plan.fingerprint && version.contentFingerprint === expectedContentFingerprint && version.servable) || !await verifyExisting(plan, adapter, logRead)) return { status: 'FAILED', passed: false, fingerprint: plan.fingerprint, reason: 'VERIFIED_SIMULATION_CONTENT_CHANGED', liveSqlExecuted };
      append('verified', { versionId: versionRef, contentFingerprint: expectedContentFingerprint, previousVersionId: previousRef, baselineVersions: baseline(snapshot), baselineVersionsFingerprint: baselineFingerprint(baseline(snapshot)), lifecyclePlanSnapshot: plan });
      return { status: 'REUSED', passed: true, fingerprint: plan.fingerprint, versionRef, liveSqlExecuted };
    }
    if (mode === 'REUSE') return rejected('NO_VERIFIED_PLAN_TO_REUSE');
    // A prepared (or applied) journal with no terminal event means a prior run died after it may have sent SQL: never replay blindly.
    if (['prepared', 'applied'].includes(ownTransitions.at(-1)?.state ?? '')) return rejected('INTERRUPTED_PRIOR_RUN');
    if (snapshot.targetStateFingerprint !== expectedTargetFingerprint) return rejected('SIMULATED_TARGET_STATE_STALE');
    if (snapshot.namespaceState === 'FOREIGN') return rejected('TARGET_NAMESPACE_FOREIGN_OR_UNOWNED');
    if (snapshot.namespaceState === 'OWNED') {
      const priorOwnership = verifiedEvents(events, plan.target.namespace).some(event => event.adapterId === adapter.adapterId && event.fingerprint === snapshot.namespaceOwnerFingerprint);
      if (!priorOwnership) return rejected('TARGET_NAMESPACE_OWNERSHIP_UNVERIFIED');
    }
    const targetModel = snapshot.versions.find(version => version.versionId === versionRef);
    if (targetModel && targetModel.planFingerprint !== plan.fingerprint) return rejected('VERSIONED_MODEL_COLLISION');
    if (targetModel?.servable && snapshot.localClientPointer === versionRef && await verifyExisting(plan, adapter, logRead)) {
      append('verified', { versionId: versionRef, contentFingerprint: targetModel.contentFingerprint, previousVersionId: previousRef, baselineVersions: baseline(snapshot), baselineVersionsFingerprint: baselineFingerprint(baseline(snapshot)), lifecyclePlanSnapshot: plan });
      return { status: 'REUSED', passed: true, fingerprint: plan.fingerprint, versionRef, liveSqlExecuted };
    }

    try {
      const immediate = await readSnapshot();
      if (!immediate || immediate.targetStateFingerprint !== snapshot.targetStateFingerprint || immediate.namespaceState !== snapshot.namespaceState || immediate.namespaceOwnerFingerprint !== snapshot.namespaceOwnerFingerprint) return rejected('SIMULATED_TARGET_CHANGED_BEFORE_MUTATION');
      if (adapter.recheckInputs) { const check = await recheckInputs(); if (check.status !== 'CURRENT') return rejected(`STALE_SOURCE_INPUTS:${(check.staleInputs ?? []).join(',')}`); }
    } catch (error) { return rejected(`PRE_MUTATION_RECHECK_FAILED:${failure(error).code}`); }
    append('prepared', { versionId: versionRef, contentFingerprint: expectedContentFingerprint, previousVersionId: previousRef, baselineVersions: baseline(snapshot), baselineVersionsFingerprint: baselineFingerprint(baseline(snapshot)), lifecyclePlanSnapshot: plan });
    let failureReason: string | null = null, operationFailureJournaled = false;
    for (const operation of plan.operations) {
      if (operation.role === 'PREFLIGHT') continue; // readSnapshot above is the injected preflight boundary
      if (!operation.sql) { failureReason = 'LIFECYCLE_OPERATION_SQL_MISSING'; break; }
      let outcome: UslSimulationOperationResult;
      try { sqlStarted = true; if (adapter.executionMode === 'LIVE') liveSqlExecuted = true; outcome = await adapter.runOperation(operation, plan); }
      catch { outcome = { status: 'UNKNOWN', requestId: 'UNKNOWN', queryId: 'UNKNOWN', diagnostic: 'ADAPTER_THROW' }; }
      const operationEvent = { versionId: versionRef, contentFingerprint: expectedContentFingerprint, operationId: operation.operationId, operationSha256: operation.sqlSha256 ?? undefined, requestId: outcome.requestId, queryId: outcome.queryId, operationStatus: outcome.status, lifecyclePlanSnapshot: plan };
      if (outcome.status === 'OK') append(operation.role === 'VERIFY' || operation.role === 'READ' ? 'read' : 'applied', operationEvent);
      else { failureReason = `${operation.operationId}:${outcome.status}`; append('failed', { ...operationEvent, reason: outcome.diagnostic ?? failureReason }); operationFailureJournaled = true; break; }
      if (operation.operationId === 'load_model_for_definition_check') {
        try { const loaded = await adapter.readLoadedModel(plan); if (verifyLoadedUslModel(plan, loaded).status !== 'PASS') failureReason = 'LOADED_MODEL_DEFINITION_MISMATCH'; }
        catch { failureReason = 'LOADED_MODEL_READ_FAILED'; }
      }
      if (!failureReason && operation.operationId === 'verify_observed_relation_sample') {
        try { const rows = await adapter.readObservedRows(plan); if (verifyObservedRelationRows(plan, rows).status !== 'PASS') failureReason = 'OBSERVED_RELATION_OUTPUT_MISMATCH'; }
        catch { failureReason = 'OBSERVED_RELATION_READ_FAILED'; }
      }
      if (failureReason) break;
    }
    if (!failureReason) {
      try {
        const final = await readSnapshot();
        if (final.activeVersionRef !== versionRef || !final.versions.some(version => version.versionId === versionRef && version.planFingerprint === plan.fingerprint && version.contentFingerprint === expectedContentFingerprint && version.servable)) failureReason = 'NEW_VERSION_NOT_SERVABLE';
        else if (!await adapter.setLocalClientPointer(previousRef, versionRef)) failureReason = 'LOCAL_POINTER_COMPARE_AND_SET_FAILED';
        else {
          pointerMoved = true;
          const published = await readSnapshot();
          if (published.activeVersionRef !== versionRef || published.localClientPointer !== versionRef || !published.versions.some(version => version.versionId === versionRef && version.servable)) failureReason = 'LOCAL_POINTER_POSTSTATE_UNVERIFIED';
          else {
            const versions = baseline(published);
            append('verified', { versionId: versionRef, contentFingerprint: expectedContentFingerprint, previousVersionId: previousRef, baselineVersions: versions, baselineVersionsFingerprint: baselineFingerprint(versions), lifecyclePlanSnapshot: plan });
            return { status: 'VERIFIED', passed: true, fingerprint: plan.fingerprint, versionRef, liveSqlExecuted };
          }
        }
      } catch (error) { if (error instanceof JournalWriteError) throw error; failureReason = 'FINAL_SIMULATION_STATE_READ_FAILED'; }
    }
    if (!operationFailureJournaled) append('failed', { reason: failureReason });
    // Half-way pointer: the local client pointer was moved to the new version but the publication did not verify. Every outcome of undoing it is journaled.
    let pointerRollback: 'NOT_NEEDED' | 'RESTORED' | 'INCOMPLETE' = pointerMoved ? 'INCOMPLETE' : 'NOT_NEEDED';
    const incompleteSuffix = () => pointerRollback === 'INCOMPLETE' ? ';LOCAL_POINTER_ROLLBACK_INCOMPLETE' : '';
    if (active && previousRef) {
      try {
        const current = await readSnapshot();
        const previousVerified = await verifyPriorVersion(readLifecycleEvents(), previousRef, adapter, logRead);
        if (previousVerified && current.versions.some(version => version.versionId === previousRef && version.planFingerprint === previousVerified.plan.fingerprint && version.contentFingerprint === previousVerified.contentFingerprint && version.servable) && await adapter.setLocalClientPointer(current.localClientPointer, previousRef)) {
          const recovered = await readSnapshot();
          if (recovered.localClientPointer === previousRef && recovered.versions.some(version => version.versionId === previousRef && version.servable)) {
            pointerRollback = 'RESTORED';
            append('recovered', { versionId: previousRef, previousVersionId: previousRef, reason: 'LOCAL_CLIENT_POINTER_RESTORED; backend may still expose the new version' });
            return { status: 'RECOVERED', passed: false, fingerprint: plan.fingerprint, versionRef: previousRef, reason: `PUBLICATION_FAILED:${failureReason}; local client pointer restored; backend may still expose the new version`, liveSqlExecuted };
          }
        }
      } catch (error) { if (error instanceof JournalWriteError) throw error; /* failure remains recorded below */ }
    }
    if (pointerRollback === 'INCOMPLETE') append('failed', { versionId: versionRef, reason: `LOCAL_POINTER_ROLLBACK_INCOMPLETE:pointer left on ${versionRef}; previous ${previousRef ?? 'none'} not restored` });
    return { status: 'FAILED', passed: false, fingerprint: plan.fingerprint, reason: (failureReason ?? 'SIMULATION_FAILED_NO_SERVABLE_PREVIOUS_VERSION') + incompleteSuffix(), liveSqlExecuted };
    } catch (error) {
      if (!(error instanceof JournalWriteError)) throw error;
      // The journal could not record a step. After SQL was sent the outcome is unknown and must be reconciled by hand; before it, nothing was sent.
      if (sqlStarted) return { status: 'FAILED', passed: false, fingerprint: plan.fingerprint, reason: `JOURNAL_WRITE_FAILED_AFTER_SQL:${error.code}`, liveSqlExecuted };
      return rejected(`JOURNAL_WRITE_FAILED_BEFORE_SQL:${error.code}`);
    }
  }));
}


/** Compatibility wrapper: simulations remain LOCAL+SYNTHETIC and use the common lifecycle machine. */
export function executeUslLifecycleSimulation(
  plan: UslLifecyclePlan, publicationManifest: PublicationManifest, input: PublicationPlanInput, binding: PublicationSourceBinding,
  grant: UslSimulationGrant, adapter: UslLifecycleSimulationAdapter, journal: PublicationJournalStore,
  runId: string, now = Date.now(), mode: 'APPLY' | 'REUSE' = 'APPLY'
): Promise<UslSimulationResult> {
  return executeUslLifecycleCore(plan, publicationManifest, input, binding, grant, adapter, journal, runId, now, mode);
}

/** LIVE and fake adapters share the same checked lifecycle coordinator; this function never constructs clients. */
export function executeAuthorizedUslLifecycle(
  plan: UslLifecyclePlan, publicationManifest: PublicationManifest, input: PublicationPlanInput, binding: PublicationSourceBinding,
  rawBindingBytes: Uint8Array, dialectBytes: Uint8Array, grant: UslLiveExecutionGrant, adapter: UslLifecycleExecutionAdapter, journal: PublicationJournalStore,
  runId: string, now = Date.now(), mode: 'APPLY' | 'REUSE' = 'APPLY'
): Promise<UslSimulationResult> {
  if (adapter.executionMode !== 'LIVE') return Promise.resolve({ status: 'REJECTED', passed: false, fingerprint: plan?.fingerprint ?? '', reason: 'LIVE_ADAPTER_REQUIRED', liveSqlExecuted: false });
  return executeUslLifecycleCore(plan, publicationManifest, input, binding, grant, adapter, journal, runId, now, mode, rawBindingBytes, dialectBytes);
}


interface FileSimulationState extends UslSimulationSnapshot {
  schemaVersion: 1;
  adapterId: 'local-synthetic-usl-fixture';
  executionMode: 'LOCAL';
  dataOrigin: 'SYNTHETIC';
  loadedModelsByVersion: Record<string, unknown>;
  observedRowsByPlanFingerprint: Record<string, (readonly unknown[])[]>;
  failOnOperationId?: string;
  failOnPlanFingerprint?: string;
  staleOnRecheck?: boolean;
}

/** A file-backed fake adapter for CLI rehearsal. It only edits a caller-created synthetic fixture below .concordia. */
export class FileUslLifecycleSimulationAdapter implements UslLifecycleSimulationAdapter {
  readonly adapterId = 'local-synthetic-usl-fixture';
  readonly executionMode = 'LOCAL' as const;
  readonly dataOrigin = 'SYNTHETIC' as const;
  readonly filePath: string;
  readonly projectRoot: string;
  constructor(filePath: string, projectRoot = ROOT) {
    this.projectRoot = path.resolve(projectRoot);
    this.filePath = path.resolve(filePath);
    this.assertPath();
  }
  private assertPath(): void {
    const projectConcordia = path.join(this.projectRoot, '.concordia');
    const allowed = path.join(projectConcordia, 'publication-plans');
    const relative = path.relative(allowed, this.filePath);
    if (path.basename(this.filePath).split('.').at(-2) !== 'simulation' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !relative) throw new TypeError('USL_SIMULATION_STATE_PATH_OUTSIDE_PROJECT');
    for (const entry of [this.projectRoot, projectConcordia, allowed, this.filePath]) {
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink() || (entry === this.filePath ? !stat.isFile() : !stat.isDirectory())) throw new TypeError('USL_SIMULATION_STATE_PATH_UNSAFE');
    }
    const realAllowed = fs.realpathSync(allowed), realFile = fs.realpathSync(this.filePath), realRelative = path.relative(realAllowed, realFile);
    if (realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) throw new TypeError('USL_SIMULATION_STATE_PATH_OUTSIDE_PROJECT');
  }
  private read(): FileSimulationState {
    this.assertPath();
    const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as FileSimulationState;
    if (!value || value.schemaVersion !== 1 || value.adapterId !== this.adapterId || value.executionMode !== 'LOCAL' || value.dataOrigin !== 'SYNTHETIC' ||
        !fingerprint(value.targetStateFingerprint) || !['ABSENT', 'OWNED', 'FOREIGN'].includes(value.namespaceState) ||
        !(value.namespaceOwnerFingerprint === null || fingerprint(value.namespaceOwnerFingerprint)) ||
        !(value.activeVersionRef === null || typeof value.activeVersionRef === 'string') || !(value.localClientPointer === null || typeof value.localClientPointer === 'string') ||
        !Array.isArray(value.versions) || value.versions.some(version => !version || typeof version.versionId !== 'string' || !fingerprint(version.planFingerprint) || !fingerprint(version.contentFingerprint) || typeof version.servable !== 'boolean') ||
        !value.loadedModelsByVersion || typeof value.loadedModelsByVersion !== 'object' || Array.isArray(value.loadedModelsByVersion) ||
        !value.observedRowsByPlanFingerprint || typeof value.observedRowsByPlanFingerprint !== 'object' || Array.isArray(value.observedRowsByPlanFingerprint) ||
        (value.failOnOperationId !== undefined && typeof value.failOnOperationId !== 'string') || (value.failOnPlanFingerprint !== undefined && !fingerprint(value.failOnPlanFingerprint)) || (value.staleOnRecheck !== undefined && typeof value.staleOnRecheck !== 'boolean')) throw new Error('USL_SIMULATION_STATE_INVALID');
    return value;
  }
  private write(value: FileSimulationState): void {
    this.assertPath();
    fs.writeFileSync(this.filePath, JSON.stringify(value, null, 2) + '\n', { flag: 'w' });
  }
  async readSnapshot(): Promise<UslSimulationSnapshot> {
    const { schemaVersion: _schema, adapterId: _adapter, executionMode: _mode, dataOrigin: _origin, loadedModelsByVersion: _models, observedRowsByPlanFingerprint: _rows, failOnOperationId: _fail, ...snapshot } = this.read();
    return structuredClone(snapshot);
  }
  async runOperation(operation: UslLifecycleOperation, plan: UslLifecyclePlan): Promise<UslSimulationOperationResult> {
    const state = this.read(), requestId = randomUUID(), queryId = randomUUID();
    if (!['create_target_namespace', 'compile_versioned_model', 'activate_observed_relation', 'load_model_for_definition_check', 'verify_observed_relation_sample'].includes(operation.operationId)) return { status: 'ERROR', requestId, queryId, diagnostic: 'UNSUPPORTED_SYNTHETIC_OPERATION' };
    if (!operation.sql || !operation.sqlSha256 || createHash('sha256').update(operation.sql, 'utf8').digest('hex') !== operation.sqlSha256) return { status: 'ERROR', requestId, queryId, diagnostic: 'OPERATION_SQL_HASH_MISMATCH' };
    if (state.failOnOperationId === operation.operationId && (!state.failOnPlanFingerprint || state.failOnPlanFingerprint === plan.fingerprint)) return { status: 'ERROR', requestId, queryId, diagnostic: 'SYNTHETIC_CONFIGURED_FAILURE' };
    const versionRef = targetRef(plan), contentFingerprint = simulationContentFingerprint(plan);
    if (operation.operationId === 'create_target_namespace') {
      if (state.namespaceState === 'FOREIGN') return { status: 'ERROR', requestId, queryId, diagnostic: 'TARGET_NAMESPACE_FOREIGN_OR_UNOWNED' };
      if (state.namespaceState === 'ABSENT') { state.namespaceState = 'OWNED'; state.namespaceOwnerFingerprint = plan.fingerprint; }
    } else if (operation.operationId === 'compile_versioned_model') {
      if (state.versions.some(version => version.versionId === versionRef && version.planFingerprint !== plan.fingerprint)) return { status: 'ERROR', requestId, queryId, diagnostic: 'VERSIONED_MODEL_COLLISION' };
      if (!state.versions.some(version => version.versionId === versionRef)) state.versions.push({ versionId: versionRef, planFingerprint: plan.fingerprint, contentFingerprint, servable: false });
    } else if (operation.operationId === 'activate_observed_relation') {
      const version = state.versions.find(item => item.versionId === versionRef && item.planFingerprint === plan.fingerprint);
      if (!version) return { status: 'ERROR', requestId, queryId, diagnostic: 'VERSIONED_MODEL_NOT_COMPILED' };
      version.servable = true;
      const activation = operation.sql.match(/^ACTIVATE USL TABLE \S+ AS (SELECT .+)$/i)?.[1] ?? '';
      state.loadedModelsByVersion[versionRef] = {
        namespace: plan.target.namespace.split('.').slice(1), name: plan.target.model,
        tables: [{ namespace: [...plan.target.namespace.split('.'), plan.target.model], name: plan.target.table,
          columnSpecs: plan.columnDefinitions.map(column => ({ name: column.name, dataType: JSON.stringify(column.type), primaryKey: false, notNull: false, foreignKey: [] })),
          unique: [], foreignKeys: [], checks: [], dqAnnotations: [], acAnnotations: [], activateQuery: activation }]
      };
      state.activeVersionRef = versionRef;
      state.targetStateFingerprint = hash({ prior: state.targetStateFingerprint, operation: operation.operationId, plan: plan.fingerprint });
    }
    this.write(state);
    return { status: 'OK', requestId, queryId };
  }
  async readLoadedModel(plan: UslLifecyclePlan): Promise<unknown> {
    const value = this.read().loadedModelsByVersion[targetRef(plan)];
    return value === undefined ? null : structuredClone(value);
  }
  async readObservedRows(plan: UslLifecyclePlan): Promise<readonly (readonly unknown[])[]> {
    const value = this.read().observedRowsByPlanFingerprint[plan.fingerprint];
    return Array.isArray(value) ? structuredClone(value) : [];
  }
  async recheckInputs(_plan: UslLifecyclePlan): Promise<{ status: 'CURRENT' | 'STALE'; staleInputs?: string[] }> {
    return this.read().staleOnRecheck ? { status: 'STALE', staleInputs: ['synthetic_source_binding'] } : { status: 'CURRENT' };
  }
  async setLocalClientPointer(expectedCurrent: string | null, next: string | null): Promise<boolean> {
    const state = this.read();
    if (state.localClientPointer !== expectedCurrent || (next !== null && !state.versions.some(version => version.versionId === next && version.servable))) return false;
    state.localClientPointer = next;
    state.targetStateFingerprint = hash({ prior: state.targetStateFingerprint, localClientPointer: next });
    this.write(state);
    return true;
  }
}

async function recoverUslLifecycleCore(
  plan: UslLifecyclePlan, binding: PublicationSourceBinding, grant: UslSimulationGrant | UslLiveExecutionGrant,
  adapter: UslLifecycleExecutionAdapter, journal: PublicationJournalStore, runId: string, now = Date.now(), rawBindingBytes?: Uint8Array, publicationManifest?: PublicationManifest, input?: PublicationPlanInput, dialectBytes?: Uint8Array
): Promise<UslSimulationResult> {
  const rejected = (reason: string): UslSimulationResult => ({ status: 'REJECTED', passed: false, fingerprint: plan?.fingerprint ?? '', reason, liveSqlExecuted: false });
  if (!adapter || !['LOCAL', 'LIVE'].includes(adapter.executionMode) || typeof adapter.dataOrigin !== 'string' || !adapter.dataOrigin || typeof adapter.readSnapshot !== 'function' || typeof adapter.setLocalClientPointer !== 'function') return rejected('LOCAL_SYNTHETIC_ADAPTER_REQUIRED');
  if (!isUslLifecyclePlanFingerprintValid(plan)) return rejected('LIFECYCLE_PLAN_FINGERPRINT_INVALID');
  const issue = adapter.executionMode === 'LOCAL' && adapter.dataOrigin === 'SYNTHETIC'
    ? grantIssue(grant as UslSimulationGrant, plan, binding, now)
    : (!rawBindingBytes || !dialectBytes || !publicationManifest || !input ? 'LIVE_BINDING_AND_DIALECT_EVIDENCE_REQUIRED' : validateUslLiveExecutionRequest(plan, publicationManifest, input, binding, rawBindingBytes, grant as UslLiveExecutionGrant, dialectBytes, now));
  if (issue) return rejected(issue);
  if (!/^[-A-Za-z0-9._]{1,64}$/.test(runId)) return rejected('SIMULATION_RUN_ID_INVALID');
  return withTargetLock(journal, plan.target.namespace, () => journal.withExclusiveLock(async locked => {
    const journalRoot = (journal as PublicationJournalStore & { projectRoot?: string }).projectRoot ?? ROOT;
    const flushAuditReads = () => {
      for (const read of adapter.drainAuditReads?.() ?? []) {
        const operationSha256 = createHash('sha256').update(read.sql, 'utf8').digest('hex');
        journalEvent(locked, plan, adapter, runId, 'read', { versionId: targetRef(plan), operationId: read.operationId, operationSha256,
          requestId: read.requestId, queryId: read.queryId, operationStatus: read.status, lifecyclePlanSnapshot: plan });
      }
    };
    const readSnapshot = async () => { try { return await adapter.readSnapshot(); } finally { flushAuditReads(); } };
    const history = [...readNamespacePublicationEvents(plan.target.namespace, journalRoot), ...locked.readEvents()].filter((event, index, items) => items.findIndex(item => item.runId === event.runId && item.eventId === event.eventId) === index);
    const events = history.filter(event => event.fingerprint === plan.fingerprint && event.targetKey === targetRef(plan));
    const failed = events.filter(event => event.state === 'failed').at(-1);
    if (!failed?.previousVersionId) return rejected('NO_PRIOR_SERVABLE_VERSION_FOR_RECOVERY');
    const priorVerification = history.filter(event => event.state === 'verified' && event.versionId === failed.previousVersionId && event.targetKey === failed.previousVersionId && event.adapterId === adapter.adapterId).at(-1);
    if (!priorVerification?.contentFingerprint || !priorVerification.lifecyclePlanSnapshot) return rejected('PREVIOUS_VERSION_VERIFICATION_RECEIPT_REQUIRED');
    const priorVerified = await verifyPriorVersion(history, failed.previousVersionId, adapter, (operation, outcome, priorPlan) => journalEvent(locked, plan, adapter, runId, 'read', { versionId: failed.previousVersionId!, operationId: operation.operationId, operationSha256: operation.sqlSha256 ?? undefined, requestId: outcome.requestId, queryId: outcome.queryId, operationStatus: outcome.status, lifecyclePlanSnapshot: priorPlan }));
    if (!priorVerified) return rejected('PREVIOUS_VERSION_CONTENT_UNVERIFIED');
    const snapshot = await readSnapshot();
    if (!snapshot.versions.some(version => version.versionId === failed.previousVersionId && version.planFingerprint === priorVerification.fingerprint && version.contentFingerprint === priorVerification.contentFingerprint && version.servable)) return rejected('PREVIOUS_VERSION_NOT_SERVABLE');
    if (snapshot.localClientPointer !== failed.versionId && snapshot.localClientPointer !== failed.previousVersionId) return rejected('LOCAL_POINTER_CHANGED_SINCE_FAILURE');
    if (!await adapter.setLocalClientPointer(snapshot.localClientPointer, failed.previousVersionId)) return rejected('LOCAL_POINTER_COMPARE_AND_SET_FAILED');
    const recovered = await readSnapshot();
    if (recovered.localClientPointer !== failed.previousVersionId || !recovered.versions.some(version => version.versionId === failed.previousVersionId && version.servable)) return rejected('LOCAL_POINTER_POSTSTATE_UNVERIFIED');
    journalEvent(locked, plan, adapter, runId, 'recovered', { versionId: failed.previousVersionId, previousVersionId: failed.previousVersionId,
      contentFingerprint: recovered.versions.find(version => version.versionId === failed.previousVersionId)!.contentFingerprint,
      targetStateFingerprint: recovered.targetStateFingerprint, reason: 'LOCAL_CLIENT_POINTER_RESTORED; backend may still expose the new version' });
    return { status: 'RECOVERED', passed: true, fingerprint: plan.fingerprint, versionRef: failed.previousVersionId, liveSqlExecuted: false };
  }));
}


export function recoverUslLifecycleSimulation(
  plan: UslLifecyclePlan, binding: PublicationSourceBinding, grant: UslSimulationGrant,
  adapter: UslLifecycleSimulationAdapter, journal: PublicationJournalStore, runId: string, now = Date.now()
): Promise<UslSimulationResult> {
  return recoverUslLifecycleCore(plan, binding, grant, adapter, journal, runId, now);
}

export function recoverAuthorizedUslLifecycle(
  plan: UslLifecyclePlan, manifest: PublicationManifest, input: PublicationPlanInput, binding: PublicationSourceBinding,
  rawBindingBytes: Uint8Array, dialectBytes: Uint8Array, grant: UslLiveExecutionGrant,
  adapter: UslLifecycleExecutionAdapter, journal: PublicationJournalStore, runId: string, now = Date.now()
): Promise<UslSimulationResult> {
  if (adapter.executionMode !== 'LIVE') return Promise.resolve({ status: 'REJECTED', passed: false, fingerprint: plan?.fingerprint ?? '', reason: 'LIVE_ADAPTER_REQUIRED', liveSqlExecuted: false });
  return recoverUslLifecycleCore(plan, binding, grant, adapter, journal, runId, now, rawBindingBytes, manifest, input, dialectBytes);
}
