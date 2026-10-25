import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Reconciler, type Claim, type Conflict } from '../reconcile/index.ts';
import { createDependencyRef, invalidateDependencies } from '../reconcile/freshness.ts';
import type { RunBudget } from './run-budget.ts';
import { ROOT, failure } from '../runtime.ts';

/** Per-universe memory of the generic agent. Kept apart from `.concordia/<universe>` (the legacy pipeline's state) so a run never touches it. */
export const AGENT_MEMORY_ACTOR = 'concordia-agent';
/** Without an origin it is the universe root; with one, the store is scoped per execution mode and data origin, so SYNTHETIC offline claims are never reused by a LIVE run. */
export const agentMemoryDir = (universeId: string, origin?: { executionMode: string; dataOrigin: string }) =>
  origin ? path.join(ROOT, '.concordia', 'agent-memory', universeId, `${origin.executionMode}-${origin.dataOrigin}`) : path.join(ROOT, '.concordia', 'agent-memory', universeId);

export interface MemoryClaimView {
  id: string; relationId: string; attribute: string; value: string; source: string; sourceVersion: string; rule: string; observedAt: string;
  /** Run that first wrote the claim; later runs that re-observed it are in `runIds`. */
  firstRunId: string | null; runIds: string[]; requestIds: string[]; superseded: boolean; supersededBy: string | null;
}
export interface MemoryConflictView { id: string; entity: string; attribute: string; status: Conflict['status']; version: number; claimIds: string[]; winner: string | null }
export interface ReviewQueueItem { conflictId: string; entity: string; attribute: string; version: number; claimIds: string[]; strategy: string }
/** The `memory` field of engine-run.json (contract with the report). */
export interface AgentMemoryReport {
  schemaVersion: 1;
  status: 'RECORDED' | 'SKIPPED' | 'ERROR';
  runId: string; universeId: string; scope: string;
  /** Claims this run observed or wrote (each carries every run id that observed it). */
  claims: MemoryClaimView[];
  conflicts: MemoryConflictView[];
  reviewQueue: ReviewQueueItem[];
  ledger: { entries: number; appendOnly: true };
  /** 3.2: what the warm start reused instead of re-probing (absent on a cold start). */
  reuse?: WarmStartReport;
  /** 3.3: what re-describing the reused relations' tables found, inside the run budget. */
  revalidation?: RevalidationReport;
  reason?: string; error?: object;
}

const memoryScope = (dir: string) => path.relative(ROOT, dir).split(path.sep).join('/');

