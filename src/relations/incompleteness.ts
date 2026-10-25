import type { Decision, EvidenceBundle, RelationContract } from '../contracts/types.ts';

/**
 * Why a decision with reason `evidence_incomplete_or_truncated` is incomplete. The verdict and reasonCode are untouched
 * (INDETERMINADA stays INDETERMINADA); this only types the reason, beside the Decision so no decision hash changes.
 *  - EXPECTED_SAMPLE_CAP: every read succeeded and an endpoint stopped at its declared row limit (or was flagged bounded).
 *  - EXECUTION_FAILURE: a read failed, was partial, or its transport/truncation state is unknown.
 *  - ENDPOINT_MISSING: no observation exists for an endpoint of the relation.
 * Precedence when several apply: ENDPOINT_MISSING, then EXECUTION_FAILURE, then EXPECTED_SAMPLE_CAP.
 */
export type IncompletenessKind = 'EXPECTED_SAMPLE_CAP' | 'EXECUTION_FAILURE' | 'ENDPOINT_MISSING';
export interface Incompleteness {
  kind: IncompletenessKind;
  detail: {
    cappedEndpoints: { sourceRef: string; limit: number | 'UNKNOWN'; rows: number }[];
    failedObservations: { observationId: string; transportStatus: string; truncated: boolean | 'UNKNOWN' }[];
    missingEndpoints: string[];
    bundleCompleteness: string[];
  };
}

/** Types the incompleteness of the evidence, or returns undefined when the evidence is complete for its scope. */
export function classifyIncompleteness(contract: RelationContract, evidence: readonly EvidenceBundle[]): Incompleteness | undefined {
  const bundles = evidence.filter(bundle => bundle.relationRef === contract.id);
  const observations = bundles.flatMap(bundle => bundle.observations);
  const keyObservations = observations.filter(observation => observation.type === 'KEY_MEMBERSHIP');
  const incomplete = bundles.some(bundle => bundle.completeness !== 'COMPLETE_FOR_SCOPE') || observations.some(observation => observation.transportStatus !== 'OK' || observation.truncated !== false);
  if (!incomplete) return undefined;
  const missingEndpoints = [...new Set([contract.from.sourceId, contract.to.sourceId])].filter(sourceId => !keyObservations.some(observation => observation.sourceRef === sourceId)).sort();
  const failedObservations = observations.filter(observation => observation.transportStatus !== 'OK' || observation.truncated === 'UNKNOWN')
    .map(observation => ({ observationId: observation.observationId, transportStatus: observation.transportStatus, truncated: observation.truncated }));
  const cappedEndpoints = keyObservations.filter(observation => observation.transportStatus === 'OK' && observation.truncated === true)
    .map(observation => ({ sourceRef: observation.sourceRef, limit: observation.limit, rows: observation.measuredTuples.length }));
  const bundleCompleteness = [...new Set(bundles.map(bundle => bundle.completeness))].sort();
  const failedBundle = bundles.some(bundle => bundle.completeness === 'TRANSPORT_FAILED' || bundle.completeness === 'UNKNOWN');
  const kind: IncompletenessKind = missingEndpoints.length ? 'ENDPOINT_MISSING'
    : failedObservations.length || failedBundle || !cappedEndpoints.length ? 'EXECUTION_FAILURE' : 'EXPECTED_SAMPLE_CAP';
  return { kind, detail: { cappedEndpoints, failedObservations, missingEndpoints, bundleCompleteness } };
}

/** Same typing, but only for a decision that is incomplete for this reason; any other decision returns undefined. */
export function incompletenessOfDecision(decision: Decision, contract: RelationContract, evidence: readonly EvidenceBundle[]): Incompleteness | undefined {
  return decision.reasonCodes.includes('evidence_incomplete_or_truncated') ? classifyIncompleteness(contract, evidence) : undefined;
}
