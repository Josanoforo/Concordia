import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT } from '../runtime.ts';
import { checkPublicationPlanPreconditions, type PublicationChange, type PublicationManifest, type PublicationPlanInput } from './publication-plan.ts';

export type PublicationJournalState = 'planned' | 'prepared' | 'applied' | 'read' | 'verified' | 'failed' | 'superseded' | 'recovered';
export interface PublicationBaselineVersion { versionId: string; planFingerprint: string; contentFingerprint: string; }
export interface PublicationJournalEvent {
  schemaVersion: 1; eventId: string; sequence: number; runId: string; state: PublicationJournalState;
  manifestId: string; fingerprint: string; idempotencyToken: string; universeId: string; targetKey: string;
  adapterId: string; sourceExecutionMode?: string; executionMode: 'LOCAL' | 'LIVE'; dataOrigin: 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN'; at: string;
  previousVersionId?: string | null; versionId?: string; contentFingerprint?: string; targetStateFingerprint?: string;
  baselineVersions?: PublicationBaselineVersion[]; baselineVersionsFingerprint?: string; lifecyclePlanSnapshot?: unknown; reason?: string; supersededByFingerprint?: string;
  operationId?: string; operationSha256?: string; requestId?: string; queryId?: string; operationStatus?: 'OK' | 'ERROR' | 'UNKNOWN';
}
export interface LockedPublicationJournal { readEvents(): PublicationJournalEvent[]; append(event: PublicationJournalEvent): void; }
export interface PublicationJournalStore { withExclusiveLock<T>(work: (journal: LockedPublicationJournal) => Promise<T>): Promise<T>; withTargetLock?<T>(targetKey: string, work: () => Promise<T>): Promise<T>; }

