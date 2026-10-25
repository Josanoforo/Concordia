import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateLocalFixtureUniverse } from '../src/universe-pipeline.ts';
import { explainLiveEvaluation, buildExplanationInput, buildExplanationGrounding, historicalExplanationStatus, modelMessages, parseExplanationResponse } from '../src/live-explanations.ts';
import { NightshiftChatError, type Receipt } from '../src/clients/nightshift.ts';
import { ROOT } from '../src/runtime.ts';

const receipt: Receipt = {
  receiptId: 'receipt-fixture-001', provider: 'anthropic', model: 'claude-haiku-fixture',
  inputTokens: 100, outputTokens: 25, totalTokens: 125, latencyMs: 12, fromCache: false,
  requestedMode: 'cheap', routedMode: 'cheap', modeCoerced: false, costUsd: 0.001
};
function scratch() {
  const root = fs.mkdtempSync(path.join(ROOT, '.concordia', 'explanation-test-'));
  fs.mkdirSync(path.join(root, '.concordia'));
  return root;
}
async function evaluation(runId = 'explain-' + randomUUID().replaceAll('-', '')) {
  const local = await evaluateLocalFixtureUniverse('GTFS');
  return {
    runId, manifestId: local.manifestId, version: '1.0', executionMode: 'LIVE', dataOrigin: 'SYNTHETIC',
    status: 'EVALUATED', sourceValidation: { status: 'COMPLETE' },
    decisions: local.results.map(item => ({
      candidateId: item.relationId, contract: item.contract, decision: item.decision,
      evidenceBundle: item.evidence, evidenceRef: item.evidence.evidenceBundleId
    }))
  };
}
function responseText(ids: string[]) {
  return JSON.stringify({ explanations: ids.map(candidateId => ({ candidateId, explanation: 'La evidencia acotada respalda esta interpretación con prudencia.' })) });
}
const fakeClient = (text: string, actualReceipt: Receipt = receipt, record?: (messages: any, options: any) => void) => ({
  chat: async (messages: any, options: any) => { record?.(messages, options); return { text, receipt: actualReceipt, policyAlerts: ['WATCHED_MODEL_FAMILY:fixture'] }; }
});

test('explanation prompt is allowlisted and omits measured source values', async () => {
  const run = await evaluation();
  run.decisions[0].evidenceBundle.observations[0].measuredTuples = [['SECRET_SOURCE_VALUE']];
  const input = buildExplanationInput(run as any);
  const text = JSON.stringify(input);
  assert.ok(text.includes(run.decisions[0].candidateId));
  assert.ok(text.includes(run.decisions[0].decision.verdict));
  assert.ok(!text.includes('SECRET_SOURCE_VALUE'));
  assert.ok(text.includes('rowCount'));
  assert.ok(!text.includes('measuredTuples'));
});

test('grounding keeps identifier space and endpoint namespaces independent and marks model text unverified', async () => {
  const run = await evaluation(), source = run.decisions[0];
  const cases = [
    { identifierSpace: { state: 'UNKNOWN' }, from: { state: 'KNOWN', value: 'source-ns' }, to: { state: 'KNOWN', value: 'target-ns' } },
    { identifierSpace: { state: 'KNOWN', value: 'synthetic-space' }, from: { state: 'UNKNOWN' }, to: { state: 'UNKNOWN' } }
  ];
  const original = JSON.stringify({ decisions: run.decisions, sourceValidation: run.sourceValidation });
  for (const facts of cases) {
    const contract = { ...source.contract, identifierSpace: facts.identifierSpace, from: { ...source.contract.from, namespace: facts.from }, to: { ...source.contract.to, namespace: facts.to } };
    const decision = { ...source.decision, reasonCodes: ['identifier_space_or_namespace_unknown'], requirementsMissing: ['known_identifier_space_and_namespaces'] };
    const input = buildExplanationInput({ ...run, decisions: [{ ...source, contract, decision }] } as any);
    const projected = input.decisions[0].semanticFacts;
    assert.deepEqual(projected.identifierSpace, facts.identifierSpace);
    assert.deepEqual(projected.endpointNamespaces, { from: facts.from, to: facts.to });
    assert.deepEqual(input.decisions[0].requirementsMissing, ['known_identifier_space_and_namespaces']);
    assert.equal(input.semanticGrounding.verificationStatus, 'MODEL_TEXT_NOT_SEMANTICALLY_VERIFIED');
    assert.deepEqual(input.semanticGrounding.decisions[0].identifierSpace, facts.identifierSpace);
    assert.deepEqual(input.semanticGrounding.decisions[0].endpointNamespaces, { from: facts.from, to: facts.to });
    const messages = modelMessages(input);
    assert.match(messages[0].content, /campos independientes/);
    assert.match(messages[0].content, /no infieras que todos son desconocidos/);
    assert.match(messages[0].content, /requirementsMissing para nombrar requisitos concretos/);
    assert.match(messages[0].content, /no tiene veracidad semántica automáticamente acreditada/);
    assert.ok(!messages[1].content.includes('measuredTuples'));
    assert.ok(!messages[1].content.includes('assertions'));
  }
  const replay = buildExplanationGrounding({ ...run, executionMode: 'REPLAY', dataOrigin: 'SYNTHETIC' } as any);
  assert.equal(replay.executionMode, 'REPLAY');
  assert.equal(replay.dataOrigin, 'SYNTHETIC');
  assert.equal(replay.decisions[0].decisionScope.state, 'KNOWN');
  assert.equal(JSON.stringify({ decisions: run.decisions, sourceValidation: run.sourceValidation }), original);
});

