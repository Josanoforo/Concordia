import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Zetaris, identifier } from '../clients/zetaris.ts';
import { readJson, writeJson, ROOT, trace, setTraceRun, traceFileForRun, failure } from '../runtime.ts';
import { normalizeKey, quotedValues, type NormalizationMode } from '../universe.ts';
import { sourceQuery } from '../universe-pipeline.ts';
import { writeRelations } from '../probe/verdicts.ts';
import type { DataOrigin, Decision, EvidenceBundle, EvidenceObservation, RelationContract } from '../contracts/types.ts';
import { validateEvidenceBundle, validateRelationContract } from '../contracts/validate.ts';
import { evaluateRelation, type RelationPolicy } from '../relations/decision.ts';
import { relationPolicyFromConfig } from '../relations/policy.ts';
import { addSampleQualitySignals, executeProbe, planProbe, type ProbeAdapter, type ProbePlan } from '../relations/probes.ts';
import { ZetarisProbeAdapter, zetarisTableSpecs } from '../relations/adapters/zetaris.ts';

export type CriticStatus = 'CONFIRMED' | 'DEGRADED' | 'INSUFFICIENT' | 'ERROR' | 'SKIPPED';
export interface TypedCriticOutcome {
  status: CriticStatus;
  classification?: 'REPEATED' | 'BASELINE_UNAVAILABLE' | 'NOVEL_SUPPORT' | 'COUNTEREXAMPLE';
  reason: string;
  baseDecision?: Decision;
  decision?: Decision;
  evidence?: EvidenceBundle;
  novelty?: { sourceTuples: number; newSourceTuples: number; targetTuples: number; newTargetTuples: number; removedTargetTuples: number; newlySupportedTuples: number };
  counterprobe?: Record<string, unknown>;
  transportFailures?: { sourceRef?: string; code: string; http?: number; retryAfter?: string; requestId?: string }[];
}

const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))) : item);
const tupleToken = (tuple: readonly unknown[]) => canonical(tuple.map(value => [value === null ? 'null' : typeof value, value]));
function normalizedTupleToken(contract: RelationContract, tuple: readonly unknown[]): string | undefined {
  if (tuple.length !== contract.normalization.length) return undefined;
  const normalized: string[] = [];
  for (let index = 0; index < tuple.length; index++) {
    const component = contract.normalization[index], operation = knownValue(component?.operation);
    if (!['text', 'integer', 'integer-pad10'].includes(operation) || knownValue(component?.lossless) !== true
      || typeof knownValue(component?.version) !== 'string' || typeof knownValue(component?.adapterCapability) !== 'string') return undefined;
    const value = normalizeKey(tuple[index], operation as NormalizationMode);
    if (value === null) return undefined;
    normalized.push(value);
  }
  return canonical(normalized);
}
const uniqueTuples = (tuples: readonly unknown[][]) => [...new Map(tuples.map(tuple => [tupleToken(tuple), tuple])).values()];
const completeBundle = (bundle: EvidenceBundle) => bundle.completeness === 'COMPLETE_FOR_SCOPE'
  && bundle.observations.length > 0
  && bundle.observations.every(observation => observation.transportStatus === 'OK' && observation.truncated === false);
const knownValue = (value: any) => value?.state === 'KNOWN' ? value.value : undefined;
function evidenceIdentities(bundle: EvidenceBundle): Set<string> {
  const identities = new Set<string>();
  for (const observation of bundle.observations) {
    identities.add(`observation:${observation.sourceRef}:${observation.observationId}`);
    const requestId = knownValue(observation.requestId);
    if (requestId !== undefined) identities.add(`request:${observation.sourceRef}:${requestId}`);
  }
  return identities;
}
function reusesEvidenceIdentity(candidate: EvidenceBundle, prior: readonly EvidenceBundle[]): boolean {
  const identities = new Set(prior.flatMap(bundle => [...evidenceIdentities(bundle)]));
  return [...evidenceIdentities(candidate)].some(identity => identities.has(identity));
}

