import test from 'node:test';
import assert from 'node:assert/strict';
import { universeManifests, resolveUniverseManifest, validateUniverseConfig } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** The opt-in probe mode is a declaration in the universe config: only "distinct-keys", only where declared (TPCDS, NWCH, U1). */
test('TPCDS, NWCH and U1 declare probeMode distinct-keys; U2, GTFS and every other config do not', () => {
  for (const alias of ['TPCDS', 'NWCH', 'U1']) assert.equal(universeConfig(alias).probeMode, 'distinct-keys', alias);
  for (const alias of ['U2', 'U3', 'GTFSAGENT', 'AGENTFX', 'AGENTLOCAL']) assert.equal(universeConfig(alias).probeMode, undefined, alias);
  assert.deepEqual(validateUniverseConfig(resolveUniverseManifest('TPCDS')!, universeConfig('TPCDS')), []);
  assert.ok(universeManifests.length > 0);
});

test('the registry rejects an unknown probeMode value, and accepts the key being absent', () => {
  const manifest = resolveUniverseManifest('TPCDS')!, codes = (mutate: (cfg: any) => void) => { const cfg = structuredClone(universeConfig('TPCDS')); mutate(cfg); return validateUniverseConfig(manifest, cfg).map(issue => issue.code); };
  for (const bad of ['all-keys', 'DISTINCT-KEYS', '', null, 1, true, ['distinct-keys']]) assert.ok(codes(cfg => { cfg.probeMode = bad; }).includes('UNKNOWN_PROBE_MODE'), JSON.stringify(bad));
  assert.deepEqual(codes(cfg => { delete cfg.probeMode; }), []);
  const noProbe = structuredClone(manifest) as any; noProbe.capabilities = noProbe.capabilities.filter((item: string) => !['BOUNDED_RELATION_PROBE', 'AGENT_EXPLORATION'].includes(item));
  assert.ok(validateUniverseConfig(noProbe, universeConfig('TPCDS')).some(issue => issue.code === 'PROBE_MODE_REQUIRES_BOUNDED_RELATION_PROBE'));
});
