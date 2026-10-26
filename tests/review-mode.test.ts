import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REVIEW_MODES, DEFAULT_REVIEW_MODE, missingReviewOrigins, requiredReviewMode, reviewModeSatisfied } from '../src/registry/review-mode.ts';
import { resolveUniverseManifest, universeManifests, validateUniverseConfig, validateUniverseRegistry } from '../src/registry/universes.ts';
import { validateReviewOverlay, withReviewOverlay } from '../src/agent/review-overlay.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { ROOT } from '../src/runtime.ts';

/** Round 9 R-config: the required review per universe/relation is declared config, HUMAN by default, validated by the registry. */
const manifests = () => structuredClone(universeManifests) as any[];

test('only NWCH and TPCDS declare a mode (the reviewer check and the Round 9 full run); every other universe and relation resolves to HUMAN, and the registry stays valid', () => {
  assert.deepEqual(validateUniverseRegistry(universeManifests), []);
  assert.equal(DEFAULT_REVIEW_MODE, 'HUMAN');
  for (const manifest of universeManifests) {
    const declared = (manifest as any).reviewMode;
    if (manifest.aliases.includes('NWCH') || manifest.aliases.includes('TPCDS')) { assert.equal(declared, 'MODEL_ADVERSARIAL'); continue; }
    assert.equal(declared, undefined, manifest.manifestId); assert.equal(requiredReviewMode(manifest), 'HUMAN'); assert.equal(requiredReviewMode(manifest, 'any_relation'), 'HUMAN');
  }
});

test('precedence: relation declaration > manifest per-relation override > manifest mode > HUMAN', () => {
  const manifest = { reviewMode: 'HUMAN_OR_MODEL', reviewModeByRelation: { r1: 'BOTH' } } as const;
  assert.equal(requiredReviewMode(manifest), 'HUMAN_OR_MODEL');
  assert.equal(requiredReviewMode(manifest, 'r2'), 'HUMAN_OR_MODEL');
  assert.equal(requiredReviewMode(manifest, 'r1'), 'BOTH');
  assert.equal(requiredReviewMode(manifest, 'r1', { reviewMode: 'MODEL_ADVERSARIAL' }), 'MODEL_ADVERSARIAL');
  assert.equal(requiredReviewMode(manifest, 'r1', { reviewMode: 'nonsense' }), 'BOTH', 'an invalid relation value is ignored here; the validators reject it');
  assert.equal(requiredReviewMode(undefined, 'r1'), 'HUMAN');
});

test('a mode is only satisfied by the origins it names: a model review never fills a human slot and the reverse', () => {
  assert.deepEqual(REVIEW_MODES, ['HUMAN', 'MODEL_ADVERSARIAL', 'HUMAN_OR_MODEL', 'BOTH']);
  const H = ['HUMAN_REVIEWED'] as const, M = ['MODEL_REVIEWED'] as const, HM = ['HUMAN_REVIEWED', 'MODEL_REVIEWED'] as const;
  const table: Record<string, [boolean, boolean, boolean, boolean]> = { HUMAN: [false, true, false, true], MODEL_ADVERSARIAL: [false, false, true, true], HUMAN_OR_MODEL: [false, true, true, true], BOTH: [false, false, false, true] };
  for (const [mode, expected] of Object.entries(table)) assert.deepEqual([[], H, M, HM].map(obtained => reviewModeSatisfied(mode as any, obtained as any)), expected, mode);
  assert.deepEqual(missingReviewOrigins('HUMAN', M), ['HUMAN_REVIEWED']);
  assert.deepEqual(missingReviewOrigins('BOTH', H), ['MODEL_REVIEWED']);
  assert.deepEqual(missingReviewOrigins('BOTH', []), ['HUMAN_REVIEWED', 'MODEL_REVIEWED']);
  assert.deepEqual(missingReviewOrigins('HUMAN_OR_MODEL', HM), []);
});

