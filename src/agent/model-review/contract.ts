/**
 * What X5 needs to turn an accepted model review into the reviewed-contract fields the decision policy reads (the same fields the F-04 overlay carries for a
 * human review), sealed with the model origin. This builds a PROPOSAL record only: writing it into a claim, a memory entry or a verdict is X5's stage, where
 * the seal `MODEL_REVIEWED` must never satisfy a slot that requires a human.
 */
import { MODEL_REVIEWED, satisfiesModelAdversarialSlot, type ModelReview } from './types.ts';

export interface ContractDefaults {
  universeId: string;
  database: string;
  normalization: string;
  normalizationVersion: string;
  normalizationAdapterCapability: string;
}
export interface ModelReviewedContract {
  id: string;
  from: { db: string; table: string; column: string };
  to: { db: string; table: string; column: string };
  kind: 'FOREIGN_KEY';
  reviewState: 'REVIEWED';
  /** Seal. Not HUMAN_REVIEWED, and not interchangeable with it. */
  reviewOrigin: typeof MODEL_REVIEWED;
  identifierSpace: string;
  normalization: string;
  normalizationVersion: string;
  normalizationLossless: true;
  normalizationAdapterCapability: string;
  basis: string;
  label: string;
  confidence: ModelReview['confidence'];
}

/** A contract exists only for a live-model accept with a completed adversarial pass; anything else returns undefined (a stand-in only with `allowStandIn`, for offline runs). */
export function proposedContract(review: ModelReview, defaults: ContractDefaults, options: { allowStandIn?: boolean } = {}): ModelReviewedContract | undefined {
  const standIn = options.allowStandIn === true && review.provenance === 'STAND_IN_OFFLINE' && review.origin === MODEL_REVIEWED && review.decision === 'accept' && review.adversarialPass === 'COMPLETED';
  if (!satisfiesModelAdversarialSlot(review) && !standIn) return undefined;
  const slug = defaults.universeId.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id: review.relationId, from: { db: defaults.database, ...review.from }, to: { db: defaults.database, ...review.to }, kind: 'FOREIGN_KEY', reviewState: 'REVIEWED', reviewOrigin: MODEL_REVIEWED,
    identifierSpace: `${slug}-${review.to.table}-${review.to.column}-v1`, normalization: defaults.normalization, normalizationVersion: defaults.normalizationVersion, normalizationLossless: true,
    normalizationAdapterCapability: defaults.normalizationAdapterCapability,
    basis: `${review.label}: ${review.reasons.join(', ')}; bounded sample only`, label: review.label, confidence: review.confidence
  };
}
