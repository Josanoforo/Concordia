import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { evaluateRelation } from '../src/relations/decision.ts';
import { relationPolicyFromConfig } from '../src/relations/policy.ts';
import { legacyRelationContract } from '../src/relations/legacy.ts';
import { resolveUniverseManifest, validateUniverseConfig } from '../src/registry/universes.ts';

/** F-04: the project owner approved the U1 review on 2026-10-25 ("Aprobado"). It is governance metadata; no stored verdict moves. */
const APPROVED = { yellow_pu_taxi_zones: 'nyc-tlc-taxi-zone-id-v1', yellow_do_taxi_zones: 'nyc-tlc-taxi-zone-id-v1', hvv_pu_taxi_zones: 'nyc-tlc-taxi-zone-id-v1', trips_pickup_zones: 'ny-taxi-ops-zone-id-v1' } as Record<string, string>;
const dir = path.join(ROOT, 'tests/fixtures/agent-runs/agent-u1-live-01');

test('U1 config declares the approved review state and identifier spaces, with the authorization recorded; green_pu and the trap stay undeclared', () => {
  const cfg = universeConfig('U1');
  assert.deepEqual(validateUniverseConfig(resolveUniverseManifest('U1')!, cfg), []);
  for (const relation of cfg.relations) {
    if (APPROVED[relation.id]) {
      assert.equal(relation.kind, 'FOREIGN_KEY'); assert.equal(relation.reviewState, 'REVIEWED'); assert.equal(relation.identifierSpace, APPROVED[relation.id]);
      assert.equal(relation.normalizationVersion, 'integer-v1'); assert.equal(relation.normalizationLossless, true); assert.equal(relation.normalizationAdapterCapability, 'integer');
      assert.deepEqual([relation.reviewAuthorization.approver, relation.reviewAuthorization.approvedAt, relation.reviewAuthorization.quote], ['project-owner', '2026-10-25', 'Aprobado']);
    } else for (const field of ['kind', 'reviewState', 'identifierSpace', 'reviewAuthorization']) assert.equal(relation[field], undefined, `${relation.id}.${field}`);
  }
  assert.notEqual(APPROVED.trips_pickup_zones, APPROVED.yellow_pu_taxi_zones, 'trips has its own space, distinct from the TLC one');
  const contract = legacyRelationContract(cfg.relations.find((r: any) => r.id === 'trips_pickup_zones'), 'U1', '2.0', 'integer', 3);
  assert.deepEqual([contract.reviewState, contract.kind, contract.identifierSpace], ['REVIEWED', 'FOREIGN_KEY', { state: 'KNOWN', value: 'ny-taxi-ops-zone-id-v1' }]);
});

test('no verdict of the stored live run agent-u1-live-01 changes, with the stored contract or with the newly approved governance', () => {
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'engine-run.json'), 'utf8')), artifacts = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts.json'), 'utf8'));
  const policy = relationPolicyFromConfig(readJson('config/thresholds.json')), cfg = universeConfig('U1');
  assert.equal(run.decisions.length, 6); assert.ok(run.decisions.every((item: any) => item.verdict === 'INDETERMINADA'));
  for (const probe of artifacts.probes) {
    const stored = probe.evidence.relationContract, evidence = probe.evidence.typedEvidence;
    const before = evaluateRelation(stored, [evidence], policy);
    const governed = APPROVED[probe.relationId] ? { ...stored, kind: 'FOREIGN_KEY', reviewState: 'REVIEWED', identifierSpace: { state: 'KNOWN', value: APPROVED[probe.relationId] },
      normalization: stored.normalization.map((step: any) => ({ ...step, version: { state: 'KNOWN', value: 'integer-v1' }, lossless: { state: 'KNOWN', value: true }, adapterCapability: { state: 'KNOWN', value: 'integer' } })) } : stored;
    const after = evaluateRelation(governed, [evidence], policy);
    assert.equal(before.verdict, 'INDETERMINADA', probe.relationId); assert.equal(after.verdict, before.verdict, probe.relationId);
    assert.equal(after.verdict, run.decisions.find((item: any) => item.relationId === probe.relationId).verdict);
  }
  assert.ok(cfg.relations.length === artifacts.probes.length);
});
