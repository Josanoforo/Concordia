import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPrevious, manifestSwitchesOf, classifySql, goldAtRuntimeViolationsR10, loadReference, renderReport, runIntegration, SWITCHES, specOf } from '../scripts/round10-integration.ts';
import { loadLabels } from '../scripts/round9-integration.ts';
import { resolveUniverseManifest } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { reviewCascadeOptions } from '../src/agent/cli-run.ts';

/** Round 10 phases A/B integration harness (X9), offline: SYNTHETIC fixture, scripted stand-in models, the deterministic COMA stand-in so the gate stays fast (the script itself uses the installed COMA). */
const reviewModeBefore = (resolveUniverseManifest('TPCDS') as any).reviewMode;
const shippedAtLoad = manifestSwitchesOf(resolveUniverseManifest('TPCDS'));
let cached: ReturnType<typeof runIntegration> | undefined;
const integration = () => (cached ??= runIntegration({ bridge: 'standin', cost: true, ceilings: false, r9Code: false, m12: true, resume: 150 }));

test('no runtime module names the evaluation labels, the gold or this lane\'s fixtures', () => {
  assert.deepEqual(goldAtRuntimeViolationsR10(), []);
});

test('the real TPCDS manifest ships all four Round 10 switches on, and cli-run turns the cascade on from the manifest', () => {
  assert.equal(shippedAtLoad.consistency, true); assert.equal(shippedAtLoad.tieBreak, true); assert.equal(shippedAtLoad.extendedProfile, true); assert.equal(shippedAtLoad.cascade, true);
  assert.deepEqual(reviewCascadeOptions(resolveUniverseManifest('TPCDS')), { config: { cascade: true } });
});

test('the Round 9 reference fixture is labelled REPLAY and consistent with the F-04 label denominators', () => {
  const ref = loadReference(), labels = loadLabels();
  assert.match(ref.label, /REPLAY/); assert.equal(ref.source.commit, '0d0dec3');
  assert.equal(labels.yes.length, 25); assert.ok(ref.numbers.yesAccepted! <= 25 && ref.numbers.deferredNotAccepted! <= 3 && ref.numbers.decoysWithoutContract === 3);
  assert.ok(ref.numbers.approvedTrue! <= ref.numbers.approved!);
});

test('the closed SQL forms are told apart and a profile scan names its logical table.column', () => {
  const cfg = universeConfig('TPCDS'), logical = (physical: string) => Object.entries<any>(cfg.tables).find(([, spec]) => spec.physicalTable === physical)?.[0];
  const f1 = 'SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT w_warehouse_sk) AS concordia_distinct, SUM(CASE WHEN w_warehouse_sk IS NULL THEN 1 ELSE 0 END) AS concordia_nulls FROM (SELECT w_warehouse_sk, w_warehouse_id FROM TPCDS_DB.warehouse) concordia_source';
  const f1x = 'SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT w_warehouse_sk) AS concordia_distinct, SUM(CASE WHEN w_warehouse_sk IS NULL THEN 1 ELSE 0 END) AS concordia_nulls, MIN(w_warehouse_sk) AS concordia_min, MAX(w_warehouse_sk) AS concordia_max, AVG(LENGTH(CAST(w_warehouse_sk AS STRING))) AS concordia_avg_len FROM (SELECT w_warehouse_sk, w_warehouse_id FROM TPCDS_DB.warehouse) concordia_source';
  assert.deepEqual([classifySql(f1, logical).form, classifySql(f1, logical).key], ['F1', 'warehouse.w_warehouse_sk']);
  assert.deepEqual([classifySql(f1x, logical).form, classifySql(f1x, logical).key], ['F1x', 'warehouse.w_warehouse_sk']);
  assert.equal(classifySql('SELECT COUNT(*) AS concordia_missing_rows FROM x', logical).form, 'F3c');
  assert.equal(classifySql('SELECT COUNT(*) AS concordia_missing FROM (SELECT DISTINCT k', logical).form, 'F3b');
  assert.equal(classifySql('SELECT a FROM TPCDS_DB.t', logical).form, 'OTHER');
});

test('the Round 10 switches exist and the two compared runs differ only by them', () => {
  assert.deepEqual(SWITCHES.A_BASELINE, { consistency: false, cascade: false, extendedProfile: false, tieBreak: false });
  assert.deepEqual(SWITCHES.B_ROUND10, { consistency: true, cascade: true, extendedProfile: true, tieBreak: true });
  assert.deepEqual(specOf('B_ROUND10', 'MAX').tokenCeiling, 'MAX');
});

