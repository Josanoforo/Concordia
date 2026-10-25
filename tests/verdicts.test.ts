import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/probe/verdicts.ts';
import { compareLabels } from '../src/probe/index.ts';
test('legacy verdict consumer rejects untyped metrics instead of applying a second policy', () => {
  const base: any = { status: 'PASS', overlap: { matched: 8, probed: 10, ratio: 0.8 }, typeCompat: { castable: true }, alerts: [] };
  assert.throws(() => classify(base, {}), /TYPED_RELATION_EVIDENCE_REQUIRED/);
});
test('labels compare actual same-key names and boroughs despite textual .0', () => {
  const result = compareLabels([['1.0','Newark','EWR']], [['1','West','Other']], ['id','name','borough'], ['key','label','borough'], { db:'x',table:'a',column:'id' }, { db:'x',table:'b',column:'key' }, ['name','borough'], ['label','borough']);
  assert.equal(result?.ratio, 0); assert.equal(result?.compared, 1);
});
