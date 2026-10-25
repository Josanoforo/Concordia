import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, stamp, writeJson } from '../src/runtime.ts';
const impl = path.join(ROOT, 'src/hmem/index.ts');
// HMEM_CONFORMANCE_RUNNER overrides the upstream runner path; the default expects
// a Meterless/Meterless checkout (rev 1742dec) next to this repository.
const runner = path.resolve(process.env.HMEM_CONFORMANCE_RUNNER ?? path.resolve(ROOT, '../meterless-reference/engines/hmem/conformance/runner.ts'));
if (!fs.existsSync(runner)) {
  console.error(`H-MEM conformance runner not found: ${runner}
Clone https://github.com/Meterless/Meterless at rev 1742dec into ../meterless-reference, or set HMEM_CONFORMANCE_RUNNER to engines/hmem/conformance/runner.ts.`);
  process.exit(2);
}
const tsx = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const result = spawnSync(process.execPath, [tsx, runner], { cwd: ROOT, env: { ...process.env, HMEM_IMPL: impl }, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000 });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
const evidence = { utc: new Date().toISOString(), implementation: impl, runner, command: [process.execPath, tsx, runner], environment: { HMEM_IMPL: impl },
  exitCode: result.status, stdout: result.stdout, stderr: result.stderr, status: result.status === 0 ? 'PASS' : 'FAIL' };
writeJson(`evidence/conformance-${stamp()}.json`, evidence);
writeJson('out/U1/conformance.json', evidence);
process.exitCode = result.status ?? 1;
