import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Reconciler, claimTier, claimTime, type BatchRejection, type Claim, type ClaimTier, type Conflict, type MemoryOrigin } from '../reconcile/index.ts';
import { readActiveReconcileSnapshot, validateReconcileScope } from '../reconcile/persistence.ts';
import { DEFAULT_CONSUMER_FRESHNESS_TTL_MS } from '../reconcile/consumer-freshness.ts';
import { claimReviewOrigin, isPlaceholderSourceVersion, isTrustedSustained } from '../reconcile/trusted-sustained.ts';
import { reviewModeSatisfied, type ReviewMode } from '../registry/review-mode.ts';
import { createDependencyRef, invalidateDependencies } from '../reconcile/freshness.ts';
import type { RunBudget } from './run-budget.ts';
import { ROOT, SafeError, failure, trace } from '../runtime.ts';

export type { MemoryOrigin };

/** Per-universe memory of the generic agent. Kept apart from `.concordia/<universe>` (the legacy pipeline's state) so a run never touches it. */
export const AGENT_MEMORY_ACTOR = 'concordia-agent';
/** Without an origin it is the universe root; with one, the store is scoped per execution mode and data origin, so SYNTHETIC offline claims are never reused by a LIVE run. */
export const agentMemoryDir = (universeId: string, origin?: { executionMode: string; dataOrigin: string }) =>
  origin ? path.join(ROOT, '.concordia', 'agent-memory', universeId, `${origin.executionMode}-${origin.dataOrigin}`) : path.join(ROOT, '.concordia', 'agent-memory', universeId);

/**
 * G0-5: the origin of a memory scope is DATA. Every scope carries origin-seal.json (execution mode + data origin); every plan and record call must
 * name an origin (or a directory that names it) and is refused with STATE_SCOPE_MISMATCH when it disagrees with the seal. Scopes created before the seal are
 * sealed once, from their directory name, and the seal stays written. Claims are never rewritten or dropped by sealing.
 */
export const ORIGIN_SEAL_FILE = 'origin-seal.json';
export interface OriginSeal { schemaVersion: 1; executionMode: string; dataOrigin: string; sealedBy: 'CREATED' | 'INFERRED_FROM_DIRECTORY' | 'DECLARED_FOR_LEGACY' | 'LEGACY_UNSCOPED'; sealedAt: string }
const ORIGIN_DIRECTORY = /^(LIVE|LOCAL|REPLAY)-(PUBLIC|SYNTHETIC|USER|UNKNOWN)$/;
export function inferOriginFromDirectory(dir: string): MemoryOrigin | undefined {
  const match = ORIGIN_DIRECTORY.exec(path.basename(dir));
  return match ? { executionMode: match[1], dataOrigin: match[2] } : undefined;
}
const sealPath = (dir: string) => path.join(dir, ORIGIN_SEAL_FILE);
function readSeal(dir: string): OriginSeal | undefined {
  if (!fs.existsSync(sealPath(dir))) return undefined;
  let seal: any; try { seal = JSON.parse(fs.readFileSync(sealPath(dir), 'utf8')); } catch { throw new SafeError('STATE_SCOPE_MISMATCH'); }
  if (!seal || seal.schemaVersion !== 1 || typeof seal.executionMode !== 'string' || typeof seal.dataOrigin !== 'string') throw new SafeError('STATE_SCOPE_MISMATCH');
  return seal as OriginSeal;
}
function writeSeal(dir: string, origin: MemoryOrigin, sealedBy: OriginSeal['sealedBy']): OriginSeal {
  const seal: OriginSeal = { schemaVersion: 1, executionMode: origin.executionMode, dataOrigin: origin.dataOrigin, sealedBy, sealedAt: new Date().toISOString() };
  fs.mkdirSync(validateReconcileScope(dir), { recursive: true });
  fs.writeFileSync(sealPath(dir), JSON.stringify(seal, null, 2) + '\n', { flag: 'wx' });
  return seal;
}
/** Resolves the scope of one plan/record call: origin required, directory derived from it, seal checked (and written for a new or legacy scope when `write`). */
export function resolveMemoryScope(universeId: string, input: { dir?: string; origin?: MemoryOrigin }, write: boolean): { dir: string; origin: MemoryOrigin; seal?: OriginSeal } {
  const inferred = input.dir ? inferOriginFromDirectory(input.dir) : undefined;
  if (input.origin && inferred && (inferred.executionMode !== input.origin.executionMode || inferred.dataOrigin !== input.origin.dataOrigin)) throw new SafeError('STATE_SCOPE_MISMATCH');
  const origin = input.origin ?? inferred;
  if (!origin || !origin.executionMode || !origin.dataOrigin) throw new SafeError('MEMORY_ORIGIN_REQUIRED');
  const dir = input.dir ?? agentMemoryDir(universeId, origin);
  const existing = readSeal(dir);
  if (existing) {
    if (existing.executionMode !== origin.executionMode || existing.dataOrigin !== origin.dataOrigin) throw new SafeError('STATE_SCOPE_MISMATCH');
    return { dir, origin, seal: existing };
  }
  const populated = fs.existsSync(path.join(dir, 'state-manifest.json'));
  if (populated) return { dir, origin, seal: writeSeal(dir, origin, inferred ? 'INFERRED_FROM_DIRECTORY' : 'DECLARED_FOR_LEGACY') };
  return write ? { dir, origin, seal: writeSeal(dir, origin, 'CREATED') } : { dir, origin };
}
/** One-off migration of every memory scope under .concordia/agent-memory: sealed from the directory name, or LEGACY_UNSCOPED (origin UNKNOWN, never reused) when the name carries none. Idempotent; touches no claim. */
export function sealLegacyAgentMemory(root = path.join(ROOT, '.concordia', 'agent-memory')): { dir: string; sealedBy: OriginSeal['sealedBy'] | 'ALREADY_SEALED'; origin: MemoryOrigin }[] {
  const out: { dir: string; sealedBy: OriginSeal['sealedBy'] | 'ALREADY_SEALED'; origin: MemoryOrigin }[] = [];
  const walk = (dir: string) => {
    if (fs.existsSync(path.join(dir, 'state-manifest.json'))) {
      const seal = readSeal(dir);
      if (seal) { out.push({ dir, sealedBy: 'ALREADY_SEALED', origin: { executionMode: seal.executionMode, dataOrigin: seal.dataOrigin } }); return; }
      const inferred = inferOriginFromDirectory(dir), origin = inferred ?? { executionMode: 'UNKNOWN', dataOrigin: 'UNKNOWN' }, sealedBy = inferred ? 'INFERRED_FROM_DIRECTORY' as const : 'LEGACY_UNSCOPED' as const;
      writeSeal(dir, origin, sealedBy); out.push({ dir, sealedBy, origin }); return;
    }
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) if (entry.isDirectory()) walk(path.join(dir, entry.name));
  };
  walk(root);
  return out;
}

