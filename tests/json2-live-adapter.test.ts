import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from '../src/runtime.ts';
import { resolveUniverseManifest } from '../src/registry/universes.ts';
import { dispatchUniverseAction } from '../src/universe-adapters.ts';
import { loadSvp1Profiles, loadSvp1ProfileRows } from '../src/svp1.ts';
import { evaluateSvp1Live, validateSvp1LiveManifest } from '../src/svp1-live.ts';
import {
  canonicalJson2SchemaSha256, canonicalJson2TypedMultisetSha256, validateJson2LiveBinding,
  ZetarisJson2ProbeAdapter, type Json2LiveBindingDocument, type Json2LiveTableBinding
} from '../src/relations/adapters/zetaris-json2.ts';
import { SafeError } from '../src/runtime.ts';
import { readFreshnessHistory } from '../src/reconcile/freshness-history.ts';

const describeRows = [['id', 'string'], ['count', 'integer']] as const;
const typedRows = [['01', 1], ['2', 2]] as const;
const typedColumns = [{ name: 'id', kind: 'string' as const }, { name: 'count', kind: 'integer' as const }];
function table(index: number, options: { schemaRows?: readonly (readonly unknown[])[]; rows?: readonly (readonly unknown[])[] } = {}): Json2LiveTableBinding {
  const schemaRows = options.schemaRows ?? describeRows;
  const rows = options.rows ?? typedRows;
  return {
    manifestId: 'fixture.universe.json2', profileAlias: 'JSON2_FIXTURE', tableId: `table${index}`,
    sourceId: `fixture:source${index}`, logicalObjectId: `fixture.db.table${index}`,
    physicalDatabase: 'FixtureDb', physicalTable: `Table${index}`,
    columns: [{ name: 'id', kind: 'string' }, { name: 'count', kind: 'integer' }],
    expectedRows: rows.length, maxRows: 20, readLimit: 50,
    observedSchemaSha256: canonicalJson2SchemaSha256(schemaRows),
    typedMultisetSha256: canonicalJson2TypedMultisetSha256(rows, typedColumns),
    fingerprintAlgorithm: 'CANONICAL_TYPED_ROWS_MULTISET_V1', dataOrigin: 'SYNTHETIC'
  };
}
function binding(tables: Json2LiveTableBinding[]): Json2LiveBindingDocument {
  return {
    schemaVersion: 1, bindingId: 'fixture.json2.binding', bindingVersion: '1.0.0',
    status: 'ROOT_REVIEWED_FOR_BOUNDED_READ_ONLY_CONSUMPTION', reviewedAtUtc: '2026-10-23T00:00:00Z',
    registrationPlanFingerprint: 'a'.repeat(64), packageSealSha256: 'b'.repeat(64),
    registrationJournalSha256: 'c'.repeat(64), backendEngineVersion: 'fixture',
    profileConfigPath: 'universes/svp1-snapshots.json', wireEncoding: 'SQL_EDITOR_STRING_CELLS_CANONICAL_INTEGER_V1',
    wireEvidenceSha256: 'd'.repeat(64), readLimit: 50, maxRowsPerTable: 20,
    requiresFreshSchemaAndTypedMultisetCheckBeforeUse: true, sqlMutationAllowed: false, uslAllowed: false, tables
  };
}
function fakeClient(tables: Json2LiveTableBinding[], options: { failDescribeTable?: string; schemaRows?: readonly (readonly unknown[])[]; rows?: readonly (readonly unknown[])[] } = {}) {
  const calls: { kind: string; sql?: string; database?: string; table?: string; trace?: boolean; limit?: number }[] = [];
  return {
    calls,
    client: {
      async describe(database: string, name: string, opts?: { trace?: boolean }) {
        calls.push({ kind: 'DESCRIBE', database, table: name, trace: opts?.trace });
        if (name === options.failDescribeTable) throw new SafeError('FIXTURE_DESCRIBE_FAILURE');
        return { sql: `DESCRIBE DATASOURCE TABLE ${database}.${name}`, requestId: `describe-request-${name}`, queryId: `describe-query-${name}`, rows: options.schemaRows ?? describeRows, durationMs: 1, utc: '2026-10-23T00:00:01Z' };
      },
      async runSql(sql: string, limit: number, opts?: { trace?: boolean }) {
        calls.push({ kind: 'SELECT', sql, limit, trace: opts?.trace });
        const name = tables.find(item => sql.includes('.' + item.physicalTable + ' '))?.physicalTable;
        return { sql, requestId: `select-request-${name}`, queryId: `select-query-${name}`, rows: options.rows ?? [['01', '1'], ['2', '2']], durationMs: 2, utc: '2026-10-23T00:00:02Z' };
      }
    }
  };
}
const request = (item: Json2LiveTableBinding) => ({ sourceId: item.sourceId, objectId: item.logicalObjectId, columns: ['id', 'count'], keyColumns: ['id'], limit: 50 });
const bindingPinnedToSnapshot = (input: Json2LiveBindingDocument, manifestId: string): Json2LiveBindingDocument => {
  const profile = loadSvp1Profiles(input.profileConfigPath).find(item => item.manifestId === manifestId)!;
  const rows = loadSvp1ProfileRows(profile);
  return { ...structuredClone(input), tables: input.tables.map(item => {
    if (item.manifestId !== manifestId) return item;
    const tableRows = rows.get(item.sourceId + ':' + item.logicalObjectId)!;
    return { ...item, typedMultisetSha256: canonicalJson2TypedMultisetSha256(tableRows, item.columns) };
  }) };
};

