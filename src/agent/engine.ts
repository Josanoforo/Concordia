import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Zetaris } from '../clients/zetaris.ts';
import { criticize, runTypedCounterprobe, type TypedCriticOutcome } from '../critic/adversarial.ts';
import { relationPolicyFromConfig } from '../relations/policy.ts';
import { SecondaryJudgeChooser, SECONDARY_JUDGE_DEFAULT_ENABLED, type JudgeConfig, type SecondaryJudge } from './secondary-judge.ts';
import { DEFAULT_COUNTERPROBE_CATALOG, suggestCounterProbes, type AssistChooser, type CriticAssist } from './critic-assist.ts';
import type { ComaBridge } from '../discovery/coma-provider.ts';
import { resolveUniverseManifest, type UniverseManifest } from '../registry/universes.ts';
import { failure, readJson, ROOT, SafeError, setTraceRun, trace, writeJson } from '../runtime.ts';
import { discoverUniverse, probeUniverse, universeConfig, withReviewedRelations } from '../universe-pipeline.ts';
import { catalogOf, type ExplorationCatalog } from './catalog.ts';
import type { ActionChooser } from './chooser.ts';
import { compareDeclaredAlternatives, type TableRowsView } from './join-compare.ts';
import { normalizeComaInputVersion, runComaPhase, type ComaPhaseResult } from './coma-input.ts';
import { agentMemoryDir, planWarmStart, recordRunMemory, type WarmStartReport } from './memory.ts';
import { createReviewDecisionMemory, type ReviewDecisionStats } from './review-decision-memory.ts';
import { runExploration, type ExplorationResult, type ProbeHint } from './exploration.ts';
import { activeReviewOverlay } from './review-overlay.ts';
import { loadNegativeControl, NEGATIVE_CONTROL_FILE } from './negative-control.ts';
import { claimReviewOrigin, isReviewOrigin } from '../reconcile/trusted-sustained.ts';
import { isReviewMode, requiredReviewMode, type ReviewMode } from '../registry/review-mode.ts';
import { MODEL_REVIEW_LABEL, type CandidateReview, type CandidateReviewOutcome, type ModelReviewedContractLike } from './model-review-contract.ts';
import { classifyRunStatus } from './run-status.ts';
import { COMA_FAILED, POST_COMA_JOURNAL_FILE, priorFromRun, runPostComa, type PostComaJournalTarget, type PostComaPrior, type PostComaScope } from './post-coma.ts';
import { orderTies } from './tie-break.ts';
import { createSourcePoolReader } from '../probe/sampling.ts';
import { execFileSync } from 'node:child_process';
import { PROBE_QUERY_COST, selectProbes, type ProbeSelection } from './probe-selector.ts';
import { findTies, measureTieEvidence } from './tie-evidence.ts';
import { enforceConsistency, type AliasDeclaration } from './consistency.ts';
import { cachedProfile, createProfileCache, measureColumnProfile, type ColumnProfile, type ProfileCache } from '../probe/column-profile.ts';
import { zetarisTableSpecs } from '../relations/adapters/zetaris.ts';
import { FULL_EVIDENCE_MAX_QUERIES } from '../probe/full-evidence.ts';
import { budgetedClient, DEFAULT_PHASE_SHARES, limitsFromBounds, RunBudget, type PhaseShares } from './run-budget.ts';

export const AGENT_RUN_ID = /^agent-[a-z0-9][A-Za-z0-9._-]{0,48}$/;
type Mode = 'LIVE' | 'REPLAY' | 'LOCAL';
type AgentClient = Pick<Zetaris, 'describe' | 'runSql'>;

export interface AgentDeps {
  client: AgentClient;
  /** Chooses exploration actions; absent means no adaptive reads (recorded, never silently skipped). */
  chooser?: ActionChooser;
  /** Optional model-driven probe ranking; absent means every affordable configured relation is probed. */
  probeChooser?: ActionChooser;
  comaBridge?: ComaBridge;
  /** Opt-in phase budget (R5-3): true uses DEFAULT_PHASE_SHARES, an object sets the split (shares sum to 1). Absent: one global ceiling, phase usage is only observed. */
  phaseBudget?: boolean | PhaseShares;
  /** Per-run override of the manifest probeLimit (1..100), applied to configured relation probes only; critic, post-COMA and exploration keep their limits. */
  probeLimit?: number;
  /** The caller asked for a model-driven run (CLI: true unless --no-model / --offline). Without it the participation is NOT_REQUESTED; with it, a run whose model never produced a call is FAILED, never silently COMPLETED. */
  modelRequested?: boolean;
  /** Error raised while building the model chooser (e.g. missing credentials); becomes the exploration plannerError. */
  chooserError?: { code: string; message?: string };
  /** The caller asked for COMA (CLI: true unless --no-coma); a COMA phase that is NOT_CONFIGURED is then a recorded degradation. */
  comaRequested?: boolean;
  /**
   * Opt-in assisted critic (R5-2): one model call per batch of SOSTENIDA relations suggests counterprobe ids from the closed catalog; only a DEGRADED outcome
   * of the existing critic rule lowers a verdict. It needs a model: without a chooser it is recorded as SKIPPED_NO_MODEL and the deterministic critic runs.
   */
  criticAssist?: boolean | { chooser?: AssistChooser; maxPerRelation?: number };
  /**
   * Optional secondary judge (R5-6), default off (SECONDARY_JUDGE_DEFAULT_ENABLED). It wraps the elector (the exploration chooser) and only adds a non-decisive
   * note to calls[].secondaryJudge; with the flag off the wrapper is not even installed. It needs a model: without a judge it is recorded as SKIPPED_NO_MODEL.
   */
  secondaryJudge?: boolean | { enabled?: boolean; judge?: SecondaryJudge; k?: number; marginThreshold?: number; ambiguity?: JudgeConfig['ambiguity'] };
  /** Explicit COMA input version; absent means the implicit legacy v1 (hash-compatible with historic runs). */
  comaInputVersion?: 1 | 2;
  executionMode?: Mode;
  /** Label for the data actually read (e.g. SYNTHETIC for offline fixtures); defaults to the manifest's origin. */
  dataOrigin?: AgentContext['dataOrigin'];
  now?: () => string;
  critic?: boolean;
  persist?: boolean;
  /** Opt-in memory (Reconciler/H-MEM): REUSED relations skip their probes and the run's claims are written with its run id. */
  memory?: boolean | { dir?: string; ttlMs?: number };
  /**
   * Ranking prior for post-COMA (M7-2). By default it is built from the latest persisted run of the SAME origin-sealed scope (universe, execution mode, data origin)
   * that has post-COMA proposals; `false` disables it, an object supplies one; a run with persist:false looks nothing up on disk. It only orders and skips coverage probes; it never changes a verdict.
   */
  postComaPrior?: false | PostComaPrior;
  /** Act 3 negative control: `.concordia/agent-runs/<run>/negative-control.json` of an earlier run, linked to this review run. Valid only with a review overlay; validated before the first SQL. */
  negativeControl?: string;
  /**
   * R-1: model review of the blind post-COMA candidates BEFORE the contract probes. It runs when the universe (manifest) requires MODEL_ADVERSARIAL or BOTH; under MODEL_ADVERSARIAL the accepted
   * ones become relations with reviewState REVIEWED and reviewOrigin MODEL_REVIEWED, are applied inside this run, probed and decided by the unchanged policy, and sealed MODEL_REVIEWED in verdict and memory.
   * REJECTED/DEFERRED get no contract. Under BOTH the review is recorded but not applied (a SOSTENIDA there also needs a human contract). HUMAN never applies a model contract.
   */
  candidateReview?: CandidateReview;
  /** E1-01: threshold of the review-health check (share of review calls that came back INVALID, truncated or failed above which the run is DEGRADED). */
  reviewHealth?: Partial<ReviewHealthThresholds>;
  /** E2-03: global consistency over the approved edges. Off unless enabled here or by `manifest.consistency.enabled`. */
  consistency?: ConsistencyOptions;
  /** E1-03: continue an interrupted persisted run. `runId` must be the run id being run; the run folder must exist and hold no engine-run.json. Only post-COMA is resumed. */
  resume?: { runId: string };
  /** Git SHA of the code running (pinned in the post-COMA journal header; a resume under another SHA is refused). Defaults to CONCORDIA_CODE_SHA, then `git rev-parse HEAD`. */
  codeSha?: string;
}

