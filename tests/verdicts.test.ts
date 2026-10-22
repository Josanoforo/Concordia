import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/probe/verdicts.ts';
import { compareLabels } from '../src/probe/index.ts';
import { readJson } from '../src/runtime.ts';
test('verdict thresholds and quality gates do not depend on evaluation case names', () => {
  const thresholds = readJson('config/thresholds.json');
  const base: any = { status: 'PASS', overlap: { matched: 8, probed: 10, ratio: 0.8 }, typeCompat: { castable: true }, alerts: [] };
  assert.equal(classify(base, thresholds).verdict, 'SOSTENIDA');
  assert.equal(classify({ ...base, overlap: { matched: 7, probed: 10, ratio: 0.7 } }, thresholds).verdict, 'INDETERMINADA');
  assert.equal(classify({ ...base, labelAgreement: { ratio: 0.49 } }, thresholds).verdict, 'ENGAÑOSA');
  assert.equal(classify({ ...base, labelAgreement: { ratio: 0.5 } }, thresholds).verdict, 'INDETERMINADA');
  assert.equal(classify({ ...base, alerts: ['quality'] }, thresholds).verdict, 'INDETERMINADA');
  assert.equal(classify({ ...base, overlap: { matched: 1, probed: 1, ratio: 1 } }, thresholds).verdict, 'INDETERMINADA');
});
test('labels compare actual same-key names and boroughs despite textual .0', () => {
  const result = compareLabels([['1.0','Newark','EWR']], [['1','West','Other']], ['id','name','borough'], ['key','label','borough'], { db:'x',table:'a',column:'id' }, { db:'x',table:'b',column:'key' }, ['name','borough'], ['label','borough']);
  assert.equal(result?.ratio, 0); assert.equal(result?.compared, 1);
});
