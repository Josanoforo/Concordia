import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderScript, runDemoTpcds } from '../src/agent/demo-tpcds.ts';
import { ROOT } from '../src/runtime.ts';

test('demo-tpcds smoke: runs the whole sequence offline and writes a shot script with true labels, never LIVE', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-tpcds-'));
  const prefix = 'agent-demo-tpcds-test';
  try {
    const result = await runDemoTpcds({ outDir, runPrefix: prefix });
    const script = fs.readFileSync(result.scriptPath, 'utf8'), summary = JSON.parse(fs.readFileSync(result.summaryPath, 'utf8'));
    assert.equal(summary.live, false);
    assert.deepEqual(result.acts.map(act => [act.id, act.status]), [['ACT1_BLIND_DISCOVERY', 'DONE'], ['ACT2_VERDICTS', 'DONE'], ['ACT3_MEMORY_GTFS', 'DONE'], ['TPCDS_ACT3', 'PENDING'], ['ACT4_EXPORTS', 'DONE']]);
    for (const act of result.acts) for (const shot of act.shots) { assert.equal(shot.mode, 'LOCAL'); assert.equal(shot.origin, 'SYNTHETIC'); assert.ok(shot.command.startsWith('concordia ')); assert.ok(shot.evidence.length > 0); }
    assert.doesNotMatch(script, /LIVE \//);
    assert.match(script, /PENDIENTE/);
    assert.match(script, /GTFSAGENT/);
    const memory: any = result.facts.memory;
    assert.ok(memory.reusedRelations >= 1, 'pass 2 reuses the relation recorded by pass 1');
    assert.equal(memory.pass2Probes, 0);
    for (const act of result.acts) for (const shot of act.shots) for (const file of shot.evidence) assert.ok(fs.existsSync(path.join(ROOT, file)), `evidence exists: ${file}`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, '.concordia', 'demo-tpcds'), { recursive: true, force: true });
    for (const id of ['1-blind', '3-gtfs-pass1', '3-gtfs-pass2']) fs.rmSync(path.join(ROOT, '.concordia', 'agent-runs', `${prefix}-${id}`), { recursive: true, force: true });
  }
});

test('demo-tpcds act 3 with the human review overlay: SOSTENIDA, origin-sealed isolated memory, REUSED on pass 2, negative control, deferred listed, human-contract wording', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-tpcds-review-')), prefix = 'agent-demo-tpcds-review-test';
  try {
    const result = await runDemoTpcds({ outDir, runPrefix: prefix, reviewFile: 'universes/reviews/TPCDS.review.json' });
    const script = fs.readFileSync(result.scriptPath, 'utf8'), review: any = result.facts.review;
    assert.deepEqual(result.acts.map(act => [act.id, act.status]), [['ACT1_BLIND_DISCOVERY', 'DONE'], ['ACT2_VERDICTS', 'DONE'], ['ACT3_TPCDS_REVIEW', 'DONE'], ['ACT4_EXPORTS', 'DONE']]);
    assert.equal(review.passA.decisions, 25); assert.equal(review.passA.verdicts, 'SOSTENIDA=25');
    assert.equal(review.passB.reused, 25); assert.equal(review.passB.probes, 0);
    assert.equal(review.originSealed, true);
    assert.equal(review.negativeControl.withDecision, 0); assert.equal(review.negativeControl.candidatesPending, review.negativeControl.candidatesFound);
    assert.equal(review.deferred.length, 3);
    assert.match(script, /contrato semantico aprobado por el humano/); assert.match(script, /el agente no las descubrio ni las valido/);
    assert.doesNotMatch(script, /el agente (descubrio|valido) las/); assert.doesNotMatch(script, /LIVE \//);
    for (const id of review.deferred.map((item: any) => item.id)) assert.ok(script.includes(id), id);
    for (const act of result.acts) for (const shot of act.shots) { assert.equal(shot.mode, 'LOCAL'); assert.equal(shot.origin, 'SYNTHETIC'); }
    for (const act of result.acts) for (const shot of act.shots) for (const file of shot.evidence) assert.ok(fs.existsSync(path.join(ROOT, file)), `evidence exists: ${file}`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, '.concordia', 'demo-tpcds'), { recursive: true, force: true });
    for (const id of ['1-blind', '3-gtfs-pass1', '3-gtfs-pass2', '3-tpcds-review-pass1', '3-tpcds-review-pass2']) fs.rmSync(path.join(ROOT, '.concordia', 'agent-runs', `${prefix}-${id}`), { recursive: true, force: true });
  }
});

test('renderScript labels a pending act and keeps the extension point visible', () => {
  const text = renderScript([{ id: 'X', title: 'Acto futuro', status: 'PENDING', note: 'no existe', shots: [] }]);
  assert.match(text, /## Acto futuro \(PENDIENTE\)/);
});
