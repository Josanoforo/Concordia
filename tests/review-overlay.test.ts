import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { readReviewOverlayFile, validateReviewOverlay, withReviewOverlay } from '../src/agent/review-overlay.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { ROOT } from '../src/runtime.ts';
import { removePath } from './helpers/safe-rm.ts';

/**
 * F-04 review overlay for TPCDS. Every overlay in this file is SYNTHETIC_TEST: it proves the mechanism and is not a human review of anything.
 * No real overlay exists, no memory is written, and act 1 (blind discovery) never reads an overlay.
 */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const made: string[] = [];
test.after(() => { for (const dir of made) removePath(dir); });
const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'TPCDS')!);
const approval = { approver: 'SYNTHETIC test approver', approvedAt: '2026-10-26T00:00:00Z', quote: 'SYNTHETIC TEST QUOTE: this is not a human approval', session: 'synthetic-test-session' };
const relation = (id: string, from: [string, string], to: [string, string], extra: Record<string, unknown> = {}) => ({ id, from: { table: from[0], column: from[1] }, to: { table: to[0], column: to[1] }, kind: 'FOREIGN_KEY', reviewState: 'REVIEWED', identifierSpace: `synthetic-${to[0]}-sk`,
  normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationLossless: true, normalizationAdapterCapability: 'exact-text', ...extra });
const overlay = (relations: any[], over: Record<string, unknown> = {}) => ({ schemaVersion: 1, universe: 'TPCDS', origin: 'SYNTHETIC_TEST', approval: structuredClone(approval), relations, ...over });
const codes = (value: unknown, options = { allowSynthetic: true }) => validateReviewOverlay(value, 'TPCDS', options).map(issue => issue.code);
const good = () => overlay([relation('ss_item_sk_item', ['store_sales', 'ss_item_sk'], ['item', 'i_item_sk'])]);

test('without a complete approval block the overlay fails closed with REVIEW_APPROVAL_MISSING and nothing runs', async () => {
  assert.deepEqual(codes(good()), []);
  for (const field of ['approver', 'approvedAt', 'quote', 'session']) {
    const broken = good() as any; delete broken.approval[field];
    assert.ok(codes(broken).includes('REVIEW_APPROVAL_MISSING'), field);
    let ran = false; await assert.rejects(() => withReviewOverlay('TPCDS', { overlay: broken }, async () => { ran = true; }, { allowSynthetic: true }), /REVIEW_APPROVAL_MISSING/); assert.equal(ran, false, `${field}: the run never starts`);
  }
  for (const approvalValue of [undefined, null, 'project-owner', {}, { ...approval, approvedAt: 'not a date' }, { ...approval, quote: '   ' }]) assert.ok(codes(overlay([], { approval: approvalValue })).includes('REVIEW_APPROVAL_MISSING'), JSON.stringify(approvalValue));
});

test('relations outside the TPCDS allowlist, malformed contracts, duplicates, other universes and unlabelled synthetic overlays are all refused', () => {
  assert.ok(codes(overlay([relation('x', ['store_sales', 'ss_not_a_column'], ['store', 's_store_sk'])])).includes('REVIEW_RELATION_OUTSIDE_ALLOWLIST'), 'a column that is not allowlisted');
  assert.ok(codes(overlay([relation('x', ['not_a_table', 'k'], ['store', 's_store_sk'])])).includes('REVIEW_RELATION_OUTSIDE_ALLOWLIST'), 'a table that is not in the universe');
  assert.ok(codes(overlay([relation('x', ['store_sales', 'ss_store_sk'], ['customer', 'c_first_name'])])).includes('REVIEW_RELATION_OUTSIDE_ALLOWLIST'), 'a personal-data column is outside the allowlist');
  for (const bad of [{ reviewState: 'PENDING' }, { kind: 'IDENTITY' }, { identifierSpace: '' }, { normalization: 'integer-pad10' }, { normalizationLossless: false }, { normalizationAdapterCapability: undefined }, { minDistinctKeys: 0 }])
    assert.ok(codes(overlay([relation('x', ['store_sales', 'ss_item_sk'], ['item', 'i_item_sk'], bad)])).includes('REVIEW_RELATION_INVALID'), JSON.stringify(bad));
  const duplicate = relation('same', ['store_sales', 'ss_item_sk'], ['item', 'i_item_sk']);
  assert.ok(codes(overlay([duplicate, duplicate])).includes('REVIEW_RELATION_INVALID'));
  assert.ok(validateReviewOverlay(good(), 'U1', { allowSynthetic: true }).some(issue => issue.code === 'REVIEW_UNIVERSE_MISMATCH'));
  assert.deepEqual(codes(good(), { allowSynthetic: false }), ['REVIEW_SYNTHETIC_NOT_ALLOWED'], 'a SYNTHETIC_TEST overlay is refused unless a test allows it, so the CLI can never apply one');
  assert.ok(codes(overlay([])).includes('REVIEW_OVERLAY_INVALID'));
});

test('overlay files are read only from approved folders as regular *.review.json files', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'review-overlay-')); made.push(dir);
  const file = path.join(dir, 'TPCDS.review.json'); fs.writeFileSync(file, JSON.stringify(good()));
  const read = readReviewOverlayFile(file);
  assert.equal(read.sha256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  for (const bad of [path.join(dir, 'TPCDS.json'), path.join(ROOT, 'universes', 'TPCDS.json'), path.join(ROOT, '..', 'x.review.json'), path.join(dir, 'missing.review.json'), dir]) assert.throws(() => readReviewOverlayFile(bad), /REVIEW_FILE_PATH_INVALID/, bad);
  fs.writeFileSync(path.join(dir, 'broken.review.json'), '{ nope'); assert.throws(() => readReviewOverlayFile(path.join(dir, 'broken.review.json')), /REVIEW_OVERLAY_INVALID/);
});

