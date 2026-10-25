import { createHash } from 'node:crypto';
import type { Decision, EvidenceBundle, RelationContract } from '../contracts/types.ts';
import { validateDecision, validateEvidenceBundle, validateRelationContract } from '../contracts/validate.ts';
import { invalidateDependencies, type DependencyRef } from '../reconcile/freshness.ts';
import type { ConsumerFreshnessSnapshot } from '../reconcile/consumer-freshness.ts';
import { resolveUniverseManifest } from '../registry/universes.ts';

export type PublicationEligibility = 'publishable' | 'review_required' | 'blocked' | 'not_in_scope';
export type PublicationBasis = 'ObservedRelation' | 'DeclaredConstraint' | 'ValidatedConstraint';

export interface PublicationChange {
  operation: 'PROJECT_RELATION';
  relationRef: string;
  contractVersion: string;
  from: { sourceId: string; objectId: string; orderedColumns: string[] };
  to: { sourceId: string; objectId: string; orderedColumns: string[] };
  normalization: { operation: string; version: string }[];
  evidenceRefs: string[];
  decisionRef: string;
  scope: string;
}

export interface PublicationSqlPlan {
  rendererVersion: 'concordia-usl-view/1';
  dialectStatus: 'UNCONFIRMED_LOCAL_PREVIEW';
  statement: string | null;
  verificationQueries: string[];
  executable: false;
}

export interface PublicationManifest {
  schemaVersion: 1;
  manifestId: string;
  manifestVersion: '1.0';
  universeId: string;
  target: { namespace: string; model: string };
  contractRefs: { id: string; version: string }[];
  evidenceRefs: { id: string; contractVersion: string; observedAt: string; checkedAt: string[]; runId: string; executionMode: string; dataOrigin: string }[];
  decisionRefs: { id: string; contractVersion: string; policyVersion: string; evidenceBundleRefs: string[] }[];
  inputFingerprints: { contract: string; evidence: string; decision: string; renderer: string; target: string; targetState: 'UNKNOWN' | 'KNOWN'; targetStateFingerprint: string | null; dependency: string };
  previousManifestRef: { state: 'UNKNOWN' };
  recoveryStrategy: 'VERSIONED_ADDITIVE_REPOINT_OR_DISABLE';
  lifecycle: { state: 'PLANNED'; executionStatus: 'NOT_RUN'; applySupported: false };
  planConditions: { freshnessState: 'CURRENT_FOR_CHECK' | 'STALE' | 'UNKNOWN' | 'INCOMPLETE'; publicationBasis: PublicationBasis; targetStateObservedAt: string | null };
  dependencyAssessment?: PublicationDependencyAssessment;
  sqlPlan: PublicationSqlPlan;
  publicationBasis: PublicationBasis;
  eligibility: PublicationEligibility;
  reasons: string[];
  changes: PublicationChange[];
  executable: false;
  executionMode: string;
  dataOrigin: string;
  fingerprint: string;
}

export interface PublicationPlanInput {
  universeId: string;
  target: { namespace: string; model: string };
  contract: RelationContract;
  evidence: readonly EvidenceBundle[];
  decision: Decision;
  publicationBasis?: PublicationBasis;
  freshnessState?: 'CURRENT_FOR_CHECK' | 'STALE' | 'UNKNOWN' | 'INCOMPLETE';
  /** Hash and observation time of a read-only target state snapshot, when available. */
  targetState?: { fingerprint: string; observedAt: string };
  /** Optional B-to-D freshness graph. If present it must cover this plan's exact contract, evidence, and decision refs. */
  freshnessDependencies?: PublicationFreshnessDependencies;
  /** Persisted B5 consumer view, used to build exact publication dependencies offline. */
  freshnessSnapshot?: ConsumerFreshnessSnapshot;
}

export interface PublicationFreshnessDependencies {
  refs: readonly DependencyRef[];
  changedIds: readonly string[];
  publicationRefId: string;
}

export interface PublicationDependencyAssessment {
  publicationRefId: string;
  changedIds: string[];
  staleIds: string[];
  pendingIds: string[];
  state: 'CURRENT' | 'STALE' | 'PENDING';
  graphFingerprint: string;
}

