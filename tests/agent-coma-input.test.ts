import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { allowlistedColumns, comaInputFromRelations, comaInputHash, comaTables, normalizeComaInputVersion, runComaPhase } from '../src/agent/coma-input.ts';
import { catalogOf } from '../src/agent/catalog.ts';
import { runAgent } from '../src/agent/engine.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

// Frozen hash of the historic U2 COMA input (same constant as U2_COMA_RECOVERY_INPUT_HASH in src/agent/u2.ts; that file is not touched).
const FROZEN_U2_HASH = '3a49787469cad83d035c0d6b5c05136bcdfd7c1ed17b33a4fb655db916988f66';
const snapshot = JSON.parse(fs.readFileSync(new URL('./fixtures/coma-input/u2-live-02-columns.json', import.meta.url), 'utf8'));
const cfg = universeConfig('U2');
const discovery = { tables: Object.fromEntries(Object.keys(snapshot.columnsByTable).map(name => [name, {}])) };
const relations = cfg.relations.filter((relation: any) => discovery.tables[relation.from.table] && discovery.tables[relation.to.table]);
const tables = comaTables(allowlistedColumns(cfg, catalogOf(cfg), discovery, snapshot.columnsByTable));
const input = comaInputFromRelations(cfg, relations, tables);
const stubBridge = (value: any) => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0',
  configuration: { max_n: 0, use_instances: false, use_schema: true, delta: 0.15, threshold: 0.0, instance_weight: 1.0 },
  matches: value.pairs.map((pair: any) => ({ source: pair.source, target: pair.target, matches: [] })) });

test('F-01 (a) the implicit v1 hash over the historic snapshot is the frozen 3a49 hash', () => {
  assert.equal(comaInputHash(input), FROZEN_U2_HASH);
  assert.equal(comaInputHash(input, 1), FROZEN_U2_HASH, 'explicit v1 equals the implicit version');
  assert.equal(normalizeComaInputVersion(undefined), 1);
  assert.throws(() => normalizeComaInputVersion(3), /COMA_INPUT_VERSION_UNSUPPORTED/);
});

test('F-01 (b) the recovery path (REPLAY with expectedInputHash) still validates the historic input and rejects another version', async () => {
  const base = { universeId: 'U2', cfg, catalog: catalogOf(cfg), discovery, sourceColumns: snapshot.columnsByTable, relations, bridge: stubBridge as any, executionMode: 'REPLAY' as const, dataOrigin: 'PUBLIC' as const };
  const ok = await runComaPhase({ ...base, expectedInputHash: FROZEN_U2_HASH });
  assert.equal(ok.status, 'RAN');
  assert.equal(ok.inputHash, FROZEN_U2_HASH);
  assert.equal(ok.comaInputVersion, 1);
  await assert.rejects(runComaPhase({ ...base, comaInputVersion: 2, expectedInputHash: FROZEN_U2_HASH }), /U2_COMA_RECOVERY_INPUT_HASH_MISMATCH/);
});

test('F-01 (c) a v2 input is distinguishable and is recorded in engine-run.json; no version is recorded as implicit v1', async () => {
  assert.notEqual(comaInputHash(input, 2), comaInputHash(input, 1));
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const run = (runId: string, comaInputVersion?: 1 | 2) => runAgent('AGENTFX', runId, { client: fixtureClient(universeConfig('AGENTFX'), fixture.tables) as any, executionMode: 'LOCAL',
    dataOrigin: 'SYNTHETIC', persist: false, critic: false, comaBridge: stubBridge as any, comaInputVersion, now: () => '2026-10-24T00:00:00Z' }) as Promise<any>;
  const legacy = await run('agent-coma-v-legacy'), v1 = await run('agent-coma-v-1', 1), v2 = await run('agent-coma-v-2', 2);
  assert.deepEqual([legacy.phases.coma.comaInputVersion, legacy.phases.coma.comaInputVersionExplicit], [1, false]);
  assert.deepEqual([v1.phases.coma.comaInputVersion, v1.phases.coma.comaInputVersionExplicit], [1, true]);
  assert.deepEqual([v2.phases.coma.comaInputVersion, v2.phases.coma.comaInputVersionExplicit], [2, true]);
  assert.equal(legacy.phases.coma.inputHash, v1.phases.coma.inputHash);
  assert.notEqual(v2.phases.coma.inputHash, v1.phases.coma.inputHash);
});