/** Latest persisted engine-run of the same scope with post-COMA proposals, other than the current run; undefined when there is none. */
export function latestPriorRun(scope: PostComaScope, currentRunId: string, runsDir = path.join(ROOT, '.concordia', 'agent-runs')): PostComaPrior | undefined {
  if (!fs.existsSync(runsDir)) return undefined;
  let best: { utc: string; run: any } | undefined;
  for (const entry of fs.readdirSync(runsDir)) {
    if (entry === currentRunId) continue;
    const file = path.join(runsDir, entry, 'engine-run.json');
    try {
      const run = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (run.universeId !== scope.universeId || run.executionMode !== scope.executionMode || run.dataOrigin !== scope.dataOrigin || !run.postComa?.proposals?.length) continue;
      if (!best || String(run.utc) > best.utc) best = { utc: String(run.utc), run };
    } catch { /* unreadable run: not a prior */ }
  }
  return best ? priorFromRun(best.run, scope) : undefined;
}

/** Everything a phase needs; built once per run from the registry manifest, never from the model. */
export interface AgentContext {
  universeId: string; manifest: UniverseManifest; cfg: any; catalog: ExplorationCatalog; budget: RunBudget; client: AgentClient;
  executionMode: Mode; dataOrigin: 'UNKNOWN' | 'PUBLIC' | 'USER' | 'SYNTHETIC'; runId: string; prefix: string; persist: boolean;
  /** Explicit per-run probe-limit override (validated 1..100); undefined means the manifest value. */
  probeLimit?: number;
  /** E1-06: ONE whole-table profile cache per run, shared by post-COMA (E2-02 orientation), tie evidence and the full evidence of the contract probes: a column is scanned once per run. */
  profileCache: ProfileCache;
}
/** F1x is declared by its own manifest field (`fullEvidenceExtendedProfile: true`); `fullEvidence === true` keeps meaning F1 whole-table evidence only. */
export const extendedProfileOf = (manifest: any): boolean => manifest?.fullEvidenceExtendedProfile === true;
/** Tie-break vector (X10) is off unless the manifest declares `tieBreak.enabled: true`. */
export const tieBreakEnabled = (manifest: any): boolean => manifest?.tieBreak?.enabled === true;
/** Whole-table profile reads are on when the universe declares full evidence or the tie-break (both need them). */
const profilesWanted = (ctx: { manifest?: any }) => fullEvidenceOf(ctx) || tieBreakEnabled(ctx.manifest);
const sha256Of = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function codeShaOf(deps: { codeSha?: string }, root: string = ROOT): string {
  if (deps.codeSha) return deps.codeSha;
  if (process.env.CONCORDIA_CODE_SHA) return process.env.CONCORDIA_CODE_SHA;
  // A clean copy (git archive, no .git) carries the stamp gate:clean writes at its root.
  try { const stamp = fs.readFileSync(path.join(root, '.code-sha'), 'utf8').trim(); if (/^[0-9a-f]{7,64}$/i.test(stamp)) return stamp; } catch { /* no stamp */ }
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'UNKNOWN'; } catch { return 'UNKNOWN'; }
}
/** Synchronous resolver for the model review: orders the tied candidates with X10's steps over the profiles this run already measured (cache reads cost nothing). */
export function tieBreakResolverOf(ctx: Pick<AgentContext, 'profileCache'>, proposals: readonly any[]) {
  const byId = new Map(proposals.filter(item => typeof item?.proposalId === 'string' && item.from && item.to).map(item => [item.proposalId as string, item]));
  const candidate = (id: string) => { const item = byId.get(id)!; return { id, from: item.from, to: item.to, reachesHigh: high(item), sourceProfile: cachedProfile(ctx.profileCache, item.from, false), targetProfile: cachedProfile(ctx.profileCache, item.to, false) }; };
  const all = [...byId.keys()].map(candidate);
  return (group: readonly string[]) => {
    const known = group.filter(id => byId.has(id));
    if (known.length < 2) return undefined;
    const ordering = orderTies(known.map(candidate), { candidates: all });
    return { ordered: ordering.ordered.map(item => item.id), decisive: ordering.decisive, reason: ordering.reason };
  };
}
/** Reader of whole-table column profiles backed by the run cache and the budgeted client; never throws (a failed scan is a NOT_MEASURED profile). */
export function profileReaderOf(ctx: Pick<AgentContext, 'cfg' | 'client' | 'manifest' | 'profileCache'>): (endpoint: { db?: string; table: string; column: string }) => Promise<ColumnProfile | undefined> {
  const specs = zetarisTableSpecs(ctx.cfg), extended = extendedProfileOf(ctx.manifest);
  return async endpoint => {
    const spec = specs[endpoint.table];
    if (!spec || !(ctx.cfg.tables?.[endpoint.table]?.columns ?? []).some((item: any) => item.name === endpoint.column)) return undefined;
    return (await measureColumnProfile({ client: ctx.client as any, endpoint: { table: endpoint.table, column: endpoint.column, spec }, extended, cache: ctx.profileCache })).profile;
  };
}

/**
 * N30: who owns the join comparison. U2 compares its alternatives itself (U2_JOIN_ALTERNATIVES in u2.ts, with its own bounded reads and labels); every other universe
 * compares what its catalog declares in joinAlternatives (runJoinComparisonStage). If U2's catalog ALSO declared joinAlternatives, two comparisons would apply to one run
 * and the rows would be compared twice with different specs, so the run is refused instead of choosing one silently.
 */
export const OWN_JOIN_COMPARISON_UNIVERSES: ReadonlySet<string> = new Set(['U2']);
export function assertSingleJoinComparisonOwner(universeId: string, catalog: Pick<ExplorationCatalog, 'joinAlternatives'> | undefined): void {
  if (OWN_JOIN_COMPARISON_UNIVERSES.has(universeId) && catalog?.joinAlternatives?.length) throw new SafeError('JOIN_COMPARISON_OWNER_AMBIGUOUS', undefined, `${universeId} compares its own alternatives; its catalog must not declare joinAlternatives`);
}

/** The review mode a relation requires (R-config, src/registry/review-mode.ts: relation > manifest per-relation > manifest universe > HUMAN). An unknown value on the relation fails closed. */
export function reviewModeOf(ctx: { manifest?: any }, relation: any): ReviewMode {
  if (relation?.reviewMode !== undefined && !isReviewMode(relation.reviewMode)) throw new SafeError('REVIEW_MODE_INVALID', undefined, String(relation?.id ?? ''));
  return requiredReviewMode(ctx?.manifest, relation?.id, relation);
}

const sha256Hex = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
/** A model-reviewed contract as a configured relation, with the seal on the relation itself (the probe contract drops unknown fields; the engine stamps the origin on the result). */
function configRelationFromContract(contract: ModelReviewedContractLike) {
  return { id: contract.id, from: { ...contract.from }, to: { ...contract.to }, normalization: contract.normalization, reason: 'Model-reviewed foreign key (R-1 model review overlay)', kind: contract.kind,
    reviewState: contract.reviewState, reviewOrigin: contract.reviewOrigin, reviewMode: 'MODEL_ADVERSARIAL', identifierSpace: contract.identifierSpace, normalizationVersion: contract.normalizationVersion,
    normalizationLossless: contract.normalizationLossless, normalizationAdapterCapability: contract.normalizationAdapterCapability };
}
const contractShapeOk = (contract: any, known: Set<string>): boolean => Boolean(contract && typeof contract.id === 'string' && known.has(contract.id) && contract.reviewOrigin === 'MODEL_REVIEWED' && contract.reviewState === 'REVIEWED' && contract.kind === 'FOREIGN_KEY'
  && contract.from?.table && contract.from?.column && contract.to?.table && contract.to?.column && contract.normalizationLossless === true);

export interface ConsistencyOptions { enabled?: boolean; aliases?: readonly AliasDeclaration[]; /** Injection point (tests, and the stub until X10's body lands). */ enforce?: typeof enforceConsistency }
/** Runs X10's pass over the approved contracts when enabled (deps or manifest); fails closed (keeps every edge, says so) if it throws. */
function applyConsistency(ctx: AgentContext, proposals: readonly any[], contracts: readonly ModelReviewedContractLike[], option?: ConsistencyOptions) {
  const manifestOption = (ctx.manifest as any)?.consistency, enabled = option?.enabled ?? manifestOption?.enabled === true;
  if (!enabled) return { section: { status: 'OFF' as const }, demoted: [] as { id: string; rule: string; winner: string | null; reason: string }[], unresolved: [] as unknown[] };
  const byId = new Map(proposals.map(item => [item?.proposalId, item]));
  const edges = contracts.map(contract => ({ id: contract.id, from: { db: contract.from.db, table: contract.from.table, column: contract.from.column }, to: { db: contract.to.db, table: contract.to.table, column: contract.to.column }, reachesHigh: high(byId.get(contract.id)) }));
  try {
    const result = (option?.enforce ?? enforceConsistency)(edges, { aliases: option?.aliases ?? manifestOption?.aliases ?? [] });
    const demoted = result.demoted.map(item => ({ id: item.edge.id, rule: item.rule, winner: item.winner, reason: item.reason }));
    return { section: { status: 'ENFORCED' as const, kept: result.kept.map(item => item.id), demoted, unresolved: result.unresolved }, demoted, unresolved: result.unresolved as unknown[] };
  } catch (error) { return { section: { status: 'ERROR' as const, error: failure(error) }, demoted: [], unresolved: [] }; }
}
const high = (proposal: any) => proposal?.coverageProbe?.status === 'EXECUTED' && proposal.coverageProbe.diagnostic?.coverage?.level === 'HIGH' && !proposal.coverageProbe.diagnostic?.suspect?.value;

