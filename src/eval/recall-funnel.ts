import fs from 'node:fs';
import path from 'node:path';
import { loadTpcdsGold, type TpcdsGold } from './tpcds-gold.ts';

/**
 * E4-01 offline recall funnel: for each edge of the TPC-DS foreign-key gold, the stage of the pipeline that lost it.
 * EVALUATION ONLY. It reads a finished run (engine-run.json, and model-review-overlay.json when the run persisted one) and the gold; the agent runtime never imports it,
 * and nothing here takes part in a run. The gold stays on this side of the line (src/eval/tpcds-gold.ts is the only reader of the gold file).
 *
 * Stages, in pipeline order (an edge gets the FIRST stage that stops it, or SOSTENIDA when nothing does):
 *   NOT_PROPOSED_BY_COMA   no post-COMA proposal in either direction
 *   REVERSED               only the opposite direction was proposed (the direct edge never entered the pipeline)
 *   NOT_PROBED_BUDGET      proposed and executable, but the coverage probe was not selected (maxProbes / budget)
 *   NOT_EXECUTABLE         the coverage probe could not run (for example NO_SAFE_SAMPLED_VALUES) or failed
 *   COVERAGE_NOT_HIGH      probed, coverage below HIGH
 *   FLAGGED                probed, HIGH, stopped by a post-COMA guard (reason in the detail)
 *   NOT_REVIEWED_BUDGET    eligible for the model review, but the review did not fit the token budget
 *   NOT_REVIEWED_NO_REVIEW eligible, but the run had no candidate review and no decision for it (HUMAN mode or no reviewer)
 *   REVIEW_DEFER / REVIEW_REJECT   the model review looked at it and did not approve it
 *   NO_DECISION            approved (or configured) but no verdict was recorded for it
 *   PROBE_INDETERMINADA / PROBE_ENGANOSA   the contract probe did not sustain it
 *   SOSTENIDA              sustained (also when REUSED_FROM_MEMORY)
 */
export const FUNNEL_STAGES = ['NOT_PROPOSED_BY_COMA', 'REVERSED', 'NOT_PROBED_BUDGET', 'NOT_EXECUTABLE', 'COVERAGE_NOT_HIGH', 'FLAGGED', 'NOT_REVIEWED_BUDGET', 'NOT_REVIEWED_NO_REVIEW', 'REVIEW_DEFER', 'REVIEW_REJECT', 'NO_DECISION', 'PROBE_INDETERMINADA', 'PROBE_ENGANOSA', 'SOSTENIDA'] as const;
export type FunnelStage = typeof FUNNEL_STAGES[number];

export interface FunnelEdge { id: string; from: string; to: string; stage: FunnelStage; detail: string | null }
export interface FunnelInput {
  /** engine-run.json, or the in-memory report of the same run. */
  report: any;
  /** model-review-overlay.json when the run persisted it; the report's phases.candidateReview section is used otherwise. */
  overlay?: any;
  gold?: TpcdsGold;
}
export interface RecallFunnel {
  schemaVersion: 1; kind: 'RECALL_FUNNEL'; runId: string | null; universeId: string | null; executionMode: string | null; dataOrigin: string | null;
  goldEdges: number; compositeNotScored: number;
  edges: FunnelEdge[];
  byStage: Record<FunnelStage, number>;
  /** Survival ladder: how many gold edges are still alive after each stage (each count includes every later one). */
  reach: { proposed: number; probed: number; coverageHigh: number; unflagged: number; reviewedOrConfigured: number; approvedOrConfigured: number; sostenida: number };
  sostenidaPct: number | null;
  reviewStage: 'OVERLAY_FILE' | 'REPORT_SECTION' | 'NONE';
  notes: string[];
}

const edgeKey = (side: { table: string; column: string }) => `${side.table}.${side.column}`;
/** The gold id `a.x->b.y` as the run names a relation: `a.x__b.y`. */
export const relationIdOf = (edge: { from: { table: string; column: string }; to: { table: string; column: string } }) => `${edgeKey(edge.from)}__${edgeKey(edge.to)}`;
export const reversedRelationIdOf = (edge: { from: { table: string; column: string }; to: { table: string; column: string } }) => `${edgeKey(edge.to)}__${edgeKey(edge.from)}`;

const decisionList = (report: any): any[] => Array.isArray(report?.decisions) ? report.decisions : [];
const verdictOf = (decision: any): string => String(decision?.verdict ?? decision?.decision?.verdict ?? '');

function budgetSkipped(overlay: any, id: string, reasons: string[]): boolean {
  if (reasons.some(reason => /SKIPPED_BUDGET|BUDGET/i.test(reason))) return true;
  const review = (Array.isArray(overlay?.reviews) ? overlay.reviews : []).find((item: any) => item?.relationId === id);
  const evaluations: any[] = Array.isArray(review?.evaluations) ? review.evaluations : [];
  return evaluations.length > 0 && evaluations.every(evaluation => evaluation?.status === 'SKIPPED_BUDGET');
}

