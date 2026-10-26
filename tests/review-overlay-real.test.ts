import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readReviewOverlayFile, validateReviewOverlay, withReviewOverlay } from '../src/agent/review-overlay.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { ROOT } from '../src/runtime.ts';

/** The REAL TPCDS overlay is a human-approved semantic contract (F-04); it is never discovery or validation by the agent. */
const file = path.join(ROOT, 'universes', 'reviews', 'TPCDS.review.json');
test('the real TPCDS overlay is a HUMAN_REVIEW with a recorded approval, 25 relations, identifierSpace per entity and the 3 deferred ones kept out', () => {
  const { overlay } = readReviewOverlayFile(file) as { overlay: any };
  assert.deepEqual(validateReviewOverlay(overlay, 'TPCDS'), [], 'valid without allowSynthetic');
  assert.equal(overlay.origin, 'HUMAN_REVIEW'); assert.equal(overlay.labelling, 'contrato semántico aprobado por el humano');
  assert.match(overlay.approval.quote, /YES for the 25 without M12/); assert.equal(overlay.relations.length, 25);
  const ids = new Set(overlay.relations.map((r: any) => r.id)); assert.equal(ids.size, 25);
  assert.equal(overlay.deferred.length, 3); for (const d of overlay.deferred) assert.ok(!ids.has(d.id), d.id);
  const spaces = new Set(overlay.relations.map((r: any) => r.identifierSpace)); assert.equal(spaces.size, 12);
  for (const r of overlay.relations) assert.equal(r.identifierSpace, `tpcds-${r.to.table.replace(/_/g, '-')}-sk-v1`, r.id);
});
test('applying it is explicit and scoped; the universe stays blind outside the call', async () => {
  assert.deepEqual(universeConfig('TPCDS').relations, []);
  let inside = 0; await withReviewOverlay('TPCDS', { file }, async () => { inside = universeConfig('TPCDS').relations.length; });
  assert.equal(inside, 25); assert.deepEqual(universeConfig('TPCDS').relations, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'universes', 'TPCDS.json'), 'utf8')).relations, []);
});
