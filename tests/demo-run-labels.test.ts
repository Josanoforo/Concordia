import test from 'node:test';
import assert from 'node:assert/strict';
import { demoRunLabels } from '../src/demo.ts';
import { modeLabel } from '../src/report/index.ts';

test('demo run labels are the true mode and origin of what runs, never LIVE by default', () => {
  const fixture = demoRunLabels('fixture', 'U1');
  assert.deepEqual(fixture, { executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
  assert.match(modeLabel({ ...fixture, utc: 'x' }), /^LOCAL .*origen de datos: SYNTHETIC/);
  const replay = demoRunLabels('replay', 'NO_SUCH_UNIVERSE', { dataOrigin: 'PUBLIC' });
  assert.deepEqual(replay, { executionMode: 'REPLAY', dataOrigin: 'PUBLIC' });
  assert.match(modeLabel(replay), /^REPLAY /);
  assert.equal(demoRunLabels('replay', 'NO_SUCH_UNIVERSE').dataOrigin, 'UNKNOWN');
  const live = demoRunLabels('live', 'NO_SUCH_UNIVERSE');
  assert.equal(live.executionMode, 'LIVE');
  assert.equal(live.dataOrigin, 'UNKNOWN', 'an unregistered origin is not guessed');
  assert.doesNotMatch(modeLabel({}), /^LIVE/);
});

test('RC-25: demo() in sample mode writes the true mode/origin into metrics.json and the report label (wiring, not just the helper)', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { ROOT } = await import('../src/runtime.ts');
  const { removePath } = await import('./helpers/safe-rm.ts');
  // The demo writes into out/U1 of its own project root: run it in a scratch copy so it never races the other tests that read the shared out/U1.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-labels-')), project = path.join(scratch, 'project');
  try {
    fs.mkdirSync(project, { recursive: true });
    for (const entry of ['src', 'scripts', 'config', 'universes', 'eval', 'data', 'docs', 'input_examples', 'output_examples', 'package.json', 'tsconfig.json']) if (fs.existsSync(path.join(ROOT, entry))) fs.cpSync(path.join(ROOT, entry), path.join(project, entry), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(project, 'node_modules'), 'junction');
    if (fs.existsSync(path.join(ROOT, 'out', 'U1'))) fs.cpSync(path.join(ROOT, 'out', 'U1'), path.join(project, 'out', 'U1'), { recursive: true });
    const run = spawnSync(process.execPath, [path.join(project, 'scripts', 'run-tsx.mjs'), path.join(project, 'src', 'cli.ts'), 'demo', '--universe', 'U1'], { encoding: 'utf8', cwd: project,
      env: { ...process.env, SAMPLE_MODE: 'true', CONCORDIA_FRESHNESS_DIR: path.join(project, '.concordia', 'freshness-test') } });
    assert.equal(run.status, 0, run.stderr);
    const metrics = JSON.parse(fs.readFileSync(path.join(project, 'out', 'U1', 'sample', 'metrics.json'), 'utf8'));
    assert.ok(['LOCAL', 'REPLAY'].includes(metrics.executionMode), `executionMode ${metrics.executionMode}`);
    assert.notEqual(metrics.executionMode, 'LIVE');
    assert.equal(typeof metrics.dataOrigin, 'string');
    assert.match(modeLabel(metrics), new RegExp(`^${metrics.executionMode} `));
    if (metrics.syntheticFixture) assert.deepEqual([metrics.executionMode, metrics.dataOrigin], ['LOCAL', 'SYNTHETIC']);
  } finally {
    try { fs.unlinkSync(path.join(project, 'node_modules')); } catch { /* junction already gone */ }
    removePath(scratch);
  }
});
