import type { RunBudget } from './run-budget.ts';

/** Label of a model review that passed an adversarial pass: never "validated", never a human review. */
export const MODEL_REVIEW_LABEL = 'revisado por modelo con pase adversarial';

/** N2: a remembered reject/defer of the model review. Never an approval: it carries no verdict, no contract and no review slot. */
export interface ReviewDecisionRecord { relationId: string; decision: 'reject' | 'defer'; reasons: string[]; evidenceFingerprint: string; promptVersion: string; /** Effective models of the review (audit only). */ models?: string[] }
export interface ReviewDecisionClaim { relationId: string; decision: 'reject' | 'defer'; reasons: string[]; evidenceFingerprint: string; promptVersion: string; models: string[]; runId: string; origin: 'MODEL_REVIEWED'; recordedAt: string }
/**
 * Injected by the engine; consumed by the reviewer (X8), which computes the evidence fingerprint and decides when to reuse. `lookup` hits only when fingerprint AND prompt version match the
 * latest remembered decision of the relation; a hit counts as a reuse. `record` appends (append-only) what the review decided this run.
 */
export interface ReviewDecisionMemory {
  lookup(relationId: string, evidenceFingerprint: string, promptVersion: string): ReviewDecisionClaim | null;
  record(decisions: ReviewDecisionRecord[]): void;
}

/**
 * R-1 (Central decision): the model review acts BEFORE the contract probes, like the human F-04, on the blind post-COMA candidates. The engine owns when it runs (after post-COMA),
 * what is applied (only under MODEL_ADVERSARIAL), the probes of the resulting contracts, the unchanged policy and the seal in verdict and memory. The caller supplies the reviewer
 * (X8 reviewBlindCandidates behind a closure with its judges, adversary and thresholds); the engine never holds a model client.
 */
export interface CandidateReviewRequest {
  universeId: string; runId: string; executionMode: string; dataOrigin: string;
  /** The run post-COMA proposals, with their coverage probes (HIGH coverage and no suspicion are decided by the reviewer eligibility, not here). */
  proposals: unknown[];
  /** Column names per discovered table (metadata only). */
  tableColumns: Record<string, string[]>;
  /** The run budget in the modelReview phase: the reviewer checks and charges it. */
  budget: RunBudget;
  now: () => string;
  /** Candidates whose MODEL_REVIEWED SOSTENIDA is still valid in memory (the engine reuses them instead of probing). The reviewer MAY skip them to save tokens; if it reviews one and does not approve it, the old approval no longer counts. */
  reusable?: string[];
  /** N2: negative memory of the review (present only when the run has memory). Absent: every non-approved candidate is reviewed again. */
  reviewDecisionMemory?: ReviewDecisionMemory;
  /**
   * Global uniqueness (form F1) of the target column of every tie: HIGH, unsuspected candidates that share a source column. Key `table.column`. The counts are the only
   * thing that tells a key from a non-key when key membership ties; a target the budget could not reach is absent (the run says so in phases.candidateReview.tieEvidence).
   */
  targetGlobalUniqueness?: Record<string, { rows: number; distinct: number; nulls: number; unique: boolean }>;
  /** The same measurement as a verdict per target column (`table.column`): only the columns that were measured; an unmeasured column is absent, never UNIQUE by default. */
  globalTargetUniqueness?: Record<string, 'UNIQUE' | 'NOT_UNIQUE'>;
  /** Tie-break of a group of tied candidates (ids), X10's `orderTies` over the profiles this run measured. Present only when the manifest declares `tieBreak.enabled`; a group of fewer than two known candidates answers undefined. */
  tieBreak?: (group: readonly string[]) => { ordered: readonly string[]; decisive: boolean; reason: string } | undefined;
}
/** The fields of an accepted model review the engine turns into a configured relation (structurally the ModelReviewedContract of X8). */
export interface ModelReviewedContractLike {
  id: string;
  from: { db?: string; table: string; column: string }; to: { db?: string; table: string; column: string };
  kind: 'FOREIGN_KEY'; reviewState: 'REVIEWED'; reviewOrigin: 'MODEL_REVIEWED';
  identifierSpace: string; normalization: string; normalizationVersion: string; normalizationLossless: true; normalizationAdapterCapability: string;
  label?: string; confidence?: string; basis?: string;
}
export interface CandidateReviewOutcome {
  /** The auditable artifact (ModelReviewOverlay of X8); written as model-review-overlay.json. Its origin is MODEL_REVIEW, never a human overlay. */
  overlay: { origin: 'MODEL_REVIEW'; [key: string]: unknown };
  contracts: ModelReviewedContractLike[];
}
export type CandidateReview = (request: CandidateReviewRequest) => Promise<CandidateReviewOutcome>;
