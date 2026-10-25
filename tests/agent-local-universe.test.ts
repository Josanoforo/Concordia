import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgentCommand } from '../src/agent/cli-run.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { resolveUniverseManifest, validateUniverseConfig, validateUniverseRegistry, universeManifests } from '../src/registry/universes.ts';
import { universeConfig, evaluateLocalFixtureUniverse } from '../src/universe-pipeline.ts';
import { ROOT } from '../src/runtime.ts';

const manifest = resolveUniverseManifest('AGENTLOCAL')!;
const runDir = (id: string) => path.join(ROOT, '.concordia', 'agent-runs', id);

test('R-03 a local-files universe may carry AGENT_EXPLORATION and validates; local-snapshot and remote-less zetaris still may not', () => {
  assert.ok(manifest.capabilities.includes('AGENT_EXPLORATION'));
  assert.deepEqual(validateUniverseRegistry(universeManifests), []);
  assert.deepEqual(validateUniverseConfig(manifest, universeConfig('AGENTLOCAL')), []);
  const snapshot = structuredClone(manifest); snapshot.source.adapterId = 'local-snapshot';
  assert.ok(validateUniverseRegistry([snapshot]).length > 0, 'AGENT_EXPLORATION is rejected on local-snapshot');
  const noLocal = structuredClone(manifest); noLocal.capabilities = ['RELATION_EVALUATION', 'AGENT_EXPLORATION'];
  assert.ok(validateUniverseConfig(noLocal, universeConfig('AGENTLOCAL')).some(issue => issue.code === 'AGENT_EXPLORATION_REQUIRES_DISCOVERY_AND_PROBE'));
});

test('R-03 the agent command runs a local universe over its own rows without .env, network or model', async () => {
  const runId = 'agent-agentlocal-r03-test-1';
  fs.rmSync(runDir(runId), { recursive: true, force: true });
  const fixture = agentFixtures().find(item => item.alias === 'AGENTLOCAL')!;
  assert.deepEqual(fixture.chooserScript, ['READ_CUSTOMER_PROFILE']);
  const fetchBefore = globalThis.fetch; globalThis.fetch = (async () => { throw new Error('network is forbidden'); }) as typeof fetch;
  const log = console.log; console.log = () => {};
  try {
    const summary: any = await runAgentCommand('AGENTLOCAL', { runId, model: true, coma: true });
    assert.equal(summary.status, 'COMPLETED'); assert.equal(summary.mode, 'OFFLINE_FIXTURE'); assert.equal(summary.dataOrigin, 'SYNTHETIC');
    const saved = JSON.parse(fs.readFileSync(path.join(runDir(runId), 'engine-run.json'), 'utf8'));
    assert.equal(saved.executionMode, 'LOCAL');
    assert.ok(saved.phases.probes.selected.length >= 1);
  } finally { console.log = log; globalThis.fetch = fetchBefore; fs.rmSync(runDir(runId), { recursive: true, force: true }); process.exitCode = 0; }
});

test('R-03 the local universe still evaluates through the common local pipeline', async () => {
  const run = await evaluateLocalFixtureUniverse('AGENTLOCAL');
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].relationId, 'agentlocal_orders_customer');
});
