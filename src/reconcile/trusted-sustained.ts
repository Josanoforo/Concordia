/**
 * The one definition of a trustworthy SOSTENIDA (RC-9): it carries the run that observed it, the receipt of the requests behind it and a REVIEWED contract.
 * The write gate (reconcile/index.ts), the persisted-state validation (reconcile/persistence.ts) and the warm start (agent/memory.ts) all use this predicate,
 * so the rule cannot drift between them. No imports on purpose: every reconcile module can depend on it.
 */
export const SOURCE_VERSION_UNSPECIFIED = 'unspecified';
export const SOURCE_VERSION_UNVERSIONED = 'unversioned';

/** A source version that does not identify a real version: absent, empty or one of the two placeholders. */
export const isPlaceholderSourceVersion = (version: string | undefined | null): boolean => !version || version === SOURCE_VERSION_UNSPECIFIED || version === SOURCE_VERSION_UNVERSIONED;

export interface SustainedProvenance {
  runId?: string;
  requestIds?: readonly string[];
  reviewState?: string;
  observations?: readonly { runId?: string }[];
}
/** Run id (on the claim or on any of its observations) AND a non-empty receipt AND a REVIEWED contract. */
export function isTrustedSustained(claim: SustainedProvenance): boolean {
  const hasRun = Boolean(claim.runId) || (claim.observations ?? []).some(item => Boolean(item.runId));
  return hasRun && (claim.requestIds?.length ?? 0) > 0 && claim.reviewState === 'REVIEWED';
}

/**
 * R-seal: who reviewed the contract behind a claim. The two origins are never confused: a model review is sealed MODEL_REVIEWED and never satisfies a slot that
 * requires a human. A claim written before the seal that carries a REVIEWED contract is read as HUMAN_REVIEWED (those contracts were declared or approved by people);
 * one without a review state has no origin.
 */
export type ReviewOrigin = 'HUMAN_REVIEWED' | 'MODEL_REVIEWED';
export const REVIEW_ORIGINS: readonly ReviewOrigin[] = ['HUMAN_REVIEWED', 'MODEL_REVIEWED'];
export const isReviewOrigin = (value: unknown): value is ReviewOrigin => REVIEW_ORIGINS.includes(value as ReviewOrigin);
export const claimReviewOrigin = (claim: { reviewOrigin?: string; reviewState?: string }): ReviewOrigin | undefined =>
  isReviewOrigin(claim.reviewOrigin) ? claim.reviewOrigin : claim.reviewState === 'REVIEWED' ? 'HUMAN_REVIEWED' : undefined;
