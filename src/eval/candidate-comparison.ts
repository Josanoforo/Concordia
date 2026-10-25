import { candidateIdentity, fingerprint, produceCandidates, type CandidateContribution, type CandidateProvider, type CandidateProductionEnvelope } from '../discovery/candidates.ts';
import { createU1HeuristicProvider, type LiveTable } from '../discovery/index.ts';
import { evaluateRelation, type RelationPolicy } from '../relations/decision.ts';
import type { Candidate, Decision, EvidenceBundle, RelationContract, Unknown } from '../contracts/types.ts';

export interface FrozenCandidateSnapshot {
  schemaVersion: number;
  universeId: string;
  database: string;
  normalizationContract: { defaultMode?: string; modes: Record<string, unknown> };
  tables: Record<string, LiveTable>;
  executionMode: 'REPLAY' | 'LOCAL';
  dataOrigin: 'UNKNOWN' | 'SYNTHETIC';
  provenance: { sourcePath?: string; sourceSha256: string; captureUtc: string; sourceDataOrigin?: string; excludedTables: string[]; [key: string]: unknown };
}

export interface FrozenCandidateCase {
  caseId: string;
  taskId: string;
  universeId: string;
  fromEndpoint: { db: string; table: string; column: string };
  toEndpoint: { db: string; table: string; column: string };
}

export interface CandidateComparisonInput {
  snapshot: FrozenCandidateSnapshot;
  caseUniverse: { schemaVersion: number; enumerationBasis: string; cases: readonly FrozenCandidateCase[] };
  inputFreeze: Record<string, any>;
  freeze: { codeHash: string; policyHash: string; frozenAt: string };
  policy: RelationPolicy;
}

type MethodId = 'key-family' | 'paired-label-catalog' | 'key-family+paired-label-catalog';
type ComparisonStatus = 'EVALUATED' | 'NOT_IN_SCOPE' | 'NOT_CONSULTED' | 'ERROR';
type CaseResult = { caseId: string; status: ComparisonStatus; reasonCodes: string[]; candidateIdentity?: string; candidateId?: string; decision?: Decision };

const known = <T>(value: T): Unknown<T> => ({ state: 'KNOWN', value });
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))) : item);
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const endpointKey = (endpoint: { db: string; table: string; column: string }) => canonical([endpoint.db, endpoint.table, endpoint.column]);
const normalizedMode = (value: unknown) => value === 'text' || value === 'integer' || value === 'integer-pad10';