/** E1-01 degradation codes of the model review (names are a contract with the report renderer). */
export const REVIEW_HEALTH_CODES = { partialBudget: 'MODEL_REVIEW_PARTIAL_BUDGET', callsInvalid: 'MODEL_REVIEW_CALLS_INVALID', adversaryIncomplete: 'MODEL_REVIEW_ADVERSARY_INCOMPLETE' } as const;
export interface ReviewHealthThresholds { /** Share (0..1) of attempted review calls that were INVALID, truncated or failed above which the run degrades. */ maxInvalidCallShare: number }
export const DEFAULT_REVIEW_HEALTH: ReviewHealthThresholds = { maxInvalidCallShare: 0.25 };
export interface ReviewHealth { calls: number; invalidCalls: number; truncatedCalls: number; skippedBudgetCalls: number; /** Calls the cheap cascade did not make: not calls, so not in the denominator. */ skippedByCascadeCalls: number; invalidCallShare: number; adversary: { attempted: number; incomplete: number }; thresholds: ReviewHealthThresholds; codes: string[] }
/**
 * Health of a model review, read only from the overlay's own records (evaluations and adversary calls): budget skips, INVALID/failed/truncated calls over the threshold, an adversarial pass that
 * did not complete. Never changes a verdict; the codes degrade the run so a defective review does not read as clean.
 */
export function reviewHealthOf(overlay: any, thresholds: Partial<ReviewHealthThresholds> = {}): ReviewHealth {
  const limit = { ...DEFAULT_REVIEW_HEALTH, ...thresholds }, reviews: any[] = Array.isArray(overlay?.reviews) ? overlay.reviews : [];
  let calls = 0, invalid = 0, truncated = 0, skipped = 0, cascaded = 0, attempted = 0, incomplete = 0;
  const tally = (record: any) => {
    if (!record) return false;
    if (record.status === 'SKIPPED_BUDGET') { skipped++; return false; }
    if (record.status === 'NOT_NEEDED') return false;
    if (record.status === 'SKIPPED_BY_CASCADE') { cascaded++; return false; }
    calls++;
    if (record.call?.truncated === true) truncated++;
    if (record.status === 'INVALID' || record.status === 'CALL_FAILED' || record.call?.truncated === true) { invalid++; return true; }
    return false;
  };
  for (const review of reviews) {
    for (const evaluation of review?.evaluations ?? []) tally(evaluation);
    const adversary = review?.adversary;
    if (adversary?.status === 'SKIPPED_BY_CASCADE') cascaded++;
    else if (adversary && adversary.status !== 'NOT_NEEDED') { attempted++; if (tally(adversary) || review.adversarialPass === 'INCOMPLETE') incomplete++; }
  }
  const share = calls ? invalid / calls : 0, codes: string[] = [];
  if (skipped > 0) codes.push(REVIEW_HEALTH_CODES.partialBudget);
  if (invalid > 0 && share > limit.maxInvalidCallShare) codes.push(REVIEW_HEALTH_CODES.callsInvalid);
  if (incomplete > 0) codes.push(REVIEW_HEALTH_CODES.adversaryIncomplete);
  return { calls, invalidCalls: invalid, truncatedCalls: truncated, skippedBudgetCalls: skipped, skippedByCascadeCalls: cascaded, invalidCallShare: Math.round(share * 1000) / 1000, adversary: { attempted, incomplete }, thresholds: limit, codes };
}

/**
 * R-1 stage. After post-COMA: hands the candidates to the injected reviewer, validates what comes back (only contracts for proposals of this run, MODEL_REVIEWED/REVIEWED), persists the
 * overlay artifact and, under MODEL_ADVERSARIAL, applies the contracts for the duration of the contract probes (and their critic). Returns the section for the report and the probe stage whose
 * results are appended to the run.
 */