/** Classify every single-column gold edge against one finished run. Pure: no I/O, no gold at runtime. */
export function buildRecallFunnel(input: FunnelInput): RecallFunnel {
  const { report } = input, gold = input.gold ?? loadTpcdsGold();
  const proposalsList: any[] = Array.isArray(report?.postComa?.proposals) ? report.postComa.proposals : [];
  const proposals = new Map<string, any>(proposalsList.map(item => [String(item.proposalId), item]));
  const section = report?.phases?.candidateReview, overlay = input.overlay ?? undefined;
  const reviewStage: RecallFunnel['reviewStage'] = overlay ? 'OVERLAY_FILE' : section && typeof section === 'object' && section.status !== 'SKIPPED_NO_REVIEWER' ? 'REPORT_SECTION' : 'NONE';
  const notApproved = new Map<string, { decision: string; reasons: string[]; reviewed: boolean }>();
  for (const item of (overlay?.notApproved ?? section?.notApproved ?? []) as any[]) notApproved.set(String(item.relationId), { decision: String(item.decision ?? 'defer'), reasons: Array.isArray(item.reasons) ? item.reasons.map(String) : [], reviewed: item.reviewed === true });
  const approved = new Set<string>(((overlay?.relations ? overlay.relations.map((relation: any) => relation.id) : section?.approved) ?? []).map(String));
  for (const id of (Array.isArray(section?.reusedFromMemory) ? section.reusedFromMemory : [])) approved.add(String(id));
  const decisions = new Map<string, any>(decisionList(report).map(item => [String(item.relationId), item]));

  const edges: FunnelEdge[] = gold.edges.map(edge => {
    const id = relationIdOf(edge), reverse = reversedRelationIdOf(edge);
    const out = (stage: FunnelStage, detail: string | null = null): FunnelEdge => ({ id: edge.id, from: edgeKey(edge.from), to: edgeKey(edge.to), stage, detail });
    const proposal = proposals.get(id);
    if (!proposal) return proposals.has(reverse) ? out('REVERSED', `proposed as ${reverse}`) : out('NOT_PROPOSED_BY_COMA');
    const probe = proposal.coverageProbe;
    if (!probe) return out('NOT_EXECUTABLE', 'NO_PROBE');
    if (probe.status === 'SUGGESTED' || probe.status === 'SKIPPED_BUDGET') return out('NOT_PROBED_BUDGET', String(probe.reason ?? probe.status));
    if (probe.status !== 'EXECUTED' || !probe.diagnostic) return out('NOT_EXECUTABLE', String(probe.reason ?? probe.status));
    const level = String(probe.diagnostic.coverage?.level ?? 'UNKNOWN');
    if (level !== 'HIGH') return out('COVERAGE_NOT_HIGH', level);
    if (probe.diagnostic.suspect?.value) return out('FLAGGED', (probe.diagnostic.suspect.reasons ?? []).join(',') || 'UNSPECIFIED');
    const decision = decisions.get(id), verdict = decision ? verdictOf(decision) : '';
    const wasApproved = approved.has(id), notApprovedEntry = notApproved.get(id);
    if (!wasApproved && notApprovedEntry && !decision) {
      if (budgetSkipped(overlay, id, notApprovedEntry.reasons)) return out('NOT_REVIEWED_BUDGET', notApprovedEntry.reasons.join(',') || null);
      return out(notApprovedEntry.decision === 'reject' ? 'REVIEW_REJECT' : 'REVIEW_DEFER', notApprovedEntry.reasons.join(',') || null);
    }
    if (!decision) {
      if (reviewStage !== 'NONE' && !wasApproved) return out('NOT_REVIEWED_BUDGET', 'ELIGIBLE_BUT_ABSENT_FROM_REVIEW_OUTPUT');
      if (reviewStage === 'NONE') return out('NOT_REVIEWED_NO_REVIEW');
      return out('NO_DECISION');
    }
    if (verdict === 'SOSTENIDA') return out('SOSTENIDA', Array.isArray(decision.reasonCodes) && decision.reasonCodes.includes('REUSED_FROM_MEMORY') ? 'REUSED_FROM_MEMORY' : null);
    const codes = Array.isArray(decision.reasonCodes) ? decision.reasonCodes.join(',') : null;
    return out(verdict === 'ENGAÑOSA' ? 'PROBE_ENGANOSA' : 'PROBE_INDETERMINADA', codes);
  });

  const byStage = Object.fromEntries(FUNNEL_STAGES.map(stage => [stage, edges.filter(edge => edge.stage === stage).length])) as Record<FunnelStage, number>;
  const lost = (...stages: FunnelStage[]) => edges.filter(edge => stages.includes(edge.stage)).length;
  const total = edges.length;
  const proposed = total - lost('NOT_PROPOSED_BY_COMA', 'REVERSED');
  const probed = proposed - lost('NOT_PROBED_BUDGET', 'NOT_EXECUTABLE');
  const coverageHigh = probed - lost('COVERAGE_NOT_HIGH');
  const unflagged = coverageHigh - lost('FLAGGED');
  const reviewedOrConfigured = unflagged - lost('NOT_REVIEWED_BUDGET', 'NOT_REVIEWED_NO_REVIEW');
  const approvedOrConfigured = reviewedOrConfigured - lost('REVIEW_DEFER', 'REVIEW_REJECT');
  const sostenida = byStage.SOSTENIDA;
  const notes = [
    'Single-column gold edges only; composite gold edges are listed with their count and are not scored.',
    reviewStage === 'NONE' ? 'The run has no candidate review: eligible edges with no decision are reported NOT_REVIEWED_NO_REVIEW.' : `Review outcomes come from ${reviewStage === 'OVERLAY_FILE' ? 'model-review-overlay.json' : 'the report section phases.candidateReview (no overlay file: budget-skipped reviews are detected from reason codes only)'}.`,
    'REVERSED counts an edge whose direct direction was never proposed; its reverse proposal is not followed further.',
    'A stage is the FIRST one that stopped the edge; the reach ladder counts edges still alive after each stage.'
  ];
  return { schemaVersion: 1, kind: 'RECALL_FUNNEL', runId: report?.runId ?? null, universeId: report?.universeId ?? null, executionMode: report?.executionMode ?? null, dataOrigin: report?.dataOrigin ?? null,
    goldEdges: total, compositeNotScored: gold.compositeEdges.length, edges, byStage,
    reach: { proposed, probed, coverageHigh, unflagged, reviewedOrConfigured, approvedOrConfigured, sostenida }, sostenidaPct: total ? sostenida / total : null, reviewStage, notes };
}