const states = new Set<PublicationJournalState>(['planned', 'prepared', 'applied', 'read', 'verified', 'failed', 'superseded', 'recovered']);
const maxJournalBytes = 10 * 1024 * 1024, maxJournalEvents = 20000, maxLineBytes = 64 * 1024, maxVersions = 2000;
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en')));
});
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const isFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const safeAdapterId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
function validBaseline(value: unknown): value is PublicationBaselineVersion[] {
  return Array.isArray(value) && value.length <= maxVersions && new Set(value.map((item: any) => item?.versionId)).size === value.length &&
    value.every(version => version && typeof version.versionId === 'string' && version.versionId.length > 0 && isFingerprint(version.planFingerprint) && isFingerprint(version.contentFingerprint));
}
function validEvent(value: any): value is PublicationJournalEvent {
  if (!value || value.schemaVersion !== 1 || typeof value.eventId !== 'string' || !Number.isInteger(value.sequence) || value.sequence < 1 ||
    typeof value.runId !== 'string' || !value.runId || !states.has(value.state) || typeof value.manifestId !== 'string' || !value.manifestId || !isFingerprint(value.fingerprint) ||
    value.idempotencyToken !== value.fingerprint || typeof value.universeId !== 'string' || !value.universeId || typeof value.targetKey !== 'string' || !value.targetKey ||
    !safeAdapterId(value.adapterId) || !['LOCAL', 'LIVE'].includes(value.executionMode) || !['SYNTHETIC', 'PUBLIC', 'USER', 'UNKNOWN'].includes(value.dataOrigin) || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return false;
  if ((value.state === 'prepared' || value.state === 'verified') &&
    (!validBaseline(value.baselineVersions) || value.baselineVersionsFingerprint !== hash(value.baselineVersions) || typeof value.versionId !== 'string' || !value.versionId ||
      !(value.previousVersionId === null || typeof value.previousVersionId === 'string') || !isFingerprint(value.contentFingerprint) || !isFingerprint(value.targetStateFingerprint))) return false;
  if (value.state === 'applied' && (typeof value.versionId !== 'string' || !value.versionId || !isFingerprint(value.contentFingerprint))) return false;
  if ((value.state === 'recovered' || value.state === 'superseded') && (typeof value.versionId !== 'string' || !value.versionId)) return false;
  if ((value.state === 'failed' || value.state === 'recovered') && (typeof value.reason !== 'string' || !value.reason)) return false;
  if (value.state === 'superseded' && !isFingerprint(value.supersededByFingerprint)) return false;
  if (value.targetStateFingerprint !== undefined && !isFingerprint(value.targetStateFingerprint)) return false;
  if (value.sourceExecutionMode !== undefined && (typeof value.sourceExecutionMode !== 'string' || !value.sourceExecutionMode)) return false;
  if (value.lifecyclePlanSnapshot !== undefined && (!value.lifecyclePlanSnapshot || typeof value.lifecyclePlanSnapshot !== 'object' || Array.isArray(value.lifecyclePlanSnapshot) || !isFingerprint((value.lifecyclePlanSnapshot as any).fingerprint))) return false;
  if (value.operationId !== undefined && (typeof value.operationId !== 'string' || !value.operationId)) return false;
  if (value.operationSha256 !== undefined && !isFingerprint(value.operationSha256)) return false;
  if (value.requestId !== undefined && (typeof value.requestId !== 'string' || !value.requestId)) return false;
  if (value.queryId !== undefined && (typeof value.queryId !== 'string' || !value.queryId)) return false;
  if (value.operationStatus !== undefined && !['OK', 'ERROR', 'UNKNOWN'].includes(value.operationStatus)) return false;
  return true;
}
function validateJournalHistory(events: readonly PublicationJournalEvent[]): void {
  if (events.length > maxJournalEvents) throw new Error('PUBLICATION_JOURNAL_EVENT_LIMIT_EXCEEDED');
  const ids = new Set<string>(), sequences = new Map<string, number>();
  for (const event of events) {
    if (ids.has(event.eventId)) throw new Error('PUBLICATION_JOURNAL_DUPLICATE_EVENT_ID'); ids.add(event.eventId);
    const expected = (sequences.get(event.fingerprint) ?? 0) + 1;
    if (event.sequence !== expected || event.eventId !== `${event.fingerprint}:${expected}:${event.state}`) throw new Error('PUBLICATION_JOURNAL_SEQUENCE_INVALID');
    sequences.set(event.fingerprint, expected);
  }
}

/** Append-only JSONL journal. Stale locks fail closed and require offline/manual recovery. */
export class FilePublicationJournal implements PublicationJournalStore {
  readonly journalPath: string;
  readonly projectRoot: string;
  constructor(journalPath: string, projectRoot = ROOT) {
    this.projectRoot = path.resolve(projectRoot); this.journalPath = path.resolve(journalPath);
    const runsRoot = path.join(this.projectRoot, '.concordia', 'publication-runs'), relative = path.relative(runsRoot, this.journalPath);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || path.basename(this.journalPath) !== 'journal.jsonl') throw new TypeError('PUBLICATION_JOURNAL_PATH_OUTSIDE_PROJECT_RUNS');
  }
  private ensureSafeDirectory(): void {
    const concordia = path.join(this.projectRoot, '.concordia'), runs = path.join(concordia, 'publication-runs');
    const rootStat = fs.lstatSync(this.projectRoot), concordiaStat = fs.lstatSync(concordia);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !concordiaStat.isDirectory() || concordiaStat.isSymbolicLink()) throw new TypeError('PUBLICATION_RUN_ROOT_UNSAFE');
    if (!fs.existsSync(runs)) fs.mkdirSync(runs);
    const runsStat = fs.lstatSync(runs); if (!runsStat.isDirectory() || runsStat.isSymbolicLink()) throw new TypeError('PUBLICATION_RUN_ROOT_UNSAFE');
    const relative = path.relative(runs, path.dirname(this.journalPath));
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new TypeError('PUBLICATION_JOURNAL_PATH_OUTSIDE_PROJECT_RUNS');
    let current = runs;
    for (const segment of relative.split(path.sep).filter(Boolean)) { current = path.join(current, segment); if (!fs.existsSync(current)) fs.mkdirSync(current); const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('PUBLICATION_JOURNAL_DIRECTORY_UNSAFE'); }
    const realRuns = fs.realpathSync(runs), realParent = fs.realpathSync(path.dirname(this.journalPath)), realRelative = path.relative(realRuns, realParent);
    if (realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) throw new TypeError('PUBLICATION_JOURNAL_PATH_OUTSIDE_PROJECT_RUNS');
    if (fs.existsSync(this.journalPath)) { const file = fs.lstatSync(this.journalPath); if (!file.isFile() || file.isSymbolicLink()) throw new TypeError('PUBLICATION_JOURNAL_FILE_UNSAFE'); }
  }
  async withTargetLock<T>(targetKey: string, work: () => Promise<T>): Promise<T> {
    if (typeof targetKey !== 'string' || !targetKey || Buffer.byteLength(targetKey) > 1024) throw new TypeError('PUBLICATION_TARGET_KEY_INVALID');
    this.ensureSafeDirectory();
    const runsRoot = path.join(this.projectRoot, '.concordia', 'publication-runs');
    const lockDirectory = path.join(runsRoot, 'target-locks');
    if (!fs.existsSync(lockDirectory)) fs.mkdirSync(lockDirectory);
    const directoryStat = fs.lstatSync(lockDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new TypeError('PUBLICATION_TARGET_LOCK_DIRECTORY_UNSAFE');
    const realRuns = fs.realpathSync(runsRoot), realDirectory = fs.realpathSync(lockDirectory), relative = path.relative(realRuns, realDirectory);
    if (relative !== 'target-locks') throw new TypeError('PUBLICATION_TARGET_LOCK_DIRECTORY_UNSAFE');
    const lockPath = path.join(lockDirectory, `${hash(targetKey)}.lock`), token = randomUUID();
    let fd: number;
    try { fd = fs.openSync(lockPath, 'wx', 0o600); }
    catch (error: any) { if (error?.code === 'EEXIST') throw new Error('PUBLICATION_TARGET_WRITER_EXISTS'); throw error; }
    try { fs.writeFileSync(fd, token); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { return await work(); }
    finally {
      const stat = fs.lstatSync(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(lockPath, 'utf8') !== token) throw new Error('PUBLICATION_TARGET_LOCK_OWNERSHIP_LOST');
      fs.unlinkSync(lockPath);
    }
  }

  async withExclusiveLock<T>(work: (journal: LockedPublicationJournal) => Promise<T>): Promise<T> {
    this.ensureSafeDirectory();
    const lockPath = `${this.journalPath}.lock`;
    let fd: number;
    try { fd = fs.openSync(lockPath, 'wx', 0o600); }
    catch (error: any) { if (error?.code === 'EEXIST') throw new Error('PUBLICATION_JOURNAL_WRITER_EXISTS'); throw error; }
    const token = randomUUID();
    try { fs.writeFileSync(fd, token); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const journal: LockedPublicationJournal = {
      readEvents: () => {
        this.ensureSafeDirectory();
        if (!fs.existsSync(this.journalPath)) return [];
        const stat = fs.lstatSync(this.journalPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxJournalBytes) throw new Error('PUBLICATION_JOURNAL_UNSAFE_OR_TOO_LARGE');
        const lines = fs.readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean);
        if (lines.length > maxJournalEvents || lines.some(line => Buffer.byteLength(line) > maxLineBytes)) throw new Error('PUBLICATION_JOURNAL_LIMIT_EXCEEDED');
        const events = lines.map(line => JSON.parse(line));
        if (events.some(event => !validEvent(event))) throw new Error('PUBLICATION_JOURNAL_EVENT_INVALID');
        validateJournalHistory(events);
        return events;
      },
      append: event => {
        const events = journal.readEvents();
        if (!validEvent(event)) throw new Error('PUBLICATION_JOURNAL_EVENT_INVALID');
        const expected = (events.filter(item => item.fingerprint === event.fingerprint).at(-1)?.sequence ?? 0) + 1;
        if (event.sequence !== expected || event.eventId !== `${event.fingerprint}:${expected}:${event.state}` || events.some(item => item.eventId === event.eventId)) throw new Error('PUBLICATION_JOURNAL_SEQUENCE_INVALID');
        const line = `${JSON.stringify(event)}\n`;
        if (events.length >= maxJournalEvents || Buffer.byteLength(line) > maxLineBytes || (fs.existsSync(this.journalPath) ? fs.statSync(this.journalPath).size : 0) + Buffer.byteLength(line) > maxJournalBytes) throw new Error('PUBLICATION_JOURNAL_LIMIT_EXCEEDED');
        const appendFd = fs.openSync(this.journalPath, 'a', 0o600);
        try { fs.writeFileSync(appendFd, line); fs.fsyncSync(appendFd); } finally { fs.closeSync(appendFd); }
      }
    };
    return Promise.resolve().then(() => work(journal)).finally(() => {
      try {
        const stat = fs.lstatSync(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(lockPath, 'utf8') !== token) throw new Error('PUBLICATION_JOURNAL_LOCK_OWNERSHIP_LOST');
        fs.unlinkSync(lockPath);
      } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    });
  }
}

/** Read-only, path-confined history view. Unlike the writer API this never creates directories or lock files. */
export function readPublicationJournalHistory(journalPath: string, projectRoot = ROOT): PublicationJournalEvent[] {
  const root = path.resolve(projectRoot), runsRoot = path.join(root, '.concordia', 'publication-runs'), resolved = path.resolve(journalPath);
  const relative = path.relative(runsRoot, resolved);
  if (path.basename(resolved) !== 'journal.jsonl' || !relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new TypeError('PUBLICATION_JOURNAL_PATH_OUTSIDE_PROJECT_RUNS');
  const rootStat = fs.lstatSync(root), concordia = path.join(root, '.concordia');
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TypeError('PUBLICATION_RUN_ROOT_UNSAFE');
  if (!fs.existsSync(concordia)) return [];
  const concordiaStat = fs.lstatSync(concordia);
  if (!concordiaStat.isDirectory() || concordiaStat.isSymbolicLink()) throw new TypeError('PUBLICATION_RUN_ROOT_UNSAFE');
  if (!fs.existsSync(runsRoot)) return [];
  const runsStat = fs.lstatSync(runsRoot);
  if (!runsStat.isDirectory() || runsStat.isSymbolicLink()) throw new TypeError('PUBLICATION_RUN_ROOT_UNSAFE');
  const parentRelative = path.relative(runsRoot, path.dirname(resolved));
  if (parentRelative.startsWith('..' + path.sep) || path.isAbsolute(parentRelative)) throw new TypeError('PUBLICATION_JOURNAL_PATH_OUTSIDE_PROJECT_RUNS');
  let current = runsRoot;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) return [];
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('PUBLICATION_JOURNAL_DIRECTORY_UNSAFE');
  }
  if (!fs.existsSync(resolved)) return [];
  const file = fs.lstatSync(resolved);
  if (!file.isFile() || file.isSymbolicLink() || file.size > maxJournalBytes) throw new Error('PUBLICATION_JOURNAL_UNSAFE_OR_TOO_LARGE');
  const realRuns = fs.realpathSync(runsRoot), realParent = fs.realpathSync(path.dirname(resolved)), realRelative = path.relative(realRuns, realParent);
  if (realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) throw new TypeError('PUBLICATION_JOURNAL_PATH_OUTSIDE_PROJECT_RUNS');
  const lines = fs.readFileSync(resolved, 'utf8').split('\n').filter(Boolean);
  if (lines.length > maxJournalEvents || lines.some(line => Buffer.byteLength(line) > maxLineBytes)) throw new Error('PUBLICATION_JOURNAL_LIMIT_EXCEEDED');
  let events: unknown[];
  try { events = lines.map(line => JSON.parse(line)); } catch { throw new Error('PUBLICATION_JOURNAL_EVENT_INVALID'); }
  if (events.some(event => !validEvent(event))) throw new Error('PUBLICATION_JOURNAL_EVENT_INVALID');
  validateJournalHistory(events as PublicationJournalEvent[]);
  return events as PublicationJournalEvent[];
}
export interface OfflinePublicationSnapshot {
  targetStateFingerprint: string; observedAt: string; activeVersionId: string | null;
  activeContentFingerprint: string | null; versions: (PublicationBaselineVersion & { enabled?: boolean })[];
  appliedTokens: { token: string; versionId: string; contentFingerprint: string }[];
}
export interface OfflinePublicationRead { input: PublicationPlanInput; target: OfflinePublicationSnapshot; }
export type OfflineApplyResult = { status: 'APPLIED' | 'ALREADY_APPLIED' | 'PARTIAL'; versionId: string; contentFingerprint: string; reason?: string };
export type OfflineRecoveryResult = { status: 'REPOINTED' | 'DISABLED' | 'CONFLICT' | 'FAILED'; reason?: string };
/** Injected LOCAL+SYNTHETIC store API; deliberately has no SQL execution operation. */
export interface OfflinePublicationAdapter {
  readonly adapterId: string; readonly executionMode: 'LOCAL'; readonly dataOrigin: 'SYNTHETIC';
  readLatest(): Promise<OfflinePublicationRead>;
  applyAdditive(request: { token: string; expectedTargetStateFingerprint: string; target: PublicationManifest['target']; changes: readonly PublicationChange[]; versionId: string; expectedContentFingerprint: string; previousVersionId: string | null }): Promise<OfflineApplyResult>;
  recoverPartial(request: { token: string; expectedTargetStateFingerprint: string; expectedActiveVersionId: string | null; previousVersionId: string | null; partialVersionId: string }): Promise<OfflineRecoveryResult>;
}
export interface OfflinePublicationResult { status: 'VERIFIED' | 'REJECTED' | 'RECOVERED' | 'FAILED'; passed: boolean; fingerprint: string; versionId?: string; reason?: string; }
function snapshotIssue(snapshot: any): string | null {
  if (!snapshot || typeof snapshot !== 'object' || !isFingerprint(snapshot.targetStateFingerprint) || typeof snapshot.observedAt !== 'string' || Number.isNaN(Date.parse(snapshot.observedAt))) return 'TARGET_SNAPSHOT_INVALID';
  if (!(snapshot.activeVersionId === null || (typeof snapshot.activeVersionId === 'string' && snapshot.activeVersionId.length > 0)) || !(snapshot.activeContentFingerprint === null || isFingerprint(snapshot.activeContentFingerprint))) return 'TARGET_ACTIVE_VERSION_INVALID';
  if (!Array.isArray(snapshot.versions) || snapshot.versions.length > maxVersions || snapshot.versions.some((version: any) => !version || typeof version.versionId !== 'string' || !version.versionId || !isFingerprint(version.planFingerprint) || !isFingerprint(version.contentFingerprint) || (version.enabled !== undefined && typeof version.enabled !== 'boolean'))) return 'TARGET_VERSION_SHAPE_INVALID';
  if (new Set(snapshot.versions.map((version: any) => version.versionId)).size !== snapshot.versions.length) return 'TARGET_VERSION_DUPLICATE';
  if (!Array.isArray(snapshot.appliedTokens) || snapshot.appliedTokens.length > maxVersions || snapshot.appliedTokens.some((item: any) => !item || !isFingerprint(item.token) || typeof item.versionId !== 'string' || !item.versionId || !isFingerprint(item.contentFingerprint))) return 'TARGET_TOKEN_SHAPE_INVALID';
  if (new Set(snapshot.appliedTokens.map((item: any) => item.token)).size !== snapshot.appliedTokens.length) return 'TARGET_TOKEN_DUPLICATE';
  for (const token of snapshot.appliedTokens) {
    const matches = snapshot.versions.filter((version: any) => version.versionId === token.versionId && version.planFingerprint === token.token && version.contentFingerprint === token.contentFingerprint);
    if (matches.length !== 1) return 'TARGET_TOKEN_VERSION_MISMATCH';
  }
  if (snapshot.activeVersionId === null) return snapshot.activeContentFingerprint === null ? null : 'TARGET_ACTIVE_CONTENT_MISMATCH';
  const active = snapshot.versions.find((version: any) => version.versionId === snapshot.activeVersionId);
  if (!active || active.enabled === false || active.contentFingerprint !== snapshot.activeContentFingerprint) return 'TARGET_ACTIVE_VERSION_MISMATCH';
  return null;
}
function publicationReadIssue(read: any): string | null {
  if (!read || typeof read !== 'object' || !read.input || typeof read.input !== 'object' || !read.input.targetState) return 'PUBLICATION_READ_SHAPE_INVALID';
  const invalidSnapshot = snapshotIssue(read.target);
  if (invalidSnapshot) return invalidSnapshot;
  if (read.input.targetState.fingerprint !== read.target.targetStateFingerprint || read.input.targetState.observedAt !== read.target.observedAt) return 'PUBLICATION_INPUT_TARGET_STATE_MISMATCH';
  return null;
}
function baselineOf(snapshot: OfflinePublicationSnapshot): PublicationBaselineVersion[] {
  const issue = snapshotIssue(snapshot);
  if (issue) throw new Error(issue);
  return [...snapshot.versions].map(version => ({ versionId: version.versionId, planFingerprint: version.planFingerprint, contentFingerprint: version.contentFingerprint })).sort((a, b) => a.versionId.localeCompare(b.versionId, 'en'));
}
function activeToken(snapshot: OfflinePublicationSnapshot, token: string, versionId: string): boolean {
  return snapshot.activeVersionId === versionId && snapshot.versions.filter(item => item.versionId === versionId && item.planFingerprint === token && item.enabled !== false && item.contentFingerprint === snapshot.activeContentFingerprint).length === 1 && snapshot.appliedTokens.filter(item => item.token === token && item.versionId === versionId && item.contentFingerprint === snapshot.activeContentFingerprint).length === 1;
}
function targetKey(manifest: PublicationManifest): string { return `${manifest.target.namespace}.${manifest.target.model}`; }
function ensureOfflineManifest(manifest: PublicationManifest): void {
  if (!manifest || manifest.schemaVersion !== 1 || !isFingerprint(manifest.fingerprint) || manifest.manifestId !== `publication:${manifest.fingerprint.slice(0, 24)}` || manifest.executable !== false || manifest.sqlPlan?.executable !== false || manifest.lifecycle?.applySupported !== false || manifest.eligibility !== 'publishable' || !Array.isArray(manifest.changes) || !manifest.changes.length || manifest.changes.some(change => change.operation !== 'PROJECT_RELATION')) throw new Error('PUBLICATION_MANIFEST_NOT_OFFLINE_ADDITIVE');
}
function eventBase(manifest: PublicationManifest, adapter: OfflinePublicationAdapter, runId: string, state: PublicationJournalState, sequence: number): PublicationJournalEvent {
  return { schemaVersion: 1, eventId: `${manifest.fingerprint}:${sequence}:${state}`, sequence, runId, state, manifestId: manifest.manifestId, fingerprint: manifest.fingerprint, idempotencyToken: manifest.fingerprint, universeId: manifest.universeId, targetKey: targetKey(manifest), sourceExecutionMode: manifest.executionMode, adapterId: adapter.adapterId, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', at: new Date().toISOString() };
}
function baselinePreserved(expected: readonly PublicationBaselineVersion[], actual: OfflinePublicationSnapshot): boolean {
  try {
    const byId = new Map(baselineOf(actual).map(item => [item.versionId, item]));
    return expected.every(item => JSON.stringify(byId.get(item.versionId)) === JSON.stringify(item));
  } catch { return false; }
}
/** Read every safe run journal for one namespace, without creating files or locks. */
export function readNamespacePublicationEvents(namespace: string, projectRoot = ROOT): PublicationJournalEvent[] {
  if (typeof namespace !== 'string' || !namespace || namespace.includes('\0')) throw new TypeError('PUBLICATION_NAMESPACE_INVALID');
  const root = path.resolve(projectRoot), concordia = path.join(root, '.concordia'), runs = path.join(concordia, 'publication-runs');
  if (!fs.existsSync(runs)) return [];
  for (const directory of [root, concordia, runs]) { const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('PUBLICATION_RUN_ROOT_UNSAFE'); }
  const output: PublicationJournalEvent[] = [];
  for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'target-locks' || entry.name === 'usl-client-pointers') continue;
    const journalPath = path.join(runs, entry.name, 'journal.jsonl');
    if (!fs.existsSync(journalPath)) continue;
    const stat = fs.lstatSync(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError('PUBLICATION_JOURNAL_FILE_UNSAFE');
    output.push(...readPublicationJournalHistory(journalPath, root).filter(event => event.targetKey === namespace || event.targetKey.startsWith(namespace + '.')));
  }
  return output.sort((a, b) => {
    const byTime = a.at.localeCompare(b.at, 'en');
    if (byTime) return byTime;
    if (a.runId === b.runId && a.fingerprint === b.fingerprint) return a.sequence - b.sequence;
    return a.runId.localeCompare(b.runId, 'en') || a.fingerprint.localeCompare(b.fingerprint, 'en') || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId, 'en');
  });
}

