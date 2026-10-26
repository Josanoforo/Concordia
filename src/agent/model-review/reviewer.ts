/**
 * The review stage: for each candidate relation with probe evidence, independent model judges evaluate it, an adversarial pass attacks those evaluations,
 * and a deterministic aggregation produces one review (accept / defer / reject) sealed `MODEL_REVIEWED`.
 *
 * Budget: every generation is checked against the remaining token budget BEFORE it is made (`canAskModel` + `canAfford`) and charged from its receipt after it.
 * A relation whose calls do not fit is recorded as SKIPPED_BUDGET and deferred; nothing is dropped silently and nothing is retried.
 * Trace: each call emits an event with the prompt hash (the prompt itself is not stored), the raw response (bounded), the receipt and the tokens.
 */
import type { AssistBudget } from '../critic-assist.ts';
import { aggregateReview, classifyAttacks } from './aggregate.ts';
import { deterministicAttacks } from './deterministic-attacks.ts';
import { evidenceFloor } from './floors.ts';
import { PLANNING_TOKENS_PER_CALL } from './calibration.ts';
import { checkClaim, decisionRecord, evidenceFingerprint, reusedDecision, worthRecording } from './decision-memory.ts';
import { buildModelDrift, buildModelTable } from './model-table.ts';
import { reviewPriority } from './priority.ts';
import { normalizeToolArguments } from './normalize.ts';
import { toolSchemaTokens } from './tool-schemas.ts';
import { adversaryMessages, estimateMessagesTokens, judgeMessages, parseAttacks, parseEvaluation, promptHash, type EvaluationForAttack, type JudgeLens } from './prompts.ts';
import {
  ATTACK_FAMILIES, MODEL_REVIEW_LABEL, MODEL_REVIEW_PROMPT_VERSION, MODEL_REVIEW_SCHEMA_VERSION, MODEL_REVIEWED,
  type AdversaryRecord, type AttackRecord, type CallRecord, type CallTransport, type DecisionMemoryActivity, type Evaluation, type ModelMessage, type ModelReview, type ModelReviewConfig, type ModelReviewRun, type ReceiptSummary, type ReusedReviewDecision, type ReviewCall, type ReviewDecisionMemory, type ReviewModel, type ReviewPacket, type ReviewProvenance, type ReviewStartDetail, type RunTransport, type ReviewTraceEvent, type TieBreakAudit, type TraceStage, type UnprobedCandidate
} from './types.ts';

/** One generation is capped at 3000 by the model client. The model spends output tokens before the JSON: 400 truncated every adversary answer of the first live NWCH run and 2000 one of the second. */
export const DEFAULT_PROGRESS_EVERY_CALLS = 25;
export const DEFAULT_MAX_OUTPUT_TOKENS_JUDGE = 1500, DEFAULT_MAX_OUTPUT_TOKENS_ADVERSARY = 3000, MAX_OUTPUT_TOKENS_CEILING = 3000, DEFAULT_TRACE_RESPONSE_CHARS = 4000, MAX_JUDGES = 3;
const LENSES: readonly JudgeLens[] = ['A', 'B', 'C'];

export interface ModelReviewInput {
  packets: readonly ReviewPacket[];
  /** Candidates with no probe evidence: they never reach a model and come out as defer with the reason. */
  unprobed?: readonly UnprobedCandidate[];
  /** 1-3 independent judges; each takes a different lens. */
  judges: readonly ReviewModel[];
  adversary: ReviewModel;
  /** Whole tie-break per relation id (from `buildPackets`): kept on the review record, not in the prompt. */
  audits?: Readonly<Record<string, TieBreakAudit>>;
  budget: AssistBudget;
  config: ModelReviewConfig;
  /**
   * N2: the review decision memory. Before a relation is sent to a model its evidence fingerprint is looked up; a rejection or deferral recorded for the same fingerprint and the same
   * prompt version is reused (0 calls, reason REUSED_REVIEW_DECISION_FROM_MEMORY, origin MODEL_REVIEWED). Approvals are never reused from here. The new rejections and deferrals are
   * recorded when the review ends. Without it the review behaves exactly as before.
   */
  reviewDecisionMemory?: ReviewDecisionMemory;
  /** Receives every trace event as it happens (the engine writes it into the run's trace). The same events are returned in the run. */
  onEvent?: (event: ReviewTraceEvent) => void;
}