function validateInput(input: CandidateComparisonInput) {
  const { snapshot, caseUniverse, inputFreeze, freeze, policy } = input;
  if (snapshot.schemaVersion !== 1 || !snapshot.universeId || !snapshot.database || !snapshot.provenance?.sourceSha256 || !snapshot.provenance.captureUtc
    || !['REPLAY', 'LOCAL'].includes(snapshot.executionMode) || !['UNKNOWN', 'SYNTHETIC'].includes(snapshot.dataOrigin)) throw new TypeError('E05D_SNAPSHOT_INVALID');
  if (snapshot.executionMode === 'REPLAY' && snapshot.dataOrigin !== 'UNKNOWN' || snapshot.executionMode === 'LOCAL' && snapshot.dataOrigin !== 'SYNTHETIC') throw new TypeError('E05D_MODE_ORIGIN_MISMATCH');
  if (!normalizedMode(snapshot.normalizationContract?.defaultMode) || !snapshot.normalizationContract.modes[snapshot.normalizationContract.defaultMode!]) throw new TypeError('E05D_NORMALIZATION_CONTEXT_INVALID');
  if (!validHash(inputFreeze.inputSha256) || !validHash(inputFreeze.caseUniverseSha256) || !validHash(inputFreeze.originalSourceSha256) || !validHash(inputFreeze.configSha256) || !validHash(inputFreeze.costExclusionsSha256)
    || !Number.isInteger(inputFreeze.caseCount) || inputFreeze.caseCount !== caseUniverse.cases.length || !Number.isInteger(inputFreeze.tables) || inputFreeze.tables !== Object.keys(snapshot.tables).length
    || !Number.isInteger(inputFreeze.rows) || inputFreeze.rows !== Object.values(snapshot.tables).reduce((count, table) => count + table.sample.rows.length, 0)
    || inputFreeze.executionMode !== snapshot.executionMode || inputFreeze.dataOrigin !== snapshot.dataOrigin || !inputFreeze.budget || !Number.isInteger(inputFreeze.budget.candidateLimit) || inputFreeze.budget.candidateLimit < 0
    || !Number.isFinite(inputFreeze.budget.reviewMinutes) || inputFreeze.budget.reviewMinutes < 0) throw new TypeError('E05D_INPUT_FREEZE_INVALID');
  if (!freeze.codeHash || !freeze.policyHash || Number.isNaN(Date.parse(freeze.frozenAt)) || !policy.policyVersion) throw new TypeError('E05D_RUN_FREEZE_INVALID');
  const excluded = new Set(snapshot.provenance.excludedTables ?? []);
  if (Object.keys(snapshot.tables).some(table => excluded.has(table))) throw new TypeError('E05D_EXCLUDED_TABLE_PRESENT');
  for (const [name, table] of Object.entries(snapshot.tables)) {
    const projected = new Set(table.columns), declared = new Set([...table.keyColumns, ...table.labels]);
    if (!name || !Array.isArray(table.schema) || !Array.isArray(table.columns) || !Array.isArray(table.keyColumns) || !Array.isArray(table.labels)
      || !Array.isArray(table.sample?.rows) || new Set(table.columns).size !== table.columns.length || projected.size !== declared.size
      || [...projected].some(column => !declared.has(column)) || [...declared].some(column => !projected.has(column))
      || new Set(table.schema.map(column => column.name)).size !== table.schema.length || table.schema.length !== table.columns.length
      || table.schema.some(column => !projected.has(column.name)) || table.sample.rows.some(row => !Array.isArray(row) || row.length !== table.columns.length
        || row.some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) throw new TypeError('E05D_SNAPSHOT_ALLOWLIST_OR_ROW_SHAPE_INVALID');
  }
  if (new Set(caseUniverse.cases.map(item => item.caseId)).size !== caseUniverse.cases.length || caseUniverse.cases.some(item => !item.caseId || !item.taskId || item.universeId !== snapshot.universeId
    || !item.fromEndpoint?.db || !item.fromEndpoint.table || !item.fromEndpoint.column || !item.toEndpoint?.db || !item.toEndpoint.table || !item.toEndpoint.column)) throw new TypeError('E05D_CASE_UNIVERSE_INVALID');
}

function methodProvider(base: CandidateProvider, methodId: Exclude<MethodId, 'key-family+paired-label-catalog'>): CandidateProvider {
  const providerId = `concordia.e05d.${methodId}`;
  return {
    descriptor: { providerId, version: '1.0.0', method: methodId, capability: 'SUPPORTED' },
    produce(context) {
      const output = base.produce(context);
      if (output instanceof Promise) throw new TypeError('E05D_PROVIDER_MUST_BE_PURE_SYNC');
      const contributions = output.contributions.filter(item => item.methodId === methodId || item.methodIds?.includes(methodId));
      const scope = methodId === 'key-family' ? 'fact-dimension-candidate' : 'catalog-candidate';
      return { ...output, contributions, abstentions: contributions.length ? output.abstentions : [...output.abstentions, { reason: 'METHOD_NO_PROPOSALS_FOR_SCOPE', scope }],
        limitations: [...output.limitations, `selected existing ${methodId} contributions only`] };
    }
  };
}

function productionInput(input: CandidateComparisonInput) {
  const snapshot = input.snapshot;
  const tables = Object.entries(snapshot.tables);
  const columns = [...new Set(tables.flatMap(([, table]) => table.columns))].sort((a, b) => a.localeCompare(b, 'en'));
  return {
    universeId: snapshot.universeId, sourceId: `zetaris:${snapshot.database}`, sourceVersion: { state: 'UNKNOWN' } as Unknown<string>,
    configFingerprint: input.inputFreeze.configSha256, inputHash: input.inputFreeze.inputSha256,
    scope: { tables: tables.map(([name]) => name).sort((a, b) => a.localeCompare(b, 'en')), columns },
    executionMode: snapshot.executionMode, dataOrigin: snapshot.dataOrigin,
    tableMetadata: Object.fromEntries(tables.map(([name, table]) => [name, { columns: table.schema, keyColumns: table.keyColumns, role: table.role }])),
    evidenceRefs: [...new Set(tables.map(([, table]) => table.sample.requestId).filter((id): id is string => typeof id === 'string' && !!id))].sort((a, b) => a.localeCompare(b, 'en')),
    metadata: { liveTables: snapshot.tables, normalizationContract: snapshot.normalizationContract, database: snapshot.database }
  };
}

function inScope(methodId: MethodId, testCase: FrozenCandidateCase, tables: Record<string, LiveTable>): boolean {
  const from = tables[testCase.fromEndpoint.table], to = tables[testCase.toEndpoint.table];
  const keyRule = testCase.taskId === 'fact-dimension-candidate' && from && to && from.role !== 'dimension' && to.role === 'dimension'
    && from.keyColumns.includes(testCase.fromEndpoint.column) && to.keyColumns.includes(testCase.toEndpoint.column);
  const tableOrder = Object.keys(tables);
  const pairedLabelsRule = testCase.taskId === 'catalog-candidate' && from?.role === 'dimension' && to?.role === 'dimension'
    && from.labels.length > 0 && to.labels.length > 0 && from.keyColumns[0] === testCase.fromEndpoint.column && to.keyColumns[0] === testCase.toEndpoint.column
    && tableOrder.indexOf(testCase.fromEndpoint.table) >= 0 && tableOrder.indexOf(testCase.fromEndpoint.table) < tableOrder.indexOf(testCase.toEndpoint.table);
  return methodId === 'key-family' ? keyRule : methodId === 'paired-label-catalog' ? pairedLabelsRule : Boolean(keyRule || pairedLabelsRule);
}

function contributionEndpoints(item: CandidateContribution): { from: { db: string; table: string; column: string }; to: { db: string; table: string; column: string } } | undefined {
  if (item.legacyCandidate) return { from: item.legacyCandidate.from, to: item.legacyCandidate.to };
  const c = item.candidate?.relationDraft;
  if (!c) return undefined;
  const tableOf = (objectId: string) => objectId.split('.').at(-1) ?? '';
  return { from: { db: '', table: tableOf(c.from.objectId), column: c.from.orderedColumns[0] ?? '' }, to: { db: '', table: tableOf(c.to.objectId), column: c.to.orderedColumns[0] ?? '' } };
}

function bundleFor(input: CandidateComparisonInput, testCase: FrozenCandidateCase, contract: RelationContract): EvidenceBundle {
  const snapshot = input.snapshot, capturedAt = snapshot.provenance.captureUtc;
  const makeObservation = (endpoint: RelationContract['from'], tableName: string, column: string, side: string) => {
    const table = snapshot.tables[tableName];
    if (!table || !table.columns.includes(column)) throw new TypeError('E05D_CASE_COLUMN_OUTSIDE_SNAPSHOT_ALLOWLIST');
    const index = table.columns.indexOf(column);
    const rows = table.sample.rows.map(row => {
      if (!Array.isArray(row) || index >= row.length) throw new TypeError('E05D_SNAPSHOT_ROW_SHAPE_INVALID');
      const value = row[index];
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new TypeError('E05D_SNAPSHOT_VALUE_TYPE_INVALID');
      return [value];
    });
    return { observationId: `e05d:${fingerprint([input.inputFreeze.inputSha256, testCase.caseId, side])}`, type: 'KEY_MEMBERSHIP', sourceRef: endpoint.sourceId,
      adapterId: 'frozen-discovery-snapshot', requestId: table.sample.requestId ? known(table.sample.requestId) : { state: 'UNKNOWN' as const },
      observedAt: { state: 'UNKNOWN' as const }, checkedAt: capturedAt,
      nativeVersion: { state: 'UNKNOWN' as const }, fingerprint: { state: 'UNKNOWN' as const }, projection: [column], filters: [], limit: 'UNKNOWN' as const,
      measuredTuples: rows, nullCount: rows.filter(row => row[0] === null).length, duplicateCount: 'UNKNOWN' as const, truncated: 'UNKNOWN' as const,
      transportStatus: 'OK' as const, protectedPayloadRef: { state: 'UNKNOWN' as const } };
  };
  const observations = [makeObservation(contract.from, testCase.fromEndpoint.table, testCase.fromEndpoint.column, 'from'),
    makeObservation(contract.to, testCase.toEndpoint.table, testCase.toEndpoint.column, 'to')];
  return { schemaVersion: 1, evidenceBundleId: `evidence:e05d:${fingerprint([input.inputFreeze.inputSha256, testCase.caseId])}`, relationRef: contract.id,
    contractVersion: contract.contractVersion, sourceRefs: observations.map(item => item.sourceRef).sort((a, b) => a.localeCompare(b, 'en')),
    runRef: { runId: `e05d:${input.inputFreeze.inputSha256}`, startedAt: known(capturedAt), executionMode: snapshot.executionMode,
      dataOrigin: snapshot.dataOrigin, configFingerprint: known(input.inputFreeze.configSha256) }, observations,
    scope: known('allowlisted frozen key sample; bounded coverage unknown'), completeness: 'UNKNOWN', capturedAt };
}

function methodResults(input: CandidateComparisonInput, methodId: MethodId, envelope: CandidateProductionEnvelope) {
  const cases = [...input.caseUniverse.cases].sort((a, b) => a.caseId.localeCompare(b.caseId, 'en'));
  const proposals = envelope.contributions.flatMap(item => {
    const endpoints = contributionEndpoints(item);
    if (!endpoints) return [];
    const matches = cases.filter(testCase => endpointKey(testCase.fromEndpoint) === endpointKey(endpoints.from) && endpointKey(testCase.toEndpoint) === endpointKey(endpoints.to));
    return matches.map(testCase => ({ testCase, item, identity: candidateIdentity(item.candidate) }));
  }).sort((a, b) => a.testCase.caseId.localeCompare(b.testCase.caseId, 'en') || a.identity.localeCompare(b.identity, 'en'));
  const eligibleIds = new Set(cases.filter(testCase => inScope(methodId, testCase, input.snapshot.tables)).map(testCase => testCase.caseId));
  const eligibleProposals = proposals.filter(item => eligibleIds.has(item.testCase.caseId));
  const proposedIds = [...new Set(eligibleProposals.map(item => item.testCase.caseId))].sort((a, b) => a.localeCompare(b, 'en'));
  const budgetLimit = input.inputFreeze.budget.candidateLimit as number;
  const selectedKeys = new Set(eligibleProposals.slice(0, budgetLimit).map(item => `${item.testCase.caseId}\0${item.identity}`));
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    if (!inScope(methodId, testCase, input.snapshot.tables)) {
      results.push({ caseId: testCase.caseId, status: 'NOT_IN_SCOPE', reasonCodes: ['method_outside_task_or_rule_scope'] });
      continue;
    }
    const matches = eligibleProposals.filter(item => item.testCase.caseId === testCase.caseId);
    if (!matches.length) {
      results.push({ caseId: testCase.caseId, status: 'NOT_CONSULTED', reasonCodes: ['method_did_not_propose'] });
      continue;
    }
    for (const proposal of matches) {
      if (!selectedKeys.has(`${testCase.caseId}\0${proposal.identity}`)) {
        results.push({ caseId: testCase.caseId, status: 'NOT_CONSULTED', reasonCodes: ['candidate_limit_reached'], candidateIdentity: proposal.identity, candidateId: proposal.item.candidate.candidateId });
        continue;
      }
      try {
        const evidence = bundleFor(input, testCase, proposal.item.candidate.relationDraft);
        const decision = evaluateRelation(proposal.item.candidate.relationDraft, [evidence], input.policy);
        results.push({ caseId: testCase.caseId, status: 'EVALUATED', reasonCodes: decision.reasonCodes, candidateIdentity: proposal.identity, candidateId: proposal.item.candidate.candidateId, decision });
      } catch (error) {
        results.push({ caseId: testCase.caseId, status: 'ERROR', reasonCodes: [error instanceof Error ? error.name : 'CANDIDATE_EVALUATION_ERROR'], candidateIdentity: proposal.identity, candidateId: proposal.item.candidate.candidateId });
      }
    }
  }
  const eligible = cases.filter(testCase => inScope(methodId, testCase, input.snapshot.tables)).length;
  const evaluated = results.filter(item => item.status === 'EVALUATED');
  const consulted = results.filter(item => item.status === 'EVALUATED' || item.status === 'ERROR').length;
  const notProposed = results.filter(item => item.reasonCodes.includes('method_did_not_propose')).length;
  const candidateLimitNotConsulted = results.filter(item => item.reasonCodes.includes('candidate_limit_reached')).length;
  const decisionAbstentions = evaluated.filter(item => item.decision?.verdict === 'INDETERMINADA').length;
  const accepts = evaluated.filter(item => item.decision?.verdict === 'SOSTENIDA').length;
  const rejects = evaluated.filter(item => item.decision?.verdict === 'ENGAÑOSA').length;
  const providerAbstentions = envelope.abstentions.length;
  const rate = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
  const taskIds = [...new Set(cases.map(testCase => testCase.taskId))].sort((a, b) => a.localeCompare(b, 'en'));
  const byTask = taskIds.map(taskId => {
    const taskCases = cases.filter(testCase => testCase.taskId === taskId), taskEligible = taskCases.filter(testCase => inScope(methodId, testCase, input.snapshot.tables));
    const taskIdsSet = new Set(taskCases.map(testCase => testCase.caseId)), taskResults = results.filter(item => taskIdsSet.has(item.caseId));
    const taskEvaluated = taskResults.filter(item => item.status === 'EVALUATED'), taskProposals = eligibleProposals.filter(item => taskIdsSet.has(item.testCase.caseId));
    const taskProposedIds = new Set(taskProposals.map(item => item.testCase.caseId));
    const taskAccepts = taskEvaluated.filter(item => item.decision?.verdict === 'SOSTENIDA').length;
    const taskRejects = taskEvaluated.filter(item => item.decision?.verdict === 'ENGAÑOSA').length;
    const taskAbstentions = taskEvaluated.filter(item => item.decision?.verdict === 'INDETERMINADA').length;
    const taskReviewed = taskEvaluated.filter(item => item.decision?.requiresReview).length;
    return { taskId, counts: { allCases: taskCases.length, eligibleCases: taskEligible.length, proposedCases: taskProposedIds.size, proposals: taskProposals.length,
      notProposed: taskResults.filter(item => item.reasonCodes.includes('method_did_not_propose')).length,
      notInScope: taskResults.filter(item => item.status === 'NOT_IN_SCOPE').length,
      candidateLimitNotConsulted: taskResults.filter(item => item.reasonCodes.includes('candidate_limit_reached')).length,
      consulted: taskResults.filter(item => item.status === 'EVALUATED' || item.status === 'ERROR').length, evaluated: taskEvaluated.length,
      providerAbstentions: envelope.abstentions.filter(item => item.scope === taskId).length, decisionAbstentions: taskAbstentions,
      accepts: taskAccepts, rejects: taskRejects, reviewed: taskReviewed, errors: taskResults.filter(item => item.status === 'ERROR').length },
      rates: { proposalCoverage: rate(taskProposedIds.size, taskEligible.length), decisionAcceptance: rate(taskAccepts, taskEvaluated.length),
        decisionRejection: rate(taskRejects, taskEvaluated.length), decisionAbstention: rate(taskAbstentions, taskEvaluated.length), review: rate(taskReviewed, taskEvaluated.length) } };
  });
  return {
    methodId, providerVersion: envelope.providers.map(item => `${item.providerId}@${item.version}`).sort((a, b) => a.localeCompare(b, 'en')),
    budget: structuredClone(input.inputFreeze.budget), capability: methodId === 'key-family' ? ['fact-dimension-candidate'] : methodId === 'paired-label-catalog' ? ['catalog-candidate'] : ['fact-dimension-candidate', 'catalog-candidate'],
    counts: { allCases: cases.length, eligibleCases: eligible, proposedCases: proposedIds.length, proposals: eligibleProposals.length,
      notProposed,
      notInScope: results.filter(item => item.status === 'NOT_IN_SCOPE').length,
      notConsulted: notProposed + candidateLimitNotConsulted, candidateLimitNotConsulted,
      consulted, evaluated: evaluated.length, providerAbstentions, decisionAbstentions, accepts, rejects, providerErrors: envelope.errors.length,
      reviewed: evaluated.filter(item => item.decision?.requiresReview).length,
      errors: results.filter(item => item.status === 'ERROR').length,
      deduplicatedContributors: envelope.contributions.reduce((sum, item) => sum + Math.max(0, (item.methodIds?.length ?? (item.methodId ? 1 : 0)) - 1), 0) },
    rates: { proposalCoverage: rate(proposedIds.length, eligible), decisionAcceptance: rate(accepts, evaluated.length),
      decisionRejection: rate(rejects, evaluated.length), decisionAbstention: rate(decisionAbstentions, evaluated.length),
      review: rate(evaluated.filter(item => item.decision?.requiresReview).length, evaluated.length) },
    byTask,
    proposalCoverage: eligible ? proposedIds.length / eligible : null,
    semanticMetrics: { precision: null, falseAcceptanceRate: null, recall: null, truth: 'UNKNOWN' as const },
    proposedCaseIds: proposedIds, results, production: envelope
  };
}

