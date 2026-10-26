import { readJson } from '../runtime.ts';

/**
 * Evaluation-only: the human F-04 labels of TPCDS (25 YES / 3 DEFERRED / 3 DECOY) used to measure the model reviewer offline.
 * They are a human evaluation, not an input of any run: this module is the ONLY reader of eval/review/TPCDS_f04_review_labels.json, no module under src/agent, src/probe,
 * src/discovery or src/registry imports it, and the labels never reach a prompt, a catalog or a universe config. The result goes to the reviewer's evaluation as an argument.
 */
export type F04Label = 'YES' | 'DEFERRED' | 'DECOY';
export interface F04ReviewLabel { relationId: string; label: F04Label; from: { table: string; column: string }; to: { table: string; column: string }; basis: string }
export interface F04ReviewLabels {
  schemaVersion: 1; kind: 'F04_REVIEW_EVALUATION_LABELS'; universe: string; labelling: string; evaluationOnly: true;
  approval: { approver: string; approvedAt: string; quote: string; session: string }; counts: Record<F04Label, number>; labels: F04ReviewLabel[];
}

export const loadF04ReviewLabels = (): F04ReviewLabels => readJson<F04ReviewLabels>('eval/review/TPCDS_f04_review_labels.json');

/** The `{ relationId, label }` shape the reviewer's offline evaluation takes. */
export const evaluationLabels = (set: F04ReviewLabels = loadF04ReviewLabels()) => set.labels.map(({ relationId, label }) => ({ relationId, label }));

/** Candidate relations for the reviewer to judge, without the label: the reviewer must never see which class a relation belongs to. */
export const unlabelledCandidates = (set: F04ReviewLabels = loadF04ReviewLabels()) => set.labels.map(({ relationId, from, to }) => ({ relationId, from, to }));
