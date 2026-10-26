import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runTypedCounterprobe } from '../src/critic/adversarial.ts';
import { assertRunSqlAllowed } from '../src/clients/zetaris.ts';
import { legacyRelationContract } from '../src/relations/legacy.ts';
import type { EvidenceBundle, RelationContract } from '../src/contracts/types.ts';

/**
 * Round 10 post-run integration (X9), observation O2. In the live pass 1 the critic classified 71 of 92 contracts as counterevidence_transport_or_scope_incomplete
 * (transportStatus TRUNCATED, matchedKeys 0). The fixture keeps the SHAPE of each of those 71 counterprobes as the live artifacts reported it (seed keys, the source fringe
 * read that filled its LIMIT of 50, the number of keys the target lookup carried). Here every one of them is replayed through the critic of this checkout against a stub
 * client that answers like the live tables did: a fringe of `sourceRows` rows over `targetKeys` distinct keys, and a unique target that holds every key it is asked for.
 * OFFLINE / SYNTHETIC values: the key values are generated, only the counts are live. Nothing here reads a live artifact, `.env` or the ledger.
 */
interface Shape { relationId: string; from: { db: string; table: string; column: string }; to: { db: string; table: string; column: string }; seedKeys: number; sourceRows: number; targetKeys: number; liveMatchedKeys: number; liveTransport: string }
const fixture: { limit: number; shapes: Shape[] } = JSON.parse(fs.readFileSync(new URL('./fixtures/round10/o2-live-critic-shapes.json', import.meta.url), 'utf8'));
const known = <T>(value: T) => ({ state: 'KNOWN' as const, value });
const checkedAt = '2026-10-26T01:52:51.000Z', policy = { policyVersion: '1.0', minimumDistinctKeys: 1, minimumOverlapRatio: 1 };