const pct = (n: number, d: number) => (d ? `${(100 * n / d).toFixed(1)}%` : 'n/a');

/** The funnel as a markdown table with denominators (n of the gold edges, and the survival ladder). */
export function renderRecallFunnel(funnel: RecallFunnel): string {
  const n = funnel.goldEdges, lines: string[] = [];
  lines.push(`Recall funnel — run ${funnel.runId ?? '?'} (${funnel.universeId ?? '?'}, ${funnel.executionMode ?? '?'}/${funnel.dataOrigin ?? '?'}), ${n} single-column gold edges (+${funnel.compositeNotScored} composite not scored)`, '',
    '| Stage that lost the edge | Edges | of gold |', '|---|---|---|');
  for (const stage of FUNNEL_STAGES) if (funnel.byStage[stage] > 0 || stage === 'SOSTENIDA') lines.push(`| ${stage} | ${funnel.byStage[stage]} | ${pct(funnel.byStage[stage], n)} |`);
  lines.push(`| **Total** | ${n} | 100.0% |`, '', '| Still alive after | Edges | of gold |', '|---|---|---|');
  const reach = funnel.reach;
  for (const [label, value] of [['gold edges', n], ['proposed by COMA (direct direction)', reach.proposed], ['coverage probe executed', reach.probed], ['coverage HIGH', reach.coverageHigh], ['not flagged', reach.unflagged], ['reviewed (or configured)', reach.reviewedOrConfigured], ['approved by the review', reach.approvedOrConfigured], ['SOSTENIDA', reach.sostenida]] as const)
    lines.push(`| ${label} | ${value} | ${pct(value, n)} |`);
  const detailed = funnel.edges.filter(edge => edge.stage === 'FLAGGED' || edge.stage === 'REVERSED' || edge.stage === 'NOT_EXECUTABLE');
  if (detailed.length) { lines.push('', '| Edge | Stage | Detail |', '|---|---|---|'); for (const edge of detailed) lines.push(`| ${edge.from} -> ${edge.to} | ${edge.stage} | ${edge.detail ?? ''} |`); }
  lines.push('', ...funnel.notes.map(note => `- ${note}`));
  return lines.join('\n');
}

/** Reads a run folder (or its engine-run.json) and its model-review-overlay.json when present. */
export function loadRunForFunnel(target: string): { report: any; overlay?: any; dir: string } {
  const resolved = path.resolve(target), dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  const file = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : path.join(dir, 'engine-run.json');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const overlayFile = path.join(dir, 'model-review-overlay.json');
  return { report, dir, ...(fs.existsSync(overlayFile) ? { overlay: JSON.parse(fs.readFileSync(overlayFile, 'utf8')) } : {}) };
}
