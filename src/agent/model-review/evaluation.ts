/**
 * Offline evaluation of the reviewer against human labels (the F-04 set for TPCDS). The labels are an ARGUMENT: nothing in src/ imports them, and a runtime
 * review never sees them. Every figure carries its denominator; a measurement made with stand-in models says so in its `provenance` and is not model evidence.
 */
import type { Decision, ModelReview, ReviewProvenance } from './types.ts';

export type ExpectedLabel = 'YES' | 'DEFERRED' | 'DECOY' | 'NOT_OFFERED';
export interface EvaluationLabel { relationId: string; label: ExpectedLabel }

export interface ClassAgreement {
  label: ExpectedLabel;
  /** Labelled relations of this class (the denominator). */
  n: number;
  /** Labelled relations that have a review. */
  reviewed: number;
  byDecision: Record<Decision, number>;
  /** Decision equals the expected one (YES: accept; DEFERRED: defer; DECOY: reject; NOT_OFFERED: no expectation, counted as non-accept). */
  exact: number;
  /** Decision is acceptable: YES: accept; DEFERRED, DECOY and NOT_OFFERED: defer or reject. */
  acceptable: number;
}
export interface AgreementReport {
  provenance: ReviewProvenance | 'MIXED';
  classes: Record<ExpectedLabel, ClassAgreement>;
  /** Over YES + DEFERRED + DECOY (NOT_OFFERED is reported apart). */
  overall: { n: number; exact: number; acceptable: number };
  /** An accept where the label is not YES: the harm that matters. */
  falseAccepts: { relationId: string; label: ExpectedLabel }[];
  /** A non-accept where the label is YES. */
  missedAccepts: { relationId: string; decision: Decision }[];
  /** Labels with no review in the run (counted in the denominators, never as agreement). */
  withoutReview: string[];
}

const emptyClass = (label: ExpectedLabel): ClassAgreement => ({ label, n: 0, reviewed: 0, byDecision: { accept: 0, defer: 0, reject: 0 }, exact: 0, acceptable: 0 });

export function measureAgreement(reviews: readonly ModelReview[], labels: readonly EvaluationLabel[]): AgreementReport {
  const byId = new Map(reviews.map(review => [review.relationId, review]));
  const classes = { YES: emptyClass('YES'), DEFERRED: emptyClass('DEFERRED'), DECOY: emptyClass('DECOY'), NOT_OFFERED: emptyClass('NOT_OFFERED') };
  const falseAccepts: AgreementReport['falseAccepts'] = [], missedAccepts: AgreementReport['missedAccepts'] = [], withoutReview: string[] = [];
  for (const { relationId, label } of labels) {
    const group = classes[label];
    group.n++;
    const review = byId.get(relationId);
    if (!review) { withoutReview.push(relationId); continue; }
    group.reviewed++; group.byDecision[review.decision]++;
    if (label === 'YES') { if (review.decision === 'accept') { group.exact++; group.acceptable++; } else missedAccepts.push({ relationId, decision: review.decision }); }
    else {
      if (review.decision === 'accept') falseAccepts.push({ relationId, label });
      else group.acceptable++;
      if ((label === 'DEFERRED' && review.decision === 'defer') || (label === 'DECOY' && review.decision === 'reject') || (label === 'NOT_OFFERED' && review.decision !== 'accept')) group.exact++;
    }
  }
  const labelled = [classes.YES, classes.DEFERRED, classes.DECOY];
  const provenances = new Set(reviews.map(review => review.provenance));
  return {
    provenance: provenances.size === 1 ? [...provenances][0]! : 'MIXED', classes,
    overall: { n: labelled.reduce((sum, group) => sum + group.n, 0), exact: labelled.reduce((sum, group) => sum + group.exact, 0), acceptable: labelled.reduce((sum, group) => sum + group.acceptable, 0) },
    falseAccepts, missedAccepts, withoutReview
  };
}

/** One-line summary with denominators, for tables and logs. */
export function agreementLine(report: AgreementReport): string {
  const { YES, DEFERRED, DECOY } = report.classes;
  return `YES accepted ${YES.exact}/${YES.n}; DEFERRED not accepted ${DEFERRED.acceptable}/${DEFERRED.n} (exact defer ${DEFERRED.exact}/${DEFERRED.n}); DECOYS not accepted ${DECOY.acceptable}/${DECOY.n} (exact reject ${DECOY.exact}/${DECOY.n}); false accepts ${report.falseAccepts.length}; missed accepts ${report.missedAccepts.length}; overall acceptable ${report.overall.acceptable}/${report.overall.n}`;
}

/** One markdown row of the ablation table. */
export function agreementRow(name: string, report: AgreementReport): string {
  const { YES, DEFERRED, DECOY, NOT_OFFERED } = report.classes;
  return `| ${name} | ${YES.exact}/${YES.n} | ${DEFERRED.acceptable}/${DEFERRED.n} (${DEFERRED.exact}/${DEFERRED.n}) | ${DECOY.acceptable}/${DECOY.n} (${DECOY.exact}/${DECOY.n}) | ${NOT_OFFERED.acceptable}/${NOT_OFFERED.n} | ${report.falseAccepts.length} | ${report.overall.acceptable}/${report.overall.n} |`;
}
export const AGREEMENT_HEADER = '| Configuration | YES accepted | DEFERRED not accepted (exact defer) | DECOYS not accepted (exact reject) | catalog_page not accepted | false accepts | overall acceptable |\n|---|---|---|---|---|---|---|';
