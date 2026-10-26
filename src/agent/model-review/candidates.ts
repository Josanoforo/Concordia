/**
 * Decision R-1 flow (Central, 25-oct): the model review acts BEFORE the contract probes, on the blind post-COMA candidates, exactly as the human F-04 did on live-04.
 *   candidates (probed, HIGH coverage, no suspicion) -> judges + adversarial pass -> APPROVED ones become a model contract (reviewState REVIEWED, reviewOrigin MODEL_REVIEWED)
 *   -> the engine applies it like the human overlay, probes it, and the unchanged policy decides. REJECTED / DEFERRED get no contract, so they never reach SOSTENIDA.
 * This function only builds the contract and the auditable artifact (`model-review-overlay.json`); applying it, probing it and sealing the memory are the engine's.
 */
import { buildPackets, reviewEligibility, type PacketContext, type ProbedProposalInput } from './evidence.ts';
import { proposedContract, type ContractDefaults, type ModelReviewedContract } from './contract.ts';
import { runModelReview } from './reviewer.ts';
import type { AssistBudget } from '../critic-assist.ts';
import { MODEL_REVIEW_LABEL_NO_ADVERSARIAL, MODEL_REVIEW_PROMPT_VERSION, type AttackFamily, type Decision, type ModelDrift, type ModelReview, type ModelReviewConfig, type ModelReviewRun, type ModelRoleRow, type ReviewStartDetail, type PriorityEntry, type ReasonCode, type ReusedReviewDecision, type DecisionMemoryActivity, type ReviewDecisionMemory, type ReviewModel, type ReviewProvenance, type ReviewTraceEvent } from './types.ts';

export interface ModelReviewOverlayRelation extends ModelReviewedContract {
  review: { decision: 'accept'; confidence: ModelReview['confidence']; reasons: ReasonCode[]; adversarialPass: ModelReview['adversarialPass']; attacksSurvived: AttackFamily[]; promptHashes: string[]; calls: number; tokens: number };
}
export interface ModelReviewOverlay {
  schemaVersion: 1;
  kind: 'MODEL_REVIEW_OVERLAY';
  universe: string;
  /** Not HUMAN_REVIEW: the engine must not read this as a human overlay, and a universe that requires HUMAN does not apply it. */
  origin: 'MODEL_REVIEW';
  label: string;
  provenance: ReviewProvenance;
  promptVersion: string;
  generatedAt: string;
  /** The approval block the overlay reader requires. The approver is the set of models, never a person; the quote is the honest label with the counts. */
  approval: { approver: string; approvedAt: string; quote: string; session: string };
  relations: ModelReviewOverlayRelation[];
  /** Candidates whose MODEL_REVIEWED SOSTENIDA the engine reuses from memory: not sent to a model, not a contract here (the engine keeps the reuse), not a rejection. */
  reused: { relationId: string; reason: string }[];
  /** N2: rejections and deferrals taken from the review decision memory (same evidence fingerprint and prompt version): 0 calls, reasonCode REUSED_REVIEW_DECISION_FROM_MEMORY, origin MODEL_REVIEWED. They are also in `notApproved`/`deferred`, so the engine treats them like any other relation without a contract. Present only when a memory was supplied. */
  reusedNegative?: ReusedReviewDecision[];
  /** N2: what the memory did in this run (lookups, hits, claims refused, decisions recorded, errors swallowed). */
  decisionMemory?: DecisionMemoryActivity;
  /** Reviewed or never reviewed, and not approved: same shape the overlay reader takes for `deferred`. */
  deferred: { id: string; reason: string }[];
  /** Everything that did not become a contract, with why (reviewed and not approved, or never reviewed). */
  notApproved: { relationId: string; decision: Decision; reasons: string[]; reviewed: boolean }[];
  /** E5-07: one row per role with the model id the receipts report and the call counts (calls, invalid, truncated, tokens). Rendered by the report. */
  modelTable: ModelRoleRow[];
  /** C4: the effective model per role and the drift of the route (calls answered by a model other than the role's dominant one). Pinning is proposed, not active. */
  modelDrift: ModelDrift;
  /** C4: what the review set out to do (candidates, cascade split, bounds on calls and tokens), as the start event reported it. */
  start: ReviewStartDetail;
  /** E5-08: the review order (structure first) and the relations the budget left without a full review, each with its rank. */
  priority: { order: PriorityEntry[]; skipped: PriorityEntry[] };
  /** How the run was configured: judges, attack scope, token caps, cascade. */
  config: ModelReviewRun['config'];
  /** Every review made, approved or not, with each evaluation and attack and the call behind it (prompt hash, requested model, raw response, receipt, tokens). */
  reviews: ModelReview[];
  counts: { candidates: number; reused: number; reviewed: number; approved: number; deferred: number; rejected: number; notReviewed: number; calls: number; tokens: number; skippedByCascade: number; cascadeEstimatedTokensAvoided: number; /** The same calls valued at the tokens per call this run measured (the live figure). */ cascadeTokensAvoidedObserved: number;
    /** N2 (with a memory): relations decided from memory, and the calls and tokens that spared. `calls` and `tokens` above already exclude them. candidates = reused + reusedNegative + reviewed-by-model + notReviewed. */
    reusedNegative?: number; reusedNegativeCallsAvoided?: number; reusedNegativeTokensAvoided?: number };
  limitations: string[];
}