const known = (value: { state: string; value?: unknown }): value is { state: 'KNOWN'; value: string } => value.state === 'KNOWN' && typeof value.value === 'string' && value.value.length > 0;
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en')));
});
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const sqlPath = (value: string): string | null => {
  const parts = value.split('.');
  return parts.length && parts.every(part => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) ? parts.join('.') : null;
};
const origin = (value: unknown): string => typeof value === 'string' ? value : value && typeof value === 'object' && 'label' in value ? String((value as { label: unknown }).label) : 'UNKNOWN';

/** Applies B's explicit invalidation graph to a publication output without executing the plan. */
export function assessPublicationDependencies(input: PublicationFreshnessDependencies, requiredIds: readonly string[]): PublicationDependencyAssessment {
  if (!input || !Array.isArray(input.refs) || !Array.isArray(input.changedIds) || typeof input.publicationRefId !== 'string' || !input.publicationRefId) throw new TypeError('PUBLICATION_DEPENDENCY_GRAPH_INVALID');
  const refs: readonly DependencyRef[] = input.refs;
  const requestedChangeIds: readonly string[] = input.changedIds;
  const byId = new Map<string, DependencyRef>();
  for (const ref of refs) {
    if (!ref || typeof ref.id !== 'string' || !ref.id || byId.has(ref.id) || !['claim', 'evidence', 'decision', 'output'].includes(ref.kind) || !Array.isArray(ref.dependsOn) || ref.dependsOn.some(id => typeof id !== 'string' || !id) || typeof ref.sourceVersion !== 'string' || !['CURRENT', 'STALE', 'PENDING'].includes(ref.state)) throw new TypeError('PUBLICATION_DEPENDENCY_GRAPH_INVALID');
    byId.set(ref.id, ref);
  }
  const publication = byId.get(input.publicationRefId);
  if (!publication || publication.kind !== 'output') throw new TypeError('PUBLICATION_DEPENDENCY_OUTPUT_REQUIRED');
  const changedIds = [...new Set(requestedChangeIds)].sort();
  if (changedIds.some(id => !byId.has(id))) throw new TypeError('PUBLICATION_DEPENDENCY_CHANGED_REF_UNKNOWN');
  for (const ref of refs) if (ref.dependsOn.some(id => !byId.has(id))) throw new TypeError('PUBLICATION_DEPENDENCY_REF_UNKNOWN');
  const reachable = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new TypeError('PUBLICATION_DEPENDENCY_CYCLE');
    if (reachable.has(id)) return;
    const ref = byId.get(id);
    if (!ref) throw new TypeError('PUBLICATION_DEPENDENCY_REF_UNKNOWN');
    visiting.add(id);
    for (const dependencyId of ref.dependsOn) visit(dependencyId);
    visiting.delete(id); reachable.add(id);
  };
  visit(publication.id);
  if (requiredIds.some(id => !reachable.has(id))) throw new TypeError('PUBLICATION_DEPENDENCY_INPUT_NOT_LINKED');
  const invalidated = invalidateDependencies(refs, changedIds);
  const stale = new Set(invalidated.filter(ref => ref.state === 'STALE').map(ref => ref.id));
  const pending = new Set(refs.filter(ref => ref.state === 'PENDING').map(ref => ref.id));
  let progress = true;
  while (progress) {
    progress = false;
    for (const ref of refs) {
      if (!stale.has(ref.id) && ref.dependsOn.some(id => stale.has(id))) { stale.add(ref.id); progress = true; }
      else if (!stale.has(ref.id) && !pending.has(ref.id) && ref.dependsOn.some(id => pending.has(id))) { pending.add(ref.id); progress = true; }
    }
  }
  const staleIds = [...stale].sort(), pendingIds = [...pending].filter(id => !stale.has(id)).sort();
  const state = stale.has(publication.id) ? 'STALE' as const : pending.has(publication.id) ? 'PENDING' as const : publication.state;
  const graphFingerprint = hash({ refs: [...refs].map(ref => ({ ...ref, dependsOn: [...ref.dependsOn].sort() })).sort((a, b) => a.id.localeCompare(b.id, 'en')), changedIds, publicationRefId: input.publicationRefId });
  return { publicationRefId: publication.id, changedIds, staleIds, pendingIds, state, graphFingerprint };
}

