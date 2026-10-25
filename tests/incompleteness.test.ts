import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/runtime.ts';
import { evaluateRelation } from '../src/relations/decision.ts';
import { classifyIncompleteness, incompletenessOfDecision } from '../src/relations/incompleteness.ts';
import type { EvidenceBundle } from '../src/contracts/types.ts';

// Historical LIVE run (sanitized fixtures from 16dcd6c): every probe carries its contract, typed evidence and recorded decision.
const artifacts = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'agent-runs', 'agent-u1-live-01', 'artifacts.json'), 'utf8'));
const probes = artifacts.probes.map((p: any) => ({ id: p.relationId, contract: p.evidence.relationContract, bundle: p.evidence.typedEvidence as EvidenceBundle, recorded: p.evidence.decision }));
const policy = { policyVersion: '1.0', minimumDistinctKeys: 1 };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test('L-02: the historical run keeps its INDETERMINADA verdict and reasonCode, and now types the reason as an expected sample cap', () => {
  assert.equal(probes.length, 6);
  for (const probe of probes) {
    const decision = evaluateRelation(probe.contract, [probe.bundle], policy);
    assert.equal(decision.verdict, 'INDETERMINADA');
    assert.deepEqual(decision.reasonCodes, ['evidence_incomplete_or_truncated']);
    assert.equal(decision.verdict, probe.recorded.verdict);
    assert.deepEqual(decision.reasonCodes, probe.recorded.reasonCodes);
    assert.equal('incompleteness' in decision, false, 'the Decision shape (and its hash) is unchanged');
    const typed = incompletenessOfDecision(decision, probe.contract, [probe.bundle]);
    assert.equal(typed?.kind, 'EXPECTED_SAMPLE_CAP', probe.id);
    assert.ok(typed!.detail.cappedEndpoints.length >= 1);
    assert.ok(typed!.detail.cappedEndpoints.every(endpoint => endpoint.limit === 50 && endpoint.rows >= 50));
    assert.deepEqual(typed!.detail.failedObservations, []);
    assert.deepEqual(typed!.detail.missingEndpoints, []);
  }
});

test('L-02: a failed read is EXECUTION_FAILURE with the same verdict and reasonCode', () => {
  const probe = probes[0], bundle = clone(probe.bundle);
  const key = bundle.observations.find((o: any) => o.type === 'KEY_MEMBERSHIP')!;
  key.transportStatus = 'ERROR'; key.truncated = 'UNKNOWN'; bundle.completeness = 'TRANSPORT_FAILED';
  const decision = evaluateRelation(probe.contract, [bundle], policy);
  assert.deepEqual({ v: decision.verdict, r: decision.reasonCodes }, { v: 'INDETERMINADA', r: ['evidence_incomplete_or_truncated'] });
  const typed = incompletenessOfDecision(decision, probe.contract, [bundle]);
  assert.equal(typed?.kind, 'EXECUTION_FAILURE');
  assert.deepEqual(typed!.detail.failedObservations.map(o => o.transportStatus), ['ERROR']);
});

test('L-02: a missing endpoint observation is ENDPOINT_MISSING, and failure outranks a cap', () => {
  const probe = probes[0], bundle = clone(probe.bundle);
  bundle.observations = bundle.observations.filter((o: any) => !(o.type === 'KEY_MEMBERSHIP' && o.sourceRef === probe.contract.to.sourceId));
  const decision = evaluateRelation(probe.contract, [bundle], policy);
  assert.deepEqual(decision.reasonCodes, ['evidence_incomplete_or_truncated']);
  const typed = incompletenessOfDecision(decision, probe.contract, [bundle]);
  assert.equal(typed?.kind, 'ENDPOINT_MISSING');
  assert.deepEqual(typed!.detail.missingEndpoints, [probe.contract.to.sourceId]);
});

test('L-02: complete evidence and other reason codes are not typed', () => {
  const probe = probes[0], bundle = clone(probe.bundle);
  for (const o of bundle.observations as any[]) { o.truncated = false; o.transportStatus = 'OK'; }
  bundle.completeness = 'COMPLETE_FOR_SCOPE';
  assert.equal(classifyIncompleteness(probe.contract, [bundle]), undefined);
  const complete = evaluateRelation(probe.contract, [bundle], policy);
  assert.equal(incompletenessOfDecision(complete, probe.contract, [bundle]), undefined);
  const missing = evaluateRelation(probe.contract, [], policy);
  assert.deepEqual(missing.reasonCodes, ['evidence_missing']);
  assert.equal(incompletenessOfDecision(missing, probe.contract, []), undefined);
});
