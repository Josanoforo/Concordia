import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { identifier, Zetaris } from '../clients/zetaris.ts';
import { Nightshift } from '../clients/nightshift.ts';
import { failure, loadLocalEnv, readJson, ROOT, SafeError, setTraceRun, trace, writeJson } from '../runtime.ts';
import { normalizeKey, sourceQuery, universeConfig } from '../universe-pipeline.ts';
import { createInstalledComaBridge } from '../discovery/coma-provider.ts';
import { HMEM } from '../hmem/index.ts';
import { criticize } from '../critic/adversarial.ts';
import { evaluateRelation } from '../relations/decision.ts';
import { relationPolicyFromConfig } from '../relations/policy.ts';
import { EXPLORATION_POLICY } from './exploration-policy.ts';
import { catalogOf } from './catalog.ts';
import { NightshiftChooser, parseAdaptiveChoice, type ChoiceCall } from './chooser.ts';
import { runComaPhase } from './coma-input.ts';
import { describedColumns, prepareAgentContext, runCriticStage, runDiscoveryPhase, runExplorationStage, runProbeStage, type AgentContext, type DiscoveryPhase } from './engine.ts';
import type { BoundedTableRows } from './exploration.ts';
import { readBudget } from '../budget.ts';

const U2_CATALOG = catalogOf(universeConfig('U2'))!;
const SAFE_OPTIONAL = U2_CATALOG.safeOptionalColumns ?? {};
const FORBIDDEN_COLUMN = EXPLORATION_POLICY.forbiddenColumn;
const SAFE_RUN = /^agent-u2-[A-Za-z0-9][A-Za-z0-9._-]{0,48}$/;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type U2JoinChoice = 'CIK_TEXT' | 'CIK_NORMALIZED' | 'SIC_CODE' | 'SIC_DESCRIPTION' | 'SIC_CODE_AND_DESCRIPTION' | 'NO_JOIN';
type AdaptiveModelCall = ChoiceCall;
export { parseAdaptiveChoice };

function askU2Model(nightshift: Nightshift, runId: string, stage: string, observation: unknown, allowed: readonly string[], compact = false): Promise<AdaptiveModelCall> {
  return new NightshiftChooser(nightshift, runId, U2_CATALOG).choose(stage, observation, allowed, { compact });
}