test('both runs complete offline and keep the invariants: decoys without a contract 3/3, 0 MODEL_REVIEWED confused with HUMAN_REVIEWED, every decision and claim sealed MODEL_REVIEWED', async () => {
  const { primary: { a, b } } = await integration();
  for (const m of [a, b]) {
    const i = m.invariants;
    assert.equal(i.yesN, 25); assert.equal(i.deferredN, 3); assert.equal(i.decoyN, 3); assert.equal(i.m12N, 3);
    assert.equal(i.decoyContracts, 0, 'no decoy gets a contract'); assert.equal(i.confusions, 0);
    assert.equal(i.nonModelOrigin, 0); assert.equal(i.claimsNonModel, 0); assert.ok(i.decisions > 0 && i.claims === i.decisions);
    assert.equal(m.candidates.notExecutedByBudget, 0, 'every executable candidate was probed');
    assert.equal(i.approvedTrue + i.approvedFalse, i.approved);
    assert.equal(i.goldEdges, 103);
  }
});

test('the recall funnel accounts for every gold edge in both runs, and the profile cache holds: at most one scan per column per run', async () => {
  const { primary: { a, b } } = await integration();
  for (const m of [a, b]) {
    assert.equal(Object.keys(m.funnelStages).length, 103);
    assert.equal(Object.values(m.funnel.byStage).reduce((sum, n) => sum + n, 0), 103);
    assert.ok(m.sql.maxScansPerColumn <= 1, `a column was scanned ${m.sql.maxScansPerColumn} times: ${m.sql.repeatedColumns.join(', ')}`);
    assert.equal(m.sql.profileScans, m.sql.profileColumns);
    assert.equal(m.memory.admitted! + m.memory.rejected!, m.memory.total);
  }
  const { runs } = await integration(), noF1x = runs.B_NO_EXTENDED!;
  assert.equal(noF1x.sql.forms.F1x ?? 0, 0, 'without manifest.fullEvidenceExtendedProfile only F1 scans are sent'); assert.equal(b.sql.forms.F1 ?? 0, 0, 'with it F1x replaces F1 in the same scan');
  assert.equal(noF1x.sql.profileScans, b.sql.profileScans, 'F1x adds no statement');
});

test('(b) turns the switches on and (a) does not: consistency, cascade and the tie-break vector leave their trace', async () => {
  const { primary: { a, b } } = await integration();
  assert.equal(a.review.consistencyStatus, 'OFF'); assert.equal(b.review.consistencyStatus, 'ENFORCED');
  assert.equal(b.consistency.trueFkDemoted, 0, 'the consistency pass never demotes a true foreign key on this fixture');
  assert.equal(a.review.skippedByCascade, 0); assert.ok(b.review.skippedByCascade > 0);
  assert.equal(a.ties.review.groups, 0); assert.ok(b.ties.review.groups > 0);
  assert.equal(b.ties.review.groups, b.ties.review.decisive + b.ties.review.deferred);
  for (const row of b.ties.review.rows) assert.ok(row.decisive || row.reason.startsWith('NOT_DECISIVE'), 'a deferred tie keeps its reason');
  assert.ok(b.review.modelTable.length >= 2, 'the model table per role (E5-07) is in the overlay');
});

test('the cascade lowers the calls without changing what is approved', async () => {
  const { runs } = await integration();
  const a = runs.A_BASELINE!, cascade = runs.A_CASCADE!;
  assert.ok(cascade.review.calls < a.review.calls); assert.ok(cascade.review.tokens < a.review.tokens);
  assert.equal(cascade.review.approved, a.review.approved);
  assert.ok(runs.B_NO_TIEBREAK!.review.tokens <= runs.B_ROUND10!.review.tokens, 'the tie-break block never makes the review cheaper');
});

test('the harness leaves the manifest and the config as it found them', async () => {
  await integration();
  const manifest: any = resolveUniverseManifest('TPCDS');
  assert.deepEqual(manifestSwitchesOf(manifest).raw, shippedAtLoad.raw, 'the four switches are back as shipped'); assert.equal(manifest.reviewMode, reviewModeBefore);
  assert.equal(universeConfig('TPCDS').explorationCatalog.postComa.coverAll, true, 'the shipped TPCDS config already declares coverAll');
});

