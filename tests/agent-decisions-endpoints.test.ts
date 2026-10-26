import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** PX-X2-9: engine-run.decisions carry each relation's endpoints, probed or reused from memory, so an evaluation does not need artifacts.json. */
const made: string[] = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const cfg = universeConfig('AGENTFX');
const run = (runId: string, dir: string) => runAgent('AGENTFX', runId, { client: fixtureClient(cfg, structuredClone(agentFixtures().find(i => i.alias === 'AGENTFX')!).tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, memory: { dir } }) as Promise<any>;
const endpoint = (e: any) => ({ db: e.db, table: e.table, column: e.column });

test('PX-X2-9: every decision, probed or REUSED_FROM_MEMORY, names its from/to as configured', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-decisions-')), 'LOCAL-SYNTHETIC'); made.push(path.dirname(dir));
  const first = await run('agent-endpoints-1', dir), second = await run('agent-endpoints-2', dir);
  assert.ok(second.decisions.some((d: any) => d.reasonCodes.includes('REUSED_FROM_MEMORY')), 'the second run reuses something');
  for (const report of [first, second]) {
    assert.ok(report.decisions.length > 0);
    for (const decision of report.decisions) {
      const relation = cfg.relations.find((r: any) => r.id === decision.relationId)!;
      assert.deepEqual([endpoint(decision.from), endpoint(decision.to)], [endpoint(relation.from), endpoint(relation.to)], decision.relationId);
    }
  }
});