export interface LegacySealScopePlan {
  dir: string; scope: string; universeId: string | null; status: 'ALREADY_SEALED' | 'WOULD_SEAL';
  sealedBy: OriginSeal['sealedBy']; origin: MemoryOrigin;
  /** Claims of the scope as they would be read after sealing. `reusable` counts active SOSTENIDA relation claims whose provenance (run id, receipt, REVIEWED contract, real source version, matching origin) allows a warm start; the version and TTL are still checked at plan time. */
  claims: { total: number; sustainedActive: number; reusable: number; notReusable: Record<string, number> };
}
/** Read-only claims of one scope: the active snapshot when there is one, else the compatibility views. Never creates or writes anything. */
function readScopeClaims(dir: string): { claims: Claim[]; superseded: Set<string>; universeId: string | null } {
  const snapshot = (() => { try { return readActiveReconcileSnapshot(dir); } catch { return null; } })();
  if (snapshot) return { claims: snapshot.claims, superseded: new Set(snapshot.memoryState.records.filter(record => (record as { supersededBy?: string }).supersededBy).map(record => record.id)), universeId: snapshot.universeId };
  const read = (name: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return undefined; } };
  const claims = read('claims.json')?.claims, state = read('state.json'), manifest = read('state-manifest.json');
  return { claims: Array.isArray(claims) ? claims : [], superseded: new Set<string>(Array.isArray(state?.records) ? state.records.filter((record: any) => record?.supersededBy).map((record: any) => record.id) : []), universeId: typeof manifest?.universeId === 'string' ? manifest.universeId : null };
}
/** Dry run of sealLegacyAgentMemory: which scopes would be sealed, with what origin, and how many of their claims would be reusable and why the others would not. Writes nothing. */
export function planLegacySeals(root = path.join(ROOT, '.concordia', 'agent-memory')): { scopes: LegacySealScopePlan[]; totals: { scopes: number; wouldSeal: number; alreadySealed: number; sustainedActive: number; reusable: number; notReusable: Record<string, number> } } {
  const scopes: LegacySealScopePlan[] = [];
  const walk = (dir: string) => {
    if (fs.existsSync(path.join(dir, 'state-manifest.json'))) {
      const seal = readSeal(dir), inferred = inferOriginFromDirectory(dir);
      const origin = seal ? { executionMode: seal.executionMode, dataOrigin: seal.dataOrigin } : inferred ?? { executionMode: 'UNKNOWN', dataOrigin: 'UNKNOWN' };
      const sealedBy = seal ? seal.sealedBy : inferred ? 'INFERRED_FROM_DIRECTORY' as const : 'LEGACY_UNSCOPED' as const;
      const { claims, superseded, universeId } = readScopeClaims(dir), notReusable: Record<string, number> = {};
      const active = claims.filter(claim => claim.entity?.startsWith('relation:') && claim.attribute === 'status' && claim.value === 'SOSTENIDA' && claim.invalidatedAt === undefined && !superseded.has(claim.id));
      let reusable = 0;
      for (const claim of active) {
        const reason = !isTrustedSustained(claim) ? (claim.reviewState === undefined ? 'NO_REVIEW_STATE' : claim.reviewState !== 'REVIEWED' ? 'REVIEW_NOT_REVIEWED' : 'NO_RUN_OR_RECEIPT')
          : isPlaceholderSourceVersion(claim.sourceVersion) ? 'PLACEHOLDER_SOURCE_VERSION'
          : origin.executionMode === 'UNKNOWN' || origin.dataOrigin === 'UNKNOWN' ? 'SCOPE_ORIGIN_UNKNOWN'
          : claim.dataOrigin !== undefined && (claim.dataOrigin !== origin.dataOrigin || claim.executionMode !== origin.executionMode) ? 'STAMPED_OTHER_ORIGIN' : undefined;
        if (reason) notReusable[reason] = (notReusable[reason] ?? 0) + 1; else reusable++;
      }
      scopes.push({ dir, scope: memoryScope(dir), universeId, status: seal ? 'ALREADY_SEALED' : 'WOULD_SEAL', sealedBy, origin, claims: { total: claims.length, sustainedActive: active.length, reusable, notReusable } });
      return;
    }
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) if (entry.isDirectory()) walk(path.join(dir, entry.name));
  };
  walk(root);
  const notReusable: Record<string, number> = {};
  for (const scope of scopes) for (const [reason, count] of Object.entries(scope.claims.notReusable)) notReusable[reason] = (notReusable[reason] ?? 0) + count;
  return { scopes, totals: { scopes: scopes.length, wouldSeal: scopes.filter(scope => scope.status === 'WOULD_SEAL').length, alreadySealed: scopes.filter(scope => scope.status === 'ALREADY_SEALED').length,
    sustainedActive: scopes.reduce((sum, scope) => sum + scope.claims.sustainedActive, 0), reusable: scopes.reduce((sum, scope) => sum + scope.claims.reusable, 0), notReusable } };
}