async function resumeAdaptiveDnsChoice(runId: string) {
  if (!SAFE_RUN.test(runId)) throw new SafeError('AGENT_RUN_ID_INVALID');
  const prefix = `.concordia/agent-runs/${runId}/`, report = readJson<any>(prefix + 'report.json');
  if (report.universeId !== 'U2' || report.runId !== runId || report.executionMode !== 'LIVE') throw new SafeError('AGENT_RUN_SCOPE_MISMATCH');
  const adaptive = readJson<any>(prefix + 'adaptive-exploration.json');
  if (adaptive.status !== 'ADAPTIVE_WITHOUT_PROVISIONAL_JOIN' || adaptive.provisionalJoin?.identityJoin?.choice == null ||
    adaptive.provisionalJoin?.dnsJoin?.error?.code !== 'U2_ADAPTIVE_RESPONSE_NOT_JSON') throw new SafeError('U2_ADAPTIVE_DNS_RETRY_NOT_ELIGIBLE');
  setTraceRun(runId);
  loadLocalEnv();
  const nightshift = new Nightshift();
  const alternatives = adaptive.alternatives.map(({ matches, ...summary }: any) => ({ ...summary, sampleMatches: matches.slice(0, 3) }));
  const allowed = alternatives.filter((item: any) => ['SIC_CODE', 'SIC_DESCRIPTION', 'SIC_CODE_AND_DESCRIPTION'].includes(item.choice) && item.matchPairs > 0)
    .map((item: any) => item.choice).concat('NO_JOIN');
  const call = await askU2Model(nightshift, runId, 'choose_company_dns_join_retry', {
    taskEvidence: 'Choose a bounded operational SIC reference join from these existing LIVE reads; no additional data access is requested.',
    alternatives, originalFailure: 'The prior response ended mid-JSON at its output limit; this retry asks for a compact choice.',
    constraints: ['Select only a listed choice; prefer evidence-backed bounded usefulness.', 'Keep UNKNOWN/PENDING; no global key, acceptance, or human approval.']
  }, allowed, true);
  adaptive.calls.push(call);
  const dnsChoice = call.decisionStatus === 'VALID' && call.selected ? call.selected : undefined;
  const metrics = adaptive.alternatives.find((item: any) => item.choice === dnsChoice);
  const usable = Boolean(dnsChoice && dnsChoice !== 'NO_JOIN' && metrics?.matchPairs > 0);
  const dnsJoin = { selectedBy: call.decisionStatus === 'VALID' ? 'nightshift' : 'none', choice: dnsChoice ?? null, reason: call.reason ?? null,
    status: usable ? 'PROVISIONAL_FOR_BOUNDED_TASK' : dnsChoice === 'NO_JOIN' ? 'NO_JOIN_SELECTED' : 'MODEL_DECISION_UNAVAILABLE',
    operationallyUsed: usable, verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING', requiresHumanReview: false,
    boundedMetrics: metrics ?? null, error: call.error ?? null, allowedChoices: allowed };
  const previous = adaptive.provisionalJoin;
  const used = Boolean(previous.identityJoin?.operationallyUsed && dnsJoin.operationallyUsed);
  adaptive.provisionalJoin = { ...previous, choice: dnsJoin.choice, dnsJoin, status: used ? 'PROVISIONAL_FOR_BOUNDED_TASK' : 'NO_COMPLETE_PROVISIONAL_PATH',
    operationallyUsed: used, verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING', requiresHumanReview: false };
  adaptive.status = used ? 'ADAPTIVE_WITH_PROVISIONAL_JOIN' : 'ADAPTIVE_WITHOUT_PROVISIONAL_JOIN';
  adaptive.plannerStatus = adaptive.calls.every((item: any) => item.status === 'PASS' && item.decisionStatus === 'VALID') ? 'MODEL_DECISIONS_RECORDED'
    : call.decisionStatus === 'VALID' && adaptive.calls.some((item: any) => item.stage === 'choose_company_dns_join' && item.decisionStatus !== 'VALID')
      ? 'MODEL_DECISIONS_RECORDED_AFTER_RETRY' : 'MODEL_PARTIAL_OR_FAILED';
  const budget = readBudget(), oldUse = report.adaptiveExploration?.usage?.ledger;
  if (!oldUse || !Number.isInteger(oldUse.priorAttemptCount) || typeof oldUse.priorAttemptsPrefixSha256 !== 'string') throw new SafeError('U2_ADAPTIVE_BUDGET_BASELINE_MISSING');
  adaptive.budgetUse = { ...adaptive.budgetUse, ...oldUse };
  const originalCount = oldUse.priorAttemptCount;
  const receipts = adaptive.calls.flatMap((item: any) => item.receipt ? [item.receipt] : []);
  Object.assign(oldUse, { attemptsAfter: budget.consumed, attemptsAdded: budget.consumed - originalCount,
    priorAttemptsPreserved: sha(budget.attempts.slice(0, originalCount)) === oldUse.priorAttemptsPrefixSha256,
    runReceipts: receipts, runInputTokens: receipts.reduce((sum: number, receipt: any) => sum + receipt.inputTokens, 0),
    runOutputTokens: receipts.reduce((sum: number, receipt: any) => sum + receipt.outputTokens, 0),
    runTotalTokens: receipts.reduce((sum: number, receipt: any) => sum + receipt.totalTokens, 0),
    observedModels: [...new Set(receipts.map((receipt: any) => `${receipt.provider}/${receipt.model}`))] });
  const usage = { requestedModel: oldUse.requestedModel, observedModels: oldUse.observedModels, receipts,
    inputTokens: oldUse.runInputTokens, outputTokens: oldUse.runOutputTokens, totalTokens: oldUse.runTotalTokens, ledger: oldUse };
  report.adaptiveExploration = { ...adaptive, requestedModel: oldUse.requestedModel, usage,
    joins: { choice: adaptive.provisionalJoin, alternatives: adaptive.alternatives } };
  const fact = report.profile?.[0], dnsRead = adaptive.dnsRead, secRead = adaptive.secRead;
  if (fact && usable && dnsRead?.rows?.length && secRead?.rows?.length) {
    const match = metrics.matches?.[0], targetRow = match?.targetRow;
    const codeIndex = dnsRead.columns.indexOf('sic_code'), descriptionIndex = dnsRead.columns.indexOf('description');
    if (targetRow && codeIndex >= 0 && descriptionIndex >= 0) {
      const description = targetRow[descriptionIndex] ?? null;
      fact.provenance.selectedOperationalJoin = { identity: adaptive.provisionalJoin.identityJoin.choice, sicReference: dnsChoice };
      fact.sectorReference = { sicCode: targetRow[codeIndex] ?? null, description, source: 'COMPANY_DNS.sic_reference',
        queryId: dnsRead.queryId, requestId: dnsRead.requestId,
        descriptionMatchesSecFiling: description === fact.sectorDescription, joinChoice: dnsChoice, status: 'PROVISIONAL' };
    }
  }
  writeJson(prefix + 'adaptive-exploration.json', adaptive);
  writeJson(prefix + 'report.json', report);
  const memory = new HMEM({ actor: 'concordia-agent-u2', persistDir: path.join(ROOT, '.concordia', 'agent-runs', runId, 'memory') });
  const memoryRecord = memory.add({ content: `U2 provisional operational union ${adaptive.provisionalJoin.identityJoin.choice} ${dnsChoice ?? 'none'}; run ${runId}; status UNKNOWN/PENDING; bounded alternatives and evidence refs are in report.json.`,
    type: 'factual', layer: 'working', source: `U2 adaptive bounded exploration ${runId}`, confidence: 0.6, missionId: runId, goalRunId: runId,
    tags: ['U2', 'provisional-join', 'unknown-pending', 'adaptive-exploration'], provenance: { origin: 'plan_completion', learnedAt: Date.now(),
      label: 'Bounded operational join choice, not adjudication', refs: [prefix + 'report.json', ...adaptive.alternatives.flatMap((item: any) => [...item.sourceEvidenceRefs, ...item.targetEvidenceRefs])] } });
  report.memory.adaptiveDecisionMemoryId = memoryRecord.id;
  report.integrity.budgetAttemptsAfter = budget.consumed;
  report.integrity.budgetPrefixPreserved = oldUse.priorAttemptsPreserved;
  writeJson(prefix + 'report.json', report);
  trace({ kind: 'agent-u2-adaptive-choice-resumed', runId, status: adaptive.status, dnsChoice: dnsChoice ?? null,
    decisionStatus: call.decisionStatus, operationallyUsed: usable, freshReads: 0, receiptId: call.receipt?.receiptId ?? null });
  const result = { status: adaptive.status, runId, dnsChoice: dnsChoice ?? null, decisionStatus: call.decisionStatus, operationallyUsed: usable,
    freshReads: 0, receipt: call.receipt ?? null, reportPath: prefix + 'report.json' };
  console.log(JSON.stringify(result));
  return result;
}

type JoinMatch = { sourceRow: unknown[]; targetRow: unknown[]; sourceEvidence: string; targetEvidence: string };
type JoinAlternative = { choice: U2JoinChoice; from: string; to: string; normalization: string; nSource: number; nTarget: number; sourceNulls: number | null; targetNulls: number | null;
  matchedSourceRows: number | null; unmatchedSourceRows: number | null; matchPairs: number | null; ambiguousSourceRows: number | null; duplicateTargetValues: number | null; sampleBounded: true;
  fieldAvailability: 'AVAILABLE' | 'NOT_PROJECTED' | 'NOT_APPLICABLE'; sourceEvidenceRefs: string[]; targetEvidenceRefs: string[]; matches: JoinMatch[] };

export function compareBoundedRows(input: { choice: U2JoinChoice; from: string; to: string; normalization: 'text' | 'integer' | 'integer-pad10';
  sourceRows: readonly unknown[][]; sourceColumns: readonly string[]; targetRows: readonly unknown[][]; targetColumns: readonly string[];
  sourceColumn: string; targetColumn: string; sourceEvidence: string[]; targetEvidence: string[]; cfg: any }): JoinAlternative {
  const sourceIndex = input.sourceColumns.indexOf(input.sourceColumn), targetIndex = input.targetColumns.indexOf(input.targetColumn);
  if (sourceIndex < 0 || targetIndex < 0) return { choice: input.choice, from: input.from, to: input.to, normalization: input.normalization,
    nSource: input.sourceRows.length, nTarget: input.targetRows.length, sourceNulls: null, targetNulls: null, matchedSourceRows: null, unmatchedSourceRows: null, matchPairs: null, ambiguousSourceRows: null,
    duplicateTargetValues: 0, sampleBounded: true, fieldAvailability: 'NOT_PROJECTED', sourceEvidenceRefs: input.sourceEvidence, targetEvidenceRefs: input.targetEvidence, matches: [] };
  const normalize = (value: unknown) => normalizeKey(value, input.normalization, input.cfg.normalizationContract);
  const targetKeyCounts = new Map<string, number>();
  for (const row of input.targetRows) { const key = normalize(row[targetIndex]); if (key !== null) targetKeyCounts.set(key, (targetKeyCounts.get(key) ?? 0) + 1); }
  const matches: JoinMatch[] = []; let matchedSourceRows = 0, ambiguousSourceRows = 0;
  for (const sourceRow of input.sourceRows) {
    const sourceKey = normalize(sourceRow[sourceIndex]); if (sourceKey === null) continue;
    const hits = input.targetRows.filter(targetRow => normalize(targetRow[targetIndex]) === sourceKey);
    if (hits.length) matchedSourceRows++;
    if (hits.length > 1) ambiguousSourceRows++;
    for (const targetRow of hits) matches.push({ sourceRow: [...sourceRow], targetRow: [...targetRow], sourceEvidence: input.sourceEvidence[0] ?? 'unknown', targetEvidence: input.targetEvidence[0] ?? 'unknown' });
  }
  return { choice: input.choice, from: input.from, to: input.to, normalization: input.normalization, nSource: input.sourceRows.length, nTarget: input.targetRows.length,
    sourceNulls: input.sourceRows.filter(row => normalize(row[sourceIndex]) === null).length, targetNulls: input.targetRows.filter(row => normalize(row[targetIndex]) === null).length,
    matchedSourceRows, unmatchedSourceRows: input.sourceRows.length - matchedSourceRows, matchPairs: matches.length, ambiguousSourceRows,
    duplicateTargetValues: [...targetKeyCounts.values()].filter(count => count > 1).length, sampleBounded: true, fieldAvailability: 'AVAILABLE',
    sourceEvidenceRefs: input.sourceEvidence, targetEvidenceRefs: input.targetEvidence, matches };
}

function compareSicAndDescription(input: { cfg: any; sourceRows: readonly unknown[][]; sourceColumns: readonly string[]; targetRows: readonly unknown[][];
  targetColumns: readonly string[]; sourceEvidence: string[]; targetEvidence: string[] }): JoinAlternative {
  const si = input.sourceColumns.indexOf('sic'), sd = input.sourceColumns.indexOf('sicDescription');
  const ti = input.targetColumns.indexOf('sic_code'), td = input.targetColumns.indexOf('description');
  const base = { choice: 'SIC_CODE_AND_DESCRIPTION' as const, from: 'SEC_DATA.apple_submissions_raw.(sic,sicDescription)', to: 'COMPANY_DNS.sic_reference.(sic_code,description)',
    normalization: 'integer(sic)+literal(text)', sampleBounded: true as const, sourceEvidenceRefs: input.sourceEvidence, targetEvidenceRefs: input.targetEvidence };
  if ([si, sd, ti, td].some(index => index < 0)) return { ...base, nSource: input.sourceRows.length, nTarget: input.targetRows.length, sourceNulls: null, targetNulls: null, matchedSourceRows: null,
    unmatchedSourceRows: null, matchPairs: null, ambiguousSourceRows: null, duplicateTargetValues: null, fieldAvailability: 'NOT_PROJECTED', matches: [] };
  const codeKey = (value: unknown) => normalizeKey(value, 'integer', input.cfg.normalizationContract);
  const composite = (code: unknown, description: unknown) => {
    const normalizedCode = codeKey(code);
    return normalizedCode === null || description === null || description === undefined || String(description) === '' ? null : JSON.stringify([normalizedCode, String(description)]);
  };
  const targetCounts = new Map<string, number>();
  for (const row of input.targetRows) { const key = composite(row[ti], row[td]); if (key !== null) targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1); }
  const matches: JoinMatch[] = []; let matchedSourceRows = 0, ambiguousSourceRows = 0;
  for (const sourceRow of input.sourceRows) {
    const key = composite(sourceRow[si], sourceRow[sd]); if (key === null) continue;
    const hits = input.targetRows.filter(targetRow => composite(targetRow[ti], targetRow[td]) === key);
    if (hits.length) matchedSourceRows++;
    if (hits.length > 1) ambiguousSourceRows++;
    for (const targetRow of hits) matches.push({ sourceRow: [...sourceRow], targetRow: [...targetRow], sourceEvidence: input.sourceEvidence[0] ?? 'unknown', targetEvidence: input.targetEvidence[0] ?? 'unknown' });
  }
  return { ...base, nSource: input.sourceRows.length, nTarget: input.targetRows.length,
    sourceNulls: input.sourceRows.filter(row => composite(row[si], row[sd]) === null).length,
    targetNulls: input.targetRows.filter(row => composite(row[ti], row[td]) === null).length, matchedSourceRows,
    unmatchedSourceRows: input.sourceRows.length - matchedSourceRows, matchPairs: matches.length, ambiguousSourceRows,
    duplicateTargetValues: [...targetCounts.values()].filter(count => count > 1).length, fieldAvailability: 'AVAILABLE', matches };
}

