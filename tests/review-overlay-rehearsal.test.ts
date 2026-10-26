import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { withReviewOverlay } from '../src/agent/review-overlay.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { ROOT } from '../src/runtime.ts';

/** Offline rehearsal of act 3 on the TPCDS synthetic fixture with the REAL human-approved overlay and an isolated temp memory: never the real .concordia memory. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const file = path.join(ROOT, 'universes', 'reviews', 'TPCDS.review.json');
test('pass 1 with the reviewed contracts gives SOSTENIDA and an origin-sealed write in the isolated memory; pass 2 reuses it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpcds-review-rehearsal-')), memory = path.join(dir, 'LOCAL-SYNTHETIC');
  try {
    const f = structuredClone(agentFixtures().find(item => item.alias === 'TPCDS')!);
    const run = (id: string) => withReviewOverlay('TPCDS', { file }, () => runAgent('TPCDS', id, { ...offlineAgentDeps('TPCDS', f, new Script([...f.chooserScript])), persist: false, critic: false, memory: { dir: memory } })) as Promise<any>;
    const first = await run('agent-tpcds-review-rehearsal-1'), second = await run('agent-tpcds-review-rehearsal-2');
    assert.equal(first.decisions.length, 25);
    assert.deepEqual([...new Set(first.decisions.map((item: any) => item.verdict))], ['SOSTENIDA']);
    assert.ok(first.decisions.every((item: any) => item.reasonCodes[0] === 'bounded_sample_key_membership'));
    assert.equal(first.memory.status, 'RECORDED');
    assert.ok(fs.existsSync(path.join(memory, 'origin-seal.json')), 'the scope is origin-sealed');
    assert.equal(second.decisions.length, 25);
    assert.ok(second.decisions.every((item: any) => item.verdict === 'SOSTENIDA' && item.reasonCodes.includes('REUSED_FROM_MEMORY')));
    assert.ok(path.resolve(memory).startsWith(path.resolve(os.tmpdir())) && !memory.startsWith(path.join(ROOT, '.concordia', 'agent-memory')));
    assert.ok(first.decisions.every((item: any) => item.reviewAuthorization === undefined || item.reviewAuthorization.overlayOrigin === 'HUMAN_REVIEW'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
