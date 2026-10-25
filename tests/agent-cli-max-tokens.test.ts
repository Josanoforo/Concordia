import test from 'node:test';
import assert from 'node:assert/strict';
import { limitsFromBounds, RunBudget, setTokenCapOverride } from '../src/agent/run-budget.ts';
import { usageFor } from '../src/agent/cli-help.ts';

test('--max-tokens overrides the manifest cap, is labeled with its source, and clears', () => {
  try {
    const base = new RunBudget(limitsFromBounds({ maxTokensPerRun: 15000 }));
    assert.deepEqual(base.snapshot().tokenCap, { value: 15000, source: 'manifest' });
    setTokenCapOverride(50000);
    const over = new RunBudget(limitsFromBounds({ maxTokensPerRun: 15000 }));
    assert.deepEqual(over.snapshot().tokenCap, { value: 50000, source: 'flag' });
    assert.equal(over.canAfford(49000), true, 'the per-call pre-estimate still applies against the new cap');
    assert.equal(over.canAfford(50001), false);
  } finally { setTokenCapOverride(undefined); }
  assert.equal(new RunBudget(limitsFromBounds({ maxTokensPerRun: 15000 })).snapshot().tokenCap.source, 'manifest');
});

test('--max-tokens outside 1000..200000 or non-integer is refused', () => {
  for (const bad of [999, 200001, 1.5, NaN, 0, -5]) assert.throws(() => setTokenCapOverride(bad), /RUN_TOKEN_CAP_INVALID/);
  setTokenCapOverride(1000); setTokenCapOverride(200000); setTokenCapOverride(undefined);
});

test('the agent help documents --max-tokens and the recommended live value', () => {
  assert.match(usageFor(['node', 'cli', 'agent'])!, /--max-tokens[\s\S]*50000/);
});
