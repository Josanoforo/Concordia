import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { BLIND_COMA_MAX_PAIRS, allowlistedColumns, comaInputBlind, comaInputHash, comaTables, runComaPhase } from '../src/agent/coma-input.ts';
import { prepareAgentContext, runDiscoveryPhase } from '../src/agent/engine.ts';
import { createInstalledComaBridge, type ComaBridge } from '../src/discovery/coma-provider.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** Blind COMA input: every pair of discovered tables with nothing in scope, only when the catalog asks for it and no relation is configured. */
async function discovered(alias: string) {
  const cfg = universeConfig(alias), ctx = prepareAgentContext(alias, `agent-${alias.toLowerCase()}-blind-input`, { client: fixtureClient(cfg, agentFixtures().find(item => item.alias === alias)!.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false });
  return { cfg, ctx, phase: await runDiscoveryPhase(ctx) };
}
const countingBridge = () => { const calls: any[] = []; const bridge: ComaBridge = input => { calls.push(input); return { schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: [] }; }; return { calls, bridge }; };
const run = (alias: string, found: Awaited<ReturnType<typeof discovered>>, bridge?: ComaBridge, catalog = found.ctx.catalog) => runComaPhase({ universeId: alias, cfg: found.cfg, catalog, discovery: found.phase.discovery, sourceColumns: found.phase.sourceColumns, relations: found.phase.relations, bridge, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });

test('without the blind flag, a universe with no configured relations still gets no COMA input (unchanged)', async () => {
  const found = await discovered('TPCDS'), { calls, bridge } = countingBridge();
  const result = await run('TPCDS', found, bridge, { ...found.ctx.catalog, postComa: { maxProbes: 30 } });
  assert.equal(result.status, 'NOT_CONFIGURED'); assert.equal(calls.length, 0);
});

test('blind mode asks COMA about every table pair with nothing in scope, in a deterministic order, as explicit input v2', async () => {
  const found = await discovered('TPCDS'), { calls, bridge } = countingBridge();
  const result = await run('TPCDS', found, bridge);
  assert.equal(result.status, 'RAN'); assert.equal(result.comaInputVersion, 2);
  assert.deepEqual(result.blind, { tablePairs: 276, pairs: 276, cap: BLIND_COMA_MAX_PAIRS, capped: false, order: 'source<target lexicographic' });
  assert.equal(calls.length, 1); const input = calls[0];
  assert.equal(input.pairs.length, 276); assert.ok(input.pairs.every((pair: any) => pair.allowed.length === 0 && pair.source < pair.target));
  assert.deepEqual(input.pairs.slice(0, 2).map((pair: any) => [pair.source, pair.target]), [['call_center', 'catalog_page'], ['call_center', 'catalog_returns']]);
  const names = Object.keys(input.tables).sort((x, y) => x.localeCompare(y, 'en')), expected = names.flatMap((source, index) => names.slice(index + 1).map(target => `${source}|${target}`));
  assert.deepEqual(input.pairs.map((pair: any) => `${pair.source}|${pair.target}`), expected, 'nested loop over sorted table names');
  assert.equal(new Set(input.pairs.map((pair: any) => `${pair.source}|${pair.target}`)).size, 276);
  assert.equal(result.inputHash, comaInputHash(input, 2)); assert.notEqual(comaInputHash(input, 2), comaInputHash(input, 1), 'v2 never collides with the legacy hash');
  assert.ok(JSON.stringify(input).length < 150_000, `the blind input stays small (${JSON.stringify(input).length} bytes)`);
});

test('the cap is deterministic and reported, never silent', async () => {
  const found = await discovered('TPCDS'), tables = comaTables(allowlistedColumns(found.cfg, found.ctx.catalog, found.phase.discovery, found.phase.sourceColumns));
  const capped = comaInputBlind(found.cfg, tables, 10), again = comaInputBlind(found.cfg, tables, 10);
  assert.deepEqual(capped.coverage, { tablePairs: 276, pairs: 10, cap: 10, capped: true, order: 'source<target lexicographic' });
  assert.deepEqual(capped.input.pairs, again.input.pairs);
});

test('a universe with configured relations is byte-identical whether or not the catalog says blind', async () => {
  const found = await discovered('AGENTFX'), plain = countingBridge(), flagged = countingBridge();
  const a = await run('AGENTFX', found, plain.bridge), b = await run('AGENTFX', found, flagged.bridge, { ...found.ctx.catalog, postComa: { maxProbes: 2, blind: true } });
  assert.deepEqual([a.status, a.comaInputVersion, b.status, b.comaInputVersion, b.blind], ['RAN', 1, 'RAN', 1, undefined]);
  assert.equal(a.inputHash, b.inputHash); assert.deepEqual(plain.calls[0], flagged.calls[0]);
});

test('measured with the installed COMA bridge (skipped where it is not installed): the 276-pair blind input completes in bounded time', async t => {
  const python = path.join(ROOT, '.concordia', 'python', 'coma-valentine-1.1.0', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) { t.skip('COMA interpreter not installed'); return; }
  const found = await discovered('TPCDS'), tables = comaTables(allowlistedColumns(found.cfg, found.ctx.catalog, found.phase.discovery, found.phase.sourceColumns));
  const { input } = comaInputBlind(found.cfg, tables), started = performance.now();
  const output = createInstalledComaBridge(python, ROOT)(input, 110_000), seconds = (performance.now() - started) / 1000;
  process.stderr.write(`BLIND_COMA_MEASURE pairs=${input.pairs.length} bytes=${JSON.stringify(input).length} seconds=${seconds.toFixed(2)} matches=${output.matches.reduce((sum, pair) => sum + pair.matches.length, 0)}\n`);
  assert.equal(output.matches.length, input.pairs.length); assert.ok(seconds < 110);
});