export async function runCandidateReviewStage(ctx: AgentContext, phase: DiscoveryPhase, postComa: any, review: CandidateReview | undefined, options: { now: () => string; critic: boolean; criticAssist?: AgentDeps['criticAssist']; reviewHealth?: Partial<ReviewHealthThresholds>; consistency?: ConsistencyOptions; memory?: { dir: string; origin: { executionMode: string; dataOrigin: string }; ttlMs?: number; now?: () => number }; /** N2: filled with the negative-memory counters once the review has run. */ reviewDecisionSink?: { stats?: ReviewDecisionStats } }) {
  const mode = requiredReviewMode(ctx.manifest);
  if (mode !== 'MODEL_ADVERSARIAL' && mode !== 'BOTH') return undefined;
  const proposals: any[] = Array.isArray(postComa?.proposals) ? postComa.proposals : [];
  if (!review) return { section: { status: 'SKIPPED_NO_REVIEWER', mode, applied: [] as string[] } };
  // Memory first: candidates whose MODEL_REVIEWED SOSTENIDA is still valid in memory (seal and mode satisfied, version current, inside the TTL) are not probed again.
  const normalization = ctx.cfg.normalizationContract?.defaultMode ?? 'text';
  let plan: WarmStartReport | undefined;
  if (options.memory) {
    try {
      const candidates = proposals.filter(item => typeof item?.proposalId === 'string' && item.from && item.to).map(item => ({ id: item.proposalId as string, from: { db: item.from.db, table: item.from.table, column: item.from.column }, to: { db: item.to.db, table: item.to.table, column: item.to.column }, normalization, reviewMode: 'MODEL_ADVERSARIAL' as const }));
      plan = planWarmStart({ universeId: ctx.universeId, discovery: phase.discovery, relations: candidates, dir: options.memory.dir, origin: options.memory.origin, ...(options.memory.ttlMs !== undefined ? { ttlMs: options.memory.ttlMs } : {}), ...(options.memory.now ? { now: options.memory.now } : {}) });
    } catch { plan = undefined; }
  }
  const reusableIds = new Set(plan?.reused.map(item => item.relationId) ?? []);
  ctx.budget.enterPhase('modelReview');
  // Ties among HIGH candidates (same source column): their targets' global uniqueness (F1, 1 query each) goes to the reviewer; counted in the budget, skipped and reported when it does not fit.
  const tieEstimate = ctx.budget.estimate(findTies(proposals).targets.length, { queries: 1 });
  const tie = await measureTieEvidence({ cfg: ctx.cfg, client: ctx.client as any, budget: ctx.budget, proposals, cache: ctx.profileCache, extendedProfile: extendedProfileOf(ctx.manifest) });
  const tieSection = { ties: tie.ties, targets: tie.targets, measured: tie.measured, notMeasured: tie.notMeasured, queries: tie.queries, cached: tie.cached, estimate: tieEstimate };
  const tableColumns = Object.fromEntries(Object.entries<any>(phase.discovery.tables).map(([name, table]) => [name, [...(table.columns ?? [])].map(String)]));
  let outcome: CandidateReviewOutcome;
  const decisionMemory = options.memory ? createReviewDecisionMemory({ universeId: ctx.universeId, dir: options.memory.dir, origin: options.memory.origin, runId: ctx.runId, now: options.now }) : undefined;
  try { outcome = await review({ universeId: ctx.universeId, runId: ctx.runId, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin, proposals: JSON.parse(JSON.stringify(proposals)), tableColumns, budget: ctx.budget, now: options.now, reusable: [...reusableIds], ...(decisionMemory ? { reviewDecisionMemory: decisionMemory } : {}), ...(tieBreakEnabled(ctx.manifest) ? { tieBreak: tieBreakResolverOf(ctx, proposals) } : {}), targetGlobalUniqueness: tie.measured, globalTargetUniqueness: Object.fromEntries(Object.entries(tie.measured).map(([target, item]) => [target, item.unique ? 'UNIQUE' as const : 'NOT_UNIQUE' as const])) }); }
  catch (error) { if (decisionMemory && options.reviewDecisionSink) options.reviewDecisionSink.stats = decisionMemory.stats(); return { section: { status: 'FAILED', mode, applied: [] as string[], tieEvidence: tieSection, error: failure(error) } }; }
  if (decisionMemory && options.reviewDecisionSink) options.reviewDecisionSink.stats = decisionMemory.stats();
  const known = new Set(proposals.map(item => item?.proposalId).filter((id): id is string => typeof id === 'string'));
  if (!outcome || outcome.overlay?.origin !== 'MODEL_REVIEW' || !Array.isArray(outcome.contracts) || !outcome.contracts.every(contract => contractShapeOk(contract, known)))
    return { section: { status: 'FAILED', mode, applied: [] as string[], tieEvidence: tieSection, error: { code: 'MODEL_REVIEW_OUTPUT_INVALID' } } };
  // A scripted stand-in is never evidence in a LIVE run: its contracts and overlay are refused before anything is persisted or applied.
  if (ctx.executionMode === 'LIVE' && (outcome.overlay as any).provenance === 'STAND_IN_OFFLINE') return { section: { status: 'FAILED', mode, applied: [] as string[], tieEvidence: tieSection, error: { code: 'MODEL_REVIEW_STAND_IN_IN_LIVE_RUN' } } };
  // E2-03: global consistency between the review and the contract probes. A demoted edge gets no contract and carries its rule and winner in the overlay and the trace; no verdict is lowered.
  const consistency = applyConsistency(ctx, proposals, outcome.contracts, options.consistency);
  const demotedIds = new Set(consistency.demoted.map(item => item.id));
  const contracts = outcome.contracts.filter(contract => !demotedIds.has(contract.id));
  // N2: an approval retires the relation's remembered "no" (it can never come back if the old evidence does).
  try { decisionMemory?.approve(contracts.map(contract => contract.id)); } catch { /* negative memory is an optimisation: never fails the review */ }
  const overlay: any = consistency.demoted.length ? { ...outcome.overlay, consistency: { demoted: consistency.demoted, unresolved: consistency.unresolved },
    notApproved: [...((outcome.overlay as any).notApproved ?? []), ...consistency.demoted.map(item => ({ relationId: item.id, decision: 'defer', reasons: [`CONSISTENCY_${item.rule}`], reviewed: true }))],
    deferred: [...((outcome.overlay as any).deferred ?? []), ...consistency.demoted.map(item => ({ id: item.id, reason: `defer: CONSISTENCY_${item.rule}` }))] } : outcome.overlay;
  const overlaySha256 = sha256Hex(overlay);
  if (ctx.persist) writeJson(`${ctx.prefix}model-review-overlay.json`, overlay);
  const base = { mode, tieEvidence: tieSection, health: reviewHealthOf(outcome.overlay, options.reviewHealth), consistency: consistency.section, overlayFile: ctx.persist ? 'model-review-overlay.json' : null, overlaySha256, counts: overlay.counts ?? null, notApproved: overlay.notApproved ?? [], label: overlay.label ?? MODEL_REVIEW_LABEL,
    provenance: overlay.provenance ?? null, approved: contracts.map(contract => contract.id) };
  if (mode === 'BOTH') return { section: { status: 'RECORDED_NOT_APPLIED', reason: 'BOTH_REQUIRES_HUMAN_CONTRACT', applied: [] as string[], ...base } };
  // A reusable candidate stays reused unless this run's review looked at it and did not approve it (new evidence against it wins over an old approval).
  const rejectedNow = new Set((overlay.notApproved ?? []).filter((item: any) => item?.reviewed === true).map((item: any) => String(item.relationId)));
  const reusedEntries = (plan?.reused ?? []).filter(item => !rejectedNow.has(item.relationId));
  const reusedIds = new Set(reusedEntries.map(item => item.relationId));
  const endpoints = new Map<string, { from: unknown; to: unknown }>(proposals.filter(item => reusedIds.has(item?.proposalId)).map(item => [item.proposalId as string, { from: { db: item.from.db, table: item.from.table, column: item.from.column }, to: { db: item.to.db, table: item.to.table, column: item.to.column } }]));
  const reuse = { reused: reusedEntries, endpoints };
  const relations = contracts.filter(contract => !reusedIds.has(contract.id)).map(configRelationFromContract);
  const estimate = ctx.budget.estimate(relations.length, { queries: probeQueryCostOf(ctx) });
  if (!relations.length) return { section: { status: reusedEntries.length ? 'APPLIED' : 'NOTHING_APPROVED', applied: [] as string[], reusedFromMemory: [...reusedIds], estimate, ...base }, ...reuse };
  try {
    const applied = await withReviewedRelations(ctx.universeId, relations, async () => {
      const modelPhase = { ...phase, relations } as DiscoveryPhase;
      const stage = await runProbeStage(ctx, modelPhase, undefined, options.now);
      stampConfiguredReviewOrigin(stage.relations, relations);
      const critic = options.critic ? await runCriticStage(ctx, modelPhase, stage, { criticAssist: options.criticAssist, now: options.now }) : { status: 'DISABLED' as const };
      return { stage, critic };
    });
    return { ...reuse, section: { status: 'APPLIED', applied: relations.map(relation => relation.id), reusedFromMemory: [...reusedIds], estimate, probed: applied.stage.selection.selected, skipped: applied.stage.selection.skipped, critic: applied.critic, ...base }, stage: applied.stage };
  } catch (error) {
    if ((error as { code?: string })?.code === 'REVIEW_ALREADY_ACTIVE') return { section: { status: 'NOT_APPLIED', reason: 'HUMAN_OVERLAY_ACTIVE', applied: [] as string[], estimate, ...base } };
    return { section: { status: 'FAILED', applied: [] as string[], estimate, error: failure(error), ...base } };
  }
}

export function prepareAgentContext(universe: string, runId: string, deps: Pick<AgentDeps, 'client' | 'executionMode' | 'dataOrigin' | 'persist' | 'phaseBudget' | 'probeLimit'>): AgentContext {
  if (!AGENT_RUN_ID.test(runId)) throw new SafeError('AGENT_RUN_ID_INVALID');
  const manifest = resolveUniverseManifest(universe);
  if (!manifest) throw new SafeError('INVALID_UNIVERSE');
  if (!manifest.capabilities.includes('AGENT_EXPLORATION')) throw new SafeError('UNIVERSE_LACKS_AGENT_EXPLORATION');
  const cfg = universeConfig(universe), catalog = catalogOf(cfg);
  if (!catalog) throw new SafeError('EXPLORATION_CATALOG_REQUIRED');
  assertSingleJoinComparisonOwner(cfg.id, catalog);
  if (deps.probeLimit !== undefined && (!Number.isInteger(deps.probeLimit) || deps.probeLimit < 1 || deps.probeLimit > 100)) throw new SafeError('PROBE_LIMIT_OUT_OF_RANGE');
  const budget = new RunBudget(limitsFromBounds(manifest.capabilityBounds?.AGENT_EXPLORATION), deps.phaseBudget ? (deps.phaseBudget === true ? DEFAULT_PHASE_SHARES : deps.phaseBudget) : undefined);
  return { universeId: cfg.id, manifest, cfg, catalog, budget, client: budgetedClient(deps.client as any, budget) as AgentClient, executionMode: deps.executionMode ?? 'LIVE',
    dataOrigin: deps.dataOrigin ?? manifest.source.dataOrigin, runId, prefix: `.concordia/agent-runs/${runId}/`, persist: deps.persist !== false, probeLimit: deps.probeLimit, profileCache: createProfileCache() };
}

export function describedColumns(discovery: any): Record<string, { name: string; type: string }[]> {
  return Object.fromEntries(Object.entries<any>(discovery.tables).map(([name, table]) => [name, (table.sourceMetadata?.rows ?? []).flatMap((row: unknown[]) =>
    typeof row[0] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(row[0]) ? [{ name: row[0], type: typeof row[1] === 'string' ? row[1] : 'unknown' }] : [])]));
}

export interface DiscoveryPhase { discovery: any; sourceColumns: Record<string, { name: string; type: string }[]>; relations: any[]; /** Configured relations dropped because an endpoint table was not discovered (recorded as degradations). */ dropped: string[] }
export async function runDiscoveryPhase(ctx: AgentContext, replay?: any): Promise<DiscoveryPhase> {
  ctx.budget.enterPhase('discovery');
  const discovery = replay ?? await discoverUniverse(ctx.universeId, { client: ctx.client, persist: false, runId: ctx.runId, executionMode: ctx.executionMode });
  const available = new Set(Object.keys(discovery.tables));
  const usable = (relation: any) => available.has(relation.from.table) && available.has(relation.to.table);
  const relations = ctx.cfg.relations.filter(usable), dropped = ctx.cfg.relations.filter((relation: any) => !usable(relation)).map((relation: any) => relation.id);
  // A universe that configured relations must keep at least one; a blind universe (none configured) stays valid.
  if (ctx.cfg.relations.length > 0 && relations.length === 0) throw new SafeError('DISCOVERY_NO_USABLE_RELATIONS', undefined, `all ${ctx.cfg.relations.length} configured relations lost an endpoint table`);
  return { discovery, sourceColumns: describedColumns(discovery), relations, dropped };
}

