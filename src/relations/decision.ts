import type { Decision, EvidenceBundle, EvidenceObservation, RelationContract, Unknown } from '../contracts/types.ts';
import { validateEvidenceBundle, validateRelationContract } from '../contracts/validate.ts';

export interface RelationPolicy { policyVersion: string; minimumDistinctKeys?: number; minimumOverlapRatio?: number; }
/**
 * Measured GLOBAL evidence (Round 9, P3; built by src/probe/full-evidence.ts). Two observation types, anchored on the contract's own endpoints, whole-table aggregates:
 * GLOBAL_COVERAGE [sourceDistinct, missing] on the source endpoint, GLOBAL_UNIQUENESS [rows, distinct, nulls] on the target endpoint. Without a well-formed observation the
 * matching caveat (global_coverage_not_established / global_uniqueness_not_established) stays exactly as before.
 */
export const GLOBAL_COVERAGE_OBSERVATION = 'GLOBAL_COVERAGE';
export const GLOBAL_UNIQUENESS_OBSERVATION = 'GLOBAL_UNIQUENESS';
export const GLOBAL_COVERAGE_PROJECTION = ['sourceDistinct', 'missing'] as const;
export const GLOBAL_UNIQUENESS_PROJECTION = ['rows', 'distinct', 'nulls'] as const;
const BOUNDED_SCOPE = 'bounded observed sample only; no global coverage or uniqueness claim';
const isKnown = <T>(value: Unknown<T>): value is { state: 'KNOWN'; value: T; provenance?: string } => value?.state === 'KNOWN';
const sorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en'));
const tupleToken = (tuple: unknown[]) => JSON.stringify(tuple.map(value => [value === null ? 'null' : typeof value, value]));
function normalizedTuple(contract: RelationContract, tuple: unknown[]): unknown[] | undefined {
  const output: unknown[] = [];
  for (let index = 0; index < tuple.length; index++) {
    const operation = contract.normalization[index]?.operation;
    if (!isKnown(operation)) return undefined;
    const text = String(tuple[index]);
    if (operation.value === 'text') { if (!text.length) return undefined; output.push(text); continue; }
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    if (operation.value === 'integer-pad10') {
      if (!/^\d+$/.test(trimmed)) return undefined;
      output.push(BigInt(trimmed).toString().padStart(10, '0')); continue;
    }
    if (operation.value === 'integer') {
      output.push(/^-?\d+(?:\.0+)?$/.test(trimmed) ? BigInt(trimmed.split('.')[0]).toString() : trimmed); continue;
    }
    return undefined;
  }
  return output;
}
const unknown = (): Unknown<string> => ({ state: 'UNKNOWN' });
function projectEndpointKeys(endpoint: RelationContract['from'], observations: readonly EvidenceObservation[]): unknown[][] {
  return observations.filter(observation => observation.type === 'KEY_MEMBERSHIP' && observation.sourceRef === endpoint.sourceId).flatMap(observation => {
    const indexes = endpoint.orderedColumns.map(column => observation.projection.indexOf(column));
    return indexes.some(index => index < 0) ? [[]] : observation.measuredTuples.map(row => indexes.map(index => row[index]));
  });
}

function makeDecision(contract: RelationContract, bundles: readonly EvidenceBundle[], policyVersion: string,
  verdict: Decision['verdict'], reasonCodes: string[], requirementsMet: string[], requirementsMissing: string[], contradictions: string[], status: Decision['status'], scope: string = BOUNDED_SCOPE): Decision {
  const refs = sorted(bundles.map(bundle => bundle.evidenceBundleId));
  return {
    schemaVersion: 1,
    decisionId: `decision:${JSON.stringify([contract.id, policyVersion, refs])}`,
    relationRef: contract.id,
    contractVersion: contract.contractVersion,
    verdict,
    reasonCodes: sorted(reasonCodes),
    requirementsMet: sorted(requirementsMet),
    requirementsMissing: sorted(requirementsMissing),
    contradictions: sorted(contradictions),
    scope: { state: 'KNOWN', value: scope },
    evidenceBundleRefs: refs,
    policyVersion,
    evaluatedAt: unknown(),
    requiresReview: verdict !== 'SOSTENIDA' || requirementsMissing.length > 0 || contradictions.length > 0,
    status
  };
}

const nonNegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sameStrings = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item, index) => item === b[index]);
interface GlobalMeasurements { coverage?: { sourceDistinct: number; missing: number }; uniqueness?: { rows: number; distinct: number; nulls: number; unique: boolean }; malformed: string[] }
/** Reads only well-formed, complete, single-column global observations that sit on the contract's own endpoints; anything else is ignored and reported, never trusted. */
function globalMeasurements(contract: RelationContract, observations: readonly EvidenceObservation[]): GlobalMeasurements {
  const out: GlobalMeasurements = { malformed: [] };
  if (contract.from.orderedColumns.length !== 1 || contract.to.orderedColumns.length !== 1) return out;
  for (const observation of observations) {
    if (observation.type !== GLOBAL_COVERAGE_OBSERVATION && observation.type !== GLOBAL_UNIQUENESS_OBSERVATION) continue;
    const coverage = observation.type === GLOBAL_COVERAGE_OBSERVATION, endpoint = coverage ? contract.from : contract.to;
    const tuple = observation.measuredTuples.length === 1 ? observation.measuredTuples[0] : undefined;
    const shaped = observation.sourceRef === endpoint.sourceId && observation.transportStatus === 'OK' && observation.truncated === false
      && sameStrings(observation.projection, coverage ? GLOBAL_COVERAGE_PROJECTION : GLOBAL_UNIQUENESS_PROJECTION) && tuple !== undefined && tuple.length === observation.projection.length && tuple.every(nonNegativeInteger);
    if (!shaped) { out.malformed.push(observation.type); continue; }
    const [a, b, c] = tuple as number[];
    if (coverage) { if (a < 1 || b > a || out.coverage) { out.malformed.push(observation.type); continue; } out.coverage = { sourceDistinct: a, missing: b }; }
    else { if (c > a || b > a - c || out.uniqueness) { out.malformed.push(observation.type); continue; } out.uniqueness = { rows: a, distinct: b, nulls: c, unique: a - c === b }; }
  }
  return out;
}