function endpointTuples(bundle: EvidenceBundle, endpoint: RelationContract['from']): { tuples: unknown[][]; issue?: string } {
  const observations = bundle.observations.filter(observation => observation.type === 'KEY_MEMBERSHIP' && observation.sourceRef === endpoint.sourceId);
  if (!observations.length) return { tuples: [], issue: 'endpoint_observation_missing' };
  const tuples: unknown[][] = [];
  for (const observation of observations) {
    const indexes = endpoint.orderedColumns.map(column => observation.projection.indexOf(column));
    if (indexes.some(index => index < 0)) return { tuples: [], issue: 'ordered_key_projection_missing' };
    for (const row of observation.measuredTuples) {
      if (row.length <= Math.max(...indexes)) return { tuples: [], issue: 'ordered_key_tuple_malformed' };
      const tuple = indexes.map(index => row[index]);
      if (tuple.some(value => value === null || value === undefined)) return { tuples, issue: 'null_key_tuple_observed' };
      tuples.push(tuple);
    }
  }
  return { tuples: uniqueTuples(tuples) };
}

function insufficient(reason: string, baseDecision?: Decision, decision?: Decision, evidence?: EvidenceBundle): TypedCriticOutcome {
  return { status: 'INSUFFICIENT', reason, ...(baseDecision ? { baseDecision } : {}), ...(decision ? { decision } : {}), ...(evidence ? { evidence } : {}) };
}

