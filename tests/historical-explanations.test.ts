import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT } from '../src/runtime.ts';
import {
  explainHistoricalCapture, loadExplanationCaptureRegistry, resolveExplanationCapturePin,
  validateExplanationCaptureRegistry, validateHistoricalCapturePayload
} from '../src/historical-explanations.ts';
import { resolveUniverseManifest } from '../src/registry/universes.ts';
import { buildExplanationInput, buildExplanationGrounding, modelMessages, parseExplanationResponse } from '../src/live-explanations.ts';
import { evaluateLocalFixtureUniverse } from '../src/universe-pipeline.ts';
import type { Receipt } from '../src/clients/nightshift.ts';

const receipt: Receipt = { receiptId: 'historical-fixture-receipt', provider: 'anthropic', model: 'fixture', inputTokens: 10, outputTokens: 10, totalTokens: 20, latencyMs: 1, fromCache: false, requestedMode: 'cheap', routedMode: 'cheap', modeCoerced: false, costUsd: 0.001 };
const response = (ids: string[]) => JSON.stringify({ explanations: ids.map(candidateId => ({ candidateId, explanation: 'La evidencia histórica respalda esta lectura con prudencia.' })) });
const registry = loadExplanationCaptureRegistry(ROOT);
const pin = registry.captures[0];
const manifest = resolveUniverseManifest('GTFS_SVP1_LIVE')!;
function fixtureRoot(t: any) {
  const source = path.join(ROOT, pin.inputRef);
  if (!fs.existsSync(source)) { t.skip('pinned accepted capture is not installed in this checkout'); return undefined; }
  const root = fs.mkdtempSync(path.join(ROOT, '.concordia', 'historical-explanation-test-'));
  const target = path.join(root, pin.inputRef);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const taskFile = (root: string, name: string) => path.join(root, '.concordia', 'live-explanations', 'tasks', name);

test('synthetic historical explanation grounding keeps semantic facts separate and REPLAY provenance intact', async () => {
  const local = await evaluateLocalFixtureUniverse('GTFS');
  const item = local.results[0];
  const contract = { ...item.contract, identifierSpace: { state: 'UNKNOWN' },
    from: { ...item.contract.from, namespace: { state: 'KNOWN', value: 'synthetic-source-ns' } },
    to: { ...item.contract.to, namespace: { state: 'KNOWN', value: 'synthetic-target-ns' } } };
  const decision = { ...item.decision, reasonCodes: ['identifier_space_or_namespace_unknown'], requirementsMissing: ['known_identifier_space_and_namespaces'] };
  const evaluation = { runId: 'synthetic-historical-grounding', manifestId: local.manifestId, version: local.version, executionMode: 'LIVE', dataOrigin: 'SYNTHETIC', status: 'EVALUATED', sourceValidation: { status: 'COMPLETE' }, decisions: [{ candidateId: item.relationId, contract, decision, evidenceBundle: item.evidence, evidenceRef: item.evidence.evidenceBundleId }] } as any;
  const input = buildExplanationInput(evaluation);
  const replayGrounding = buildExplanationGrounding(evaluation, 'REPLAY');
  const historicalInput = { ...input, executionMode: 'REPLAY', sourceExecutionMode: 'REPLAY', sourceCaptureExecutionMode: 'LIVE', historicalEvidence: true, semanticGrounding: replayGrounding };
  const messages = modelMessages(historicalInput as any);
  assert.equal(replayGrounding.executionMode, 'REPLAY');
  assert.equal(replayGrounding.dataOrigin, 'SYNTHETIC');
  assert.equal(replayGrounding.decisions[0].identifierSpace.state, 'UNKNOWN');
  assert.equal(replayGrounding.decisions[0].endpointNamespaces.from.state, 'KNOWN');
  assert.equal(replayGrounding.decisions[0].endpointNamespaces.to.state, 'KNOWN');
  assert.equal(replayGrounding.verificationStatus, 'MODEL_TEXT_NOT_SEMANTICALLY_VERIFIED');
  assert.equal(historicalInput.sourceCaptureExecutionMode, 'LIVE');
  assert.match(messages[1].content, /"executionMode":"REPLAY"/);
  assert.match(messages[1].content, /"dataOrigin":"SYNTHETIC"/);
  assert.ok(!messages[1].content.includes('measuredTuples'));
  assert.ok(!messages[1].content.includes('assertions'));
});

test('historical explanation prepares, dispatches once through the default factory path, and retries without env loading', async t => {
  const root = fixtureRoot(t); if (!root) return;
  let clientConstructions = 0, envLoads = 0, sentMessages: any[] = [], sentOptions: any, factoryOrder: string[] = [];
  const taskId = 'historical-' + randomUUID().replaceAll('-', '');
  const capture = JSON.parse(fs.readFileSync(path.join(root, pin.inputRef), 'utf8'));
  const environmentLoader = () => {
    envLoads++; factoryOrder.push('env');
    assert.ok(fs.existsSync(taskFile(root, taskId + '.dispatch')), 'dispatch reservation precedes environment loading');
  };
  const prepared = await explainHistoricalCapture(pin.inputRef, pin.inputSha256, taskId, 'GTFS_SVP1_LIVE', {
    projectRoot: root, captureRegistry: registry, phase: 'prepare', environmentLoader
  });
  assert.equal(prepared.explanationStatus, 'PREPARED_FOR_DISPATCH');
  assert.equal(clientConstructions, 0); assert.equal(envLoads, 0);
  const intentPath = taskFile(root, taskId + '.intent'), intent = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
  assert.equal(intent.inputSha256, pin.inputSha256); assert.equal(intent.sourceExecutionMode, 'REPLAY');
  assert.equal(intent.sourceCaptureExecutionMode, 'LIVE'); assert.equal(intent.modelExecutionMode, 'LIVE');
  assert.equal(intent.sourceProductCommit, pin.producerCommit); assert.equal(intent.manifestVersion, pin.manifestVersion);
  assert.equal(intent.promptSha256, createHash('sha256').update(JSON.stringify(intent.messages)).digest('hex'));
  assert.ok(!JSON.stringify(intent.messages).includes('measuredTuples'));

  const output = await explainHistoricalCapture(pin.inputRef, pin.inputSha256, taskId, 'GTFS_SVP1_LIVE', {
    projectRoot: root, captureRegistry: registry, phase: 'dispatch', environmentLoader,
    nightshiftFactory: () => {
      clientConstructions++; factoryOrder.push('client');
      return { chat: async (messages: any[], options: any) => { sentMessages = messages; sentOptions = options; return { text: response(capture.decisions.map((item: any) => item.candidateId)), receipt, policyAlerts: [] }; } };
    }
  });
  assert.equal(output.explanationStatus, 'PASS'); assert.equal(output.artifact?.sourceExecutionMode, 'REPLAY');
  assert.equal(output.artifact?.sourceCaptureExecutionMode, 'LIVE'); assert.equal(output.artifact?.modelExecutionMode, 'LIVE');
  assert.equal(output.artifact?.sourceCapturedAt, 'UNKNOWN'); assert.equal(output.artifact?.sourceCaptureTimeStatus, 'UPPER_BOUND_ONLY');
  assert.equal(output.artifact?.sourceCaptureTimeUpperBound, pin.captureTime.upperBound); assert.equal(output.artifact?.sourceCaptureRunId, pin.runId);
  assert.deepEqual(sentMessages, intent.messages); assert.equal(sentOptions.maxTokens, 2000); assert.equal(clientConstructions, 1); assert.equal(envLoads, 1);
  assert.deepEqual(factoryOrder, ['env', 'client']);
  const saved = JSON.parse(fs.readFileSync(path.join(root, output.artifactRef!), 'utf8'));
  assert.equal(saved.inputSha256, pin.inputSha256); assert.equal(saved.sourceExecutionMode, 'REPLAY');
  assert.equal(saved.intentSha256, createHash('sha256').update(fs.readFileSync(intentPath)).digest('hex'));
  const { taskSha256, ...taskBody } = saved;
  assert.equal(taskSha256, createHash('sha256').update(JSON.stringify(taskBody)).digest('hex'));

  const retry = await explainHistoricalCapture(pin.inputRef, pin.inputSha256, taskId, 'GTFS_SVP1_LIVE', {
    projectRoot: root, captureRegistry: registry, phase: 'dispatch',
    environmentLoader: () => { envLoads++; throw new Error('retry must not load environment'); },
    clientFactory: () => { clientConstructions++; throw new Error('retry must not construct model client'); }
  });
  assert.equal(retry.explanationStatus, 'HISTORICAL_OUTPUT_AVAILABLE');
  assert.equal(clientConstructions, 1); assert.equal(envLoads, 1);
});

test('truncated historical completion persists the exact response, receipt, and stop metadata', async t => {
  const root = fixtureRoot(t); if (!root) return;
  const taskId = 'historical-truncated-' + randomUUID().replaceAll('-', '');
  const capture = JSON.parse(fs.readFileSync(path.join(root, pin.inputRef), 'utf8'));
  const firstId = capture.decisions[0].candidateId;
  const partial = `{"explanations":[{"candidateId":"${firstId}","explanation":"La evidencia hist`;
  await explainHistoricalCapture(pin.inputRef, pin.inputSha256, taskId, 'GTFS_SVP1_LIVE', { projectRoot: root, captureRegistry: registry, phase: 'prepare' });
  const output = await explainHistoricalCapture(pin.inputRef, pin.inputSha256, taskId, 'GTFS_SVP1_LIVE', {
    projectRoot: root, captureRegistry: registry, phase: 'dispatch',
    clientFactory: () => ({ chat: async () => ({ text: partial, receipt, policyAlerts: [], finishReason: 'length', stopReason: 'max_tokens', truncated: true }) })
  });
  assert.equal(output.explanationStatus, 'ERROR');
  assert.equal(output.artifact?.error?.code, 'EXPLANATION_RESPONSE_TRUNCATED');
  assert.equal(output.artifact?.responseText, partial);
  assert.deepEqual(output.artifact?.receipt, receipt);
  assert.equal(output.artifact?.receiptStatus, 'VERIFIED');
  assert.equal(output.artifact?.finishReason, 'length'); assert.equal(output.artifact?.stopReason, 'max_tokens');
  assert.equal(output.artifact?.responseTruncated, true);
});
test('exclusive dispatch reservation prevents duplicate concurrent model calls', async t => {
  const root = fixtureRoot(t); if (!root) return;
  const taskId = 'historical-race-' + randomUUID().replaceAll('-', '');
  const capture = JSON.parse(fs.readFileSync(path.join(root, pin.inputRef), 'utf8'));
  await explainHistoricalCapture(pin.inputRef, pin.inputSha256, taskId, 'GTFS_SVP1_LIVE', { projectRoot: root, captureRegistry: registry, phase: 'prepare' });
  let calls = 0, release!: (value: any) => void;
  const waiting = new Promise<any>(resolve => { release = resolve; });
  const clientFactory = () => ({ chat: async () => { calls++; return waiting; } });
  const first = explainHistoricalCapture(pin.inputRef, pin.inputSha256, taskId, 'GTFS_SVP1_LIVE', { projectRoot: root, captureRegistry: registry, phase: 'dispatch', clientFactory });
  assert.equal(calls, 1);
  const second = explainHistoricalCapture(pin.inputRef, pin.inputSha256, taskId, 'GTFS_SVP1_LIVE', { projectRoot: root, captureRegistry: registry, phase: 'dispatch', clientFactory: () => { calls++; throw new Error('duplicate dispatch'); } });
  await assert.rejects(second, /EXPLANATION_TASK_PENDING_NO_RETRY/); assert.equal(calls, 1);
  release({ text: response(capture.decisions.map((item: any) => item.candidateId)), receipt, policyAlerts: [] });
  assert.equal((await first).explanationStatus, 'PASS');
});

test('historical explanation rejects bad hashes, paths, and DTO links before model construction', async t => {
  const root = fixtureRoot(t); if (!root) return;
  let calls = 0; const clientFactory = () => { calls++; throw new Error('must reject before model client'); };
  await assert.rejects(explainHistoricalCapture(pin.inputRef, '0'.repeat(64), 'task-hash-mismatch', 'GTFS_SVP1_LIVE', { projectRoot: root, captureRegistry: registry, phase: 'prepare', clientFactory }), /HISTORICAL_CAPTURE_NOT_REGISTERED/);
  await assert.rejects(explainHistoricalCapture('../live-explanations/inputs/capture.json', pin.inputSha256, 'task-path-mismatch', 'GTFS_SVP1_LIVE', { projectRoot: root, captureRegistry: registry, phase: 'prepare', clientFactory }), /HISTORICAL_CAPTURE_NOT_REGISTERED/);
  const inputFile = path.join(root, pin.inputRef); fs.appendFileSync(inputFile, ' ');
  await assert.rejects(explainHistoricalCapture(pin.inputRef, pin.inputSha256, 'task-tampered-input', 'GTFS_SVP1_LIVE', { projectRoot: root, captureRegistry: registry, phase: 'prepare', clientFactory }), /HISTORICAL_CAPTURE_HASH_MISMATCH/);
  const capture = JSON.parse(fs.readFileSync(path.join(ROOT, pin.inputRef), 'utf8'));
  capture.decisions[0].evidenceBundle.contractVersion = '9.9';
  assert.throws(() => validateHistoricalCapturePayload(capture, manifest, pin), /HISTORICAL_EVIDENCE_INVALID/);
  assert.equal(calls, 0);
});

test('capture registry admits a second pin by configuration without product-core changes', () => {
  const second = structuredClone(pin);
  second.captureId = 'second-synthetic-capture';
  second.inputRef = '.concordia/live-explanations/inputs/second-synthetic-capture.json';
  second.inputSha256 = 'a'.repeat(64);
  second.runId = 'second-synthetic-run';
  second.bounds = { maxInputBytes: 4096, maxCandidates: 8 };
  const configured = { ...registry, captures: [...registry.captures, second] };
  assert.deepEqual(validateExplanationCaptureRegistry(configured), []);
  assert.equal(resolveExplanationCapturePin(second.inputRef, second.inputSha256, manifest, configured).captureId, second.captureId);
});

test('response schema allows explanations with authorized counts and more than eighteen words', () => {
  const explanation = 'La captura histórica incluyó 45 filas verificadas y esta evidencia sustenta la correspondencia dentro del alcance acotado sin afirmar frescura presente.';
  assert.equal(parseExplanationResponse(JSON.stringify({ explanations: [{ candidateId: 'G01', explanation }] }), ['G01'])[0].explanation, explanation);
});

test('injected client stub dispatch does not invoke the environment loader', async t => {
  const root = fixtureRoot(t); if (!root) return;
  const taskId = 'historical-stub-' + randomUUID().replaceAll('-', '');
  const capture = JSON.parse(fs.readFileSync(path.join(root, pin.inputRef), 'utf8'));
  let envLoads = 0, clientCalls = 0;
  const environmentLoader = () => { envLoads++; };
  const prepared = await explainHistoricalCapture(pin.inputRef, pin.inputSha256, taskId, 'GTFS_SVP1_LIVE', {
    projectRoot: root, captureRegistry: registry, phase: 'prepare', environmentLoader
  });
  assert.equal(prepared.explanationStatus, 'PREPARED_FOR_DISPATCH'); assert.equal(envLoads, 0);
  const output = await explainHistoricalCapture(pin.inputRef, pin.inputSha256, taskId, 'GTFS_SVP1_LIVE', {
    projectRoot: root, captureRegistry: registry, phase: 'dispatch', environmentLoader,
    clientFactory: () => ({ chat: async () => { clientCalls++; return { text: response(capture.decisions.map((item: any) => item.candidateId)), receipt, policyAlerts: [] }; } })
  });
  assert.equal(output.explanationStatus, 'PASS'); assert.equal(clientCalls, 1); assert.equal(envLoads, 0);
});
