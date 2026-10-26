import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestPriorRun, runAgent } from '../src/agent/engine.ts';
import { priorFromRun } from '../src/agent/post-coma.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import type { ComaBridge, ComaSchemaInput } from '../src/discovery/coma-provider.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** M7-2 wiring: the engine hands post-COMA its origin-sealed scope and, when a previous run of the same scope exists, a prior built from it. Ranking only. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => agentFixtures().find(item => item.alias === 'TPCDS')!;
const tokens = (name: string) => new Set(name.split('_').slice(1));
const nameBridge: ComaBridge = (input: ComaSchemaInput) => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: input.pairs.map(pair => ({ source: pair.source, target: pair.target,
  matches: input.tables[pair.source].columns.flatMap(a => input.tables[pair.target].columns.flatMap(b => { const x = tokens(a), y = tokens(b), shared = [...x].filter(t => y.has(t)).length, score = shared / (x.size + y.size - shared); return score >= 0.5 ? [{ sourceColumn: a, targetColumn: b, rawScore: score }] : []; })) })) });
const run = (runId: string, extra: Record<string, unknown> = {}) => runAgent('TPCDS', runId, { client: fixtureClient(universeConfig('TPCDS'), fixture().tables) as any, chooser: new Script([...fixture().chooserScript]), comaBridge: nameBridge,
  executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, ...extra }) as Promise<any>;
const scope = { universeId: 'TPCDS', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' };
const executedIds = (report: any) => report.postComa.proposals.filter((item: any) => item.coverageProbe?.status === 'EXECUTED').map((item: any) => item.proposalId);

test('M7-2 engine: with a prior run of the same scope the probe order changes and the diagnostics of each probed pair do not', async () => {
  const first = await run('agent-prior-1', { postComaPrior: false });
  assert.equal(first.postComa.priorRun, undefined, 'no prior, no priorRun section');
  const ids = executedIds(first);
  assert.ok(ids.length > 0 && first.postComa.proposals.length > ids.length, 'the fixture has more proposals than probes');
  const second = await run('agent-prior-2', { postComaPrior: priorFromRun(first, scope) });
  assert.equal(second.postComa.priorRun.applied, true);
  assert.notDeepEqual(executedIds(second), ids, 'the order/selection changed');
  const baseline = await run('agent-prior-3', { postComaPrior: false });
  for (const id of executedIds(second).filter((x: string) => executedIds(baseline).includes(x)))
    assert.deepEqual(second.postComa.proposals.find((p: any) => p.proposalId === id).coverageProbe.diagnostic, baseline.postComa.proposals.find((p: any) => p.proposalId === id).coverageProbe.diagnostic);
  assert.deepEqual(second.decisions, first.decisions, 'verdicts are identical with and without the prior');
  assert.equal(second.status, first.status);
});

test('M7-2 engine: a prior of another scope is ignored and said so', async () => {
  const first = await run('agent-prior-4', { postComaPrior: false });
  const second = await run('agent-prior-5', { postComaPrior: priorFromRun(first, { ...scope, executionMode: 'LIVE' }) });
  assert.deepEqual([second.postComa.priorRun.applied, second.postComa.priorRun.reason], [false, 'PRIOR_RUN_SCOPE_MISMATCH']);
  assert.deepEqual(executedIds(second), executedIds(first));
});

test('M7-2 engine: latestPriorRun picks the newest persisted run of the same scope and skips the current run and other scopes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-runs-'));
  try {
    const first = await run('agent-prior-6', { postComaPrior: false });
    const put = (name: string, over: object) => { fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, name, 'engine-run.json'), JSON.stringify({ ...scope, utc: '2026-10-25T00:00:00.000Z', postComa: first.postComa, ...over })); };
    put('agent-old', { utc: '2026-10-24T00:00:00.000Z' }); put('agent-new', {}); put('agent-other', { executionMode: 'LIVE', utc: '2026-10-26T00:00:00.000Z' }); put('agent-cur', { utc: '2026-10-27T00:00:00.000Z' });
    const prior = latestPriorRun(scope, 'agent-cur', dir)!;
    assert.deepEqual(prior.scope, scope);
    assert.deepEqual(prior.pairs, priorFromRun(first, scope).pairs);
    assert.equal(latestPriorRun({ ...scope, dataOrigin: 'PUBLIC' }, 'agent-cur', dir), undefined);
    assert.equal(latestPriorRun(scope, 'agent-cur', path.join(dir, 'missing')), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