/** Uses the shared relation engine for both baseline eligibility and each new counterprobe. */
export function evaluateTypedCounterprobe(input: { contract: RelationContract; baseEvidence: EvidenceBundle; counterEvidence: EvidenceBundle; previousCompleteEvidence?: EvidenceBundle; policy: RelationPolicy }): TypedCriticOutcome {
  const { contract, baseEvidence, counterEvidence, previousCompleteEvidence, policy } = input;
  if (validateRelationContract(contract).length) return insufficient('typed_base_contract_invalid');
  if (validateEvidenceBundle(baseEvidence).length || baseEvidence.relationRef !== contract.id || baseEvidence.contractVersion !== contract.contractVersion) return insufficient('typed_base_evidence_invalid');
  if (!completeBundle(baseEvidence)) return insufficient('typed_base_evidence_incomplete');
  let baseDecision: Decision;
  try { baseDecision = evaluateRelation(contract, [baseEvidence], policy); }
  catch { return insufficient('typed_base_evaluation_failed'); }
  if (baseDecision.verdict !== 'SOSTENIDA') return insufficient('common_engine_baseline_not_sustained', baseDecision);
  const baseFrom = endpointTuples(baseEvidence, contract.from), baseTo = endpointTuples(baseEvidence, contract.to);
  if (baseFrom.issue || baseTo.issue) return insufficient(baseFrom.issue ?? baseTo.issue ?? 'typed_base_tuple_invalid', baseDecision);
  if (!baseFrom.tuples.length || !baseTo.tuples.length) return insufficient('zero_typed_baseline_tuples', baseDecision);
  if (previousCompleteEvidence && (validateEvidenceBundle(previousCompleteEvidence).length || previousCompleteEvidence.relationRef !== contract.id
    || previousCompleteEvidence.contractVersion !== contract.contractVersion || !completeBundle(previousCompleteEvidence))) return insufficient('previous_complete_typed_evidence_invalid', baseDecision);
  const priorBundles = previousCompleteEvidence ? [baseEvidence, previousCompleteEvidence] : [baseEvidence];

  if (validateEvidenceBundle(counterEvidence).length || counterEvidence.relationRef !== contract.id || counterEvidence.contractVersion !== contract.contractVersion) return insufficient('typed_counterevidence_invalid', baseDecision, undefined, counterEvidence);
  if (reusesEvidenceIdentity(counterEvidence, priorBundles)) return { status: 'INSUFFICIENT', classification: 'REPEATED', reason: 'counterevidence reuses a prior request or observation identifier', baseDecision, evidence: counterEvidence };
  let decision: Decision;
  try { decision = evaluateRelation(contract, [counterEvidence], policy); }
  catch { return insufficient('common_engine_counterprobe_evaluation_failed', baseDecision, undefined, counterEvidence); }
  if (!completeBundle(counterEvidence)) return insufficient('counterevidence_transport_or_scope_incomplete', baseDecision, decision, counterEvidence);
  const currentFrom = endpointTuples(counterEvidence, contract.from), currentTo = endpointTuples(counterEvidence, contract.to);
  if (currentFrom.issue || currentTo.issue) return insufficient(currentFrom.issue ?? currentTo.issue ?? 'typed_countertuple_invalid', baseDecision, decision, counterEvidence);
  if (!currentFrom.tuples.length || !currentTo.tuples.length) return insufficient('zero_typed_counterprobe_tuples', baseDecision, decision, counterEvidence);

  const priorFrom = priorBundles.flatMap(bundle => endpointTuples(bundle, contract.from).tuples);
  const priorTo = priorBundles.flatMap(bundle => endpointTuples(bundle, contract.to).tuples);
  const priorFromTokens = priorFrom.map(tuple => normalizedTupleToken(contract, tuple));
  const priorToTokens = priorTo.map(tuple => normalizedTupleToken(contract, tuple));
  const currentFromTokens = currentFrom.tuples.map(tuple => normalizedTupleToken(contract, tuple));
  const currentToTokens = currentTo.tuples.map(tuple => normalizedTupleToken(contract, tuple));
  if ([...priorFromTokens, ...priorToTokens, ...currentFromTokens, ...currentToTokens].some(token => token === undefined)) return insufficient('typed_tuple_normalization_unsupported_or_value_rejected', baseDecision, decision, counterEvidence);
  const baseFromSet = new Set(priorFromTokens as string[]), baseToSet = new Set(priorToTokens as string[]);
  const currentFromSet = new Set(currentFromTokens as string[]), currentToSet = new Set(currentToTokens as string[]);
  const newSourceTuples = currentFrom.tuples.filter((_tuple, index) => !baseFromSet.has(currentFromTokens[index]!));
  const newTargetTuples = currentTo.tuples.filter((_tuple, index) => !baseToSet.has(currentToTokens[index]!));
  const previousToSet = new Set((previousCompleteEvidence ? endpointTuples(previousCompleteEvidence, contract.to).tuples : baseTo.tuples).map(tuple => normalizedTupleToken(contract, tuple)!));
  const removedTargetTuples = [...previousToSet].filter(token => !currentToSet.has(token));
  const newlySupportedTuples = newSourceTuples.filter(tuple => currentToSet.has(normalizedTupleToken(contract, tuple)!));
  const novelty = { sourceTuples: currentFrom.tuples.length, newSourceTuples: newSourceTuples.length, targetTuples: currentTo.tuples.length,
    newTargetTuples: newTargetTuples.length, removedTargetTuples: removedTargetTuples.length, newlySupportedTuples: newlySupportedTuples.length };
  if (decision.verdict === 'ENGAÑOSA') return { status: 'DEGRADED', classification: 'COUNTEREXAMPLE', reason: 'common engine found a complete pertinent counterexample', baseDecision, decision, evidence: counterEvidence, novelty };
  const repeated = newSourceTuples.length === 0 && newTargetTuples.length === 0 && removedTargetTuples.length === 0;
  if (repeated) return { status: 'INSUFFICIENT', classification: 'REPEATED', reason: 'same typed tuples; new request identifiers do not add support', baseDecision, decision, evidence: counterEvidence, novelty };
  if (decision.verdict === 'SOSTENIDA' && newlySupportedTuples.length > 0) return { status: 'CONFIRMED', classification: 'NOVEL_SUPPORT', reason: 'common engine found new typed support in complete counterevidence', baseDecision, decision, evidence: counterEvidence, novelty };
  return { status: 'INSUFFICIENT', reason: 'counterprobe did not establish new pertinent support', baseDecision, decision, evidence: counterEvidence, novelty };
}

