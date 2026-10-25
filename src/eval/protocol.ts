import { createHash } from 'node:crypto';
import type { EvidenceBundle, RelationContract } from '../contracts/types.ts';
import { evaluateRelation, type RelationPolicy } from '../relations/decision.ts';

export type EvalTruth = 'APPROVABLE' | 'NONAPPROVABLE' | 'UNKNOWN';
export interface Adjudication { truth: EvalTruth; basis: 'SYNTHETIC_FIXTURE' | 'HUMAN_REVIEW' | 'DECLARED_CONTROL'; adjudicatorId: string; referenceHash: string; adjudicatedAt: string; }
export interface EvaluationCase {
  caseId: string;
  split: 'DEVELOPMENT' | 'RESERVED_HOLDOUT';
  taskId: string;
  universeId: string;
  inputSetHash: string;
  executionMode: 'LIVE' | 'REPLAY' | 'LOCAL';
  dataOrigin: 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN';
  contract: RelationContract;
  evidence: EvidenceBundle[];
  adjudication: Adjudication;
}
export interface EvaluationProtocol {
  schemaVersion: 1;
  protocolVersion: '1.0';
  evaluator: 'evaluateRelation';
  evaluatorVersion: string;
  policyVersion: string;
  codeHash: string;
  policyHash: string;
  frozenAt: string;
  developmentCaseIds: string[];
  positiveEnumerationComplete: boolean;
  reservedHoldout: { manifestId: string; version: string; contentHash: string; caseCount: number; accessState: 'NOT_READ' | 'NOT_EVALUATED' };
}
export interface EvaluationBudget { candidateLimit: number; reviewMinutes: number; }
export interface MethodRun { methodId: string; providerVersion: string; inputSetHash: string; budget: EvaluationBudget; cases: readonly EvaluationCase[]; }
export interface EvalMetrics {
  universeId: string; taskId: string; methodId: string; dataOrigin: string; executionMode: string;
  denominator: { allCases: number; consulted: number; evaluated: number; notConsulted: number; accepts: number; adjudicatedAccepts: number; nonapprovable: number; positives: number };
  counts: { correctAccept: number; falseAccept: number; unknownAdjudications: number; rejects: number; abstentions: number; reviewed: number; errors: number; notConsulted: number };
  precisionAccept: number | null; falseAcceptanceRate: number | null; recallPositive: number | null;
  acceptanceRate: number | null; rejectionRate: number | null; abstentionRate: number | null; reviewRate: number | null; errorRate: number | null; notConsultedRate: number | null;
}
export interface EvaluationRun { protocolHash: string; metricDefinitionVersion: 'e05a-enumerated-denominators-v2'; split: 'DEVELOPMENT'; methods: { methodId: string; providerVersion: string; inputSetHash: string; budget: EvaluationBudget }[]; metrics: EvalMetrics[]; results: { methodId: string; caseId: string; verdict: string | 'ERROR' | 'NOT_CONSULTED'; reasonCodes: string[]; }[]; holdout: EvaluationProtocol['reservedHoldout']; }

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))) : item);
}
const ratio = (n: number, d: number): number | null => d ? n / d : null;

export function createEvaluationProtocol(input: Omit<EvaluationProtocol, 'schemaVersion' | 'evaluator'>): EvaluationProtocol {
  if (!input.protocolVersion || !input.evaluatorVersion || !input.policyVersion || !input.codeHash || !input.policyHash || Number.isNaN(Date.parse(input.frozenAt))) throw new TypeError('INVALID_EVALUATION_FREEZE');
  if (new Set(input.developmentCaseIds).size !== input.developmentCaseIds.length || input.developmentCaseIds.some(id => !id)) throw new TypeError('INVALID_DEVELOPMENT_SPLIT');
  if (!input.reservedHoldout.manifestId || !input.reservedHoldout.version || !input.reservedHoldout.contentHash || input.reservedHoldout.caseCount < 0 || input.reservedHoldout.accessState !== 'NOT_READ') throw new TypeError('INVALID_RESERVED_HOLDOUT_MANIFEST');
  return { schemaVersion: 1, evaluator: 'evaluateRelation', ...structuredClone(input), developmentCaseIds: [...input.developmentCaseIds].sort() };
}

