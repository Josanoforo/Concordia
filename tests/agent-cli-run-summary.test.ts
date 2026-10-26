import test from 'node:test';
import assert from 'node:assert/strict';
import { runNotes, liveAgentDeps, liveExitCode, runWarnings, assertModelFlags, liveSummaryFields, degradationCodes, evalAgentExitCode, modelDidNotParticipate } from '../src/agent/cli-run.ts';
import { evaluateAgentLoop } from '../src/eval/agent-eval.ts';

const base = { phases: { exploration: { plannerError: null } } };

test('the probe-ranking label is the engine label, verbatim (single source); absent probeSelection is null', () => {
  for (const label of ['NOT_APPLICABLE_NO_CONFIGURED_PROBES', 'USED', 'NOT_USED']) assert.equal(liveSummaryFields({ ...base, probeSelection: { modelRanking: label, calls: [], selected: [] } }).probeModelRanking, label);
  assert.equal(liveSummaryFields({ ...base }).probeModelRanking, null);
});

test('the exploration planner error is exposed in the summary', () => {
  const error = { code: 'TOKEN_BUDGET_WOULD_EXCEED', used: 0, estimated: 62573, limit: 50000 };
  const fields = liveSummaryFields({ phases: { exploration: { plannerError: error } }, probeSelection: { calls: [], selected: [] } });
  assert.deepEqual(fields.explorationError, error);
  assert.equal(liveSummaryFields({ probeSelection: { calls: [], selected: [] } }).explorationError, null);
});

test('a run that asked for the model without it participating is not a pass (S2 contract)', () => {
  assert.equal(modelDidNotParticipate({ modelParticipation: 'USED' }, true), undefined);
  assert.equal(modelDidNotParticipate({ modelParticipation: 'NOT_REQUESTED' }, false), undefined);
  assert.equal(modelDidNotParticipate({ modelParticipation: 'FAILED', modelParticipationReason: 'CHOOSER_UNAVAILABLE' }, true), 'CHOOSER_UNAVAILABLE');
  assert.equal(modelDidNotParticipate({ modelParticipation: 'FAILED' }, true), 'FAILED');
  assert.equal(modelDidNotParticipate({}, true), 'NO_PARTICIPATION_RECORDED');
});

test('the summary carries the contract fields', () => {
  const fields = liveSummaryFields({ modelParticipation: 'USED', degradations: [{ phase: 'critic', code: 'X' }], phases: { coma: { status: 'PASS' }, critic: { status: 'PASS' }, exploration: { calls: [{}, {}] } },
    criticAssist: { status: 'ACTIVE' }, secondaryJudge: { status: 'SKIPPED_NO_MODEL' }, memory: { status: 'ERROR' }, budget: { used: { tokens: 1234 } } });
  assert.deepEqual([fields.modelParticipation, fields.coma, fields.critic, fields.criticAssist, fields.secondaryJudge, fields.memory, fields.explorationCalls, fields.tokensUsed, fields.degradations.length], ['USED', 'PASS', 'PASS', 'ACTIVE', 'SKIPPED_NO_MODEL', 'ERROR', 2, 1234, 1]);
});

test('model flags without a chooser fail with the cause; with a chooser or no flags they pass', () => {
  assert.throws(() => assertModelFlags({ chooser: false, probeModel: true }), (e: any) => e.code === 'MODEL_REQUIRED_FOR_FLAG' && e.detail === '--probe-model');
  assert.throws(() => assertModelFlags({ chooser: false, criticAssist: true, chooserError: { code: 'NIGHTSHIFT_KEY_MISSING' } }), (e: any) => e.code === 'NIGHTSHIFT_KEY_MISSING' && e.detail === '--critic-assist');
  assert.throws(() => assertModelFlags({ chooser: false, secondaryJudge: true }), (e: any) => e.detail === '--secondary-judge');
  assert.doesNotThrow(() => assertModelFlags({ chooser: true, probeModel: true, criticAssist: true, secondaryJudge: true }));
  assert.doesNotThrow(() => assertModelFlags({ chooser: false }));
});

test('eval-agent exit code: 0 only when the criteria pass, 1 on any failing universe or a missing verdict', async () => {
  assert.equal(evalAgentExitCode({ criteria: { passed: true } }), 0);
  assert.equal(evalAgentExitCode({ criteria: { passed: false } }), 1);
  assert.equal(evalAgentExitCode({}), 1);
  assert.equal(evalAgentExitCode(await evaluateAgentLoop()), 0, 'the shipped fixtures pass');
});

test('degradationCodes lists the distinct codes, UNSPECIFIED when none were recorded', () => {
  assert.deepEqual(degradationCodes({ degradations: [{ phase: 'memory', code: 'MEMORY_ERROR' }, { phase: 'coma', code: 'COMA_FAILED' }, { phase: 'x', code: 'MEMORY_ERROR' }] }), ['MEMORY_ERROR', 'COMA_FAILED']);
  assert.deepEqual(degradationCodes({}), ['UNSPECIFIED']);
});

test('eval-agent prints the verdict: criteria, selective, and mode/origin per universe; exit 0 when it passes', async () => {
  const { spawnSync } = await import('node:child_process');
  const path = await import('node:path');
  const { ROOT } = await import('../src/runtime.ts');
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tsx.mjs'), path.join(ROOT, 'src', 'cli.ts'), 'eval-agent'], { encoding: 'utf8', cwd: ROOT });
  const summary = JSON.parse(out.stdout.trim().split('\n').pop()!);
  assert.equal(out.status, summary.criteria.passed ? 0 : 1);
  assert.equal(summary.mode, 'LOCAL'); assert.equal(summary.dataOrigin, 'SYNTHETIC');
  assert.ok(Array.isArray(summary.selective) && Array.isArray(summary.criteria.failures));
  for (const entry of Object.values<any>(summary.criteria.byUniverse)) { assert.equal(entry.mode, 'LOCAL'); assert.equal(entry.dataOrigin, 'SYNTHETIC'); assert.equal(typeof entry.passed, 'boolean'); }
});

