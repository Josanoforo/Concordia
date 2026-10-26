/**
 * Round 10 / X10 (E2-03). Global consistency post-pass over APPROVED edges, before the contract probes (Auto-BI 2023, Chen 2014, HoPF 2020, T36 of the external research).
 * Pure: no I/O, no SQL, no model calls, no gold. It never lowers a verdict: a demoted edge simply gets no contract, and X5 leaves it out with the rule, the winner and the reason.
 *
 * Rules, applied in this order (each uses the declared tie-break steps of tie-break.ts, with the approved edges as the candidate set):
 *   TRANSITIVE  S.c -> B.k, B.k -> A.k and S.c -> A.k all hold: the two edges of S.c compete; the one the evidence separates (name, cardinality) or, failing that, the one with the more
 *               central target is kept. B.k -> A.k is untouched.
 *   FK_ONCE     at most one target per source column, unless the (source, target) pair is a declared alias. Edges of one source column compete.
 *   CYCLE       no cycle among COLUMNS (a.x -> b.y -> ... -> a.x): the weakest edge of each cycle is demoted. Cycles are over columns, not tables: customer.store_id -> store and
 *               store.manager_id -> customer is a legitimate table-level loop and stays. Nothing assumes the schema is a tree.
 * NOT implemented on purpose: "one FK per table pair" (it breaks pickup/dropoff to the same zone table).
 *
 * Conservative by construction: when the declared steps do not separate the competing edges, NOTHING is demoted; the conflict is reported in `unresolved` and every edge stays kept.
 */
import { orderTies, weakestOf, type Endpoint, type TieCandidate } from './tie-break.ts';

export type ConsistencyRule = 'FK_ONCE' | 'CYCLE' | 'TRANSITIVE';

/** An approved edge. It is a TieCandidate: the profiles and `reachesHigh` feed the vector. `id` must be unique in the call. */
export type ConsistencyEdge = TieCandidate;

/** A source column that may legitimately reference several targets (documented alias in config). `source` is `table.column`; each target is `table.column` or just `table`. */
export interface AliasDeclaration { source: string; targets: readonly string[] }

export interface DemotedEdge<T extends ConsistencyEdge = ConsistencyEdge> {
  edge: T; rule: ConsistencyRule;
  /** The edge that stays instead (the other direction of a 2-cycle, the strongest edge left in a longer cycle). Null only when a cycle's remaining edges do not separate. */
  winner: string | null;
  reason: string;
}
export interface UnresolvedConflict { rule: ConsistencyRule; edges: string[]; reason: string }

export interface ConsistencyResult<T extends ConsistencyEdge = ConsistencyEdge> {
  kept: T[];
  demoted: DemotedEdge<T>[];
  /** Conflicts the evidence does not separate. Every edge involved stays in `kept` (nothing is dropped on a coin flip). */
  unresolved: UnresolvedConflict[];
}

const node = (e: Endpoint): string => `${e.db ? `${e.db}.` : ''}${e.table}.${e.column}`;
const plain = (e: Endpoint): string => `${e.table}.${e.column}`;
const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id, 'en');

function aliasedPairs(aliases: readonly AliasDeclaration[] | undefined): (edge: ConsistencyEdge) => boolean {
  const table = new Map<string, Set<string>>();
  for (const alias of aliases ?? []) table.set(alias.source, new Set([...(table.get(alias.source) ?? []), ...alias.targets]));
  return edge => { const targets = table.get(plain(edge.from)); return !!targets && (targets.has(plain(edge.to)) || targets.has(edge.to.table)); };
}

/** First cycle of the column graph (as its edges in order), or null. Deterministic: nodes and edges are visited in sorted order. */
function findCycle(edges: readonly ConsistencyEdge[]): ConsistencyEdge[] | null {
  const out = new Map<string, ConsistencyEdge[]>();
  for (const edge of [...edges].sort(byId)) out.set(node(edge.from), [...(out.get(node(edge.from)) ?? []), edge]);
  const state = new Map<string, 1 | 2>(), pathNodes: string[] = [], pathEdges: ConsistencyEdge[] = [];
  const visit = (current: string): ConsistencyEdge[] | null => {
    state.set(current, 1); pathNodes.push(current);
    for (const edge of out.get(current) ?? []) {
      const next = node(edge.to), seen = state.get(next);
      if (seen === 1) return [...pathEdges.slice(pathNodes.indexOf(next)), edge];
      if (seen === 2) continue;
      pathEdges.push(edge);
      const found = visit(next);
      if (found) return found;
      pathEdges.pop();
    }
    pathNodes.pop(); state.set(current, 2);
    return null;
  };
  for (const start of [...out.keys()].sort((a, b) => a.localeCompare(b, 'en'))) if (!state.has(start)) { const found = visit(start); if (found) return found; }
  return null;
}