/** Links the saved freshness lineage to the exact contract, evidence, decision, and plan refs. */
export function publicationDependenciesFromSnapshot(snapshot: ConsumerFreshnessSnapshot, contract: RelationContract, evidence: readonly EvidenceBundle[], decision: Decision): PublicationFreshnessDependencies {
  const snapshotManifest=snapshot?.universeId?resolveUniverseManifest(snapshot.universeId):undefined,contractManifest=resolveUniverseManifest(contract.universeRef.universeId);
  const sameScope=snapshot?.universeId===contract.universeRef.universeId||Boolean(snapshotManifest&&contractManifest&&snapshotManifest.manifestId===contractManifest.manifestId);
  if (!snapshot || snapshot.schemaVersion !== 1 || !sameScope) throw new TypeError('PUBLICATION_FRESHNESS_SNAPSHOT_INVALID');
  const dependency = snapshot.dependencies.find(item => item.relationId === contract.id);
  const expectedEvidenceRefs=[...decision.evidenceBundleRefs].sort((a,b)=>a.localeCompare(b,'en')),actualEvidenceRefs=[...evidence.filter(bundle=>bundle.relationRef===contract.id&&decision.evidenceBundleRefs.includes(bundle.evidenceBundleId)).map(bundle=>bundle.evidenceBundleId)].sort((a,b)=>a.localeCompare(b,'en'));
  const inputMismatch=!dependency||dependency.contractVersion!==contract.contractVersion||dependency.decisionRef!==decision.decisionId||dependency.policyVersion!==decision.policyVersion||JSON.stringify(dependency.evidenceRefs)!==JSON.stringify(expectedEvidenceRefs)||JSON.stringify(actualEvidenceRefs)!==JSON.stringify(expectedEvidenceRefs);
  const canonicalUniverseId=snapshotManifest?.manifestId??snapshot.universeId;
  const sourceRef = `freshness:${hash([canonicalUniverseId, contract.id]).slice(0, 24)}`;
  const state: DependencyRef['state'] = dependency?.state === 'PENDING' || dependency?.state === 'UNKNOWN' ? 'PENDING' : dependency?.state === 'STALE' || inputMismatch ? 'STALE' : 'CURRENT';
  const refs: DependencyRef[] = [{ id: sourceRef, kind: 'evidence', dependsOn: [], sourceVersion: dependency?.semanticSourceVersion ?? 'UNKNOWN', state },
    { id: contract.id, kind: 'claim', dependsOn: [sourceRef], sourceVersion: contract.contractVersion, state: 'CURRENT' },
    ...evidence.map(bundle => ({ id: bundle.evidenceBundleId, kind: 'evidence' as const, dependsOn: [contract.id, sourceRef], sourceVersion: bundle.contractVersion, state: 'CURRENT' as const })),
    { id: decision.decisionId, kind: 'decision', dependsOn: [contract.id, ...evidence.map(bundle => bundle.evidenceBundleId)], sourceVersion: hash({ contractVersion: decision.contractVersion, policyVersion: decision.policyVersion, verdict: decision.verdict }), state: 'CURRENT' },
    { id: `publication:${contract.id}:${decision.decisionId}`, kind: 'output', dependsOn: [contract.id, decision.decisionId, ...evidence.map(bundle => bundle.evidenceBundleId)], sourceVersion: 'publication-plan-v1', state: 'CURRENT' }];
  return { refs, changedIds: state === 'STALE' ? [sourceRef] : [], publicationRefId: `publication:${contract.id}:${decision.decisionId}` };
}
/** Pure offline compiler. It emits a versioned SQL preview and traceable plan; it never executes SQL. */
export function compilePublicationPlan(input: PublicationPlanInput): PublicationManifest {
  const { contract, decision } = input;
  if (validateRelationContract(contract).length) throw new TypeError('INVALID_PUBLICATION_RELATION_CONTRACT');
  if (validateDecision(decision).length) throw new TypeError('INVALID_PUBLICATION_DECISION');
  if (!input.universeId || contract.universeRef.universeId !== input.universeId) throw new TypeError('PUBLICATION_UNIVERSE_MISMATCH');
  if (!input.target?.namespace || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(input.target.namespace) || !input.target?.model || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.target.model)) throw new TypeError('PUBLICATION_TARGET_INVALID');
  if (input.targetState && (!/^[a-f0-9]{64}$/i.test(input.targetState.fingerprint) || !Number.isFinite(Date.parse(input.targetState.observedAt)))) throw new TypeError('PUBLICATION_TARGET_STATE_INVALID');
  if (decision.relationRef !== contract.id || decision.contractVersion !== contract.contractVersion) throw new TypeError('PUBLICATION_DECISION_REF_MISMATCH');
  const related = input.evidence.filter(bundle => bundle.relationRef === contract.id && decision.evidenceBundleRefs.includes(bundle.evidenceBundleId));
  for (const bundle of related) if (validateEvidenceBundle(bundle).length) throw new TypeError('INVALID_PUBLICATION_EVIDENCE');
  const dependencies=input.freshnessDependencies??(input.freshnessSnapshot?publicationDependenciesFromSnapshot(input.freshnessSnapshot,contract,related,decision):undefined);
  const dependencyAssessment = dependencies
    ? assessPublicationDependencies(dependencies, [contract.id, decision.decisionId, ...related.map(bundle => bundle.evidenceBundleId)])
    : undefined;
  const basis = input.publicationBasis ?? 'ObservedRelation';
  const reasons = new Set<string>();
  let eligibility: PublicationEligibility = 'publishable';
  let blocked = false;
  const block = (reason: string) => { blocked = true; eligibility = 'blocked'; reasons.add(reason); };
  const review = (reason: string) => { if (!blocked) eligibility = 'review_required'; reasons.add(reason); };

  if (contract.reviewState !== 'REVIEWED') review('contract_review_required');
  if (!related.length || decision.evidenceBundleRefs.length === 0 || decision.evidenceBundleRefs.some(ref => !related.some(bundle => bundle.evidenceBundleId === ref)) || related.some(bundle => bundle.contractVersion !== contract.contractVersion)) block('matching_exact_version_evidence_required');
  if (related.some(bundle => bundle.completeness !== 'COMPLETE_FOR_SCOPE')) block('complete_evidence_required');
  const matchingRefs = related.filter(bundle => bundle.contractVersion === contract.contractVersion);
  const expectedProjection = new Map([[contract.from.sourceId, contract.from.orderedColumns], [contract.to.sourceId, contract.to.orderedColumns]]);
  const observedEndpoints = new Set(matchingRefs.flatMap(bundle => bundle.observations
    .filter(observation => observation.type === 'KEY_MEMBERSHIP' && observation.transportStatus === 'OK' && observation.truncated !== true)
    .filter(observation => bundle.sourceRefs.includes(observation.sourceRef) && JSON.stringify(observation.projection) === JSON.stringify(expectedProjection.get(observation.sourceRef)))
    .map(observation => observation.sourceRef)));
  if (![contract.from.sourceId, contract.to.sourceId].every(sourceId => observedEndpoints.has(sourceId))) block('successful_key_evidence_for_both_contract_endpoints_required');
  if (related.some(bundle => bundle.runRef.executionMode === 'UNKNOWN')) review('execution_mode_unknown');
  const dependencyFreshness = dependencyAssessment?.state === 'STALE' ? 'STALE' : dependencyAssessment?.state === 'PENDING' ? 'UNKNOWN' : undefined;
  const freshnessState: PublicationManifest['planConditions']['freshnessState'] = input.freshnessState === 'STALE' || dependencyFreshness === 'STALE' ? 'STALE'
    : input.freshnessState === 'INCOMPLETE' ? 'INCOMPLETE'
      : input.freshnessState === 'UNKNOWN' || dependencyFreshness === 'UNKNOWN' ? 'UNKNOWN'
        : input.freshnessState ?? 'UNKNOWN';
  if (dependencyAssessment?.state === 'STALE') reasons.add('publication_dependency_stale');
  if (dependencyAssessment?.state === 'PENDING') reasons.add('publication_dependency_pending');
  if (freshnessState === 'STALE' || freshnessState === 'INCOMPLETE') block('current_complete_evidence_freshness_required');
  else if (freshnessState !== 'CURRENT_FOR_CHECK') review('evidence_freshness_unproven');
  if (decision.verdict !== 'SOSTENIDA' || decision.status !== 'CURRENT') block('current_sustained_decision_required');
  const scopeOnlyRequirements = decision.requirementsMissing.length > 0 && decision.requirementsMissing.every(requirement => ['global_coverage_not_established', 'global_uniqueness_not_established'].includes(requirement));
  const unresolvedRequirements = decision.requirementsMissing.filter(requirement => !['global_coverage_not_established', 'global_uniqueness_not_established'].includes(requirement));
  const scopeOnlyReview = decision.requiresReview && decision.verdict === 'SOSTENIDA' && decision.status === 'CURRENT' && scopeOnlyRequirements;
  if ((decision.requiresReview && !scopeOnlyReview) || unresolvedRequirements.length > 0 || decision.contradictions.length > 0) review('decision_requires_review');
  if (contract.kind !== 'FOREIGN_KEY') reasons.add('relationship_kind_outside_current_sql_renderer_scope');
  if (basis !== 'ObservedRelation') review('constraint_publication_basis_not_implemented');
  if (!known(contract.from.namespace) || !known(contract.to.namespace) || contract.from.namespace.value !== contract.to.namespace.value) block('compatible_known_namespaces_required');
  if (contract.from.orderedColumns.length !== contract.to.orderedColumns.length || contract.normalization.length !== contract.from.orderedColumns.length) block('ordered_key_arity_mismatch');
  const normalizationIsExactTextV1 = contract.normalization.length === contract.from.orderedColumns.length && contract.normalization.every((component, index) => component.componentIndex === index && known(component.operation) && component.operation.value === 'text' && known(component.version) && component.version.value === '1' && known(component.adapterCapability) && component.adapterCapability.value === 'exact-text' && component.lossless.state === 'KNOWN' && component.lossless.value === true);
  if (!normalizationIsExactTextV1) block('normalization_not_supported_by_renderer');
  if (![contract.from.objectId, contract.to.objectId].every(value => sqlPath(value) !== null)) review('sql_endpoint_identifier_unsupported');
  if (![...contract.from.orderedColumns, ...contract.to.orderedColumns].every(value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) review('sql_key_identifier_unsupported');

  if (!matchingRefs.length) block('decision_must_reference_exact_contract_evidence');
  if (contract.kind !== 'FOREIGN_KEY' && !blocked) eligibility = 'not_in_scope';
  const evidenceRefs = related.map(bundle => ({ id: bundle.evidenceBundleId, contractVersion: bundle.contractVersion, observedAt: bundle.capturedAt, checkedAt: bundle.observations.map(observation => observation.checkedAt).sort(), runId: bundle.runRef.runId, executionMode: bundle.runRef.executionMode, dataOrigin: origin(bundle.runRef.dataOrigin) })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const modes = [...new Set(evidenceRefs.map(ref => ref.executionMode))].sort();
  const origins = [...new Set(evidenceRefs.map(ref => ref.dataOrigin))].sort();
  if (modes.length > 1) review('mixed_execution_modes');
  if (origins.length > 1) review('mixed_data_origins');

  const changes: PublicationChange[] = eligibility === 'publishable' ? [{
    operation: 'PROJECT_RELATION', relationRef: contract.id, contractVersion: contract.contractVersion,
    from: { sourceId: contract.from.sourceId, objectId: contract.from.objectId, orderedColumns: [...contract.from.orderedColumns] },
    to: { sourceId: contract.to.sourceId, objectId: contract.to.objectId, orderedColumns: [...contract.to.orderedColumns] },
    normalization: contract.normalization.map(component => ({ operation: (component.operation as { value: string }).value, version: (component.version as { value: string }).value })),
    evidenceRefs: matchingRefs.map(bundle => bundle.evidenceBundleId).sort(), decisionRef: decision.decisionId,
    scope: known(decision.scope) ? decision.scope.value : 'UNKNOWN'
  }] : [];
  if (eligibility === 'publishable') reasons.add('bounded_observed_relation_projection_only');

  const viewName = sqlPath(`${input.target.namespace}.${input.target.model}`);
  const fromObject = sqlPath(contract.from.objectId), toObject = sqlPath(contract.to.objectId);
  const sqlReady = eligibility === 'publishable' && normalizationIsExactTextV1 && Boolean(viewName && fromObject && toObject);
  const keyPairs = contract.from.orderedColumns.map((column, index) => ({ from: column, to: contract.to.orderedColumns[index] }));
  const viewColumns = keyPairs.flatMap((pair, index) => [`src.${pair.from} AS source_key_${index + 1}`, `tgt.${pair.to} AS target_key_${index + 1}`]);
  const join = keyPairs.map(pair => `src.${pair.from} = tgt.${pair.to}`).join(' AND ');
  const statement = sqlReady ? `CREATE VIEW ${viewName} AS SELECT ${viewColumns.join(', ')} FROM ${fromObject} AS src INNER JOIN ${toObject} AS tgt ON ${join}` : null;
  const verificationQueries = sqlReady ? [`SELECT * FROM ${viewName} LIMIT 10`] : [];
  const canonicalEvidence = related.map(bundle => ({ ...bundle, sourceRefs: [...bundle.sourceRefs].sort(), observations: [...bundle.observations].sort((a, b) => a.observationId.localeCompare(b.observationId, 'en')) })).sort((a, b) => a.evidenceBundleId.localeCompare(b.evidenceBundleId, 'en'));
  const inputFingerprints = { contract: hash(contract), evidence: hash(canonicalEvidence), decision: hash(decision), renderer: hash('concordia-usl-view/1'), target: hash(input.target), targetState: input.targetState ? 'KNOWN' as const : 'UNKNOWN' as const, targetStateFingerprint: input.targetState ? hash(input.targetState) : null, dependency: dependencyAssessment?.graphFingerprint ?? hash('no-publication-dependencies') };
  const body = {
    schemaVersion: 1 as const, manifestVersion: '1.0' as const, universeId: input.universeId,
    target: { namespace: input.target.namespace, model: input.target.model },
    contractRefs: [{ id: contract.id, version: contract.contractVersion }], evidenceRefs,
    decisionRefs: [{ id: decision.decisionId, contractVersion: decision.contractVersion, policyVersion: decision.policyVersion, evidenceBundleRefs: [...decision.evidenceBundleRefs].sort() }],
    inputFingerprints, previousManifestRef: { state: 'UNKNOWN' as const }, recoveryStrategy: 'VERSIONED_ADDITIVE_REPOINT_OR_DISABLE' as const,
    lifecycle: { state: 'PLANNED' as const, executionStatus: 'NOT_RUN' as const, applySupported: false as const },
    planConditions: { freshnessState, publicationBasis: basis, targetStateObservedAt: input.targetState?.observedAt ?? null },
    ...(dependencyAssessment ? { dependencyAssessment } : {}),
    sqlPlan: { rendererVersion: 'concordia-usl-view/1' as const, dialectStatus: 'UNCONFIRMED_LOCAL_PREVIEW' as const, statement, verificationQueries, executable: false as const },
    publicationBasis: basis, eligibility, reasons: [...reasons].sort(), changes,
    executable: false as const, executionMode: modes.length === 1 ? modes[0] : 'UNKNOWN', dataOrigin: origins.length === 1 ? origins[0] : 'UNKNOWN'
  };
  const fingerprint = hash(body);
  return { ...body, manifestId: `publication:${fingerprint.slice(0, 24)}`, fingerprint };
}
export type PublicationPlanInputKey = 'contract' | 'evidence' | 'decision' | 'target' | 'targetState' | 'renderer' | 'dependencyState' | 'planConditions' | 'manifest';
export interface PublicationPlanPreconditionCheck {
  status: 'CURRENT' | 'STALE';
  diagnostic: 'stale_plan' | null;
  staleInputs: PublicationPlanInputKey[];
}

/** Recompute and compare a saved plan immediately before any future apply integration. */
export function checkPublicationPlanPreconditions(manifest: PublicationManifest, current: PublicationPlanInput): PublicationPlanPreconditionCheck {
  const staleInputs = new Set<PublicationPlanInputKey>();
  // Older or malformed saved plans fail closed as stale instead of throwing.
  if (!manifest || typeof manifest !== 'object' || typeof manifest.manifestId !== 'string' ||
      typeof manifest.fingerprint !== 'string' || !manifest.inputFingerprints ||
      !manifest.planConditions || !manifest.lifecycle || !manifest.sqlPlan ||
      !manifest.contractRefs || !manifest.evidenceRefs || !manifest.decisionRefs) {
    return { status: 'STALE', diagnostic: 'stale_plan', staleInputs: ['manifest'] };
  }
  const { manifestId: _manifestId, fingerprint: suppliedFingerprint, ...manifestBody } = manifest;
  if (hash(manifestBody) !== suppliedFingerprint) staleInputs.add('manifest');
  let recalculated: PublicationManifest;
  try {
    recalculated = compilePublicationPlan(current);
  } catch {
    return { status: 'STALE', diagnostic: 'stale_plan', staleInputs: ['manifest'] };
  }
  for (const key of ['contract', 'evidence', 'decision', 'target', 'targetState', 'renderer'] as const) {
    if (manifest.inputFingerprints[key] !== recalculated.inputFingerprints[key]) staleInputs.add(key);
  }
  // A changed target digest at the same observation time is still stale.
  if (manifest.inputFingerprints.targetStateFingerprint !== recalculated.inputFingerprints.targetStateFingerprint) staleInputs.add('targetState');
  if (manifest.inputFingerprints.dependency !== recalculated.inputFingerprints.dependency || hash(manifest.dependencyAssessment ?? null) !== hash(recalculated.dependencyAssessment ?? null)) staleInputs.add('dependencyState');
  if (manifest.planConditions.freshnessState !== recalculated.planConditions.freshnessState || manifest.planConditions.publicationBasis !== recalculated.planConditions.publicationBasis) staleInputs.add('planConditions');
  if (manifest.planConditions.targetStateObservedAt !== recalculated.planConditions.targetStateObservedAt) staleInputs.add('targetState');
  if (manifest.fingerprint !== recalculated.fingerprint && staleInputs.size === 0) staleInputs.add('manifest');
  const ordered = [...staleInputs].sort();
  return { status: ordered.length ? 'STALE' : 'CURRENT', diagnostic: ordered.length ? 'stale_plan' : null, staleInputs: ordered };
}

export interface PublicationApplyGate {
  explicitAuthorization: boolean;
  dialectConfirmed: boolean;
}
export interface PublicationApplyPreconditionResult {
  status: 'STALE' | 'BLOCKED' | 'PLAN_ONLY';
  canApply: false;
  reasons: string[];
  staleInputs: PublicationPlanInputKey[];
}

/** This gate covers SQL execution only; offline structured apply uses its injected local/synthetic coordinator. */
export function assessPublicationApplyPreconditions(manifest: PublicationManifest, current: PublicationPlanInput, gate: PublicationApplyGate): PublicationApplyPreconditionResult {
  const check = checkPublicationPlanPreconditions(manifest, current);
  const reasons = new Set<string>();
  if (check.status === 'STALE') reasons.add('stale_plan');
  if (!manifest || typeof manifest !== 'object' || !manifest.lifecycle || !manifest.sqlPlan || !manifest.inputFingerprints) {
    reasons.add('malformed_or_unsupported_manifest');
    reasons.add('live_sql_apply_not_supported');
    return { status: 'STALE', canApply: false, reasons: [...reasons].sort(), staleInputs: check.staleInputs };
  }
  if (manifest.eligibility !== 'publishable') reasons.add('publication_not_eligible');
  if (!current.targetState) reasons.add('target_state_preflight_required');
  if (!gate.explicitAuthorization) reasons.add('explicit_apply_authorization_required');
  if (!gate.dialectConfirmed) reasons.add('sql_dialect_confirmation_required');
  if (manifest.executable || manifest.sqlPlan.executable || manifest.lifecycle.applySupported) reasons.add('unexpected_executable_plan');
  // The executor and recovery protocol are deliberately absent in this offline slice.
  reasons.add('live_sql_apply_not_supported');
  const status = check.status === 'STALE' ? 'STALE' : reasons.size ? 'BLOCKED' : 'PLAN_ONLY';
  return { status, canApply: false, reasons: [...reasons].sort(), staleInputs: check.staleInputs };
}