export interface MemoryClaimView {
  id: string; relationId: string; attribute: string; value: string; source: string; sourceVersion: string; rule: string; observedAt: string;
  /** Run that first wrote the claim; later runs that re-observed it are in `runIds`. */
  /** Label only (observed / reviewed / reused): never ranks claims or changes a decision. `reusedBy` lists the runs that reused it. */
  tier: ClaimTier; reusedBy: string[];
  /** Bi-temporal: world time (validFrom / validTo) and transaction time (recordedAt / supersededAt). */
  validFrom: string; validTo: string | null; recordedAt: string; supersededAt: string | null;
  /** R6-M5: invalidated (directly or through derived_from); `invalidatedBy` is the root claim. */
  /** R-seal: who reviewed the contract behind the claim (null when it has no review). */
  reviewOrigin: 'HUMAN_REVIEWED' | 'MODEL_REVIEWED' | null;
  invalidated: boolean; invalidatedBy: string | null;
  /** M8-2: STALE because a claim it derives from was invalidated or degraded; `staleBy` is the cause claim. */
  stale: boolean; staleBy: string | null;
  firstRunId: string | null; runIds: string[]; requestIds: string[]; superseded: boolean; supersededBy: string | null;
}
export interface MemoryConflictView { id: string; entity: string; attribute: string; status: Conflict['status']; version: number; claimIds: string[]; winner: string | null }
/** M8-2: a claim made STALE because a claim it derives from was invalidated or degraded; a human decides what happens to it. */
export interface StaleReviewItem { kind: 'STALE_DEPENDENCY'; claimId: string; entity: string; attribute: string; causeClaimId: string; reason: string; staleAt: string }
/** E1-02: a claim rejected by the strict gate, held apart from the sealed memory for a human. Never read as a claim. */
export interface QuarantineReviewItem { kind: 'QUARANTINED_CLAIM'; relationId: string; entity: string; code: string; reason: string; runId: string | null; quarantineFile: string }
/** E1-02: the batch denominators of the run's memory write. `rejected` + `admitted` = `total` unless the batch was unhealthy (then admitted is 0 and nothing was written). */
export interface MemoryBatchReport { total: number; admitted: number; rejected: number; rejectedShare: number; threshold: { minRejected: number; maxRejectedShare: number }; unhealthy: boolean; written: boolean; quarantineFile: string | null; reasons: { relationId: string; code: string; reason: string }[] }
export interface ReviewQueueItem { conflictId: string; entity: string; attribute: string; version: number; claimIds: string[]; strategy: string }
/** The `memory` field of engine-run.json (contract with the report). */
export interface AgentMemoryReport {
  schemaVersion: 1;
  /** RECORDED: all written. DEGRADED: some claims rejected into quarantine (see `batch`). FAILED: batch unhealthy, nothing written (error MEMORY_BATCH_UNHEALTHY). */
  status: 'RECORDED' | 'DEGRADED' | 'FAILED' | 'SKIPPED' | 'ERROR';
  runId: string; universeId: string; scope: string;
  /** Sealed origin of the memory scope this run read and wrote. */
  origin?: MemoryOrigin;
  /** Claims this run observed or wrote (each carries every run id that observed it). */
  claims: MemoryClaimView[];
  conflicts: MemoryConflictView[];
  reviewQueue: (ReviewQueueItem | StaleReviewItem | QuarantineReviewItem)[];
  /** E1-02: n/N of the write, the rejections with their reasons, and where the quarantine file is. Present whenever the run had sustained claims to write. */
  batch?: MemoryBatchReport;
  ledger: { entries: number; appendOnly: true };
  /** 3.2: what the warm start reused instead of re-probing (absent on a cold start). */
  reuse?: WarmStartReport;
  /** 3.3: what re-describing the reused relations' tables found, inside the run budget. */
  revalidation?: RevalidationReport;
  /** N2: negative memory of the model review. reused = remembered rejects/defers the review did not pay for again; recorded = new ones written; invalidated = relations whose remembered decision no longer applies (fingerprint or prompt version changed). Never approvals. */
  reviewDecisions?: { reused: number; recorded: number; invalidated: number; reusedIds: string[]; invalidatedIds: string[] };
  reason?: string; error?: object;
}

const memoryScope = (dir: string) => path.relative(ROOT, dir).split(path.sep).join('/');