const receiptSummary = (call: ReviewCall): ReceiptSummary | undefined => call.receipt
  ? { receiptId: call.receipt.receiptId, provider: call.receipt.provider, model: call.receipt.model, inputTokens: call.receipt.inputTokens, outputTokens: call.receipt.outputTokens, totalTokens: call.receipt.totalTokens } : undefined;

/** The adversary makes one call for the four families: its tokens are split evenly over the attack records (remainder to the first) so any sum over attacks is the call's cost. */
function splitAttackTokens<T extends { tokens?: number }>(attacks: T[], total: number): T[] {
  const base = Math.floor(total / Math.max(1, attacks.length)), remainder = total - base * attacks.length;
  return attacks.map((attack, index) => ({ ...attack, tokens: base + (index === 0 ? remainder : 0) }));
}

export function outputCaps(config: Pick<ModelReviewConfig, 'maxOutputTokensPerCall' | 'maxOutputTokensJudge' | 'maxOutputTokensAdversary'>) {
  const pick = (specific: number | undefined, fallback: number) => config.maxOutputTokensPerCall ?? specific ?? fallback;
  const caps = { judge: pick(config.maxOutputTokensJudge, DEFAULT_MAX_OUTPUT_TOKENS_JUDGE), adversary: pick(config.maxOutputTokensAdversary, DEFAULT_MAX_OUTPUT_TOKENS_ADVERSARY) };
  for (const value of Object.values(caps)) if (!Number.isInteger(value) || value < 1 || value > MAX_OUTPUT_TOKENS_CEILING) throw new Error('MODEL_REVIEW_MAX_OUTPUT_TOKENS_INVALID');
  return caps;
}

export function reviewProvenance(models: readonly ReviewModel[]): ReviewProvenance {
  return models.every(model => model.kind === 'LIVE_MODEL') ? 'LIVE_MODEL' : 'STAND_IN_OFFLINE';
}

/** Upper bound of the tokens one run needs, for pre-estimation against the budget (RunBudget.estimate(units, { tokens }) takes `perRelationTokens`). */
/** How each role's client gets the answer. */
export interface RoleTransports { judges: CallTransport; adversary: CallTransport }
/** The run-level label: one transport when both roles share it, MIXED when they differ. */
export const runTransport = (transports: RoleTransports): RunTransport => transports.judges === transports.adversary ? transports.judges : 'MIXED';

export function estimateModelReviewCost(packets: readonly ReviewPacket[], judgeCount: number, config: Pick<ModelReviewConfig, 'attackScope' | 'cascade' | 'maxOutputTokensPerCall' | 'maxOutputTokensJudge' | 'maxOutputTokensAdversary'>, options: { transport?: CallTransport; transports?: RoleTransports } = {}) {
  const { judge: maxJudge, adversary: maxAdversary } = outputCaps(config);
  // E5-02: a call over the tool-call transport also sends the function schema.
  // The schema is sent by the roles whose client uses the tool call: a mixed run (judges by tool call, adversary by text) pays it on the judge calls only.
  const transports = options.transports ?? { judges: options.transport ?? 'TEXT', adversary: options.transport ?? 'TEXT' };
  const schema = { judge: transports.judges === 'TOOL_CALL' ? toolSchemaTokens('EVALUATION') : 0, adversary: transports.adversary === 'TOOL_CALL' ? toolSchemaTokens('ATTACK') : 0 };
  let calls = 0, tokens = 0, evaluated = 0, firstJudgeTokens = 0;
  for (const packet of packets) {
    const floor = evidenceFloor(packet);
    if (floor.cap === 'reject') continue;
    evaluated++;
    for (let index = 0; index < judgeCount; index++) { const estimate = estimateMessagesTokens(judgeMessages(packet, LENSES[index % LENSES.length]!), maxJudge) + schema.judge; calls++; tokens += estimate; if (index === 0) firstJudgeTokens += estimate; }
    if (floor.cap === 'accept' && config.attackScope !== 'NONE') {
      const placeholder: EvaluationForAttack[] = Array.from({ length: judgeCount }, (_, index) => ({ evaluator: `E${index + 1}`, decision: 'accept', confidence: 'medium', reasonCodes: ['NAME_ENTITY_MATCH', 'KEY_MEMBERSHIP_COMPLETE', 'TARGET_UNIQUE_IN_SAMPLE'], rationale: 'x'.repeat(400) }));
      calls++; tokens += estimateMessagesTokens(adversaryMessages(packet, placeholder), maxAdversary) + schema.adversary;
    }
  }
  // With the cascade the upper bound is unchanged (every judge accepts); the floor is judge A alone for every evaluated relation.
  return { relations: packets.length, evaluatedRelations: evaluated, calls, estimatedTokens: tokens, perRelationTokens: packets.length ? Math.ceil(tokens / packets.length) : 0, ...(config.cascade ? { cascadeMinimumTokens: firstJudgeTokens } : {}) };
}

