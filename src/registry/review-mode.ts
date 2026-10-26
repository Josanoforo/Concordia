/**
 * Round 9 R-config: which review a universe (and, by override, a relation) requires before its SOSTENIDA counts as reviewed.
 * Declared config only: the default is HUMAN (today's behavior), so nothing changes without a declaration. The human flow (review overlay, F-04) is kept as is;
 * the model reviewer is an added mode. A model review never fills a slot that requires a human, and the reverse holds for MODEL_ADVERSARIAL.
 */
export const REVIEW_MODES = ['HUMAN', 'MODEL_ADVERSARIAL', 'HUMAN_OR_MODEL', 'BOTH'] as const;
export type ReviewMode = typeof REVIEW_MODES[number];
export type ReviewOrigin = 'HUMAN_REVIEWED' | 'MODEL_REVIEWED';
export const DEFAULT_REVIEW_MODE: ReviewMode = 'HUMAN';
export const isReviewMode = (value: unknown): value is ReviewMode => typeof value === 'string' && (REVIEW_MODES as readonly string[]).includes(value);

interface ReviewModeDeclaration { reviewMode?: ReviewMode; reviewModeByRelation?: Record<string, ReviewMode> }

/** Precedence: the relation's own declaration (config or overlay) > the manifest's per-relation override > the manifest's universe mode > HUMAN. */
export function requiredReviewMode(manifest: ReviewModeDeclaration | undefined, relationId?: string, relation?: { reviewMode?: unknown }): ReviewMode {
  if (isReviewMode(relation?.reviewMode)) return relation!.reviewMode as ReviewMode;
  const override = relationId === undefined ? undefined : manifest?.reviewModeByRelation?.[relationId];
  if (isReviewMode(override)) return override;
  return isReviewMode(manifest?.reviewMode) ? manifest!.reviewMode! : DEFAULT_REVIEW_MODE;
}

/** True when the set of review origins actually obtained satisfies the mode. Nothing obtained never satisfies any mode. */
export function reviewModeSatisfied(mode: ReviewMode, obtained: readonly ReviewOrigin[]): boolean {
  const human = obtained.includes('HUMAN_REVIEWED'), model = obtained.includes('MODEL_REVIEWED');
  switch (mode) {
    case 'HUMAN': return human;
    case 'MODEL_ADVERSARIAL': return model;
    case 'HUMAN_OR_MODEL': return human || model;
    case 'BOTH': return human && model;
  }
}

/** The origins a mode still lacks, so a report can say what is missing instead of a bare "not reviewed". */
export function missingReviewOrigins(mode: ReviewMode, obtained: readonly ReviewOrigin[]): ReviewOrigin[] {
  const human = obtained.includes('HUMAN_REVIEWED'), model = obtained.includes('MODEL_REVIEWED');
  if (reviewModeSatisfied(mode, obtained)) return [];
  if (mode === 'HUMAN') return ['HUMAN_REVIEWED'];
  if (mode === 'MODEL_ADVERSARIAL') return ['MODEL_REVIEWED'];
  if (mode === 'HUMAN_OR_MODEL') return ['HUMAN_REVIEWED', 'MODEL_REVIEWED'];
  return [...(human ? [] : ['HUMAN_REVIEWED' as const]), ...(model ? [] : ['MODEL_REVIEWED' as const])];
}
