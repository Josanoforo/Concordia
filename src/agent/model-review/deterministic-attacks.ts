/**
 * Round 10 E5-03: the attack families that the packet already decides are computed here, not argued by the adversary. INSUFFICIENT_KEYS reads the distinct source keys against
 * the minimum; INVERTED_ORIENTATION reads the key shapes and the measured global uniqueness of the target. The adversary model argues only HOMONYM and SIBLING, which need
 * semantics, so its prompt and its answer are shorter. These attacks need no evidence reference to be grounded: the packet itself is the evidence.
 */
import { sourceKeysBasisText, type AttackRecord, type ReviewPacket } from './types.ts';

type Draft = Pick<AttackRecord, 'severity' | 'recommend' | 'argument' | 'evidenceRefs'>;
const NONE: Draft = { severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] };
const outcomeOf = (severity: Draft['severity']): AttackRecord['outcome'] => (severity === 'blocking' ? 'SUSTAINED' : severity === 'minor' ? 'SURVIVED' : 'NO_ATTACK');

export function insufficientKeysAttack(packet: ReviewPacket): Draft {
  const keys = packet.sourceKeys.distinctKeys, minimum = packet.minDistinctKeys, basis = sourceKeysBasisText(packet.sourceKeys);
  if (keys < minimum) return { severity: 'blocking', recommend: 'defer', evidenceRefs: ['sourceKeys', 'minDistinctKeys'], argument: `${keys} distinct source keys (${basis}), below the minimum of ${minimum}.` };
  if (keys === minimum) return { severity: 'minor', recommend: 'keep', evidenceRefs: ['sourceKeys', 'minDistinctKeys'], argument: `Exactly the minimum of distinct keys (${basis}): the evidence has no margin.` };
  return NONE;
}

export function invertedOrientationAttack(packet: ReviewPacket): Draft {
  if (packet.target.globalUniqueness === 'NOT_UNIQUE') return { severity: 'blocking', recommend: 'reject', evidenceRefs: ['target.globalUniqueness'], argument: 'The target column was measured not unique over the whole table: it cannot be the referenced side.' };
  if (packet.structure?.sourceShape === 'UNIQUE_IN_SAMPLE' && packet.structure.targetShape === 'DUPLICATES_OBSERVED') return { severity: 'blocking', recommend: 'defer', evidenceRefs: ['structure'], argument: 'The target repeats keys and the source does not: the direction looks inverted.' };
  if (packet.oneToOne) return { severity: 'minor', recommend: 'keep', evidenceRefs: ['oneToOne'], argument: 'Both ends are unique over the whole table: uniqueness cannot fix the direction, the names do. A weakness, not a block.' };
  if (packet.orientation === 'SWAPPED_TARGET_UNIQUE' && packet.structure?.sourceShape === 'UNIQUE_IN_SAMPLE') return { severity: 'minor', recommend: 'keep', evidenceRefs: ['orientation', 'structure'], argument: 'Both sides look unique in the sample; the direction was fixed by structure and names.' };
  return NONE;
}

/** The two deterministic records, in the family order of the review (INSUFFICIENT_KEYS, INVERTED_ORIENTATION). */
export function deterministicAttacks(packet: ReviewPacket): AttackRecord[] {
  return ([['INSUFFICIENT_KEYS', insufficientKeysAttack(packet)], ['INVERTED_ORIENTATION', invertedOrientationAttack(packet)]] as const)
    .map(([family, draft]) => ({ family, ...draft, source: 'DETERMINISTIC' as const, tokens: 0, outcome: outcomeOf(draft.severity) }));
}