test('the overlay is applied only inside the call that names it: TPCDS.json and its blind relations: [] are untouched before, during-outside, after and after a failure', async () => {
  const bytes = fs.readFileSync(path.join(ROOT, 'universes', 'TPCDS.json'), 'utf8');
  assert.deepEqual(universeConfig('TPCDS').relations, []);
  let inside: any;
  await withReviewOverlay('TPCDS', { overlay: good() }, async () => { inside = universeConfig('TPCDS').relations; }, { allowSynthetic: true });
  assert.equal(inside.length, 1); assert.deepEqual([inside[0].reviewState, inside[0].kind, inside[0].reviewAuthorization.overlayOrigin, inside[0].reviewAuthorization.quote], ['REVIEWED', 'FOREIGN_KEY', 'SYNTHETIC_TEST', approval.quote]);
  assert.match(inside[0].reviewAuthorization.overlaySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(universeConfig('TPCDS').relations, [], 'dropped when the call ends');
  await assert.rejects(() => withReviewOverlay('TPCDS', { overlay: good() }, async () => { throw new Error('boom'); }, { allowSynthetic: true }), /boom/);
  assert.deepEqual(universeConfig('TPCDS').relations, [], 'dropped when the call fails');
  await assert.rejects(() => withReviewOverlay('TPCDS', { overlay: good() }, () => withReviewOverlay('TPCDS', { overlay: good() }, async () => {}, { allowSynthetic: true }), { allowSynthetic: true }), /REVIEW_ALREADY_ACTIVE/);
  assert.equal(fs.readFileSync(path.join(ROOT, 'universes', 'TPCDS.json'), 'utf8'), bytes, 'the universe config file is never edited');
  const sources = ['src/agent', 'src/relations', 'src/probe', 'src/discovery', 'src/registry', 'src/critic'].flatMap(dir => fs.readdirSync(path.join(ROOT, dir), { recursive: true }).map(name => path.join(dir, String(name)))).filter(file => file.endsWith('.ts') && !['review-overlay.ts', 'cli-help.ts', 'cli-run.ts'].includes(path.basename(file)));
  for (const file of sources) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /universes[\\/]+reviews|\.review\.json/, `${file} never looks for an overlay by itself (only the --review wiring and its help text may name one)`);
});

test('act 1 stays blind with an overlay file on disk: no option, no relations, no verdict, no review authorization', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'review-overlay-')); made.push(dir);
  fs.writeFileSync(path.join(dir, 'TPCDS.review.json'), JSON.stringify(good()));
  const f = fixture(), run = (id: string) => runAgent('TPCDS', id, { ...offlineAgentDeps('TPCDS', f, new Script([...f.chooserScript])), persist: false, critic: false }) as Promise<any>;
  const withFile = await run('agent-tpcds-blind-with-file');
  fs.rmSync(path.join(dir, 'TPCDS.review.json'));
  const without = await run('agent-tpcds-blind-without-file');
  for (const report of [withFile, without]) { assert.deepEqual(report.decisions, []); assert.deepEqual(report.phases.discovery.relations, []); assert.equal(report.phases.coma.status, 'RAN'); assert.deepEqual(report.phases.probes.selected, []); assert.ok(report.postComa.counts.proposals > 0); }
  assert.deepEqual(withFile.postComa.counts, without.postComa.counts, 'the overlay file changes nothing about the blind run');
  assert.ok(!JSON.stringify(withFile).includes('reviewAuthorization'));
});

test('act 3 mechanism on the synthetic fixture: with distinct-keys and the overlay the unchanged policy gives SOSTENIDA for 3 or more distinct keys and INDETERMINADA for 1; no memory is written', async () => {
  const f = fixture(), inventory = f.tables.inventory, index = inventory.columns.findIndex(column => column.name === 'inv_warehouse_sk');
  for (const row of inventory.rows) row[index] = f.tables.warehouse.rows[0][0];
  assert.equal(new Set(inventory.rows.map(row => row[index])).size, 1);
  const memoryDir = path.join(ROOT, '.concordia', 'agent-memory', 'TPCDS'), memoryBefore = fs.existsSync(memoryDir);
  const synthetic = overlay([relation('ss_item_sk', ['store_sales', 'ss_item_sk'], ['item', 'i_item_sk']), relation('inv_warehouse_sk', ['inventory', 'inv_warehouse_sk'], ['warehouse', 'w_warehouse_sk'])]);
  const report: any = await withReviewOverlay('TPCDS', { overlay: synthetic }, () => runAgent('TPCDS', 'agent-tpcds-review-synthetic', { ...offlineAgentDeps('TPCDS', f, new Script([...f.chooserScript])), persist: false, critic: false }), { allowSynthetic: true });
  assert.equal(universeConfig('TPCDS').probeMode, 'distinct-keys');
  const verdicts = Object.fromEntries(report.decisions.map((item: any) => [item.relationId, [item.verdict, item.reasonCodes[0]]]));
  assert.deepEqual(verdicts.ss_item_sk, ['SOSTENIDA', 'bounded_sample_key_membership'], 'three distinct keys, reviewed: sustained on the bounded sample');
  assert.deepEqual(verdicts.inv_warehouse_sk, ['INDETERMINADA', 'insufficient_distinct_sample_keys'], 'one distinct key: the policy does not move');
  assert.equal(fs.existsSync(memoryDir), memoryBefore, 'no memory is written');
  const blind: any = await runAgent('TPCDS', 'agent-tpcds-after-review', { ...offlineAgentDeps('TPCDS', fixture(), new Script([...fixture().chooserScript])), persist: false, critic: false });
  assert.deepEqual(blind.decisions, [], 'the next run without the option is blind again');
});
