import test from 'node:test';
import path from 'node:path';
import assert from 'node:assert/strict';
import { resolveUniverseManifest, validateUniverseConfig, validateUniverseRegistry, universeManifests } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { prepareAgentContext } from '../src/agent/engine.ts';
import { agentMemoryDir } from '../src/agent/memory.ts';

/** TPCDS: blind relation discovery over the TPC-DS Lightning database. Nothing here names a foreign key. */
test('P2: TPCDS is an AGENT_EXPLORATION universe with 24 allowlisted tables, keys and non-personal labels only, no configured relations and no foreign key named', () => {
  const manifest = resolveUniverseManifest('TPCDS')!, cfg = universeConfig('TPCDS');
  assert.deepEqual(validateUniverseRegistry(universeManifests), []); assert.deepEqual(validateUniverseConfig(manifest, cfg), []);
  assert.equal(manifest.source.adapterId, 'zetaris'); assert.equal(manifest.source.dataOrigin, 'PUBLIC', 'TPC-DS is a public benchmark: LIVE runs write memory under LIVE-PUBLIC');
  assert.match(agentMemoryDir('TPCDS', { executionMode: 'LIVE', dataOrigin: prepareAgentContext('TPCDS', 'agent-tpcds-origin-1', { client: {} as any, executionMode: 'LIVE', persist: false }).dataOrigin }).split(path.sep).join('/'), /agent-memory\/TPCDS\/LIVE-PUBLIC$/);
  assert.deepEqual(['DISCOVERY', 'BOUNDED_RELATION_PROBE', 'AGENT_EXPLORATION'].filter(item => !manifest.capabilities.includes(item as any)), []);
  assert.deepEqual(manifest.relationIds, []); assert.deepEqual(cfg.relations, []);
  assert.deepEqual(manifest.capabilityBounds?.AGENT_EXPLORATION, { maxQueriesPerRun: 4200, readLimit: 20, maxTokensPerRun: 3000000, maxSteps: 3 }); // Round 9 full run: 24 discovery + ~6 exploration + ~1500 coverAll + 7 x 200 contract probes (PROBE_QUERY_COST 2 + FULL_EVIDENCE_MAX_QUERIES 5) + ~600 critic, plus margin
  const tables = Object.entries<any>(cfg.tables);
  assert.equal(tables.length, 24);
  assert.ok(tables.every(([, table]) => table.db === 'TPCDS_DB'));
  const columns = tables.flatMap(([, table]) => table.columns.map((column: any) => column.name as string));
  const labels = tables.flatMap(([, table]) => table.labels as string[]);
  assert.equal(labels.length, 8); assert.ok(labels.every(name => /_(name|desc|type|description)$/.test(name) && !/customer|first|last/.test(name)), 'labels are non-personal entity names');
  assert.ok(columns.every(name => /_(sk|id|number)$/.test(name) || labels.includes(name)), 'only surrogate keys, business ids, ticket/order numbers and 8 non-personal entity labels are allowlisted: no personal names, addresses, contacts or measures');
  assert.ok(!columns.some(name => /address|email|phone|street|city|zip|birth|first_name|last_name/.test(name.replace(/^ca_address_(sk|id)$/, ''))));
  assert.equal(cfg.schemaStatus, 'LIVE_DESCRIBE_CONFIRMED_20261026', 'the allowlisted columns were confirmed against the live DESCRIBE (metadata only)');
});

test('P2: the exploration catalog is bounded and hints no relation: every action reads a table by its own keys', () => {
  const catalog = universeConfig('TPCDS').explorationCatalog;
  assert.ok(catalog.actions.length >= 1 && catalog.actions.every((action: any) => ['KEYED_READ', 'BOUNDED_PROFILE'].includes(action.kind)));
  for (const action of catalog.actions.filter((item: any) => item.kind === 'KEYED_READ')) assert.equal(catalog.observations[action.observation].fromTable, action.table, `${action.id} is self-keyed`);
  for (const action of catalog.actions.filter((item: any) => item.kind === 'BOUNDED_PROFILE')) { assert.equal(action.observation, undefined, `${action.id} takes no observed values`); assert.match(action.filterColumn, /_sk$/); }
  assert.ok(catalog.actions.some((item: any) => item.kind === 'BOUNDED_PROFILE') && catalog.actions.some((item: any) => item.kind === 'KEYED_READ'));
  assert.doesNotMatch(JSON.stringify(catalog), /foreign|references|fk\b|join/i);
});