/** Pure deterministic evaluation of bounded key-membership evidence, plus measured global coverage/uniqueness when the bundle carries it. */
export function evaluateRelation(contract: RelationContract, evidence: readonly EvidenceBundle[], policy: RelationPolicy): Decision {
  const contractIssues = validateRelationContract(contract);
  if (contractIssues.length) throw new TypeError(`Invalid relation contract: ${contractIssues.map(issue => `${issue.path}:${issue.code}`).join(', ')}`);
  if (!policy || !/^\d+\.\d+$/.test(policy.policyVersion) || (policy.minimumDistinctKeys !== undefined && (!Number.isInteger(policy.minimumDistinctKeys) || policy.minimumDistinctKeys < 0)) || (policy.minimumOverlapRatio !== undefined && (!Number.isFinite(policy.minimumOverlapRatio) || policy.minimumOverlapRatio < 0 || policy.minimumOverlapRatio > 1))) {
    throw new TypeError('Invalid relation evaluation policy');
  }
  const related = evidence.filter(bundle => bundle.relationRef === contract.id).slice();
  for (const bundle of related) {
    const issues = validateEvidenceBundle(bundle);
    if (issues.length) throw new TypeError(`Invalid evidence bundle ${bundle.evidenceBundleId}: ${issues.map(issue => `${issue.path}:${issue.code}`).join(', ')}`);
  }
  related.sort((a, b) => a.evidenceBundleId.localeCompare(b.evidenceBundleId, 'en'));
  if (related.some(bundle => bundle.contractVersion !== contract.contractVersion)) {
    return makeDecision(contract, related, policy.policyVersion, 'INDETERMINADA', ['contract_version_mismatch'], [], ['evidence_for_exact_contract_version'], [], 'UNKNOWN');
  }
  const matching = related;
  if (!matching.length) return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['evidence_missing'], [], ['matching_evidence_bundle'], [], 'INCOMPLETE');

  const incomplete = matching.some(bundle => bundle.completeness !== 'COMPLETE_FOR_SCOPE' || bundle.observations.some(observation => observation.transportStatus !== 'OK' || observation.truncated !== false));
  if (incomplete) return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['evidence_incomplete_or_truncated'], [], ['complete_untruncated_transport'], [], 'INCOMPLETE');

  if (contract.kind !== 'SCHEMA_CORRESPONDENCE') {
    const keyObservations = matching.flatMap(bundle => bundle.observations).filter(observation => observation.type === 'KEY_MEMBERSHIP');
    const fromEvidenceRows = projectEndpointKeys(contract.from, keyObservations);
    const toEvidenceRows = projectEndpointKeys(contract.to, keyObservations);
    if (!fromEvidenceRows.length || !toEvidenceRows.length) return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['endpoint_evidence_missing'], [], ['both_endpoint_observations'], [], 'INCOMPLETE');
    if ([...fromEvidenceRows, ...toEvidenceRows].some(row => row.length !== contract.from.orderedColumns.length || row.some(value => value === null || value === undefined || typeof value === 'object'))) {
      return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['null_or_malformed_tuple_observed'], [], ['non_null_ordered_tuples'], ['tuple_shape_or_null_conflict'], 'CURRENT');
    }
  }
  const qualitySignals = matching.flatMap(bundle => bundle.observations.filter(observation => observation.type === 'SAMPLE_QUALITY').flatMap(observation => observation.measuredTuples.map(tuple => tuple[0])));
  if (qualitySignals.includes('LABEL_CONFLICT')) {
    const from = contract.from.namespace, to = contract.to.namespace;
    if (isKnown(from) && isKnown(to) && from.value !== to.value) {
      return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['incompatible_namespaces', 'observed_label_conflict'], [], ['compatible_endpoint_namespaces'], ['namespace_mismatch', 'sampled_labels_contradict'], 'UNKNOWN');
    }
    const semanticsReady = contract.kind === 'FOREIGN_KEY' && contract.reviewState === 'REVIEWED' && isKnown(contract.identifierSpace) && isKnown(from) && isKnown(to);
    if (!semanticsReady) {
      const missing = [
        ...(contract.kind === 'UNKNOWN' ? ['reviewed_relation_kind'] : []),
        ...(contract.reviewState !== 'REVIEWED' ? ['reviewed_relation_contract'] : []),
        ...(!isKnown(contract.identifierSpace) ? ['known_identifier_space'] : []),
        ...(!isKnown(from) || !isKnown(to) ? ['known_endpoint_namespaces'] : [])
      ];
      return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['observed_label_conflict_under_unknown_semantics'], [], missing, ['sampled_labels_contradict'], 'UNKNOWN');
    }
    return makeDecision(contract, matching, policy.policyVersion, 'ENGAÑOSA', ['observed_label_conflict'], ['namespace_compatible', 'reviewed_relation_kind', 'known_identifier_space'], [], ['sampled_labels_contradict'], 'CURRENT');
  }
  const blockingSignals = ['MANY_TO_MANY', 'DUPLICATE_REFERENCED_KEYS', 'TYPE_INCOMPATIBLE', 'SAMPLE_ALERT', 'LABEL_UNCERTAIN'];
  const presentBlockingSignals = sorted(qualitySignals.filter((signal): signal is string => typeof signal === 'string' && blockingSignals.includes(signal)));
  if (presentBlockingSignals.length) return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', presentBlockingSignals.map(signal => signal.toLowerCase()), [], ['sample_quality_review'], [], 'CURRENT');

  if (contract.kind === 'SCHEMA_CORRESPONDENCE') {
    const schemaFindings = matching.flatMap(bundle => bundle.observations.filter(observation => observation.type === 'SCHEMA_CORRESPONDENCE').flatMap(observation => observation.measuredTuples));
    if (!schemaFindings.length) return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['schema_correspondence_evidence_missing'], [], ['metadata_candidate_and_bounded_type_evidence'], [], 'UNKNOWN');
    const [target, rule, distinctCount, observedRows, compatible] = schemaFindings[0] ?? [];
    const contractMinimum = contract.evidencePolicy.minimumDistinctKeys === 'UNKNOWN' ? undefined : contract.evidencePolicy.minimumDistinctKeys;
    const required = contractMinimum === undefined ? policy.minimumDistinctKeys : Math.max(contractMinimum, policy.minimumDistinctKeys ?? contractMinimum);
    if (typeof target !== 'string' || !target || !['unique_metadata_concept', 'approved_metadata_alias'].includes(String(rule)) || typeof distinctCount !== 'number' || distinctCount < (required ?? Number.POSITIVE_INFINITY) || typeof observedRows !== 'number' || observedRows < 1 || compatible !== true) {
      return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['unknown_ambiguous_or_insufficient_schema_evidence'], [], ['unique_metadata_concept_bounded_values_and_compatible_type'], [], 'UNKNOWN');
    }
    return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['candidate_requires_adjudication'], ['unique_metadata_concept', 'bounded_type_compatibility'], ['adjudicated_schema_correspondence'], [], 'UNKNOWN');
  }
  const fromNamespace = contract.from.namespace;
  const toNamespace = contract.to.namespace;
  if (!isKnown(contract.identifierSpace) || !isKnown(fromNamespace) || !isKnown(toNamespace)) {
    return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['identifier_space_or_namespace_unknown'], [], ['known_identifier_space_and_namespaces'], [], 'UNKNOWN');
  }
  if (fromNamespace.value !== toNamespace.value) {
    return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['incompatible_namespaces'], [], ['compatible_endpoint_namespaces'], ['namespace_mismatch'], 'CURRENT');
  }
  if (contract.kind === 'UNKNOWN') return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['relation_kind_unknown'], [], ['reviewed_relation_kind'], [], 'UNKNOWN');
  if (contract.reviewState !== 'REVIEWED') return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['relation_contract_not_reviewed'], [], ['reviewed_relation_contract'], [], 'UNKNOWN');
  if (contract.kind !== 'FOREIGN_KEY') return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['kind_specific_evidence_required'], ['namespace_compatible'], ['kind_specific_evidence'], [], 'UNKNOWN');

  if (contract.normalization.some(component => !isKnown(component.operation) || !['text', 'integer', 'integer-pad10'].includes(component.operation.value) || !isKnown(component.version) || !isKnown(component.lossless) || component.lossless.value !== true || !isKnown(component.adapterCapability))) {
    return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['normalization_unknown_or_unsupported'], ['namespace_compatible'], ['declared_lossless_text_normalization_and_adapter_capability'], [], 'UNKNOWN');
  }
  const contractMinimum = contract.evidencePolicy.minimumDistinctKeys === 'UNKNOWN' ? undefined : contract.evidencePolicy.minimumDistinctKeys;
  const required = contractMinimum === undefined ? policy.minimumDistinctKeys : Math.max(contractMinimum, policy.minimumDistinctKeys ?? contractMinimum);
  if (required === undefined) return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['minimum_distinct_keys_unknown'], ['namespace_compatible'], ['bounded_minimum_distinct_keys'], [], 'UNKNOWN');

  const observations = matching.flatMap(bundle => bundle.observations).slice().sort((a, b) => a.sourceRef.localeCompare(b.sourceRef, 'en') || a.observationId.localeCompare(b.observationId, 'en'));
  const fromRows = projectEndpointKeys(contract.from, observations);
  const toRows = projectEndpointKeys(contract.to, observations);
  const canonicalFrom = fromRows.map(row => normalizedTuple(contract, row));
  const canonicalTo = toRows.map(row => normalizedTuple(contract, row));
  if ([...canonicalFrom, ...canonicalTo].some(row => !row)) return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['normalization_rejected_observed_value'], ['namespace_compatible'], ['values_supported_by_declared_normalization'], ['normalization_rejected_observed_value'], 'CURRENT');
  const uniqueFrom = new Map(canonicalFrom.map(row => [tupleToken(row!), row!]));
  const uniqueTo = new Set(canonicalTo.map(row => tupleToken(row!)));
  if (uniqueFrom.size < required) return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['insufficient_distinct_sample_keys'], ['namespace_compatible'], [`at_least_${required}_distinct_keys`], [], 'CURRENT');
  const missing = [...uniqueFrom.keys()].filter(key => !uniqueTo.has(key)).sort((a, b) => a.localeCompare(b, 'en'));
  const overlapRatio = (uniqueFrom.size - missing.length) / uniqueFrom.size;
  if (missing.length && (policy.minimumOverlapRatio === undefined || overlapRatio < policy.minimumOverlapRatio)) return makeDecision(contract, matching, policy.policyVersion, 'ENGAÑOSA', ['observed_key_missing_from_referenced_sample'], ['namespace_compatible', 'minimum_distinct_sample_met'], [], ['sampled_source_key_absent_from_referenced_sample'], 'CURRENT');
  const baseMet = ['namespace_compatible', 'minimum_distinct_sample_met', 'all_observed_source_keys_present_in_referenced_sample'];
  const measured = globalMeasurements(contract, observations);
  // Measured global coverage can only tighten the sample verdict: a source key the whole target lacks is judged by the same rule as a sampled one.
  if (measured.coverage && measured.coverage.missing > 0) {
    const globalRatio = (measured.coverage.sourceDistinct - measured.coverage.missing) / measured.coverage.sourceDistinct;
    if (policy.minimumOverlapRatio === undefined || globalRatio < policy.minimumOverlapRatio) {
      return makeDecision(contract, matching, policy.policyVersion, 'ENGAÑOSA', ['global_source_keys_missing_from_target'], ['namespace_compatible', 'minimum_distinct_sample_met'], [], ['global_source_key_absent_from_target'], 'CURRENT',
        'whole-table coverage measured: some source keys have no match in the referenced table');
    }
  }
  if (measured.uniqueness && !measured.uniqueness.unique) {
    return makeDecision(contract, matching, policy.policyVersion, 'INDETERMINADA', ['global_target_keys_not_unique'], baseMet, ['unique_referenced_keys'], [], 'CURRENT', 'whole-table uniqueness measured: the referenced key repeats');
  }
  const coverageComplete = measured.coverage?.missing === 0, uniquenessMeasured = measured.uniqueness?.unique === true;
  const stillMissing = [...(coverageComplete ? [] : ['global_coverage_not_established']), ...(uniquenessMeasured ? [] : ['global_uniqueness_not_established'])];
  const reasons = ['bounded_sample_key_membership', ...(coverageComplete ? ['global_coverage_measured_complete'] : measured.coverage ? ['global_coverage_measured_partial'] : []), ...(uniquenessMeasured ? ['global_target_uniqueness_measured'] : []), ...(measured.malformed.length ? ['global_evidence_malformed_ignored'] : [])];
  const scope = coverageComplete && uniquenessMeasured ? 'whole-table coverage and target uniqueness measured by aggregate queries' : coverageComplete ? 'whole-table coverage measured; target uniqueness not established' : uniquenessMeasured ? 'whole-table target uniqueness measured; global coverage not established' : BOUNDED_SCOPE;
  return makeDecision(contract, matching, policy.policyVersion, 'SOSTENIDA', reasons, [...baseMet, ...(coverageComplete ? ['global_coverage_established'] : []), ...(uniquenessMeasured ? ['global_uniqueness_established'] : [])], stillMissing, [], 'CURRENT', scope);
}