/** C4: what the review is about to do, from the packets alone (no call): the cascade split, the bounds on calls and tokens. */
export function reviewStartDetail(input: { packets: readonly ReviewPacket[]; notEvaluated: number; reusedNegative?: number; judges: number; config: ModelReviewConfig; transports: RoleTransports; tokenBudget?: { used: number; limit: number } }): ReviewStartDetail {
  const { packets, judges, config } = input;
  const attackScope = config.attackScope ?? 'ACCEPTED_ONLY', cascade = config.cascade === true;
  let floorRejected = 0, evaluated = 0, attackEligible = 0, decidedByPacket = 0;
  for (const packet of packets) {
    const floor = evidenceFloor(packet);
    if (floor.cap === 'reject') { floorRejected++; continue; }
    evaluated++;
    if (floor.cap === 'accept' && attackScope !== 'NONE') { attackEligible++; if (deterministicAttacks(packet).some(attack => attack.outcome === 'SUSTAINED')) decidedByPacket++; }
  }
  const minimum = cascade ? evaluated : evaluated * judges, maximum = evaluated * judges + (attackEligible - decidedByPacket);
  const upperBound = estimateModelReviewCost(packets, judges, config, { transports: input.transports }).estimatedTokens;
  return {
    candidates: packets.length + (input.reusedNegative ?? 0) + input.notEvaluated, relations: packets.length, notEvaluated: input.notEvaluated, judges, attackScope, cascade, transport: runTransport(input.transports), transports: input.transports,
    floorRejected, evaluated, attackEligible, decidedByPacket, calls: { minimum, maximum }, tokensPerCall: PLANNING_TOKENS_PER_CALL,
    projectedTokens: { minimum: minimum * PLANNING_TOKENS_PER_CALL, maximum: maximum * PLANNING_TOKENS_PER_CALL, upperBound },
    ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}), progressEveryCalls: progressEvery(config), promptVersion: MODEL_REVIEW_PROMPT_VERSION,
    ...(input.reusedNegative !== undefined ? { reusedNegative: input.reusedNegative } : {})
  };
}
export function progressEvery(config: Pick<ModelReviewConfig, 'progressEveryCalls'>): number {
  const value = config.progressEveryCalls ?? DEFAULT_PROGRESS_EVERY_CALLS;
  if (!Number.isInteger(value) || value < 0) throw new Error('MODEL_REVIEW_PROGRESS_EVERY_INVALID');
  return value;
}
/** The run budget when it exposes its meter (RunBudget does; the AssistBudget interface does not require it). */
const tokenMeter = (budget: AssistBudget): { used: number; limit: number } | undefined => {
  const meter = budget as unknown as { tokens?: unknown; limits?: { maxTokensPerRun?: unknown } };
  return typeof meter.tokens === 'number' && typeof meter.limits?.maxTokensPerRun === 'number' ? { used: meter.tokens, limit: meter.limits.maxTokensPerRun } : undefined;
};

