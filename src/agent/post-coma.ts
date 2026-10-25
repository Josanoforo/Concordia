import { identifier, type Zetaris } from '../clients/zetaris.ts';
import type { OutOfScopeProposal } from '../discovery/candidates.ts';
import { zetarisSourceQuery } from '../relations/adapters/zetaris.ts';
import { failure, trace } from '../runtime.ts';
import { normalizeKey, type NormalizationMode } from '../universe.ts';
import { SAFE_LITERAL, type ExplorationCatalog } from './catalog.ts';
import type { RunBudget } from './run-budget.ts';

/** A coverage probe reads the target once: one bounded SQL statement. The source values come from the discovery sample. */
export const COVERAGE_PROBE_QUERY_COST = 1;
export const DEFAULT_POST_COMA = { maxProbes: 2 } as const;
export type CoverageProbeStatus = 'EXECUTED' | 'SUGGESTED' | 'NOT_EXECUTABLE' | 'SKIPPED_BUDGET' | 'FAILED';
export interface CoverageProbe {
  kind: 'COVERAGE_PROBE'; status: CoverageProbeStatus; reason?: string; sql?: string;
  result?: { sampledSourceValues: number; probedValues: number; targetMatches: number; ratio: number | null; rows: number; queryId: string; requestId: string;
    normalization?: { mode: NormalizationMode; source: 'RELATION' | 'UNIVERSE_DEFAULT'; relationId?: string; unnormalizableValues: number } };
  error?: object;
}
export interface PostComaProposal {
  proposalId: string; from: OutOfScopeProposal['from']; to: OutOfScopeProposal['to']; rawScore: number; reason: string;
  verificationStatus: 'NO VERIFICADO/UNKNOWN'; reviewState: 'PENDING'; coverageProbe: CoverageProbe;
}
export interface PostComaReport {
  status: 'NONE' | 'SUGGESTED_ONLY' | 'EXECUTED' | 'PARTIAL';
  policy: { maxProbes: number; ranking: 'rawScore desc, then proposalId'; costPerProbe: number; equality: string };
  proposals: PostComaProposal[]; counts: { proposals: number; executed: number; suggested: number; notExecutable: number; skippedBudget: number; failed: number };
  limitations: string[];
}

const TEXT_EQUALITY = 'literal text equality of sampled values';
const sameEndpoint = (a: { table: string; column: string }, b: { table: string; column: string }) => a.table === b.table && a.column === b.column;

/**
 * The normalization a coverage probe compares under is the one the universe declares: the mode of a configured relation
 * over the same endpoints (either direction) when there is one, otherwise the universe's default mode. Never inferred.
 */
export function coverageNormalization(cfg: any, proposal: Pick<OutOfScopeProposal, 'from' | 'to'>): { mode: NormalizationMode; source: 'RELATION' | 'UNIVERSE_DEFAULT'; relationId?: string } {
  const declared = (mode: unknown): mode is NormalizationMode => typeof mode === 'string' && Boolean(cfg?.normalizationContract?.modes?.[mode]);
  const relation = (cfg?.relations ?? []).find((item: any) => declared(item?.normalization) && item.from && item.to
    && ((sameEndpoint(item.from, proposal.from) && sameEndpoint(item.to, proposal.to)) || (sameEndpoint(item.from, proposal.to) && sameEndpoint(item.to, proposal.from))));
  if (relation) return { mode: relation.normalization, source: 'RELATION', relationId: relation.id };
  const fallback = cfg?.normalizationContract?.defaultMode;
  return { mode: declared(fallback) ? fallback : 'text', source: 'UNIVERSE_DEFAULT' };
}

/** Literals to send for one normalized source key: the raw sampled forms plus the normalized form, so a padded or unpadded target can still match. */
function literalVariants(raws: string[], key: string, mode: NormalizationMode) {
  const forms = new Set(raws.filter(raw => SAFE_LITERAL.test(raw)));
  forms.add(key);
  if (mode === 'integer-pad10') forms.add(BigInt(key).toString());
  return [...forms];
}

const idOf = (proposal: OutOfScopeProposal) => `${proposal.from.table}.${proposal.from.column}__${proposal.to.table}.${proposal.to.column}`;

/**
 * Post-COMA step. COMA proposals outside the configured scope are never evaluated as relations; instead each one gets a
 * coverage probe that the agent may run inside the remaining budget: how many of the sampled source values appear in the
 * target column. The result is a bounded diagnostic with the proposal still NO VERIFICADO/UNKNOWN and PENDING; it never
 * produces or changes a verdict. Probes run by raw score, up to the catalog's postComa.maxProbes (default 2), one query each.
 */
