/**
 * Round 10 E5-08: when the token budget cuts a review run, what is left unreviewed should be the least promising, not whatever came last in the list. The order is a pure function of
 * the packet's structure: key class (a key candidate before key-to-key before both sides duplicated), a declared target key, name affinity between the source column and the
 * target table, and no competing siblings. Ties keep the input order. The order decides who is reviewed first, never what a review decides.
 */
import { nameAffinity } from './names.ts';
import type { PriorityEntry, ReviewPacket } from './types.ts';

const KEY_CLASS_RANK: Record<string, number> = { KEY_CANDIDATE: 0, KEY_TO_KEY: 1, UNKNOWN: 1, BOTH_SIDES_DUPLICATED: 2 };

export function reviewPriority(packets: readonly ReviewPacket[]): PriorityEntry[] {
  const rows = packets.map((packet, index) => {
    const keyClass = packet.structure?.rankClass ?? 'UNKNOWN', declared = packet.structure?.targetDeclaredKey === true;
    return { index, entry: { relationId: packet.relationId, rank: 0, keyClass, targetDeclaredKey: declared, nameAffinity: nameAffinity(packet.source.column, packet.target.table), siblings: packet.siblings.filter(sibling => sibling.shares === 'SOURCE').length } };
  });
  rows.sort((a, b) => (KEY_CLASS_RANK[a.entry.keyClass] ?? 1) - (KEY_CLASS_RANK[b.entry.keyClass] ?? 1) || Number(b.entry.targetDeclaredKey) - Number(a.entry.targetDeclaredKey)
    || b.entry.nameAffinity - a.entry.nameAffinity || a.entry.siblings - b.entry.siblings || a.index - b.index);
  return rows.map((row, position) => ({ ...row.entry, rank: position + 1 }));
}
