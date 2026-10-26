import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { requiredReviewMode } from '../src/registry/review-mode.ts';
import { resolveUniverseManifest, validateUniverseConfig, validateUniverseRegistry, universeManifests } from '../src/registry/universes.ts';
import { agentFixtures, evaluateAgentLoop } from '../src/eval/agent-eval.ts';
import { loadNwchGold, orphanViolations, scoreNwchCandidates } from '../src/eval/nwch-gold.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { ROOT } from '../src/runtime.ts';

/** NWCH: Northwind + Chinook as an untouched blind check of the reviewer. Six key-only tables, no relations configured, a synthetic offline fixture, an offline-only gold. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'NWCH')!);
const SIX = ['chinook_album', 'chinook_artist', 'chinook_playlist_track', 'northwind_order_details', 'northwind_orders', 'northwind_products'];

test('NWCH is registered as a public blind universe with only the six allowlisted tables and the reviewer check mode', () => {
  const manifest = resolveUniverseManifest('NWCH')!, config = universeConfig('NWCH');
  assert.deepEqual(validateUniverseRegistry(universeManifests), []); assert.deepEqual(validateUniverseConfig(manifest, config), []);
  assert.equal(manifest.source.dataOrigin, 'PUBLIC'); assert.equal(manifest.source.adapterId, 'zetaris');
  assert.equal(requiredReviewMode(manifest), 'MODEL_ADVERSARIAL');
  assert.equal(config.database, 'CONCORDIA_L2_SOURCES_20261023_SVP1_JSON2');
  assert.deepEqual(Object.keys(config.tables).sort(), SIX);
  assert.ok(!Object.values<any>(config.tables).some(table => /gtfs/i.test(table.physicalTable)), 'the four gtfs_* tables of the same database are not allowlisted');
  assert.deepEqual(config.relations, [], 'blind: no relation is configured'); assert.equal(config.probeMode, 'distinct-keys');
  assert.deepEqual([config.explorationCatalog.postComa.blind, config.explorationCatalog.postComa.coverAll, config.explorationCatalog.postComa.homonymGuard], [true, true, true]);
  assert.match(config.publicBenchmark.name, /Northwind/); assert.match(config.publicBenchmark.name, /Chinook/);
  for (const table of Object.values<any>(config.tables)) { assert.ok(table.columns.every((column: any) => column.type === 'integer' && table.keyColumns.includes(column.name))); assert.deepEqual(table.labels, []); }
  assert.deepEqual(manifest.relationIds, []);
});

test('the synthetic fixture holds the 3 true FKs by construction, overlaps keys across the schemas on purpose and leaves playlist_track without a parent', () => {
  const { tables } = fixture(), values = (table: string, column: string) => { const t = (tables as any)[table], i = t.columns.findIndex((c: any) => c.name === column); return t.rows.map((row: any[]) => row[i]); };
  const within = (child: [string, string], parent: [string, string]) => values(...child).every((value: number) => values(...parent).includes(value));
  assert.ok(within(['northwind_order_details', 'OrderID'], ['northwind_orders', 'OrderID']));
  assert.ok(within(['northwind_order_details', 'ProductID'], ['northwind_products', 'ProductID']));
  assert.ok(within(['chinook_album', 'ArtistId'], ['chinook_artist', 'ArtistId']));
  assert.ok(within(['northwind_orders', 'OrderID'], ['chinook_artist', 'ArtistId']), 'homonym overlap across the schemas');
  assert.ok(within(['northwind_products', 'ProductID'], ['chinook_album', 'AlbumId']), 'homonym overlap across the schemas');
  assert.equal(Object.keys((tables as any)).length, 6);
});

test('the offline blind run is truly blind: no decision, COMA stand-in ran, every proposal probed (coverAll), gold untouched; homonyms look as good as the true edges by coverage alone', async () => {
  const f = fixture(), report: any = await runAgent('NWCH', 'agent-nwch-offline-1', { ...offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), persist: false, critic: false });
  assert.equal(report.status, 'COMPLETED'); assert.deepEqual(report.decisions, []); assert.equal(report.phases.coma.status, 'RAN');
  assert.deepEqual([report.postComa.counts.proposals, report.postComa.counts.executed, report.postComa.status], [19, 19, 'EXECUTED']);
  assert.ok(report.budget.used.queries <= 500);
  const candidates = report.postComa.proposals.map((item: any) => ({ from: item.from, to: item.to }));
  const score = scoreNwchCandidates(candidates.map((c: any) => ({ from: { table: c.from.table, column: c.from.column }, to: { table: c.to.table, column: c.to.column } })));
  assert.deepEqual([score.goldEdges, score.truePositives], [3, 3], 'all three true edges are among the probed candidates');
  const level = (id: string) => report.postComa.proposals.find((item: any) => item.proposalId === id).coverageProbe.diagnostic.coverage.level;
  assert.equal(level('northwind_order_details.OrderID__northwind_orders.OrderID'), 'HIGH');
  assert.equal(level('northwind_order_details.OrderID__chinook_artist.ArtistId'), 'HIGH', 'a cross-schema homonym is indistinguishable from a true edge by coverage: the reviewer has to tell them apart');
  assert.ok(score.falsePositives >= 14 && score.trapsProposed.length >= 8, JSON.stringify({ fp: score.falsePositives, traps: score.trapsProposed.length }));
  assert.ok(score.orphanViolations.length >= 5, 'the orphan columns are proposed against other keys: the reviewer must reject them');
});

test('the gold is offline only: 3 edges, 12 cross-schema traps, 2 orphans; no runtime module reads it', () => {
  const gold = loadNwchGold();
  assert.deepEqual([gold.edges.length, gold.homonymTraps.length, gold.orphans.length, gold.compositeEdges.length], [3, 12, 2, 0]);
  assert.deepEqual(gold.orphans.map(item => item.column).sort(), ['PlaylistId', 'TrackId']);
  assert.deepEqual(orphanViolations([{ from: { table: 'chinook_playlist_track', column: 'TrackId' }, to: { table: 'chinook_album', column: 'AlbumId' } }, { from: { table: 'chinook_album', column: 'ArtistId' }, to: { table: 'chinook_artist', column: 'ArtistId' } }], gold), ['chinook_playlist_track.TrackId->chinook_album.AlbumId']);
  for (const dir of ['agent', 'probe', 'discovery', 'registry', 'relations', 'critic', 'reconcile', 'report', 'export', 'clients']) {
    const root = path.join(ROOT, 'src', dir); if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root, { recursive: true })) {
      const file = path.join(root, String(name)); if (!file.endsWith('.ts') || !fs.statSync(file).isFile()) continue;
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /nwch-gold|NWCH_fk_gold/, path.relative(ROOT, file));
    }
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'universes', 'NWCH.json'), 'utf8'), /gold/i);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'eval', 'agent', 'NWCH.json'), 'utf8'), /gold/i);
});

test('eval-agent enrolls NWCH and it passes for the blind post-COMA reason', async () => {
  const evaluation = await evaluateAgentLoop();
  assert.ok(evaluation.runs.some(run => run.alias === 'NWCH' && run.status === 'COMPLETED'));
  assert.equal(evaluation.criteria.byUniverse.NWCH.passed, true);
  assert.equal(evaluation.criteria.byUniverse.NWCH.reason, 'BLIND_POST_COMA_EXECUTED_WITH_STANDIN');
  assert.equal(evaluation.criteria.passed, true);
});
