import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { helpHint, usageFor, wantsHelp } from '../src/agent/cli-help.ts';
import { ROOT } from '../src/runtime.ts';

const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tsx.mjs'), path.join(ROOT, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: ROOT });

test('usage resolves per command and agent continue is distinct', () => {
  const argv = (...a: string[]) => ['node', 'cli', ...a];
  assert.match(usageFor(argv('agent'))!, /--offline/);
  assert.match(usageFor(argv('agent', 'continue'))!, /--run-id/);
  assert.match(usageFor(argv('eval-agent'))!, /eval-agent/);
  assert.match(usageFor(argv('agent-report'))!, /agent-report/);
  assert.equal(usageFor(argv('review')), undefined);
  assert.equal(wantsHelp(argv('agent', '--help')), true);
  assert.equal(wantsHelp(argv('agent', '--universe', 'U1')), false);
  assert.match(helpHint(argv('agent-report'))!, /^USAGE/);
});

test('--help prints usage and exits 0 without touching anything', () => {
  const out = cli('agent', '--help');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /concordia agent --universe/);
});

test('a missing argument fails with the code and then the usage', () => {
  const out = cli('agent-report');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /FAIL .*AGENT_RUN_ID_REQUIRED/);
  assert.match(out.stderr, /USAGE\nconcordia agent-report --run-id/);
});

test('--probe-limit: integer 1..100 parses; anything else is PROBE_LIMIT_OUT_OF_RANGE with the usage; documented in --help', async () => {
  const { parseProbeLimit } = await import('../src/agent/cli-help.ts');
  assert.equal(parseProbeLimit(undefined), undefined);
  assert.equal(parseProbeLimit('1'), 1);
  assert.equal(parseProbeLimit('100'), 100);
  for (const bad of ['0', '101', '-3', '2.5', 'abc', '', '1e1']) assert.throws(() => parseProbeLimit(bad), /PROBE_LIMIT_OUT_OF_RANGE/, bad);
  assert.match(usageFor(['node', 'cli', 'agent'])!, /--probe-limit[^\n]*manifest/);
  const out = cli('agent', '--universe', 'U1', '--offline', '--probe-limit', '500');
  assert.notEqual(out.status, 0);
  assert.match(out.stdout + out.stderr, /PROBE_LIMIT_OUT_OF_RANGE/);
  assert.match(out.stdout + out.stderr, /--probe-limit/);
});

test('--phase-budget and --critic-assist are documented', () => {
  const usage = usageFor(['node', 'cli', 'agent'])!;
  assert.match(usage, /--phase-budget[^\n]*discovery \.4/);
  assert.match(usage, /--critic-assist[^\n]*nunca elevar/);
});

test('agent flags reach options on both routes (shared builder) and only when given', async () => {
  const { agentFlagOptions } = await import('../src/agent/cli-help.ts');
  assert.deepEqual(agentFlagOptions(['node', 'cli', 'agent'], undefined), {});
  assert.deepEqual(agentFlagOptions(['node', 'cli', 'agent', '--phase-budget', '--critic-assist', '--secondary-judge'], '7'),
    { probeLimit: 7, phaseBudget: true, criticAssist: true, secondaryJudge: true });
  assert.throws(() => agentFlagOptions(['node', 'cli', 'agent'], '0'), /PROBE_LIMIT_OUT_OF_RANGE/);
  const source = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8');
  assert.equal((source.match(/\.\.\.agentFlagOptions\(process\.argv, option\('probe-limit'\), option\('review'\), option\('negative-control'\), option\('run-id'\)\)/g) ?? []).length, 2, 'live and offline both pass the flags');
  assert.match(usageFor(['node', 'cli', 'agent'])!, /--secondary-judge[^\n]*OFF por defecto/);
});

test('--probe-limit reaches the offline run record; agent-multi needs --cross and has usage', () => {
  const runId = 'agent-x1-pl-test', dir = path.join(ROOT, '.concordia', 'agent-runs', runId);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    const run = cli('agent', '--universe', 'GTFSAGENT', '--offline', '--run-id', runId, '--probe-limit', '2');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'engine-run.json'), 'utf8'));
    assert.match(JSON.stringify(record), /"probeLimit":\s*2/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const multi = cli('agent-multi');
  assert.notEqual(multi.status, 0);
  assert.match(multi.stdout + multi.stderr, /AGENT_MULTI_CROSS_REQUIRED/);
  assert.match(usageFor(['node', 'cli', 'agent-multi'])!, /sin SQL entre fuentes/);
});

test('E1-03: --resume reaches the options only with --run-id; without it AGENT_RESUME_REQUIRES_RUN_ID; documented in --help', async () => {
  const { agentFlagOptions } = await import('../src/agent/cli-help.ts');
  const argv = (...a: string[]) => ['node', 'cli', 'agent', ...a];
  assert.deepEqual(agentFlagOptions(argv('--resume'), undefined, undefined, undefined, 'agent-x'), { resume: true });
  assert.deepEqual(agentFlagOptions(argv(), undefined, undefined, undefined, 'agent-x'), {});
  assert.throws(() => agentFlagOptions(argv('--resume'), undefined), /AGENT_RESUME_REQUIRES_RUN_ID/);
  assert.match(usageFor(argv())!, /--resume[^\n]*--run-id[^\n]*AGENT_RESUME_REQUIRES_RUN_ID/);
  const out = cli('agent', '--universe', 'U1', '--offline', '--resume');
  assert.notEqual(out.status, 0); assert.match(out.stdout + out.stderr, /AGENT_RESUME_REQUIRES_RUN_ID/);
});
