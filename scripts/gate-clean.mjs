// `npm run gate:clean`: the project gate on a clean copy of HEAD, so other people's work in progress never decides the result.
// Steps: git archive HEAD -> temp folder (junction to node_modules, own TEMP, CI no-services guard), then typecheck, test and eval-agent there;
// check-secrets runs on the real checkout. Never touches .concordia or the budget ledger. Prints one summary line; exit 1 on any failure.
// Flags: --keep (leave the temp copy), --steps typecheck,test,eval-agent,check-secrets (default: all).
process.noDeprecation = true;
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALL_STEPS = ['typecheck', 'test', 'eval-agent', 'check-secrets'];

/** Counts from node:test's summary lines ("ℹ pass 12"). */
export function parseTestSummary(output) {
  const pick = name => { const match = new RegExp(`^.?\\s*${name} (\\d+)\\s*$`, 'm').exec(output); return match ? Number(match[1]) : null; };
  return { pass: pick('pass'), fail: pick('fail'), skipped: pick('skipped') };
}

export function formatSummary(sha, results, seconds) {
  const ok = Object.values(results).every(item => item.ok);
  const parts = Object.entries(results).map(([name, item]) => `${name}=${item.ok ? 'ok' : 'FAIL'}${item.detail ? `(${item.detail})` : ''}`);
  return `GATE_CLEAN ${ok ? 'PASS' : 'FAIL'} head=${sha} ${parts.join(' ')} ${seconds}s`;
}

function run(command, args, options) {
  return spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' && command === 'npm', maxBuffer: 256 * 1024 * 1024, ...options });
}

export function gateClean(argv = process.argv.slice(2)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const keep = argv.includes('--keep');
  const stepsArg = argv.indexOf('--steps') >= 0 ? argv[argv.indexOf('--steps') + 1] : undefined;
  const steps = stepsArg ? stepsArg.split(',').filter(step => ALL_STEPS.includes(step)) : ALL_STEPS;
  const started = Date.now();
  const sha = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).stdout.trim() || 'unknown';
  // Own TEMP, outside the repo: no spaces issue for NODE_OPTIONS and nothing lands in .concordia.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'concordia-gate-'));
  const copy = path.join(work, 'repo'), tar = path.join(work, 'head.tar'), guard = path.join(work, 'ci-no-services.cjs');
  const results = {};
  try {
    fs.mkdirSync(copy); // GNU tar reads "C:..." as host:path, so tar runs with relative names inside the temp folder
    if (run('git', ['archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: root }).status !== 0 || run('tar', ['-xf', 'head.tar', '-C', 'repo'], { cwd: work }).status !== 0) throw new Error('GATE_CLEAN_ARCHIVE_FAILED');
    // A git archive has no .git: stamp the full SHA so the engine (codeShaOf) can still pin it in the post-COMA journal.
    const fullSha = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
    if (fullSha) fs.writeFileSync(path.join(copy, '.code-sha'), fullSha + '\n');
    fs.copyFileSync(path.join(root, 'scripts', 'ci-no-services.cjs'), guard);
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'junction');
    const env = { ...process.env, TEMP: work, TMP: work, TMPDIR: work, NODE_OPTIONS: `--require ${guard.split(path.sep).join('/')}` };
    const npm = script => run('npm', ['run', script], { cwd: copy, env });
    for (const step of steps) {
      if (step === 'typecheck') { const out = npm('typecheck'); results[step] = { ok: out.status === 0 }; }
      else if (step === 'test') { const out = npm('test'), counts = parseTestSummary(out.stdout + out.stderr); results[step] = { ok: out.status === 0 && counts.fail === 0, detail: `${counts.pass ?? '?'} pass, ${counts.fail ?? '?'} fail` };
        // Name what failed so a red gate is actionable without rerunning by hand (stderr; the summary line stays one line).
        if (!results[step].ok) for (const line of [...new Set((out.stdout + out.stderr).split(/\r?\n/).filter(item => item.startsWith('✖')))].slice(0, 8)) console.error(line); }
      else if (step === 'eval-agent') { const out = npm('eval-agent'); results[step] = { ok: out.status === 0 }; }
      else if (step === 'check-secrets') { const out = run(process.execPath, ['scripts/check-secrets.mjs'], { cwd: root }); results[step] = { ok: out.status === 0 }; }
    }
  } catch (error) {
    results.setup = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!keep) {
      // Remove the junction itself first: it must never be followed into the real node_modules.
      try { fs.rmdirSync(path.join(copy, 'node_modules')); } catch { /* not created */ }
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  const line = formatSummary(sha, results, Math.round((Date.now() - started) / 1000));
  return { line, ok: Object.values(results).every(item => item.ok) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { line, ok } = gateClean();
  console.log(line);
  process.exitCode = ok ? 0 : 1;
}
