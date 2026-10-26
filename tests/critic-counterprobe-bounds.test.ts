import test from 'node:test';
import assert from 'node:assert/strict';
import { runTypedCounterprobe } from '../src/critic/adversarial.ts';
import { assertRunSqlAllowed } from '../src/clients/zetaris.ts';
import { legacyRelationContract } from '../src/relations/legacy.ts';
import type { EvidenceBundle, RelationContract } from '../src/contracts/types.ts';

/**
 * R10 live, observation O2: the critic confirmed 0 of 92. 71 came back counterevidence_transport_or_scope_incomplete (transportStatus TRUNCATED, matchedKeys 0) on
 * relations like store_returns.sr_customer_sk → customer.c_customer_sk. Offline reproduction over a live-shaped table: a big fact table whose bounded read fills its
 * LIMIT, a nullable foreign key, and a unique target that holds every selected key.
 */
const known = <T>(value: T) => ({ state: 'KNOWN' as const, value });
const LIMIT = 50, checkedAt = '2026-10-25T10:00:00.000Z';
const policy = { policyVersion: '1.0', minimumDistinctKeys: 1, minimumOverlapRatio: 1 };

function contract(): RelationContract {
  const value = legacyRelationContract({ id: 'child-parent', from: { db: 'fixture_db', table: 'child', column: 'key' }, to: { db: 'fixture_db', table: 'parent', column: 'key' }, kind: 'FOREIGN_KEY', identifierSpace: 'customer-key',
    normalizationVersion: '1', normalizationLossless: true, normalizationAdapterCapability: 'exact', reviewState: 'REVIEWED' }, 'fixture-universe', '1.0', 'text', 1);
  value.from.orderedColumns = ['key']; value.to.orderedColumns = ['key'];
  value.from.namespace = known('ns'); value.to.namespace = known('ns'); value.identifierSpace = known('customer-key'); value.reviewState = 'REVIEWED';
  value.normalization = [{ componentIndex: 0, operation: known('text'), version: known('1'), lossless: known(true), adapterCapability: known('exact-text') }];
  return value;
}
function bundle(c: RelationContract, from: unknown[][], to: unknown[][]): EvidenceBundle {
  const observation = (endpoint: RelationContract['from'], rows: unknown[][], side: string) => ({ observationId: `base:${side}`, type: 'KEY_MEMBERSHIP' as const, sourceRef: endpoint.sourceId, adapterId: 'synthetic', requestId: known(`base:${side}`),
    observedAt: known(checkedAt), checkedAt, nativeVersion: { state: 'UNKNOWN' as const }, fingerprint: { state: 'UNKNOWN' as const }, projection: ['key'], filters: [], limit: LIMIT, measuredTuples: rows, nullCount: 0, duplicateCount: 'UNKNOWN' as const,
    truncated: false as const, transportStatus: 'OK' as const, protectedPayloadRef: { state: 'UNKNOWN' as const } });
  return { schemaVersion: 1, evidenceBundleId: 'evidence:base', relationRef: c.id, contractVersion: c.contractVersion, sourceRefs: [c.from.sourceId, c.to.sourceId].sort(),
    runRef: { runId: 'base', startedAt: { state: 'UNKNOWN' }, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', configFingerprint: { state: 'UNKNOWN' } },
    observations: [observation(c.from, from, 'from'), observation(c.to, to, 'to')], scope: known('baseline'), completeness: 'COMPLETE_FOR_SCOPE', capturedAt: checkedAt };
}
const config = { database: 'fixture_db', tables: { child: { columns: [{ name: 'key', type: 'int' }, { name: 'other', type: 'int' }] }, parent: { columns: [{ name: 'key', type: 'int' }] } } };
const inventory = { tables: { child: { labels: [] }, parent: { labels: [] } } };

/** The source table: `fringe` rows after the baseline. The client answers through the REAL read guard. */
function setup(options: { sourceRows: unknown[][]; targetRows: (keys: number[]) => unknown[][] }) {
  const c = contract(), base = bundle(c, [[1], [2]], [[1], [2]]), sql: string[] = [];
  const client = { async runSql(text: string, limit = 20) {
    assertRunSqlAllowed(text); sql.push(text);
    if (/FROM \(SELECT .* FROM fixture_db\.child\)/.test(text) || text.includes('child')) {
      return { sql: text, requestId: 'source-req', queryId: 'source-q', rows: options.sourceRows.slice(0, limit), durationMs: 0, utc: checkedAt };
    }
    const keys = [...text.matchAll(/'?(\d+)'?(?=[,)])/g)].map(match => Number(match[1]));
    return { sql: text, requestId: 'target-req', queryId: 'target-q', rows: options.targetRows(keys).slice(0, limit), durationMs: 0, utc: checkedAt };
  } };
  const run = () => runTypedCounterprobe({ contract: c, baseEvidence: base, policy, config, inventory, thresholds: { criticProbeLimit: LIMIT }, client: client as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', now: checkedAt, runId: 'critic-run:child-parent' });
  return { run, sql };
}
const fringe = (count: number, perKey = 1) => Array.from({ length: count * perKey }, (_, index) => [1000 + Math.floor(index / perKey), index]);
const inTarget = (keys: number[]) => keys.filter(key => key >= 1000).map(key => [key]);

test('O2: a big fact table (the bounded read fills its LIMIT) and a unique target holding every key is CONFIRMED, not TRUNCATED; matchedKeys is measured', async () => {
  const { run, sql } = setup({ sourceRows: fringe(80), targetRows: inTarget });
  const outcome = await run();
  assert.equal(outcome.status, 'CONFIRMED', outcome.reason); assert.equal(outcome.classification, 'NOVEL_SUPPORT');
  assert.equal(outcome.evidence?.completeness, 'COMPLETE_FOR_SCOPE');
  const metrics = (outcome.counterprobe as any).metrics;
  assert.equal(metrics.sourceReadFilled, true, 'the read did fill its limit (kept as a diagnostic, not as truncation)');
  assert.equal(metrics.fringeKeys, LIMIT - 1); assert.equal(metrics.matchedKeys, LIMIT - 1);
  assert.equal(sql.length, 2);
  const targetKeys = [...sql[1].matchAll(/IN \(([^)]*)\)/g)][0][1].split(',');
  assert.equal(targetKeys.length, LIMIT - 1, 'the target lookup never asks for as many keys as its own limit');
  const sourceObservation = outcome.evidence!.observations.find(observation => observation.sourceRef === contract().from.sourceId)!;
  assert.equal(sourceObservation.truncated, false); assert.ok(sourceObservation.filters.some(filter => /read filled its limit/.test(filter)), 'the cap of the read is declared in the filters');
});

test('O2: the fringe read leaves NULL keys out in the SQL (nullable foreign key) and the SQL is accepted by the real guard', async () => {
  const { run, sql } = setup({ sourceRows: fringe(5), targetRows: inTarget });
  await run();
  assert.match(sql[0], /WHERE "?key"? IS NOT NULL AND "?key"? NOT IN \(/); assert.doesNotMatch(sql[0], /IS NULL\)|OR /);
});

test('O2: few distinct keys over many rows (duplicates in the source) use only the distinct keys', async () => {
  const { run } = setup({ sourceRows: fringe(3, 20), targetRows: inTarget });
  const outcome = await run();
  assert.equal(outcome.status, 'CONFIRMED'); const metrics = (outcome.counterprobe as any).metrics;
  assert.deepEqual([metrics.fringeKeys, metrics.matchedKeys, metrics.sourceReadFilled], [3, 3, true]);
});

test('O2: a target that really holds more rows than keys (duplicates) still reaches the limit and is reported as truncated, with matchedKeys measured and not 0', async () => {
  const { run } = setup({ sourceRows: fringe(80), targetRows: keys => keys.flatMap(key => key >= 1000 ? [[key], [key]] : []) });
  const outcome = await run();
  assert.equal(outcome.status, 'INSUFFICIENT'); assert.equal(outcome.reason, 'counterevidence_transport_or_scope_incomplete');
  const counter = outcome.counterprobe as any;
  assert.equal(counter.transportStatus, 'TRUNCATED'); assert.equal(counter.metrics.matchedKeys, LIMIT / 2, 'what the cut read did match (25 keys x 2 rows = 50) is reported, not a default 0');
});

test('O2: keys missing in the target are a real counterexample: DEGRADED, matchedKeys counts only the found ones', async () => {
  const { run } = setup({ sourceRows: fringe(10), targetRows: keys => inTarget(keys).slice(0, 6) });
  const outcome = await run();
  assert.equal(outcome.status, 'DEGRADED'); assert.equal((outcome.counterprobe as any).metrics.matchedKeys, 6);
});

test('O2: an empty fringe is a repeated bounded request, a limit of 1 can never be complete', async () => {
  const empty = await setup({ sourceRows: [], targetRows: inTarget }).run();
  assert.deepEqual([empty.status, empty.classification, empty.reason], ['INSUFFICIENT', 'REPEATED', 'no new source tuples; repeated bounded request']);
  const c = contract();
  const tiny = await runTypedCounterprobe({ contract: c, baseEvidence: bundle(c, [[1]], [[1]]), policy, config, inventory, thresholds: { criticProbeLimit: 1 }, client: { async runSql() { throw new Error('no read expected'); } } as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', now: checkedAt, runId: 'r' });
  assert.equal(tiny.reason, 'critic_probe_limit_invalid');
});
