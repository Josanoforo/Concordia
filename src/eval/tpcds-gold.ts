import { readJson } from '../runtime.ts';

/**
 * Evaluation-only scoring of blind relation candidates against the TPC-DS foreign-key gold (eval/gold/TPCDS_fk_gold.json).
 * This module is the ONLY reader of that file. The agent runtime never imports it, and the gold never reaches a prompt, a catalog or a universe config.
 */
export interface TpcdsGold {
  schemaVersion: 1; kind: 'TPCDS_FK_GOLD'; direction: string;
  edges: { id: string; from: { table: string; column: string }; to: { table: string; column: string } }[];
  compositeEdges: { id: string; from: { table: string; columns: string[] }; to: { table: string; columns: string[] } }[];
  homonymTraps: { id: string; a: { table: string; column: string }; b: { table: string; column: string }; reason: string; /** Run after which the trap was added: it was not predeclared for that run and must not be read as predicted. */ addedAfter?: string }[];
}
export interface CandidateEdge { from: { table: string; column: string }; to: { table: string; column: string } }

export const loadTpcdsGold = (): TpcdsGold => readJson<TpcdsGold>('eval/gold/TPCDS_fk_gold.json');
const key = (edge: CandidateEdge) => `${edge.from.table}.${edge.from.column}->${edge.to.table}.${edge.to.column}`;
const pair = (a: { table: string; column: string }, b: { table: string; column: string }) => [`${a.table}.${a.column}`, `${b.table}.${b.column}`].sort().join('~');

/**
 * Precision and recall with their denominators, plus the homonym traps the candidates fell for.
 * Single-column candidates are scored against single-column gold edges (direction matters; a reversed edge is reported, not counted as correct).
 * Composite gold edges are listed with their count and are not scored by single-column candidates.
 */
export function scoreTpcdsCandidates(candidates: readonly CandidateEdge[], gold: TpcdsGold = loadTpcdsGold()) {
  const unique = [...new Map(candidates.map(candidate => [key(candidate), candidate])).values()];
  const goldKeys = new Set(gold.edges.map(key)), reversedKeys = new Set(gold.edges.map(edge => key({ from: edge.to, to: edge.from })));
  const trapPairs = new Map(gold.homonymTraps.map(trap => [pair(trap.a, trap.b), trap.id]));
  const truePositives = unique.filter(candidate => goldKeys.has(key(candidate))), reversed = unique.filter(candidate => reversedKeys.has(key(candidate)));
  const trapsProposed = [...new Set(unique.flatMap(candidate => trapPairs.has(pair(candidate.from, candidate.to)) ? [trapPairs.get(pair(candidate.from, candidate.to))!] : []))];
  const falsePositives = unique.filter(candidate => !goldKeys.has(key(candidate)));
  const found = new Set(truePositives.map(key));
  return {
    candidates: unique.length, goldEdges: gold.edges.length, truePositives: truePositives.length, falsePositives: falsePositives.length,
    precision: unique.length ? truePositives.length / unique.length : null, precisionReason: unique.length ? null : 'NO_CANDIDATES',
    recall: gold.edges.length ? truePositives.length / gold.edges.length : null,
    reversed: reversed.map(key), trapsProposed, trapsInGold: gold.homonymTraps.length, trapsPredeclared: gold.homonymTraps.filter(trap => !trap.addedAfter).length,
    trapsProposedPredeclared: trapsProposed.filter(id => !gold.homonymTraps.find(trap => trap.id === id)?.addedAfter), trapsProposedAddedAfter: trapsProposed.filter(id => gold.homonymTraps.find(trap => trap.id === id)?.addedAfter),
    missed: gold.edges.filter(edge => !found.has(edge.id)).map(edge => edge.id),
    composite: { goldEdges: gold.compositeEdges.length, scored: false, note: 'composite foreign keys are not scored by single-column candidates' }
  };
}