export function enforceConsistency<T extends ConsistencyEdge>(edges: readonly T[], options?: { aliases?: readonly AliasDeclaration[] }): ConsistencyResult<T> {
  const ids = new Set<string>();
  for (const edge of edges) { if (ids.has(edge.id)) throw new Error(`CONSISTENCY_DUPLICATE_EDGE_ID: ${edge.id}`); ids.add(edge.id); }
  const aliased = aliasedPairs(options?.aliases);
  const alive = new Set(edges.map(edge => edge.id)), demoted: DemotedEdge<T>[] = [], unresolved: UnresolvedConflict[] = [];
  const live = (): T[] => edges.filter(edge => alive.has(edge.id));
  const reported = new Set<string>();
  const report = (rule: ConsistencyRule, group: readonly T[], reason: string): void => {
    const edgeIds = group.map(edge => edge.id).sort((a, b) => a.localeCompare(b, 'en')), signature = `${rule}|${edgeIds.join('|')}`;
    if (!reported.has(signature)) { reported.add(signature); unresolved.push({ rule, edges: edgeIds, reason }); }
  };
  const demote = (loser: T, rule: ConsistencyRule, winner: string | null, why: string): void => {
    alive.delete(loser.id);
    demoted.push({ edge: loser, rule, winner, reason: `${rule}: ${loser.id} demoted${winner ? ` in favour of ${winner}` : ''}; ${why}` });
  };

  // TRANSITIVE: S.c -> B.k, B.k -> A.k, S.c -> A.k. Restart the scan after each demotion.
  const blockedTransitive = new Set<string>();
  for (;;) {
    const current = live();
    let pair: [T, T] | null = null;
    for (const direct of [...current].sort(byId)) {
      if (aliased(direct)) continue;
      for (const via of current.filter(edge => node(edge.from) === node(direct.from) && edge.id !== direct.id && node(edge.to) !== node(direct.to) && !aliased(edge)).sort(byId)) {
        const closes = current.some(link => node(link.from) === node(via.to) && node(link.to) === node(direct.to));
        // `via` goes S -> B, `direct` goes S -> A, `link` goes B -> A.
        if (closes && !blockedTransitive.has([direct.id, via.id].sort().join('|'))) { pair = [direct, via]; break; }
      }
      if (pair) break;
    }
    if (!pair) break;
    const ordering = orderTies(pair, { candidates: current });
    if (!ordering.decisive) { blockedTransitive.add([pair[0].id, pair[1].id].sort().join('|')); report('TRANSITIVE', pair, ordering.reason); continue; }
    const winner = ordering.ordered[0]!, loser = ordering.ordered[1]!;
    demote(loser, 'TRANSITIVE', winner.id, ordering.reason);
  }

  // FK_ONCE: one target per source column (declared aliases are exempt).
  const bySource = new Map<string, T[]>();
  for (const edge of live()) if (!aliased(edge)) bySource.set(node(edge.from), [...(bySource.get(node(edge.from)) ?? []), edge]);
  for (const key of [...bySource.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    const group = bySource.get(key)!.filter(edge => alive.has(edge.id));
    if (group.length < 2) continue;
    if (group.length === 2 && blockedTransitive.has(group.map(edge => edge.id).sort().join('|'))) continue;
    const ordering = orderTies(group, { candidates: live() });
    if (!ordering.decisive) { report('FK_ONCE', group, ordering.reason); continue; }
    const winner = ordering.ordered[0]!;
    for (const loser of ordering.ordered.slice(1)) demote(loser, 'FK_ONCE', winner.id, ordering.reason);
  }

  // CYCLE: over columns. A cycle the evidence cannot break stays whole and is reported; its edges leave the cycle search so the loop ends.
  const searchable = new Set(alive);
  for (;;) {
    const cycle = findCycle(live().filter(edge => searchable.has(edge.id))) as T[] | null;
    if (!cycle) break;
    const weakest = weakestOf(cycle, { candidates: live() });
    if (!weakest.decisive) { report('CYCLE', cycle, `NOT_DECISIVE: ${weakest.survivors.map(edge => edge.id).join(', ')} stay tied as the weakest edge of the cycle`); for (const edge of cycle) searchable.delete(edge.id); continue; }
    const loser = weakest.survivors[0]!, rest = cycle.filter(edge => edge.id !== loser.id);
    const strongest = rest.length ? orderTies(rest, { candidates: live() }) : null;
    demote(loser, 'CYCLE', strongest?.decisive ? strongest.ordered[0]!.id : null, `weakest edge of the cycle ${cycle.map(edge => edge.id).join(' -> ')} (decided by ${weakest.decidedBy})`);
    searchable.delete(loser.id);
  }

  return { kept: live(), demoted, unresolved };
}