/** Executes only DEVELOPMENT fixtures through the shared relation evaluator. Reserved holdout contents are never accepted here. */
export function evaluateDevelopment(protocol: EvaluationProtocol, methods: readonly MethodRun[], policy: RelationPolicy): EvaluationRun {
  if (protocol.reservedHoldout.accessState !== 'NOT_READ') throw new TypeError('RESERVED_HOLDOUT_ACCESS_STATE_INVALID');
  if (policy.policyVersion !== protocol.policyVersion) throw new TypeError('EVALUATION_POLICY_VERSION_MISMATCH');
  if (!methods.length || new Set(methods.map(method => method.methodId)).size !== methods.length) throw new TypeError('INVALID_METHOD_RUNS');
  const expectedIds = [...protocol.developmentCaseIds].sort();
  for (const method of methods) {
    if (!method.methodId || !method.providerVersion || !method.inputSetHash || !Number.isInteger(method.budget.candidateLimit) || method.budget.candidateLimit < 0 || !Number.isFinite(method.budget.reviewMinutes) || method.budget.reviewMinutes < 0) throw new TypeError('INVALID_METHOD_METADATA');
    const ids = method.cases.map(item => item.caseId).sort();
    if (ids.some(id => !id) || new Set(ids).size !== ids.length || canonical(ids) !== canonical(expectedIds)) throw new TypeError('DEVELOPMENT_SPLIT_MISMATCH');
    if (method.cases.some(item => item.split !== 'DEVELOPMENT' || item.universeId !== item.contract.universeRef.universeId || item.inputSetHash !== method.inputSetHash || !['LIVE', 'REPLAY', 'LOCAL'].includes(item.executionMode) || !['SYNTHETIC', 'PUBLIC', 'USER', 'UNKNOWN'].includes(item.dataOrigin) || !['APPROVABLE', 'NONAPPROVABLE', 'UNKNOWN'].includes(item.adjudication.truth) || !item.adjudication.adjudicatorId || Number.isNaN(Date.parse(item.adjudication.adjudicatedAt)) || !item.adjudication.referenceHash)) throw new TypeError('DEVELOPMENT_CASE_INVALID');
  }
  const sharedInput = methods[0].inputSetHash, sharedBudget = canonical(methods[0].budget);
  if (methods.some(method => method.inputSetHash !== sharedInput || canonical(method.budget) !== sharedBudget)) throw new TypeError('ABLATION_INPUT_OR_BUDGET_MISMATCH');
  const adjudicationShape = (method: MethodRun) => canonical(method.cases.map(item => [item.caseId, item.taskId, item.universeId, item.executionMode, item.dataOrigin, item.adjudication]).sort(([left], [right]) => String(left).localeCompare(String(right), 'en')));
  if (methods.some(method => adjudicationShape(method) !== adjudicationShape(methods[0]))) throw new TypeError('ABLATION_CASE_OR_ADJUDICATION_MISMATCH');

  const results: EvaluationRun['results'] = [];
  const groups = new Map<string, { method: MethodRun; cases: EvaluationCase[]; outcomes: { testCase: EvaluationCase; verdict: string; review: boolean; error: boolean; consulted: boolean }[] }>();
  for (const method of methods) {
    const orderedCases = [...method.cases].sort((a, b) => a.caseId.localeCompare(b.caseId, 'en'));
    const consultedIds = new Set(orderedCases.slice(0, method.budget.candidateLimit).map(testCase => testCase.caseId));
    const outcomes = orderedCases.map(testCase => {
      if (!consultedIds.has(testCase.caseId)) {
        results.push({ methodId: method.methodId, caseId: testCase.caseId, verdict: 'NOT_CONSULTED', reasonCodes: ['candidate_limit_reached'] });
        return { testCase, verdict: 'NOT_CONSULTED', review: false, error: false, consulted: false };
      }
      try {
        const decision = evaluateRelation(testCase.contract, testCase.evidence, policy);
        results.push({ methodId: method.methodId, caseId: testCase.caseId, verdict: decision.verdict, reasonCodes: decision.reasonCodes });
        return { testCase, verdict: decision.verdict, review: decision.requiresReview || decision.status !== 'CURRENT', error: false, consulted: true };
      } catch (error) {
        results.push({ methodId: method.methodId, caseId: testCase.caseId, verdict: 'ERROR', reasonCodes: [error instanceof Error ? error.name : 'EVALUATION_ERROR'] });
        return { testCase, verdict: 'ERROR', review: true, error: true, consulted: true };
      }
    });
    groups.set(method.methodId, { method, cases: [...method.cases], outcomes });
  }
  const metrics: EvalMetrics[] = [];
  for (const [methodId, group] of groups) {
    const buckets = new Map<string, typeof group.outcomes>();
    for (const outcome of group.outcomes) {
      const testCase = outcome.testCase;
      const key = JSON.stringify([testCase.universeId, testCase.taskId, testCase.dataOrigin, testCase.executionMode]);
      buckets.set(key, [...(buckets.get(key) ?? []), outcome]);
    }
    for (const bucket of buckets.values()) {
      const first = bucket[0].testCase;
      const accepts = bucket.filter(outcome => outcome.consulted && !outcome.error && outcome.verdict === 'SOSTENIDA');
      const adjudicatedAccepts = accepts.filter(outcome => outcome.testCase.adjudication.truth !== 'UNKNOWN');
      const consulted = bucket.filter(outcome => outcome.consulted);
      const nonapprovable = bucket.filter(outcome => outcome.testCase.adjudication.truth === 'NONAPPROVABLE');
      const positives = bucket.filter(outcome => outcome.testCase.adjudication.truth === 'APPROVABLE');
      const correctAccept = accepts.filter(outcome => outcome.testCase.adjudication.truth === 'APPROVABLE').length;
      const falseAccept = accepts.filter(outcome => outcome.testCase.adjudication.truth === 'NONAPPROVABLE').length;
      const unknownAdjudications = consulted.filter(outcome => outcome.testCase.adjudication.truth === 'UNKNOWN').length;
      const rejects = bucket.filter(outcome => !outcome.error && outcome.verdict === 'ENGAÑOSA').length;
      const abstentions = consulted.filter(outcome => !outcome.error && outcome.verdict === 'INDETERMINADA').length;
      const errors = bucket.filter(outcome => outcome.error).length;
      const reviewed = bucket.filter(outcome => outcome.consulted && outcome.review).length;
      const allCases = bucket.length;
      const notConsulted = allCases - consulted.length;
      const evaluated = consulted.length - errors;
      const recallPositive = protocol.positiveEnumerationComplete ? ratio(correctAccept, positives.length) : null;
      metrics.push({ universeId: first.universeId, taskId: first.taskId, methodId, dataOrigin: first.dataOrigin, executionMode: first.executionMode,
        denominator: { allCases, consulted: consulted.length, evaluated, notConsulted, accepts: accepts.length, adjudicatedAccepts: adjudicatedAccepts.length, nonapprovable: nonapprovable.length, positives: positives.length },
        counts: { correctAccept, falseAccept, unknownAdjudications, rejects, abstentions, reviewed, errors, notConsulted },
        precisionAccept: ratio(correctAccept, accepts.length), falseAcceptanceRate: ratio(falseAccept, nonapprovable.length), recallPositive,
        acceptanceRate: ratio(accepts.length, allCases), rejectionRate: ratio(rejects, allCases), abstentionRate: ratio(abstentions, allCases), reviewRate: ratio(reviewed, allCases), errorRate: ratio(errors, allCases), notConsultedRate: ratio(notConsulted, allCases) });
    }
  }
  return { protocolHash: hash(protocol), metricDefinitionVersion: 'e05a-enumerated-denominators-v2', split: 'DEVELOPMENT', methods: methods.map(({ methodId, providerVersion, inputSetHash, budget }) => ({ methodId, providerVersion, inputSetHash, budget: { ...budget } })), metrics, results, holdout: { ...protocol.reservedHoldout } };
}
