import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectPieces, goldAtRuntimeViolations, labelsOf, loadLabels, renderReport, runIntegration, withHarnessOverrides, HARNESS_OVERRIDES, REVIEW_CONFIGS } from '../scripts/round9-integration.ts';
import { satisfiesModelAdversarialSlot } from '../src/agent/model-review/index.ts';
import { resolveUniverseManifest } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** Round 9 integration harness (X9), offline: the invariants that already apply whatever has landed. The run uses the deterministic COMA stand-in so the gate stays fast; the script itself uses the installed COMA. */
const integration = () => (cached ??= runIntegration({ bridge: 'standin' }));
let cached: ReturnType<typeof runIntegration> | undefined;

test('every Round 9 piece is reported LANDED or NOT_YET_LANDED, never an exception', async () => {
  const pieces = await detectPieces();
  assert.deepEqual(pieces.map(piece => piece.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'G', 'R', 'R-1', 'R-1-apply', 'R-config', 'R-stage', 'R-seal', 'R-label']);
  for (const piece of pieces) { assert.ok(['LANDED', 'NOT_YET_LANDED'].includes(piece.status), piece.id); assert.ok(piece.detail.length > 0, piece.id); assert.ok(piece.owner.length > 0); }
});

test('the offline evaluation labels are an evaluation set with the expected denominators, and no runtime module names them', () => {
  const labels = loadLabels(), all = labelsOf(labels);
  assert.deepEqual([labels.yes.length, labels.deferred.length, labels.decoys.length], [25, 3, 3]);
  assert.equal(new Set(all.map(item => item.id)).size, 31, 'no relation is labelled twice');
  assert.deepEqual(goldAtRuntimeViolations(), [], 'nothing under src/ (outside src/eval) reads the labels or the human review files');
  const f04 = '../out/reports/F04_TPCDS_CONTRACTS_25_20261025.json';
  if (fs.existsSync(new URL(f04, import.meta.url))) {
    const file = JSON.parse(fs.readFileSync(new URL(f04, import.meta.url), 'utf8'));
    assert.deepEqual(file.relations.map((item: any) => item.id), labels.yes, 'the label fixture is the F-04 approved set');
    assert.deepEqual(file.deferred.map((item: any) => item.id), labels.deferred.map(item => item.id));
  }
});

test('the harness overrides are in-process and restored: the shipped config and manifest are untouched afterwards', async () => {
  const before = JSON.stringify(universeConfig('TPCDS').explorationCatalog.postComa), manifest: any = resolveUniverseManifest('TPCDS'), bounds = JSON.stringify(manifest.capabilityBounds?.AGENT_EXPLORATION);
  const seen = await withHarnessOverrides(HARNESS_OVERRIDES, async shipped => ({ shipped, inside: universeConfig('TPCDS').explorationCatalog.postComa, queries: manifest.capabilityBounds.AGENT_EXPLORATION.maxQueriesPerRun }));
  assert.equal(seen.inside.coverAll, true); assert.ok(seen.queries >= 2000);
  assert.equal(JSON.stringify(universeConfig('TPCDS').explorationCatalog.postComa), before);
  assert.equal(JSON.stringify(manifest.capabilityBounds?.AGENT_EXPLORATION), bounds);
});

test('blind run with every piece that exists: all probed candidates are accounted for and nothing is cut silently', async () => {
  const result = await integration();
  assert.equal(result.run.status, 'COMPLETED');
  const c = result.candidates;
  assert.ok(c.proposals > 276 && c.executed > 0);
  if (result.pieces.find(piece => piece.id === 'P1')!.status === 'LANDED') {
    assert.equal(c.coverAll, true); assert.equal(c.notExecutedByBudget, 0, 'no candidate left out by an artificial cap'); assert.equal(c.executed, c.executable);
    assert.notEqual(c.postComaStatus, 'BUDGET_REQUIRED'); assert.ok(!result.sql.exhausted.includes('queries'), 'the probes did not exhaust the query budget');
  }
  assert.equal(c.executable + c.notExecutable, c.proposals);
});

test('0 reviews confused with HUMAN_REVIEWED; a stand-in review never fills a live MODEL_ADVERSARIAL slot; pass-two origin loss is measured and must be 0 once the engine applies the model overlay', async () => {
  const result = await integration();
  assert.equal(result.reviews.reduce((sum, review) => sum + review.originConfusions, 0), 0); assert.equal(result.sealed.engineReportHumanOverlay, false, 'a blind run carries no human overlay');
  const apply = result.pieces.find(piece => piece.id === 'R-1-apply')!;
  if (apply.status === 'LANDED') assert.equal(result.passTwo.originLost, 0, 'the engine applies model contracts: no verdict may lose MODEL_REVIEWED');
  assert.equal(result.sealed.modelVsHumanConfusions, result.passTwo.originLost, 'the headline is the review confusions (0) plus the verdicts that lost the seal');
  if (result.sealed.humanSlotSatisfiedByModel !== 'NOT_CHECKABLE') assert.equal(result.sealed.humanSlotSatisfiedByModel, false);
  for (const review of result.reviews) {
    assert.equal(review.provenance, 'STAND_IN_OFFLINE'); assert.equal(review.reviewsOfOtherOrigin, 0);
    assert.ok(review.counts.relations > 0);
  }
  assert.equal(satisfiesModelAdversarialSlot({ origin: 'MODEL_REVIEWED', provenance: 'STAND_IN_OFFLINE', decision: 'accept', adversarialPass: 'COMPLETED' }), false);
});

