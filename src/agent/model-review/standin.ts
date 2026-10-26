/**
 * Offline stand-in models for the reviewer. They are deterministic functions of the packet in the prompt (nothing else: no labels, no gold), and they answer
 * in the exact JSON a live model must produce, so the whole path (prompt, parse, budget, trace, aggregation) is exercised without a generation.
 *
 * They are NOT evidence about model quality. `kind` is STAND_IN_OFFLINE, which marks every review they produce so it can never fill a MODEL_ADVERSARIAL slot
 * in a live run. Agreement measured with them (see evaluation.ts) tests the pipeline and its floors; agreement of a live model is measured separately and
 * needs an approved run.
 *   SEMANTIC       judge reads names (entity of the source column vs the target table) and evidence.
 *   EVIDENCE_ONLY  judge reads evidence only: it behaves like the policy's bounded key membership, which cannot tell a homonym apart (the live negative control).
 *   adversary      attacks from names, siblings, negative control, keys and orientation.
 */
import { entityNamesTable, sourceEntity } from './names.ts';
import { estimateMessagesTokens } from './prompts.ts';
import type { AttackFamily, AttackRecommend, AttackSeverity, Confidence, Decision, ModelMessage, ReasonCode, ReviewCall, ReviewModel, ReviewPacket } from './types.ts';

export { sourceEntity, entityNamesTable } from './names.ts';

const evidenceOk = (packet: ReviewPacket) => packet.keyRules.inclusion === 'NO_VIOLATION_IN_SAMPLE' && packet.keyRules.missingCount === 0 && packet.coverage.level === 'HIGH'
  && packet.sourceKeys.distinctKeys >= packet.minDistinctKeys && packet.keyRules.targetUniqueness !== 'DUPLICATES_OBSERVED';
const membershipOk = (packet: ReviewPacket) => packet.keyRules.inclusion === 'NO_VIOLATION_IN_SAMPLE' && packet.coverage.level === 'HIGH';

function packetFrom(messages: readonly ModelMessage[]): ReviewPacket {
  const user = JSON.parse(messages[1]!.content);
  return user.packet as ReviewPacket;
}

export type StandInJudgeKind = 'SEMANTIC' | 'EVIDENCE_ONLY';
export function judgeAnswer(kind: StandInJudgeKind, packet: ReviewPacket): string {
  const codes: ReasonCode[] = [];
  let decision: Decision, confidence: Confidence, rationale: string;
  const entity = sourceEntity(packet.source.column), nameMatches = entityNamesTable(entity, packet.target.table);
  const evidence = evidenceOk(packet);
  const weak = packet.sourceKeys.distinctKeys === packet.minDistinctKeys || packet.negativeControl.some(entry => entry.passedMembership === true);
  if (kind === 'SEMANTIC' && !nameMatches) {
    codes.push('NAME_ENTITY_MISMATCH'); if (membershipOk(packet)) codes.push('HOMONYM_RISK', 'EVIDENCE_NOT_DISCRIMINATING');
    decision = 'reject'; confidence = 'high';
    rationale = `The source column names the entity "${entity.join('_')}", the target table is "${packet.target.table}": different entity. Key membership alone does not make them the same.`;
  } else if (evidence) {
    if (kind === 'SEMANTIC') codes.push('NAME_ENTITY_MATCH');
    codes.push('KEY_MEMBERSHIP_COMPLETE', 'TARGET_UNIQUE_IN_SAMPLE'); if (packet.orientation === 'SWAPPED_TARGET_UNIQUE') codes.push('ORIENTATION_CONSISTENT');
    decision = 'accept'; confidence = weak ? 'medium' : 'high';
    rationale = `${kind === 'SEMANTIC' ? `Source column names "${entity.join('_')}", target table "${packet.target.table}". ` : ''}${packet.coverage.matched} of ${packet.coverage.probed} probed keys found; target unique in the sample.`;
  } else {
    if (packet.keyRules.inclusion === 'VIOLATION_OBSERVED' || packet.keyRules.missingCount > 0) { codes.push('KEY_MEMBERSHIP_CONTRADICTED'); decision = 'reject'; }
    else { codes.push(packet.sourceKeys.distinctKeys < packet.minDistinctKeys ? 'INSUFFICIENT_DISTINCT_KEYS' : packet.keyRules.targetUniqueness === 'DUPLICATES_OBSERVED' ? 'TARGET_NOT_UNIQUE' : 'SEMANTICS_NOT_ESTABLISHED'); decision = 'defer'; }
    confidence = 'medium'; rationale = 'The measured evidence does not support the relation.';
  }
  return JSON.stringify({ relationId: packet.relationId, decision, confidence, reasonCodes: codes, rationale });
}

