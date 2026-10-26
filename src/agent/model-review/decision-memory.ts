/**
 * N2: negative memory of the review. A rejection or a deferral the reviewer already took on the same evidence, with the same prompt version, is not asked of the models again
 * (R10 pass 2 re-reviewed 90 relations that pass 1 had rejected or deferred: 77 calls, 328,865 tokens, the same answers except three deferrals that became rejections).
 *
 * The memory is a dependency the reviewer receives (`ReviewDecisionMemory`, implemented and wired by the engine). This file holds the pure parts: the fingerprint of what the
 * prompt shows, the test of a claim, and the record of a decision worth keeping. It never reuses towards an approval, and it never keeps a decision that is not a judgment on the
 * evidence (a call that failed, an answer that did not parse, a budget skip).
 */
import { createHash } from 'node:crypto';
import { PLANNING_TOKENS_PER_CALL } from './calibration.ts';
import {
  MODEL_REVIEW_PROMPT_VERSION, MODEL_REVIEWED, REUSED_REVIEW_DECISION_REASON,
  type Evaluation, type ModelReview, type ReviewDecisionClaim, type ReviewDecisionRecord, type ReviewPacket, type ReviewProvenance, type ReusedReviewDecision
} from './types.ts';

/** Keys that identify a run or a moment and never the evidence: dropped at any depth so that two runs over the same evidence hash alike. */
const VOLATILE_KEYS = new Set(['runId', 'requestId', 'timestamp', 'generatedAt', 'createdAt', 'now']);

/** JSON with object keys sorted at every depth and `undefined` dropped; array order is kept (it is part of what the prompt shows). */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(item => walk(item === undefined ? null : item));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        const item = (node as Record<string, unknown>)[key];
        if (item !== undefined && !VOLATILE_KEYS.has(key)) out[key] = walk(item);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

/**
 * Hash of exactly what the prompt shows the models for this relation: the packet (evidence, profile, siblings, roles, tie-break as the prompt carries it, negative control,
 * one-to-one trait). The judge and the adversary prompts embed the same packet, so one fingerprint covers both. The prompt text around it is the prompt version's business.
 */
export const evidenceFingerprint = (packet: ReviewPacket): string => createHash('sha256').update(canonicalJson(packet)).digest('hex');

export type ClaimCheck = { reuse: true; decision: 'reject' | 'defer' } | { reuse: false; why: string };
/** A claim is reused only if it is a rejection or deferral on this fingerprint and this prompt version, MODEL_REVIEWED, and not a stand-in's. */
export function checkClaim(claim: ReviewDecisionClaim | null | undefined, fingerprint: string): ClaimCheck {
  if (!claim || typeof claim !== 'object') return { reuse: false, why: 'NO_CLAIM' };
  if (claim.decision !== 'reject' && claim.decision !== 'defer') return { reuse: false, why: 'NOT_NEGATIVE' };
  if (claim.evidenceFingerprint !== fingerprint) return { reuse: false, why: 'FINGERPRINT_DIFFERS' };
  if (claim.promptVersion !== MODEL_REVIEW_PROMPT_VERSION) return { reuse: false, why: 'PROMPT_VERSION_DIFFERS' };
  if (claim.origin !== undefined && claim.origin !== MODEL_REVIEWED) return { reuse: false, why: 'ORIGIN_NOT_MODEL_REVIEWED' };
  if (claim.provenance === 'STAND_IN_OFFLINE') return { reuse: false, why: 'STAND_IN_CLAIM' };
  return { reuse: true, decision: claim.decision };
}

/**
 * `fallbackCalls` is what this configuration asks for a negative decision (the cascade: judge A alone; otherwise every judge). The saving never claims more calls than that, even when the
 * claim's original review made more (R10: a deferral that took both judges and the adversary costs one call under the cascade), and the tokens follow the calls at the claim's own rate.
 */
export function reusedDecision(packet: ReviewPacket, claim: ReviewDecisionClaim, fingerprint: string, decision: 'reject' | 'defer', fallbackCalls: number): ReusedReviewDecision {
  const claimedCalls = Number.isInteger(claim.calls) && (claim.calls ?? 0) > 0 ? claim.calls! : undefined;
  const callsAvoided = Math.min(claimedCalls ?? fallbackCalls, fallbackCalls);
  const claimedTokens = Number.isFinite(claim.tokens) && (claim.tokens ?? 0) > 0 ? claim.tokens! : undefined;
  const fromClaim = claimedTokens !== undefined && claimedCalls !== undefined;
  const tokensAvoided = fromClaim ? Math.round(claimedTokens * callsAvoided / claimedCalls) : callsAvoided * PLANNING_TOKENS_PER_CALL;
  return {
    relationId: packet.relationId, from: { table: packet.source.table, column: packet.source.column }, to: { table: packet.target.table, column: packet.target.column },
    decision, reasonCode: REUSED_REVIEW_DECISION_REASON, originalReasons: [...claim.reasons], ...(claim.confidence ? { confidence: claim.confidence } : {}),
    origin: MODEL_REVIEWED, evidenceFingerprint: fingerprint, promptVersion: MODEL_REVIEW_PROMPT_VERSION, calls: 0, tokens: 0, callsAvoided, tokensAvoided, tokensBasis: fromClaim ? 'CLAIM' : 'PLANNING',
    ...((claim.recordedRunId ?? claim.runId) ? { recordedRunId: (claim.recordedRunId ?? claim.runId)! } : {})
  };
}

/** An evaluation or attack that is not a judgment on the evidence: the call failed, the answer did not parse, or the budget cut it. */
const NOT_A_JUDGMENT = new Set<string>(['INVALID', 'CALL_FAILED', 'SKIPPED_BUDGET']);
const judged = (evaluation: Evaluation) => !NOT_A_JUDGMENT.has(evaluation.status);

/**
 * Whether a fresh decision is worth keeping: a rejection or deferral of a LIVE review in which a model actually judged and nothing that mattered was lost. A deferral that only means
 * "a call failed / an answer was invalid / the budget ran out" would make the next run skip a relation that was never really reviewed. A floor rejection needs no model and is not kept.
 */
export function worthRecording(review: ModelReview): boolean {
  if (review.decision === 'accept' || review.provenance !== 'LIVE_MODEL' || review.origin !== MODEL_REVIEWED) return false;
  if (review.calls < 1 || review.floor.cap === 'reject') return false;
  if (!review.evaluations.every(judged) || NOT_A_JUDGMENT.has(review.adversary.status)) return false;
  return true;
}

export function decisionRecord(review: ModelReview, fingerprint: string, provenance: ReviewProvenance, config: { judges: number; attackScope: string; cascade: boolean }): ReviewDecisionRecord {
  const calls = [...review.evaluations.map(item => item.call), review.adversary.call];
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
  return {
    relationId: review.relationId, decision: review.decision as 'reject' | 'defer', evidenceFingerprint: fingerprint, promptVersion: MODEL_REVIEW_PROMPT_VERSION,
    reasons: [...review.reasons], confidence: review.confidence, origin: MODEL_REVIEWED, provenance,
    models: unique(calls.map(call => call?.receipt?.model)), requestedModels: unique(calls.map(call => call?.requestedModel)), config, calls: review.calls, tokens: review.tokens
  };
}