/** Offline structured publication coordinator. A journal marker alone never constitutes verification. */
export async function executeOfflinePublication(manifest: PublicationManifest, current: PublicationPlanInput, adapter: OfflinePublicationAdapter, journal: PublicationJournalStore, runId: string = randomUUID()): Promise<OfflinePublicationResult> {
  try { ensureOfflineManifest(manifest); } catch (error: any) { return { status: 'REJECTED', passed: false, fingerprint: manifest?.fingerprint ?? '', reason: error?.message ?? 'PUBLICATION_MANIFEST_INVALID' }; }
  if (!adapter || adapter.executionMode !== 'LOCAL' || adapter.dataOrigin !== 'SYNTHETIC' || !safeAdapterId(adapter.adapterId) || typeof adapter.readLatest !== 'function' || typeof adapter.applyAdditive !== 'function' || typeof adapter.recoverPartial !== 'function') return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: 'OFFLINE_SYNTHETIC_ADAPTER_REQUIRED' };
  let first: OfflinePublicationRead;
  try { first = await adapter.readLatest(); } catch { return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: 'TARGET_PREFLIGHT_FAILED' }; }
  const readIssue = publicationReadIssue(first);
  if (readIssue) return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: readIssue };
  const initialCheck = checkPublicationPlanPreconditions(manifest, { ...first.input, targetState: current.targetState });
  if (initialCheck.status !== 'CURRENT' || manifest.inputFingerprints.targetState !== 'KNOWN') return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: `STALE_PREFLIGHT:${initialCheck.staleInputs.join(',')}` };
  const expectedContent = hash({ target: manifest.target, changes: manifest.changes });
  const versionId = `publication-version:${manifest.fingerprint.slice(0, 24)}`;
  const runWithJournal = (): Promise<OfflinePublicationResult> => journal.withExclusiveLock<OfflinePublicationResult>(async store => {
    const events = store.readEvents(), own = events.filter(event => event.fingerprint === manifest.fingerprint);
    if (own.some(event => event.manifestId !== manifest.manifestId || event.universeId !== manifest.universeId || event.targetKey !== targetKey(manifest) || event.adapterId !== adapter.adapterId)) return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: 'PUBLICATION_JOURNAL_IDENTITY_COLLISION' };
    const append = (state: PublicationJournalState, extra: Partial<PublicationJournalEvent> = {}) => {
      const sequence = (own.at(-1)?.sequence ?? 0) + 1, event = { ...eventBase(manifest, adapter, runId, state, sequence), ...extra } as PublicationJournalEvent;
      store.append(event); own.push(event); return event;
    };
    if (!own.length) append('planned');
    let latest: OfflinePublicationRead;
    try { latest = await adapter.readLatest(); } catch { return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: 'TARGET_PREFLIGHT_FAILED' }; }
    const latestIssue = publicationReadIssue(latest);
    if (latestIssue) return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: latestIssue };
    const latestCheck = checkPublicationPlanPreconditions(manifest, { ...latest.input, targetState: current.targetState });
    if (latestCheck.status !== 'CURRENT' || latest.target.targetStateFingerprint !== first.target.targetStateFingerprint) return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: 'STALE_TARGET_OR_INPUT' };
    const verifiedEvent = own.at(-1);
    if (verifiedEvent?.state === 'verified') {
      if (!verifiedEvent.baselineVersions || !baselinePreserved(verifiedEvent.baselineVersions, latest.target) || !activeToken(latest.target, manifest.fingerprint, verifiedEvent.versionId!) || verifiedEvent.contentFingerprint !== latest.target.activeContentFingerprint) {
        append('failed', { reason: 'VERIFIED_CONTENT_OR_BASELINE_CHANGED' });
        return { status: 'FAILED', passed: false, fingerprint: manifest.fingerprint, reason: 'VERIFIED_CONTENT_OR_BASELINE_CHANGED' };
      }
      return { status: 'VERIFIED', passed: true, fingerprint: manifest.fingerprint, versionId: verifiedEvent.versionId };
    }
    const prepared = own.find(event => event.state === 'prepared');
    if (prepared) {
      if (!prepared.baselineVersions || !prepared.versionId || !baselinePreserved(prepared.baselineVersions, latest.target)) return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: 'PREPARED_TARGET_BASELINE_STALE' };
      if (activeToken(latest.target, manifest.fingerprint, prepared.versionId) && latest.target.activeContentFingerprint === prepared.contentFingerprint && baselinePreserved(prepared.baselineVersions, latest.target)) {
        append('recovered', { versionId: prepared.versionId, reason: 'IDEMPOTENT_TOKEN_CONFIRMED' });
        append('verified', { versionId: prepared.versionId, contentFingerprint: prepared.contentFingerprint, targetStateFingerprint: latest.target.targetStateFingerprint, previousVersionId: prepared.previousVersionId, baselineVersions: prepared.baselineVersions, baselineVersionsFingerprint: prepared.baselineVersionsFingerprint });
        return { status: 'VERIFIED', passed: true, fingerprint: manifest.fingerprint, versionId: prepared.versionId };
      }
      const partialOwned = latest.target.activeVersionId === prepared.versionId && latest.target.versions.some(item => item.versionId === prepared.versionId && item.planFingerprint === manifest.fingerprint);
      if (!partialOwned) return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: 'PREPARED_TARGET_STALE_OR_UNOWNED' };
      const fresh = await adapter.readLatest(); if (publicationReadIssue(fresh)) throw new Error('RECOVERY_READ_INVALID');
      if (fresh.target.targetStateFingerprint !== latest.target.targetStateFingerprint || fresh.target.activeVersionId !== prepared.versionId || !baselinePreserved(prepared.baselineVersions, fresh.target)) return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: 'PARTIAL_RECOVERY_PRECONDITION_STALE' };
      const recovery = await adapter.recoverPartial({ token: manifest.fingerprint, expectedTargetStateFingerprint: fresh.target.targetStateFingerprint, expectedActiveVersionId: prepared.versionId, previousVersionId: prepared.previousVersionId ?? null, partialVersionId: prepared.versionId });
      const safe = (recovery.status === 'REPOINTED' || recovery.status === 'DISABLED') && await recoveryPoststate(adapter, recovery.status, manifest.fingerprint, prepared.baselineVersions, prepared.versionId, prepared.previousVersionId ?? null);
      append(safe ? 'recovered' : 'failed', { versionId: prepared.versionId, reason: safe ? recovery.reason ?? recovery.status : 'RECOVERY_POSTSTATE_UNVERIFIED' });
      return { status: safe ? 'RECOVERED' : 'FAILED', passed: false, fingerprint: manifest.fingerprint, versionId: prepared.versionId, reason: safe ? recovery.reason ?? recovery.status : 'RECOVERY_POSTSTATE_UNVERIFIED' };
    }
    if (latest.target.targetStateFingerprint !== current.targetState?.fingerprint) return { status: 'REJECTED', passed: false, fingerprint: manifest.fingerprint, reason: 'TARGET_CHANGED_BEFORE_PREPARE' };
    const baseline = baselineOf(latest.target), baselineHash = hash(baseline);
    append('prepared', { previousVersionId: latest.target.activeVersionId, versionId, contentFingerprint: expectedContent, targetStateFingerprint: latest.target.targetStateFingerprint, baselineVersions: baseline, baselineVersionsFingerprint: baselineHash });
    let applied: OfflineApplyResult | undefined, applyError: unknown;
    try { applied = await adapter.applyAdditive({ token: manifest.fingerprint, expectedTargetStateFingerprint: latest.target.targetStateFingerprint, target: manifest.target, changes: manifest.changes, versionId, expectedContentFingerprint: expectedContent, previousVersionId: latest.target.activeVersionId }); }
    catch (error) { applyError = error; }
    if (applyError || !applied || applied.status === 'PARTIAL') {
      let after: OfflinePublicationRead | undefined;
      try { after = await adapter.readLatest(); if (publicationReadIssue(after)) after = undefined; } catch { /* fail closed below */ }
      const ownedPartial = after && after.target.activeVersionId === versionId && after.target.versions.some(item => item.versionId === versionId && item.planFingerprint === manifest.fingerprint);
      if (after && ownedPartial && baselinePreserved(baseline, after.target)) {
        const fresh = await adapter.readLatest(); if (publicationReadIssue(fresh)) throw new Error('RECOVERY_READ_INVALID');
        if (fresh.target.targetStateFingerprint !== after.target.targetStateFingerprint || fresh.target.activeVersionId !== versionId) {
          append('failed', { reason: 'PARTIAL_RECOVERY_PRECONDITION_STALE' });
          return { status: 'FAILED', passed: false, fingerprint: manifest.fingerprint, versionId, reason: 'PARTIAL_RECOVERY_PRECONDITION_STALE' };
        }
        const recovery = await adapter.recoverPartial({ token: manifest.fingerprint, expectedTargetStateFingerprint: fresh.target.targetStateFingerprint, expectedActiveVersionId: versionId, previousVersionId: latest.target.activeVersionId, partialVersionId: versionId });
        const safe = (recovery.status === 'REPOINTED' || recovery.status === 'DISABLED') && await recoveryPoststate(adapter, recovery.status, manifest.fingerprint, baseline, versionId, latest.target.activeVersionId);
        append(safe ? 'recovered' : 'failed', { versionId, reason: safe ? recovery.reason ?? (applyError ? 'APPLY_INTERRUPTED' : applied?.reason ?? 'PARTIAL_APPLY') : 'RECOVERY_POSTSTATE_UNVERIFIED' });
        return { status: safe ? 'RECOVERED' : 'FAILED', passed: false, fingerprint: manifest.fingerprint, versionId, reason: safe ? recovery.reason ?? 'PARTIAL_APPLY_RECOVERED' : 'RECOVERY_POSTSTATE_UNVERIFIED' };
      }
      const reason = applyError instanceof Error ? applyError.message : applied?.reason ?? 'OFFLINE_APPLY_FAILED';
      append('failed', { reason });
      return { status: 'FAILED', passed: false, fingerprint: manifest.fingerprint, reason };
    }
    if (applied.status !== 'APPLIED' && applied.status !== 'ALREADY_APPLIED' || applied.versionId !== versionId || !isFingerprint(applied.contentFingerprint)) {
      append('failed', { reason: 'OFFLINE_ADAPTER_RESULT_INVALID' });
      return { status: 'FAILED', passed: false, fingerprint: manifest.fingerprint, reason: 'OFFLINE_ADAPTER_RESULT_INVALID' };
    }
    append('applied', { versionId, contentFingerprint: applied.contentFingerprint });
    const after = await adapter.readLatest();
    if (publicationReadIssue(after)) { append('failed', { reason: 'POST_APPLY_READ_INVALID' }); return { status: 'FAILED', passed: false, fingerprint: manifest.fingerprint, versionId, reason: 'POST_APPLY_READ_INVALID' }; }
    const afterCheck = checkPublicationPlanPreconditions(manifest, { ...after.input, targetState: current.targetState });
    if (afterCheck.status !== 'CURRENT' || !baselinePreserved(baseline, after.target) || !activeToken(after.target, manifest.fingerprint, versionId) || after.target.activeContentFingerprint !== expectedContent || applied.contentFingerprint !== expectedContent) {
      append('failed', { reason: 'OFFLINE_APPLY_VERIFICATION_FAILED' });
      return { status: 'FAILED', passed: false, fingerprint: manifest.fingerprint, versionId, reason: 'OFFLINE_APPLY_VERIFICATION_FAILED' };
    }
    append('verified', { versionId, contentFingerprint: expectedContent, targetStateFingerprint: after.target.targetStateFingerprint, previousVersionId: latest.target.activeVersionId, baselineVersions: baseline, baselineVersionsFingerprint: baselineHash });
    return { status: 'VERIFIED', passed: true, fingerprint: manifest.fingerprint, versionId };
  });
  return journal.withTargetLock ? journal.withTargetLock(targetKey(manifest), runWithJournal) : runWithJournal();
}



