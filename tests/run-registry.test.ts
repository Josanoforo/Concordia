import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ROOT, readJson } from '../src/runtime.ts';
import { evaluateSvp1Live } from '../src/svp1-live.ts';
import type { Json2LiveBindingDocument } from '../src/relations/adapters/zetaris-json2.ts';
import { resolveUniverseManifest } from '../src/registry/universes.ts';
import { evaluateLocalFixtureUniverse } from '../src/universe-pipeline.ts';
import { assertCapturedRunInputsCurrent, captureLiveRun, captureLocalFixtureRun, readCapturedRun, registerCapturedRun } from '../src/registry/runs.ts';

const makeProject = () => {
  const scratch = fs.mkdtempSync(path.join(ROOT, '.concordia', 'run-registry-test-'));
  const project = path.join(scratch, 'project');
  fs.mkdirSync(project, { recursive: true });
  for (const directory of ['src', 'config', 'universes']) fs.cpSync(path.join(ROOT, directory), path.join(project, directory), { recursive: true });
  for (const directory of ['scripts']) fs.cpSync(path.join(ROOT, directory), path.join(project, directory), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) fs.copyFileSync(path.join(ROOT, file), path.join(project, file));
  for (const directory of ['data/snapshots/svp1-v1/runtime/gtfs', 'data/snapshots/svp1-v1/runtime/chinook']) { const target = path.join(project, directory); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(path.join(ROOT, directory), target, { recursive: true }); }
  return { scratch, project };
};
const registryDir = '.concordia/run-registry/test';

