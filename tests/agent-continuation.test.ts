import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { type ActionChooser, type ChoiceCall } from '../src/agent/chooser.ts';
import { continueAgentExploration } from '../src/agent/continuation.ts';
import { runAgent } from '../src/agent/engine.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { readJson } from '../src/runtime.ts';

class Script implements ActionChooser {
  seen: { allowed: readonly string[]; compact: boolean | undefined }[] = [];
  constructor(private readonly script: (string | 'INVALID' | 'TRANSPORT')[]) {}
  async choose(stage: string, _observation: unknown, allowed: readonly string[], options?: { compact?: boolean }): Promise<ChoiceCall> {
    this.seen.push({ allowed, compact: options?.compact });
    const next = this.script.shift() ?? 'STOP_EXPLORATION';
    const base = { stage, status: 'PASS', requestedModel: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
    if (next === 'TRANSPORT') return { stage, status: 'FAIL', requestedModel: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z', error: { code: 'NIGHTSHIFT_TIMEOUT' } };
    if (next === 'INVALID') return { ...base, decisionStatus: 'INVALID_RESPONSE', error: { code: 'U2_ADAPTIVE_RESPONSE_NOT_JSON' } };
    return { ...base, decisionStatus: 'VALID', selected: next, reason: 'scripted offline choice' };
  }
}
const fx = readJson('eval/agent/AGENTFX.json');
const client = () => fixtureClient(universeConfig('AGENTFX'), fx.tables) as any;
const runDir = (id: string) => path.join(ROOT, '.concordia', 'agent-runs', id);

test('compact continuation makes exactly one decision and read, keeps earlier evidence, and refuses a second attempt', async () => {
  const runId = 'agent-agentfx-continuation-test-1';
  fs.rmSync(runDir(runId), { recursive: true, force: true });
  try {
    await runAgent('AGENTFX', runId, { client: client(), chooser: new Script(['READ_CUSTOMER_PROFILE', 'INVALID']), executionMode: 'LIVE', dataOrigin: 'SYNTHETIC', critic: false });
    const original = fs.readFileSync(path.join(runDir(runId), 'engine-run.json'), 'utf8');
    const chooser = new Script(['READ_REGION_REFERENCE', 'READ_CUSTOMER_PROFILE']);
    const record = await continueAgentExploration('AGENTFX', runId, { client: client(), chooser });
    assert.equal(record.outcome, 'COMPLETED');
    assert.equal(chooser.seen.length, 1, 'exactly one model decision');
    assert.equal(chooser.seen[0].compact, true);
    assert.deepEqual(chooser.seen[0].allowed, ['READ_REGION_REFERENCE', 'READ_ORDERS_BY_REGION', 'STOP_EXPLORATION'], 'already-read actions are not offered again');
    assert.deepEqual(record.newActions.map((item: any) => item.action), ['READ_REGION_REFERENCE']);
    assert.match(record.newActions[0].sql ?? '', /^SELECT .* FROM AGENT_FIXTURE\.regions WHERE region_code IN \(.*\) LIMIT 50$/);
    assert.deepEqual(Object.keys(record.reads).sort(), ['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE']);
    assert.ok(record.budget.used.queries <= record.budget.limits.maxQueriesPerRun);
    assert.equal(record.budget.used.steps, 2, 'a rejected decision takes no exploration step');
    assert.equal(fs.readFileSync(path.join(runDir(runId), 'engine-run.json'), 'utf8'), original, 'the original run record is never rewritten');
    assert.ok(fs.existsSync(path.join(runDir(runId), 'continuation.json')));
    await assert.rejects(() => continueAgentExploration('AGENTFX', runId, { client: client(), chooser: new Script(['READ_REGION_REFERENCE']) }), /AGENT_CONTINUATION_ALREADY_RESERVED/);
  } finally { fs.rmSync(runDir(runId), { recursive: true, force: true }); }
});

test('a failed continuation is preserved and ends without another attempt; healthy or foreign runs are not continuable', async () => {
  const runId = 'agent-agentfx-continuation-test-2', healthy = 'agent-agentfx-continuation-test-3';
  for (const id of [runId, healthy]) fs.rmSync(runDir(id), { recursive: true, force: true });
  try {
    await runAgent('AGENTFX', runId, { client: client(), chooser: new Script(['READ_CUSTOMER_PROFILE', 'INVALID']), executionMode: 'LIVE', dataOrigin: 'SYNTHETIC', critic: false });
    const record = await continueAgentExploration('AGENTFX', runId, { client: client(), chooser: new Script(['INVALID']) });
    assert.equal(record.outcome, 'DECISION_OR_READ_FAILED');
    assert.equal((record.plannerError as { code?: string } | null)?.code, 'U2_ADAPTIVE_RESPONSE_NOT_JSON');
    assert.deepEqual(record.newActions, []);
    await assert.rejects(() => continueAgentExploration('AGENTFX', runId, { client: client(), chooser: new Script(['READ_REGION_REFERENCE']) }), /AGENT_CONTINUATION_ALREADY_RESERVED/);
    await runAgent('AGENTFX', healthy, { client: client(), chooser: new Script(['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE']), executionMode: 'LIVE', dataOrigin: 'SYNTHETIC', critic: false });
    await assert.rejects(() => continueAgentExploration('AGENTFX', healthy, { client: client(), chooser: new Script(['STOP_EXPLORATION']) }), /AGENT_RUN_NOT_CONTINUABLE/);
    await assert.rejects(() => continueAgentExploration('AGENTFX', 'agent-agentfx-does-not-exist', { client: client(), chooser: new Script([]) }), /AGENT_RUN_NOT_FOUND/);
  } finally { for (const id of [runId, healthy]) fs.rmSync(runDir(id), { recursive: true, force: true }); }
});

test('an explicitly re-authorized second attempt resumes after a failed first one, is itself one-shot, and there is no third', async () => {
  const runId = 'agent-agentfx-continuation-test-4';
  fs.rmSync(runDir(runId), { recursive: true, force: true });
  try {
    await runAgent('AGENTFX', runId, { client: client(), chooser: new Script(['READ_CUSTOMER_PROFILE', 'INVALID']), executionMode: 'LIVE', dataOrigin: 'SYNTHETIC', critic: false });
    await assert.rejects(() => continueAgentExploration('AGENTFX', runId, { client: client(), chooser: new Script(['STOP_EXPLORATION']) }, 2), /AGENT_CONTINUATION_PREVIOUS_ATTEMPT_MISSING/);
    const first = await continueAgentExploration('AGENTFX', runId, { client: client(), chooser: new Script(['INVALID']) });
    assert.equal(first.outcome, 'DECISION_OR_READ_FAILED');
    const chooser = new Script(['READ_REGION_REFERENCE']);
    const second = await continueAgentExploration('AGENTFX', runId, { client: client(), chooser }, 2);
    assert.equal(second.attempt, 2);
    assert.equal(second.outcome, 'COMPLETED');
    assert.equal(chooser.seen.length, 1);
    assert.ok(second.budget.used.queries > first.budget.used.queries, 'queries accumulate across attempts');
    assert.ok(fs.existsSync(path.join(runDir(runId), 'continuation.json')) && fs.existsSync(path.join(runDir(runId), 'continuation-2.json')), 'both attempts stay as evidence');
    await assert.rejects(() => continueAgentExploration('AGENTFX', runId, { client: client(), chooser: new Script(['STOP_EXPLORATION']) }, 2), /AGENT_CONTINUATION_ALREADY_RESERVED|AGENT_CONTINUATION_PREVIOUS_NOT_FAILED/);
    await assert.rejects(() => continueAgentExploration('AGENTFX', runId, { client: client(), chooser: new Script([]) }, 3), /AGENT_CONTINUATION_ATTEMPT_INVALID/);
  } finally { fs.rmSync(runDir(runId), { recursive: true, force: true }); }
});

// Kept in this file on purpose: LIVE-mode runs share the freshness history, so two such files running concurrently race.
test('a transport failure of the model call is continuable once, like an invalid response', async () => {
  const runId = 'agent-agentfx-continuation-transport-test-1', other = 'agent-agentfx-continuation-transport-test-2';
  for (const id of [runId, other]) fs.rmSync(runDir(id), { recursive: true, force: true });
  try {
    await runAgent('AGENTFX', runId, { client: client(), chooser: new Script(['READ_CUSTOMER_PROFILE', 'TRANSPORT']), executionMode: 'LIVE', dataOrigin: 'SYNTHETIC', critic: false });
    const record = await continueAgentExploration('AGENTFX', runId, { client: client(), chooser: new Script(['READ_REGION_REFERENCE']) });
    assert.equal(record.outcome, 'COMPLETED');
    assert.deepEqual(record.newActions.map((item: any) => item.action), ['READ_REGION_REFERENCE']);
    await assert.rejects(() => continueAgentExploration('AGENTFX', runId, { client: client(), chooser: new Script([]) }), /AGENT_CONTINUATION_ALREADY_RESERVED/);
    // a run that stopped without any failed model call stays non-continuable
    await runAgent('AGENTFX', other, { client: client(), chooser: new Script(['READ_CUSTOMER_PROFILE', 'STOP_EXPLORATION']), executionMode: 'LIVE', dataOrigin: 'SYNTHETIC', critic: false });
    await assert.rejects(() => continueAgentExploration('AGENTFX', other, { client: client(), chooser: new Script([]) }), /AGENT_RUN_NOT_CONTINUABLE/);
  } finally { for (const id of [runId, other]) fs.rmSync(runDir(id), { recursive: true, force: true }); }
});

test('a DEGRADED_NO_MODEL run (invalid model response, model requested) is continuable; one with a valid last decision is still refused', async () => {
  const runId = 'agent-agentfx-continuation-degraded-1';
  fs.rmSync(runDir(runId), { recursive: true, force: true });
  try {
    const report = await runAgent('AGENTFX', runId, { client: client(), chooser: new Script(['INVALID']), executionMode: 'LIVE', dataOrigin: 'SYNTHETIC', critic: false, modelRequested: true } as any);
    assert.equal(report.status, 'DEGRADED_NO_MODEL');
    const record = await continueAgentExploration('AGENTFX', runId, { client: client(), chooser: new Script(['READ_CUSTOMER_PROFILE']) });
    assert.equal(record.outcome, 'COMPLETED');
  } finally { fs.rmSync(runDir(runId), { recursive: true, force: true }); }
});