test('WARNING lines: both apply together (DEGRADED_NO_MODEL + COMA_FAILED); none for a clean COMPLETED run', () => {
  const both = { status: 'DEGRADED_NO_MODEL', modelParticipation: 'FAILED', modelParticipationReason: 'CHOOSER_UNAVAILABLE', degradations: [{ phase: 'coma', code: 'COMA_FAILED' }] };
  assert.deepEqual(runWarnings(both, true), ['WARNING: MODEL_DID_NOT_PARTICIPATE(CHOOSER_UNAVAILABLE)'], 'RUN_DEGRADED is only for status DEGRADED');
  assert.deepEqual(runNotes(both), ['NOTE: degradations(COMA_FAILED)']);
  assert.deepEqual(runWarnings({ status: 'DEGRADED', modelParticipation: 'USED', degradations: [{ code: 'MEMORY_ERROR' }] }, true), ['WARNING: RUN_DEGRADED(MEMORY_ERROR)']);
  assert.deepEqual(runWarnings({ status: 'COMPLETED', modelParticipation: 'USED', degradations: [] }, true), []);
  const informative = { status: 'COMPLETED', modelParticipation: 'USED', degradations: [{ code: 'CRITIC_SKIPPED' }, { code: 'BUDGET_EXHAUSTED_STEPS' }] };
  assert.deepEqual(runWarnings(informative, true), [], 'a COMPLETED run with informational degradations prints no WARNING');
  assert.deepEqual(runNotes(informative), ['NOTE: degradations(CRITIC_SKIPPED,BUDGET_EXHAUSTED_STEPS)']);
  assert.deepEqual(runNotes({ status: 'DEGRADED', degradations: [{ code: 'X' }] }), [], 'a DEGRADED run is already a WARNING');
});

test('process.exitCode composition: only COMPLETED + ledger intact + (model used when requested) is 0', () => {
  const ok = { status: 'COMPLETED', modelParticipation: 'USED' };
  assert.equal(liveExitCode(ok, true, true), 0);
  assert.equal(liveExitCode({ status: 'COMPLETED', modelParticipation: 'NOT_REQUESTED' }, false, true), 0);
  assert.equal(liveExitCode(ok, true, false), 1, 'ledger prefix changed');
  assert.equal(liveExitCode({ status: 'COMPLETED', modelParticipation: 'FAILED' }, true, true), 1, 'model requested, not used');
  for (const status of ['DEGRADED', 'DEGRADED_NO_MODEL', 'PARTIAL', 'DISCOVERY_FAILED']) assert.equal(liveExitCode({ status, modelParticipation: 'USED' }, true, true), 1, status);
});

test('live engine deps carry what the CLI requested: modelRequested, comaRequested and the chooser error', () => {
  const options = { model: true, coma: false, probeModel: false };
  const deps: any = liveAgentDeps({ client: {}, chooserError: { code: 'NIGHTSHIFT_KEY_MISSING' }, options, argv: [] });
  assert.equal(deps.modelRequested, true); assert.equal(deps.comaRequested, false); assert.equal(deps.executionMode, 'LIVE');
  assert.deepEqual(deps.chooserError, { code: 'NIGHTSHIFT_KEY_MISSING', message: 'NIGHTSHIFT_KEY_MISSING' });
  const noModel: any = liveAgentDeps({ client: {}, options: { model: false, coma: true }, argv: [] });
  assert.equal(noModel.modelRequested, false); assert.equal(noModel.comaRequested, true); assert.equal('chooserError' in noModel, false);
});

test('offline deps are shared by agent --offline and eval-agent: LOCAL/SYNTHETIC, COMA stand-in only for blind universes', async () => {
  const { offlineAgentDeps } = await import('../src/agent/offline-deps.ts');
  const { agentFixtures } = await import('../src/eval/agent-eval.ts');
  const { catalogOf } = await import('../src/agent/catalog.ts');
  const { universeConfig } = await import('../src/universe-pipeline.ts');
  for (const fixture of agentFixtures()) {
    const deps = offlineAgentDeps(fixture.alias, fixture, undefined);
    assert.equal(deps.executionMode, 'LOCAL'); assert.equal(deps.dataOrigin, 'SYNTHETIC');
    assert.equal(deps.comaBridge !== undefined, catalogOf(universeConfig(fixture.alias))?.postComa?.blind === true, fixture.alias);
  }
});

test('the offline summary carries degradations and modelParticipation', async () => {
  const { runOfflineAgent } = await import('../src/agent/cli-run.ts');
  const fs = await import('node:fs'); const path = await import('node:path'); const { ROOT } = await import('../src/runtime.ts');
  const id = 'agent-agentfx-offline-summary-test';
  try {
    const { summary } = await runOfflineAgent('AGENTFX', { runId: id }) as { summary: any };
    assert.ok(Array.isArray(summary.degradations)); assert.ok('modelParticipation' in summary);
  } finally { fs.rmSync(path.join(ROOT, '.concordia', 'agent-runs', id), { recursive: true, force: true }); }
});