test('failed JSON2 preflight capture keeps profile contract versions and safe diagnostics with zero decisions', async () => {
  const { scratch, project } = makeProject();
  const registry = '.concordia/run-registry/preflight-failure-test';
  try {
    const manifest = resolveUniverseManifest('GTFS_SVP1_LIVE')!;
    const binding = readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json');
    const failure = { sourceId: 'gtfs:3c9e7b904b5035349622f03e11851e25c16d1d99:trips', code: 'HTTP_ERROR', http: 429, retryAfter: '37' };
    const adapter = { adapterId: 'offline-failure-fixture', async verifyAllTables() { return { status: 'ERROR', tables: [], failure }; }, getRunSummary() { return { status: 'ERROR', tables: [], failure }; }, async read() { throw new Error('must not evaluate after failed preflight'); } };
    const result = await evaluateSvp1Live(manifest, { binding, adapter, runId: 'preflight-failure-capture-01' });
    assert.equal(result.status, 'ERROR');
    assert.deepEqual(result.decisions, []);
    assert.ok((result.contractDeclarations ?? []).length > 0);
    const evaluation = { manifestId: result.manifestId, version: result.version, universeId: result.manifestId, executionMode: 'LIVE' as const,
      dataOrigin: result.dataOrigin, status: result.status, sourceValidation: result.sourceValidation, contractDeclarations: result.contractDeclarations,
      results: result.decisions.map((item: any) => ({ relationId: item.candidateId, contract: item.contract, evidence: item.evidenceBundle, probeStatus: item.probeStatus, decision: item.decision })) };
    const captured = await captureLiveRun(evaluation, 'preflight-failure-capture-01', { projectRoot: project, registryDir: registry });
    assert.equal(captured.record.status, 'FAILED');
    assert.deepEqual(captured.record.contractVersions, ['1.0']);
    assert.deepEqual(captured.record.sourceValidation?.failure, failure);
    assert.deepEqual(captured.record.evidenceRefs, []);
    const retry = await registerCapturedRun('preflight-failure-capture-01', { projectRoot: project, registryDir: registry });
    assert.equal(retry.status, 'REUSED');
    assert.equal(retry.record.sourceValidation?.failure?.http, 429);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
test('LIVE capture stores bounded source DTOs and retry reuses before env or source client construction', async () => {
  const { scratch, project } = makeProject();
  const registry = '.concordia/run-registry/live-capture-test';
  try {
    const manifest = resolveUniverseManifest('GTFS_SVP1_LIVE')!;
    const evaluation = {
      manifestId: manifest.manifestId, version: manifest.version, universeId: manifest.manifestId,
      executionMode: 'LIVE' as const, dataOrigin: 'UNKNOWN', status: 'PARTIAL',
      sourceValidation: {
        status: 'PARTIAL', failure: { sourceId: 'gtfs:trips', code: 'FIXTURE_INTEGRITY_FAILURE' },
        tables: [{ sourceId: 'gtfs:trips', logicalObjectId: 'snapshot.trips', status: 'ERROR', expectedRows: 12,
          actualRows: 0, describeRequestId: 'req-describe', describeQueryId: 'query-describe', describeRequestedAt: '2026-10-23T00:00:00Z',
          describeStatement: 'DESCRIBE fixture', describeDurationMs: 1, rows: [['raw marker must not persist']] }]
      },
      results: []
    };
    const captured = await captureLiveRun(evaluation, 'live-capture-01', { projectRoot: project, registryDir: registry });
    assert.equal(captured.status, 'RECORDED');
    assert.equal(captured.record.executionMode, 'LIVE');
    assert.equal(captured.record.status, 'PARTIAL');
    assert.ok(captured.record.sourceInputHash);
    assert.equal(captured.record.sourceValidation?.failure?.code, 'FIXTURE_INTEGRITY_FAILURE');
    const captureFile = path.join(project, ...registry.split('/'), 'captures', 'live-capture-01.json');
    const captureText = fs.readFileSync(captureFile, 'utf8');
    assert.equal(captureText.includes('raw marker must not persist'), false);
    assert.equal(captureText.includes('"rows"'), false);

    const retry = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(project, 'src/cli.ts'), 'universe', 'evaluate', '--universe', 'GTFS_SVP1_LIVE', '--capture-run', 'live-capture-01', '--run-registry-dir', registry, '--explain'], {
      cwd: project, encoding: 'utf8',
      env: { ...process.env, CONCORDIA_LOCAL_ENV_FILE: path.join(scratch, 'intentionally-absent.env'), ZETARIS_REST_URL: '', ZETARIS_API_KEY: '', ZETARIS_ORG_ID: '' }
    });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(JSON.parse(retry.stdout).status, 'CAPTURE_REUSED');
    assert.equal(JSON.parse(retry.stdout).sourceExecutionMode, 'LIVE');
    assert.equal(JSON.parse(retry.stdout).explanation.explanationStatus, 'NOT_PRESENT_HISTORICAL_CAPTURE');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
test('run registry stores metadata only, retries append idempotently, and rejects identity collisions', async () => {
  const { scratch, project } = makeProject();
  try {
    const evaluation = await evaluateLocalFixtureUniverse('GTFS');
    const first = await captureLocalFixtureRun(evaluation, 'fixture-run-01', { projectRoot: project, registryDir });
    assert.equal(first.status, 'RECORDED');
    assert.equal(first.record.universeId, 'concordia.universe.gtfs');
    assert.deepEqual(first.record.contractVersions, [...new Set(evaluation.results.map(item => item.contract.contractVersion))].sort());
    assert.equal(first.record.policyVersion, evaluation.results[0].decision.policyVersion);
    assert.equal(first.record.executionMode, 'LOCAL');
    assert.equal(first.record.dataOrigin, 'SYNTHETIC');
    const capturePath = path.join(project, ...registryDir.split('/'), 'captures', 'fixture-run-01.json');
    const captureText = fs.readFileSync(capturePath, 'utf8');
    assert.equal(captureText.includes('tuples'), false);
    assert.equal(captureText.includes('fixtureRows'), false);
    assert.equal(readCapturedRun('fixture-run-01', { projectRoot: project, registryDir })?.runId, 'fixture-run-01');
    assert.equal((await registerCapturedRun('fixture-run-01', { projectRoot: project, registryDir })).status, 'REUSED');
    const logPath = path.join(project, ...registryDir.split('/'), 'runs.jsonl');
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 1);
    assertCapturedRunInputsCurrent(first.record, project);

    const originalLog = fs.readFileSync(logPath, 'utf8');
    fs.writeFileSync(logPath, originalLog.replace('/run-registry/test/captures/', '/run-registry/../test/captures/'));
    await assert.rejects(() => registerCapturedRun('fixture-run-01', { projectRoot: project, registryDir }), /RUN_REGISTRY_CORRUPT/);
    fs.writeFileSync(logPath, originalLog);
    const altered = structuredClone(evaluation) as any;
    altered.results[0].decision.verdict = 'INDETERMINADA';
    await assert.rejects(() => captureLocalFixtureRun(altered, 'fixture-run-01', { projectRoot: project, registryDir }), /RUN_REGISTRY_IDENTITY_COLLISION/);
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 1);
    await assert.rejects(() => captureLocalFixtureRun(evaluation, 'traversal', { projectRoot: project, registryDir: '.concordia/run-registry/../escape' }), /RUN_REGISTRY_PATH_INVALID/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('run identity detects isolated manifest, config, dependency source, and policy drift', async () => {
  const { scratch, project } = makeProject();
  try {
    const evaluation = await evaluateLocalFixtureUniverse('GTFS');
    const run = await captureLocalFixtureRun(evaluation, 'drift-check', { projectRoot: project, registryDir });
    assertCapturedRunInputsCurrent(run.record, project);

    const manifestPath = path.join(project, 'universes', 'registry.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    fs.appendFileSync(manifestPath, '\n');
    assert.throws(() => assertCapturedRunInputsCurrent(run.record, project), /RUN_REGISTRY_IDENTITY_COLLISION/);
    fs.writeFileSync(manifestPath, manifestBytes);
    assertCapturedRunInputsCurrent(run.record, project);

    const manifest = JSON.parse(manifestBytes.toString('utf8')).find((item: any) => item.manifestId === evaluation.manifestId);
    const configPath = path.join(project, manifest.source.configPath);
    const configBytes = fs.readFileSync(configPath);
    fs.appendFileSync(configPath, '\n');
    assert.throws(() => assertCapturedRunInputsCurrent(run.record, project), /RUN_REGISTRY_IDENTITY_COLLISION/);
    fs.writeFileSync(configPath, configBytes);
    assertCapturedRunInputsCurrent(run.record, project);

    const dependencyPath = path.join(project, 'src', 'contracts', 'types.ts');
    fs.appendFileSync(dependencyPath, '\n// source closure drift fixture\n');
    assert.throws(() => assertCapturedRunInputsCurrent(run.record, project), /RUN_REGISTRY_IDENTITY_COLLISION/);

    const overriddenEvaluation = await evaluateLocalFixtureUniverse('GTFS', '9.4');
    const overrideRun = await captureLocalFixtureRun(overriddenEvaluation, 'policy-override', { projectRoot: project, registryDir });
    assert.equal(overrideRun.record.policyVersion, '9.4');
    assert.notEqual(overrideRun.record.hashes.policy, run.record.hashes.policy);
    assert.equal(overriddenEvaluation.results[0].decision.policyVersion, '9.4');
    assertCapturedRunInputsCurrent(overrideRun.record, project, '9.4');
    assert.throws(() => assertCapturedRunInputsCurrent(overrideRun.record, project), /RUN_REGISTRY_IDENTITY_COLLISION/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
test('run-registry safety guards reject malformed records, foreign locks, escaping junctions, and false completeness', async context => {
  const { scratch, project } = makeProject();
  const evaluation = await evaluateLocalFixtureUniverse('GTFS');
  try {
    const localRegistryDir = '.concordia/run-registry/guards';
    const capturePath = (runId: string) => path.join(project, ...localRegistryDir.split('/'), 'captures', runId + '.json');
    for (const [suffix, mutate] of [
      ['missing', (record: any) => { delete record.evidenceRefs; }],
      ['null', (record: any) => { record.evidenceRefs = null; }]
    ] as const) {
      const runId = 'bad-capture-' + suffix;
      await captureLocalFixtureRun(evaluation, runId, { projectRoot: project, registryDir: localRegistryDir });
      const malformed = JSON.parse(fs.readFileSync(capturePath(runId), 'utf8'));
      mutate(malformed);
      fs.writeFileSync(capturePath(runId), JSON.stringify(malformed));
      await assert.rejects(() => registerCapturedRun(runId, { projectRoot: project, registryDir: localRegistryDir }), error => error instanceof Error && error.message === 'RUN_REGISTRY_CAPTURE_CORRUPT');
    }

    for (const [suffix, mutate] of [
      ['missing', (record: any) => { delete record.evidenceRefs; }],
      ['null', (record: any) => { record.evidenceRefs = null; }]
    ] as const) {
      const runId = 'bad-log-' + suffix;
      await captureLocalFixtureRun(evaluation, runId, { projectRoot: project, registryDir: localRegistryDir });
      const logPath = path.join(project, ...localRegistryDir.split('/'), 'runs.jsonl');
      const originalLog = fs.readFileSync(logPath, 'utf8');
      const lines = originalLog.trim().split('\n').map(line => JSON.parse(line));
      mutate(lines[0]);
      fs.writeFileSync(logPath, lines.map(record => JSON.stringify(record)).join('\n') + '\n');
      await assert.rejects(() => registerCapturedRun(runId, { projectRoot: project, registryDir: localRegistryDir }), error => error instanceof Error && error.message === 'RUN_REGISTRY_CORRUPT');
      fs.writeFileSync(logPath, originalLog);
    }

    const lockPath = path.join(project, ...localRegistryDir.split('/'), 'runs.lock');
    fs.writeFileSync(lockPath, 'foreign-writer-token');
    await assert.rejects(() => registerCapturedRun('bad-log-null', { projectRoot: project, registryDir: localRegistryDir }), error => error instanceof Error && error.message === 'RUN_REGISTRY_WRITER_EXISTS');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'foreign-writer-token');
    fs.rmSync(lockPath);

    const failed: any = structuredClone(evaluation);
    failed.results.forEach((result: any) => { result.probeStatus = 'ERROR'; });
    const failedRecord = await captureLocalFixtureRun(failed, 'all-error-status', { projectRoot: project, registryDir: localRegistryDir });
    assert.equal(failedRecord.record.status, 'FAILED');
    const mixed: any = { ...structuredClone(evaluation), results: [
      { ...structuredClone(evaluation.results[0]), probeStatus: 'COMPLETE' },
      { ...structuredClone(evaluation.results[0]), probeStatus: 'ERROR' }
    ] };
    const mixedRecord = await captureLocalFixtureRun(mixed, 'mixed-status', { projectRoot: project, registryDir: localRegistryDir });
    assert.equal(mixedRecord.record.status, 'PARTIAL');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }

  await context.test('junction to a sibling path is rejected before outside writes', async junctionContext => {
    const { scratch: linkScratch, project: linkProject } = makeProject();
    try {
      const concordia = path.join(linkProject, '.concordia'), sibling = path.join(linkScratch, 'outside-project');
      fs.mkdirSync(concordia, { recursive: true });
      fs.mkdirSync(sibling);
      const junction = path.join(concordia, 'run-registry');
      try { fs.symlinkSync(sibling, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error: any) { junctionContext.skip('SKIP: OS prevented junction creation (' + String(error?.code ?? error?.message) + ')'); return; }
      const evaluation = await evaluateLocalFixtureUniverse('GTFS');
      await assert.rejects(() => captureLocalFixtureRun(evaluation, 'junction-reject', { projectRoot: linkProject }), /RUN_REGISTRY_DIRECTORY_UNSAFE/);
      assert.equal(fs.readdirSync(sibling).length, 0);
    } finally { fs.rmSync(linkScratch, { recursive: true, force: true }); }
  });
});
test('offline CLI capture reuse and record-only retry preserve original execution metadata', () => {
  const { scratch, project } = makeProject();
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const preload = path.join(scratch, 'deny-network.mjs');
  const noEnv = path.join(scratch, 'must-not-load.env');
  const dir = '.concordia/run-registry/cli-test';
  fs.writeFileSync(preload, `import http from 'node:http'; import https from 'node:https'; globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); }; for (const client of [http, https]) for (const method of ['request', 'get']) client[method] = () => { throw new Error('NETWORK_FORBIDDEN'); };\n`);
  const invoke = (args: string[]) => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, tsxCli, path.join(project, 'src', 'cli.ts'), ...args], {
    cwd: project, encoding: 'utf8', env: { ...process.env, CONCORDIA_LOCAL_ENV_FILE: noEnv, TSX_DISABLE_CACHE: '1', TMPDIR: path.join(project, '.concordia', 'tmp'), TEMP: path.join(project, '.concordia', 'tmp'), TMP: path.join(project, '.concordia', 'tmp') }
  });
  try {
    const explanationWithoutCapture = invoke(['universe', 'evaluate', '--universe', 'GTFS_SVP1_LIVE', '--explain']);
    assert.equal(explanationWithoutCapture.status, 1);
    assert.match(explanationWithoutCapture.stderr, /EXPLANATION_CAPTURE_RUN_REQUIRED/);

    const first = invoke(['universe', 'evaluate', '--universe', 'GTFS', '--capture-run', 'cli-fixture-01', '--run-registry-dir', dir]);
    assert.equal(first.status, 0, first.stderr);
    const captured = JSON.parse(first.stdout.trim().split('\n').at(-1)!);
    assert.equal(captured.status, 'EVALUATED');
    assert.equal(captured.runRegistryStatus, 'RECORDED');

    const aliasRetry = invoke(['universe', 'evaluate', '--universe', 'concordia.universe.gtfs', '--capture-run', 'cli-fixture-01', '--run-registry-dir', dir]);
    assert.equal(aliasRetry.status, 0, aliasRetry.stderr);
    const reused = JSON.parse(aliasRetry.stdout.trim().split('\n').at(-1)!);
    assert.equal(reused.status, 'CAPTURE_REUSED');
    assert.equal(reused.sourceExecutionMode, 'LOCAL');
    assert.equal('results' in reused, false);

    const policyOverride = invoke(['universe', 'evaluate', '--universe', 'GTFS', '--capture-run', 'cli-policy-override', '--run-registry-dir', dir, '--policy-version', '9.4']);
    assert.equal(policyOverride.status, 0, policyOverride.stderr);
    const overrideRecord = readCapturedRun('cli-policy-override', { projectRoot: project, registryDir: dir });
    const defaultRecord = readCapturedRun('cli-fixture-01', { projectRoot: project, registryDir: dir });
    assert.equal(overrideRecord?.policyVersion, '9.4');
    assert.notEqual(overrideRecord?.hashes.policy, defaultRecord?.hashes.policy);
    const wrongPolicyReuse = invoke(['universe', 'evaluate', '--universe', 'GTFS', '--capture-run', 'cli-policy-override', '--run-registry-dir', dir]);
    assert.equal(wrongPolicyReuse.status, 1);
    const wrongUniverse = invoke(['universe', 'evaluate', '--universe', 'CHINOOK', '--capture-run', 'cli-fixture-01', '--run-registry-dir', dir]);
    assert.equal(wrongUniverse.status, 1);

    const logPath = path.join(project, ...dir.split('/'), 'runs.jsonl');
    fs.rmSync(logPath);
    const retry = invoke(['universe', 'run-record', '--run-id', 'cli-fixture-01', '--run-registry-dir', dir]);
    assert.equal(retry.status, 0, retry.stderr);
    const retried = JSON.parse(retry.stdout.trim().split('\n').at(-1)!);
    assert.equal(retried.status, 'RECORDED');
    assert.equal(retried.sourceExecutionMode, 'LOCAL');
    assert.equal('results' in retried, false);
    const duplicate = invoke(['universe', 'run-record', '--run-id', 'cli-fixture-01', '--run-registry-dir', dir]);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout.trim().split('\n').at(-1)!).status, 'REUSED');
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 1);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