export function runComaStage(ctx: AgentContext, phase: DiscoveryPhase, bridge?: ComaBridge, comaInputVersion?: number): Promise<ComaPhaseResult> {
  return runComaPhase({ universeId: ctx.universeId, cfg: ctx.cfg, catalog: ctx.catalog, discovery: phase.discovery, sourceColumns: phase.sourceColumns, relations: phase.relations,
    bridge, comaInputVersion, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin });
}

/**
 * Join comparison for universes that declare joinAlternatives. The comparator reads nothing: it measures rows already observed
 * (a bounded exploration read of the table, else the discovery sample). It runs only while the SQL budget still has room;
 * otherwise it is recorded as not executed. Universes without joinAlternatives are untouched (returns undefined).
 */
export function runJoinComparisonStage(ctx: AgentContext, phase: DiscoveryPhase, exploration: ExplorationResult) {
  const specs = ctx.catalog?.joinAlternatives;
  if (!specs?.length) return undefined;
  if (!ctx.budget.canQuery()) return { status: 'NOT_EXECUTED_BUDGET', reason: 'AGENT_QUERY_BUDGET_EXHAUSTED', alternatives: [] };
  const readOf = (table: string) => Object.values(exploration.reads).find(read => ctx.catalog.actions?.some((action: any) => action.id === read.actionId && action.table === table));
  const view = (table: string): TableRowsView => {
    const read = readOf(table), sample = phase.discovery.tables[table], useRead = Boolean(read?.rows.length);
    return { rows: useRead ? read!.rows : sample?.sample?.rows ?? [], columns: useRead ? read!.columns : sample?.columns ?? [], evidenceRefs: [useRead ? read!.queryId : sample?.sample?.queryId].filter(Boolean) };
  };
  try { return { status: 'COMPARED', queriesCharged: 0, alternatives: compareDeclaredAlternatives(ctx.cfg, specs, view) }; }
  catch (error) { return { status: 'ERROR', error: failure(error), alternatives: [] }; }
}

export function runExplorationStage(ctx: AgentContext, phase: DiscoveryPhase, chooser: ActionChooser | undefined, coma: ComaPhaseResult): Promise<ExplorationResult> {
  ctx.budget.enterPhase('exploration');
  return runExploration({ runId: ctx.runId, cfg: ctx.cfg, catalog: ctx.catalog, discovery: phase.discovery, sourceColumns: phase.sourceColumns, client: ctx.client, chooser, budget: ctx.budget,
    extraObservation: coma.production?.outOfScopeProposals ?? [], executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin, persistPrefix: ctx.persist ? ctx.prefix : undefined });
}

export interface ProbeStage { selection: ProbeSelection; result?: any; relations: any[]; error?: object }
/** P3: whole-table evidence is on for the contract probes of a universe whose manifest declares fullEvidence: true. */
export const fullEvidenceOf = (ctx: { manifest?: any }): boolean => ctx.manifest?.fullEvidence === true;
/** Queries one contract probe is expected to cost: the probe itself plus, when full evidence is on, its aggregate queries (3 to 5, the upper bound is reserved). */
export const probeQueryCostOf = (ctx: { manifest?: any }): number => PROBE_QUERY_COST + (fullEvidenceOf(ctx) ? FULL_EVIDENCE_MAX_QUERIES : 0);
export async function runProbeStage(ctx: AgentContext, phase: DiscoveryPhase, probeChooser?: ActionChooser, now?: () => string, hints?: readonly ProbeHint[]): Promise<ProbeStage> {
  ctx.budget.enterPhase('probes');
  const selection = await selectProbes({ relations: phase.relations, budget: ctx.budget, chooser: probeChooser, observation: { scope: ctx.cfg.scope }, queryCost: probeQueryCostOf(ctx), ...(hints?.length ? { hints } : {}) });
  if (!selection.selected.length) return { selection, relations: [] };
  try {
    const result = await probeUniverse(ctx.universeId, { probeLimit: ctx.probeLimit, ...(fullEvidenceOf(ctx) ? { fullEvidence: true, profileCache: ctx.profileCache, extendedProfile: extendedProfileOf(ctx.manifest) } : {}), inventory: phase.discovery, client: ctx.client, persist: false, recordFreshness: ctx.executionMode === 'LIVE', relationIds: selection.selected, now, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin });
    return { selection, result, relations: (result as any).relations ?? (result as any).probes ?? [] };
  } catch (error) { return { selection, relations: [], error: failure(error) }; }
}

type CriticStageOptions = Pick<AgentDeps, 'criticAssist'> & { now?: () => string };
/** Runs the closed-catalog counterprobes the model suggested through the existing typed counterprobe; applies a DEGRADED outcome exactly as criticize() does. */
async function runAssistedCritic(ctx: AgentContext, phase: DiscoveryPhase, probes: ProbeStage, chooser: AssistChooser, maxPerRelation: number | undefined, now: () => string) {
  const thresholds = readJson<any>('config/thresholds.json'), policy = relationPolicyFromConfig(thresholds);
  const byId = new Map<string, any>(probes.relations.map((item: any) => [item.relationId ?? item.relation?.id, item]));
  const sustained = probes.relations.filter((item: any) => (item.verdict ?? item.decision?.verdict) === 'SOSTENIDA').map((item: any) => {
    const from = item.from ?? item.relation?.from, to = item.to ?? item.relation?.to;
    return { relationId: item.relationId ?? item.relation?.id, from: `${from?.table}.${from?.column}`, to: `${to?.table}.${to?.column}` };
  });
  const outcomes: Record<string, TypedCriticOutcome[]> = {};
  const execute = async (relationId: string, _counterprobeId: string): Promise<TypedCriticOutcome> => {
    const relation = byId.get(relationId);
    const contract = relation?.relationContract ?? relation?.evidence?.relationContract, baseEvidence = relation?.typedEvidence ?? relation?.evidence?.typedEvidence;
    const freshness = relation?.freshness?.state ?? relation?.evidence?.freshness?.state;
    let outcome: TypedCriticOutcome;
    if (freshness === 'DEGRADADA' || freshness === 'INCOMPLETA') outcome = { status: 'INSUFFICIENT', reason: `base_relation_freshness_${String(freshness).toLowerCase()}; no source reads issued` };
    else if (!contract || !baseEvidence || !(relation?.decision ?? relation?.evidence?.decision)) outcome = { status: 'INSUFFICIENT', reason: 'valid complete typed baseline contract, evidence and common Decision are required; no source reads issued' };
    else {
      try { outcome = await runTypedCounterprobe({ contract, baseEvidence, previousCompleteEvidence: relation.criticEvidence, policy, config: ctx.cfg, inventory: phase.discovery, thresholds, client: ctx.client as any,
        executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin, now: now(), runId: `${ctx.runId}:${relationId}` }); }
      catch (error) { outcome = { status: 'ERROR', reason: (failure(error) as any).code ?? 'TYPED_CRITIC_FAILURE' }; }
    }
    (outcomes[relationId] ??= []).push(outcome);
    // Same rule as criticize(): only DEGRADED lowers the verdict; nothing here can raise one.
    if (outcome.status === 'DEGRADED' && outcome.decision && relation) {
      relation.critic = { ...(relation.critic ?? {}), status: outcome.status, classification: outcome.classification, reason: outcome.reason, currentDecisionRef: outcome.decision.decisionId, source: 'CRITIC_ASSIST' };
      relation.criticDecision = outcome.decision; if (outcome.evidence) relation.criticEvidence = outcome.evidence;
      relation.decision = outcome.decision; relation.verdict = outcome.decision.verdict; relation.requiresReview = outcome.decision.requiresReview;
    }
    return outcome;
  };
  const assist = await suggestCounterProbes({ sustained, catalog: DEFAULT_COUNTERPROBE_CATALOG, budget: ctx.budget, chooser, execute, maxPerRelation });
  return { assist, outcomes };
}