test('explanation prompt requests compact one-sentence JSON with a bounded length', async () => {
  const messages = modelMessages(buildExplanationInput(await evaluation()));
  assert.match(messages[0].content, /JSON compacto en una sola línea, sin Markdown/);
  assert.match(messages[0].content, /una frase breve de hasta 240 caracteres/);
});
test('valid explanation is persisted separately with verified model consumption and unchanged decisions', async () => {
  const root = scratch(), run = await evaluation(), before = JSON.stringify({ decisions: run.decisions, sourceValidation: run.sourceValidation });
  const ids = run.decisions.map(item => item.candidateId);
  let sent: any;
  try {
    const output = await explainLiveEvaluation(run as any, {
      projectRoot: root, now: () => '2026-10-23T12:00:00.000Z',
      clientFactory: () => fakeClient(responseText(ids), receipt, (messages, options) => { sent = { messages, options }; })
    });
    assert.equal(output.explanationStatus, 'PASS');
    assert.equal(output.generationStatus, 'PASS');
    assert.equal(output.artifact?.receiptStatus, 'VERIFIED');
    assert.equal(output.artifact?.semanticGrounding.verificationStatus, 'MODEL_TEXT_NOT_SEMANTICALLY_VERIFIED');
    assert.equal(output.artifact?.semanticGrounding.executionMode, 'LIVE');
    assert.equal(output.artifact?.semanticGrounding.dataOrigin, 'SYNTHETIC');
    assert.equal(output.artifact?.receipt?.model, 'claude-haiku-fixture');
    assert.equal(output.artifact?.receipt?.totalTokens, 125);
    assert.deepEqual(output.artifact?.policyAlerts, ['WATCHED_MODEL_FAMILY:fixture']);
    assert.deepEqual(JSON.parse(sent.messages[1].content).decisions.map((item: any) => item.candidateId), ids);
    assert.equal(sent.options.route, 'meterless/cheap');
    assert.equal(sent.options.maxTokens, 2000);
    assert.equal(sent.options.preserveTextOnFailure, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, output.artifactRef!), 'utf8')), output.artifact);
    assert.equal(JSON.stringify({ decisions: run.decisions, sourceValidation: run.sourceValidation }), before);
    assert.equal(historicalExplanationStatus(run.runId, root).explanationStatus, 'HISTORICAL_OUTPUT_AVAILABLE');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('malformed, unknown, duplicate, incomplete, and verdict-changing responses are rejected without retry', async () => {
  const root = scratch();
  try {
    const run = await evaluation(), ids = run.decisions.map(item => item.candidateId);
    const invalid = [
      JSON.stringify({ explanations: [{ candidateId: 'foreign-id', explanation: 'Texto explicativo suficientemente largo.' }] }),
      JSON.stringify({ explanations: ids.flatMap(candidateId => [{ candidateId, explanation: 'Texto explicativo suficientemente largo.' }, { candidateId, explanation: 'Otro texto explicativo suficientemente largo.' }]) }),
      JSON.stringify({ explanations: ids.slice(1).map(candidateId => ({ candidateId, explanation: 'Texto explicativo suficientemente largo.' })) }),
      JSON.stringify({ explanations: ids.map(candidateId => ({ candidateId, explanation: 'Texto explicativo suficientemente largo.', verdict: 'SOSTENIDA' })) })
    ];
    for (const [index, text] of invalid.entries()) {
      const trial = { ...run, runId: run.runId + '-' + index };
      let calls = 0;
      const output = await explainLiveEvaluation(trial as any, { projectRoot: root, clientFactory: () => ({ chat: async () => { calls++; return { text, receipt, policyAlerts: [] }; } }) });
      assert.equal(output.explanationStatus, 'ERROR');
      assert.equal(output.generationStatus, 'PASS');
      assert.equal(calls, 1);
      assert.equal(output.artifact?.explanations.length, 0);
      assert.equal(output.artifact?.responseText, text);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('compact complete response parses all four candidates', () => {
  const ids = ['rel-a', 'rel-b', 'rel-c', 'rel-d'];
  const text = JSON.stringify({ explanations: ids.map(candidateId => ({ candidateId, explanation: 'Cruza claves exactas; la evidencia es histórica y acotada.' })) });
  const parsed = parseExplanationResponse(text, ids);
  assert.deepEqual(parsed.map(item => item.candidateId), ids);
  assert.ok(parsed.every(item => item.explanation.length <= 240));
});
test('truncated completion retains text and receipt and labels the parser failure', async () => {
  const root = scratch(), run = await evaluation(), firstId = run.decisions[0].candidateId;
  const partial = `{"explanations":[{"candidateId":"${firstId}","explanation":"La evidencia hist`;
  try {
    const output = await explainLiveEvaluation(run as any, { projectRoot: root, clientFactory: () => ({
      chat: async () => ({ text: partial, receipt, policyAlerts: [], finishReason: 'length', truncated: true })
    }) });
    assert.equal(output.explanationStatus, 'ERROR');
    assert.equal(output.artifact?.error?.code, 'EXPLANATION_RESPONSE_TRUNCATED');
    assert.equal(output.artifact?.responseText, partial);
    assert.deepEqual(output.artifact?.receipt, receipt);
    assert.equal(output.artifact?.receiptStatus, 'VERIFIED');
    assert.equal(output.artifact?.generationStatus, 'PASS');
    assert.equal(output.artifact?.finishReason, 'length');
    assert.equal(output.artifact?.responseTruncated, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('failed receipt resolution preserves returned text as unverified without calling it live', async () => {
  const root = scratch(), run = await evaluation();
  const raw = JSON.stringify({ explanations: run.decisions.map(item => ({ candidateId: item.candidateId, explanation: 'Texto recibido pendiente de verificación.' })) });
  try {
    const output = await explainLiveEvaluation(run as any, { projectRoot: root, clientFactory: () => ({
      chat: async () => { throw new NightshiftChatError('RECEIPT_NOT_FOUND', undefined, undefined, undefined, 'attempt-fixture', raw, undefined, false); }
    }) });
    assert.equal(output.explanationStatus, 'ERROR');
    assert.equal(output.generationStatus, 'ERROR');
    assert.equal(output.artifact?.receiptStatus, 'UNVERIFIED');
    assert.equal(output.artifact?.responseText, raw);
    assert.equal(output.artifact?.error?.code, 'RECEIPT_NOT_FOUND');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('preflight failure or zero decisions avoids model construction and generation', async () => {
  const root = scratch(), run = await evaluation();
  let constructions = 0;
  try {
    const partial = await explainLiveEvaluation({ ...run, status: 'PARTIAL', sourceValidation: { status: 'PARTIAL' } } as any, { projectRoot: root, clientFactory: () => { constructions++; throw new Error('not called'); } });
    const none = await explainLiveEvaluation({ ...run, decisions: [] } as any, { projectRoot: root, clientFactory: () => { constructions++; throw new Error('not called'); } });
    assert.equal(partial.explanationStatus, 'NOT_RUN_PRECONDITIONS');
    assert.equal(none.explanationStatus, 'NOT_RUN_PRECONDITIONS');
    assert.equal(constructions, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cached receipt is not reported as a live explanation', async () => {
  const root = scratch(), run = await evaluation();
  try {
    const output = await explainLiveEvaluation(run as any, { projectRoot: root, clientFactory: () => fakeClient(responseText(run.decisions.map(item => item.candidateId)), { ...receipt, fromCache: true }) });
    assert.equal(output.explanationStatus, 'ERROR');
    assert.equal(output.generationStatus, 'ERROR');
    assert.equal(output.artifact?.receiptStatus, 'VERIFIED_CACHED');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
