import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { readReviewOverlayFile, validateReviewOverlay, withReviewOverlay } from '../src/agent/review-overlay.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { checkDistinctKeys } from '../scripts/check-distinct-keys.ts';
import { ROOT } from '../src/runtime.ts';

/**
 * Act 3 negative control (offline). Decoys are gold-trap homonyms that are NOT in the 25 approved contracts. With the overlay of those contracts in force they must stay
 * out of every decision (never SOSTENIDA, never probed as relations) and remain PENDING candidates. The second test measures what the policy alone would say about a decoy
 * if someone did put a REVIEWED contract on it: membership is all it checks, so the protection is the human contract set, not the evidence.
 */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
export const DECOYS = [
  { from: 'store_sales.ss_store_sk', to: 'web_site.web_site_sk' },
  { from: 'inventory.inv_warehouse_sk', to: 'ship_mode.sm_ship_mode_sk' },
  { from: 'store_sales.ss_promo_sk', to: 'reason.r_reason_sk' }
];
const decoyId = (d: { from: string; to: string }) => `${d.from}__${d.to}`;
const contractsFile = path.join(ROOT, '..', 'internal', 'concordia', 'docs', 'reportes', 'level2', 'F04_TPCDS_CONTRACTS_25_20261025.json');
const approved: any[] | undefined = fs.existsSync(contractsFile) ? JSON.parse(fs.readFileSync(contractsFile, 'utf8')).relations : undefined;

test('the 25 approved contracts do not contain any decoy', { skip: approved ? false : 'F-04 contract data not present' }, () => {
  assert.equal(approved!.length, 25);
  const ids = new Set(approved!.map(r => r.id));
  for (const decoy of DECOYS) assert.ok(!ids.has(decoyId(decoy)), decoyId(decoy));
});

test('with the 25 approved contracts in force (the real overlay file), no decoy gets a decision and every decoy candidate stays PENDING', async () => {
  const file = 'universes/reviews/TPCDS.review.json', { overlay } = readReviewOverlayFile(file) as { overlay: any };
  assert.equal(overlay.relations.length, 25, 'exactly the 25 approved contracts');
  assert.deepEqual(validateReviewOverlay(overlay, 'TPCDS'), [], 'all 25 pass the allowlist of declared columns');
  for (const decoy of DECOYS) assert.ok(!overlay.relations.some((r: any) => r.id === decoyId(decoy)), decoyId(decoy));
  const f = structuredClone(agentFixtures().find(item => item.alias === 'TPCDS')!);
  const report: any = await withReviewOverlay('TPCDS', { file }, () => runAgent('TPCDS', 'agent-tpcds-negative-control', { ...offlineAgentDeps('TPCDS', f, new Script([...f.chooserScript])), persist: false, critic: false }));
  const ids = new Set(report.decisions.map((d: any) => d.relationId));
  for (const decoy of DECOYS) assert.ok(!ids.has(decoyId(decoy)), `${decoyId(decoy)} has no decision`);
  assert.ok(!report.decisions.some((d: any) => DECOYS.some(x => decoyId(x) === d.relationId) && d.verdict === 'SOSTENIDA'));
  for (const item of report.postComa.proposals.filter((p: any) => DECOYS.some(x => decoyId(x) === p.proposalId))) {
    assert.equal(item.verificationStatus, 'NO VERIFICADO/UNKNOWN'); assert.equal(item.reviewState, 'PENDING');
  }
});

test('measure: a hypothetical REVIEWED contract on a decoy gets SOSTENIDA from the policy (membership only), so the control is the human contract set', async () => {
  const outcome: Record<string, string> = {};
  for (const decoy of DECOYS) {
    const lines: any[] = [];
    await checkDistinctKeys({ universe: 'TPCDS', from: decoy.from, to: decoy.to, offline: true }, line => lines.push(line));
    const verdict = lines.at(-1);
    assert.equal(verdict.hypotheticalContract, true); assert.equal(verdict.notAHumanReview, true);
    outcome[decoyId(decoy)] = `${verdict.verdict}:${verdict.reasonCodes[0]}`;
  }
  process.stderr.write(`ACTO3_DECOY_HYPOTHETICAL ${JSON.stringify(outcome)}\n`);
  assert.ok(Object.values(outcome).every(value => value === 'SOSTENIDA:bounded_sample_key_membership'));
});

import os from 'node:os';
import { runNegativeControl, classifyDecoy } from '../scripts/negative-control.ts';
test('the negative-control artifact is labelled, capped at 6 SQL and separates rejected-by-evidence from out-of-contract-only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'negctl-'));
  try {
    const a = await runNegativeControl({ outRun: 'x', offline: true, dir });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'negative-control.json'), 'utf8'));
    assert.equal(written.label, 'OFFLINE_FIXTURE'); assert.equal(written.sqlCeiling, 6); assert.ok(a.sqlSent <= 6 && a.sqlSent === 6);
    assert.equal(written.decoys.length, 3); assert.ok(written.decoys.every((d: any) => d.sql.length === 2 && d.inContract === false));
    assert.deepEqual([...written.outOfContractOnly, ...written.rejectedByEvidence].sort(), written.decoys.map((d: any) => d.id).sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(classifyDecoy('SOSTENIDA'), 'OUT_OF_CONTRACT_ONLY'); assert.equal(classifyDecoy('INDETERMINADA'), 'REJECTED_BY_EVIDENCE'); assert.equal(classifyDecoy('ENGAÑOSA'), 'REJECTED_BY_EVIDENCE');
});
