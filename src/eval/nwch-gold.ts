import { readJson } from '../runtime.ts';
import { scoreTpcdsCandidates, type CandidateEdge, type TpcdsGold } from './tpcds-gold.ts';

/**
 * Evaluation-only gold for the NWCH blind check (Northwind + Chinook): 3 true foreign keys, the cross-schema homonym traps and the orphan columns that have no parent.
 * This module is the ONLY reader of eval/gold/NWCH_fk_gold.json. The agent runtime never imports it and the gold never reaches a prompt, a catalog or a universe config.
 * Scoring reuses the TPC-DS scorer (same edge and trap shapes) and adds the orphan check.
 */
export interface NwchGold extends TpcdsGold { orphans: { table: string; column: string; reason: string }[] }
export const loadNwchGold = (): NwchGold => readJson<NwchGold>('eval/gold/NWCH_fk_gold.json');

/** A candidate that touches an orphan column on either side is an invented relation: the orphans must have no relation at all. */
export function orphanViolations(candidates: readonly CandidateEdge[], gold: NwchGold = loadNwchGold()): string[] {
  const orphan = new Set(gold.orphans.map(item => `${item.table}.${item.column}`));
  return [...new Set(candidates.flatMap(candidate => {
    const from = `${candidate.from.table}.${candidate.from.column}`, to = `${candidate.to.table}.${candidate.to.column}`;
    return orphan.has(from) || orphan.has(to) ? [`${from}->${to}`] : [];
  }))];
}

export function scoreNwchCandidates(candidates: readonly CandidateEdge[], gold: NwchGold = loadNwchGold()) {
  return { ...scoreTpcdsCandidates(candidates, gold), orphans: gold.orphans.length, orphanViolations: orphanViolations(candidates, gold) };
}
