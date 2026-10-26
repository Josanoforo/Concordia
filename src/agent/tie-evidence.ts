import type { Cell } from '../clients/zetaris.ts';
import { cachedProfile, measureColumnProfile, type ProfileCache } from '../probe/column-profile.ts';
import type { GlobalTiming } from '../probe/global-timing.ts';
import { zetarisTableSpecs } from '../relations/adapters/zetaris.ts';
import type { RunBudget } from './run-budget.ts';

/**
 * Tie evidence (R-1). Two HIGH-coverage, unsuspected candidates that share a source column are a tie: key membership alone cannot tell them apart (album.ArtistId reaches
 * artist.ArtistId 15/15 and playlist_track.TrackId 15/15). What separates a key from a non-key is global uniqueness of the target column, so for each distinct target column of a tie
 * the engine runs form F1 once (1 query, already allowed by the read guard) and hands the counts to the reviewer. It decides nothing: counts only, charged to the budget, and
 * skipped (and said so) when the budget does not reach.
 */
/** min, max and avgLen only when the profile was the extended one (F1x). */
export interface TargetGlobalUniqueness { rows: number; distinct: number; nulls: number; unique: boolean; min?: Cell; max?: Cell; avgLen?: number }
export interface Tie { source: string; candidates: string[] }
export interface TieEvidence {
  ties: Tie[];
  /** `table.column` of every distinct target column of a tie. */
  targets: string[];
  measured: Record<string, TargetGlobalUniqueness>;
  notMeasured: { target: string; reason: 'QUERY_BUDGET_INSUFFICIENT' | 'COLUMN_OUTSIDE_CONFIG' | 'QUERY_FAILED' | 'MALFORMED_RESPONSE' | 'TIMEOUT' | 'TIME_BUDGET_EXHAUSTED' }[];
  /** Scans actually sent. */
  queries: number;
  /** Targets served from the per-run profile cache (E1-06): measured, no query, no budget. */
  cached: string[];
}

const endpointKey = (e: { table: string; column: string }) => `${e.table}.${e.column}`;
const high = (proposal: any) => proposal?.coverageProbe?.status === 'EXECUTED' && proposal.coverageProbe.diagnostic?.coverage?.level === 'HIGH' && !proposal.coverageProbe.diagnostic?.suspect?.value;

/** The ties among HIGH, unsuspected candidates: groups of two or more that share a source column. */
export function findTies(proposals: readonly any[]): { ties: Tie[]; targets: string[] } {
  const bySource = new Map<string, any[]>();
  for (const proposal of proposals) if (high(proposal) && proposal.from && proposal.to) bySource.set(endpointKey(proposal.from), [...(bySource.get(endpointKey(proposal.from)) ?? []), proposal]);
  const ties = [...bySource.entries()].filter(([, group]) => group.length > 1).map(([source, group]) => ({ source, candidates: group.map(item => String(item.proposalId)).sort() })).sort((x, y) => x.source.localeCompare(y.source, 'en'));
  const targets = [...new Set(ties.flatMap(tie => bySource.get(tie.source)!.map(item => endpointKey(item.to))))].sort((x, y) => x.localeCompare(y, 'en'));
  return { ties, targets };
}

/** Runs F1 (profileSql) once per distinct target column of a tie, through the budgeted client, and reports what it measured and what it could not. */
export async function measureTieEvidence(input: { cfg: any; client: { runSql: (sql: string, limit?: number) => Promise<{ rows: unknown[][]; requestId?: string; queryId?: string; durationMs?: number }> }; budget: RunBudget; proposals: readonly any[]; /** Per-run profile cache shared with measureFullEvidence: a target already profiled in this run is not scanned again. */ cache?: ProfileCache; /** Manifest `fullEvidence.extendedProfile: true`: F1x instead of F1. */ extendedProfile?: boolean; /** C3: global-evidence time policy shared with measureFullEvidence. */ timing?: GlobalTiming }): Promise<TieEvidence> {
  const { ties, targets } = findTies(input.proposals);
  const evidence: TieEvidence = { ties, targets, measured: {}, notMeasured: [], queries: 0, cached: [] };
  if (!targets.length) return evidence;
  const specs = zetarisTableSpecs(input.cfg);
  for (const target of targets) {
    const [table, ...rest] = target.split('.'), column = rest.join('.');
    const spec = specs[table], config = input.cfg.tables?.[table];
    if (!spec || !config || !(config.columns ?? []).some((item: any) => item.name === column)) { evidence.notMeasured.push({ target, reason: 'COLUMN_OUTSIDE_CONFIG' }); continue; }
    const endpoint = { table, column, spec }, extended = input.extendedProfile === true;
    // A profile already measured in this run costs nothing; only a scan that has to be sent needs the budget.
    if (!cachedProfile(input.cache, endpoint, extended) && !input.budget.canQuery(1)) { evidence.notMeasured.push({ target, reason: 'QUERY_BUDGET_INSUFFICIENT' }); continue; }
    const { profile, query, failed } = await measureColumnProfile({ client: input.client as any, endpoint, extended, cache: input.cache, timing: input.timing });
    if (query.cached) evidence.cached.push(target); else if (query.ok || query.sql) evidence.queries += failed ? 2 : 1;
    if (profile.provenance === 'NOT_MEASURED') { evidence.notMeasured.push({ target, reason: profile.reason === 'MALFORMED_RESPONSE' || profile.reason === 'COLUMN_OUTSIDE_CONFIG' || profile.reason === 'TIMEOUT' || profile.reason === 'TIME_BUDGET_EXHAUSTED' ? profile.reason : 'QUERY_FAILED' }); continue; }
    evidence.measured[target] = { rows: profile.rows, distinct: profile.distinct, nulls: profile.nulls, unique: profile.distinct === profile.rows - profile.nulls, ...(profile.min !== undefined ? { min: profile.min } : {}), ...(profile.max !== undefined ? { max: profile.max } : {}), ...(profile.avgLen !== undefined ? { avgLen: profile.avgLen } : {}) };
  }
  return evidence;
}