test('the comparison with act 3 keeps its denominators: 25 approved, 3 deferred, 3 decoys, every label in every configuration', async () => {
  const result = await integration();
  assert.equal(result.reviews.length, REVIEW_CONFIGS.length);
  for (const review of result.reviews) {
    const a = review.agreement;
    assert.deepEqual([a.yesN, a.deferredN, a.decoysN], [25, 3, 3]); assert.equal(review.rows.length, 31);
    assert.ok(a.yesAccepted >= 0 && a.yesAccepted <= 25 && a.deferredNotAccepted <= 3 && a.decoysNotAccepted <= 3);
    assert.equal(a.yesN - a.yesAccepted, a.missedAccepts.length);
    for (const row of review.rows) if (row.found === 'ABSENT') assert.equal(row.decision, 'NOT_PROPOSED', 'a relation COMA did not propose stays in the denominator as not accepted');
  }
  assert.equal(result.m12.length, 3);
});

test('the review only lowers what the evidence allows: the evidence-only ablation accepts at least as many decoys as the adversarial configuration', async () => {
  const [primary, ablation] = (await integration()).reviews;
  assert.ok(ablation.agreement.decoysNotAccepted <= primary.agreement.decoysNotAccepted, 'the semantic judges plus the adversarial pass never do worse on decoys than membership alone');
  assert.equal(ablation.adversarialCompleted, 0, 'the ablation has no adversarial pass');
});

test('the report names its labels honestly and marks what has not landed', async () => {
  const result = await integration(), text = renderReport(result);
  assert.match(text, /OFFLINE \/ SYNTHETIC fixture \/ SCRIPTED stand-in models/);
  assert.match(text, /offline evaluation set/);
  assert.doesNotMatch(text, /\bvalidated\b|\bvalidado\b/i, 'a model review is never called validated');
  assert.match(text, /MODEL_REVIEWED confused with HUMAN_REVIEWED \| \*\*\d+\*\* = reviews with another origin 0 of/);
  for (const piece of result.pieces.filter(item => item.status === 'NOT_YET_LANDED')) assert.ok(text.includes(`| ${piece.id} |`) && text.includes('NOT_YET_LANDED'), piece.id);
  assert.match(text, /\d+\/25/); assert.match(text, /\d+\/3/);
  assert.ok(!text.includes('liveOutcome'), 'the decoy outcomes of the live artifact are not part of the run output');
});

test('pass two: model-reviewed contracts become verdicts through the unchanged policy, the stage labels them, key sampling is the dispersed one, and the memory keeps a model review out of a HUMAN slot if the seal survived', async () => {
  const { passTwo } = await integration();
  assert.equal(passTwo.status, 'RAN'); assert.ok(passTwo.contracts > 0);
  assert.equal(Object.values(passTwo.verdicts).reduce((sum, n) => sum + n, 0), passTwo.contracts, 'one verdict per contract');
  assert.equal(passTwo.review!.label, 'revisado por modelo con pase adversarial'); assert.equal(passTwo.review!.provenance, 'STAND_IN_OFFLINE');
  assert.equal(passTwo.review!.approved, passTwo.contracts, 'the engine applied every approved contract (R-1)');
  assert.equal(passTwo.agreement!.decoyWithContract, 0, 'no decoy got a contract: a relation without a contract never reaches SOSTENIDA');
  assert.equal(Object.keys(passTwo.sampling).filter(key => key !== 'DISTINCT_POOL_STRIDE').length, 0, 'every probe seeded from the dispersed distinct pool (P2)');
  assert.equal(passTwo.memory!.claimsWritten >= passTwo.verdicts.SOSTENIDA, true, 'every sustained verdict was written to memory');
  assert.equal(passTwo.memory!.claimsModelReviewed, passTwo.memory!.claimsWritten, 'every claim is sealed MODEL_REVIEWED');
  assert.equal(passTwo.memory!.warmStartHumanSlotReused, 0, 'MODEL_REVIEWED never fills a HUMAN slot');
  assert.equal(passTwo.memory!.warmStartHumanSlotMismatch, passTwo.memory!.warmStartModelSlotReused, 'what a model slot can reuse, a human slot refuses');
  assert.equal(passTwo.caveats.status === 'LANDED', passTwo.caveats.decisions > 0 && passTwo.caveats.withGlobalCoverageCaveat < passTwo.caveats.decisions, 'caveats are measurements exactly when the full evidence reaches the run');
});

test('the model-accepted contracts are also scored against the 103-edge TPCDS gold, offline, with their denominators', async () => {
  const { goldScore, passTwo } = await integration();
  assert.equal(goldScore.goldEdges, 103); assert.equal(goldScore.accepted, passTwo.contracts);
  assert.equal(goldScore.truePositives + goldScore.falsePositives + goldScore.reversed <= goldScore.accepted + goldScore.reversed, true);
  assert.ok(goldScore.truePositives >= 0 && goldScore.truePositives <= goldScore.accepted);
});
