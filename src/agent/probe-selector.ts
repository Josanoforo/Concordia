import type { ActionChooser, ChoiceCall } from './chooser.ts';
import type { RunBudget } from './run-budget.ts';

/** A configured relation probe reads both endpoints once: two bounded SQL statements. */
export const PROBE_QUERY_COST = 2;
export interface ProbeSelection { selected: string[]; skipped: { relationId: string; reason: string }[]; calls: ChoiceCall[]; mode: 'ALL_AFFORDABLE' | 'CHOSEN' | 'CHOSEN_WITH_FALLBACK'; fallback?: { reason: string; used?: number; estimated?: number; limit?: number } }

/**
 * Chooses which configured relation probes to run inside the remaining query budget.
 * Without a chooser every affordable relation runs in config order (the product default);
 * with a chooser the model ranks fixed PROBE:<id> options and can stop early. It never supplies SQL.
 * A valid STOP is honored. If a decision is unusable (invalid, unknown id, token budget spent) the remaining affordable
 * relations run in config order and the selection is labeled CHOSEN_WITH_FALLBACK: an unusable answer must not silently drop probes.
 */
export async function selectProbes(o: { relations: readonly { id: string }[]; budget: RunBudget; chooser?: ActionChooser; observation?: unknown }): Promise<ProbeSelection> {
  const selected: string[] = [], skipped: ProbeSelection['skipped'] = [], calls: ChoiceCall[] = [];
  const remaining = o.relations.map(relation => relation.id);
  let reserved = 0;
  const affordable = () => remaining.filter(id => o.budget.canQuery(reserved + PROBE_QUERY_COST));
  if (!o.chooser) {
    for (const id of remaining) {
      if (o.budget.canQuery(reserved + PROBE_QUERY_COST)) { selected.push(id); reserved += PROBE_QUERY_COST; } else skipped.push({ relationId: id, reason: 'QUERY_BUDGET_INSUFFICIENT' });
    }
    return { selected, skipped, calls, mode: 'ALL_AFFORDABLE' };
  }
  let fallback: ProbeSelection['fallback'];
  while (remaining.length) {
    const options = affordable();
    if (!options.length) break;
    if (!o.budget.canAskModel()) { fallback = { reason: 'TOKEN_BUDGET_EXHAUSTED' }; break; }
    const stage = `select_probe_${selected.length + 1}`, observation = { ...(o.observation as object ?? {}), remainingRelations: options, reservedQueries: reserved }, allowed = [...options.map(id => `PROBE:${id}`), 'STOP_EXPLORATION'];
    const estimated = o.chooser.estimateTokens?.(stage, observation, allowed);
    if (estimated !== undefined && !o.budget.canAfford(estimated)) { const { used, limit } = o.budget.wouldExceed(estimated); fallback = { reason: 'TOKEN_BUDGET_WOULD_EXCEED', used, estimated, limit }; break; }
    const call = await o.chooser.choose(stage, observation, allowed);
    calls.push(call);
    o.budget.chargeTokens(call.receipt?.totalTokens ?? 0);
    if (call.decisionStatus !== 'VALID' || !call.selected) { fallback = { reason: 'DECISION_UNUSABLE' }; break; }
    if (call.selected === 'STOP_EXPLORATION') break;
    const id = call.selected.replace(/^PROBE:/, '');
    if (!options.includes(id)) { fallback = { reason: 'PROBE_ID_NOT_OFFERED' }; break; }
    selected.push(id); reserved += PROBE_QUERY_COST; remaining.splice(remaining.indexOf(id), 1);
  }
  if (fallback) {
    for (const id of [...remaining]) if (o.budget.canQuery(reserved + PROBE_QUERY_COST)) { selected.push(id); reserved += PROBE_QUERY_COST; remaining.splice(remaining.indexOf(id), 1); }
  }
  for (const id of remaining) skipped.push({ relationId: id, reason: o.budget.canQuery(reserved + PROBE_QUERY_COST) ? 'NOT_SELECTED' : 'QUERY_BUDGET_INSUFFICIENT' });
  return fallback ? { selected, skipped, calls, mode: 'CHOSEN_WITH_FALLBACK', fallback } : { selected, skipped, calls, mode: 'CHOSEN' };
}
