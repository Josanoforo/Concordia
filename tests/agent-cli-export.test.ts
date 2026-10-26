import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/runtime.ts';
import { resolveExportOut } from '../src/agent/cli-export.ts';

const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tsx.mjs'), path.join(ROOT, 'src', 'cli.ts'), ...args], { encoding: 'utf8', timeout: 60000 });
const text = (r: ReturnType<typeof cli>) => r.stdout + r.stderr;

test('export-negative: unknown or missing run ids are RUN_NOT_FOUND; a malformed id keeps INVALID_RUN_ID; a flag is never taken as the value', () => {
  for (const args of [['--run-id', 'agent-no-such-run-x1']]) {
    const out = cli('export-negative', ...args);
    assert.notEqual(out.status, 0);
    assert.match(text(out), /RUN_NOT_FOUND/);
  }
  for (const args of [[], ['--run-id', '--out']]) { const missing = cli('export-negative', ...args); assert.notEqual(missing.status, 0); assert.match(text(missing), /FAIL .*AGENT_RUN_ID_REQUIRED/); }
  const bad = cli('export-negative', '--run-id', '../evil');
  assert.notEqual(bad.status, 0); assert.match(text(bad), /FAIL .*INVALID_RUN_ID/);
});

test('export-negative: --out outside the repo is OUT_PATH_INVALID', () => {
  assert.throws(() => resolveExportOut(path.resolve(ROOT, '..', 'elsewhere')), /OUT_PATH_INVALID/);
  assert.throws(() => resolveExportOut('../../x'), /OUT_PATH_INVALID/);
  assert.throws(() => resolveExportOut(''), /OUT_PATH_INVALID/);
  assert.equal(resolveExportOut(undefined), undefined);
  assert.equal(resolveExportOut('out/x'), path.join(ROOT, 'out', 'x'));
  const out = cli('export-negative', '--run-id', 'agent-no-such-run-x1', '--out', '../../outside');
  assert.match(text(out), /OUT_PATH_INVALID/);
});

test('export-negative: a real run writes the dossier and prints one JSON line', () => {
  const runId = 'export-test-x1-u1', dir = path.join(ROOT, '.concordia', 'agent-runs', runId), outDir = path.join(ROOT, '.concordia', 'export-test-x1-out');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'agent-runs', 'agent-u1-live-01'), dir, { recursive: true });
  try {
    const out = cli('export-negative', '--run-id', runId, '--out', '.concordia/export-test-x1-out');
    assert.equal(out.status, 0, text(out));
    const line = JSON.parse(out.stdout.trim().split('\n').pop()!);
    assert.equal(line.entries, 12);
    assert.ok(fs.existsSync(path.join(outDir, 'negative-dossier.json')) && fs.existsSync(path.join(outDir, 'negative-dossier.md')));
    assert.equal(path.resolve(line.path), path.join(outDir, 'negative-dossier.json'));
    assert.ok(Object.values<number>(line.byKind).reduce((a, b) => a + b, 0) === 12);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true }); }
});

test('export-odcs: RUN_NOT_FOUND, AGENT_RUN_ID_REQUIRED and OUT_PATH_INVALID (out is a file)', () => {
  assert.match(text(cli('export-odcs')), /FAIL .*AGENT_RUN_ID_REQUIRED/);
  assert.match(text(cli('export-odcs', '--run-id', '../evil')), /INVALID_RUN_ID/);
  for (const args of [['--run-id', 'agent-no-such-run-x1']]) {
    const out = cli('export-odcs', ...args);
    assert.notEqual(out.status, 0);
    assert.match(text(out), /RUN_NOT_FOUND/);
  }
  assert.match(text(cli('export-odcs', '--run-id', 'agent-no-such-run-x1', '--out', '../../c.yaml')), /OUT_PATH_INVALID/);
});

test('export-odcs: U1 fixture run exports 0 relations with 6 skipped, to the requested file', () => {
  const runId = 'export-test-x1-odcs', dir = path.join(ROOT, '.concordia', 'agent-runs', runId), file = path.join(ROOT, '.concordia', 'export-test-x1-odcs', 'c.odcs.yaml');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(path.dirname(file), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'agent-runs', 'agent-u1-live-01'), dir, { recursive: true });
  try {
    const out = cli('export-odcs', '--run-id', runId, '--out', '.concordia/export-test-x1-odcs/c.odcs.yaml');
    assert.equal(out.status, 0, text(out));
    const line = JSON.parse(out.stdout.trim().split('\n').pop()!);
    assert.equal(line.skipped.length, 6);
    assert.equal(path.resolve(line.path), file);
    assert.ok(fs.existsSync(file));
    const dflt = cli('export-odcs', '--run-id', runId);
    assert.equal(dflt.status, 0, text(dflt));
    assert.ok(fs.existsSync(path.join(dir, 'contract.odcs.yaml')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('export-odcs: a GTFSAGENT run exports its sustained relation', () => {
  const runId = 'agent-export-test-x1-gtfs', dir = path.join(ROOT, '.concordia', 'agent-runs', runId);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    const run = cli('agent', '--universe', 'GTFSAGENT', '--offline', '--run-id', runId);
    assert.equal(run.status, 0, text(run));
    const out = cli('export-odcs', '--run-id', runId);
    assert.equal(out.status, 0, text(out));
    const line = JSON.parse(out.stdout.trim().split('\n').pop()!);
    assert.equal(line.relations, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('export-usl-odcs: the verified USL fixture exports 1 relation; no grant or no run says why; errors are coded', () => {
  const usl = path.join(ROOT, 'tests', 'fixtures', 'usl-publication'), dir = path.join(ROOT, '.concordia', 'export-test-x1-usl');
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    const out = path.join('.concordia', 'export-test-x1-usl', 'm.odcs.yaml');
    const ok = cli('export-usl-odcs', '--plan', path.join(usl, 'plan.json'), '--run', path.join(usl, 'run'), '--grant', path.join(usl, 'grant.json'), '--out', out);
    assert.equal(ok.status, 0, text(ok));
    const line = JSON.parse(ok.stdout.trim().split('\n').pop()!);
    assert.equal(line.relations, 1); assert.deepEqual(line.skipped, []);
    assert.ok(fs.existsSync(path.join(ROOT, out)));
    const noGrant = JSON.parse(cli('export-usl-odcs', '--plan', path.join(usl, 'plan.json'), '--run', path.join(usl, 'run'), '--out', out).stdout.trim().split('\n').pop()!);
    assert.equal(noGrant.relations, 0); assert.match(noGrant.skipped[0].reason, /sin autorizacion/);
    fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(path.join(usl, 'plan.json'), path.join(dir, 'plan.json'));
    const dflt = cli('export-usl-odcs', '--plan', path.join(dir, 'plan.json'), '--run', path.join(usl, 'run'), '--grant', path.join(usl, 'grant.json'));
    assert.equal(dflt.status, 0, text(dflt));
    assert.ok(fs.readdirSync(dir).some(file => file.endsWith('.odcs.yaml')), 'written next to the plan');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.match(text(cli('export-usl-odcs', '--plan', 'nope.json')), /USL_PLAN_NOT_FOUND/);
  assert.match(text(cli('export-usl-odcs')), /USL_PLAN_NOT_FOUND/);
  assert.match(text(cli('export-usl-odcs', '--plan', path.join(ROOT, 'tests', 'fixtures', 'usl-publication', 'plan.json'), '--out', '../../x.yaml')), /OUT_PATH_INVALID/);
});