function contractFor(shape: Shape): RelationContract {
  const value = legacyRelationContract({ id: shape.relationId, from: shape.from, to: shape.to, kind: 'FOREIGN_KEY', identifierSpace: 'sk', normalizationVersion: '1', normalizationLossless: true,
    normalizationAdapterCapability: 'exact', reviewState: 'REVIEWED' }, 'tpcds', '1.0', 'text', 1);
  value.from.orderedColumns = [shape.from.column]; value.to.orderedColumns = [shape.to.column];
  value.from.namespace = known('ns'); value.to.namespace = known('ns'); value.identifierSpace = known('sk'); value.reviewState = 'REVIEWED';
  value.normalization = [{ componentIndex: 0, operation: known('text'), version: known('1'), lossless: known(true), adapterCapability: known('exact-text') }];
  return value;
}
function baseBundle(c: RelationContract, keys: string[], limit: number): EvidenceBundle {
  const observation = (endpoint: RelationContract['from'], column: string, side: string) => ({ observationId: `base:${side}`, type: 'KEY_MEMBERSHIP' as const, sourceRef: endpoint.sourceId, adapterId: 'synthetic', requestId: known(`base:${side}`),
    observedAt: known(checkedAt), checkedAt, nativeVersion: { state: 'UNKNOWN' as const }, fingerprint: { state: 'UNKNOWN' as const }, projection: [column], filters: [], limit, measuredTuples: keys.map(key => [key]), nullCount: 0, duplicateCount: 'UNKNOWN' as const,
    truncated: false as const, transportStatus: 'OK' as const, protectedPayloadRef: { state: 'UNKNOWN' as const } });
  return { schemaVersion: 1, evidenceBundleId: 'evidence:base', relationRef: c.id, contractVersion: c.contractVersion, sourceRefs: [c.from.sourceId, c.to.sourceId].sort(),
    runRef: { runId: 'base', startedAt: { state: 'UNKNOWN' }, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', configFingerprint: { state: 'UNKNOWN' } },
    observations: [observation(c.from, c.from.orderedColumns[0], 'from'), observation(c.to, c.to.orderedColumns[0], 'to')], scope: known('baseline'), completeness: 'COMPLETE_FOR_SCOPE', capturedAt: checkedAt };
}

/** Replays one live shape. `perKeyInTarget` > 1 turns the target into a table that holds duplicates of each key (the one case that must still be truncated). */
async function replay(shape: Shape, perKeyInTarget = 1) {
  const limit = fixture.limit, c = contractFor(shape);
  const fringeKeys = Array.from({ length: shape.targetKeys }, (_, index) => `f${index}`);
  const fringe = Array.from({ length: shape.sourceRows }, (_, index) => [fringeKeys[index % fringeKeys.length]]);
  const config = { database: shape.from.db, tables: { [shape.from.table]: { columns: [{ name: shape.from.column, type: 'int' }] }, [shape.to.table]: { columns: [{ name: shape.to.column, type: 'int' }] } } };
  const inventory = { tables: { [shape.from.table]: { labels: [] }, [shape.to.table]: { labels: [] } } };
  const sql: string[] = [];
  const client = { async runSql(text: string, lim = 20) {
    assertRunSqlAllowed(text); sql.push(text);
    if (text.includes(`${shape.from.db}.${shape.from.table})`)) return { sql: text, requestId: 'src', queryId: 'q1', rows: fringe.slice(0, lim), durationMs: 0, utc: checkedAt };
    const asked = [...(text.match(/IN \(([^)]*)\)/)?.[1] ?? '').matchAll(/'([^']*)'/g)].map(match => match[1]);
    return { sql: text, requestId: 'tgt', queryId: 'q2', rows: asked.flatMap(key => Array.from({ length: perKeyInTarget }, () => [key])).slice(0, lim), durationMs: 0, utc: checkedAt };
  } };
  const outcome = await runTypedCounterprobe({ contract: c, baseEvidence: baseBundle(c, Array.from({ length: shape.seedKeys }, (_, index) => `s${index}`), limit), policy, config, inventory,
    thresholds: { criticProbeLimit: limit }, client: client as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', now: checkedAt, runId: `critic-run:${shape.relationId}` });
  const asked = sql[1] ? (sql[1].match(/IN \(([^)]*)\)/)?.[1] ?? '').split(',').length : 0;
  return { outcome, metrics: (outcome.counterprobe as any)?.metrics ?? {}, transport: (outcome.counterprobe as any)?.transportStatus, asked };
}

test('O2 live replay: the fixture holds the 71 shapes the live pass 1 reported as TRUNCATED with matchedKeys 0', () => {
  assert.equal(fixture.shapes.length, 71);
  assert.ok(fixture.shapes.every(shape => shape.liveTransport === 'TRUNCATED' && shape.liveMatchedKeys === 0 && shape.sourceRows === fixture.limit));
  assert.ok(fixture.shapes.some(shape => shape.targetKeys === fixture.limit), 'the 13 cases whose target lookup carried as many keys as its own limit are in the fixture');
});

test('O2 live replay: store_returns.sr_customer_sk -> customer.c_customer_sk (49 seed keys, 50 fringe rows = LIMIT, 46 keys looked up) is CONFIRMED with 46/46 matched', async () => {
  const shape = fixture.shapes.find(item => item.relationId === 'store_returns.sr_customer_sk__customer.c_customer_sk')!;
  assert.deepEqual([shape.seedKeys, shape.sourceRows, shape.targetKeys], [49, 50, 46]);
  const { outcome, metrics, transport, asked } = await replay(shape);
  assert.equal(outcome.status, 'CONFIRMED', outcome.reason); assert.equal(transport, 'COMPLETE');
  assert.deepEqual([metrics.fringeKeys, metrics.matchedKeys, metrics.sourceReadFilled, asked], [46, 46, true, 46]);
});

test('O2 live replay: all 71 shapes are CONFIRMED with a COMPLETE target read, matchedKeys measured (never 0 by default), and a lookup that never carries as many keys as its limit', async () => {
  const bad: string[] = [];
  for (const shape of fixture.shapes) {
    const { outcome, metrics, transport, asked } = await replay(shape);
    const expectedKeys = Math.min(shape.targetKeys, fixture.limit - 1);
    if (outcome.status !== 'CONFIRMED' || transport !== 'COMPLETE' || metrics.matchedKeys !== expectedKeys || metrics.fringeKeys !== expectedKeys || asked !== expectedKeys || asked >= fixture.limit) bad.push(`${shape.relationId}: ${outcome.status} ${transport} matched ${metrics.matchedKeys}/${expectedKeys} asked ${asked}`);
  }
  assert.deepEqual(bad, []);
});

test('O2 live replay (negative control): a target that holds two rows per key still reaches its limit and stays TRUNCATED, with matchedKeys measured', async () => {
  const shape = fixture.shapes.find(item => item.relationId === 'store_returns.sr_customer_sk__customer.c_customer_sk')!;
  const { outcome, metrics, transport } = await replay(shape, 2);
  assert.equal(outcome.status, 'INSUFFICIENT'); assert.equal(outcome.reason, 'counterevidence_transport_or_scope_incomplete'); assert.equal(transport, 'TRUNCATED');
  assert.equal(metrics.matchedKeys, 25, '25 keys x 2 rows = the 50 rows the cut read returned');
});