test('JSON2 live manifests validate offline against approved bindings and SVP1 profiles', () => {
  const bindingInput = readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json');
  const profiles = loadSvp1Profiles(bindingInput.profileConfigPath);
  for (const alias of ['GTFS_SVP1_LIVE', 'CHINOOK_SVP1_LIVE', 'NORTHWIND_SVP1_LIVE']) {
    const manifest = resolveUniverseManifest(alias)!;
    assert.deepEqual(validateSvp1LiveManifest(manifest, bindingInput, profiles), []);
  }
});

test('JSON2 binding enforces aggregate 20-query and 145-row caps across complete manifest work', () => {
  const tenTables = Array.from({ length: 10 }, (_, index) => {
    const item = table(index + 1);
    return { ...item, sourceId: 'fixture:source' + (index + 1), logicalObjectId: 'fixture.db.table' + (index + 1),
      expectedRows: index === 9 ? 19 : 14, maxRows: 20 };
  });
  assert.deepEqual(validateJson2LiveBinding(binding(tenTables)), []);
  const elevenTables = [...tenTables, { ...table(11), sourceId: 'fixture:source11', logicalObjectId: 'fixture.db.table11', expectedRows: 1 }];
  assert.ok(validateJson2LiveBinding(binding(elevenTables)).some(issue => issue.code === 'TOTAL_LIVE_BOUNDS_EXCEEDED'));
  const overRows = tenTables.map((item, index) => ({ ...item, expectedRows: index === 9 ? 20 : 15 }));
  assert.ok(validateJson2LiveBinding(binding(overRows)).some(issue => issue.code === 'TOTAL_LIVE_BOUNDS_EXCEEDED'));

  const raw = readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json');
  const profiles = loadSvp1Profiles(raw.profileConfigPath);
  const activeIds = ['concordia.universe.gtfs-svp1', 'concordia.universe.chinook-svp1', 'vendor.universe.northwind-known-reserve'];
  const activeTables = raw.tables.filter(item => activeIds.includes(item.manifestId));
  const candidateCount = profiles.filter(profile => activeIds.includes(profile.manifestId)).reduce((sum, profile) => sum + profile.candidates.length, 0);
  assert.equal(activeTables.length, 10);
  assert.equal(activeTables.reduce((sum, item) => sum + item.expectedRows, 0), 145);
  assert.equal(candidateCount, 17);
  assert.ok(activeTables.length * 2 <= 20);
  assert.ok(activeTables.reduce((sum, item) => sum + item.expectedRows, 0) <= 145);
});test('JSON2 adapter enforces bounded SQL, exact string and canonical integer wire decoding, then reuses one verified read', async () => {
  const item = table(1), document = binding([item]);
  assert.deepEqual(validateJson2LiveBinding(document), []);
  const fake = fakeClient([item]);
  const adapter = new ZetarisJson2ProbeAdapter(document, fake.client as any);
  const first = await adapter.read(request(item));
  const second = await adapter.read(request(item));
  assert.deepEqual(first.tuples, [['01', 1], ['2', 2]]);
  assert.deepEqual(second.tuples, first.tuples);
  assert.equal(fake.calls.filter(call => call.kind === 'DESCRIBE').length, 1);
  assert.equal(fake.calls.filter(call => call.kind === 'SELECT').length, 1);
  assert.equal(fake.calls.find(call => call.kind === 'SELECT')?.sql, 'SELECT id, count FROM FixtureDb.Table1 LIMIT 50');
  assert.equal(fake.calls.every(call => call.trace === true), true);
  const summary = adapter.getRunSummary();
  assert.equal(summary.status, 'COMPLETE');
  assert.equal((summary.tables[0] as any).actualRows, 2);
  assert.equal(JSON.stringify(summary).includes(String.fromCharCode(34) + '01' + String.fromCharCode(34)), false);
});

