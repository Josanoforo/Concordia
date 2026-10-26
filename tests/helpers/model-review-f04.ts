/**
 * Offline evaluation set for the model reviewer (piece R): the 30 probed TPCDS candidates of the live-04 run fixture, the 3 live negative-control decoys
 * (probed as candidates, as P1 will do for every proposal), and the F-04 human labels (canonical set: eval/review, read through src/eval/f04-review-labels.ts). Test support only: src/ never imports this file or the labels.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackets, negativeControlEntries, type ProbedProposalInput } from '../../src/agent/model-review/evidence.ts';
import type { EvaluationLabel } from '../../src/agent/model-review/evaluation.ts';
import { evaluationLabels } from '../../src/eval/f04-review-labels.ts';
import type { ReviewPacket, UnprobedCandidate } from '../../src/agent/model-review/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (relative: string) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
export const MIN_DISTINCT_KEYS = readJson('config/thresholds.json').minDistinctKeys as number;

/** The two catalog_page candidates the F-04 package left out (TARGET_NOT_UNIQUE): not a human label, reported apart as a floor check. */
export const NOT_OFFERED = ['catalog_returns.cr_catalog_page_sk__catalog_page.cp_catalog_page_sk', 'catalog_sales.cs_catalog_page_sk__catalog_page.cp_catalog_page_sk'];

interface DecoySide { side: string; rows: number; distinctKeys: number }
interface Decoy { id: string; from: string; to: string; hypotheticalVerdict?: string; outcome?: string; sql: DecoySide[] }

/** The decoy as a probed proposal: the same shape post-COMA gives any probed candidate, built from the two bounded reads of the negative control. */
export function decoyProposal(decoy: Decoy): ProbedProposalInput {
  const split = (text: string) => ({ db: 'TPCDS_DB', table: text.slice(0, text.indexOf('.')), column: text.slice(text.indexOf('.') + 1) });
  const source = decoy.sql.find(item => item.side === 'SOURCE')!, target = decoy.sql.find(item => item.side === 'TARGET')!;
  const probed = source.distinctKeys, matched = target.distinctKeys, ratio = probed ? matched / probed : 0;
  return {
    proposalId: decoy.id, from: split(decoy.from), to: split(decoy.to),
    coverageProbe: { status: 'EXECUTED', diagnostic: {
      coverage: { level: ratio >= 0.8 ? 'HIGH' : matched > 0 ? 'LOW' : 'NONE', matched, probed, threshold: 0.8 },
      labels: { signal: 'NOT_COMPARABLE' },
      multiplicity: { from: { rows: source.rows, distinctKeys: source.distinctKeys, maxRowsPerKey: 1 }, to: { rows: target.rows, distinctKeys: target.distinctKeys, maxRowsPerKey: 1 } },
      keyRules: { inclusion: { status: matched >= probed ? 'NO_VIOLATION_IN_SAMPLE' : 'VIOLATED_IN_SAMPLE', missingCount: Math.max(0, probed - matched) }, targetUniqueness: { status: 'NO_DUPLICATES_IN_SAMPLE', duplicateKeyCount: 0 } }
    } }
  };
}

export function loadF04Set(): { packets: ReviewPacket[]; unprobed: UnprobedCandidate[]; labels: EvaluationLabel[]; proposals: ProbedProposalInput[] } {
  const run = readJson('tests/fixtures/agent-runs/agent-tpcds-live-04/engine-run.json');
  const control = readJson('tests/fixtures/agent-runs/agent-tpcds-negative-control/negative-control.json');
  const decoyIds = new Set<string>(control.decoys.map((decoy: Decoy) => decoy.id));
  // The decoys replace any unprobed copy of themselves in the proposal list: from here on they are probed candidates like the rest.
  const proposals: ProbedProposalInput[] = [...(run.postComa.proposals as ProbedProposalInput[]).filter(item => !decoyIds.has(item.proposalId)), ...control.decoys.map(decoyProposal)];
  const { packets, unprobed } = buildPackets(proposals, { universeId: 'TPCDS', minDistinctKeys: MIN_DISTINCT_KEYS, negativeControl: negativeControlEntries(control) });
  const labels: EvaluationLabel[] = [...evaluationLabels(), ...NOT_OFFERED.map(relationId => ({ relationId, label: 'NOT_OFFERED' as const }))];
  return { packets, unprobed, labels, proposals };
}

/** Only the packets that carry a label: the 30 + 3 candidates the human process (or the negative control) looked at. */
export function labelledPackets(set: { packets: ReviewPacket[]; labels: EvaluationLabel[] }): ReviewPacket[] {
  const ids = new Set(set.labels.map(label => label.relationId));
  return set.packets.filter(packet => ids.has(packet.relationId));
}