export async function runModelReview(input: ModelReviewInput): Promise<ModelReviewRun> {
  const { budget, config } = input;
  const judges = input.judges;
  if (judges.length < 1 || judges.length > MAX_JUDGES) throw new Error('MODEL_REVIEW_JUDGES_OUT_OF_RANGE');
  if (!Number.isInteger(config.minDistinctKeys) || config.minDistinctKeys < 1) throw new Error('MODEL_REVIEW_MIN_DISTINCT_KEYS_INVALID');
  const attackScope = config.attackScope ?? 'ACCEPTED_ONLY', cascade = config.cascade === true;
  const caps = outputCaps(config), traceChars = config.maxTraceResponseChars ?? DEFAULT_TRACE_RESPONSE_CHARS;
  const provenance = reviewProvenance([...judges, input.adversary]);
  // N2: relations whose rejection or deferral the memory already holds (same fingerprint, same prompt version) leave the list: no call, no tokens. Floor rejections need no model and are not looked up.
  const memory = input.reviewDecisionMemory, activity: DecisionMemoryActivity = { lookups: 0, hits: 0, ignoredClaims: 0, recorded: 0, errors: [] };
  let reusedDecisions: ReusedReviewDecision[] = [];
  const fingerprints = new Map<string, string>();
  let packets: readonly ReviewPacket[] = input.packets;
  if (memory) {
    const toReview: ReviewPacket[] = [];
    for (const packet of input.packets) {
      if (evidenceFloor(packet).cap === 'reject') { toReview.push(packet); continue; }
      const fingerprint = evidenceFingerprint(packet);
      fingerprints.set(packet.relationId, fingerprint); activity.lookups++;
      let claim: ReturnType<ReviewDecisionMemory['lookup']> = null;
      try { claim = memory.lookup(packet.relationId, fingerprint, MODEL_REVIEW_PROMPT_VERSION); }
      catch (error) { activity.errors.push(`lookup ${packet.relationId}: ${error instanceof Error ? error.name : 'MEMORY_LOOKUP_FAILED'}`); }
      const check = checkClaim(claim, fingerprint);
      if (check.reuse) { reusedDecisions.push(reusedDecision(packet, claim!, fingerprint, check.decision, cascade ? 1 : judges.length)); activity.hits++; continue; }
      if (claim) activity.ignoredClaims++;
      toReview.push(packet);
    }
    packets = toReview;
  }
  const trace: ReviewTraceEvent[] = [];
  const emit = (event: ReviewTraceEvent) => { trace.push(event); input.onEvent?.(event); };
  const models = new Set<string>();
  let skippedBudget = 0, skippedByCascade = 0, cascadeTokensAvoided = 0, callsMade = 0, chargedTokens = 0, failedCalls = 0;
  // C4: the cascade's saving valued at what this run measured per call of the same stage; the upper-bound estimate stays as the gate's figure.
  const skippedByStage: Record<TraceStage, number> = { EVALUATION: 0, ATTACK: 0 }, liveByStage: Record<TraceStage, { calls: number; tokens: number }> = { EVALUATION: { calls: 0, tokens: 0 }, ATTACK: { calls: 0, tokens: 0 } };
  const every = progressEvery(config), startedAt = Date.now();
  // R10b: the transport is per role (judges by tool call, the adversary by text is the default of createCandidateReview); a role is tool-call only if every model in it is.
  const transports: RoleTransports = { judges: judges.every(model => model.transport === 'TOOL_CALL') ? 'TOOL_CALL' : 'TEXT', adversary: input.adversary.transport === 'TOOL_CALL' ? 'TOOL_CALL' : 'TEXT' };
  const meterAtStart = tokenMeter(budget);
  const start = reviewStartDetail({ packets, notEvaluated: input.unprobed?.length ?? 0, ...(memory ? { reusedNegative: reusedDecisions.length } : {}), judges: judges.length, config, transports, ...(meterAtStart ? { tokenBudget: meterAtStart } : {}) });
  emit({ kind: 'model-review-start', detail: start });
  for (const reused of reusedDecisions) emit({ kind: 'model-review-decision', relationId: reused.relationId, detail: { decision: reused.decision, ...(reused.confidence ? { confidence: reused.confidence } : {}), reasons: [reused.reasonCode], originalReasons: reused.originalReasons, reused: true, evidenceFingerprint: reused.evidenceFingerprint, promptVersion: reused.promptVersion, calls: 0, tokens: 0, callsAvoided: reused.callsAvoided, tokensAvoided: reused.tokensAvoided, origin: MODEL_REVIEWED } });
  const done = new Map<string, ModelReview>();
  const progress = () => {
    const reviewed = [...done.values()], meter = tokenMeter(budget);
    emit({ kind: 'model-review-progress', detail: { callsMade, failedCalls, tokens: chargedTokens, relationsDone: done.size, relationsTotal: packets.length,
      accept: reviewed.filter(review => review.decision === 'accept').length, defer: reviewed.filter(review => review.decision === 'defer').length, reject: reviewed.filter(review => review.decision === 'reject').length,
      skippedByCascade, skippedBudget, ...(memory ? { reusedNegative: reusedDecisions.length } : {}), callsExpected: start.calls, elapsedMs: Date.now() - startedAt, ...(meter ? { tokenBudget: meter } : {}) } });
  };

  /** One counted generation: budget check before, charge after, trace event always. */
  async function generate(model: ReviewModel, messages: ModelMessage[], stage: TraceStage, relationId: string, maxOut: number): Promise<{ call?: ReviewCall; hash: string; tokens: number; skipped: boolean; record: CallRecord }> {
    const hash = promptHash(messages), estimated = model.estimateTokens(messages, maxOut, stage);
    const base = { kind: 'model-review-call' as const, stage, relationId, actor: model.id, promptVersion: MODEL_REVIEW_PROMPT_VERSION, promptHash: hash, ...(model.requestedModel ? { requestedModel: model.requestedModel } : {}), estimatedTokens: estimated };
    if (!budget.canAskModel() || !budget.canAfford(estimated)) {
      skippedBudget++;
      emit({ ...base, callStatus: 'SKIPPED_BUDGET', parseStatus: 'NOT_PARSED', error: budget.wouldExceed(estimated) });
      return { hash, tokens: 0, skipped: true, record: { status: 'SKIPPED_BUDGET', ...(model.requestedModel ? { requestedModel: model.requestedModel } : {}), tokens: 0, maxOutputTokens: maxOut } };
    }
    let call: ReviewCall;
    try { call = await model.complete(messages, { maxOutputTokens: maxOut, stage }); }
    catch (error) { call = { status: 'FAIL', error: { code: error instanceof Error ? error.name : 'REVIEW_MODEL_THROWN' } }; }
    const tokens = call.receipt?.totalTokens ?? 0;
    budget.chargeTokens(tokens);
    callsMade++; chargedTokens += tokens; if (call.status !== 'PASS') failedCalls++;
    if (call.status === 'PASS') { liveByStage[stage].calls++; liveByStage[stage].tokens += tokens; }
    if (call.receipt) models.add(call.receipt.model);
    const summary = receiptSummary(call);
    emit({ ...base, callStatus: call.status === 'PASS' ? 'PASS' : 'FAIL', tokens, ...(call.transport ? { transport: call.transport } : {}), ...(call.truncated ? { truncated: true } : {}), ...(summary ? { receipt: summary } : {}), ...(call.responseText !== undefined ? { responseText: call.responseText.slice(0, traceChars) } : {}), ...(call.error ? { error: call.error } : {}) });
    if (every > 0 && callsMade % every === 0) progress();
    return { call, hash, tokens, skipped: false, record: { status: call.status === 'PASS' ? 'PASS' : 'FAIL', ...(model.requestedModel ? { requestedModel: model.requestedModel } : {}), ...(call.transport ? { transport: call.transport } : {}), tokens, maxOutputTokens: maxOut, ...(call.truncated ? { truncated: true } : {}), ...(summary ? { receipt: summary } : {}), ...(call.responseText !== undefined ? { responseText: call.responseText.slice(0, traceChars) } : {}) } };
  }
  const setParse = (parseStatus: 'VALID' | 'INVALID', relationId: string, stage: TraceStage, actor: string, normalized: readonly string[] = []) => {
    // The call event was already emitted; the parse result is its own event so the call event stays immutable.
    emit({ kind: 'model-review-parse', stage, relationId, actor, parseStatus, ...(normalized.length ? { normalized: [...normalized] } : {}) });
  };
  /** R10b: the arguments of a tool call may carry an array/object field as a JSON string; they are read one level decoded, and the record says so only when the answer then parsed. */
  const readAnswer = (call: ReviewCall, text: string, stage: TraceStage) => call.transport === 'TOOL_CALL' ? normalizeToolArguments(stage, text) : { text, normalized: [] as string[] };

  /** A call the cascade did not make: recorded, never charged. The estimate is what it would have cost, for the before/after of the cascade. */
  const skipByCascade = (model: ReviewModel, messages: ModelMessage[], stage: TraceStage, relationId: string, maxOut: number): CallRecord => {
    skippedByCascade++; skippedByStage[stage]++;
    const estimated = model.estimateTokens(messages, maxOut, stage);
    cascadeTokensAvoided += estimated;
    emit({ kind: 'model-review-call', stage, relationId, actor: model.id, promptVersion: MODEL_REVIEW_PROMPT_VERSION, ...(model.requestedModel ? { requestedModel: model.requestedModel } : {}), estimatedTokens: estimated, callStatus: 'SKIPPED_BY_CASCADE', parseStatus: 'NOT_PARSED', tokens: 0 });
    return { status: 'SKIPPED_BY_CASCADE', ...(model.requestedModel ? { requestedModel: model.requestedModel } : {}), tokens: 0, maxOutputTokens: maxOut };
  };

  // E5-08: relations are reviewed in priority order (structure first) so that a budget cut leaves the least promising unreviewed; the reviews come back in input order.
  const order = reviewPriority(packets), packetById = new Map(packets.map(packet => [packet.relationId, packet]));
  for (const { relationId } of order) {
    const packet = packetById.get(relationId)!;
    const floor = evidenceFloor(packet);
    const evaluations: Evaluation[] = [];
    let calls = 0, tokens = 0;
    const adversary: AdversaryRecord = { actor: input.adversary.id, status: 'NOT_NEEDED', attacks: [] };

    if (floor.cap !== 'reject') {
      let askMore = true;
      for (const [index, judge] of judges.entries()) {
        const messages = judgeMessages(packet, LENSES[index % LENSES.length]!);
        if (cascade && !askMore) { evaluations.push({ judgeId: judge.id, status: 'SKIPPED_BY_CASCADE', reasonCodes: [], flags: [], call: skipByCascade(judge, messages, 'EVALUATION', packet.relationId, caps.judge), tokens: 0 }); continue; }
        const result = await generate(judge, messages, 'EVALUATION', packet.relationId, caps.judge);
        tokens += result.tokens;
        if (result.skipped) { askMore = false; evaluations.push({ judgeId: judge.id, status: 'SKIPPED_BUDGET', reasonCodes: [], flags: [], promptHash: result.hash, call: result.record, tokens: 0 }); continue; }
        calls++;
        const call = result.call!;
        if (call.status !== 'PASS' || typeof call.responseText !== 'string') { askMore = false; evaluations.push({ judgeId: judge.id, status: 'CALL_FAILED', reasonCodes: [], flags: [], promptHash: result.hash, call: result.record, tokens: result.tokens }); continue; }
        const answer = readAnswer(call, call.responseText, 'EVALUATION'), parsed = parseEvaluation(answer.text, packet.relationId);
        if (parsed?.decision !== 'accept') askMore = false;
        if (parsed && answer.normalized.length) result.record.normalized = answer.normalized;
        setParse(parsed ? 'VALID' : 'INVALID', packet.relationId, 'EVALUATION', judge.id, parsed ? answer.normalized : []);
        evaluations.push(parsed
          ? { judgeId: judge.id, status: 'VALID', decision: parsed.decision, confidence: parsed.confidence, reasonCodes: parsed.reasonCodes, rationale: parsed.rationale, flags: parsed.flags, promptHash: result.hash, call: result.record, tokens: result.tokens }
          : { judgeId: judge.id, status: 'INVALID', reasonCodes: [], flags: [], promptHash: result.hash, call: result.record, tokens: result.tokens });
      }

      const anyAccept = evaluations.some(evaluation => evaluation.status === 'VALID' && evaluation.decision === 'accept');
      const allAccept = evaluations.length === judges.length && evaluations.every(evaluation => evaluation.status === 'VALID' && evaluation.decision === 'accept');
      const wanted = attackScope === 'ALL' ? floor.cap === 'accept' && evaluations.some(evaluation => evaluation.status === 'VALID') : attackScope === 'ACCEPTED_ONLY' ? floor.cap === 'accept' && anyAccept : false;
      // E5-03: attacks the packet already decides are computed here; one that sustains lowers the decision below accept, so the adversary call could change nothing.
      const deterministic = deterministicAttacks(packet), decidedByPacket = deterministic.some(attack => attack.outcome === 'SUSTAINED');
      // E5-01: with the cascade the adversary runs only when every judge accepted (a disagreement defers whatever it says).
      const attack = wanted && !decidedByPacket && (!cascade || allAccept);
      if (attack) {
        const shown: EvaluationForAttack[] = evaluations.filter(evaluation => evaluation.status === 'VALID').map((evaluation, index) => ({ evaluator: `E${index + 1}`, decision: evaluation.decision!, confidence: evaluation.confidence!, reasonCodes: evaluation.reasonCodes, rationale: evaluation.rationale ?? '' }));
        const result = await generate(input.adversary, adversaryMessages(packet, shown), 'ATTACK', packet.relationId, caps.adversary);
        tokens += result.tokens; adversary.promptHash = result.hash; adversary.call = result.record; adversary.tokens = result.tokens;
        if (result.skipped) adversary.status = 'SKIPPED_BUDGET';
        else {
          calls++;
          const call = result.call!;
          if (call.status !== 'PASS' || typeof call.responseText !== 'string') adversary.status = 'CALL_FAILED';
          else {
            const answer = readAnswer(call, call.responseText, 'ATTACK'), parsed = parseAttacks(answer.text, packet.relationId);
            if (parsed && answer.normalized.length) result.record.normalized = answer.normalized;
            setParse(parsed ? 'VALID' : 'INVALID', packet.relationId, 'ATTACK', input.adversary.id, parsed ? answer.normalized : []);
            if (parsed) { adversary.status = 'COMPLETED'; adversary.attacks = splitAttackTokens(classifyAttacks(packet, parsed), result.tokens); }
            else adversary.status = 'INVALID';
          }
        }
      } else if (cascade && floor.cap === 'accept' && attackScope !== 'NONE' && !decidedByPacket) {
        adversary.status = 'SKIPPED_BY_CASCADE';
        adversary.call = skipByCascade(input.adversary, adversaryMessages(packet, []), 'ATTACK', packet.relationId, caps.adversary);
      }
      // The two computed families join the record in the review's family order, whether or not the adversary was asked.
      adversary.attacks = (ATTACK_FAMILIES as readonly string[]).flatMap(family => [...deterministic, ...adversary.attacks].filter(item => item.family === family)) as AttackRecord[];
    }

    const review = aggregateReview({ packet, floor, evaluations, adversary, judgesConfigured: judges.length, attackScope, provenance, calls, tokens });
    if (input.audits?.[packet.relationId]) review.tieBreak = input.audits[packet.relationId]!;
    done.set(packet.relationId, review);
    emit({ kind: 'model-review-decision', relationId: packet.relationId, detail: { decision: review.decision, confidence: review.confidence, reasons: review.reasons, adversarialPass: review.adversarialPass, attacksSustained: review.attacksSustained.map(attack => attack.family), calls, tokens, origin: MODEL_REVIEWED, label: review.label } });
  }

  const reviews = packets.map(packet => done.get(packet.relationId)!);
  const notEvaluated = (input.unprobed ?? []).map(item => ({ relationId: item.relationId, decision: 'defer' as const, reason: item.reason }));
  const observedMean = (stage: TraceStage) => (liveByStage[stage].calls ? liveByStage[stage].tokens / liveByStage[stage].calls : PLANNING_TOKENS_PER_CALL);
  const cascadeTokensAvoidedObserved = Math.round(skippedByStage.EVALUATION * observedMean('EVALUATION') + skippedByStage.ATTACK * observedMean('ATTACK'));
  // A claim without figures (the engine's ledger keeps none) is valued at what this run's judge calls measured, as the cascade saving is, not at the planning figure.
  if (liveByStage.EVALUATION.calls) reusedDecisions = reusedDecisions.map(item => item.tokensBasis === 'PLANNING' ? { ...item, tokensAvoided: Math.round(item.callsAvoided * observedMean('EVALUATION')), tokensBasis: 'OBSERVED_THIS_RUN' as const } : item);
  const modelTable = buildModelTable(reviews, judges, input.adversary), modelDrift = buildModelDrift(modelTable);
  // N2: record the new rejections and deferrals that are a judgment on the evidence; a deferral that only means a failed, invalid or unfunded call is not kept.
  if (memory) {
    const records = reviews.filter(worthRecording).flatMap(review => fingerprints.has(review.relationId) ? [decisionRecord(review, fingerprints.get(review.relationId)!, provenance, { judges: judges.length, attackScope, cascade })] : []);
    if (records.length) {
      try { memory.record(records); activity.recorded = records.length; }
      catch (error) { activity.errors.push(`record: ${error instanceof Error ? error.name : 'MEMORY_RECORD_FAILED'}`); }
    }
  }
  const counts = {
    ...(memory ? { reusedNegative: reusedDecisions.length, reusedNegativeCallsAvoided: reusedDecisions.reduce((sum, item) => sum + item.callsAvoided, 0), reusedNegativeTokensAvoided: reusedDecisions.reduce((sum, item) => sum + item.tokensAvoided, 0) } : {}),
    relations: reviews.length, accept: reviews.filter(review => review.decision === 'accept').length, defer: reviews.filter(review => review.decision === 'defer').length, reject: reviews.filter(review => review.decision === 'reject').length,
    calls: reviews.reduce((sum, review) => sum + review.calls, 0), tokens: reviews.reduce((sum, review) => sum + review.tokens, 0), skippedBudget, skippedByCascade, cascadeEstimatedTokensAvoided: cascadeTokensAvoided, cascadeTokensAvoidedObserved, adversarialCompleted: reviews.filter(review => review.adversarialPass === 'COMPLETED').length
  };
  const run: ModelReviewRun = {
    schemaVersion: MODEL_REVIEW_SCHEMA_VERSION, kind: 'MODEL_ADVERSARIAL_REVIEW_RUN', origin: MODEL_REVIEWED, provenance, label: MODEL_REVIEW_LABEL, promptVersion: MODEL_REVIEW_PROMPT_VERSION,
    config: { judges: judges.length, attackScope, minDistinctKeys: config.minDistinctKeys, maxOutputTokensJudge: caps.judge, maxOutputTokensAdversary: caps.adversary, cascade },
    status: !input.packets.length ? 'EMPTY' : skippedBudget ? 'PARTIAL_BUDGET' : 'COMPLETE',
    reviews, notEvaluated, counts, trace,
    modelTable, modelDrift, start, ...(memory ? { reusedDecisions, decisionMemory: activity } : {}),
    priority: { order, skipped: order.filter(entry => done.get(entry.relationId)!.evaluations.some(item => item.status === 'SKIPPED_BUDGET') || done.get(entry.relationId)!.adversary.status === 'SKIPPED_BUDGET').map(entry => ({ ...entry, reason: 'SKIPPED_BUDGET' })) },
    ...(models.size ? { sameModelAcrossRoles: models.size === 1 } : {}),
    limitations: ['bounded-sample evidence only; no global coverage or uniqueness claim', 'model judgment, not a human review: the origin stays MODEL_REVIEWED and never fills a slot that requires a human',
      'key membership cannot tell a homonym apart; the judges and the adversary carry the semantics and can be wrong',
      ...(provenance === 'STAND_IN_OFFLINE' ? ['STAND_IN_OFFLINE: scripted stand-in model, not a live model review'] : []),
      ...(models.size === 1 ? ['judges and adversary used the same model: self-preference can correlate their errors'] : []),
      ...(modelDrift.driftedCalls ? [`model drift inside the route: ${modelDrift.driftedCalls} of ${modelDrift.receiptCalls} calls were answered by a model other than their role's dominant one (${modelDrift.models.map(entry => `${entry.model} ${entry.calls}`).join(', ')}); the model per role is not pinned`] : []),
      ...(reusedDecisions.length ? [`review decision memory: ${reusedDecisions.length} rejection/deferral decision(s) reused (same evidence fingerprint and prompt version), not re-reviewed: ${reusedDecisions.filter(item => item.decision === 'reject').length} reject, ${reusedDecisions.filter(item => item.decision === 'defer').length} defer; approvals are never reused from the memory`] : []),
      ...(activity.errors.length ? [`review decision memory errors (the review went on without it): ${activity.errors.join('; ')}`] : [])]
  };
  emit({ kind: 'model-review-run', detail: { status: run.status, counts, provenance, promptVersion: MODEL_REVIEW_PROMPT_VERSION, cascade, ...(memory ? { decisionMemory: { ...activity, reusedNegative: reusedDecisions.length, tokensAvoided: counts.reusedNegativeTokensAvoided } } : {}), ...(cascade ? { cascadeEstimatedTokensAvoided: cascadeTokensAvoided, cascadeTokensAvoidedObserved } : {}), modelDrift: { homogeneous: modelDrift.homogeneous, driftedCalls: modelDrift.driftedCalls, receiptCalls: modelDrift.receiptCalls, models: modelDrift.models }, prioritySkipped: run.priority.skipped.map(entry => ({ relationId: entry.relationId, rank: entry.rank })) } });
  return run;
}