test('JSON2 fingerprints match all ten approved GTFS, Chinook, and Northwind receipt hashes without rewriting them', () => {
  const bindingInput = readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json');
  const profiles = loadSvp1Profiles(bindingInput.profileConfigPath);
  for (const manifestId of ['concordia.universe.gtfs-svp1', 'concordia.universe.chinook-svp1', 'vendor.universe.northwind-known-reserve']) {
    const profile = profiles.find(item => item.manifestId === manifestId)!;
    const localRows = loadSvp1ProfileRows(profile);
    for (const snapshot of profile.tables) {
      const receipt = bindingInput.tables.find(item => item.manifestId === manifestId && item.sourceId === snapshot.sourceId)!;
      const rows = localRows.get(snapshot.sourceId + ':' + snapshot.objectId)!;
      assert.equal(canonicalJson2TypedMultisetSha256(rows, receipt.columns), receipt.typedMultisetSha256, receipt.tableId);
    }
  }
});

test('JSON2 receipt hashing is order stable, lexical, typed, and duplicate sensitive', () => {
  const columns = [{ name: 'key', kind: 'string' as const }, { name: 'n', kind: 'integer' as const }];
  const rows = [['a', 1], ['A', 1], ['a/', 1], ['a0', 1], ['a', 1]] as const;
  assert.equal(canonicalJson2TypedMultisetSha256(rows, columns), canonicalJson2TypedMultisetSha256([...rows].reverse(), columns));
  assert.notEqual(canonicalJson2TypedMultisetSha256(rows, columns), canonicalJson2TypedMultisetSha256(rows.slice(1), columns));
  assert.equal(canonicalJson2SchemaSha256([['z', 'string'], ['a', 'integer']]), canonicalJson2SchemaSha256([['a', 'integer'], ['z', 'string']]));
});