function compareU2Alternatives(cfg: any, discovery: any, secRead?: BoundedTableRows, dnsRead?: BoundedTableRows): JoinAlternative[] {
  const facts = discovery.tables.apple_revenue_facts, submissions = discovery.tables.apple_submissions_raw, dns = discovery.tables.sic_reference;
  const factRows = facts?.sample?.rows ?? [], factColumns = facts?.columns ?? [];
  const secRows = secRead?.rows.length ? secRead.rows : submissions?.sample?.rows ?? [];
  const secColumns = secRead?.rows.length ? secRead.columns : submissions?.columns ?? [];
  const dnsRows = dnsRead?.rows.length ? dnsRead.rows : dns?.sample?.rows ?? [];
  const dnsColumns = dnsRead?.rows.length ? dnsRead.columns : dns?.columns ?? [];
  const factRef = [facts?.sample?.queryId].filter(Boolean), secRef = [secRead?.rows.length ? secRead.queryId : submissions?.sample?.queryId].filter(Boolean),
    dnsRef = [dnsRead?.rows.length ? dnsRead.queryId : dns?.sample?.queryId].filter(Boolean);
  return [
    compareBoundedRows({ choice: 'CIK_TEXT', from: 'SEC_DATA.apple_revenue_facts.cik', to: 'SEC_DATA.apple_submissions_raw.cik', normalization: 'text', sourceRows: factRows,
      sourceColumns: factColumns, targetRows: secRows, targetColumns: secColumns, sourceColumn: 'cik', targetColumn: 'cik', sourceEvidence: factRef, targetEvidence: secRef, cfg }),
    compareBoundedRows({ choice: 'CIK_NORMALIZED', from: 'SEC_DATA.apple_revenue_facts.cik', to: 'SEC_DATA.apple_submissions_raw.cik', normalization: 'integer-pad10', sourceRows: factRows,
      sourceColumns: factColumns, targetRows: secRows, targetColumns: secColumns, sourceColumn: 'cik', targetColumn: 'cik', sourceEvidence: factRef, targetEvidence: secRef, cfg }),
    compareBoundedRows({ choice: 'SIC_CODE', from: 'SEC_DATA.apple_submissions_raw.sic', to: 'COMPANY_DNS.sic_reference.sic_code', normalization: 'integer', sourceRows: secRows,
      sourceColumns: secColumns, targetRows: dnsRows, targetColumns: dnsColumns, sourceColumn: 'sic', targetColumn: 'sic_code', sourceEvidence: secRef, targetEvidence: dnsRef, cfg }),
    compareBoundedRows({ choice: 'SIC_DESCRIPTION', from: 'SEC_DATA.apple_submissions_raw.sicDescription', to: 'COMPANY_DNS.sic_reference.description', normalization: 'text', sourceRows: secRows,
      sourceColumns: secColumns, targetRows: dnsRows, targetColumns: dnsColumns, sourceColumn: 'sicDescription', targetColumn: 'description', sourceEvidence: secRef, targetEvidence: dnsRef, cfg }),
    compareSicAndDescription({ cfg, sourceRows: secRows, sourceColumns: secColumns, targetRows: dnsRows, targetColumns: dnsColumns, sourceEvidence: secRef, targetEvidence: dnsRef }),
    { choice: 'NO_JOIN', from: 'none', to: 'none', normalization: 'none', nSource: factRows.length, nTarget: dnsRows.length, sourceNulls: null, targetNulls: null,
      matchedSourceRows: null, unmatchedSourceRows: null, matchPairs: null, ambiguousSourceRows: null, duplicateTargetValues: null, sampleBounded: true, fieldAvailability: 'NOT_APPLICABLE', sourceEvidenceRefs: factRef,
      targetEvidenceRefs: dnsRef, matches: [] }
  ];
}

function runDiscoveryPhaseFor(ctx: AgentContext, saved?: any) { return runDiscoveryPhase(ctx, saved); }