test('the registry validates declared modes: bad values, a bad override map and a bad relation id are rejected', () => {
  const valid = manifests(), target = valid.find(m => m.aliases.includes('TPCDS'));
  target.reviewMode = 'BOTH'; target.reviewModeByRelation = { 'a.b__c.d': 'MODEL_ADVERSARIAL' };
  assert.deepEqual(validateUniverseRegistry(valid), []);
  const bad = manifests(), tpcds = bad.find(m => m.aliases.includes('TPCDS'));
  tpcds.reviewMode = 'AUTO'; assert.ok(validateUniverseRegistry(bad).some(i => i.code === 'INVALID_REVIEW_MODE' && i.path.endsWith('.reviewMode')));
  tpcds.reviewMode = 'HUMAN'; tpcds.reviewModeByRelation = ['x']; assert.ok(validateUniverseRegistry(bad).some(i => i.code === 'INVALID_REVIEW_MODE_BY_RELATION'));
  tpcds.reviewModeByRelation = { ok_id: 'robot' }; assert.ok(validateUniverseRegistry(bad).some(i => i.code === 'INVALID_REVIEW_MODE'));
  tpcds.reviewModeByRelation = { 'bad id!': 'HUMAN' }; assert.ok(validateUniverseRegistry(bad).some(i => i.code === 'INVALID_REVIEW_MODE_RELATION_ID'));
});

test('a config relation may carry its own mode and the config validator rejects a bad one', () => {
  const manifest = resolveUniverseManifest('U1')!, config = structuredClone(universeConfig('U1'));
  assert.deepEqual(validateUniverseConfig(manifest, config), []);
  config.relations[0].reviewMode = 'BOTH'; assert.deepEqual(validateUniverseConfig(manifest, config), []);
  config.relations[0].reviewMode = 'nope'; assert.ok(validateUniverseConfig(manifest, config).some(i => i.code === 'INVALID_REVIEW_MODE'));
});

test('an overlay relation may declare its mode; it travels into the applied relation, and the real overlay is unchanged', async () => {
  const approval = { approver: 'SYNTHETIC', approvedAt: '2026-10-26T00:00:00Z', quote: 'SYNTHETIC TEST', session: 's' };
  const relation = (extra: object) => ({ id: 'ss_item_sk_item', from: { table: 'store_sales', column: 'ss_item_sk' }, to: { table: 'item', column: 'i_item_sk' }, kind: 'FOREIGN_KEY', reviewState: 'REVIEWED', identifierSpace: 'synthetic-item-sk',
    normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationLossless: true, normalizationAdapterCapability: 'exact-text', ...extra });
  const overlay = (extra: object) => ({ schemaVersion: 1, universe: 'TPCDS', origin: 'SYNTHETIC_TEST', approval, relations: [relation(extra)] });
  assert.deepEqual(validateReviewOverlay(overlay({ reviewMode: 'BOTH' }), 'TPCDS', { allowSynthetic: true }), []);
  assert.ok(validateReviewOverlay(overlay({ reviewMode: 'x' }), 'TPCDS', { allowSynthetic: true }).some(i => i.code === 'REVIEW_RELATION_INVALID'));
  let applied: any; await withReviewOverlay('TPCDS', { overlay: overlay({ reviewMode: 'BOTH' }) }, async () => { applied = universeConfig('TPCDS').relations[0]; }, { allowSynthetic: true });
  assert.equal(applied.reviewMode, 'BOTH');
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'universes', 'reviews', 'TPCDS.review.json'), 'utf8'));
  assert.ok(real.relations.every((item: any) => item.reviewMode === undefined), 'the human F-04 overlay declares no mode: it stays HUMAN by default');
});