test('JSON2 accepts quoted DESCRIBE type metadata and shuffled columns while requiring audited SQL results', async () => {
  const schemaRows = [['count', 'integer'], ['id', '"string"']] as const;
  const item = table(3, { schemaRows });
  const fake = fakeClient([item], { schemaRows });
  const adapter = new ZetarisJson2ProbeAdapter(binding([item]), fake.client as any);
  assert.deepEqual((await adapter.read(request(item))).tuples, [['01', 1], ['2', 2]]);
  for (const missing of ['requestId', 'queryId', 'utc'] as const) {
    const client = fakeClient([item], { schemaRows });
    const describe = client.client.describe;
    client.client.describe = async (...args: Parameters<typeof describe>) => {
      const value = await describe(...args);
      return { ...value, [missing]: undefined };
    };
    const guarded = new ZetarisJson2ProbeAdapter(binding([item]), client.client as any);
    await assert.rejects(() => guarded.read(request(item)), /JSON2_AUDIT_/);
    assert.equal(client.calls.some(call => call.kind === 'SELECT'), false);
  }
});
test('JSON2 adapter rejects a matching prefix when the backend reports more rows or a continuation', async () => {
  const item = table(1);
  for (const pagination of [{ rawRowsReceived: 2, reportedTotal: 3, totalReported: true }, { rawRowsReceived: 2, continuationPresent: true }]) {
    const fake = fakeClient([item]);
    const original = fake.client.runSql;
    fake.client.runSql = async (...args: Parameters<typeof original>) => ({ ...await original(...args), ...pagination });
    const adapter = new ZetarisJson2ProbeAdapter(binding([item]), fake.client as any);
    await assert.rejects(() => adapter.read(request(item)), /JSON2_RESULT_PAGINATION_INCOMPLETE/);
    assert.equal(adapter.getRunSummary().status, 'ERROR');
  }
  const describeFake = fakeClient([item]);
  const originalDescribe = describeFake.client.describe;
  describeFake.client.describe = async (...args: Parameters<typeof originalDescribe>) => ({ ...await originalDescribe(...args), rawRowsReceived: 2, reportedTotal: 3, totalReported: true });
  const describeAdapter = new ZetarisJson2ProbeAdapter(binding([item]), describeFake.client as any);
  await assert.rejects(() => describeAdapter.read(request(item)), /JSON2_RESULT_PAGINATION_INCOMPLETE/);
  assert.equal(describeFake.calls.some(call => call.kind === 'SELECT'), false);

  const fake = fakeClient([item]);
  const adapter = new ZetarisJson2ProbeAdapter(binding([item]), fake.client as any);
  await adapter.read(request(item));
  const tableSummary = adapter.getRunSummary().tables[0] as any;
  assert.equal(tableSummary.paginationScope, 'CLOSED_BINDING');
  assert.equal(tableSummary.paginationStatus, 'TOTAL_UNREPORTED');
  assert.equal(tableSummary.totalReported, false);
});
test('JSON2 adapter stops on the first failed table and preserves verified prefix as partial', async () => {
  const items = [table(1), table(2), table(3)], document = binding(items);
  const fake = fakeClient(items, { failDescribeTable: 'Table2' });
  const adapter = new ZetarisJson2ProbeAdapter(document, fake.client as any);
  const summary = await adapter.verifyAllTables();
  assert.equal(summary.status, 'PARTIAL');
  assert.equal((summary.tables[0] as any).status, 'VERIFIED');
  assert.equal((summary.tables[1] as any).status, 'ERROR');
  assert.equal((summary.tables[2] as any).status, 'NOT_REQUESTED');
  assert.equal(summary.failure?.code, 'FIXTURE_DESCRIBE_FAILURE');
  assert.equal(fake.calls.filter(call => call.kind === 'DESCRIBE').length, 2);
  assert.deepEqual((await adapter.read(request(items[0]))).tuples, [['01', 1], ['2', 2]]);
  await assert.rejects(() => adapter.read(request(items[2])), /JSON2_SESSION_ABORTED_AFTER_FAILURE/);
  assert.equal(fake.calls.filter(call => call.kind === 'DESCRIBE').length, 2);
});