async function planAndExploreU2(ctx: AgentContext, phase: DiscoveryPhase, production: any): Promise<any> {
  const { runId, cfg } = ctx, discovery = phase.discovery;
  const prefix = ctx.prefix, calls: AdaptiveModelCall[] = [];
  let plannerError: object | undefined;
  let nightshift: Nightshift | undefined;
  try { nightshift = new Nightshift(); } catch (error) { plannerError = failure(error); }
  const exploration = await runExplorationStage(ctx, phase, nightshift ? new NightshiftChooser(nightshift, runId, U2_CATALOG) : undefined, { status: 'RAN', production });
  calls.push(...exploration.calls);
  const actions: any[] = exploration.actions;
  const secRead: BoundedTableRows | undefined = exploration.reads.READ_SEC_PROFILE, dnsRead: BoundedTableRows | undefined = exploration.reads.READ_DNS_REFERENCE;
  if (nightshift && exploration.plannerError) plannerError = exploration.plannerError;
  const alternatives = compareU2Alternatives(cfg, discovery, secRead, dnsRead);
  let provisionalJoin: any = { selectedBy: 'none', status: 'NO_MODEL_DECISION', operationallyUsed: false,
    verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING', requiresHumanReview: false };
  if (nightshift) {
    const evidence = alternatives.map(({ matches, ...summary }) => ({ ...summary, sampleMatches: matches.slice(0, EXPLORATION_POLICY.sampleMatchesPerAlternative) }));
    const evidenceFor = (choices: readonly U2JoinChoice[]) => evidence.filter(item => choices.includes(item.choice));
    const identityIds: U2JoinChoice[] = [...EXPLORATION_POLICY.joinFamilies.identity];
    const dnsIds: U2JoinChoice[] = [...EXPLORATION_POLICY.joinFamilies.dns];
    const optionsFor = (ids: U2JoinChoice[]) => [...alternatives.filter(item => ids.includes(item.choice) && item.matchPairs !== null && item.matchPairs > 0).map(item => item.choice), 'NO_JOIN'];
    const identityOptions = optionsFor(identityIds), dnsOptions = optionsFor(dnsIds);
    const constraints = ['Choose only a listed option with observed match pairs or NO_JOIN.', 'A description condition may be operationally useful in this bounded task without being globally unique.',
      'Do not claim global equivalence, FK, acceptance, approval, or REVIEWED.', 'Account for duplicates and ambiguous source rows in the bounded results.'];
    const identityCall = await askU2Model(nightshift, runId, 'choose_company_identity_join', { alternatives: evidenceFor(identityIds), constraints }, identityOptions);
    calls.push(identityCall); ctx.budget.chargeTokens(identityCall.receipt?.totalTokens ?? 0);
    const dnsCall = await askU2Model(nightshift, runId, 'choose_company_dns_join', { alternatives: evidenceFor(dnsIds),
      comaOutOfScopeProposals: production.outOfScopeProposals ?? [], constraints }, dnsOptions);
    calls.push(dnsCall); ctx.budget.chargeTokens(dnsCall.receipt?.totalTokens ?? 0);
    const choiceResult = (call: AdaptiveModelCall, ids: U2JoinChoice[]) => {
      const choice = call.decisionStatus === 'VALID' && call.selected ? call.selected as U2JoinChoice : undefined;
      const metrics = alternatives.find(item => item.choice === choice);
      const usable = Boolean(choice && choice !== 'NO_JOIN' && metrics?.matchPairs);
      return { selectedBy: call.decisionStatus === 'VALID' ? 'nightshift' : 'none', choice: choice ?? null, reason: call.reason ?? null,
        status: usable ? 'PROVISIONAL_FOR_BOUNDED_TASK' : choice === 'NO_JOIN' ? 'NO_JOIN_SELECTED' : 'MODEL_DECISION_UNAVAILABLE',
        operationallyUsed: usable, verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING', requiresHumanReview: false,
        boundedMetrics: metrics ?? null, error: call.error ?? null, allowedChoices: ids };
    };
    const identityJoin = choiceResult(identityCall, identityOptions as U2JoinChoice[]);
    const dnsJoin = choiceResult(dnsCall, dnsOptions as U2JoinChoice[]);
    const used = identityJoin.operationallyUsed && dnsJoin.operationallyUsed;
    provisionalJoin = { selectedBy: 'nightshift', choice: dnsJoin.choice, identityJoin, dnsJoin, status: used ? 'PROVISIONAL_FOR_BOUNDED_TASK' : 'NO_COMPLETE_PROVISIONAL_PATH',
      operationallyUsed: used, verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING', requiresHumanReview: false,
      caveat: 'Operational choices for this task sample only; no global FK/equivalence/acceptance state is changed.' };
  } else provisionalJoin = { ...provisionalJoin, status: 'MODEL_UNAVAILABLE', error: plannerError };
  const budget = readBudget();
  const modelReceipts = calls.flatMap(call => call.receipt ? [call.receipt] : []);
  const budgetUse = { ledger: 'configured append-only application ledger', attemptsAfterPlanner: budget.consumed,
    runReceipts: modelReceipts.map(({ receiptId, provider, model, inputTokens, outputTokens, totalTokens, latencyMs, fromCache, requestedMode, routedMode, modeCoerced, predicted, winner, routingReason }) =>
      ({ receiptId, provider, model, inputTokens, outputTokens, totalTokens, latencyMs, fromCache, requestedMode, routedMode, modeCoerced, predicted, winner, routingReason })),
    runInputTokens: modelReceipts.reduce((sum, receipt) => sum + receipt.inputTokens, 0), runOutputTokens: modelReceipts.reduce((sum, receipt) => sum + receipt.outputTokens, 0),
    runTotalTokens: modelReceipts.reduce((sum, receipt) => sum + receipt.totalTokens, 0), requestedModel: nightshift?.route ?? null,
    observedModels: [...new Set(modelReceipts.map(receipt => `${receipt.provider}/${receipt.model}`))], policy: readJson('config/model-policy.json').modelPolicy };
  const result = { status: provisionalJoin.operationallyUsed ? 'ADAPTIVE_WITH_PROVISIONAL_JOIN' : 'ADAPTIVE_WITHOUT_PROVISIONAL_JOIN',
    plannerStatus: calls.every(call => call.status === 'PASS' && call.decisionStatus === 'VALID') ? 'MODEL_DECISIONS_RECORDED' : calls.length ? 'MODEL_PARTIAL_OR_FAILED' : 'MODEL_UNAVAILABLE',
    plannerError, calls, actions, alternatives, provisionalJoin, secRead, dnsRead, budgetUse };
  writeJson(prefix + 'adaptive-exploration.json', result);
  return result;
}

export function u2ProtectedArtifactPaths(): string[] {
  return [
    '.concordia/U1/claims.json', '.concordia/U1/state.json', '.concordia/U1/ledger.jsonl',
    '.concordia/U2/claims.json', '.concordia/U2/state.json', '.concordia/U2/ledger.jsonl',
    '.concordia/U3/claims.json', '.concordia/U3/state.json', '.concordia/U3/ledger.jsonl',
    'evidence/trace.jsonl'
  ].sort();
}

function captureU2ProtectedArtifacts() {
  return u2ProtectedArtifactPaths().map(file => ({ path: file, exists: fs.existsSync(path.join(ROOT, file)), ...(fs.existsSync(path.join(ROOT, file)) ? { sha256: fileSha256(file) } : {}) }));
}

async function runComaOnSnapshot(cfg: any, discovery: any, options: { executionMode?: 'LIVE' | 'REPLAY'; expectedInputHash?: string } = {}) {
  const relations = cfg.relations.filter((relation: any) => discovery.tables[relation.from.table] && discovery.tables[relation.to.table]);
  let rawOutput: ReturnType<ReturnType<typeof createInstalledComaBridge>> | undefined;
  const installedBridge = createInstalledComaBridge(path.join(ROOT, '.concordia', 'python', 'coma-valentine-1.1.0', 'Scripts', 'python.exe'), ROOT);
  const phase = await runComaPhase({ universeId: 'U2', cfg, catalog: U2_CATALOG, discovery, sourceColumns: describedColumns(discovery), relations,
    bridge: value => { rawOutput = installedBridge(value); return rawOutput; }, expectedInputHash: options.expectedInputHash, executionMode: options.executionMode ?? 'LIVE', dataOrigin: 'PUBLIC' });
  if (phase.status !== 'RAN' || !phase.input || !phase.production) throw new SafeError('U2_COMA_NOT_CONFIGURED');
  return { input: phase.input, inputHash: phase.inputHash!, rawOutput, production: phase.production };
}

const U2_COMA_RECOVERY_INPUT_HASH = '3a49787469cad83d035c0d6b5c05136bcdfd7c1ed17b33a4fb655db916988f66';
const fileSha256 = (relative: string) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, relative))).digest('hex');

/** Offline replay of the exact saved U2 schema snapshot; writes a new sidecar and never edits historical artifacts. */
export async function recoverU2ComaFromSnapshot(runId: string) {
  if (!SAFE_RUN.test(runId)) throw new SafeError('AGENT_RUN_ID_INVALID');
  const prefix = `.concordia/agent-runs/${runId}/`;
  const report = readJson<any>(prefix + 'report.json');
  if (report.universeId !== 'U2' || report.runId !== runId) throw new SafeError('AGENT_RUN_SCOPE_MISMATCH');
  if (report.coma?.inputHash !== U2_COMA_RECOVERY_INPUT_HASH) throw new SafeError('U2_COMA_RECOVERY_HISTORIC_INPUT_HASH_MISMATCH');
  const discovery = readJson<any>(prefix + 'discovery.json');
  const cfg = universeConfig('U2');
  const replay = await runComaOnSnapshot(cfg, discovery, { executionMode: 'REPLAY', expectedInputHash: U2_COMA_RECOVERY_INPUT_HASH });
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const sidecarPath = `${prefix}coma-recovery-${timestamp}.json`;
  const providerPath = 'src/discovery/coma-provider.ts', bridgePath = 'scripts/coma/bridge.py';
  const pythonPath = '.concordia/python/coma-valentine-1.1.0/Scripts/python.exe';
  const sidecar = {
    schemaVersion: 1, recoveryId: `coma-recovery-${timestamp}`, createdAt: new Date().toISOString(), originalRunId: runId,
    recoveryStatus: replay.rawOutput ? 'REPRODUCED_FROM_SNAPSHOT' : 'MATCHER_DID_NOT_REPRODUCE',
    provenance: { inputExecutionMode: 'REPLAY', matcherExecutionMode: 'LOCAL', dataOrigin: 'PUBLIC', snapshotPath: prefix + 'discovery.json', historicalRawOutputAvailable: false,
      attribution: 'This result is a new local matcher replay over the saved discovery snapshot; it is not the missing historical raw output or a LIVE verification.' },
    hashes: { expectedInputHash: U2_COMA_RECOVERY_INPUT_HASH, replayInputHash: replay.inputHash, configHash: sha(cfg), snapshotSha256: fileSha256(prefix + 'discovery.json'),
      providerSha256: fileSha256(providerPath), bridgeSha256: fileSha256(bridgePath), pythonExecutableSha256: fileSha256(pythonPath),
      rawOutputSha256: replay.rawOutput ? sha(replay.rawOutput) : null },
    versions: { node: process.version, provider: 'valentine.coma@1.1.0', method: 'COMA', rawOutputVersion: replay.rawOutput?.version ?? null,
      bridge: 'scripts/coma/bridge.py', pythonExecutable: pythonPath },
    input: replay.input, rawOutput: replay.rawOutput ?? null, production: replay.production,
    outOfScopeProposals: replay.production.outOfScopeProposals ?? [], limitations: replay.production.limitations
  };
  fs.writeFileSync(path.join(ROOT, sidecarPath), JSON.stringify(sidecar, null, 2) + '\n', { flag: 'wx' });
  return { status: sidecar.recoveryStatus, runId, sidecarPath, inputHash: replay.inputHash, outOfScopeProposals: sidecar.outOfScopeProposals,
    providerState: replay.production.providerStates, errors: replay.production.errors };
}