async function recoveryPoststate(adapter: OfflinePublicationAdapter, status: OfflineRecoveryResult['status'], token: string, baseline: readonly PublicationBaselineVersion[], partialVersionId: string, previousVersionId: string | null): Promise<boolean> {
  let latest: OfflinePublicationRead;
  try { latest = await adapter.readLatest(); } catch { return false; }
  if (publicationReadIssue(latest) || !baselinePreserved(baseline, latest.target)) return false;
  const partial = latest.target.versions.find(item => item.versionId === partialVersionId);
  if (!partial || partial.planFingerprint !== token || latest.target.activeVersionId === partialVersionId || activeToken(latest.target, token, partialVersionId)) return false;
  if (status === 'DISABLED') {
    if (partial.enabled !== false || latest.target.activeVersionId === partialVersionId) return false;
    if (previousVersionId === null) return latest.target.activeVersionId === null && latest.target.activeContentFingerprint === null;
    const previous = baseline.find(item => item.versionId === previousVersionId);
    return Boolean(previous && latest.target.activeVersionId === previousVersionId && latest.target.activeContentFingerprint === previous.contentFingerprint);
  }
  if (status === 'REPOINTED') {
    if (latest.target.activeVersionId !== previousVersionId) return false;
    if (previousVersionId === null) return latest.target.activeContentFingerprint === null;
    const previous = baseline.find(item => item.versionId === previousVersionId);
    return Boolean(previous && latest.target.activeContentFingerprint === previous.contentFingerprint);
  }
  return false;
}