/** Compatibility diagnostic only. It never creates or mutates a Decision. */
export function judgeCounterprobe(metrics: any, thresholds: any) {
  const reasons: string[] = [];
  if (!metrics || !Number.isFinite(metrics.seedKeys) || metrics.seedKeys <= 0 || metrics.overlap === null || !Number.isFinite(metrics.overlap)
    || metrics.sourceError || metrics.transportIncomplete || metrics.targetTruncated) return { status: 'INSUFFICIENT', reasons: ['counterprobe_incomplete_or_no_typed_seed'] };
  if (metrics.duplicateKeys?.length) reasons.push('duplicate_referenced_keys_in_bounded_result');
  if (metrics.labelAgreement && metrics.labelAgreement.ratio < thresholds.criticLabelAgreementFloor) reasons.push('label_agreement_below_floor');
  if (metrics.overlap < thresholds.criticOverlapFloor) reasons.push('overlap_below_floor');
  if (metrics.sponsor?.metrics?.ratio !== null && metrics.sponsor?.metrics?.ratio !== undefined && metrics.sponsor.metrics.ratio < thresholds.criticOverlapFloor) reasons.push('sponsor_reference_overlap_below_floor');
  if (reasons.some(reason => reason === 'duplicate_referenced_keys_in_bounded_result' || reason === 'label_agreement_below_floor')) return { status: 'DEGRADED', reasons };
  if (reasons.length) return { status: 'DEGRADED', reasons };
  return { status: 'CONFIRMED', reasons };
}