function appendJsonLine(relative: string, value: unknown) {
  const file = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n', { flag: 'a' });
}

function continueRun(runId: string, decision?: string, actor?: string) {
  if (!SAFE_RUN.test(runId)) throw new SafeError('AGENT_RUN_ID_INVALID');
  const relative = `.concordia/agent-runs/${runId}/report.json`;
  const report = readJson<any>(relative);
  if (report.universeId !== 'U2' || report.runId !== runId) throw new SafeError('AGENT_RUN_SCOPE_MISMATCH');
  // Pin every continuation event to this validated run before writing any trace data.
  setTraceRun(runId);
  // The initial SIC sample is bounded and may not contain the company's code.
  // Attribute the description to the exact COMPANY_DNS lookup already recorded.
  const profile = report.profile?.[0];
  if (profile?.sectorReference?.queryId && profile.provenance) {
    profile.provenance.sectorDescription = profile.sectorReference.queryId;
    writeJson(relative, report);
  }
  const reviewHistory = `.concordia/agent-runs/${runId}/review.jsonl`;
  if (report.review.status === 'PENDING' && !fs.existsSync(path.join(ROOT, reviewHistory))) appendJsonLine(reviewHistory, {
    utc: new Date().toISOString(), runId, event: 'review_requested', actor: 'concordia-agent-u2', status: 'PENDING',
    question: report.review.question, alternatives: report.review.alternatives
  });
  if (decision) {
    if (!['keep_company_scope', 'request_multi_company'].includes(decision) || !actor?.trim()) throw new SafeError('AGENT_REVIEW_DECISION_INVALID');
    const event = { utc: new Date().toISOString(), runId, actor: actor.trim(), decision, note: 'Human continuation choice recorded; source evidence is unchanged.' };
    appendJsonLine(`.concordia/agent-runs/${runId}/review.jsonl`, event);
    report.review = { ...report.review, status: 'DECIDED', decision, actor: actor.trim(), decidedAt: event.utc };
    writeJson(relative, report);
  }
  const memory = new HMEM({ actor: 'concordia-agent-u2', persistDir: path.join(ROOT, '.concordia', 'agent-runs', runId, 'memory') });
  const recalled = memory.query(`U2 company profile ${report.companyScope}`, { topN: 5, threshold: 0 });
  const uniqueMemories = [...new Map(recalled.memories.map(item => [item.memory.content, item.memory.id])).values()];
  const joinChoice = report.adaptiveExploration?.provisionalJoin;
  const adaptiveRecall = joinChoice ? memory.query(`U2 provisional operational union ${joinChoice.identityJoin?.choice ?? 'none'} ${joinChoice.dnsJoin?.choice ?? joinChoice.choice ?? 'none'}`, { topN: 5, threshold: 0 }) : undefined;
  const recalledAdaptiveMemoryIds = [...new Set(adaptiveRecall?.memories.map(item => item.memory.id) ?? [])];
  const result = { status: report.review.status === 'PENDING' ? 'REVIEW_PENDING' : 'CONTINUED', runId, review: report.review,
    recalledMemoryIds: [...new Set([...uniqueMemories, ...recalledAdaptiveMemoryIds])], recalledAdaptiveMemoryIds, sourceEvidenceReused: true, freshReads: 0,
    continuationCommand: `npm run agent-u2 -- continue --run-id ${runId} --decide keep_company_scope --actor <human-name>` };
  trace({ kind: 'agent-u2-continuation', ...result });
  console.log(JSON.stringify(result));
  return result;
}