export async function runCriticStage(ctx: AgentContext, phase: DiscoveryPhase, probes: ProbeStage, options: CriticStageOptions = {}) {
  ctx.budget.enterPhase('critic');
  if (!probes.relations.length) return { status: 'SKIPPED', reason: 'no probe results' } as const;
  let assist: object | undefined;
  if (options.criticAssist) {
    const chooser = typeof options.criticAssist === 'object' ? options.criticAssist.chooser : undefined;
    if (!chooser) assist = { status: 'SKIPPED_NO_MODEL', fallback: { to: 'DETERMINISTIC_CRITIC', reason: 'NO_MODEL' } };
    else {
      try {
        const { assist: record, outcomes } = await runAssistedCritic(ctx, phase, probes, chooser, (options.criticAssist as any).maxPerRelation, options.now ?? (() => new Date().toISOString()));
        if (!record.fallback) {
          const all = Object.values(outcomes).flat(), count = (status: string) => all.filter(item => item.status === status).length;
          return { status: 'EVALUATED', mode: 'ASSISTED', eligible: record.executed.length, summary: { confirmed: count('CONFIRMED'), degraded: count('DEGRADED'), insufficient: count('INSUFFICIENT'), errors: count('ERROR'),
            skipped: record.executed.filter(item => item.status.startsWith('SKIPPED')).length }, assist: record } as const;
        }
        assist = record;
      } catch (error) { assist = { status: 'FALLBACK_DETERMINISTIC', fallback: { to: 'DETERMINISTIC_CRITIC', reason: 'CRITIC_ASSIST_FAILED' }, error: failure(error) }; }
    }
  }
  try {
    const critic = await criticize(ctx.universeId, { relationIds: probes.relations.map((item: any) => item.relationId ?? item.relation?.id) }, {
      config: ctx.cfg, relations: { relations: probes.relations }, inventory: phase.discovery, thresholds: readJson('config/thresholds.json'), client: ctx.client as any, persist: false });
    return { status: 'EVALUATED', eligible: critic.results.length, summary: { confirmed: critic.confirmed, degraded: critic.degraded, insufficient: critic.insufficient, errors: critic.errors, skipped: critic.skipped }, ...(assist ? { assist } : {}) } as const;
  } catch (error) { return { status: 'ERROR', error: failure(error) } as const; }
}

/** R-seal: the review origin sealed in a verdict, from the probe result (its own or its contract's); a REVIEWED contract with none is human. */
const reviewOriginField = (item: any): { reviewOrigin?: string } => {
  const origin = claimReviewOrigin({ reviewOrigin: item.reviewOrigin ?? item.relationContract?.reviewOrigin ?? item.evidence?.relationContract?.reviewOrigin, reviewState: item.relationContract?.reviewState ?? item.evidence?.relationContract?.reviewState });
  return origin ? { reviewOrigin: origin } : {};
};
/**
 * R-seal for configured relations: the contract built for a probe drops fields it does not know, so a relation declared with reviewOrigin MODEL_REVIEWED (a model contract applied
 * through the config or withReviewedRelations) would read as human. The origin the configuration declares is stamped on the probe result, where verdicts and memory read it.
 */
export function stampConfiguredReviewOrigin(results: any[], relations: readonly any[]): void {
  const declared = new Map(relations.filter(relation => relation?.reviewOrigin !== undefined).map(relation => [relation.id, relation.reviewOrigin]));
  for (const item of results) {
    const origin = declared.get(item?.relationId ?? item?.relation?.id);
    if (origin === undefined) continue;
    if (!isReviewOrigin(origin)) throw new SafeError('REVIEW_ORIGIN_INVALID');
    item.reviewOrigin = origin;
  }
}
export const decisionsOf = (relations: any[]) => relations.map((item: any) => ({ relationId: item.relationId ?? item.relation?.id, verdict: item.verdict ?? item.decision?.verdict,
  ...(item.from && item.to ? { from: item.from, to: item.to } : {}),
  ...reviewOriginField(item),
  reasonCodes: item.reasonCodes ?? item.decision?.reasonCodes ?? (item.rule ? [item.rule] : []) }));

/**
 * The product's agent loop for any registered universe: discovery -> COMA candidates -> bounded exploration ->
 * budgeted probes -> adversarial critic -> deterministic decisions. Read-only; the model only ever chooses ids.
 */
/** Token-budget stops of the exploration loop: informational, they never change the status of a run whose model already made valid choices. */
const BUDGET_STOP_CODES = new Set(['AGENT_TOKEN_BUDGET_EXHAUSTED', 'TOKEN_BUDGET_WOULD_EXCEED']);