test('R-1: an overlay with origin MODEL_REVIEW is MODEL_REVIEWED, never human, and is refused where a human contract is required', async () => {
  const approval = { approver: 'model-review run agent-test-1', approvedAt: '2026-10-26T00:00:00Z', quote: 'model contract: accepted by judges, survived the adversarial pass', session: 'agent-test-1' };
  const relation = (table: string, column: string, parent: string, parentColumn: string, extra: object = {}) => ({ id: `${table}.${column}__${parent}.${parentColumn}`, from: { table, column }, to: { table: parent, column: parentColumn }, kind: 'FOREIGN_KEY', reviewState: 'REVIEWED',
    identifierSpace: 'nwch-order-id-v1', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationLossless: true, normalizationAdapterCapability: 'exact-text', ...extra });
  const overlay = (universe: string, origin: string, relations: object[]) => ({ schemaVersion: 1, universe, origin, approval, relations });
  const nwch = overlay('NWCH', 'MODEL_REVIEW', [relation('northwind_order_details', 'OrderID', 'northwind_orders', 'OrderID')]);
  assert.deepEqual(validateReviewOverlay(nwch, 'NWCH'), [], 'valid without allowSynthetic');
  let applied: any; await withReviewOverlay('NWCH', { overlay: nwch }, async () => { applied = universeConfig('NWCH').relations[0]; });
  assert.deepEqual([applied.reviewOrigin, applied.reviewAuthorization.overlayOrigin, applied.reviewState], ['MODEL_REVIEWED', 'MODEL_REVIEW', 'REVIEWED']);
  const tpcdsHuman = overlay('TPCDS', 'MODEL_REVIEW', [relation('store_sales', 'ss_item_sk', 'item', 'i_item_sk', { reviewMode: 'HUMAN' })]);
  await assert.rejects(() => withReviewOverlay('TPCDS', { overlay: tpcdsHuman }, async () => {}), /REVIEW_MODEL_NOT_ACCEPTED_FOR_MODE/, 'a relation that requires HUMAN refuses a model contract');
  const declared = overlay('TPCDS', 'MODEL_REVIEW', [relation('store_sales', 'ss_item_sk', 'item', 'i_item_sk', { reviewMode: 'HUMAN_OR_MODEL' })]);
  await withReviewOverlay('TPCDS', { overlay: declared }, async () => { applied = universeConfig('TPCDS').relations[0]; });
  assert.equal(applied.reviewOrigin, 'MODEL_REVIEWED');
  const human = JSON.parse(fs.readFileSync(path.join(ROOT, 'universes', 'reviews', 'TPCDS.review.json'), 'utf8'));
  await withReviewOverlay('TPCDS', { overlay: human }, async () => { applied = universeConfig('TPCDS').relations[0]; });
  assert.equal(applied.reviewOrigin, 'HUMAN_REVIEWED');
  assert.ok(validateReviewOverlay({ ...nwch, origin: 'ROBOT' }, 'NWCH').some(i => i.code === 'REVIEW_OVERLAY_INVALID'));
});

test('fullEvidence is a boolean manifest declaration, only for universes that probe; TPCDS and NWCH declare it', () => {
  for (const alias of ['TPCDS', 'NWCH']) assert.equal((resolveUniverseManifest(alias) as any).fullEvidence, true, alias);
  const bad = manifests(), tpcds = bad.find(m => m.aliases.includes('TPCDS'));
  tpcds.fullEvidence = 'yes'; assert.ok(validateUniverseRegistry(bad).some(i => i.code === 'INVALID_FULL_EVIDENCE'));
  tpcds.fullEvidence = true; tpcds.capabilities = tpcds.capabilities.filter((c: string) => c !== 'BOUNDED_RELATION_PROBE' && c !== 'AGENT_EXPLORATION'); assert.ok(validateUniverseRegistry(bad).some(i => i.code === 'INVALID_FULL_EVIDENCE'));
});

test('a HUMAN_REVIEW overlay relation without a declared mode requires HUMAN, so the human contract (act 3) stays usable when its universe asks for MODEL_ADVERSARIAL', async () => {
  const human = JSON.parse(fs.readFileSync(path.join(ROOT, 'universes', 'reviews', 'TPCDS.review.json'), 'utf8'));
  let applied: any[] = []; await withReviewOverlay('TPCDS', { overlay: human }, async () => { applied = universeConfig('TPCDS').relations; });
  assert.equal(applied.length, 25);
  assert.ok(applied.every(item => item.reviewMode === 'HUMAN' && item.reviewOrigin === 'HUMAN_REVIEWED'));
  assert.equal(requiredReviewMode(resolveUniverseManifest('TPCDS'), applied[0].id, applied[0]), 'HUMAN');
  assert.equal(requiredReviewMode(resolveUniverseManifest('TPCDS'), 'some_model_candidate'), 'MODEL_ADVERSARIAL');
});

