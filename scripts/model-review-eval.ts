// Offline evaluation of the model reviewer against the F-04 human labels (TPCDS). No network, no generation, no SQL: scripted stand-in models only.
// Usage: node scripts/run-tsx.mjs scripts/model-review-eval.ts [--json] [--rows]
//   (default)  prints the ablation table with denominators
//   --rows     also prints every labelled relation with the decision of the default configuration
//   --json     prints the machine-readable result
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { agreementRow, AGREEMENT_HEADER, measureAgreement, type AgreementReport } from '../src/agent/model-review/evaluation.ts';
import { runModelReview } from '../src/agent/model-review/reviewer.ts';
import { standInAdversary, standInJudge, type StandInJudgeKind } from '../src/agent/model-review/standin.ts';
import type { ModelReviewRun } from '../src/agent/model-review/types.ts';
import { labelledPackets, loadF04Set, MIN_DISTINCT_KEYS } from '../tests/helpers/model-review-f04.ts';

export interface EvalConfiguration { name: string; judges: StandInJudgeKind[]; attackScope: 'ACCEPTED_ONLY' | 'NONE' }
export const CONFIGURATIONS: EvalConfiguration[] = [
  { name: 'A. evidence-only judges, no adversarial pass (what bounded key membership gives)', judges: ['EVIDENCE_ONLY', 'EVIDENCE_ONLY'], attackScope: 'NONE' },
  { name: 'B. evidence-only judges + adversarial pass', judges: ['EVIDENCE_ONLY', 'EVIDENCE_ONLY'], attackScope: 'ACCEPTED_ONLY' },
  { name: 'C. semantic judges, no adversarial pass', judges: ['SEMANTIC', 'SEMANTIC'], attackScope: 'NONE' },
  { name: 'D. semantic judges + adversarial pass (default)', judges: ['SEMANTIC', 'SEMANTIC'], attackScope: 'ACCEPTED_ONLY' },
  { name: 'E. one semantic + one evidence-only judge + adversarial pass', judges: ['SEMANTIC', 'EVIDENCE_ONLY'], attackScope: 'ACCEPTED_ONLY' }
];

export async function evaluateConfiguration(configuration: EvalConfiguration): Promise<{ run: ModelReviewRun; report: AgreementReport }> {
  const set = loadF04Set(), packets = labelledPackets(set);
  const budget = new RunBudget(limitsFromBounds({ maxTokensPerRun: 1_000_000 }));
  const run = await runModelReview({ packets, unprobed: set.unprobed, judges: configuration.judges.map((kind, index) => standInJudge(`standin-${kind.toLowerCase()}-${index + 1}`, kind)), adversary: standInAdversary('standin-adversary'),
    budget, config: { minDistinctKeys: MIN_DISTINCT_KEYS, attackScope: configuration.attackScope } });
  return { run, report: measureAgreement(run.reviews, set.labels) };
}

async function main() {
  const rows: string[] = [], json: object[] = [];
  let defaultRun: ModelReviewRun | undefined;
  for (const configuration of CONFIGURATIONS) {
    const { run, report } = await evaluateConfiguration(configuration);
    rows.push(agreementRow(configuration.name, report));
    json.push({ configuration: configuration.name, provenance: report.provenance, classes: report.classes, overall: report.overall, falseAccepts: report.falseAccepts, missedAccepts: report.missedAccepts, counts: run.counts });
    if (configuration.name.startsWith('D.')) defaultRun = run;
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(json, null, 2)); return; }
  console.log('Provenance: STAND_IN_OFFLINE (scripted stand-ins; pipeline measurement, not model evidence). Labels: F-04 (25 YES, 3 DEFERRED), 3 decoys, 2 catalog_page.');
  console.log(AGREEMENT_HEADER); console.log(rows.join('\n'));
  if (process.argv.includes('--rows') && defaultRun) {
    const set = loadF04Set();
    console.log('\n| relation | F-04 label | decision | confidence | adversarial pass | sustained attacks | survived attacks |\n|---|---|---|---|---|---|---|');
    for (const label of set.labels) {
      const review = defaultRun.reviews.find(item => item.relationId === label.relationId);
      console.log(review ? `| ${label.relationId} | ${label.label} | ${review.decision} | ${review.confidence} | ${review.adversarialPass} | ${review.attacksSustained.map(a => a.family).join(', ') || '-'} | ${review.attacksSurvived.map(a => `${a.family}(${a.severity})`).join(', ') || '-'} |` : `| ${label.relationId} | ${label.label} | NO REVIEW | | | | |`);
    }
  }
}
if (process.argv[1] && /model-review-eval\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) await main();