export function attackAnswer(packet: ReviewPacket): string {
  const entity = sourceEntity(packet.source.column), nameMatches = entityNamesTable(entity, packet.target.table);
  type Attack = { family: AttackFamily; severity: AttackSeverity; recommend: AttackRecommend; argument: string; evidenceRefs: string[] };
  const attacks: Attack[] = [];
  const none = (family: AttackFamily): Attack => ({ family, severity: 'none', recommend: 'keep', argument: 'No attack found in the packet.', evidenceRefs: [] });

  const controlIndex = packet.negativeControl.findIndex(entry => entry.passedMembership === true);
  if (!nameMatches && membershipOk(packet)) {
    attacks.push({ family: 'HOMONYM', severity: 'blocking', recommend: 'reject', evidenceRefs: ['source.column', 'target.table', ...(controlIndex >= 0 ? [`negativeControl[${controlIndex}]`] : [])],
      argument: `The source column refers to "${entity.join('_')}", not to "${packet.target.table}"; the keys overlap but name a different entity.` });
  } else if (nameMatches && controlIndex >= 0) {
    attacks.push({ family: 'HOMONYM', severity: 'minor', recommend: 'keep', evidenceRefs: [`negativeControl[${controlIndex}]`],
      argument: 'Another endpoint also passed key membership for this column; the name alone separates them.' });
  } else attacks.push(none('HOMONYM'));

  const decided = packet.tieBreak?.decisive === true && packet.tieBreak.winner === 'THIS';
  const better = decided ? -1 : packet.siblings.findIndex(sibling => sibling.shares === 'SOURCE' && sibling.otherGlobalUniqueness !== 'NOT_UNIQUE' && !nameMatches && entityNamesTable(entity, sibling.other.table));
  if (better >= 0) attacks.push({ family: 'SIBLING', severity: 'blocking', recommend: 'reject', evidenceRefs: [`siblings[${better}]`], argument: `A sibling candidate on the same source column targets "${packet.siblings[better]!.other.table}", the entity the column names.` });
  else attacks.push(none('SIBLING'));

  return JSON.stringify({ relationId: packet.relationId, attacks });
}

let counter = 0;
/** Scripted model: `answer` gets the parsed prompt and returns the raw text. Receipts are synthetic (provider "standin"). */
export class StandInModel implements ReviewModel {
  readonly kind = 'STAND_IN_OFFLINE' as const;
  calls = 0;
  constructor(readonly id: string, private readonly answer: (messages: readonly ModelMessage[]) => string | ReviewCall) {}
  estimateTokens(messages: readonly ModelMessage[], maxOutputTokens: number) { return estimateMessagesTokens(messages, maxOutputTokens); }
  async complete(messages: readonly ModelMessage[], options: { maxOutputTokens: number }): Promise<ReviewCall> {
    this.calls++;
    const out = this.answer(messages);
    if (typeof out !== 'string') return out;
    const inputTokens = Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 2), outputTokens = Math.min(options.maxOutputTokens, Math.ceil(out.length / 2));
    return { status: 'PASS', responseText: out, receipt: { receiptId: `standin-${++counter}`, provider: 'standin', model: 'standin-offline', inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, latencyMs: 0, fromCache: false } };
  }
}
export const standInJudge = (id: string, kind: StandInJudgeKind) => new StandInModel(id, messages => judgeAnswer(kind, packetFrom(messages)));
export const standInAdversary = (id: string) => new StandInModel(id, messages => attackAnswer(packetFrom(messages)));