test('JSON2 adapter rejects schema and typed multiset mismatches before exposing data', async () => {
  const item = table(1), schemaFake = fakeClient([item], { schemaRows: [['id', 'integer'], ['count', 'integer']] });
  const schemaAdapter = new ZetarisJson2ProbeAdapter(binding([item]), schemaFake.client as any);
  await assert.rejects(() => schemaAdapter.read(request(item)), /JSON2_SCHEMA_MISMATCH/);
  assert.equal(schemaFake.calls.filter(call => call.kind === 'SELECT').length, 0);

  const dataFake = fakeClient([item], { rows: [['different', '1'], ['2', '2']] });
  const dataAdapter = new ZetarisJson2ProbeAdapter(binding([item]), dataFake.client as any);
  await assert.rejects(() => dataAdapter.read(request(item)), /JSON2_TYPED_MULTISET_MISMATCH/);
  assert.equal(dataFake.calls.filter(call => call.kind === 'SELECT').length, 1);
  assert.equal(dataAdapter.getRunSummary().status, 'ERROR');
});
test('SVP1 live evaluation uses the shared planner and evaluator with injected adapter and retains partial source status', async () => {
  const bindingInput = bindingPinnedToSnapshot(readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json'), 'concordia.universe.gtfs-svp1');
  const manifest = resolveUniverseManifest('GTFS_SVP1_LIVE')!;
  const calls: string[] = [];
  const adapter = {
    adapterId: 'synthetic-json2-injected',
    async verifyAllTables() { return { status: 'PARTIAL', tables: [], failure: { sourceId: 'fixture:stopped', code: 'FIXTURE_STOP' } }; },
    getRunSummary() { return { status: 'PARTIAL', tables: [], failure: { sourceId: 'fixture:stopped', code: 'FIXTURE_STOP' } }; },
    async read(request: { sourceId: string; objectId: string }) { calls.push(`${request.sourceId}:${request.objectId}`); return { tuples: [], requestId: `fake:${calls.length}` }; }
  };
  const result = await evaluateSvp1Live(manifest, { binding: bindingInput, adapter, runId: 'json2-injected-eval-01' });
  assert.equal(result.executionMode, 'LIVE');
  assert.equal(result.status, 'PARTIAL');
  assert.equal((result.pinnedSnapshotValidation as any).status, 'VERIFIED');
  assert.equal((result.pinnedSnapshotValidation as any).tables.length, 4);
  assert.equal((result.sourceValidation as any).failure.code, 'FIXTURE_STOP');
  assert.equal(result.candidateCount, 0);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.predictions, []);
  assert.equal(result.evaluationMeaning, 'Live preflight incomplete; relation evaluation was not run.');
  assert.equal(calls.length, 0);
});
test('Northwind LIVE route uses the common planner and leaves discovery unsupported', async () => {
  const manifest = resolveUniverseManifest('NORTHWIND_SVP1_LIVE')!;
  await assert.rejects(() => dispatchUniverseAction(manifest, 'NORTHWIND_SVP1_LIVE', 'discover'), /UNIVERSE_DISCOVERY_CAPABILITY_REQUIRED/);
  const raw = readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json');
  const bindingInput = bindingPinnedToSnapshot(raw, 'vendor.universe.northwind-known-reserve');
  const profile = loadSvp1Profiles(raw.profileConfigPath).find(item => item.manifestId === 'vendor.universe.northwind-known-reserve')!;
  const fake = {
    adapterId: 'synthetic-json2-northwind',
    async verifyAllTables() { return { status: 'COMPLETE', tables: [] }; },
    getRunSummary() { return { status: 'COMPLETE', tables: [] }; },
    async read() { return { tuples: [], requestId: 'northwind-fixture-request' }; }
  };
  const result = await evaluateSvp1Live(manifest, { binding: bindingInput, adapter: fake, runId: 'northwind-live-offline-01' });
  assert.equal(result.status, 'EVALUATED');
  assert.equal(result.candidateCount, profile.candidates.length);
  assert.ok(result.decisions.length > 0 && result.decisions.length <= profile.candidates.length);
  assert.equal(result.executionMode, 'LIVE');
});
test('universe CLI dispatcher and direct live evaluation produce the same shared-evaluator result', async () => {
  const bindingInput = bindingPinnedToSnapshot(readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json'), 'concordia.universe.gtfs-svp1');
  const manifest = resolveUniverseManifest('GTFS_SVP1_LIVE')!;
  const makeAdapter = () => ({
    adapterId: 'synthetic-json2-injected',
    async verifyAllTables() { return { status: 'COMPLETE', tables: [] }; },
    getRunSummary() { return { status: 'COMPLETE', tables: [] }; },
    async read() { return { tuples: [], requestId: 'deterministic-fake-request' }; }
  });
  const options = { binding: bindingInput, runId: 'json2-cli-parity-01', now: () => '2026-10-23T12:00:00.000Z' };
  const direct = await evaluateSvp1Live(manifest, { ...options, adapter: makeAdapter() });
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = value => { logged.push(String(value)); };
  try {
    const dispatched = await dispatchUniverseAction(manifest, 'GTFS_SVP1_LIVE', 'eval', { ...options, adapter: makeAdapter() });
    assert.deepEqual(dispatched, direct);
    assert.deepEqual(JSON.parse(logged[0]), direct);
  } finally { console.log = originalLog; }
});
test('live receipt typed-multiset mismatch is held before the adapter is touched', async () => {
  const raw = readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json');
  for (const [alias, profileId] of [['GTFS_SVP1_LIVE', 'concordia.universe.gtfs-svp1'], ['CHINOOK_SVP1_LIVE', 'concordia.universe.chinook-svp1']]) {
    const bindingInput = bindingPinnedToSnapshot(raw, profileId);
    const table = bindingInput.tables.find(item => item.manifestId === profileId)!;
    table.typedMultisetSha256 = '0'.repeat(64);
    const manifest = resolveUniverseManifest(alias)!;
    let adapterTouched = false;
    const adapter = { adapterId: 'must-not-run', async read() { adapterTouched = true; return { tuples: [] }; }, async verifyAllTables() { adapterTouched = true; } };
    await assert.rejects(() => evaluateSvp1Live(manifest, { binding: bindingInput, adapter, runId: `json2-binding-pin-guard-${alias.toLowerCase()}` }), /JSON2_BINDING_PINNED_SNAPSHOT_MISMATCH/);
    assert.equal(adapterTouched, false);
  }
});

test('SVP1 LIVE persistence uses route manifest and canonical G01 contract scope', async () => {
  const bindingInput = bindingPinnedToSnapshot(readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json'), 'concordia.universe.gtfs-svp1');
  const manifest = resolveUniverseManifest('GTFS_SVP1_LIVE')!;
  const adapter = {
    adapterId: 'synthetic-json2-scope-check',
    async verifyAllTables() { return { status: 'COMPLETE', tables: [] }; },
    getRunSummary() { return { status: 'COMPLETE', tables: [] }; },
    async read() { return { tuples: [], requestId: 'scope-check-request' }; }
  };
  const runId = `svP1-scope-${Date.now()}`;
  const result = await evaluateSvp1Live(manifest, { binding: bindingInput, adapter, runId, relationIds: ['G01'], persistFreshness: true, now: () => '2026-10-23T12:34:56.000Z' });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.decisions[0].relationContractRef, 'svp1_G01');
  const history = readFreshnessHistory(manifest.manifestId, 'svp1_G01');
  const attempt = history.at(-1)!;
  assert.ok(attempt);
  assert.equal(attempt.universeId, manifest.manifestId);
  assert.equal(attempt.relationId, 'svp1_G01');
  assert.equal(attempt.evidence?.runRef.executionMode, 'LIVE');
});
test('SVP1 LIVE API persists one canonical preflight failure with native error references', async () => {
  const bindingInput = bindingPinnedToSnapshot(readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json'), 'concordia.universe.gtfs-svp1');
  const manifest = resolveUniverseManifest('GTFS_SVP1_LIVE')!;
  const table = bindingInput.tables[0];
  const summary = { status: 'PARTIAL', tables: [{ sourceId: table.sourceId, logicalObjectId: table.logicalObjectId, status: 'ERROR', observedSchemaSha256: 'd'.repeat(64), describeRequestId: 'describe-request-fixture', describeQueryId: 'describe-query-fixture', describeRequestedAt: '2026-10-23T12:00:00.000Z', selectRequestId: 'select-request-fixture', selectQueryId: 'select-query-fixture', selectRequestedAt: '2026-10-23T12:01:00.000Z' }], failure: { sourceId: table.sourceId, code: 'RATE_LIMITED', http: 429, retryAfter: '17' } };
  const adapter = { adapterId: 'synthetic-json2-preflight-failure', async verifyAllTables() { return summary; }, getRunSummary() { return summary; }, async read() { throw new Error('READ_MUST_NOT_RUN'); } };
  const prior=readFreshnessHistory(manifest.manifestId, 'svp1_G01').at(-1),expectedComplete=prior?.validity.completeness==='COMPLETE'?prior.attemptId:prior?.latestCompleteAttemptRef??null;
  await evaluateSvp1Live(manifest, { binding: bindingInput, adapter, runId: `svp1-preflight-${Date.now()}`, relationIds: ['G01'], persistFreshness: true, now: () => '2026-10-23T12:02:00.000Z' });
  const record = readFreshnessHistory(manifest.manifestId, 'svp1_G01').at(-1)!;
  assert.equal(record.kind, 'PREFLIGHT_FAILURE'); assert.equal(record.evidence, null); assert.equal(record.decision, null); assert.equal(record.latestCompleteAttemptRef, expectedComplete);
  assert.deepEqual(record.sourceQueryHistory.map(item => item.requestId), ['describe-request-fixture', 'select-request-fixture']);
  assert.equal(record.sourceQueryHistory[1].queryId, 'select-query-fixture'); assert.equal(record.transportFailures[0].http, 429); assert.equal(record.transportFailures[0].retryAfter, '17');
});