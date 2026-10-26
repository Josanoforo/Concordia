/**
 * Deterministic combination of judges, adversary and evidence floor into one review. No model call happens here, and nothing here can raise a decision:
 * judges agree or the relation is deferred; the adversarial pass and the floor only lower. An accept needs unanimous judges, a completed adversarial pass
 * and a floor that allows it.
 */
import { evidenceRefResolves, type ParsedAttack } from './prompts.ts';
import { confidenceCeiling } from './floors.ts';
import {
  BLOCKING_REASON_CODES, MODEL_REVIEW_LABEL, MODEL_REVIEW_LABEL_NO_ADVERSARIAL, MODEL_REVIEW_SCHEMA_VERSION, MODEL_REVIEWED, lowerConfidence, lowerOf,
  type AdversaryRecord, type AdversarialPass, type AttackFamily, type AttackRecord, type Confidence, type Decision, type Evaluation, type FloorResult, type ModelReview, type ReasonCode, type ReviewPacket, type ReviewProvenance
} from './types.ts';

export { BLOCKING_REASON_CODES };
const FAMILY_REASON: Record<AttackFamily, ReasonCode> = { HOMONYM: 'HOMONYM_RISK', INSUFFICIENT_KEYS: 'INSUFFICIENT_DISTINCT_KEYS', SIBLING: 'SIBLING_BETTER_MATCH', INVERTED_ORIENTATION: 'ORIENTATION_DOUBTFUL' };

/**
 * A SIBLING attack says another candidate is the better match. It is refuted when EVERY sibling it cites is excluded by evidence in the packet:
 *  - a sibling sharing the source whose target was measured NOT globally unique (it cannot be a foreign key, whatever its key membership says);
 *  - a role (E2-04): another column of this source table pointing at the same target is a role of one dimension, not an alternative;
 *  - a tied sibling that loses a DECISIVE tie-break to this relation (X10's `orderTies`). A tie that is not decisive is not refuted: the defer stays.
 */
function siblingExcluded(packet: ReviewPacket, index: number): boolean {
  const sibling = packet.siblings[index];
  if (!sibling) return false;
  if (sibling.shares === 'TARGET') return sibling.role === true;
  if (sibling.otherGlobalUniqueness === 'NOT_UNIQUE') return true;
  // Every SOURCE sibling is in the tie group by construction; the winner is named relative to this packet (THIS).
  const tie = packet.tieBreak;
  return tie?.decisive === true && tie.winner === 'THIS';
}
function refutedSibling(packet: ReviewPacket, attack: ParsedAttack): boolean {
  if (attack.family !== 'SIBLING') return false;
  const cited = [...new Set(attack.evidenceRefs.map(ref => /^siblings\[(\d+)\]/.exec(ref)?.[1]).filter((index): index is string => index !== undefined))].map(Number);
  return cited.length > 0 && cited.every(index => siblingExcluded(packet, index));
}

/** Grounds each parsed attack against the packet and decides its outcome. A blocking attack whose references are not all in the packet is UNGROUNDED and discarded. */
export function classifyAttacks(packet: ReviewPacket, parsed: readonly ParsedAttack[]): AttackRecord[] {
  return parsed.map(attack => {
    const grounded = attack.evidenceRefs.length > 0 && attack.evidenceRefs.every(ref => evidenceRefResolves(packet, ref));
    // The 1:1 trait is evidence for the adversary but never blocks on its own: an attack that cites only it survives as a weakness (the names decide).
    const onlyOneToOne = attack.evidenceRefs.length > 0 && attack.evidenceRefs.every(ref => ref === 'oneToOne' || ref.startsWith('oneToOne.'));
    const outcome = attack.severity === 'none' ? 'NO_ATTACK' : attack.severity === 'minor' ? 'SURVIVED' : !grounded ? 'UNGROUNDED' : onlyOneToOne ? 'SURVIVED' : refutedSibling(packet, attack) ? 'REFUTED' : 'SUSTAINED';
    return { ...attack, source: 'MODEL' as const, outcome };
  });
}

export interface AggregateInput {
  packet: ReviewPacket;
  floor: FloorResult;
  evaluations: Evaluation[];
  adversary: AdversaryRecord;
  /** Number of judges configured: a judge that failed or was skipped still counts as a judge that did not accept. */
  judgesConfigured: number;
  attackScope: 'ACCEPTED_ONLY' | 'ALL' | 'NONE';
  provenance: ReviewProvenance;
  calls: number;
  tokens: number;
}