/** Pure, deterministic comparison over caller-supplied frozen input; performs no I/O and accepts no gold labels. */
export async function compareCandidateMethods(input: CandidateComparisonInput) {
  validateInput(input);
  const commonInput = productionInput(input), source = createU1HeuristicProvider();
  const keyProvider = methodProvider(source, 'key-family'), labelProvider = methodProvider(source, 'paired-label-catalog');
  const keyRun = await produceCandidates(commonInput, [keyProvider]);
  const labelRun = await produceCandidates(commonInput, [labelProvider]);
  const combinedRun = await produceCandidates(commonInput, [keyProvider, labelProvider]);
  const originalRun = await produceCandidates(commonInput, [source]);
  const signature = (envelope: CandidateProductionEnvelope) => envelope.contributions.map(item => [candidateIdentity(item.candidate), item.reasons]).sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
  const combinedMatchesOriginal = canonical(signature(combinedRun)) === canonical(signature(originalRun));
  const methods = [methodResults(input, 'key-family', keyRun), methodResults(input, 'paired-label-catalog', labelRun), methodResults(input, 'key-family+paired-label-catalog', combinedRun)];
  const runFreeze = { codeHash: input.freeze.codeHash, policyHash: input.freeze.policyHash, policyVersion: input.policy.policyVersion, frozenAt: input.freeze.frozenAt,
    inputSha256: input.inputFreeze.inputSha256, caseUniverseSha256: input.inputFreeze.caseUniverseSha256, originalSourceSha256: input.inputFreeze.originalSourceSha256,
    configSha256: input.inputFreeze.configSha256, costExclusionsSha256: input.inputFreeze.costExclusionsSha256, budget: structuredClone(input.inputFreeze.budget),
    providerVersions: methods.map(method => ({ methodId: method.methodId, providerVersion: method.providerVersion })),
    equivalenceReferenceProviderVersions: originalRun.providers.map(provider => ({ providerId: provider.providerId, version: provider.version })),
    executionMode: input.snapshot.executionMode, dataOrigin: input.snapshot.dataOrigin,
    timeHumanMeasured: false };
  const result = { schemaVersion: 1 as const, split: 'FROZEN_REPLAY' as const, universeId: input.snapshot.universeId, enumerationBasis: input.caseUniverse.enumerationBasis,
    inputFreeze: structuredClone(input.inputFreeze), snapshotProvenance: structuredClone(input.snapshot.provenance), runFreeze,
    caseUniverseHash: input.inputFreeze.caseUniverseSha256, caseIds: [...input.caseUniverse.cases].map(item => item.caseId).sort((a, b) => a.localeCompare(b, 'en')),
    semanticTruthAvailable: false, fullHeuristicEquivalence: { matchesByCandidateIdentityAndReason: combinedMatchesOriginal, originalCandidateCount: originalRun.candidates.length }, methods };
  return { ...result, comparisonHash: fingerprint(result) };
}