export interface OverlayBuildInput {
  run: ModelReviewRun;
  /** Candidates that never reached a model, with the reason. */
  /** `reviewed: true` marks a reused candidate that new evidence now excludes: the engine must stop reusing it. */
  notReviewed: readonly { relationId: string; reason: string; reviewed?: boolean }[];
  reused?: readonly string[];
  candidates: number;
  universeId: string;
  defaults: ContractDefaults;
  allowStandIn?: boolean;
  now?: () => string;
  runId?: string;
  actors: readonly string[];
}
/** Contracts and the auditable overlay from a finished review run. Shared by the candidate flow and the engine stage. */
export function buildModelReviewOverlay(input: OverlayBuildInput): { overlay: ModelReviewOverlay; contracts: ModelReviewedContract[] } {
  const { run, notReviewed } = input;
  const reused = (input.reused ?? []).map(relationId => ({ relationId, reason: 'REUSED_FROM_MEMORY: a valid MODEL_REVIEWED SOSTENIDA is held; not re-reviewed' }));
  const contracts: ModelReviewedContract[] = [], relations: ModelReviewOverlayRelation[] = [];
  const hashes = (review: ModelReview) => [...review.evaluations.map(item => item.promptHash), review.adversary.promptHash].filter((hash): hash is string => typeof hash === 'string');
  for (const review of run.reviews) {
    const contract = proposedContract(review, input.defaults, { allowStandIn: input.allowStandIn === true });
    if (!contract) continue;
    contracts.push(contract);
    relations.push({ ...contract, review: { decision: 'accept', confidence: review.confidence, reasons: review.reasons, adversarialPass: review.adversarialPass, attacksSurvived: review.attacksSurvived.map(attack => attack.family), promptHashes: hashes(review), calls: review.calls, tokens: review.tokens } });
  }
  const approved = new Set(contracts.map(contract => contract.id));
  const notApproved = [
    ...run.reviews.filter(review => !approved.has(review.relationId)).map(review => ({ relationId: review.relationId, decision: review.decision, reasons: [...review.reasons], reviewed: true })),
    ...(run.reusedDecisions ?? []).map(item => ({ relationId: item.relationId, decision: item.decision, reasons: [item.reasonCode, ...item.originalReasons], reviewed: false })),
    ...notReviewed.map(item => ({ relationId: item.relationId, decision: 'defer' as const, reasons: [item.reason], reviewed: item.reviewed === true }))
  ];
  const generatedAt = (input.now ?? (() => new Date().toISOString()))();
  const label = relations[0]?.label ?? MODEL_REVIEW_LABEL_NO_ADVERSARIAL;
  const overlay: ModelReviewOverlay = {
    schemaVersion: 1, kind: 'MODEL_REVIEW_OVERLAY', universe: input.universeId, origin: 'MODEL_REVIEW', label, provenance: run.provenance,
    promptVersion: MODEL_REVIEW_PROMPT_VERSION, generatedAt,
    approval: { approver: `models: ${input.actors.join(', ')}`.slice(0, 120), approvedAt: generatedAt, quote: `${label}: ${contracts.length} approved of ${run.reviews.length} reviewed (${notReviewed.length} not reviewed); bounded sample only, not a human review`, session: (input.runId ?? 'model-review').slice(0, 200) },
    relations, reused, ...(run.reusedDecisions ? { reusedNegative: run.reusedDecisions, ...(run.decisionMemory ? { decisionMemory: run.decisionMemory } : {}) } : {}), modelTable: run.modelTable, modelDrift: run.modelDrift, start: run.start, priority: run.priority, config: run.config, reviews: run.reviews, deferred: notApproved.map(item => ({ id: item.relationId, reason: `${item.decision}${item.reasons.length ? `: ${item.reasons.join(', ')}` : ''}` })), notApproved,
    counts: { candidates: input.candidates, reused: reused.length, reviewed: run.reviews.length, approved: contracts.length, deferred: run.counts.defer, rejected: run.counts.reject, notReviewed: notReviewed.length, calls: run.counts.calls, tokens: run.counts.tokens, skippedByCascade: run.counts.skippedByCascade, cascadeEstimatedTokensAvoided: run.counts.cascadeEstimatedTokensAvoided, cascadeTokensAvoidedObserved: run.counts.cascadeTokensAvoidedObserved, ...(run.reusedDecisions ? { reusedNegative: run.counts.reusedNegative ?? 0, reusedNegativeCallsAvoided: run.counts.reusedNegativeCallsAvoided ?? 0, reusedNegativeTokensAvoided: run.counts.reusedNegativeTokensAvoided ?? 0 } : {}) },
    limitations: [...run.limitations, 'a model contract is applied only where the universe or relation declares MODEL_ADVERSARIAL (or BOTH, together with the human contract); never where HUMAN is required']
  };
  return { overlay, contracts };
}

