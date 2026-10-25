import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures, evaluateAgentLoop } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { resolveUniverseManifest, validateUniverseConfig, validateUniverseRegistry, universeManifests } from '../src/registry/universes.ts';
import { resolveUniverseRoute } from '../src/universe-adapters.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { ROOT } from '../src/runtime.ts';

/** R-01: U3 (madi-schema) enrolled in the generic loop with KEYED_READ actions over its metadata allowlist; no gold at runtime. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _observation: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted offline choice', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => agentFixtures().find(item => item.alias === 'U3')!;

test('U3 declares AGENT_EXPLORATION with bounds and a catalog, and its madi-schema route is unchanged', () => {
  const manifest = resolveUniverseManifest('U3')!;
  assert.ok(manifest.capabilities.includes('AGENT_EXPLORATION'));
  assert.deepEqual(manifest.capabilityBounds?.AGENT_EXPLORATION, { maxQueriesPerRun: 25, readLimit: 20, maxTokensPerRun: 15000, maxSteps: 3 });
  assert.deepEqual(validateUniverseRegistry(universeManifests), []);
  assert.deepEqual(validateUniverseConfig(manifest, universeConfig('U3')), []);
  for (const action of ['discover', 'probe', 'eval'] as const) assert.equal(resolveUniverseRoute(manifest, action), 'madi-schema');
  assert.ok(universeConfig('U3').explorationCatalog.actions.every((action: any) => action.kind === 'KEYED_READ'));
});

test('the historical U3 config (tables, patterns, privacy exclusions, limits) is byte-identical apart from the new catalog', () => {
  const { explorationCatalog: _catalog, ...historical } = universeConfig('U3');
  assert.equal(createHash('sha256').update(JSON.stringify(historical)).digest('hex'), '819bb3010575cd7a45373d8c50927f8228fc26cb91ae1d1c199d61b4fc79601a');
});

test('the agent loop on U3 runs offline over the synthetic fixture: bounded keyed reads, no probes, no privacy-excluded columns', async () => {
  const cfg = universeConfig('U3'), log: string[] = [];
  const report: any = await runAgent('U3', 'agent-u3-offline-1', { client: fixtureClient(cfg, fixture().tables, log) as any, chooser: new Script([...fixture().chooserScript]), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: true });
  assert.equal(report.status, 'COMPLETED');
  assert.deepEqual(report.phases.exploration.actions.filter((item: any) => item.execution === 'PASS').map((item: any) => item.action), ['READ_FORBES_BY_REGION', 'READ_DBPEDIA_BY_SECTOR']);
  assert.deepEqual(report.phases.probes.selected, [], 'U3 declares no relations, so nothing is probed and no verdict is produced');
  assert.deepEqual(report.decisions, []);
  assert.ok(report.budget.used.queries <= 25 && report.budget.used.steps <= 3);
  assert.ok(log.every(sql => /\bLIMIT\b/i.test(sql) && !/\b(JOIN|COUNT|GROUP\s+BY|ORDER\s+BY)\b/i.test(sql)), 'every read is bounded and join-free');
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'universes/U3_madi_companies.json'), 'utf8'));
  const excluded: string[] = Object.values<string[]>(config.privacyExcluded).flat();
  assert.ok(excluded.length > 0 && log.every(sql => excluded.every(column => !sql.includes(column))), 'privacy-excluded columns are never projected');
  assert.ok(log.some(sql => /1 AS row_present/.test(sql)), 'the opaque FullContact table is only checked for row presence');
});

test('no gold at runtime: the loop never opens a gold path, the catalog cannot name one, and the agent sources do not reference the gold key', async () => {
  const cfg = universeConfig('U3'), opened: string[] = [];
  const originals = { readFileSync: fs.readFileSync, openSync: fs.openSync, existsSync: fs.existsSync };
  const note = (target: unknown) => { opened.push(String(target)); };
  (fs as any).readFileSync = (target: any, ...rest: any[]) => { note(target); return (originals.readFileSync as any)(target, ...rest); };
  (fs as any).openSync = (target: any, ...rest: any[]) => { note(target); return (originals.openSync as any)(target, ...rest); };
  (fs as any).existsSync = (target: any) => { note(target); return originals.existsSync(target); };
  try { await runAgent('U3', 'agent-u3-offline-2', { client: fixtureClient(cfg, fixture().tables) as any, chooser: new Script([...fixture().chooserScript]), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: true }); }
  finally { Object.assign(fs, originals); }
  assert.ok(opened.length > 0, 'the spy observed the run');
  assert.deepEqual(opened.filter(target => /gold/i.test(target)), []);
  assert.doesNotMatch(JSON.stringify(cfg.explorationCatalog), /gold/i);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'eval/agent/U3.json'), 'utf8'), /gold/i);
  for (const file of ['engine.ts', 'exploration.ts', 'catalog.ts', 'coma-input.ts', 'post-coma.ts', 'probe-selector.ts', 'run-budget.ts', 'chooser.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src/agent', file), 'utf8'), /\bcfg\.gold\b|\.gold\b|sm_mapping_gold|readJson\([^)]*gold/, file);
  }
  const manifest = resolveUniverseManifest('U3')!;
  const rogue = structuredClone(universeConfig('U3')); rogue.explorationCatalog.actions[0].description = 'compare with the gold mapping';
  assert.ok(validateUniverseConfig(manifest, rogue).some(issue => issue.code === 'AGENT_CATALOG_REFERENCES_GOLD'));
});

test('eval-agent enrolls and evaluates U3 with the counts derived from the registry', async () => {
  const evaluation = await evaluateAgentLoop();
  const capable = universeManifests.filter(manifest => manifest.capabilities.includes('AGENT_EXPLORATION'));
  assert.ok(capable.some(manifest => manifest.aliases.includes('U3')));
  assert.equal(evaluation.registry.agentCapable, capable.length);
  assert.equal(evaluation.registry.evaluated, capable.length);
  assert.ok(!evaluation.registry.notEnrolled.includes('U3'));
  assert.deepEqual(evaluation.registry.skipped, []);
  assert.ok(evaluation.runs.some(run => run.alias === 'U3' && run.method === 'agent-loop' && run.status === 'COMPLETED'));
});