test('consistency is an optional manifest declaration {enabled, aliases?}, on only in TPCDS', () => {
  for (const manifest of universeManifests as any[]) assert.ok(manifest.consistency === undefined || manifest.consistency.enabled === manifest.aliases.includes('TPCDS'), manifest.aliases[0]);
  const bad = manifests(), tpcds = bad.find(m => m.aliases.includes('TPCDS'));
  const codes = () => validateUniverseRegistry(bad).map(i => i.code);
  tpcds.consistency = { enabled: true, aliases: [{ source: 'store_sales.ss_sold_date_sk', targets: ['date_dim', 'time_dim.t_time_sk'] }] }; assert.ok(!codes().includes('INVALID_CONSISTENCY'));
  tpcds.consistency = { enabled: false }; assert.ok(!codes().includes('INVALID_CONSISTENCY'));
  for (const invalid of ['on', { enabled: 'yes' }, {}, { enabled: true, aliases: 'x' }, { enabled: true, aliases: [{ source: 'nodot', targets: ['t'] }] }, { enabled: true, aliases: [{ source: 'a.b', targets: [] }] }]) { tpcds.consistency = invalid; assert.ok(codes().includes('INVALID_CONSISTENCY'), JSON.stringify(invalid)); }
});

test('fullEvidenceExtendedProfile (boolean) and tieBreak ({enabled}) are optional manifest declarations, on only in TPCDS', () => {
  for (const manifest of universeManifests as any[]) { const isTpcds = manifest.aliases.includes('TPCDS'); assert.equal(!!manifest.fullEvidenceExtendedProfile, isTpcds, manifest.aliases[0]); assert.ok(manifest.tieBreak === undefined || manifest.tieBreak.enabled === isTpcds, manifest.aliases[0]); }
  const bad = manifests(), tpcds = bad.find(m => m.aliases.includes('TPCDS'));
  const codes = () => validateUniverseRegistry(bad).map(i => i.code);
  tpcds.fullEvidenceExtendedProfile = true; tpcds.tieBreak = { enabled: true }; assert.ok(!codes().includes('INVALID_FULL_EVIDENCE_EXTENDED_PROFILE') && !codes().includes('INVALID_TIE_BREAK'));
  for (const invalid of ['yes', 1, null]) { tpcds.fullEvidenceExtendedProfile = invalid; assert.ok(codes().includes('INVALID_FULL_EVIDENCE_EXTENDED_PROFILE'), String(invalid)); }
  tpcds.fullEvidenceExtendedProfile = true; tpcds.capabilities = tpcds.capabilities.filter((c: string) => c !== 'BOUNDED_RELATION_PROBE' && c !== 'AGENT_EXPLORATION'); assert.ok(codes().includes('INVALID_FULL_EVIDENCE_EXTENDED_PROFILE'));
  for (const invalid of ['on', {}, { enabled: 'yes' }, [], null]) { tpcds.tieBreak = invalid; assert.ok(codes().includes('INVALID_TIE_BREAK'), JSON.stringify(invalid)); }
});

test('reviewCascade is an optional manifest declaration {enabled}; TPCDS declares all four validated features', () => {
  for (const manifest of universeManifests as any[]) assert.ok(manifest.reviewCascade === undefined || manifest.reviewCascade.enabled === manifest.aliases.includes('TPCDS'), manifest.aliases[0]);
  const real: any = universeManifests.find((m: any) => m.aliases.includes('TPCDS'));
  assert.deepEqual([real.consistency?.enabled, real.tieBreak?.enabled, real.fullEvidenceExtendedProfile, real.reviewCascade?.enabled], [true, true, true, true]);
  const bad = manifests(), tpcds = bad.find(m => m.aliases.includes('TPCDS'));
  const codes = () => validateUniverseRegistry(bad).map(i => i.code);
  tpcds.reviewCascade = { enabled: false }; assert.ok(!codes().includes('INVALID_REVIEW_CASCADE'));
  for (const invalid of ['on', {}, { enabled: 'yes' }, [], null]) { tpcds.reviewCascade = invalid; assert.ok(codes().includes('INVALID_REVIEW_CASCADE'), JSON.stringify(invalid)); }
});
