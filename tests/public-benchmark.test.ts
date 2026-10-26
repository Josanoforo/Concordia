import test from 'node:test';
import assert from 'node:assert/strict';
import { publicBenchmarkOf } from '../src/agent/public-benchmark.ts';
import { resolveUniverseManifest, validateUniverseConfig } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** M7-6: the universe declares that its schema is a known public benchmark; the registry validates the declaration and the run can read it. */
test('TPCDS declares its public benchmark and the helper hands it to the run; undeclared universes have none', () => {
  assert.deepEqual(publicBenchmarkOf('TPCDS'), { name: 'TPC-DS', note: 'esquema público conocido; un modelo puede reconocerlo por los nombres' });
  for (const alias of ['U1', 'U2', 'U3', 'AGENTFX', 'GTFSAGENT']) assert.equal(publicBenchmarkOf(alias), undefined, alias);
  assert.deepEqual(validateUniverseConfig(resolveUniverseManifest('TPCDS')!, universeConfig('TPCDS')), []);
});

test('the registry allows only name and note, as plain bounded text', () => {
  const manifest = resolveUniverseManifest('TPCDS')!, codes = (mutate: (cfg: any) => void) => { const cfg = structuredClone(universeConfig('TPCDS')); mutate(cfg); return validateUniverseConfig(manifest, cfg).map(issue => issue.code); };
  assert.ok(codes(cfg => { cfg.publicBenchmark.extra = 'x'; }).includes('UNKNOWN_PUBLIC_BENCHMARK_KEY'));
  assert.ok(codes(cfg => { cfg.publicBenchmark = 'TPC-DS'; }).includes('INVALID_PUBLIC_BENCHMARK'));
  assert.ok(codes(cfg => { cfg.publicBenchmark = ['TPC-DS']; }).includes('INVALID_PUBLIC_BENCHMARK'));
  assert.ok(codes(cfg => { cfg.publicBenchmark.name = ''; }).includes('INVALID_PUBLIC_BENCHMARK'));
  assert.ok(codes(cfg => { cfg.publicBenchmark.name = 'TPC-DS; DROP'; }).includes('INVALID_PUBLIC_BENCHMARK'));
  assert.ok(codes(cfg => { cfg.publicBenchmark.note = '   '; }).includes('INVALID_PUBLIC_BENCHMARK'));
  assert.ok(codes(cfg => { cfg.publicBenchmark.note = 'x'.repeat(301); }).includes('INVALID_PUBLIC_BENCHMARK'));
  assert.ok(codes(cfg => { cfg.publicBenchmark.note = 'line\nbreak'; }).includes('INVALID_PUBLIC_BENCHMARK'));
  assert.deepEqual(codes(cfg => { delete cfg.publicBenchmark; }), [], 'the declaration is optional');
});