test('the report is labelled OFFLINE / SYNTHETIC / STAND-IN, keeps denominators and never says validated; open items carry an owner', async () => {
  const result = await integration(), text = renderReport(result);
  assert.match(text, /OFFLINE \/ SYNTHETIC fixture \/ SCRIPTED stand-in models \(STAND_IN_OFFLINE\)/);
  assert.doesNotMatch(text, /\bvalidated\b|\bvalidado\b/i);
  for (const heading of ['## 1. Headline', '## 2. Recall funnel', '## 3. Ties', '## 4. Reversed edges', '## 5. Global consistency', '## 6. Review cost', '## 7. SQL', '## 8. Invariants', '## 10. Health', '## 11. Live M12', '## 12. Resume', '## 13. The ceiling', '## 14. Open items', '## 16. Final validation', 'Appendix A']) assert.ok(text.includes(heading), heading);
  assert.match(text, /\d+\/25/); assert.match(text, /\d+\/103/); assert.match(text, /promotion\.p_end_date_sk/);
  assert.match(text, /goldAtRuntimeViolations`: \*\*0\*\*/);
  for (const item of result.openItems) { assert.ok(item.owner.length > 0 && item.files.length > 0 && item.title.length > 0); assert.ok(text.includes(item.title)); }
  assert.ok(!text.includes('liveOutcome'));
});

test('previous-report fixture is a labelled REPLAY of the commit it names', () => {
  const previous = loadPrevious();
  assert.match(previous.label, /REPLAY/); assert.equal(previous.source.commit, '51260a9'); assert.ok(Number(previous.numbers.bApprovedTrue) <= Number(previous.numbers.bApproved));
});

test('ties: a decisive tie-break in the review never points at income_band, and every review tie group keeps its reason', async () => {
  const { primary: { b } } = await integration();
  assert.ok(b.ties.review.groups > 0);
  assert.deepEqual(b.ties.review.winnersNotGold.filter(id => /__income_band./.test(id)), []);
  assert.equal(b.ties.review.decisive + b.ties.review.deferred, b.ties.review.groups);
});

test('live M12: F4 widens a 1-key discovery sample to at least 3 probed keys, keeps the invariants, and costs one read per degenerate column', async () => {
  const { m12 } = await integration();
  assert.ok(m12); assert.equal(m12!.columns, 6);
  const { withF4, withoutF4 } = m12!;
  assert.equal(withF4.rows.length, 3); assert.equal(withoutF4.rows.length, 3);
  for (const row of withF4.rows) { assert.equal(row.samplingSource, 'GLOBAL_DISTINCT_F4'); assert.ok((row.probedKeys ?? 0) >= 3, row.id + ' probed keys'); }
  for (const row of withoutF4.rows) { assert.equal(row.samplingSource, 'DISCOVERY_SAMPLE'); assert.ok((row.probedKeys ?? 99) < 3, row.id + ' stays degenerate without F4'); }
  assert.equal(withF4.f4PoolReads, 6, '+1 SQL per degenerate column'); assert.equal(withoutF4.f4PoolReads, 0); assert.ok(withoutF4.f4Blocked >= 6);
  for (const arm of [withF4, withoutF4]) { assert.equal(arm.decoyContracts, 0); assert.equal(arm.confusions, 0); }
});

test('resume: a run killed after k post-COMA probes resumes with the same verdicts, resumedProbes = k and fewer queries', async () => {
  const { resume } = await integration();
  assert.ok(resume); assert.equal(resume!.status, 'RAN', resume!.detail);
  assert.ok(resume!.journaledAtKill >= 150);
  assert.equal(resume!.resumed!.resume!.resumedProbes, resume!.journaledAtKill);
  assert.equal(resume!.identicalVerdicts, true, (resume!.verdictDiffs ?? []).join('; '));
  assert.equal(resume!.sameApproved, true); assert.ok(resume!.queriesSaved! > 0); assert.equal(resume!.resumed!.resume!.interruptions, 1);
});

test('(a) and (b) declare their switches explicitly: the as-shipped run, through the real review path, matches the declared (b) and gets the cascade from the manifest', async () => {
  const { primary: { b }, shippedRun, shippedSwitches } = await integration();
  assert.deepEqual(shippedSwitches, { consistency: true, cascade: true, extendedProfile: true, tieBreak: true });
  assert.ok(shippedRun); assert.equal(shippedRun!.spec.asShipped, true);
  assert.equal(shippedRun!.status, 'COMPLETED');
  assert.deepEqual([...shippedRun!.approvedIds].sort(), [...b.approvedIds].sort());
  assert.ok(shippedRun!.review.skippedByCascade > 0, 'the cascade came from reviewCascade in the manifest, not from an injection');
  assert.equal(shippedRun!.review.consistencyStatus, 'ENFORCED'); assert.ok(shippedRun!.ties.review.groups > 0);
  assert.equal(shippedRun!.invariants.decoyContracts, 0); assert.equal(shippedRun!.invariants.confusions, 0);
  assert.ok(shippedRun!.review.tokens <= 4_000_000);
});

test('live M12 after the key-basis fix: with F4 the 3 relations carry basis GLOBAL_DISTINCT_F4 with at least 3 keys and reach a verdict or a deferral that is not INSUFFICIENT_DISTINCT_KEYS', async () => {
  const { m12 } = await integration();
  for (const row of m12!.withF4.rows) {
    assert.equal(row.fromBasis, 'GLOBAL_DISTINCT_F4', row.id); assert.ok((row.distinctKeys ?? 0) >= 3, `${row.id} distinct source keys ${row.distinctKeys}`);
    assert.ok(row.approved || !/INSUFFICIENT_DISTINCT_KEYS/.test(row.whyNot ?? ''), `${row.id}: ${row.whyNot}`);
    if (row.approved) assert.ok(row.verdict, `${row.id} has a verdict`);
  }
  for (const row of m12!.withoutF4.rows) assert.match(row.whyNot ?? '', /INSUFFICIENT_DISTINCT_KEYS/);
});