export async function runPostComa(o: { cfg: any; catalog?: ExplorationCatalog; discovery: any; proposals: readonly OutOfScopeProposal[]; client: Pick<Zetaris, 'runSql'>; budget: RunBudget }): Promise<PostComaReport> {
  const maxProbes = o.catalog?.postComa?.maxProbes ?? DEFAULT_POST_COMA.maxProbes;
  const byId = new Map<string, OutOfScopeProposal>();
  for (const proposal of o.proposals) { const id = idOf(proposal), kept = byId.get(id); if (!kept || proposal.rawScore > kept.rawScore) byId.set(id, proposal); }
  const ranked = [...byId.entries()].sort(([a, pa], [b, pb]) => pb.rawScore - pa.rawScore || a.localeCompare(b, 'en'));
  const defaultMode = coverageNormalization(o.cfg, { from: { table: '', column: '' }, to: { table: '', column: '' } } as any).mode;
  const defaultEquality = defaultMode === 'text' ? TEXT_EQUALITY : `equality of sampled values under the declared normalization (${defaultMode}); a configured relation over the same columns overrides it per proposal`;
  const report: PostComaReport = { status: 'NONE', policy: { maxProbes, ranking: 'rawScore desc, then proposalId', costPerProbe: COVERAGE_PROBE_QUERY_COST, equality: defaultEquality },
    proposals: [], counts: { proposals: ranked.length, executed: 0, suggested: 0, notExecutable: 0, skippedBudget: 0, failed: 0 },
    limitations: [defaultMode === 'text' ? 'Coverage compares literal text of bounded sampled values; it does not apply normalization and says nothing about the whole table.'
        : 'Coverage compares bounded sampled values under the normalization the universe declares (per proposal: mode and source in the result); it says nothing about the whole table.',
      'A coverage probe is a diagnostic: the proposal stays NO VERIFICADO/UNKNOWN and PENDING, and no verdict is produced or changed.'] };
  let executed = 0;
  for (const [proposalId, proposal] of ranked) {
    const item: PostComaProposal = { proposalId, from: proposal.from, to: proposal.to, rawScore: proposal.rawScore, reason: proposal.reason, verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING',
      coverageProbe: { kind: 'COVERAGE_PROBE', status: 'SUGGESTED' } };
    report.proposals.push(item);
    const probe = item.coverageProbe;
    const fromSpec = o.cfg.tables[proposal.from.table], toSpec = o.cfg.tables[proposal.to.table];
    const fromTable = o.discovery.tables[proposal.from.table];
    const inAllowlist = (spec: any, column: string) => Boolean(spec?.columns?.some((item: any) => item.name === column));
    const sampleIndex = fromTable?.columns?.indexOf(proposal.from.column) ?? -1;
    if (!fromSpec || !toSpec || !inAllowlist(fromSpec, proposal.from.column) || !inAllowlist(toSpec, proposal.to.column) || !o.discovery.tables[proposal.to.table]) { probe.status = 'NOT_EXECUTABLE'; probe.reason = 'ENDPOINT_OUTSIDE_ALLOWLIST_OR_UNDISCOVERED'; continue; }
    if (sampleIndex < 0) { probe.status = 'NOT_EXECUTABLE'; probe.reason = 'SOURCE_COLUMN_NOT_SAMPLED'; continue; }
    const norm = coverageNormalization(o.cfg, proposal);
    const sampled = (fromTable.sample?.rows ?? []).map((row: unknown[]) => row[sampleIndex]).filter((value: unknown) => value !== null && value !== undefined).map(String);
    const values = [...new Set<string>(sampled)];
    const rawsByKey = new Map<string, string[]>(); let unnormalizable = 0;
    for (const raw of values) { const key = normalizeKey(raw, norm.mode); if (key === null) { unnormalizable++; continue; } rawsByKey.set(key, [...(rawsByKey.get(key) ?? []), raw]); }
    const safe = [...rawsByKey.keys()].filter(key => SAFE_LITERAL.test(key)).slice(0, o.budget.limits.readLimit);
    if (!safe.length) { probe.status = 'NOT_EXECUTABLE'; probe.reason = 'NO_SAFE_SAMPLED_VALUES'; continue; }
    if (executed >= maxProbes) { probe.reason = 'NOT_SELECTED_MAX_PROBES'; continue; }
    if (!o.budget.canQuery(COVERAGE_PROBE_QUERY_COST)) { probe.status = 'SKIPPED_BUDGET'; probe.reason = 'QUERY_BUDGET_INSUFFICIENT'; continue; }
    const literals = [...new Set(safe.flatMap(key => literalVariants(rawsByKey.get(key)!, key, norm.mode)))].map(value => `'${value.replace(/'/g, "''")}'`).join(', ');
    const sql = `SELECT ${identifier(proposal.to.column)} FROM ${zetarisSourceQuery({ ...toSpec, columns: toSpec.columns })} WHERE ${identifier(proposal.to.column)} IN (${literals}) LIMIT ${o.budget.limits.readLimit}`;
    probe.sql = sql; executed++;
    try {
      const result = await o.client.runSql(sql, o.budget.limits.readLimit);
      const found = new Set(result.rows.map((row: unknown[]) => normalizeKey(row[0], norm.mode)).filter((key: string | null): key is string => key !== null));
      const matches = safe.filter(value => found.has(value)).length;
      probe.status = 'EXECUTED';
      probe.result = { sampledSourceValues: values.length, probedValues: safe.length, targetMatches: matches, ratio: safe.length ? matches / safe.length : null, rows: result.rows.length, queryId: result.queryId, requestId: result.requestId,
        normalization: { mode: norm.mode, source: norm.source, ...(norm.relationId ? { relationId: norm.relationId } : {}), unnormalizableValues: unnormalizable } };
      trace({ kind: 'agent-post-coma-coverage', proposalId, status: 'PASS', probed: safe.length, matches, queryId: result.queryId, requestId: result.requestId, sql });
    } catch (error) {
      probe.status = 'FAILED'; probe.error = failure(error);
      trace({ kind: 'agent-post-coma-coverage', proposalId, status: 'FAIL', ...failure(error) });
    }
  }
  for (const item of report.proposals) {
    const status = item.coverageProbe.status;
    if (status === 'EXECUTED') report.counts.executed++; else if (status === 'SUGGESTED') report.counts.suggested++; else if (status === 'NOT_EXECUTABLE') report.counts.notExecutable++; else if (status === 'SKIPPED_BUDGET') report.counts.skippedBudget++; else report.counts.failed++;
  }
  report.status = !ranked.length ? 'NONE' : report.counts.failed || report.counts.skippedBudget ? 'PARTIAL' : report.counts.executed ? 'EXECUTED' : 'SUGGESTED_ONLY';
  return report;
}