async function enrichCompletedRun(runId: string) {
  if (!SAFE_RUN.test(runId)) throw new SafeError('AGENT_RUN_ID_INVALID');
  const prefix = `.concordia/agent-runs/${runId}/`;
  const report = readJson<any>(prefix + 'report.json');
  const discovery = readJson<any>(prefix + 'discovery.json');
  const profile = report.profile?.[0];
  if (!profile || !/^\d+$/.test(String(profile.cik))) throw new SafeError('AGENT_PROFILE_CIK_UNAVAILABLE');
  const cfg = universeConfig('U2'), spec = cfg.tables.apple_submissions_raw;
  const available = describedColumns(discovery).apple_submissions_raw.map(column => column.name);
  const fields = SAFE_OPTIONAL.apple_submissions_raw.filter(field => available.includes(field) && !FORBIDDEN_COLUMN.test(field));
  if (!fields.length) throw new SafeError('AGENT_OPTIONAL_FIELDS_UNAVAILABLE');
  const runDirectory = path.join(ROOT, '.concordia', 'agent-runs', runId);
  setTraceRun(runId);
  const client = new Zetaris();
  const cik = String(profile.cik), cikVariants = [...new Set([cik, cik.padStart(10, '0')])];
  const cikFilter = cikVariants.map(value => `'${value}'`).join(', ');
  const optionalPath = path.join(runDirectory, 'optional-data.json');
  let optionalRecord: any;
  if (fs.existsSync(optionalPath)) {
    const saved = readJson<any>(prefix + 'optional-data.json');
    if (saved.rows?.length) optionalRecord = saved;
  }
  if (!optionalRecord) {
    const result = await client.runSql(`SELECT ${fields.map(field => `\`${identifier(field)}\``).join(', ')} FROM ${identifier(spec.db)}.${identifier(spec.physicalTable)} WHERE ${identifier('cik')} IN (${cikFilter}) LIMIT 1`, 1);
    optionalRecord = { source: `${spec.db}.${spec.physicalTable}`, columns: fields, rows: result.rows, queryId: result.queryId, requestId: result.requestId, executionMode: 'LIVE', dataOrigin: 'PUBLIC', utc: result.utc };
    writeJson(prefix + 'optional-data.json', optionalRecord);
  }
  const values = optionalRecord.rows[0] ?? [];
  const queryId = optionalRecord.queryId, requestId = optionalRecord.requestId;
  const mapped = Object.fromEntries(fields.map((field, index) => [field, values[index] ?? null]));
  if (mapped.name) profile.legalName = { value: mapped.name, sourceField: 'name', source: `${spec.db}.${spec.physicalTable}`, queryId, requestId };
  if (mapped.sicDescription) profile.sectorDescription = mapped.sicDescription;
  profile.optionalProvenance = { source: `${spec.db}.${spec.physicalTable}`, queryId, requestId, fields };
  report.optionalFields = { ...report.optionalFields, apple_submissions_raw: { columns: fields, queryId, requestId, rows: optionalRecord.rows.length, values: mapped } };
  report.provenance.optionalFieldRead = { source: `${spec.db}.${spec.physicalTable}`, queryId, requestId, columns: fields, limit: 1 };
  const sic = String(profile.sic), sicVariants = [...new Set([sic, sic.replace(/\.0$/, '')])];
  const sicSpec = cfg.tables.sic_reference;
  const dnsPath = path.join(runDirectory, 'company-dns-data.json');
  let dnsRecord: any;
  if (fs.existsSync(dnsPath)) dnsRecord = readJson<any>(prefix + 'company-dns-data.json');
  else {
    const dns = await client.runSql(`SELECT sic_code, description FROM (${sourceQuery(sicSpec)}) concordia_source WHERE sic_code IN (${sicVariants.map(value => `'${value}'`).join(', ')}) LIMIT 1`, 1);
    dnsRecord = { source: `${sicSpec.db}.${sicSpec.physicalTable}`, columns: ['sic_code', 'description'], rows: dns.rows, queryId: dns.queryId, requestId: dns.requestId, executionMode: 'LIVE', dataOrigin: 'PUBLIC', utc: dns.utc };
    writeJson(prefix + 'company-dns-data.json', dnsRecord);
  }
  const dnsRow = dnsRecord.rows?.[0];
  const referenceDescription = dnsRow?.[1] ?? null;
  profile.sectorReference = { sicCode: dnsRow?.[0] ?? null, description: referenceDescription, source: dnsRecord.source, queryId: dnsRecord.queryId, requestId: dnsRecord.requestId,
    descriptionMatchesSecFiling: typeof referenceDescription === 'string' && typeof mapped.sicDescription === 'string' ? referenceDescription.trim().toLowerCase() === mapped.sicDescription.trim().toLowerCase() : null };
  report.provenance.companyDnsLookup = { source: dnsRecord.source, queryId: dnsRecord.queryId, requestId: dnsRecord.requestId, sic: profile.sic, limit: 1 };
  const comaReplay = await runComaOnSnapshot(cfg, discovery);
  report.coma = { ...report.coma, state: comaReplay.production.providerStates, provider: comaReplay.production.providers[0],
    candidates: comaReplay.production.candidates.map(candidate => ({ candidateId: candidate.candidateId, status: candidate.status, provenance: candidate.provenance })),
    outOfScopeProposals: comaReplay.production.outOfScopeProposals ?? [],
    errors: comaReplay.production.errors, abstentions: comaReplay.production.abstentions, limitations: comaReplay.production.limitations,
    replayedFromSavedSchemaOnly: true, inputHash: comaReplay.inputHash };
  const critic = await criticize('U2', { relationIds: (report.relationEvidence ?? []).map((item: any) => item.relationId) }, {
    config: cfg, relations: { relations: report.relationEvidence ?? [] }, inventory: discovery, thresholds: readJson('config/thresholds.json'), client, persist: false
  });
  report.critic = { status: 'EVALUATED', eligibleCounterprobes: critic.results.length,
    summary: { confirmed: critic.confirmed, degraded: critic.degraded, insufficient: critic.insufficient, errors: critic.errors, skipped: critic.skipped },
    reason: critic.results.length ? 'Critic evaluated eligible sustained relations.' : 'No relation had a SOSTENIDA decision, so the critic issued no counterprobe.' };
  writeJson(prefix + 'report.json', report);
  appendJsonLine(prefix + 'enrichments.jsonl', { utc: new Date().toISOString(), runId, queryId, requestId, source: `${spec.db}.${spec.physicalTable}`, columns: fields, companyDnsQueryId: dnsRecord.queryId });
  if (mapped.name || mapped.sicDescription) {
    const memory = new HMEM({ actor: 'concordia-agent-u2', persistDir: path.join(runDirectory, 'memory') });
    const content = `U2 company identification from SEC_DATA: ${String(mapped.name ?? 'name not observed')}; SIC description: ${String(mapped.sicDescription ?? 'not observed')}.`;
    if (!memory.query(content, { topN: 5, threshold: 0 }).memories.some(item => item.memory.content === content)) memory.add({ content, type: 'factual', layer: 'working', source: `${spec.db}.${spec.physicalTable} SELECT`, confidence: 0.9,
      missionId: runId, goalRunId: runId, tags: ['U2', 'company-brief', 'SEC_DATA'], provenance: { origin: 'plan_completion', learnedAt: Date.now(), label: 'Bounded optional-field read', refs: [`${spec.db}.${spec.physicalTable}`, queryId] } });
  }
  const output = { status: 'ENRICHED_FROM_LIVE_SOURCE', runId, legalNameObserved: Boolean(profile.legalName), sectorDescriptionObserved: Boolean(profile.sectorDescription), sectorReferenceObserved: Boolean(profile.sectorReference.sicCode), reportPath: prefix + 'report.json', queryId, requestId };
  trace({ kind: 'agent-u2-critic', ...report.critic });
  trace({ kind: 'agent-u2-enrichment', ...output });
  console.log(JSON.stringify(output));
  return output;
}

export async function runU2Agent(options: { runId: string; task: string; continueRunId?: string; resumeAdaptive?: boolean; enrich?: boolean; resume?: boolean; decision?: string; actor?: string }) {
  if (options.continueRunId && options.resumeAdaptive) return resumeAdaptiveDnsChoice(options.continueRunId);
  if (options.continueRunId) return continueRun(options.continueRunId, options.decision, options.actor);
  if (options.enrich) { loadLocalEnv(); return enrichCompletedRun(options.runId); }
  if (!SAFE_RUN.test(options.runId)) throw new SafeError('AGENT_RUN_ID_INVALID');
  const runDirectory = path.join(ROOT, '.concordia', 'agent-runs', options.runId);
  const discoveryPath = path.join(runDirectory, 'discovery.json');
  if (fs.existsSync(runDirectory) && (!options.resume || !fs.existsSync(discoveryPath) || fs.existsSync(path.join(runDirectory, 'report.json')))) throw new SafeError('AGENT_RUN_ALREADY_EXISTS');
  fs.mkdirSync(runDirectory, { recursive: true });
  setTraceRun(options.runId);
  loadLocalEnv();
  const protectedBefore = captureU2ProtectedArtifacts();
  writeJson(`.concordia/agent-runs/${options.runId}/protection-before.json`, protectedBefore);
  const budgetBefore = readBudget(), priorBudgetPrefixHash = sha(budgetBefore.attempts);
  const cfg = universeConfig('U2'), client = new Zetaris();
  // Same engine context the generic agent uses: registry bounds, budgeted client, catalog.
  const ctx = prepareAgentContext('U2', options.runId, { client, executionMode: 'LIVE' });
  const savedDiscovery = options.resume ? readJson<any>(`.concordia/agent-runs/${options.runId}/discovery.json`) : undefined;
  const phase = await runDiscoveryPhaseFor(ctx, savedDiscovery);
  const discovery = phase.discovery, enabledRelations = phase.relations, sourceColumns = phase.sourceColumns;
  if (!options.resume) writeJson(`.concordia/agent-runs/${options.runId}/discovery.json`, discovery);

  // Optional profile reads are selected by the bounded model planner below; parameters stay executor-derived.
  const optionalData: Record<string, any> = {};

  // COMA receives only schema metadata from the actual U2 reads, scoped to configured relations.
  const comaPhase = await runComaPhase({ universeId: 'U2', cfg, catalog: U2_CATALOG, discovery, sourceColumns, relations: enabledRelations,
    bridge: createInstalledComaBridge(path.join(ROOT, '.concordia', 'python', 'coma-valentine-1.1.0', 'Scripts', 'python.exe'), ROOT), executionMode: 'LIVE', dataOrigin: 'PUBLIC' });
  if (comaPhase.status !== 'RAN' || !comaPhase.production) throw new SafeError('U2_COMA_NOT_CONFIGURED');
  const production = comaPhase.production;

  const adaptive = await planAndExploreU2(ctx, phase, production);
  const budgetAfter = readBudget();
  adaptive.budgetUse = { ...adaptive.budgetUse, attemptsBefore: budgetBefore.consumed, attemptsAfter: budgetAfter.consumed,
    attemptsAdded: budgetAfter.consumed - budgetBefore.consumed, priorAttemptCount: budgetBefore.attempts.length,
    priorAttemptsPrefixSha256: priorBudgetPrefixHash, priorAttemptsPreserved: sha(budgetAfter.attempts.slice(0, budgetBefore.attempts.length)) === priorBudgetPrefixHash };
  if (adaptive.secRead) optionalData.apple_submissions_raw = adaptive.secRead;
  const comparedAlternatives = adaptive.alternatives as JoinAlternative[];

  // Select configured probes only after discovery proved both endpoint reads completed.
  const probeStage = await runProbeStage(ctx, phase, undefined, () => new Date().toISOString());
  if (probeStage.error) throw new SafeError(String((probeStage.error as any).code ?? 'U2_PROBE_FAILED'));
  const probeRelations = probeStage.relations;
  const policy = relationPolicyFromConfig(readJson('config/thresholds.json'));
  const comaDecisions = production.contributions.map(item => ({ candidateId: item.candidate.candidateId, decision: evaluateRelation(item.candidate.relationDraft, [], policy), diagnostics: item.diagnostics }));
  const facts: any[] = [];
  const factsTable = discovery.tables.apple_revenue_facts, factsRows = factsTable?.sample?.rows ?? [], factsColumns = factsTable?.columns ?? [];
  const submissions = discovery.tables.apple_submissions_raw, sicTable = discovery.tables.sic_reference;
  const submissionRows: unknown[][] = adaptive.secRead?.rows.length ? adaptive.secRead.rows : submissions?.sample?.rows ?? [];
  const submissionColumns: string[] = adaptive.secRead?.rows.length ? adaptive.secRead.columns : submissions?.columns ?? [];
  const sicRows: unknown[][] = adaptive.dnsRead?.rows.length ? adaptive.dnsRead.rows : sicTable?.sample?.rows ?? [];
  const sicColumns: string[] = adaptive.dnsRead?.rows.length ? adaptive.dnsRead.columns : sicTable?.columns ?? [];
  const secEvidenceId = adaptive.secRead?.rows.length ? adaptive.secRead.queryId : submissions?.sample?.queryId;
  const dnsEvidenceId = adaptive.dnsRead?.rows.length ? adaptive.dnsRead.queryId : sicTable?.sample?.queryId;
  const selectedChoice = adaptive.provisionalJoin.choice as U2JoinChoice | undefined;
  const identityChoice = adaptive.provisionalJoin.identityJoin?.choice as U2JoinChoice | undefined;
  const sicMode = cfg.relations.find((relation: any) => relation.id === 'company_sic_reference')?.normalization ?? 'integer';
  for (const row of factsRows.slice(0, 20)) {
    const cikIndex = factsColumns.indexOf('cik'), cik = cikIndex >= 0 ? row[cikIndex] : null;
    const identityNormalization = identityChoice === 'CIK_NORMALIZED' ? 'integer-pad10' : 'text';
    const matchingSubmission = identityChoice && identityChoice !== 'NO_JOIN' ? submissionRows.find((item: unknown[]) =>
      normalizeKey(item[submissionColumns.indexOf('cik')], identityNormalization, cfg.normalizationContract) ===
      normalizeKey(cik, identityNormalization, cfg.normalizationContract)) : undefined;
    const sicIndex = submissionColumns.indexOf('sic'), sic = matchingSubmission && sicIndex >= 0 ? matchingSubmission[sicIndex] : null;
    const sicKey = normalizeKey(sic, sicMode, cfg.normalizationContract);
    const codeMatch = sicKey === null ? undefined : sicRows.find(item => normalizeKey(item[sicColumns.indexOf('sic_code')], sicMode, cfg.normalizationContract) === sicKey);
    const descriptionIndex = submissionColumns.indexOf('sicDescription'), submittedDescription = matchingSubmission && descriptionIndex >= 0 ? matchingSubmission[descriptionIndex] : null;
    let chosenDnsRow: unknown[] | undefined;
    if (selectedChoice === 'SIC_CODE') chosenDnsRow = codeMatch;
    if (selectedChoice === 'SIC_DESCRIPTION' && typeof submittedDescription === 'string') chosenDnsRow = sicRows.find(item => item[sicColumns.indexOf('description')] === submittedDescription);
    if (selectedChoice === 'SIC_CODE_AND_DESCRIPTION' && typeof submittedDescription === 'string') chosenDnsRow = sicRows.find(item =>
      normalizeKey(item[sicColumns.indexOf('sic_code')], sicMode, cfg.normalizationContract) === sicKey && item[sicColumns.indexOf('description')] === submittedDescription);
    const dnsCodeIndex = sicColumns.indexOf('sic_code'), dnsDescriptionIndex = sicColumns.indexOf('description');
    const referenceDescription = chosenDnsRow && dnsDescriptionIndex >= 0 ? chosenDnsRow[dnsDescriptionIndex] : null;
    const fact: any = { identification: { value: 'U2 configured company evidence', basis: 'bounded source rows; no identity asserted beyond observed keys' }, cik,
      sic: sic ?? null, sectorDescription: submittedDescription ?? referenceDescription ?? null,
      provenance: { cik: factsTable?.sample?.queryId, secCompany: secEvidenceId, sicReference: dnsEvidenceId,
        selectedOperationalJoin: { identity: identityChoice ?? null, sicReference: selectedChoice ?? null } } };
    if (matchingSubmission) {
      const nameIndex = submissionColumns.indexOf('name'), name = nameIndex >= 0 ? matchingSubmission[nameIndex] : null;
      if (typeof name === 'string' && name) fact.legalName = { value: name, sourceField: 'name', source: 'SEC_DATA.apple_submissions_raw', queryId: secEvidenceId, requestId: adaptive.secRead?.requestId ?? submissions?.sample?.requestId };
      if (typeof submittedDescription === 'string') fact.sectorDescription = submittedDescription;
      fact.optionalProvenance = { source: 'SEC_DATA.apple_submissions_raw', queryId: secEvidenceId, requestId: adaptive.secRead?.requestId ?? submissions?.sample?.requestId,
        fields: submissionColumns.filter(column => SAFE_OPTIONAL.apple_submissions_raw.includes(column)) };
    }
    if (chosenDnsRow) fact.sectorReference = { sicCode: chosenDnsRow[dnsCodeIndex] ?? null, description: referenceDescription, source: `${cfg.tables.sic_reference.db}.${cfg.tables.sic_reference.physicalTable}`,
      queryId: dnsEvidenceId, requestId: adaptive.dnsRead?.requestId ?? sicTable?.sample?.requestId,
      descriptionMatchesSecFiling: typeof referenceDescription === 'string' && typeof submittedDescription === 'string' ? referenceDescription === submittedDescription : null,
      joinChoice: selectedChoice && selectedChoice !== 'NO_JOIN' ? selectedChoice : 'configured SIC lookup', status: selectedChoice && selectedChoice !== 'NO_JOIN' ? 'PROVISIONAL' : 'OBSERVED_REFERENCE' };
    facts.push(fact);
  }
  const criticStage = await runCriticStage(ctx, phase, probeStage);
  if (criticStage.status === 'ERROR') throw new SafeError(String((criticStage.error as any).code ?? 'U2_CRITIC_FAILED'));
  const critic = criticStage.status === 'EVALUATED' ? criticStage.summary : { confirmed: 0, degraded: 0, insufficient: 0, errors: 0, skipped: 0 };
  const criticEligible = criticStage.status === 'EVALUATED' ? criticStage.eligible : 0;
  const review = { status: 'PENDING', question: '¿Mantener la ficha limitada al alcance de una compañía configurada o autorizar más adelante un alcance multiempresa?',
    alternatives: ['keep_company_scope', 'request_multi_company'], actor: null, decision: null, sourceEvidenceChangedByDecision: false };
  const report = { schemaVersion: 1, runId: options.runId, utc: new Date().toISOString(), universeId: 'U2', task: options.task,
    executionMode: 'LIVE', dataOrigin: 'PUBLIC', companyScope: cfg.scope, companyNameStatus: facts.some(fact => fact.legalName) ? 'SOURCE_FIELD_READ' : 'SCOPE_LABEL_ONLY',
    actionPlan: [
      { action: 'discover_configured_u2_tables', reason: 'Task requests a company brief; U2 config scopes SEC_DATA and COMPANY_DNS reads.' , status: 'DONE', tables: Object.keys(discovery.tables) },
      { action: 'run_schema_only_coma', reason: 'Compare configured relation endpoints using current per-table database metadata.', status: production.providerStates[0]?.status ?? 'UNKNOWN' },
      ...adaptive.actions.map((item: any) => ({ action: item.action, reason: item.reason, status: item.execution, observation: item.observation ?? null, error: item.error ?? null })),
      { action: 'probe_configured_relations', reason: 'Discovery returned both endpoint tables; run only the configured allowlisted key probes.', status: 'DONE', relations: probeRelations.map((item: any) => item.relationId ?? item.relation?.id) }
    ],
    profile: facts, relationEvidence: probeRelations.map((item: any) => { const evidence = item.evidence ?? item; return { relationId: item.relationId ?? item.relation?.id, verdict: item.verdict ?? item.decision?.verdict, reasonCodes: item.reasonCodes ?? item.decision?.reasonCodes,
      overlap: evidence.overlap, freshness: item.freshness ?? evidence.freshness, queries: (evidence.queries ?? []).map((query: any) => ({ queryId: query.queryId, requestId: query.requestId, rows: query.rows.length, sql: query.sql })) }; }),
    coma: { provider: production.providers[0], state: production.providerStates, candidates: production.candidates.map(candidate => ({ candidateId: candidate.candidateId, status: candidate.status, provenance: candidate.provenance })), outOfScopeProposals: production.outOfScopeProposals ?? [],
      errors: production.errors, abstentions: production.abstentions, decisions: comaDecisions.map(item => ({ candidateId: item.candidateId, verdict: item.decision.verdict, reasonCodes: item.decision.reasonCodes, diagnostics: item.diagnostics })), limitations: production.limitations },
    optionalFields: Object.fromEntries(Object.entries(optionalData).map(([name, data]: [string, any]) => [name, { columns: data.columns, queryId: data.queryId, requestId: data.requestId, rows: data.rows.length }])),
    adaptiveExploration: { ...adaptive, requestedModel: adaptive.budgetUse.requestedModel,
      usage: { requestedModel: adaptive.budgetUse.requestedModel, observedModels: adaptive.budgetUse.observedModels,
        receipts: adaptive.budgetUse.runReceipts, inputTokens: adaptive.budgetUse.runInputTokens, outputTokens: adaptive.budgetUse.runOutputTokens,
        totalTokens: adaptive.budgetUse.runTotalTokens, ledger: adaptive.budgetUse },
      joins: { choice: adaptive.provisionalJoin, alternatives: comparedAlternatives },
      outOfScopeProposalsObserved: production.outOfScopeProposals ?? [],
      limitations: ['The model selected bounded action IDs only; executor built all SQL and values from the current U2 schema and sampled keys.',
        'Alternatives are compared over captured rows and targeted bounded reads; metrics do not claim table-wide uniqueness, completeness, or stability.',
        'A provisional operational join remains UNKNOWN/PENDING and is not accepted, reviewed, or promoted to a global key.'] },
    critic: { status: 'EVALUATED', eligibleCounterprobes: criticEligible,
      summary: { confirmed: critic.confirmed, degraded: critic.degraded, insufficient: critic.insufficient, errors: critic.errors, skipped: critic.skipped },
      reason: criticEligible ? 'Critic evaluated eligible sustained relations.' : 'No relation had a SOSTENIDA decision, so the critic issued no counterprobe.' },
    review, continuation: { required: true, command: `npm run agent-u2 -- continue --run-id ${options.runId}` },
    provenance: { discoveryTables: Object.fromEntries(Object.entries<any>(discovery.tables).map(([name, table]) => [name, { database: cfg.tables[name].db, table: cfg.tables[name].physicalTable, describeRequestId: table.sourceMetadata.requestId, describeQueryId: table.sourceMetadata.queryId, sampleRequestId: table.sample.requestId, sampleQueryId: table.sample.queryId, sampleRows: table.sample.rows.length }])),
      runScopedTrace: `.concordia/agent-runs/${options.runId}/trace.jsonl`, freshnessScope: 'recorded through shared freshness history per U2 relation' },
    limitations: ['U2 is a one-company configured sample; no multi-company coverage claim.', 'COMA scores are candidate diagnostics only; semantic verdicts remain governed by the common deterministic evaluator.',
      'The chosen union is operational and provisional for this task; semantic verification remains UNKNOWN/PENDING and no global key is declared.',
      'No revenue or period is reported unless a named optional field was present in DESCRIBE and read.']
  };
  writeJson(`.concordia/agent-runs/${options.runId}/report.json`, report);
  const memory = new HMEM({ actor: 'concordia-agent-u2', persistDir: path.join(runDirectory, 'memory') });
  const memoryContent = `U2 company profile ${cfg.scope}. Run ${options.runId}; profile contains ${facts.length} bounded sample record(s) with SEC_DATA and COMPANY_DNS provenance.`;
  const memoryRecord = memory.query(memoryContent, { topN: 5, threshold: 0 }).memories.find(item => item.memory.content === memoryContent)?.memory ?? memory.add({ content: memoryContent, type: 'factual', layer: 'working', source: 'U2 live company brief', confidence: 0.8,
    missionId: options.runId, goalRunId: options.runId, tags: ['U2', 'company-brief', 'live'], provenance: { origin: 'plan_completion', learnedAt: Date.now(), label: 'U2 agent run report', refs: [`.concordia/agent-runs/${options.runId}/report.json`] } });
  const provisionalContent = `U2 provisional operational union ${adaptive.provisionalJoin.identityJoin?.choice ?? 'none'} ${adaptive.provisionalJoin.dnsJoin?.choice ?? adaptive.provisionalJoin.choice ?? 'none'}; run ${options.runId}; status UNKNOWN/PENDING; bounded alternatives and evidence refs are in report.json. Do not treat as an accepted or global key.`;
  const provisionalMemory = memory.query(provisionalContent, { topN: 5, threshold: 0 }).memories.find(item => item.memory.content === provisionalContent)?.memory ?? memory.add({ content: provisionalContent,
    type: 'factual', layer: 'working', source: `U2 adaptive bounded exploration ${options.runId}`, confidence: 0.6, missionId: options.runId, goalRunId: options.runId,
    tags: ['U2', 'provisional-join', 'unknown-pending', 'adaptive-exploration'], provenance: { origin: 'plan_completion', learnedAt: Date.now(), label: 'Bounded operational join choice, not adjudication',
      refs: [`.concordia/agent-runs/${options.runId}/report.json`, ...comparedAlternatives.flatMap(item => [...item.sourceEvidenceRefs, ...item.targetEvidenceRefs])] } });
  const protectedAfter = captureU2ProtectedArtifacts();
  const protectedBeforeByPath = new Map(protectedBefore.map(item => [item.path, item.sha256 ?? null]));
  const protectedUnchanged = protectedAfter.every(item => protectedBeforeByPath.get(item.path) === (item.sha256 ?? null)) && protectedAfter.length === protectedBefore.length;
  writeJson(`.concordia/agent-runs/${options.runId}/protection-after.json`, protectedAfter);
  (report as any).integrity = { protectedArtifactCount: protectedBefore.length, protectedArtifactsUnchanged: protectedUnchanged,
    before: `.concordia/agent-runs/${options.runId}/protection-before.json`, after: `.concordia/agent-runs/${options.runId}/protection-after.json`,
    budgetPrefixPreserved: adaptive.budgetUse.priorAttemptsPreserved, budgetAttemptsBefore: budgetBefore.consumed, budgetAttemptsAfter: budgetAfter.consumed };
  (report as any).memory = { profileMemoryId: memoryRecord.id, provisionalJoinMemoryId: provisionalMemory.id, scope: 'run-local HMEM only; original memory directories untouched' };
  writeJson(`.concordia/agent-runs/${options.runId}/report.json`, report);
  const result = { status: 'COMPLETED_WITH_REVIEW_PENDING', runId: options.runId, reportPath: `.concordia/agent-runs/${options.runId}/report.json`, memoryId: memoryRecord.id,
    provisionalJoinMemoryId: provisionalMemory.id, adaptiveStatus: adaptive.status, provisionalJoin: adaptive.provisionalJoin.choice ?? null,
    tablesRead: Object.keys(discovery.tables), relationCount: probeRelations.length, comaStatus: production.providerStates[0]?.status ?? 'UNKNOWN', profileRecords: facts.length,
    review, continuation: report.continuation, trace: `.concordia/agent-runs/${options.runId}/trace.jsonl` };
  trace({ kind: 'agent-u2-complete', ...result });
  console.log(JSON.stringify(result));
  return result;
}