function rawFilterValues(tuples: readonly unknown[][]): (string | number | boolean)[] | undefined {
  const values = tuples.map(tuple => tuple[0]);
  if (values.some(value => !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) return undefined;
  return [...new Map(values.map(value => [canonical([typeof value, value]), value as string | number | boolean])).values()];
}

function buildCounterPlan(contract: RelationContract, config: any, inventory: any, limit: number, targetValues: (string | number | boolean)[]): { plan: ProbePlan; sourceSpec: any; allowlist: Record<string, string[]> } {
  const tables = Object.keys(config.tables ?? {});
  const resolve = (objectId: string) => tables.find(table => `${config.tables[table].db ?? config.database}.${table}` === objectId);
  const fromTable = resolve(contract.from.objectId), toTable = resolve(contract.to.objectId);
  if (!fromTable || !toTable) throw new TypeError('CRITIC_TYPED_ENDPOINT_OUTSIDE_UNIVERSE_CONFIG');
  const fromSpec = config.tables[fromTable], toSpec = config.tables[toTable];
  const allowlist: Record<string, string[]> = {
    [contract.from.objectId]: fromSpec.columns.map((column: any) => column.name),
    [contract.to.objectId]: toSpec.columns.map((column: any) => column.name)
  };
  const labels = (table: string) => (inventory.tables?.[table]?.labels ?? []).filter((column: string) => allowlist[`${config.tables[table].db ?? config.database}.${table}`]?.includes(column));
  const additionalColumns = { [contract.from.objectId]: labels(fromTable), [contract.to.objectId]: labels(toTable) };
  const filters = targetValues.length ? { [contract.to.objectId]: { column: contract.to.orderedColumns[0], values: targetValues } } : {};
  const plan = planProbe(contract, allowlist, limit, 50, additionalColumns, filters);
  return { plan, sourceSpec: fromSpec, allowlist };
}

async function runTypedCounterprobe(input: {
  contract: RelationContract; baseEvidence: EvidenceBundle; previousCompleteEvidence?: EvidenceBundle; policy: RelationPolicy; config: any; inventory: any; thresholds: any;
  client: Pick<Zetaris, 'runSql'>; executionMode: 'LIVE' | 'LOCAL' | 'REPLAY' | 'UNKNOWN'; dataOrigin: DataOrigin; now: string; runId: string;
}): Promise<TypedCriticOutcome> {
  const baseCheck = evaluateTypedCounterprobe({ contract: input.contract, baseEvidence: input.baseEvidence, counterEvidence: input.baseEvidence, policy: input.policy });
  if (!baseCheck.baseDecision || baseCheck.baseDecision.verdict !== 'SOSTENIDA' || baseCheck.classification !== 'REPEATED') return { ...baseCheck, reason: baseCheck.reason || 'base typed evidence is insufficient; no source reads issued' };
  if (input.contract.from.orderedColumns.length !== 1 || input.contract.to.orderedColumns.length !== 1) return insufficient('COMPOSITE_COUNTERPROBE_FILTER_UNSUPPORTED_BY_CURRENT_ADAPTER', baseCheck.baseDecision);
  const baseFrom = endpointTuples(input.baseEvidence, input.contract.from);
  const baselineValues = rawFilterValues(baseFrom.tuples);
  if (!baselineValues?.length) return insufficient('zero_or_non_scalar_source_seeds; no source reads issued', baseCheck.baseDecision);
  const limit = input.thresholds.criticProbeLimit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return insufficient('critic_probe_limit_invalid', baseCheck.baseDecision);
  const sourceColumn = input.contract.from.orderedColumns[0];
  let initial: ReturnType<typeof buildCounterPlan>;
  try { initial = buildCounterPlan(input.contract, input.config, input.inventory, limit, []); }
  catch (error) { return insufficient(error instanceof Error ? error.message : 'critic_probe_plan_invalid', baseCheck.baseDecision); }
  const sourceEndpoint = initial.plan.endpoints[0];
  const source = zetarisTableSpecs(input.config)[sourceEndpoint.objectId.split('.').at(-1)!];
  if (!source) return insufficient('CRITIC_SOURCE_TABLE_SPEC_MISSING', baseCheck.baseDecision);
  if (!initial.allowlist[sourceEndpoint.objectId]?.includes(sourceColumn)) return insufficient('critic_source_key_outside_allowlist', baseCheck.baseDecision);
  const sourceProjection = sourceEndpoint.columns.map(identifier).join(', ');
  const tableSql = sourceQuery(source);
  const sourceSql = `SELECT ${sourceProjection} FROM ${tableSql} WHERE (${identifier(sourceColumn)} NOT IN (${quotedValues(baselineValues)}) OR ${identifier(sourceColumn)} IS NULL) LIMIT ${limit}`;
  let sourceRead: Awaited<ReturnType<Zetaris['runSql']>>;
  try { sourceRead = await input.client.runSql(sourceSql, limit); }
  catch (error) {
    const diagnostic = failure(error) as any;
    return { status: 'ERROR', reason: 'source counterprobe transport failed; baseline remains current', baseDecision: baseCheck.baseDecision,
      transportFailures: [{ sourceRef: input.contract.from.sourceId, code: diagnostic.code ?? 'SOURCE_COUNTERPROBE_FAILED', http: diagnostic.http, retryAfter: diagnostic.retryAfter, requestId: (error as any)?.requestId }] };
  }
  const sourceTuples = sourceRead.rows;
  const fringeValues = rawFilterValues(sourceTuples.filter(row => row[0] !== null && row[0] !== undefined).map(row => [row[0]]));
  if (!fringeValues?.length) {
    const counterprobe = { strategy: 'typed unseen source key fringe', sql: sourceSql, requestId: sourceRead.requestId, sourceRows: sourceTuples.length, sourceTruncated: sourceTuples.length >= limit };
    return { status: 'INSUFFICIENT', classification: sourceTuples.length ? undefined : 'REPEATED', reason: sourceTuples.length ? 'fringe contained no usable non-null typed tuple' : 'no new source tuples; repeated bounded request', baseDecision: baseCheck.baseDecision, counterprobe };
  }
  let targetPlan: ReturnType<typeof buildCounterPlan>;
  try { targetPlan = buildCounterPlan(input.contract, input.config, input.inventory, limit, fringeValues); }
  catch (error) { return insufficient(error instanceof Error ? error.message : 'critic_target_plan_invalid', baseCheck.baseDecision); }
  const targetAdapter = new ZetarisProbeAdapter(zetarisTableSpecs(input.config), input.client);
  const adapter: ProbeAdapter = {
    adapterId: 'typed-critic-counterprobe',
    async read(request) {
      if (request.sourceId === input.contract.from.sourceId && request.objectId === input.contract.from.objectId) {
        return { tuples: sourceTuples, requestId: sourceRead.requestId, observedAt: sourceRead.utc, requestedAt: sourceRead.utc, statement: sourceSql, queryId: sourceRead.queryId, durationMs: sourceRead.durationMs, truncated: sourceTuples.length >= limit };
      }
      return targetAdapter.read(request);
    }
  };
  const execution = await executeProbe(targetPlan.plan, adapter, { runId: input.runId, checkedAt: input.now, scope: 'bounded typed unseen source tuples and target key lookup', executionMode: input.executionMode, dataOrigin: input.dataOrigin });
  const sourceObservation = execution.bundle.observations.find(observation => observation.sourceRef === input.contract.from.sourceId);
  if (sourceObservation) sourceObservation.filters = [`${sourceColumn} NOT IN (${baselineValues.length} prior typed values)`, `${sourceColumn} IS NULL`];
  const targetObservation = execution.bundle.observations.find(observation => observation.sourceRef === input.contract.to.sourceId);
  if (targetObservation) {
    const keyIndexes = input.contract.to.orderedColumns.map(column => targetObservation.projection.indexOf(column));
    const counts = new Map<string, number>();
    for (const row of targetObservation.measuredTuples) {
      const tuple = keyIndexes.map(index => row[index]);
      const token = tupleToken(tuple);
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    if ([...counts.values()].some(count => count > 1)) addSampleQualitySignals(execution.bundle, ['DUPLICATE_REFERENCED_KEYS'], input.now);
  }
  const outcome = evaluateTypedCounterprobe({ contract: input.contract, baseEvidence: input.baseEvidence, counterEvidence: execution.bundle,
    previousCompleteEvidence: input.previousCompleteEvidence, policy: input.policy });
  const targetRead = execution.reads.find(read => read.sourceId === input.contract.to.sourceId);
  const metrics = { seedKeys: baseFrom.tuples.length, sourceRows: sourceTuples.length, matchedKeys: outcome.novelty?.newlySupportedTuples ?? 0,
    newSourceTuples: outcome.novelty?.newSourceTuples ?? 0, newTargetTuples: outcome.novelty?.newTargetTuples ?? 0,
    duplicateKeys: execution.bundle.observations.find(observation => observation.sourceRef === input.contract.to.sourceId)?.duplicateCount ?? 'UNKNOWN' };
  const counterprobe = { strategy: 'typed unseen source key fringe → bounded target lookup', sql: targetRead?.statement ?? sourceSql,
    sourceSql, requestId: targetRead?.requestId ?? null, sourceRequestId: sourceRead.requestId, utc: targetRead?.requestedAt ?? sourceRead.utc,
    metrics, evidenceBundleRef: execution.bundle.evidenceBundleId, decisionRef: outcome.decision?.decisionId ?? null,
    transportStatus: execution.status, transportErrors: execution.errors };
  return { ...outcome, counterprobe, ...(execution.errors.length ? { transportFailures: execution.errors.map(error => ({ sourceRef: error.sourceRef, code: error.adapterCode, http: error.http, retryAfter: error.retryAfter })) } : {}) };
}

export interface CriticDependencies {
  relations?: any;
  inventory?: any;
  config?: any;
  thresholds?: any;
  client?: Pick<Zetaris, 'runSql'>;
  persist?: boolean;
  persistRelations?: (universeId: string, relations: any) => void;
  now?: () => string;
  executionMode?: 'LIVE' | 'LOCAL' | 'REPLAY' | 'UNKNOWN';
  dataOrigin?: DataOrigin;
}
function lastRequestId(file: string) {
  try { const lines = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/), last = JSON.parse(lines.at(-1) ?? '{}'); return last.kind === 'zetaris' ? last.requestId : null; }
  catch { return null; }
}
function artifactRelationId(relationId: string) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(relationId) ? relationId : createHash('sha256').update(relationId).digest('hex').slice(0, 24); }
function relationTouchesExcluded(relation: any, excluded: readonly string[]): boolean {
  const contract: RelationContract | undefined = relation.relationContract ?? relation.evidence?.relationContract ?? relation.evidence?.typedEvidence?.relationContract;
  const candidates = [relation.from?.table, relation.to?.table, relation.from?.objectId, relation.to?.objectId,
    contract?.from.objectId, contract?.to.objectId].filter((value): value is string => typeof value === 'string');
  const names = new Set(candidates.flatMap(value => [value, value.split('.').at(-1)!]));
  return excluded.some(value => names.has(value));
}