export interface CandidateReviewInput {
  proposals: readonly ProbedProposalInput[];
  universeId: string;
  context: Omit<PacketContext, 'universeId'>;
  judges: readonly ReviewModel[];
  adversary: ReviewModel;
  budget: AssistBudget;
  config: ModelReviewConfig;
  defaults: ContractDefaults;
  now?: () => string;
  runId?: string;
  /** Ids the engine reuses from memory (CandidateReviewRequest.reusable). By default they are not reviewed again, and are listed as reused, not as reviewed. */
  reusable?: readonly string[];
  /** Review the reusable ones anyway. One that is then not approved comes back in notApproved with reviewed:true, which makes the engine stop reusing it. */
  reviewReusable?: boolean;
  onEvent?: (event: ReviewTraceEvent) => void;
  /** N2: the review decision memory (see ReviewDecisionMemory). Without it nothing changes. */
  reviewDecisionMemory?: ReviewDecisionMemory;
  /** Offline runs with stand-ins: allow building contracts from a STAND_IN_OFFLINE review (never in a live run). */
  allowStandIn?: boolean;
}
export interface CandidateReviewResult { run: ModelReviewRun; overlay: ModelReviewOverlay; contracts: ModelReviewedContract[] }

export async function reviewBlindCandidates(input: CandidateReviewInput): Promise<CandidateReviewResult> {
  const eligible: ProbedProposalInput[] = [], notReviewed: { relationId: string; reason: string; reviewed?: boolean }[] = [], reused: string[] = [];
  const reusable = new Set(input.reusable ?? []);
  for (const proposal of input.proposals) {
    const verdict = reviewEligibility(proposal), isReusable = reusable.has(proposal.proposalId);
    // A reusable candidate that the evidence of THIS run now excludes (suspect, lower coverage) is reported as not approved and reviewed: the old approval no longer counts. No tokens spent.
    if (isReusable && !verdict.eligible) { notReviewed.push({ relationId: proposal.proposalId, reason: `REUSABLE_NOW_EXCLUDED:${verdict.reason}`, reviewed: true }); continue; }
    if (isReusable && input.reviewReusable !== true) { reused.push(proposal.proposalId); continue; }
    if (verdict.eligible) eligible.push(proposal); else notReviewed.push({ relationId: proposal.proposalId, reason: verdict.reason });
  }
  // Siblings and negative control are read from ALL proposals, so a competing target that is itself ineligible still counts as evidence for the others.
  const { packets, audits } = buildPackets(input.proposals, { ...input.context, universeId: input.universeId });
  const ids = new Set(eligible.map(item => item.proposalId));
  const run = await runModelReview({ packets: packets.filter(packet => ids.has(packet.relationId)), unprobed: notReviewed.map(item => ({ relationId: item.relationId, source: { table: '', column: '' }, target: { table: '', column: '' }, reason: item.reason })),
    audits, judges: input.judges, adversary: input.adversary, budget: input.budget, config: input.config, ...(input.onEvent ? { onEvent: input.onEvent } : {}), ...(input.reviewDecisionMemory ? { reviewDecisionMemory: input.reviewDecisionMemory } : {}) });

  const { overlay, contracts } = buildModelReviewOverlay({ run, notReviewed, reused, candidates: input.proposals.length, universeId: input.universeId, defaults: input.defaults, allowStandIn: input.allowStandIn === true, now: input.now, runId: input.runId, actors: [...input.judges, input.adversary].map(model => model.id) });
  return { run, overlay, contracts };
}