function claimView(reconciler: Reconciler, claim: Claim): MemoryClaimView {
  const record = reconciler.hmem.store.get(claim.id), runIds = [...new Set((claim.observations ?? []).flatMap(item => item.runId ? [item.runId] : []))];
  return { id: claim.id, ...(({ legacy: _legacy, ...time }) => time)(claimTime(claim, !!record?.supersededBy)), reviewOrigin: claimReviewOrigin(claim) ?? null, invalidated: claim.invalidatedAt !== undefined, invalidatedBy: claim.invalidatedBy ?? null, stale: claim.staleAt !== undefined, staleBy: claim.staleBy ?? null, tier: claimTier(claim), reusedBy: [...new Set((claim.observations ?? []).filter(item => item.tier === 'reused' && item.runId).map(item => item.runId!))], relationId: claim.entity.replace(/^relation:/, ''), attribute: claim.attribute, value: claim.value, source: claim.source, sourceVersion: claim.sourceVersion ?? 'unspecified', rule: claim.rule ?? 'unspecified',
    observedAt: claim.observedAt ?? '', firstRunId: claim.runId ?? runIds[0] ?? null, runIds, requestIds: [...claim.requestIds], superseded: !!record?.supersededBy, supersededBy: record?.supersededBy ?? null };
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Version of what a relation's evidence depends on: both tables' described columns and source versions plus the relation's
 * declared key mapping and normalization. Any change makes remembered evidence for it a different version.
 */
export function relationVersion(discovery: any, relation: { from: { db?: string; table: string; column: string }; to: { db?: string; table: string; column: string }; normalization?: string }): string {
  const side = (ref: { table: string }) => { const table = discovery?.tables?.[ref.table]; return [table?.sourceVersion ?? null, table?.sourceMetadata?.rows ?? null]; };
  return 'rv1:' + sha([side(relation.from), side(relation.to), relation.from, relation.to, relation.normalization ?? null]).slice(0, 24);
}
const versionOfProbe = (discovery: any, probe: any) => relationVersion(discovery, { from: probe.from, to: probe.to, normalization: probe.normalization ?? probe.evidence?.normalization });

export type ReprobeReason = 'NO_MEMORY' | 'NOT_SUSTAINED' | 'VERSION_CHANGED' | 'EXPIRED' | 'UNTRUSTED_PROVENANCE' | 'INVALIDATED' | 'STALE_DEPENDENCY' | 'REVIEW_ORIGIN_MISMATCH';
export interface WarmStartReport {
  schemaVersion: 1; mode: 'COLD' | 'WARM';
  reused: { relationId: string; claimId: string; version: string; reusedFromRunId: string | null; queriesSaved: number; /** R-seal: origin of the reused claim's review. */ reviewOrigin?: 'HUMAN_REVIEWED' | 'MODEL_REVIEWED' }[];
  reprobe: { relationId: string; reason: ReprobeReason; rememberedVersion?: string; currentVersion: string }[];
  queriesSaved: number;
  /** Observations dated after the clock or after the moment they were recorded; they were clipped, not trusted (CLOCK_SKEW). */
  clockSkew?: { relationId: string; claimId: string; observedAt: string; clippedTo: string }[];
}
export interface WarmStartInput {
  universeId: string; discovery: any;
  /** Configured relations that exist in this discovery (the ones the run could probe). */
  relations: { id: string; from: { db?: string; table: string; column: string }; to: { db?: string; table: string; column: string }; normalization?: string; /** Declared review mode of the relation (R-config); when present the reused claim must satisfy it. */ reviewMode?: ReviewMode }[];
  dir?: string; /** Execution mode and data origin of the run; required unless `dir` is an origin-named scope directory. */ origin?: MemoryOrigin; ttlMs?: number; now?: () => number;
}

/**
 * Migration of legacy claims (written before the review stamp): they are never reused as they are. The documented path is ONE strict run that re-probes the relation:
 * its fresh observation (run id, receipt, REVIEWED contract) stamps the legacy claim in place (reviewState, origin) and refreshes lastObservedAt; no claim is rewritten otherwise and none is dropped.
 *
 * 3.2: decides, per configured relation, whether memory already holds current evidence. A relation is REUSED only when its
 * active claim is SOSTENIDA, was recorded under exactly the current version and has not expired; anything else is re-probed with
 * the reason. Reading memory never creates it: a missing scope is a cold start.
 */
export function planWarmStart(input: WarmStartInput): WarmStartReport {
  const { dir, origin } = resolveMemoryScope(input.universeId, input, false), now = (input.now ?? Date.now)();
  const reprobeAll = (reason: ReprobeReason): WarmStartReport => ({ schemaVersion: 1, mode: 'COLD', reused: [], queriesSaved: 0,
    reprobe: input.relations.map(relation => ({ relationId: relation.id, reason, currentVersion: relationVersion(input.discovery, relation) })) });
  if (!fs.existsSync(path.join(dir, 'state-manifest.json'))) return reprobeAll('NO_MEMORY');
  const reconciler = new Reconciler(input.universeId, dir, AGENT_MEMORY_ACTOR, { strictSustained: true, origin });
  const report: WarmStartReport = { schemaVersion: 1, mode: 'WARM', reused: [], reprobe: [], queriesSaved: 0 };
  for (const relation of input.relations) {
    const currentVersion = relationVersion(input.discovery, relation);
    const claims = reconciler.claims.filter(claim => claim.entity === 'relation:' + relation.id && claim.attribute === 'status');
    const active = claims.filter(claim => !reconciler.hmem.store.get(claim.id)?.supersededBy && claim.invalidatedAt === undefined && claim.staleAt === undefined);
    const sustainedAll = active.filter(claim => claim.value === 'SOSTENIDA');
    // R-seal: a SOSTENIDA that does not satisfy the relation's declared review mode (a model review where a human is required) is never reused.
    const originOf = (origin: 'HUMAN_REVIEWED' | 'MODEL_REVIEWED') => sustainedAll.find(claim => claimReviewOrigin(claim) === origin);
    const obtained = sustainedAll.flatMap(claim => claimReviewOrigin(claim) ?? []);
    const slotFilled = relation.reviewMode === undefined || reviewModeSatisfied(relation.reviewMode, obtained);
    // The claim that fills the slot: the one of the origin the mode asks for (a human one for BOTH, which needs a model one as well); an undeclared mode takes the first.
    const sustained = !slotFilled ? undefined : relation.reviewMode === undefined ? sustainedAll[0] : relation.reviewMode === 'MODEL_ADVERSARIAL' ? originOf('MODEL_REVIEWED') : (originOf('HUMAN_REVIEWED') ?? originOf('MODEL_REVIEWED'));
    if (!claims.length) { report.reprobe.push({ relationId: relation.id, reason: 'NO_MEMORY', currentVersion }); continue; }
    if (!sustained && sustainedAll.length) { report.reprobe.push({ relationId: relation.id, reason: 'REVIEW_ORIGIN_MISMATCH', currentVersion }); continue; }
    if (!sustained) { report.reprobe.push({ relationId: relation.id, reason: claims.some(claim => claim.value === 'SOSTENIDA' && claim.invalidatedAt !== undefined && !reconciler.hmem.store.get(claim.id)?.supersededBy) ? 'INVALIDATED' : claims.some(claim => claim.value === 'SOSTENIDA' && claim.staleAt !== undefined && claim.invalidatedAt === undefined && !reconciler.hmem.store.get(claim.id)?.supersededBy) ? 'STALE_DEPENDENCY' : 'NOT_SUSTAINED', currentVersion }); continue; }
    // A claim with no real source version cannot be shown current: it is never reused (G1).
    if (isPlaceholderSourceVersion(sustained.sourceVersion)) { report.reprobe.push({ relationId: relation.id, reason: 'UNTRUSTED_PROVENANCE', currentVersion }); continue; }
    if (sustained.sourceVersion !== currentVersion) { report.reprobe.push({ relationId: relation.id, reason: 'VERSION_CHANGED', rememberedVersion: sustained.sourceVersion, currentVersion }); continue; }
    // Only a claim that carries its run id and the request receipts of the probes behind it can be reused (R6-M2): memory without provenance is re-probed.
    const stampedElsewhere = sustained.dataOrigin !== undefined && (sustained.dataOrigin !== origin.dataOrigin || sustained.executionMode !== origin.executionMode);
    if (!isTrustedSustained(sustained) || stampedElsewhere) { report.reprobe.push({ relationId: relation.id, reason: 'UNTRUSTED_PROVENANCE', rememberedVersion: sustained.sourceVersion, currentVersion }); continue; }
    // Freshness is measured from the most recent PROBED observation (RC-4): a relation that keeps being re-observed stays fresh; a reuse does not refresh it.
    const probedTimes = [sustained.lastObservedAt, sustained.observedAt, ...(sustained.observations ?? []).filter(item => item.rule !== 'reused_from_memory').map(item => item.observedAt)].filter((value): value is string => typeof value === 'string').map(value => Date.parse(value)).filter(Number.isFinite);
    let observedMs = probedTimes.length ? Math.max(...probedTimes) : NaN;
    // An observation cannot be later than the clock: a future observedAt would stretch the TTL, so it is clipped to now and traced (CLOCK_SKEW).
    const ceiling = now;
    if (Number.isFinite(observedMs) && observedMs > ceiling) {
      (report.clockSkew ??= []).push({ relationId: relation.id, claimId: sustained.id, observedAt: new Date(observedMs).toISOString(), clippedTo: new Date(ceiling).toISOString() });
      trace({ kind: 'memory-clock-skew', code: 'CLOCK_SKEW', relationId: relation.id, claimId: sustained.id });
      observedMs = ceiling;
    }
    // No caller-supplied TTL means the consumer-freshness default, never an eternal REUSED (G1).
    const ttlMs = input.ttlMs ?? DEFAULT_CONSUMER_FRESHNESS_TTL_MS;
    if (!Number.isFinite(observedMs) || now - observedMs > ttlMs) { report.reprobe.push({ relationId: relation.id, reason: 'EXPIRED', rememberedVersion: sustained.sourceVersion, currentVersion }); continue; }
    const observedBy = (sustained.observations ?? []).find(item => item.runId && item.rule !== 'reused_from_memory');
    const queriesSaved = sustained.requestIds.length;
    report.reused.push({ relationId: relation.id, claimId: sustained.id, version: currentVersion, reusedFromRunId: observedBy?.runId ?? sustained.runId ?? null, queriesSaved, ...(claimReviewOrigin(sustained) ? { reviewOrigin: claimReviewOrigin(sustained)! } : {}) });
    report.queriesSaved += queriesSaved;
  }
  return report;
}

export interface RevalidationReport {
  schemaVersion: 1;
  /** Relations whose tables were re-described and still match the remembered version: REUSED stands. */
  confirmed: string[];
  /** Relations whose tables changed since the remembered evidence: no longer reusable, re-probe, dependents invalidated. */
  altered: { relationId: string; rememberedVersion: string; currentVersion: string; invalidated: string[] }[];
  /** Relations not re-described because the run budget could not afford it; they are not claimed fresh and are re-probed. */
  unverified: { relationId: string; reason: 'QUERY_BUDGET_EXHAUSTED' | 'DESCRIBE_FAILED' }[];
  queriesSpent: number; probesSaved: number; queriesSavedByReuse: number;
}
type DescribeClient = { describe: (db: string, physicalTable: string) => Promise<{ rows: unknown[][] }> };

/**
 * 3.3: revalidation by freshness as an agent action. Each distinct table behind a REUSED relation is re-described once, charged to
 * the run budget before the call; a relation whose tables still yield the remembered version stays REUSED, an altered one is
 * dropped from REUSED and its dependents (evidence, claim, decision) are invalidated. It never writes memory and never changes a verdict.
 */
export async function revalidateWarmStart(input: { plan: WarmStartReport; cfg: any; discovery: any; client: DescribeClient; budget: RunBudget; relations: WarmStartInput['relations'] }): Promise<{ plan: WarmStartReport; revalidation: RevalidationReport }> {
  const byId = new Map(input.relations.map(relation => [relation.id, relation]));
  const described = new Map<string, unknown[][] | 'BUDGET' | 'FAILED'>();
  let spent = 0;
  const describeTable = async (table: string) => {
    if (described.has(table)) return;
    const spec = input.cfg.tables?.[table];
    if (!spec) { described.set(table, 'FAILED'); return; }
    if (!input.budget.canQuery()) { described.set(table, 'BUDGET'); return; }
    input.budget.chargeQuery(); spent++;
    try { described.set(table, (await input.client.describe(spec.db, spec.physicalTable)).rows); } catch { described.set(table, 'FAILED'); }
  };
  const revalidation: RevalidationReport = { schemaVersion: 1, confirmed: [], altered: [], unverified: [], queriesSpent: 0, probesSaved: 0, queriesSavedByReuse: 0 };
  const stillReused: WarmStartReport['reused'] = [], reprobe = [...input.plan.reprobe];
  for (const reused of input.plan.reused) {
    const relation = byId.get(reused.relationId);
    if (!relation) { revalidation.unverified.push({ relationId: reused.relationId, reason: 'DESCRIBE_FAILED' }); continue; }
    await describeTable(relation.from.table); await describeTable(relation.to.table);
    const sides = [relation.from.table, relation.to.table].map(table => described.get(table));
    const failed = sides.find(side => side === 'BUDGET' || side === 'FAILED');
    if (failed) { revalidation.unverified.push({ relationId: reused.relationId, reason: failed === 'BUDGET' ? 'QUERY_BUDGET_EXHAUSTED' : 'DESCRIBE_FAILED' }); reprobe.push({ relationId: reused.relationId, reason: 'VERSION_CHANGED', rememberedVersion: reused.version, currentVersion: 'UNVERIFIED' }); continue; }
    const fresh = { tables: Object.fromEntries([relation.from.table, relation.to.table].map(table => [table, { sourceVersion: input.discovery?.tables?.[table]?.sourceVersion, sourceMetadata: { rows: described.get(table) } }])) };
    const currentVersion = relationVersion(fresh, relation);
    if (currentVersion === reused.version) { stillReused.push(reused); revalidation.confirmed.push(reused.relationId); continue; }
    const refs = [createDependencyRef(`evidence:${reused.relationId}`, 'evidence', [reused.relationId], reused.version), createDependencyRef(`claim:${reused.claimId}`, 'claim', [`evidence:${reused.relationId}`], reused.version),
      createDependencyRef(`decision:${reused.relationId}`, 'decision', [`claim:${reused.claimId}`], reused.version)];
    revalidation.altered.push({ relationId: reused.relationId, rememberedVersion: reused.version, currentVersion, invalidated: invalidateDependencies(refs, [reused.relationId]).filter(ref => ref.state === 'STALE').map(ref => ref.id) });
    reprobe.push({ relationId: reused.relationId, reason: 'VERSION_CHANGED', rememberedVersion: reused.version, currentVersion });
  }
  revalidation.queriesSpent = spent; revalidation.probesSaved = stillReused.length; revalidation.queriesSavedByReuse = stillReused.reduce((sum, item) => sum + item.queriesSaved, 0);
  return { plan: { ...input.plan, reused: stillReused, reprobe, queriesSaved: revalidation.queriesSavedByReuse }, revalidation };
}

/** Pure projection of the reconciler state for one run; reading it never writes. */
export function memoryReport(reconciler: Reconciler, runId: string, scope: string, extra: Partial<AgentMemoryReport> = {}): AgentMemoryReport {
  const touched = reconciler.claims.filter(claim => (claim.observations ?? []).some(item => item.runId === runId) || claim.runId === runId);
  const conflicts = reconciler.conflicts;
  return { schemaVersion: 1, status: 'RECORDED', runId, universeId: reconciler.universeId, scope, claims: touched.map(claim => claimView(reconciler, claim)),
    conflicts: conflicts.map(conflict => ({ id: conflict.id, entity: conflict.entity, attribute: conflict.attribute, status: conflict.status, version: conflict.version, claimIds: [...conflict.claimIds], winner: conflict.winner ?? null })),
    reviewQueue: (conflicts.filter(conflict => conflict.status === 'queued').map(conflict => ({ conflictId: conflict.id, entity: conflict.entity, attribute: conflict.attribute, version: conflict.version, claimIds: [...conflict.claimIds], strategy: conflict.strategy })) as (ReviewQueueItem | StaleReviewItem)[]).concat(reconciler.claims.filter(claim => claim.staleAt !== undefined && claim.invalidatedAt === undefined).map((claim): StaleReviewItem => ({ kind: 'STALE_DEPENDENCY', claimId: claim.id, entity: claim.entity, attribute: claim.attribute, causeClaimId: claim.staleBy ?? '', reason: claim.staleReason ?? '', staleAt: claim.staleAt! }))),
    ledger: { entries: reconciler.hmem.ledger.all().length, appendOnly: true }, ...extra };
}

export interface RecordRunMemoryInput {
  universeId: string; runId: string; discovery: any;
  /** Typed probe results of the run (`report.artifacts.probes`); only these feed memory, never model text. */
  probes: any[];
  dir?: string;
  /** Execution mode and data origin of the run; required unless `dir` is an origin-named scope directory. */
  origin?: MemoryOrigin;
  /** Warm-start outcome of this run; its REUSED relations are recorded as observations of the run, not as new votes. */
  warmStart?: WarmStartReport;
  revalidation?: RevalidationReport;
  /** Injected clock (ISO) for the transaction times written to the claims; defaults to the real one. */
  now?: () => string;
}

/**
 * 3.1: writes the run's deterministic probe results into the Reconciler/H-MEM facade as claims stamped with the run id.
 * Only relation claims are written (SOSTENIDA verdicts, critic/freshness degradations, verdict drift); the ledger only appends
 * and a re-observation by a later run is recorded as an observation, not as a second vote.
 */
export function recordRunMemory(input: RecordRunMemoryInput): AgentMemoryReport {
  const unresolved = input.dir ?? (input.origin ? agentMemoryDir(input.universeId, input.origin) : undefined);
  if (!input.probes.length && !input.warmStart?.reused.length) return { schemaVersion: 1, status: 'SKIPPED', runId: input.runId, universeId: input.universeId, scope: unresolved ? memoryScope(unresolved) : 'UNRESOLVED', claims: [], conflicts: [], reviewQueue: [], ledger: { entries: 0, appendOnly: true }, reason: 'no probe results to remember' };
  let dir: string, origin: MemoryOrigin;
  try { ({ dir, origin } = resolveMemoryScope(input.universeId, input, true)); }
  catch (error) { return { schemaVersion: 1, status: 'ERROR', runId: input.runId, universeId: input.universeId, scope: unresolved ? memoryScope(unresolved) : 'UNRESOLVED', claims: [], conflicts: [], reviewQueue: [], ledger: { entries: 0, appendOnly: true }, error: failure(error) }; }
  const scope = memoryScope(dir);
  try {
    const reconciler = new Reconciler(input.universeId, dir, AGENT_MEMORY_ACTOR, { strictSustained: true, origin, ...(input.now ? { now: input.now } : {}) });
    const versioned = input.probes.map(probe => probe?.from && probe?.to ? { ...probe, evidence: { ...probe.evidence, sourceVersion: versionOfProbe(input.discovery, probe) } } : probe);
    let batch: MemoryBatchReport | undefined, quarantineItems: QuarantineReviewItem[] = [];
    if (versioned.length) {
      reconciler.ingest(input.discovery, { relations: versioned }, { runId: input.runId });
      const outcome = reconciler.lastBatch;
      if (outcome && outcome.total > 0) {
        const file = outcome.rejected.length ? writeQuarantine(dir, scope, input.universeId, input.runId, outcome.rejected, outcome, input.now?.() ?? new Date().toISOString()) : null;
        quarantineItems = outcome.rejected.map(item => ({ kind: 'QUARANTINED_CLAIM', relationId: item.relationId, entity: item.entity, code: item.code, reason: item.reason, runId: item.runId, quarantineFile: file! }));
        batch = { total: outcome.total, admitted: outcome.admitted, rejected: outcome.rejected.length, rejectedShare: Math.round(outcome.rejected.length / outcome.total * 1000) / 1000, threshold: outcome.threshold, unhealthy: outcome.unhealthy, written: !outcome.unhealthy, quarantineFile: file,
          reasons: outcome.rejected.map(item => ({ relationId: item.relationId, code: item.code, reason: item.reason })) };
      }
    }
    if (batch?.unhealthy) {
      return { ...memoryReport(reconciler, input.runId, scope, { origin }), status: 'FAILED', claims: [], reviewQueue: quarantineItems, batch, error: { code: 'MEMORY_BATCH_UNHEALTHY', message: `${batch.rejected} of ${batch.total} claims rejected (> ${batch.threshold.maxRejectedShare * 100}% and >= ${batch.threshold.minRejected}); nothing written` } };
    }
    for (const reused of input.warmStart?.reused ?? []) {
      const claim = reconciler.claims.find(candidate => candidate.id === reused.claimId);
      if (claim) reconciler.addClaim({ entity: claim.entity, attribute: claim.attribute, value: claim.value, source: claim.source, confidence: claim.confidence, requestIds: [...claim.requestIds],
        sourceVersion: reused.version, observedAt: claim.observedAt, rule: 'reused_from_memory', runId: input.runId, reviewState: claim.reviewState, ...(claim.reviewOrigin ? { reviewOrigin: claim.reviewOrigin } : {}) });
      // M8-2: a reuse creates no claim of its own. It is an observation of the original claim, so invalidating or degrading the original already excludes the reuse
      // (warm start says INVALIDATED / STALE_DEPENDENCY on the original) without an extra node. The real production derivations are human corrections (derivedFrom the alternatives).
    }
    const report = memoryReport(reconciler, input.runId, scope, { origin, ...(batch ? { batch } : {}), ...(batch?.rejected ? { status: 'DEGRADED' as const } : {}), ...(input.warmStart ? { reuse: input.warmStart } : {}), ...(input.revalidation ? { revalidation: input.revalidation } : {}) });
    return quarantineItems.length ? { ...report, reviewQueue: [...report.reviewQueue, ...quarantineItems] } : report;
  } catch (error) {
    return { schemaVersion: 1, status: 'ERROR', runId: input.runId, universeId: input.universeId, scope, claims: [], conflicts: [], reviewQueue: [], ledger: { entries: 0, appendOnly: true }, error: failure(error) };
  }
}

/**
 * E1-02 quarantine: rejected claims live in `<scope>/quarantine/<runId>.json`, outside the sealed memory. Nothing reads this directory as claims (warm start and reconcile open only the snapshot);
 * it is a queue for a human, with the full reason, the run id and the evidence of each rejection. Re-writing the same run replaces the same file.
 */
export const QUARANTINE_DIR = 'quarantine';
function writeQuarantine(dir: string, scope: string, universeId: string, runId: string, rejected: readonly BatchRejection[], outcome: { total: number; admitted: number; unhealthy: boolean; threshold: object }, at: string): string {
  const file = path.join(dir, QUARANTINE_DIR, `${runId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: 'MEMORY_QUARANTINE', runId, universeId, scope, writtenAt: at, total: outcome.total, admitted: outcome.admitted, unhealthy: outcome.unhealthy, threshold: outcome.threshold, rejected }, null, 2) + '\n');
  return path.relative(ROOT, file).split(path.sep).join('/');
}
/** Quarantined items of a scope, for a human review queue. Never claims. */
export function readQuarantine(dir: string): { runId: string; file: string; rejected: BatchRejection[] }[] {
  const root = path.join(dir, QUARANTINE_DIR);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(name => name.endsWith('.json')).sort().map(name => { const body = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); return { runId: String(body.runId), file: path.relative(ROOT, path.join(root, name)).split(path.sep).join('/'), rejected: body.rejected as BatchRejection[] }; });
}

export interface IngestRunInput { runDir: string; universeId: string; dryRun?: boolean; dir?: string; now?: () => string }
export interface IngestRunResult { status: 'INGESTED' | 'ALREADY_INGESTED' | 'DRY_RUN' | 'FAILED'; runId: string; scope: string; wouldWrite?: { total: number; admitted: number; rejected: number }; ledgerPrefixPreserved?: boolean; memory?: AgentMemoryReport }
/**
 * E1-02 / E6-05: re-ingests a finished run into agent memory from its own artifacts (engine-run.json, artifacts.json, discovery.json) through the same two-phase + quarantine + threshold path.
 * Offline, idempotent (a run the memory already holds writes nothing again), and it refuses a scope whose origin seal disagrees with the run's origin. The ledger prefix is checked before and after.
 */
export function ingestRunMemory(input: IngestRunInput): IngestRunResult {
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(input.runDir, name), 'utf8'));
  const engine = read('engine-run.json'), artifacts = read('artifacts.json'), discovery = read('discovery.json');
  if (engine.universeId !== undefined && engine.universeId !== input.universeId) throw new SafeError('MEMORY_INGEST_UNIVERSE_MISMATCH');
  const runId = String(engine.runId ?? artifacts.runId), origin: MemoryOrigin = { executionMode: String(artifacts.executionMode ?? engine.executionMode), dataOrigin: String(artifacts.dataOrigin ?? engine.dataOrigin) };
  const { dir } = resolveMemoryScope(input.universeId, { ...(input.dir ? { dir: input.dir } : {}), origin }, !input.dryRun);
  const scope = memoryScope(dir);
  const probes: any[] = Array.isArray(artifacts.probes) ? artifacts.probes : [];
  const held = fs.existsSync(dir) && new Reconciler(input.universeId, dir, AGENT_MEMORY_ACTOR, { strictSustained: true, origin, ...(input.now ? { now: input.now } : {}) }).claims.some(claim => claim.runId === runId || (claim.observations ?? []).some(item => item.runId === runId)) || fs.existsSync(path.join(dir, QUARANTINE_DIR, `${runId}.json`));
  if (held) return { status: 'ALREADY_INGESTED', runId, scope };
  if (input.dryRun) {
    const sustained = probes.filter(probe => probe?.verdict === 'SOSTENIDA');
    const rejected = sustained.filter(probe => !((probe.relationContract ?? probe.evidence?.relationContract)?.reviewState === 'REVIEWED' && (probe.evidence?.queries ?? []).some((q: any) => q?.requestId))).length;
    return { status: 'DRY_RUN', runId, scope, wouldWrite: { total: sustained.length, admitted: sustained.length - rejected, rejected } };
  }
  const digest = () => new Reconciler(input.universeId, dir, AGENT_MEMORY_ACTOR, { strictSustained: true, origin }).hmem.ledger.all().map(entry => sha(entry));
  const before = digest();
  const memory = recordRunMemory({ universeId: input.universeId, runId, discovery, probes, dir, origin, ...(input.now ? { now: input.now } : {}) });
  const after = digest(), preserved = before.every((item, index) => after[index] === item);
  return { status: memory.status === 'FAILED' || memory.status === 'ERROR' || !preserved ? 'FAILED' : 'INGESTED', runId, scope, ledgerPrefixPreserved: preserved, memory };
}