export function aggregateReview(input: AggregateInput): ModelReview {
  const { packet, floor, evaluations, adversary } = input;
  const notes: string[] = [...floor.notes];
  const reasons: ReasonCode[] = [];
  const addReason = (code: ReasonCode) => { if (!reasons.includes(code)) reasons.push(code); };

  // 1. Judges: invalid, failed or skipped judges count as defer; an accept that contradicts its own reasons is read as defer.
  const decisions: Decision[] = [];
  const confidences: Confidence[] = [];
  // A judge skipped by the cascade was never asked: the judges before it already decided (the cascade only skips after one of them did not accept).
  const cascaded = evaluations.filter(evaluation => evaluation.status === 'SKIPPED_BY_CASCADE').length;
  if (cascaded) notes.push(`${cascaded} judge call(s) skipped by the cascade: an earlier judge did not accept`);
  for (const evaluation of evaluations) {
    if (evaluation.status === 'SKIPPED_BY_CASCADE') continue;
    if (evaluation.status !== 'VALID' || !evaluation.decision) { decisions.push('defer'); notes.push(`judge ${evaluation.judgeId}: ${evaluation.status}; counted as defer`); continue; }
    let decision = evaluation.decision;
    if (decision === 'accept' && evaluation.reasonCodes.some(code => BLOCKING_REASON_CODES.includes(code))) {
      decision = 'defer'; if (!evaluation.flags.includes('ACCEPT_WITH_BLOCKING_REASON')) evaluation.flags.push('ACCEPT_WITH_BLOCKING_REASON');
      notes.push(`judge ${evaluation.judgeId}: accept cited a blocking reason; read as defer`);
    }
    for (const flag of evaluation.flags) if (flag === 'APPEALS_TO_PUBLIC_BENCHMARK') notes.push(`judge ${evaluation.judgeId}: justification appeals to the public benchmark, not the packet`);
    decisions.push(decision);
    confidences.push(evaluation.confidence ?? 'low');
    evaluation.reasonCodes.forEach(addReason);
  }
  while (decisions.length + cascaded < input.judgesConfigured) decisions.push('defer');
  let stage: Decision = decisions.length && decisions.every(decision => decision === decisions[0]) ? decisions[0]! : 'defer';
  if (!decisions.length) stage = 'defer';
  if (decisions.length > 1 && new Set(decisions).size > 1) notes.push(`judges disagree (${decisions.join(' / ')}); an accept needs all of them`);

  // 2. Adversarial pass: only lowers. An accept without a completed pass is not an accept. Deterministic attacks (E5-03) lower whatever happened to the adversary call.
  let adversarialPass: AdversarialPass = input.attackScope === 'NONE' ? 'NOT_RUN' : 'NOT_NEEDED';
  const sustained = adversary.attacks.filter(attack => attack.outcome === 'SUSTAINED' && (attack.source === 'DETERMINISTIC' || adversary.status === 'COMPLETED'));
  for (const attack of sustained) { stage = lowerOf(stage, attack.recommend === 'reject' ? 'reject' : 'defer'); addReason(FAMILY_REASON[attack.family]); }
  if (sustained.some(attack => attack.source === 'DETERMINISTIC')) notes.push(`deterministic attack ${sustained.filter(attack => attack.source === 'DETERMINISTIC').map(attack => attack.family).join(', ')} computed from the packet`);
  if (adversary.status === 'COMPLETED') {
    adversarialPass = 'COMPLETED';
    for (const attack of adversary.attacks.filter(item => item.outcome === 'UNGROUNDED')) notes.push(`attack ${attack.family} discarded: cites evidence that is not in the packet`);
    for (const attack of adversary.attacks.filter(item => item.outcome === 'REFUTED')) notes.push(`attack ${attack.family} refuted: every sibling it cites is excluded by the packet (target not globally unique, role of one dimension, or a decisive tie-break)`);
  } else if (adversary.status !== 'NOT_NEEDED' && adversary.status !== 'SKIPPED_BY_CASCADE') {
    adversarialPass = 'INCOMPLETE';
    if (stage === 'accept') { stage = 'defer'; notes.push(`adversarial pass ${adversary.status}; an accept without it is deferred`); }
  } else if (stage === 'accept' && floor.cap === 'accept' && input.attackScope !== 'NONE') {
    // Defensive: the reviewer always runs the adversary before an accept can stand.
    stage = 'defer'; adversarialPass = 'INCOMPLETE'; notes.push('no adversarial pass ran for an accept; deferred');
  }

  // 3. Evidence floor: a ceiling, never a raise.
  const decision = lowerOf(stage, floor.cap);
  if (decision !== stage) notes.push(`evidence floor caps the decision at ${floor.cap}`);
  floor.reasons.forEach(addReason); floor.annotations.forEach(addReason);

  const flagged = evaluations.some(evaluation => evaluation.flags.includes('APPEALS_TO_PUBLIC_BENCHMARK'));
  // No judge answered because the evidence itself rejects (missing keys): the floor is a measurement, so the confidence in "reject" is high.
  let confidence: Confidence = confidences.length ? confidences.reduce(lowerConfidence) : !evaluations.length && floor.cap === 'reject' ? 'high' : 'low';
  confidence = lowerConfidence(confidence, confidenceCeiling(floor));
  if (flagged) confidence = lowerConfidence(confidence, 'medium');
  if (decisions.length > 1 && new Set(decisions).size > 1) confidence = lowerConfidence(confidence, 'low');
  if (!reasons.length) addReason('SEMANTICS_NOT_ESTABLISHED');

  return {
    schemaVersion: MODEL_REVIEW_SCHEMA_VERSION, kind: 'MODEL_ADVERSARIAL_REVIEW', origin: MODEL_REVIEWED, provenance: input.provenance,
    label: adversarialPass === 'COMPLETED' ? MODEL_REVIEW_LABEL : MODEL_REVIEW_LABEL_NO_ADVERSARIAL,
    relationId: packet.relationId, from: { table: packet.source.table, column: packet.source.column }, to: { table: packet.target.table, column: packet.target.column },
    decision, confidence, reasons, notes, floor, evaluations, adversary, adversarialPass,
    attacksSurvived: adversary.attacks.filter(attack => attack.outcome === 'SURVIVED' || attack.outcome === 'UNGROUNDED' || attack.outcome === 'REFUTED'),
    attacksSustained: sustained,
    boundedSampleOnly: true, humanReviewed: false, calls: input.calls, tokens: input.tokens
  };
}