function claimView(reconciler: Reconciler, claim: Claim): MemoryClaimView {
  const record = reconciler.hmem.store.get(claim.id), runIds = [...new Set((claim.observations ?? []).flatMap(item => item.runId ? [item.runId] : []))];
  return { id: claim.id, relationId: claim.entity.replace(/^relation:/, ''), attribute: claim.attribute, value: claim.value, source: claim.source, sourceVersion: claim.sourceVersion ?? 'unspecified', rule: claim.rule ?? 'unspecified',
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

export type ReprobeReason = 'NO_MEMORY' | 'NOT_SUSTAINED' | 'VERSION_CHANGED' | 'EXPIRED';
export interface WarmStartReport {
  schemaVersion: 1; mode: 'COLD' | 'WARM';
  reused: { relationId: string; claimId: string; version: string; reusedFromRunId: string | null; queriesSaved: number }[];
  reprobe: { relationId: string; reason: ReprobeReason; rememberedVersion?: string; currentVersion: string }[];
  queriesSaved: number;
}
export interface WarmStartInput {
  universeId: string; discovery: any;
  /** Configured relations that exist in this discovery (the ones the run could probe). */
  relations: { id: string; from: { db?: string; table: string; column: string }; to: { db?: string; table: string; column: string }; normalization?: string }[];
  dir?: string; ttlMs?: number; now?: () => number;
}

/**
 * 3.2: decides, per configured relation, whether memory already holds current evidence. A relation is REUSED only when its
 * active claim is SOSTENIDA, was recorded under exactly the current version and has not expired; anything else is re-probed with
 * the reason. Reading memory never creates it: a missing scope is a cold start.
 */
export function planWarmStart(input: WarmStartInput): WarmStartReport {
  const dir = input.dir ?? agentMemoryDir(input.universeId), now = (input.now ?? Date.now)();
  const reprobeAll = (reason: ReprobeReason): WarmStartReport => ({ schemaVersion: 1, mode: 'COLD', reused: [], queriesSaved: 0,
    reprobe: input.relations.map(relation => ({ relationId: relation.id, reason, currentVersion: relationVersion(input.discovery, relation) })) });
  if (!fs.existsSync(path.join(dir, 'state-manifest.json'))) return reprobeAll('NO_MEMORY');
  const reconciler = new Reconciler(input.universeId, dir, AGENT_MEMORY_ACTOR);
  const report: WarmStartReport = { schemaVersion: 1, mode: 'WARM', reused: [], reprobe: [], queriesSaved: 0 };
  for (const relation of input.relations) {
    const currentVersion = relationVersion(input.discovery, relation);
    const claims = reconciler.claims.filter(claim => claim.entity === 'relation:' + relation.id && claim.attribute === 'status');
    const active = claims.filter(claim => !reconciler.hmem.store.get(claim.id)?.supersededBy);
    const sustained = active.find(claim => claim.value === 'SOSTENIDA');
    if (!claims.length) { report.reprobe.push({ relationId: relation.id, reason: 'NO_MEMORY', currentVersion }); continue; }
    if (!sustained) { report.reprobe.push({ relationId: relation.id, reason: 'NOT_SUSTAINED', currentVersion }); continue; }
    if (sustained.sourceVersion !== currentVersion) { report.reprobe.push({ relationId: relation.id, reason: 'VERSION_CHANGED', rememberedVersion: sustained.sourceVersion, currentVersion }); continue; }
    const observedMs = Date.parse(sustained.observedAt ?? '');
    if (input.ttlMs !== undefined && (!Number.isFinite(observedMs) || now - observedMs > input.ttlMs)) { report.reprobe.push({ relationId: relation.id, reason: 'EXPIRED', rememberedVersion: sustained.sourceVersion, currentVersion }); continue; }
    const origin = (sustained.observations ?? []).find(item => item.runId && item.rule !== 'reused_from_memory');
    const queriesSaved = sustained.requestIds.length;
    report.reused.push({ relationId: relation.id, claimId: sustained.id, version: currentVersion, reusedFromRunId: origin?.runId ?? sustained.runId ?? null, queriesSaved });
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
    reviewQueue: conflicts.filter(conflict => conflict.status === 'queued').map(conflict => ({ conflictId: conflict.id, entity: conflict.entity, attribute: conflict.attribute, version: conflict.version, claimIds: [...conflict.claimIds], strategy: conflict.strategy })),
    ledger: { entries: reconciler.hmem.ledger.all().length, appendOnly: true }, ...extra };
}

export interface RecordRunMemoryInput {
  universeId: string; runId: string; discovery: any;
  /** Typed probe results of the run (`report.artifacts.probes`); only these feed memory, never model text. */
  probes: any[];
  dir?: string;
  /** Warm-start outcome of this run; its REUSED relations are recorded as observations of the run, not as new votes. */
  warmStart?: WarmStartReport;
  revalidation?: RevalidationReport;
}

/**
 * 3.1: writes the run's deterministic probe results into the Reconciler/H-MEM facade as claims stamped with the run id.
 * Only relation claims are written (SOSTENIDA verdicts, critic/freshness degradations, verdict drift); the ledger only appends
 * and a re-observation by a later run is recorded as an observation, not as a second vote.
 */
export function recordRunMemory(input: RecordRunMemoryInput): AgentMemoryReport {
  const dir = input.dir ?? agentMemoryDir(input.universeId), scope = memoryScope(dir);
  if (!input.probes.length && !input.warmStart?.reused.length) return { schemaVersion: 1, status: 'SKIPPED', runId: input.runId, universeId: input.universeId, scope, claims: [], conflicts: [], reviewQueue: [], ledger: { entries: 0, appendOnly: true }, reason: 'no probe results to remember' };
  try {
    const reconciler = new Reconciler(input.universeId, dir, AGENT_MEMORY_ACTOR);
    const versioned = input.probes.map(probe => probe?.from && probe?.to ? { ...probe, evidence: { ...probe.evidence, sourceVersion: versionOfProbe(input.discovery, probe) } } : probe);
    if (versioned.length) reconciler.ingest(input.discovery, { relations: versioned }, { runId: input.runId });
    for (const reused of input.warmStart?.reused ?? []) {
      const claim = reconciler.claims.find(candidate => candidate.id === reused.claimId);
      if (claim) reconciler.addClaim({ entity: claim.entity, attribute: claim.attribute, value: claim.value, source: claim.source, confidence: claim.confidence, requestIds: [...claim.requestIds],
        sourceVersion: reused.version, observedAt: claim.observedAt, rule: 'reused_from_memory', runId: input.runId });
    }
    return memoryReport(reconciler, input.runId, scope, { ...(input.warmStart ? { reuse: input.warmStart } : {}), ...(input.revalidation ? { revalidation: input.revalidation } : {}) });
  } catch (error) {
    return { schemaVersion: 1, status: 'ERROR', runId: input.runId, universeId: input.universeId, scope, claims: [], conflicts: [], reviewQueue: [], ledger: { entries: 0, appendOnly: true }, error: failure(error) };
  }
}
