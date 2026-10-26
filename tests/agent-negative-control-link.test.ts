import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { withReviewOverlay } from '../src/agent/review-overlay.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { ROOT } from '../src/runtime.ts';

/** Act 3 negative control link: validated before the first SQL, copied into the run, recorded with its hash. SYNTHETIC overlay and SYNTHETIC artifact only. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const SRC = 'agent-nc-src-test', RUNS = path.join(ROOT, '.concordia', 'agent-runs');
const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'TPCDS')!);
const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'universes', 'reviews', 'TPCDS.review.json'), 'utf8'));
const overlay = () => ({ ...structuredClone(real), origin: 'SYNTHETIC_TEST', approval: { approver: 'SYNTHETIC test approver', approvedAt: '2026-10-26T00:00:00Z', quote: 'SYNTHETIC TEST QUOTE: this is not a human approval', session: 'synthetic-test-session', package: 'synthetic/package.md' },
  relations: structuredClone(real.relations).slice(0, 3), deferred: [] });
const contractId = overlay().relations[0].id;
const control = (over: Record<string, unknown> = {}) => ({ kind: 'ACT3_NEGATIVE_CONTROL', universe: 'TPCDS', label: 'SYNTHETIC decoys', decoys: ['decoy.a__decoy.b'], ...over });
const writeSource = (value: unknown, raw?: string) => { fs.mkdirSync(path.join(RUNS, SRC), { recursive: true }); const file = path.join(RUNS, SRC, 'negative-control.json'); fs.writeFileSync(file, raw ?? JSON.stringify(value)); return file; };
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
const cleanups: string[] = [path.join(RUNS, SRC)];
test.after(() => { for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true }); });

function run(runId: string, negativeControl: string | undefined, withReview = true, persist = true) {
  const f = fixture(), deps = { ...offlineAgentDeps('TPCDS', f, new Script([...f.chooserScript])), persist, critic: false, ...(negativeControl === undefined ? {} : { negativeControl }) };
  cleanups.push(path.join(RUNS, runId));
  const go = () => runAgent('TPCDS', runId, deps as any) as Promise<any>;
  return withReview ? withReviewOverlay('TPCDS', { overlay: overlay() }, go, { allowSynthetic: true }) : go();
}

test('negative control: a valid artifact is copied into the run and recorded with source run, sha256 and label', async () => {
  const file = writeSource(control());
  const report = await run('agent-nc-run-ok', rel(file));
  const copy = path.join(RUNS, 'agent-nc-run-ok', 'negative-control.json');
  assert.ok(fs.existsSync(copy));
  const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.deepEqual(report.reviewOverlay.negativeControl, { artifact: 'negative-control.json', sourceRun: SRC, sha256: sha, label: 'SYNTHETIC decoys' });
  assert.equal(createHash('sha256').update(fs.readFileSync(copy)).digest('hex'), sha, 'the copy is byte-identical');
  const persisted = JSON.parse(fs.readFileSync(path.join(RUNS, 'agent-nc-run-ok', 'engine-run.json'), 'utf8'));
  assert.equal(persisted.reviewOverlay.negativeControl.sha256, sha);
});

test('negative control: no option keeps artifact null as before; the option without a review is refused', async () => {
  const none = await run('agent-nc-run-none', undefined, true, false);
  assert.deepEqual(none.reviewOverlay.negativeControl, { artifact: null });
  const file = writeSource(control());
  await assert.rejects(() => run('agent-nc-run-noreview', rel(file), false, false), /NEGATIVE_CONTROL_REQUIRES_REVIEW/);
});

test('negative control: refusals happen before the first SQL and before the run folder exists', async () => {
  const f = fixture();
  const cases: [string, unknown, RegExp, string?][] = [
    ['kind', control({ kind: 'OTHER' }), /NEGATIVE_CONTROL_INVALID/],
    ['universe', control({ universe: 'U2' }), /NEGATIVE_CONTROL_INVALID/],
    ['decoys not an array', control({ decoys: 'x' }), /NEGATIVE_CONTROL_INVALID/],
    ['decoy by id is a contract relation', control({ decoys: [contractId] }), /NEGATIVE_CONTROL_DECOY_IN_CONTRACT/],
    ['decoy by object id', control({ decoys: [{ id: contractId }] }), /NEGATIVE_CONTROL_DECOY_IN_CONTRACT/],
    ['decoy by endpoints (reversed)', control({ decoys: [{ id: 'other', from: overlay().relations[0].to, to: overlay().relations[0].from }] }), /NEGATIVE_CONTROL_DECOY_IN_CONTRACT/],
    ['not JSON', null, /NEGATIVE_CONTROL_INVALID/, 'not json'],
  ];
  for (const [name, value, expected, raw] of cases) {
    const file = writeSource(value, raw); let sql = 0;
    const deps = { ...offlineAgentDeps('TPCDS', f, new Script([...f.chooserScript])), persist: true, critic: false, negativeControl: rel(file) } as any;
    const counted = { ...deps.client, describe: (...a: any[]) => { sql++; return deps.client.describe(...a); }, runSql: (...a: any[]) => { sql++; return deps.client.runSql(...a); } };
    const runId = 'agent-nc-run-bad'; cleanups.push(path.join(RUNS, runId));
    await assert.rejects(() => withReviewOverlay('TPCDS', { overlay: overlay() }, () => runAgent('TPCDS', runId, { ...deps, client: counted }) as Promise<any>, { allowSynthetic: true }), expected, name);
    assert.equal(sql, 0, `${name}: no SQL ran`);
    assert.equal(fs.existsSync(path.join(RUNS, runId)), false, `${name}: no run folder`);
  }
});

test('negative control: the path must be .concordia/agent-runs/<run>/negative-control.json', async () => {
  writeSource(control());
  for (const bad of ['universes/reviews/TPCDS.review.json', '.concordia/agent-runs/agent-nc-src-test/other.json', '../outside/negative-control.json', '.concordia/agent-runs/not-an-agent-run/negative-control.json', '.concordia/agent-runs/agent-missing-test/negative-control.json'])
    await assert.rejects(() => run('agent-nc-run-path', bad, true, false), /NEGATIVE_CONTROL_PATH_INVALID/, bad);
});
