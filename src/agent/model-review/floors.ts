/**
 * Evidence floors: a deterministic ceiling on what any judge may accept, computed from the packet alone. A model can lower below the floor, never above it.
 * They mirror what the decision policy already refuses (missing keys, too few distinct keys, non-unique target, conflicting labels), so a model review cannot
 * smuggle through a relation the evidence itself blocks. What the floors cannot see is semantics: that is the part the judges and the adversary carry.
 */
import { sourceKeysBasisText, lowerOf, type Confidence, type Decision, type FloorResult, type ReasonCode, type ReviewPacket } from './types.ts';

export function evidenceFloor(packet: ReviewPacket): FloorResult {
  let cap: Decision = 'accept';
  const reasons: ReasonCode[] = [], annotations: ReasonCode[] = [], notes: string[] = [];
  const lower = (to: Decision, reason: ReasonCode, note: string) => { cap = lowerOf(cap, to); if (!reasons.includes(reason)) reasons.push(reason); notes.push(note); };

  if (packet.keyRules.inclusion === 'VIOLATION_OBSERVED' || packet.keyRules.missingCount > 0 || packet.coverage.level === 'NONE' && packet.coverage.probed > 0) {
    lower('reject', 'KEY_MEMBERSHIP_CONTRADICTED', `${packet.keyRules.missingCount} of ${packet.coverage.probed} probed source keys are absent from the target sample`);
  } else if (packet.coverage.level === 'LOW') {
    lower('defer', 'KEY_MEMBERSHIP_PARTIAL', `coverage ${packet.coverage.matched} of ${packet.coverage.probed} is below the threshold`);
  }
  if (packet.keyRules.inclusion === 'UNKNOWN' || packet.coverage.probed === 0) lower('defer', 'NO_EVIDENCE', 'no usable key-membership measurement');
  if (packet.sourceKeys.distinctKeys < packet.minDistinctKeys) {
    lower('defer', 'INSUFFICIENT_DISTINCT_KEYS', `${packet.sourceKeys.distinctKeys} distinct source keys (${sourceKeysBasisText(packet.sourceKeys)}), below the minimum of ${packet.minDistinctKeys}`);
  } else if (packet.sourceKeys.distinctKeys === packet.minDistinctKeys) {
    annotations.push('AT_MINIMUM_KEYS'); notes.push(`exactly the minimum of ${packet.minDistinctKeys} distinct keys (${sourceKeysBasisText(packet.sourceKeys)}): the name decides, the evidence does not discriminate`);
  }
  if (packet.target.globalUniqueness === 'NOT_UNIQUE') lower('reject', 'TARGET_NOT_UNIQUE', 'the target column was measured NOT unique over the whole table: it cannot be the target of a foreign key');
  else if (packet.keyRules.targetUniqueness === 'DUPLICATES_OBSERVED') lower('defer', 'TARGET_NOT_UNIQUE', `${packet.keyRules.duplicateKeyCount} duplicated target keys in the sample (max ${packet.targetKeys.maxRowsPerKey} rows per key)`);
  if (packet.labels.signal === 'LABEL_CONFLICT') lower('reject', 'LABELS_CONFLICT', 'label columns conflict across the pair');
  else if (packet.labels.signal === 'LABEL_UNCERTAIN') lower('defer', 'SEMANTICS_NOT_ESTABLISHED', 'label agreement is uncertain');
  if (packet.negativeControl.some(entry => entry.passedMembership === true)) {
    annotations.push('EVIDENCE_NOT_DISCRIMINATING'); notes.push('an alternative endpoint probed for the same column also passed key membership: membership does not tell them apart');
  }
  if (packet.oneToOne) {
    annotations.push('ONE_TO_ONE_EXTENSION'); notes.push('both ends are unique over the whole table: this may be a one-to-one extension, uniqueness cannot fix the direction, the names decide');
  }
  return { cap, reasons, annotations, notes };
}

/** Confidence ceiling implied by the annotations: when the evidence does not discriminate, no one gets to be "high". */
export function confidenceCeiling(floor: FloorResult): Confidence {
  return floor.annotations.length ? 'medium' : 'high';
}