/** Public typed critic route. Invalid/incomplete baselines are reported before source reads. */
export async function criticize(id = 'U1', options: { includeExcluded?: boolean; relationIds?: string[]; force?: boolean } = {}, dependencies: CriticDependencies = {}) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const runId = `critic-${id}-${now().replace(/[-:.]/g, '')}`;
  const persist = dependencies.persist !== false;
  const tracePath = traceFileForRun(runId), traceOffset = persist && fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').length : 0;
  if (persist) setTraceRun(runId);
  try {
    const cfg = dependencies.config ?? readJson<any>(`universes/${id === 'U1' ? 'U1_ny_taxi' : id === 'U2' ? 'U2_companies' : 'U3_madi_companies'}.json`);
    const relations = dependencies.relations ?? readJson<any>(`out/${id}/relaciones.json`);
    const inventory = dependencies.inventory ?? readJson<any>(`out/${id}/discovery.json`);
    const thresholds = dependencies.thresholds ?? readJson<any>('config/thresholds.json');
    const excluded = dependencies.config?.costExclusions?.[id] ?? (dependencies.config ? [] : readJson<any>('config/cost-exclusions.json')[id] ?? []);
    const policy = relationPolicyFromConfig(thresholds);
    let client = dependencies.client;
    const getClient = () => client ??= new Zetaris();
    const prior = relations.critic?.results ?? [];
    const log: any[] = options.force ? [] : options.relationIds?.length ? prior.filter((item: any) => !options.relationIds!.includes(item.relationId)) : prior;
    const candidates = relations.relations.filter((relation: any) => (relation.decision ? relation.decision.verdict === 'SOSTENIDA'
      : relation.verdict === 'SOSTENIDA' || relation.originalCriticVerdict === 'SOSTENIDA')
      && (!options.relationIds?.length || options.relationIds.includes(relation.relationId)));

    for (const relation of candidates) {
      if (!options.force && prior.some((item: any) => item.relationId === relation.relationId && !['ERROR', 'SKIPPED'].includes(item.status))) continue;
      if (!options.includeExcluded && (excluded.includes(relation.relationId) || relationTouchesExcluded(relation, excluded))) {
        log.push({ relationId: relation.relationId, status: 'SKIPPED', reason: 'cost_excluded_relation_or_endpoint' }); continue;
      }
      const contract: RelationContract | undefined = relation.relationContract ?? relation.evidence?.relationContract ?? relation.evidence?.typedEvidence?.relationContract;
      const baseEvidence: EvidenceBundle | undefined = relation.typedEvidence ?? relation.evidence?.typedEvidence;
      const baseDecision: Decision | undefined = relation.decision ?? relation.evidence?.decision;
      const baseEvidenceRef = baseEvidence?.evidenceBundleId;
      let outcome: TypedCriticOutcome;
      const freshnessState = relation.freshness?.state ?? relation.evidence?.freshness?.state;
      if (freshnessState === 'DEGRADADA' || freshnessState === 'INCOMPLETA') {
        outcome = insufficient(`base_relation_freshness_${freshnessState.toLowerCase()}; no source reads issued`);
      } else if (!contract || !baseEvidence || !baseDecision || baseDecision.verdict !== 'SOSTENIDA') {
        outcome = insufficient('valid complete typed baseline contract, evidence and common Decision are required; no source reads issued');
      } else {
        try {
          outcome = await runTypedCounterprobe({ contract, baseEvidence, previousCompleteEvidence: relation.criticEvidence, policy, config: cfg, inventory, thresholds, client: getClient(),
            executionMode: dependencies.executionMode ?? 'LIVE', dataOrigin: dependencies.dataOrigin ?? 'UNKNOWN', now: now(), runId: `${runId}:${relation.relationId}` });
        } catch (error) {
          const diagnostic = failure(error) as any;
          outcome = { status: 'ERROR', reason: diagnostic.code ?? 'TYPED_CRITIC_FAILURE', transportFailures: [{ code: diagnostic.code ?? 'TYPED_CRITIC_FAILURE', http: diagnostic.http, retryAfter: diagnostic.retryAfter, requestId: (error as any)?.requestId ?? (persist ? lastRequestId(tracePath) : undefined) ?? undefined }] };
        }
      }
      const counter = outcome.counterprobe;
      const decision = outcome.decision;
      const priorRelationDecision = relation.decision as Decision | undefined;
      const effectiveBaseDecision = outcome.baseDecision ?? baseDecision;
      const result = { relationId: relation.relationId, status: outcome.status, ...(outcome.classification ? { classification: outcome.classification } : {}), reason: outcome.reason,
        baseDecisionRef: effectiveBaseDecision?.decisionId ?? null, baseEvidenceRef: baseEvidenceRef ?? null, priorRelationDecisionRef: priorRelationDecision?.decisionId ?? null, decisionRef: decision?.decisionId ?? null,
        evidenceBundleRef: outcome.evidence?.evidenceBundleId ?? null, novelty: outcome.novelty ?? null, transportFailures: outcome.transportFailures ?? [],
        counterprobes: counter ? [counter] : [] };
      log.push(result);
      const history = [...(relation.critic?.history ?? []), { runId, checkedAt: now(), baseDecisionSnapshot: effectiveBaseDecision ?? null, ...result }];
      relation.critic = { ...(relation.critic ?? {}), status: outcome.status, classification: outcome.classification, reason: outcome.reason,
        currentDecisionRef: decision?.decisionId ?? null, counterprobes: counter ? [counter] : [], history };
      if ((outcome.status === 'CONFIRMED' || outcome.status === 'DEGRADED') && decision && outcome.evidence && completeBundle(outcome.evidence)) {
        relation.criticDecision = decision;
        relation.criticEvidence = outcome.evidence;
        relation.decision = decision;
        relation.verdict = decision.verdict;
        relation.requiresReview = decision.requiresReview;
        relation.critic.lastCompleteDecisionRef = decision.decisionId;
        relation.critic.lastCompleteEvidenceRef = outcome.evidence.evidenceBundleId;
      }
      if (persist) {
        const safeRelationId = artifactRelationId(relation.relationId);
        writeJson(`evidence/critic-${id}-${safeRelationId}.json`, { role: 'critic', action: 'counterprobe', runId, baseDecisionRef: result.baseDecisionRef, baseEvidenceRef, ...outcome });
        if (outcome.status === 'DEGRADED') writeJson(`evidence/critic-downgrade-${id}-${safeRelationId}.json`, { role: 'critic', action: 'review_required', decisionRef: decision?.decisionId, evidenceBundleRef: outcome.evidence?.evidenceBundleId, baseDecisionRef: result.baseDecisionRef, utc: now() });
        trace({ role: 'critic', action: outcome.status === 'DEGRADED' ? 'counterexample' : 'counterprobe', relationId: relation.relationId, baseDecisionRef: result.baseDecisionRef,
          decisionRef: decision?.decisionId ?? null, evidenceBundleRef: outcome.evidence?.evidenceBundleId ?? null, status: outcome.status });
      }
    }
    const summary = { runId, utc: now(), confirmed: log.filter(item => item.status === 'CONFIRMED').length, degraded: log.filter(item => item.status === 'DEGRADED').length,
      insufficient: log.filter(item => item.status === 'INSUFFICIENT').length, repeated: log.filter(item => item.classification === 'REPEATED').length,
      errors: log.filter(item => item.status === 'ERROR').length, skipped: log.filter(item => item.status === 'SKIPPED').length, results: log };
    relations.critic = summary;
    if (dependencies.persistRelations) dependencies.persistRelations(id, relations);
    else if (persist) { writeJson(`out/${id}/critic.json`, summary); writeRelations(relations, id); }
    if (persist && fs.existsSync(tracePath)) {
      const events = fs.readFileSync(tracePath, 'utf8').slice(traceOffset).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const runTracePath = path.join(ROOT, 'evidence', 'runs', runId, 'trace.jsonl');
      fs.mkdirSync(path.dirname(runTracePath), { recursive: true });
      fs.writeFileSync(runTracePath, events.map((event: any) => JSON.stringify(event)).join('\n') + '\n');
      writeJson(`evidence/runs/${runId}/critic.json`, { universe: id, ...summary });
    }
    console.log('Critic', id, JSON.stringify({ confirmed: summary.confirmed, degraded: summary.degraded, insufficient: summary.insufficient, repeated: summary.repeated, errors: summary.errors, skipped: summary.skipped }));
    return summary;
  } catch (error) {
    if (persist) writeJson(`evidence/runs/${runId}/critic-error.json`, { runId, universe: id, error: failure(error), utc: now() });
    throw error;
  } finally { if (persist) setTraceRun(); }
}