export async function runAgent(universe: string, runId: string, deps: AgentDeps) {
  const ctx = prepareAgentContext(universe, runId, deps);
  const runDirectory = path.join(ROOT, ctx.prefix);
  // Fail closed before anything is created or queried.
  for (const relation of ctx.cfg.relations ?? []) reviewModeOf(ctx, relation);
  const negativeControl = deps.negativeControl === undefined ? undefined : loadNegativeControl(deps.negativeControl, { universeId: ctx.universeId, review: activeReviewOverlay(ctx.universeId), relations: ctx.cfg.relations ?? [] });
  // E1-03: a resume continues an interrupted persisted run in its own folder; a finished run (engine-run.json) is never reopened.
  let resumeJournal: PostComaJournalTarget | undefined, journalExisted = false, interruptions = 0;
  const journalFile = path.join(runDirectory, POST_COMA_JOURNAL_FILE);
  const journalHeader = { kind: 'HEADER' as const, schemaVersion: 1 as const, codeSha: codeShaOf(deps), manifestHash: sha256Of(ctx.manifest), runId };
  if (deps.resume) {
    if (deps.persist === false) throw new SafeError('RESUME_REQUIRES_PERSIST');
    if (deps.resume.runId !== runId) throw new SafeError('RESUME_RUN_ID_MISMATCH');
    if (!fs.existsSync(runDirectory)) throw new SafeError('RESUME_RUN_NOT_FOUND');
    if (fs.existsSync(path.join(runDirectory, 'engine-run.json'))) throw new SafeError('RUN_ALREADY_COMPLETE');
    journalExisted = fs.existsSync(journalFile);
    const log = path.join(runDirectory, 'resume-log.jsonl');
    fs.appendFileSync(log, JSON.stringify({ utc: new Date().toISOString(), codeSha: journalHeader.codeSha }) + '\n');
    interruptions = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    setTraceRun(runId);
  } else if (deps.persist !== false) { if (fs.existsSync(runDirectory)) throw new SafeError('AGENT_RUN_ALREADY_EXISTS'); fs.mkdirSync(runDirectory, { recursive: true }); setTraceRun(runId); }
  const journalTarget: PostComaJournalTarget | undefined = deps.persist !== false ? { path: journalFile, header: journalHeader } : undefined;
  if (deps.resume && journalExisted && journalTarget) resumeJournal = journalTarget;
  const report: any = { schemaVersion: 1, runId, universeId: ctx.universeId, manifestId: ctx.manifest.manifestId, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin, utc: new Date().toISOString(), phases: {} };
  // M7-6: a universe may declare itself a known public benchmark; the declaration is copied as is.
  if (ctx.cfg.publicBenchmark) report.publicBenchmark = { name: ctx.cfg.publicBenchmark.name, note: ctx.cfg.publicBenchmark.note };
  // act 3: a run under a human review overlay records who approved what, taken from the overlay the call already validated; without one the field is absent.
  const reviewOverlay = activeReviewOverlay(ctx.universeId);
  if (reviewOverlay) report.reviewOverlay = negativeControl ? { ...reviewOverlay, negativeControl: negativeControl.record } : reviewOverlay;
  if (negativeControl && deps.persist !== false) fs.writeFileSync(path.join(runDirectory, NEGATIVE_CONTROL_FILE), negativeControl.bytes);
  const finish = () => {
    report.limits = { probeLimit: ctx.probeLimit ?? ctx.cfg.probeLimit, probeLimitSource: ctx.probeLimit !== undefined ? 'flag' : 'manifest', probeLimitAppliesTo: 'configured relation probes only (critic, post-COMA and exploration keep their limits)' };
    ctx.budget.notePreflightQueries((deps.client as any).preflightQueryCount?.() ?? 0);
    report.budget = ctx.budget.snapshot();
    report.limitations = ['Read-only: bounded SELECT templates and configured probes only; no DDL, no gold, no model-written SQL.',
      'Verdicts come from the deterministic relation policy; COMA proposals and model choices never change them.', 'Bounded samples are not table-wide claims.'];
    if (deps.persist !== false) writeJson(`${ctx.prefix}engine-run.json`, report);
    trace({ kind: 'agent-run-complete', runId, universeId: ctx.universeId, budget: report.budget });
    return report;
  };
  let phase: DiscoveryPhase;
  try { phase = await runDiscoveryPhase(ctx); report.phases.discovery = { status: 'PASS', tables: Object.keys(phase.discovery.tables), relations: phase.relations.map((relation: any) => relation.id) }; }
  catch (error) { report.phases.discovery = { status: 'ERROR', error: failure(error) }; report.status = 'DISCOVERY_FAILED'; return finish(); }
  if (deps.persist !== false) writeJson(`${ctx.prefix}discovery.json`, phase.discovery);
  const coma = await runComaStage(ctx, phase, deps.comaBridge, deps.comaInputVersion);
  report.phases.coma = { status: coma.status, comaInputVersion: coma.comaInputVersion ?? normalizeComaInputVersion(deps.comaInputVersion), comaInputVersionExplicit: deps.comaInputVersion !== undefined, inputHash: coma.inputHash ?? null, providerStates: coma.production?.providerStates ?? [], candidates: coma.production?.candidates.length ?? 0,
    outOfScopeProposals: coma.production?.outOfScopeProposals ?? [], ...(coma.blind ? { blind: coma.blind } : {}) };
  const judgeOption = deps.secondaryJudge, judgeEnabled = typeof judgeOption === 'object' ? (judgeOption.enabled ?? true) : (judgeOption ?? SECONDARY_JUDGE_DEFAULT_ENABLED);
  const judge = typeof judgeOption === 'object' ? judgeOption.judge : undefined;
  let electorChooser = deps.chooser;
  if (judgeEnabled && deps.chooser && judge) {
    const option = judgeOption as Exclude<AgentDeps['secondaryJudge'], boolean | undefined>;
    electorChooser = new SecondaryJudgeChooser(deps.chooser, { enabled: true, judge, budget: ctx.budget, k: option.k ?? 2, marginThreshold: option.marginThreshold, ambiguity: option.ambiguity, seedBase: runId });
  }
  if (judgeEnabled) report.secondaryJudge = { enabled: true, status: deps.chooser && judge ? 'ACTIVE' : 'SKIPPED_NO_MODEL', label: 'NOTA_NO_DECISORIA' };
  const exploration = await runExplorationStage(ctx, phase, electorChooser, coma);
  if (deps.chooserError && !exploration.calls.length) exploration.plannerError = { code: deps.chooserError.code, ...(deps.chooserError.message ? { message: deps.chooserError.message } : {}) };
  report.phases.exploration = { actions: exploration.actions, calls: exploration.calls.map(({ responseText: _text, ...call }) => call), plannerError: exploration.plannerError ?? null, explorationErrors: exploration.explorationErrors ?? [], ...(exploration.hints ? { hints: exploration.hints } : {}),
    reads: Object.fromEntries(Object.entries(exploration.reads).map(([id, read]) => [id, { source: read.source, columns: read.columns, rows: read.rows.length, queryId: read.queryId }])) };
  if (exploration.observationCompacted) (report.phases.exploration as any).observationCompacted = exploration.observationCompacted;
  const joinComparison = runJoinComparisonStage(ctx, phase, exploration);
  if (joinComparison) report.phases.joinComparison = joinComparison;
  const requestedMemory = deps.memory ? (deps.memory === true ? {} : deps.memory) : undefined;
  // Memory is scoped per execution mode and data origin unless the caller pins a directory.
  const memoryOrigin = { executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin };
  const memoryOptions = requestedMemory ? { ...requestedMemory, origin: memoryOrigin, dir: requestedMemory.dir ?? agentMemoryDir(ctx.universeId, memoryOrigin) } : undefined;
  let warmStart: WarmStartReport | undefined, memoryError: object | undefined;
  if (memoryOptions) { try { warmStart = planWarmStart({ universeId: ctx.universeId, discovery: phase.discovery, relations: phase.relations.map((relation: any) => { const reviewMode = reviewModeOf(ctx, relation); return reviewMode ? { ...relation, reviewMode } : relation; }), ...memoryOptions, ...(deps.now ? { now: () => Date.parse(deps.now!()) } : {}) }); } catch (error) { memoryError = failure(error); } }
  const reusedIds = new Set(warmStart?.reused.map(item => item.relationId) ?? []);
  const probes = await runProbeStage(ctx, reusedIds.size ? { ...phase, relations: phase.relations.filter((relation: any) => !reusedIds.has(relation.id)) } : phase, deps.probeChooser, deps.now, exploration.hints);
  stampConfiguredReviewOrigin(probes.relations, phase.relations);
  report.probeSelection = { mode: probes.selection.mode, modelRanking: probes.selection.calls.length > 0 ? 'USED' : phase.relations.length === 0 ? 'NOT_APPLICABLE_NO_CONFIGURED_PROBES' : 'NOT_USED', fallback: probes.selection.fallback ?? null, selected: probes.selection.selected, skipped: probes.selection.skipped,
    calls: probes.selection.calls.map(({ responseText: _text, ...call }) => call), ...(probes.selection.hints ? { hints: probes.selection.hints } : {}) };
  report.phases.probes = { mode: probes.selection.mode, selected: probes.selection.selected, skipped: probes.selection.skipped, error: probes.error ?? null };
  report.phases.critic = deps.critic === false ? { status: 'DISABLED' } : await runCriticStage(ctx, phase, probes, { criticAssist: deps.criticAssist, now: deps.now });
  const criticAssist = (report.phases.critic as any).assist;
  if (criticAssist) { report.criticAssist = criticAssist; delete (report.phases.critic as any).assist; }
  // Post-COMA runs last, on whatever budget is left: out-of-scope proposals become coverage diagnostics, never verdicts.
  ctx.budget.enterPhase('postComa');
  const postComaScope: PostComaScope = { universeId: ctx.universeId, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin };
  const postComaPrior = deps.postComaPrior === false ? undefined : deps.postComaPrior ?? (deps.persist !== false ? latestPriorRun(postComaScope, runId) : undefined);
  // E3-07a: one source-pool reader per run (budgeted client, one F4 read per degenerate column).
  const sourcePool = createSourcePoolReader({ client: ctx.client as any, cfg: ctx.cfg, scope: runId });
  report.postComa = await runPostComa({ cfg: ctx.cfg, catalog: ctx.catalog, discovery: phase.discovery, proposals: coma.production?.outOfScopeProposals ?? [], client: ctx.client, budget: ctx.budget, production: coma.production, scope: postComaScope, ...(postComaPrior ? { prior: postComaPrior } : {}), sourcePool, ...(profilesWanted(ctx) ? { profile: profileReaderOf(ctx) } : {}), ...(tieBreakEnabled(ctx.manifest) ? { tieBreak: { orderTies } } : {}), ...(resumeJournal ? { resume: { journal: resumeJournal } } : journalTarget ? { journal: journalTarget } : {}) });
  if (sourcePool.stats.queries || sourcePool.stats.hits) (report.postComa as any).sourcePool = { ...sourcePool.stats };
  if (deps.resume) {
    const executed = ((report.postComa as any)?.proposals ?? []).filter((item: any) => item?.coverageProbe?.status === 'EXECUTED').length, resumedProbes = Number((report.postComa as any)?.policy?.resumedProbes ?? 0);
    report.resume = { resumedFrom: path.relative(ROOT, journalFile).split(path.sep).join('/'), resumedProbes, newProbes: Math.max(0, executed - resumedProbes), interruptions, journalFound: journalExisted, limits: 'only post-COMA is resumed; exploration, model review and contract probes run again from the start' };
  }
  const candidateEndpoints = new Map<string, { from: unknown; to: unknown }>();
  const reviewDecisionSink: { stats?: ReviewDecisionStats } = {};
  const candidateReview = await runCandidateReviewStage(ctx, phase, report.postComa, deps.candidateReview, { reviewDecisionSink, now: deps.now ?? (() => new Date().toISOString()), critic: deps.critic !== false, criticAssist: deps.criticAssist, ...(deps.reviewHealth ? { reviewHealth: deps.reviewHealth } : {}), ...(deps.consistency ? { consistency: deps.consistency } : {}), ...(memoryOptions ? { memory: { dir: memoryOptions.dir, origin: memoryOrigin, ...(memoryOptions.ttlMs !== undefined ? { ttlMs: memoryOptions.ttlMs } : {}), ...(deps.now ? { now: () => Date.parse(deps.now!()) } : {}) } } : {}) });
  if (candidateReview) {
    report.phases.candidateReview = candidateReview.section;
    const reusedHere = (candidateReview as any).reused as WarmStartReport['reused'] | undefined;
    if (reusedHere?.length) {
      warmStart = { schemaVersion: 1, mode: 'WARM', reused: [...(warmStart?.reused ?? []), ...reusedHere], reprobe: warmStart?.reprobe ?? [], queriesSaved: (warmStart?.queriesSaved ?? 0) + reusedHere.reduce((sum, item) => sum + item.queriesSaved, 0) };
      for (const [id, ends] of (candidateReview as any).endpoints as Map<string, { from: unknown; to: unknown }>) candidateEndpoints.set(id, ends);
    }
    if ((candidateReview as any).stage) { const stage = (candidateReview as any).stage as ProbeStage; probes.relations = [...probes.relations, ...stage.relations]; if (stage.error && !probes.error) probes.error = stage.error; }
  }
  // PX-X2-9: every decision carries the relation's endpoints so an evaluation never needs artifacts.json.
  const endpointsOf = (relationId: string) => { const relation = phase.relations.find((item: any) => item.id === relationId); return relation ? { from: relation.from, to: relation.to } : candidateEndpoints.get(relationId); };
  report.decisions = [...decisionsOf(probes.relations), ...(warmStart?.reused ?? []).map(item => ({ relationId: item.relationId, verdict: 'SOSTENIDA', ...(endpointsOf(item.relationId) ?? {}), ...(item.reviewOrigin ? { reviewOrigin: item.reviewOrigin } : {}), reasonCodes: ['REUSED_FROM_MEMORY'], reused: { claimId: item.claimId, version: item.version, fromRunId: item.reusedFromRunId } }))];
  if (memoryOptions) report.memory = memoryError ? { schemaVersion: 1, status: 'ERROR', runId, universeId: ctx.universeId, error: memoryError }
    : recordRunMemory({ universeId: ctx.universeId, runId, discovery: phase.discovery, probes: probes.relations, warmStart, dir: memoryOptions.dir, origin: memoryOrigin, ...(deps.now ? { now: deps.now } : {}) });
  if (report.memory && reviewDecisionSink.stats) (report.memory as any).reviewDecisions = reviewDecisionSink.stats;
  // Full typed probe results (relation contract, typed evidence, freshness) are kept in memory as report.artifacts and
  // persisted next to the run as artifacts.json, so a run can be re-evaluated offline without new reads.
  Object.defineProperty(report, 'artifacts', { value: { discovery: phase.discovery, probes: probes.relations }, enumerable: false });
  if (deps.persist !== false) {
    writeJson(`${ctx.prefix}artifacts.json`, { schemaVersion: 1, runId, universeId: ctx.universeId, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin, utc: report.utc, probes: probes.relations });
    report.artifactsFile = `${ctx.prefix}artifacts.json`;
  }
  // Model participation and degradations (S1): a run is only COMPLETED when nothing it was asked to do silently failed to run.
  const degradations: { phase: string; code: string; detail?: string }[] = [], degrade = (phaseName: string, code: string, detail?: unknown) => degradations.push({ phase: phaseName, code, ...(detail === undefined || detail === null ? {} : { detail: String(detail) }) });
  for (const id of phase.dropped) degrade('discovery', 'RELATION_DROPPED_TABLE_ABSENT', id);
  let explorationDegraded = false;
  const plannerError = (report.phases.exploration as any).plannerError as { code?: string; message?: string } | null;
  // N27: a read that FAILED is a degradation of its own; a later budget stop (which overwrites plannerError) must not hide it.
  const explorationReadErrors = ((report.phases.exploration as any).explorationErrors ?? []) as unknown[];
  if (explorationReadErrors.length) { degrade('exploration', 'EXPLORATION_READ_FAILED', `n=${explorationReadErrors.length}`); explorationDegraded = true; }
  if (deps.modelRequested) {
    // The model participated when at least one of its decisions was VALID. A later budget stop is informational; any other later error is a degradation.
    const validCalls = exploration.calls.filter((call: any) => call.decisionStatus === 'VALID').length;
    const failed = validCalls === 0;
    report.modelParticipation = failed ? 'FAILED' : 'USED';
    if (failed) { report.modelParticipationReason = plannerError?.code ?? deps.chooserError?.code ?? 'NO_MODEL_CALLS'; degrade('exploration', report.modelParticipationReason, plannerError?.message ?? deps.chooserError?.message); }
    else if (plannerError?.code) { degrade('exploration', plannerError.code, plannerError.message); if (!BUDGET_STOP_CODES.has(plannerError.code)) explorationDegraded = true; }
    else if (deps.chooserError) degrade('exploration', deps.chooserError.code, deps.chooserError.message);
  } else {
    // The offline fixture chooser makes real calls that are scripted, not a model: neither NOT_REQUESTED (it chose) nor USED (no model).
    const scripted = exploration.calls.length > 0 && exploration.calls.every((call: any) => call.requestedModel === 'fixture-script');
    report.modelParticipation = scripted ? 'SCRIPTED_OFFLINE' : 'NOT_REQUESTED';
    if (deps.modelRequested === false && ctx.executionMode === 'LIVE') degrade('exploration', 'NO_MODEL_REQUESTED', 'the run was started without a model (--no-model)');
  }
  if (!deps.modelRequested && plannerError?.code && plannerError.code !== 'AGENT_CHOOSER_UNAVAILABLE') degrade('exploration', plannerError.code, plannerError.message);
  const criticStatus = (report.phases.critic as any).status;
  if (['SKIPPED', 'DISABLED', 'ERROR'].includes(criticStatus)) degrade('critic', `CRITIC_${criticStatus}`, (report.phases.critic as any).reason ?? (report.phases.critic as any).error?.code);
  if (deps.comaRequested && coma.status === 'NOT_CONFIGURED') degrade('coma', 'COMA_NOT_CONFIGURED');
  // A real bridge/provider failure is a degradation that changes the status; out-of-scope proposals (the expected result of a blind run) are not an error.
  // A real failure of the COMA provider is reported by post-COMA as COMA_FAILED (out-of-scope matches of a blind run are ABSTAINED, not errors).
  const comaFailed = (report.postComa as any)?.status === COMA_FAILED;
  if (comaFailed) degrade('coma', COMA_FAILED, ((report.postComa as any).errors ?? []).map((error: { code: string }) => error.code).join(','));
  if (report.resume) degrade('run', 'RESUMED_AFTER_INTERRUPTION', `resumedProbes=${report.resume.resumedProbes} newProbes=${report.resume.newProbes} interruptions=${report.resume.interruptions}`);
  const candidateSection = candidateReview?.section as { status: string; error?: { code?: string }; reason?: string; health?: ReviewHealth } | undefined;
  const reviewHealth = candidateSection?.health;
  if (candidateSection) {
    // Listed always; it changes the status only in a LIVE run (an offline baseline of a MODEL_ADVERSARIAL universe runs blind on purpose).
    if (candidateSection.status === 'SKIPPED_NO_REVIEWER') degrade('review', 'MODEL_REVIEW_UNAVAILABLE', 'candidate review');
    else if (candidateSection.status === 'FAILED') degrade('review', candidateSection.error?.code ?? 'MODEL_REVIEW_FAILED', 'candidate review');
    else if (candidateSection.status === 'NOT_APPLIED') degrade('review', 'MODEL_CONTRACT_NOT_APPLIED', candidateSection.reason);
    // E1-01: a review that finished but is defective (budget cut, invalid/truncated calls over the threshold, adversary not completed) degrades the run with its counts.
    if ((candidateSection as any).consistency?.status === 'ERROR') degrade('review', 'CONSISTENCY_FAILED', (candidateSection as any).consistency.error?.code);
    for (const code of reviewHealth?.codes ?? []) degrade('review', code, `calls ${reviewHealth!.calls}, invalid ${reviewHealth!.invalidCalls}, truncated ${reviewHealth!.truncatedCalls}, skippedBudget ${reviewHealth!.skippedBudgetCalls}, adversaryIncomplete ${reviewHealth!.adversary.incomplete}/${reviewHealth!.adversary.attempted}`);
  }
  if (deps.memory && report.memory?.status === 'ERROR') degrade('memory', 'MEMORY_ERROR', report.memory.error?.code);
  // E1-02: rejected claims are quarantined, never silently dropped: the run says n/N and why. Over the declared threshold nothing was written and the run FAILS.
  const memoryBatch = deps.memory ? report.memory?.batch : undefined;
  if (memoryBatch?.unhealthy) degrade('memory', 'MEMORY_BATCH_UNHEALTHY', `${memoryBatch.rejected}/${memoryBatch.total} claims rejected; nothing written`);
  else if (memoryBatch && memoryBatch.rejected > 0) degrade('memory', 'MEMORY_CLAIMS_QUARANTINED', `${memoryBatch.rejected}/${memoryBatch.total} claims rejected into quarantine (${memoryBatch.reasons.map((item: { code: string }) => item.code).filter((code: string, index: number, all: string[]) => all.indexOf(code) === index).join(',')})`);
  if (report.criticAssist?.status === 'SKIPPED_NO_MODEL') degrade('critic', 'CRITIC_ASSIST_NO_MODEL');
  if (report.secondaryJudge?.status === 'SKIPPED_NO_MODEL') degrade('exploration', 'SECONDARY_JUDGE_NO_MODEL');
  for (const item of probes.selection.skipped) if (/BUDGET/.test(item.reason)) degrade('probes', item.reason, item.relationId);
  for (const item of ctx.budget.snapshot().exhausted) degrade('budget', `BUDGET_EXHAUSTED_${String(item).toUpperCase()}`);
  report.degradations = degradations;
  // Informational degradations (--no-model, exhausted budgets, budget-skipped probes) are listed but never change the status.
  // Core phases (discovery, post-COMA, review, memory) decide DEGRADED / DEGRADED_NO_MODEL; auxiliary ones (exploration, critic) only give COMPLETED_WITH_WARNINGS.
  const hardStatus = memoryBatch?.unhealthy ? 'FAILED' : probes.error ? 'PARTIAL' : undefined;
  const classification = classifyRunStatus({ ...report, status: hardStatus }, { explorationDegraded });
  report.status = classification.status;
  report.phaseStatus = classification.phaseStatus;
  report.statusExplanation = classification.statusExplanation;
  return finish();
}
