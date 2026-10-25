import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../src/runtime.ts';
import type { Decision, EvidenceBundle, RelationContract } from '../src/contracts/types.ts';
import { assessPublicationApplyPreconditions, checkPublicationPlanPreconditions, compilePublicationPlan, type PublicationManifest } from '../src/usl/publication-plan.ts';
import { evaluateRelation } from '../src/relations/decision.ts';

function fixture() {
  const known = <T extends string | boolean>(value: T) => ({ state: 'KNOWN' as const, value });
  const contract: RelationContract = {
    schemaVersion: 1, id: 'fk-synthetic', contractVersion: '1.0',
    universeRef: { universeId: 'U1', universeVersion: { state: 'UNKNOWN' }, namespace: known('synthetic-catalog'), configFingerprint: { state: 'UNKNOWN' } },
    kind: 'FOREIGN_KEY',
    from: { sourceId: 'source-child', namespace: known('synthetic-catalog'), objectId: 'child', orderedColumns: ['key_a', 'key_b'] },
    to: { sourceId: 'source-parent', namespace: known('synthetic-catalog'), objectId: 'parent', orderedColumns: ['key_x', 'key_y'] },
    identifierSpace: known('synthetic-id-space'),
    normalization: [0, 1].map(componentIndex => ({ componentIndex, operation: known('text'), version: known('1'), lossless: known(true), adapterCapability: known('exact-text') })),
    semanticContext: { grain: { state: 'UNKNOWN' }, unit: { state: 'UNKNOWN' }, scale: { state: 'UNKNOWN' }, period: { state: 'UNKNOWN' }, timezone: { state: 'UNKNOWN' } },
    assertions: [], evidencePolicy: { requiredObservationTypes: ['KEY_MEMBERSHIP'], minimumCompleteness: 'COMPLETE_FOR_SCOPE', nulls: 'UNKNOWN', cardinality: 'UNKNOWN', declarationsAdmissible: 'UNKNOWN', minimumDistinctKeys: 2 }, reviewState: 'REVIEWED'
  };
  const observation = (id: string, sourceRef: string): EvidenceBundle['observations'][number] => ({
    observationId: id, type: 'KEY_MEMBERSHIP', sourceRef, adapterId: 'local-fixture', requestId: known(id), observedAt: known('2026-01-01T00:00:00Z'), checkedAt: '2026-01-01T00:01:00Z',
    nativeVersion: { state: 'UNKNOWN' }, fingerprint: { state: 'UNKNOWN' }, projection: sourceRef === 'source-child' ? ['key_a', 'key_b'] : ['key_x', 'key_y'], filters: [], limit: 10, measuredTuples: [['01', 'a'], ['1', 'b']], nullCount: 0,
    duplicateCount: 'UNKNOWN', truncated: false, transportStatus: 'OK', protectedPayloadRef: { state: 'UNKNOWN' }
  });
  const evidence: EvidenceBundle = { schemaVersion: 1, evidenceBundleId: 'evidence-synthetic', relationRef: contract.id, contractVersion: contract.contractVersion, sourceRefs: ['source-child', 'source-parent'],
    runRef: { runId: 'local-run-1', startedAt: known('2026-01-01T00:00:00Z'), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', configFingerprint: { state: 'UNKNOWN' } },
    observations: [observation('obs-child', 'source-child'), observation('obs-parent', 'source-parent')], scope: known('bounded fixture sample'), completeness: 'COMPLETE_FOR_SCOPE', capturedAt: '2026-01-01T00:01:00Z' };
  const decision: Decision = { schemaVersion: 1, decisionId: 'decision-synthetic', relationRef: contract.id, contractVersion: contract.contractVersion, verdict: 'SOSTENIDA', reasonCodes: ['bounded_sample_key_membership'],
    requirementsMet: ['compatible_namespaces'], requirementsMissing: ['global_coverage_not_established', 'global_uniqueness_not_established'], contradictions: [], scope: known('bounded sample only'), evidenceBundleRefs: [evidence.evidenceBundleId],
    policyVersion: '1.0', evaluatedAt: known('2026-01-01T00:02:00Z'), requiresReview: false, status: 'CURRENT' };
  return { contract, evidence, decision, target: { namespace: 'local.catalog', model: 'concordia_usl' } };
}

test('D publication plan is deterministic, traceable and emits no executable DDL', () => {
  const f = fixture();
  const plan = compilePublicationPlan({ ...f, universeId: 'U1', evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' });
  const again = compilePublicationPlan({ ...f, universeId: 'U1', evidence: [{ ...f.evidence, observations: [...f.evidence.observations].reverse() }], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(plan.fingerprint, again.fingerprint);
  assert.equal(plan.sqlPlan.statement, again.sqlPlan.statement);
  assert.notEqual(plan.inputFingerprints.contract, '');
  assert.notEqual(plan.inputFingerprints.evidence, '');
  const changedEvidence = { ...f.evidence, observations: f.evidence.observations.map((observation, index) => index ? observation : { ...observation, measuredTuples: [['different'], ['1']] }) };
  const changedPlan = compilePublicationPlan({ ...f, universeId: 'U1', evidence: [changedEvidence], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.notEqual(plan.inputFingerprints.evidence, changedPlan.inputFingerprints.evidence);
  assert.notEqual(plan.fingerprint, compilePublicationPlan({ ...f, universeId: 'U1', target: { ...f.target, model: 'other_model' }, evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' }).fingerprint);
  assert.equal(plan.eligibility, 'publishable');
  assert.equal(plan.publicationBasis, 'ObservedRelation');
  assert.equal(plan.executable, false);
  assert.deepEqual(plan.changes[0].from.orderedColumns, ['key_a', 'key_b']);
  assert.deepEqual(plan.changes[0].to.orderedColumns, ['key_x', 'key_y']);
  assert.deepEqual(plan.changes[0].evidenceRefs, ['evidence-synthetic']);
  assert.equal(plan.executionMode, 'LOCAL'); assert.equal(plan.dataOrigin, 'SYNTHETIC');
  assert.equal(plan.sqlPlan.executable, false);
  assert.equal(plan.sqlPlan.dialectStatus, 'UNCONFIRMED_LOCAL_PREVIEW');
  assert.equal(plan.sqlPlan.statement, 'CREATE VIEW local.catalog.concordia_usl AS SELECT src.key_a AS source_key_1, tgt.key_x AS target_key_1, src.key_b AS source_key_2, tgt.key_y AS target_key_2 FROM child AS src INNER JOIN parent AS tgt ON src.key_a = tgt.key_x AND src.key_b = tgt.key_y');
  assert.doesNotMatch(plan.sqlPlan.statement ?? '', /CAST|TRIM|COALESCE/);
  assert.ok(!/\b(?:PRIMARY KEY|FOREIGN KEY|ACTIVATE|DROP)\b/i.test(plan.sqlPlan.statement ?? ''));
  assert.deepEqual(plan.decisionRefs[0].evidenceBundleRefs, ['evidence-synthetic']);
  assert.equal(plan.previousManifestRef.state, 'UNKNOWN');
  assert.equal(plan.inputFingerprints.targetState, 'UNKNOWN');
  assert.ok(plan.sqlPlan.verificationQueries[0].endsWith('LIMIT 10'));
});

test('D compilation refuses to infer constraints or freshness from bounded evidence', () => {
  const f = fixture();
  const unknownFreshness = compilePublicationPlan({ ...f, universeId: 'U1', evidence: [f.evidence] });
  assert.equal(unknownFreshness.eligibility, 'review_required');
  assert.deepEqual(unknownFreshness.changes, []);
  const constraintBasis = compilePublicationPlan({ ...f, universeId: 'U1', evidence: [f.evidence], publicationBasis: 'ValidatedConstraint', freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(constraintBasis.eligibility, 'review_required');
  assert.ok(constraintBasis.reasons.includes('constraint_publication_basis_not_implemented'));
  assert.deepEqual(constraintBasis.changes, []);
  const declaredBasis = compilePublicationPlan({ ...f, universeId: 'U1', evidence: [f.evidence], publicationBasis: 'DeclaredConstraint', freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(declaredBasis.eligibility, 'review_required');
  assert.ok(declaredBasis.reasons.includes('constraint_publication_basis_not_implemented'));
  assert.equal(declaredBasis.sqlPlan.statement, null);
});

test('D compiler blocks stale, incomplete, mismatched or contradictory inputs', () => {
  const f = fixture();
  const stale = compilePublicationPlan({ ...f, universeId: 'U1', evidence: [f.evidence], freshnessState: 'STALE' });
  assert.equal(stale.eligibility, 'blocked');
  const partial = compilePublicationPlan({ ...f, universeId: 'U1', evidence: [{ ...f.evidence, completeness: 'PARTIAL' }], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.ok(partial.reasons.includes('complete_evidence_required'));
  const newContract = { ...f.contract, contractVersion: '2.0' };
  const mismatch = compilePublicationPlan({ ...f, universeId: 'U1', contract: newContract, decision: { ...f.decision, contractVersion: '2.0' }, evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.ok(mismatch.reasons.includes('matching_exact_version_evidence_required'));
  const contradicted = compilePublicationPlan({ ...f, universeId: 'U1', decision: { ...f.decision, verdict: 'ENGAÑOSA' }, evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.ok(contradicted.reasons.includes('current_sustained_decision_required'));
});

test('D publication requires successful endpoint observations behind exact evidence refs', () => {
  const f = fixture();
  const oneSided = { ...f.evidence, observations: [f.evidence.observations[0]] };
  const plan = compilePublicationPlan({ ...f, universeId: 'U1', evidence: [oneSided], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(plan.eligibility, 'blocked');
  assert.ok(plan.reasons.includes('successful_key_evidence_for_both_contract_endpoints_required'));
  assert.deepEqual(plan.changes, []);
});

test('D SQL renderer abstains on unsafe contract identifiers', () => {
  const f = fixture();
  const unsafe = { ...f.contract, from: { ...f.contract.from, orderedColumns: ['key_a; DROP TABLE x', 'key_b'] } };
  const unsafeEvidence = { ...f.evidence, observations: f.evidence.observations.map((observation, index) => index ? observation : { ...observation, projection: ['key_a; DROP TABLE x', 'key_b'] }) };
  const plan = compilePublicationPlan({ ...f, universeId: 'U1', contract: unsafe, decision: { ...f.decision, evidenceBundleRefs: [f.evidence.evidenceBundleId] }, evidence: [unsafeEvidence], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(plan.eligibility, 'review_required');
  assert.ok(plan.reasons.includes('sql_key_identifier_unsupported'));
  assert.equal(plan.sqlPlan.statement, null);
});

test('D rejects stale contract, evidence, target and target-state preconditions before apply', () => {
  const f = fixture();
  const input = { ...f, universeId: 'U1', evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' as const, targetState: { fingerprint: 'a'.repeat(64), observedAt: '2026-01-01T00:03:00Z' } };
  const plan = compilePublicationPlan(input);
  assert.deepEqual(checkPublicationPlanPreconditions(plan, input), { status: 'CURRENT', diagnostic: null, staleInputs: [] });
  const changedContract = { ...f.contract, identifierSpace: { state: 'KNOWN' as const, value: 'different-id-space' } };
  const changedEvidence = { ...f.evidence, capturedAt: '2026-01-01T00:04:00Z' };
  const changedTarget = { namespace: f.target.namespace, model: 'different_model' };
  const changedTargetState = { fingerprint: 'b'.repeat(64), observedAt: input.targetState.observedAt };
  assert.deepEqual(checkPublicationPlanPreconditions(plan, { ...input, contract: changedContract }).staleInputs, ['contract']);
  assert.deepEqual(checkPublicationPlanPreconditions(plan, { ...input, evidence: [changedEvidence] }).staleInputs, ['evidence']);
  assert.deepEqual(checkPublicationPlanPreconditions(plan, { ...input, target: changedTarget }).staleInputs, ['target']);
  assert.deepEqual(checkPublicationPlanPreconditions(plan, { ...input, targetState: changedTargetState }).staleInputs, ['targetState']);
  const malformed = checkPublicationPlanPreconditions({ schemaVersion: 1 } as unknown as PublicationManifest, input);
  assert.equal(malformed.status, 'STALE');
  assert.equal(malformed.diagnostic, 'stale_plan');
  assert.deepEqual(malformed.staleInputs, ['manifest']);
  const rendererDrift = { ...plan, inputFingerprints: { ...plan.inputFingerprints, renderer: 'changed' } };
  assert.ok(checkPublicationPlanPreconditions(rendererDrift, input).staleInputs.includes('renderer'));
  const gate = assessPublicationApplyPreconditions(plan, input, { explicitAuthorization: true, dialectConfirmed: true });
  assert.equal(gate.canApply, false);
  assert.equal(gate.status, 'BLOCKED');
  assert.ok(gate.reasons.includes('live_sql_apply_not_supported'));
});


test('D CLI plan and check are deterministic, path-bounded and reject stale contract/evidence/target', () => {
  const directory = path.join(ROOT, '.concordia', 'publication-plans');
  fs.mkdirSync(directory, { recursive: true });
  const slug = `route-${randomUUID().replaceAll('-', '')}`;
  const inputPath = `.concordia/publication-plans/${slug}.input.json`;
  let planPath = '';
  const absoluteInput = path.join(ROOT, inputPath);
  let absolutePlan = '';
  const preload = path.join(directory, `${slug}.guard.mjs`);
  const missingEnv = path.join(directory, `${slug}.missing.env`);
  assert.equal(fs.existsSync(absoluteInput), false);

  assert.equal(fs.existsSync(preload), false);
  fs.writeFileSync(preload, `import http from 'node:http'; import https from 'node:https'; globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); }; for (const client of [http, https]) for (const method of ['request', 'get']) client[method] = () => { throw new Error('NETWORK_FORBIDDEN'); };\n`);
  const base = fixture();
  const inputBase = { ...base, universeId: 'U1', evidence: [base.evidence], freshnessState: 'CURRENT_FOR_CHECK', targetState: { fingerprint: 'a'.repeat(64), observedAt: '2026-01-01T00:03:00Z' } };
  const runCli = (args: string[]) => spawnSync(process.execPath, [
    '--import', pathToFileURL(preload).href,
    path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/cli.ts'),
    'publication', ...args
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CONCORDIA_LOCAL_ENV_FILE: missingEnv } });
  try {
    fs.writeFileSync(absoluteInput, JSON.stringify(inputBase));
    const first = runCli(['plan', '--input', inputPath]);
    assert.equal(first.status, 0, first.stderr);
    const firstOutput = JSON.parse(first.stdout);
    assert.equal(firstOutput.status, 'PLANNED');
    assert.equal(firstOutput.executable, false);
    planPath = firstOutput.outputPath;
    absolutePlan = path.join(ROOT, planPath);
    const firstManifest = JSON.parse(fs.readFileSync(absolutePlan, 'utf8'));
    const again = runCli(['plan', '--input', inputPath]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).fingerprint, firstOutput.fingerprint);
    const unchanged = runCli(['check', '--input', inputPath, '--plan', planPath]);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(JSON.parse(unchanged.stdout).status, 'CURRENT');
    assert.equal(JSON.parse(unchanged.stdout).canApply, false);

    const changedInputs = [
      { expected: 'contract', input: { ...inputBase, contract: { ...inputBase.contract, identifierSpace: { state: 'KNOWN', value: 'changed-id-space' } } } },
      { expected: 'evidence', input: { ...inputBase, evidence: [{ ...inputBase.evidence[0], capturedAt: '2026-01-01T00:04:00Z' }] } },
      { expected: 'target', input: { ...inputBase, target: { ...inputBase.target, model: 'changed_target' } } },
      { expected: 'targetState', input: { ...inputBase, targetState: { fingerprint: 'c'.repeat(64), observedAt: inputBase.targetState.observedAt } } }
    ];
    for (const item of changedInputs) {
      fs.writeFileSync(absoluteInput, JSON.stringify(item.input));
      const stale = runCli(['check', '--input', inputPath, '--plan', planPath]);
      assert.equal(stale.status, 1, stale.stderr);
      const result = JSON.parse(stale.stdout);
      assert.equal(result.status, 'STALE');
      assert.equal(result.diagnostic, 'stale_plan');
      assert.deepEqual(result.staleInputs, [item.expected]);
      fs.writeFileSync(absoluteInput, JSON.stringify(inputBase));
    }

    const unsafePath = runCli(['plan', '--input', '.concordia/publication-plans/../outside.input.json']);
    assert.equal(unsafePath.status, 1);
    assert.match(unsafePath.stderr, /INVALID_PUBLICATION_PLAN_PATH/);
    assert.equal(firstManifest.lifecycle.applySupported, false);
    fs.writeFileSync(absolutePlan, JSON.stringify({ schemaVersion: 1 }));
    const malformedCheck = runCli(['check', '--input', inputPath, '--plan', planPath]);
    assert.equal(malformedCheck.status, 1);
    const malformedResult = JSON.parse(malformedCheck.stdout);
    assert.equal(malformedResult.diagnostic, 'stale_plan');
    assert.equal(malformedResult.canApply, false);
    fs.writeFileSync(absolutePlan, JSON.stringify(null));
    const nullCheck = runCli(['check', '--input', inputPath, '--plan', planPath]);
    assert.equal(nullCheck.status, 1);
    assert.equal(JSON.parse(nullCheck.stdout).diagnostic, 'stale_plan');
  } finally {
    for (const file of [absoluteInput, absolutePlan, preload]) if (fs.existsSync(file)) fs.rmSync(file);
  }
});
test('L3 B freshness invalidation reaches and blocks the dependent D publication plan', () => {
  const f = fixture();
  const publicationRefId = 'publication:local.catalog.concordia_usl';
  const refs = [
    { id: f.contract.id, kind: 'claim' as const, dependsOn: [], sourceVersion: f.contract.contractVersion, state: 'CURRENT' as const },
    { id: f.evidence.evidenceBundleId, kind: 'evidence' as const, dependsOn: [], sourceVersion: f.evidence.contractVersion, state: 'CURRENT' as const },
    { id: f.decision.decisionId, kind: 'decision' as const, dependsOn: [f.evidence.evidenceBundleId], sourceVersion: f.decision.policyVersion, state: 'CURRENT' as const },
    { id: publicationRefId, kind: 'output' as const, dependsOn: [f.contract.id, f.evidence.evidenceBundleId, f.decision.decisionId], sourceVersion: 'plan-v1', state: 'CURRENT' as const },
    { id: 'unrelated-output', kind: 'output' as const, dependsOn: [], sourceVersion: 'other-v1', state: 'CURRENT' as const }
  ];
  const input = { ...f, universeId: 'U1', evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' as const,
    freshnessDependencies: { refs, changedIds: [], publicationRefId } };
  const current = compilePublicationPlan(input);
  const changedInput = { ...input, freshnessDependencies: { ...input.freshnessDependencies, changedIds: [f.evidence.evidenceBundleId] } };
  const stale = compilePublicationPlan(changedInput);
  assert.equal(stale.dependencyAssessment?.state, 'STALE');
  assert.deepEqual(stale.dependencyAssessment?.staleIds, [f.decision.decisionId, publicationRefId]);
  assert.equal(stale.planConditions.freshnessState, 'STALE');
  assert.equal(stale.eligibility, 'blocked');
  assert.ok(stale.reasons.includes('publication_dependency_stale'));
  assert.equal(checkPublicationPlanPreconditions(current, changedInput).staleInputs.includes('dependencyState'), true);
  assert.equal(stale.executable, false);
  assert.equal(stale.sqlPlan.statement, null);
  const pendingRefs = refs.map(ref => ref.id === f.decision.decisionId ? { ...ref, state: 'PENDING' as const } : ref);
  const pending = compilePublicationPlan({ ...input, freshnessDependencies: { ...input.freshnessDependencies, refs: pendingRefs } });
  assert.equal(pending.dependencyAssessment?.state, 'PENDING');
  assert.deepEqual(pending.dependencyAssessment?.pendingIds, [f.decision.decisionId, publicationRefId]);
  assert.equal(pending.planConditions.freshnessState, 'UNKNOWN');
  assert.equal(pending.eligibility, 'review_required');
  assert.ok(pending.reasons.includes('publication_dependency_pending'));
});

test('D renderer supports only declared exact-text v1 normalization and blocks numeric coercion', () => {
  const f = fixture();
  const integerContract = { ...f.contract, normalization: f.contract.normalization.map(component => ({ ...component, operation: { state: 'KNOWN' as const, value: 'integer-pad10' } })) };
  const plan = compilePublicationPlan({ ...f, universeId: 'U1', contract: integerContract, evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(plan.eligibility, 'blocked');
  assert.ok(plan.reasons.includes('normalization_not_supported_by_renderer'));
  assert.equal(plan.sqlPlan.statement, null);
});
test('D explicitly marks relation kinds outside the current renderer as not in scope', () => {
  const f = fixture();
  const contract = { ...f.contract, kind: 'SCHEMA_CORRESPONDENCE' as const };
  const plan = compilePublicationPlan({ ...f, universeId: 'U1', contract, decision: { ...f.decision }, evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(plan.eligibility, 'not_in_scope');
  assert.equal(plan.sqlPlan.statement, null);
  assert.deepEqual(plan.changes, []);
});

test('D publication rejects endpoint evidence with a projection that differs from ordered contract keys', () => {
  const f = fixture();
  const wrongProjection = { ...f.evidence, observations: f.evidence.observations.map((observation, index) => index ? observation : { ...observation, projection: ['key_b', 'key_a'] }) };
  const plan = compilePublicationPlan({ ...f, universeId: 'U1', evidence: [wrongProjection], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(plan.eligibility, 'blocked');
  assert.ok(plan.reasons.includes('successful_key_evidence_for_both_contract_endpoints_required'));
});

test('D allows an observed informational view for a current sustained evaluator decision with only global scope limits', () => {
  const f = fixture();
  const decision = evaluateRelation(f.contract, [f.evidence], { policyVersion: '1.0', minimumDistinctKeys: 2, minimumOverlapRatio: 1 });
  assert.equal(decision.verdict, 'SOSTENIDA');
  assert.equal(decision.status, 'CURRENT');
  assert.equal(decision.requiresReview, true);
  assert.deepEqual(decision.requirementsMissing, ['global_coverage_not_established', 'global_uniqueness_not_established']);
  const plan = compilePublicationPlan({ ...f, universeId: 'U1', decision, evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(plan.eligibility, 'publishable');
  assert.ok(plan.sqlPlan.statement);
  assert.equal(plan.executable, false);
  assert.deepEqual(plan.changes[0].evidenceRefs, decision.evidenceBundleRefs);
  const unresolved = { ...decision, requirementsMissing: [...decision.requirementsMissing, 'manual_validation_required'] };
  const reviewPlan = compilePublicationPlan({ ...f, universeId: 'U1', decision: unresolved, evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(reviewPlan.eligibility, 'review_required');
  assert.equal(reviewPlan.sqlPlan.statement, null);
  const contradicted = { ...decision, contradictions: ['conflicting_current_claim'] };
  const contradictionPlan = compilePublicationPlan({ ...f, universeId: 'U1', decision: contradicted, evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' });
  assert.equal(contradictionPlan.eligibility, 'review_required');
  assert.equal(contradictionPlan.sqlPlan.statement, null);
});
import { executeOfflinePublication, type OfflinePublicationAdapter, type OfflinePublicationSnapshot, type PublicationJournalEvent } from '../src/usl/publication-executor.ts';

function offlineExecutorFixture() {
  const f = fixture();
  const input = { ...f, universeId: 'U1', evidence: [f.evidence], freshnessState: 'CURRENT_FOR_CHECK' as const, targetState: { fingerprint: 'a'.repeat(64), observedAt: '2026-01-01T00:03:00Z' } };
  const manifest = compilePublicationPlan(input);
  const target: OfflinePublicationSnapshot = { targetStateFingerprint: input.targetState!.fingerprint, observedAt: '2026-01-01T00:03:00Z', activeVersionId: 'base-v1', activeContentFingerprint: 'b'.repeat(64), versions: [{ versionId: 'base-v1', planFingerprint: 'c'.repeat(64), contentFingerprint: 'b'.repeat(64) }], appliedTokens: [] };
  const events: PublicationJournalEvent[] = [];
  const journal = { withExclusiveLock: async <T>(work: (locked: any) => Promise<T>) => work({ readEvents: () => [...events], append: (event: PublicationJournalEvent) => events.push(event) }) };
  return { input, manifest, target, events, journal };
}
function fakeOfflineAdapter(target: OfflinePublicationSnapshot, input: any, options: { throwAfterApply?: boolean; conflictRecovery?: boolean; misreportRecovery?: boolean } = {}) {
  let state = structuredClone(target), applyCount = 0, recoveryCount = 0;
  const adapter: OfflinePublicationAdapter = {
    adapterId: 'fake-local', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC',
    async readLatest() { return { input: { ...input, targetState: { fingerprint: state.targetStateFingerprint, observedAt: state.observedAt } }, target: structuredClone(state) }; },
    async applyAdditive(request) {
      applyCount++;
      state = { ...state, targetStateFingerprint: 'b'.repeat(64), activeVersionId: request.versionId, activeContentFingerprint: request.expectedContentFingerprint,
        versions: [...state.versions, { versionId: request.versionId, planFingerprint: request.token, contentFingerprint: request.expectedContentFingerprint }],
        appliedTokens: [...state.appliedTokens, { token: request.token, versionId: request.versionId, contentFingerprint: request.expectedContentFingerprint }] };
      if (options.throwAfterApply) throw new Error('simulated interrupted response');
      return { status: 'APPLIED', versionId: request.versionId, contentFingerprint: request.expectedContentFingerprint };
    },
    async recoverPartial(request) {
      recoveryCount++;
      if (options.conflictRecovery) {
        state = { ...state, targetStateFingerprint: 'c'.repeat(64), activeVersionId: 'third-party-version' };
        return { status: 'CONFLICT', reason: 'target changed after recovery read' };
      }
      assert.equal(request.expectedActiveVersionId, request.partialVersionId);
      state = { ...state, targetStateFingerprint: 'd'.repeat(64), activeVersionId: request.previousVersionId, activeContentFingerprint: request.previousVersionId ? state.versions.find(item => item.versionId === request.previousVersionId)?.contentFingerprint ?? null : null, versions: options.misreportRecovery ? state.versions : state.versions.map(item => item.versionId === request.partialVersionId ? { ...item, enabled: false } : item) };
      return { status: 'DISABLED' };
    }
  };
  return { adapter, get applyCount() { return applyCount; }, get recoveryCount() { return recoveryCount; }, get state() { return state; } };
}

test('D offline executor verifies additive fake publication and rechecks current content on replay', async () => {
  const f = offlineExecutorFixture(), fake = fakeOfflineAdapter(f.target, f.input);
  const first = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, 'offline-run-1');
  assert.deepEqual({ status: first.status, passed: first.passed }, { status: 'VERIFIED', passed: true });
  assert.deepEqual(f.events.map(event => event.state), ['planned', 'prepared', 'applied', 'verified']);
  const replay = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, 'offline-run-2');
  assert.equal(replay.status, 'VERIFIED');
  assert.equal(fake.applyCount, 1);
  fake.state.activeContentFingerprint = 'f'.repeat(64);
  fake.state.targetStateFingerprint = 'e'.repeat(64);
  const changed = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, 'offline-run-3');
  assert.equal(changed.passed, false);
  assert.equal(changed.reason, 'TARGET_ACTIVE_VERSION_MISMATCH');
  assert.equal(fake.applyCount, 1);
});

test('D offline executor rejects stale source or target preflight without adapter mutation', async () => {
  const f = offlineExecutorFixture(), fake = fakeOfflineAdapter(f.target, { ...f.input, target: { ...f.input.target, model: 'other_model' } });
  const result = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, 'offline-stale');
  assert.equal(result.status, 'REJECTED');
  assert.equal(fake.applyCount, 0);
  assert.equal(f.events.length, 0);
});

test('D offline executor records prepared state and recovers token-owned interrupted apply as non-pass', async () => {
  const f = offlineExecutorFixture(), fake = fakeOfflineAdapter(f.target, f.input, { throwAfterApply: true });
  const result = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, 'offline-crash');
  assert.equal(result.status, 'RECOVERED');
  assert.equal(result.passed, false);
  assert.equal(fake.applyCount, 1);
  assert.equal(fake.recoveryCount, 1);
  assert.deepEqual(f.events.map(event => event.state), ['planned', 'prepared', 'recovered']);
  assert.ok(f.events[1].baselineVersionsFingerprint);
});

test('D offline executor never reports pass when recovery CAS detects a target race', async () => {
  const f = offlineExecutorFixture(), fake = fakeOfflineAdapter(f.target, f.input, { throwAfterApply: true, conflictRecovery: true });
  const result = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, 'offline-race');
  assert.equal(result.status, 'FAILED');
  assert.equal(result.passed, false);
  assert.equal(fake.recoveryCount, 1);
  assert.equal(f.events.at(-1)?.state, 'failed');
});


import { FilePublicationJournal } from '../src/usl/publication-executor.ts';

test('D append-only journal rejects a second writer and validates event sequence', async () => {
  const directory = path.join(ROOT, '.concordia', 'publication-runs', `journal-${randomUUID().replaceAll('-', '')}`);
  const journalPath = path.join(directory, 'journal.jsonl');
  const store = new FilePublicationJournal(journalPath, ROOT);
  let announceEntered!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { announceEntered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = store.withExclusiveLock(async locked => { announceEntered(); await gate; assert.deepEqual(locked.readEvents(), []); });
  await entered;
  await assert.rejects(store.withExclusiveLock(async () => undefined), /PUBLICATION_JOURNAL_WRITER_EXISTS/);
  release();
  await first;
  const fingerprint = 'a'.repeat(64);
  const event: PublicationJournalEvent = { schemaVersion: 1, eventId: `${fingerprint}:1:planned`, sequence: 1, runId: 'run-1', state: 'planned', manifestId: 'publication:aaaaaaaaaaaaaaaaaaaaaaaa', fingerprint, idempotencyToken: fingerprint, universeId: 'U1', targetKey: 'local.catalog.model', adapterId: 'fake-local', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', at: '2026-01-01T00:00:00.000Z' };
  await store.withExclusiveLock(async locked => {
    locked.append(event);
    assert.deepEqual(locked.readEvents(), [event]);
    assert.throws(() => locked.append(event), /PUBLICATION_JOURNAL_SEQUENCE_INVALID/);
  });
  assert.equal(fs.existsSync(`${journalPath}.lock`), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('D append-only journal rejects journal paths outside project-owned publication runs', () => {
  assert.throws(() => new FilePublicationJournal(path.join(ROOT, '.concordia', 'outside', 'journal.jsonl'), ROOT), /PUBLICATION_JOURNAL_PATH_OUTSIDE_PROJECT_RUNS/);
});


test('D offline executor verifies compensation state instead of trusting an adapter recovery label', async () => {
  const f = offlineExecutorFixture(), fake = fakeOfflineAdapter(f.target, f.input, { throwAfterApply: true, misreportRecovery: true });
  const result = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, 'offline-misreported-recovery');
  assert.equal(result.status, 'FAILED');
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'RECOVERY_POSTSTATE_UNVERIFIED');
  assert.equal(f.events.at(-1)?.state, 'failed');
});

test('D offline executor rejects baseline history mutation on verified replay', async () => {
  const f = offlineExecutorFixture(), fake = fakeOfflineAdapter(f.target, f.input);
  const first = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, 'offline-baseline-first');
  assert.equal(first.passed, true);
  fake.state.versions[0].contentFingerprint = 'f'.repeat(64);
  fake.state.targetStateFingerprint = 'e'.repeat(64);
  const replay = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, 'offline-baseline-replay');
  assert.equal(replay.status, 'FAILED');
  assert.equal(replay.reason, 'VERIFIED_CONTENT_OR_BASELINE_CHANGED');
  assert.equal(fake.applyCount, 1);
});

test('D offline executor rejects raw target drift before prepare without mutation', async () => {
  const f = offlineExecutorFixture(), fake = fakeOfflineAdapter(f.target, f.input);
  fake.state.targetStateFingerprint = 'f'.repeat(64);
  const result = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, 'offline-target-drift');
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'TARGET_CHANGED_BEFORE_PREPARE');
  assert.equal(fake.applyCount, 0);
});
test('D file journal resumes an applied token after process interruption without a duplicate adapter write', async () => {
  const f = offlineExecutorFixture();
  const fake = fakeOfflineAdapter(f.target, f.input);
  const directory = path.join(ROOT, '.concordia', 'publication-runs', `recovery-${randomUUID().replaceAll('-', '')}`);
  const store = new FilePublicationJournal(path.join(directory, 'journal.jsonl'), ROOT);
  const interruptedStore = {
    withExclusiveLock: <T>(work: (locked: any) => Promise<T>) => store.withExclusiveLock(locked => work({
      readEvents: locked.readEvents,
      append: (event: PublicationJournalEvent) => { if (event.state === 'applied') throw new Error('simulated process interruption'); locked.append(event); }
    }))
  };
  try {
    await assert.rejects(executeOfflinePublication(f.manifest, f.input, fake.adapter, interruptedStore as any, 'offline-durable-crash'), /simulated process interruption/);
    const prepared = await store.withExclusiveLock(async locked => locked.readEvents());
    assert.deepEqual(prepared.map(event => event.state), ['planned', 'prepared']);
    const reopened = new FilePublicationJournal(path.join(directory, 'journal.jsonl'), ROOT);
    const recovered = await executeOfflinePublication(f.manifest, f.input, fake.adapter, reopened, 'offline-durable-retry');
    assert.equal(recovered.status, 'VERIFIED');
    assert.equal(recovered.passed, true);
    assert.equal(fake.applyCount, 1);
    const complete = await reopened.withExclusiveLock(async locked => locked.readEvents());
    assert.deepEqual(complete.map(event => event.state), ['planned', 'prepared', 'recovered', 'verified']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('D rejects valid receipts when active version is missing, foreign, disabled or duplicated', async () => {
  const corruptions: ((snapshot: OfflinePublicationSnapshot) => void)[] = [
    snapshot => { snapshot.versions = snapshot.versions.filter(version => version.versionId !== snapshot.activeVersionId); },
    snapshot => { const active = snapshot.versions.find(version => version.versionId === snapshot.activeVersionId)!; active.planFingerprint = 'c'.repeat(64); },
    snapshot => { const active = snapshot.versions.find(version => version.versionId === snapshot.activeVersionId)!; active.enabled = false; },
    snapshot => { const active = snapshot.versions.find(version => version.versionId === snapshot.activeVersionId)!; snapshot.versions.push({ ...active }); },
    snapshot => { snapshot.appliedTokens.push({ ...snapshot.appliedTokens[0] }); }
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const f = offlineExecutorFixture(), fake = fakeOfflineAdapter(f.target, f.input);
    const first = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, `offline-shape-${index}`);
    assert.equal(first.passed, true);
    corrupt(fake.state);
    const replay = await executeOfflinePublication(f.manifest, f.input, fake.adapter, f.journal as any, `offline-shape-replay-${index}`);
    assert.equal(replay.passed, false);
    assert.notEqual(replay.status, 'VERIFIED');
    assert.equal(fake.applyCount, 1);
  }
});

test('D fails closed when adapter input target state disagrees with its snapshot', async () => {
  const f = offlineExecutorFixture(), fake = fakeOfflineAdapter(f.target, f.input);
  const inconsistent: OfflinePublicationAdapter = { ...fake.adapter, async readLatest() {
    const read = await fake.adapter.readLatest();
    return { ...read, input: { ...read.input, targetState: { ...read.input.targetState!, fingerprint: 'e'.repeat(64) } } };
  } };
  const result = await executeOfflinePublication(f.manifest, f.input, inconsistent, f.journal as any, 'offline-inconsistent-read');
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'PUBLICATION_INPUT_TARGET_STATE_MISMATCH');
  assert.equal(fake.applyCount, 0);
});

test('B5 publication plan persists freshness dependencies and becomes stale when semantic source version changes',()=>{
  const f=fixture(),snapshot=(version:string,state:'CURRENT'|'STALE'|'PENDING'|'UNKNOWN'='CURRENT')=>({schemaVersion:1 as const,universeId:'U1',state,dependencies:[{relationId:f.contract.id,state,semanticSourceVersion:version,contractVersion:f.contract.contractVersion,decisionRef:f.decision.decisionId,policyVersion:f.decision.policyVersion,verdict:f.decision.verdict,evidenceRefs:[f.evidence.evidenceBundleId],attemptRef:`attempt-${version}`,latestCompleteAttemptRef:`attempt-${version}`,checkedAt:'2026-10-23T00:00:00Z'}]});
  const input={...f,universeId:'U1',evidence:[f.evidence],freshnessState:'CURRENT_FOR_CHECK' as const,freshnessSnapshot:snapshot('semantic-v1')};
  const plan=compilePublicationPlan(input);assert.equal(plan.dependencyAssessment?.state,'CURRENT');assert.equal(plan.planConditions.freshnessState,'CURRENT_FOR_CHECK');
  assert.equal(checkPublicationPlanPreconditions(plan,input).status,'CURRENT');
  const canonicalSnapshot={...input,freshnessSnapshot:{...snapshot('semantic-v1'),universeId:'concordia.universe.ny-taxi'}};assert.equal(compilePublicationPlan(canonicalSnapshot).dependencyAssessment?.state,'CURRENT');
  const changed={...input,freshnessSnapshot:snapshot('semantic-v2')};const check=checkPublicationPlanPreconditions(plan,changed);
  assert.equal(check.status,'STALE');assert.ok(check.staleInputs.includes('dependencyState'));
  const partial=compilePublicationPlan({...input,freshnessSnapshot:snapshot('semantic-v1','PENDING')});
  assert.equal(partial.dependencyAssessment?.state,'PENDING');assert.equal(partial.planConditions.freshnessState,'UNKNOWN');assert.ok(partial.reasons.includes('publication_dependency_pending'));
  const stale=compilePublicationPlan({...input,freshnessSnapshot:snapshot('semantic-v2','STALE')});
  assert.equal(stale.dependencyAssessment?.state,'STALE');assert.equal(stale.planConditions.freshnessState,'STALE');assert.ok(stale.reasons.includes('publication_dependency_stale'));
});