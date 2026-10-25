import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from '../src/runtime.ts';
import type { Decision, EvidenceBundle, RelationContract } from '../src/contracts/types.ts';
import { compilePublicationPlan } from '../src/usl/publication-plan.ts';
import { Zetaris } from '../src/clients/zetaris.ts';
import { decodeLoadedUslModelRows, FileUslClientPointerStore, parseNamespaceCatalogRows, sourceKeyProjectionMatches, ZetarisUslLifecycleAdapter } from '../src/usl/zetaris-lifecycle-adapter.ts';
import { canonicalJson2SchemaSha256, canonicalJson2TypedMultisetSha256 } from '../src/relations/adapters/zetaris-json2.ts';
import { executeAuthorizedUslLifecycle, recoverAuthorizedUslLifecycle } from '../src/usl/lifecycle-simulator.ts';
import { FilePublicationJournal, readNamespacePublicationEvents, readPublicationJournalHistory } from '../src/usl/publication-executor.ts';
import { retargetPublicationInput } from '../src/usl/retarget.ts';
import { buildLiveUslGrant } from '../src/usl/live-grant.ts';
import { isApprovedL4Namespace, assessUslLifecycleApplyGate, checkUslLifecyclePlan, compileUslLifecyclePlan, verifyLoadedUslModel, verifyObservedRelationRows, verifyPublicationSourceBindingBytes, type PublicationSourceBinding } from '../src/usl/lifecycle-plan.ts';
function fixture() {
  const known = <T extends string | boolean>(value: T) => ({ state: 'KNOWN' as const, value });
  const contract: RelationContract = {
    schemaVersion: 1, id: 'fk-usl-synthetic', contractVersion: '1.0',
    universeRef: { universeId: 'U1', universeVersion: { state: 'UNKNOWN' }, namespace: known('synthetic-catalog'), configFingerprint: { state: 'UNKNOWN' } },
    kind: 'FOREIGN_KEY',
    from: { sourceId: 'source-child', namespace: known('synthetic-catalog'), objectId: 'child', orderedColumns: ['key_a', 'key_b'] },
    to: { sourceId: 'source-parent', namespace: known('synthetic-catalog'), objectId: 'parent', orderedColumns: ['key_x', 'key_y'] },
    identifierSpace: known('synthetic-id-space'),
    normalization: [0, 1].map(componentIndex => ({ componentIndex, operation: known('text'), version: known('1'), lossless: known(true), adapterCapability: known('exact-text') })),
    semanticContext: { grain: { state: 'UNKNOWN' }, unit: { state: 'UNKNOWN' }, scale: { state: 'UNKNOWN' }, period: { state: 'UNKNOWN' }, timezone: { state: 'UNKNOWN' } },
    assertions: [], evidencePolicy: { requiredObservationTypes: ['KEY_MEMBERSHIP'], minimumCompleteness: 'COMPLETE_FOR_SCOPE', nulls: 'UNKNOWN', cardinality: 'UNKNOWN', declarationsAdmissible: 'UNKNOWN', minimumDistinctKeys: 2 }, reviewState: 'REVIEWED'
  };
  const observation = (id: string, sourceRef: string, projection: string[]): EvidenceBundle['observations'][number] => ({
    observationId: id, type: 'KEY_MEMBERSHIP', sourceRef, adapterId: 'local-fixture', requestId: known(id), observedAt: known('2026-01-01T00:00:00Z'), checkedAt: '2026-01-01T00:01:00Z',
    nativeVersion: { state: 'UNKNOWN' }, fingerprint: { state: 'UNKNOWN' }, projection, filters: [], limit: 10, measuredTuples: [['01', 'a'], ['1', 'b']], nullCount: 0,
    duplicateCount: 'UNKNOWN', truncated: false, transportStatus: 'OK', protectedPayloadRef: { state: 'UNKNOWN' }
  });
  const evidence: EvidenceBundle = { schemaVersion: 1, evidenceBundleId: 'evidence-usl-synthetic', relationRef: contract.id, contractVersion: contract.contractVersion, sourceRefs: ['source-child', 'source-parent'],
    runRef: { runId: 'local-run-usl', startedAt: known('2026-01-01T00:00:00Z'), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', configFingerprint: { state: 'UNKNOWN' } },
    observations: [observation('obs-child', 'source-child', ['key_a', 'key_b']), observation('obs-parent', 'source-parent', ['key_x', 'key_y'])], scope: known('bounded synthetic fixture'), completeness: 'COMPLETE_FOR_SCOPE', capturedAt: '2026-01-01T00:01:00Z' };
  const decision: Decision = { schemaVersion: 1, decisionId: 'decision-usl-synthetic', relationRef: contract.id, contractVersion: contract.contractVersion, verdict: 'SOSTENIDA', reasonCodes: ['bounded_sample_key_membership'],
    requirementsMet: ['compatible_namespaces'], requirementsMissing: ['global_coverage_not_established', 'global_uniqueness_not_established'], contradictions: [], scope: known('bounded fixture only'), evidenceBundleRefs: [evidence.evidenceBundleId],
    policyVersion: '1.0', evaluatedAt: known('2026-01-01T00:02:00Z'), requiresReview: false, status: 'CURRENT' };
  const input = { universeId: 'U1', target: { namespace: 'lightning.metastore.concordia_l4_json2_20261023', model: 'concordia_l4_observed_v1' }, contract, evidence: [evidence], decision,
    freshnessState: 'CURRENT_FOR_CHECK' as const, targetState: { fingerprint: 'a'.repeat(64), observedAt: '2026-01-01T00:03:00Z' } };
  const manifest = compilePublicationPlan(input);
  const binding: PublicationSourceBinding = { bindingId: 'synthetic-binding', bindingVersion: '1', bindingSha256: 'b'.repeat(64), uslAllowed: false,
    mappings: [
      { sourceId: 'source-child', logicalObjectId: 'child', physicalDatabase: 'json2', physicalTable: 'trips', keyColumns: [{ logicalColumn: 'key_a', physicalColumn: 'route_id', valueType: 'TEXT' }, { logicalColumn: 'key_b', physicalColumn: 'service_id', valueType: 'TEXT' }] },
      { sourceId: 'source-parent', logicalObjectId: 'parent', physicalDatabase: 'json2', physicalTable: 'routes', keyColumns: [{ logicalColumn: 'key_x', physicalColumn: 'route_id', valueType: 'TEXT' }, { logicalColumn: 'key_y', physicalColumn: 'service_id', valueType: 'TEXT' }] }
    ] };
  return { input, manifest, binding };
}

test('source binding verification hashes exact sealed bytes and compares the complete mapping payload', () => {
  const f = fixture();
  const bindingMappings = f.binding.mappings.map(mapping => ({ ...mapping, keyColumns: mapping.keyColumns.slice(0, 1).map(column => ({ ...column, physicalColumn: column.logicalColumn })) }));
  const completeTableMappings = [...bindingMappings, ...Array.from({ length: 8 }, (_, index) => ({
    sourceId: `synthetic-extra-${index}`, logicalObjectId: `synthetic_catalog.extra_${index}`, physicalDatabase: 'synthetic_json2', physicalTable: `extra_${index}`,
    keyColumns: [{ logicalColumn: `id_${index}`, physicalColumn: `id_${index}`, valueType: 'TEXT' as const }]
  }))];
  const payload = {
    schemaVersion: 1, bindingId: f.binding.bindingId, bindingVersion: '1.0.0',
    status: 'ROOT_REVIEWED_FOR_BOUNDED_READ_ONLY_CONSUMPTION', reviewedAtUtc: '2026-10-23T12:00:00Z',
    registrationPlanFingerprint: 'a'.repeat(64), packageSealSha256: 'b'.repeat(64), registrationJournalSha256: 'c'.repeat(64),
    backendEngineVersion: 'synthetic-json2-1', profileConfigPath: 'synthetic/profile.json',
    wireEncoding: 'SQL_EDITOR_STRING_CELLS_CANONICAL_INTEGER_V1', wireEvidenceSha256: 'd'.repeat(64), readLimit: 50, maxRowsPerTable: 20,
    requiresFreshSchemaAndTypedMultisetCheckBeforeUse: true, sqlMutationAllowed: false, uslAllowed: false,
    tables: completeTableMappings.map((mapping, index) => ({
      manifestId: 'synthetic.manifest', profileAlias: 'SYNTHETIC', tableId: mapping.logicalObjectId.split('.').at(-1)!,
      sourceId: mapping.sourceId, logicalObjectId: mapping.logicalObjectId, physicalDatabase: mapping.physicalDatabase,
      physicalTable: mapping.physicalTable, columns: [...mapping.keyColumns.map(column => ({ name: column.logicalColumn, kind: column.valueType === 'TEXT' ? 'string' : 'integer' })), ...(index === 0 ? [{ name: 'non_key_field', kind: 'string' }] : [])],
      expectedRows: 1, maxRows: 20, readLimit: 50, observedSchemaSha256: String(index + 1).padStart(64, '0'),
      typedMultisetSha256: String(index + 3).padStart(64, '0'), fingerprintAlgorithm: 'CANONICAL_TYPED_ROWS_MULTISET_V1', dataOrigin: 'SYNTHETIC'
    }))
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const binding = { ...f.binding, bindingVersion: '1.0.0', mappings: bindingMappings, bindingSha256: createHash('sha256').update(raw).digest('hex') };
  assert.deepEqual(verifyPublicationSourceBindingBytes(raw, binding), { status: 'VERIFIED', sha256: binding.bindingSha256 });
  assert.equal(verifyPublicationSourceBindingBytes(raw, f.binding).status, 'REJECTED');
  const altered = Buffer.from(JSON.stringify({ ...payload, tables: payload.tables.map((table, index) => index ? table : { ...table, physicalTable: 'foreign_table' }) }), 'utf8');
  const alteredBinding = { ...binding, bindingSha256: createHash('sha256').update(altered).digest('hex') };
  assert.equal(verifyPublicationSourceBindingBytes(altered, alteredBinding).status, 'REJECTED');
  for (const change of [
    (table: typeof payload.tables[number]) => ({ ...table, sourceId: 'synthetic-substitution' }),
    (table: typeof payload.tables[number]) => ({ ...table, columns: table.columns.map((column, index) => index ? column : { ...column, kind: 'integer' }) })
  ]) {
    const changed = Buffer.from(JSON.stringify({ ...payload, tables: payload.tables.map((table, index) => index ? table : change(table)) }), 'utf8');
    assert.equal(verifyPublicationSourceBindingBytes(changed, { ...binding, bindingSha256: createHash('sha256').update(changed).digest('hex') }).status, 'REJECTED');
  }
  assert.equal(verifyPublicationSourceBindingBytes(Buffer.from('{'), binding).status, 'REJECTED');
});

test('USL lifecycle plan is deterministic, exact-text, traceable, and never executable', () => {
  const f = fixture(), plan = compileUslLifecyclePlan(f.manifest, f.input, f.binding), again = compileUslLifecyclePlan(f.manifest, f.input, f.binding);
  assert.equal(plan.fingerprint, again.fingerprint);
  assert.equal(plan.status, 'PREPARED');
  assert.equal(plan.executable, false);
  assert.equal(plan.executionStatus, 'NOT_RUN');
  assert.equal(plan.publicationBasis, 'ObservedRelation');
  assert.equal(plan.sourceBinding.uslAllowed, false);
  assert.equal(plan.sourceBinding.sha256Status, 'CLAIMED_UNVERIFIED');
  assert.equal(plan.target.namespace, 'lightning.metastore.concordia_l4_json2_20261023');
  assert.match(plan.target.model, /_v1$/);
  assert.equal(plan.expectedProjection?.rowCount, 2);
  assert.equal(plan.operations.map(item => item.sequence).join(','), plan.operations.map((_, index) => index + 1).join(','));
  const activation = plan.operations.find(item => item.operationId === 'activate_observed_relation')!;
  assert.match(activation.sql ?? '', /INNER JOIN/);
  assert.doesNotMatch(activation.sql ?? '', /DISTINCT|CAST|TRIM|COALESCE|PRIMARY KEY|FOREIGN KEY/i);
  assert.equal(activation.sqlSha256, createHash('sha256').update(activation.sql!, 'utf8').digest('hex'));
  assert.equal(plan.operations.find(item => item.operationId === 'compile_versioned_model')?.sql?.includes('varchar(512)'), true);
  assert.equal(plan.operations.find(item => item.operationId === 'verify_observed_relation_sample')?.sql?.endsWith('LIMIT 50'), true);
  assert.ok(plan.gates.some(gate => gate.code === 'backend_dialect_and_server_capability_unconfirmed'));
  assert.ok(plan.gates.some(gate => gate.code === 'source_binding_hash_confirmation_required'));
  const check = checkUslLifecyclePlan(plan, f.manifest, f.input, f.binding);
  assert.equal(check.status, 'CURRENT');
  assert.equal(assessUslLifecycleApplyGate(plan, check).canApply, false);
});

test('Zetaris keeps the default JOIN guard and permits only exact plan-bound publication SQL with a scoped grant', async () => {
  const f = fixture(), plan = compileUslLifecyclePlan(f.manifest, f.input, f.binding);
  if (plan.status !== 'PREPARED') throw new Error('SYNTHETIC_PLAN_NOT_PREPARED');
  const operation = plan.operations.find(item => item.operationId === 'activate_observed_relation')!;
  const authorizedOperation = { operationId: operation.operationId, objectRef: operation.objectRef, sql: operation.sql!, sqlSha256: operation.sqlSha256! };
  const grant = { schemaVersion: 1 as const, grantId: 'synthetic-live-grant', scope: 'LIVE_USL_PUBLICATION' as const, planFingerprint: plan.fingerprint,
    targetRef: `${plan.target.namespace}.${plan.target.model}`, sourceBindingSha256: plan.sourceBinding.bindingSha256,
    operationSqlSha256s: plan.operations.flatMap(item => item.sqlSha256 ? [item.sqlSha256] : []), approvedBy: 'synthetic-test',
    approvedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const client = new Zetaris({ base: 'http://localhost', key: 'synthetic', org: '1' });
  const priorFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    await assert.rejects(client.runSql(authorizedOperation.sql), /FORBIDDEN_SQL/);
    await assert.rejects(client.runAuthorizedPublicationSql(authorizedOperation, { ...grant, planFingerprint: '0'.repeat(64) }, plan), /EXACT_LIVE_PUBLICATION_GRANT_REQUIRED/);
    await assert.rejects(client.runAuthorizedPublicationSql({ ...authorizedOperation, objectRef: `${plan.target.namespace}.foreign.ObservedRelation` }, grant, plan), /EXACT_LIVE_PUBLICATION_GRANT_REQUIRED/);
    assert.equal(calls, 0);
    const result = await client.runAuthorizedPublicationSql(authorizedOperation, grant, plan);
    assert.equal(result.sql, authorizedOperation.sql);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = priorFetch; }
});

test('USL lifecycle projection verifies exact text values and duplicate multiplicity', () => {
  const f = fixture();
  const observations = f.input.evidence[0].observations.map(observation => ({ ...observation, measuredTuples: [['01', 'a'], ['1', 'b'], ['01', 'a']] }));
  const input = { ...f.input, evidence: [{ ...f.input.evidence[0], observations }] };
  const manifest = compilePublicationPlan(input), plan = compileUslLifecyclePlan(manifest, input, f.binding);
  assert.equal(plan.expectedProjection?.rowCount, 5);
  const rows = [['01', '01', 'a', 'a'], ['01', '01', 'a', 'a'], ['01', '01', 'a', 'a'], ['01', '01', 'a', 'a'], ['1', '1', 'b', 'b']];
  assert.deepEqual(verifyObservedRelationRows(plan, rows), { status: 'PASS', rowCount: 5, duplicateRowCount: 3, reasons: [] });
  assert.equal(verifyObservedRelationRows(plan, [...rows.slice(0, 4), ['01', '01', 'a', 'a']]).status, 'FAIL');
  assert.equal(verifyObservedRelationRows(plan, rows.map((row, index) => index === 4 ? [1, '1', 'b', 'b'] : row)).status, 'FAIL');
});

test('USL loaded-definition verification matches observed response shape and rejects type or inline constraints', () => {
  const f = fixture(), plan = compileUslLifecyclePlan(f.manifest, f.input, f.binding);
  const activation = plan.operations.find(item => item.operationId === 'activate_observed_relation')!.sql!.replace(/^ACTIVATE USL TABLE \S+ AS /, '');
  const loaded = { namespace: ['metastore', 'concordia_l4_json2_20261023'], name: plan.target.model, tables: [{
    namespace: ['lightning', 'metastore', 'concordia_l4_json2_20261023', plan.target.model], name: 'ObservedRelation',
    columnSpecs: plan.columnDefinitions.map(column => ({ name: column.name, dataType: JSON.stringify(column.type) })), unique: [], foreignKeys: [], checks: [], dqAnnotations: [], acAnnotations: [], activateQuery: activation
  }] };
  assert.deepEqual(verifyLoadedUslModel(plan, loaded), { status: 'PASS', reasons: [] });
  const wrongType = structuredClone(loaded); wrongType.tables[0].columnSpecs[0].dataType = '"varchar(128)"';
  assert.ok(verifyLoadedUslModel(plan, wrongType).reasons.includes('loaded_column_type_mismatch'));
  const inlineConstraint: any = structuredClone(loaded); inlineConstraint.tables[0].columnSpecs[0].foreignKey = ['parent.id'];
  assert.ok(verifyLoadedUslModel(plan, inlineConstraint).reasons.includes('loaded_constraints_unexpected'));
  const inlinePrimaryKey: any = structuredClone(loaded); inlinePrimaryKey.tables[0].columnSpecs[0].primaryKey = true;
  assert.ok(verifyLoadedUslModel(plan, inlinePrimaryKey).reasons.includes('loaded_constraints_unexpected'));
  const wrongNamespace: any = structuredClone(loaded); wrongNamespace.tables[0].namespace = ['lightning', 'metastore', 'wrong', plan.target.model];
  assert.ok(verifyLoadedUslModel(plan, wrongNamespace).reasons.includes('loaded_column_schema_mismatch'));
});

test('USL lifecycle plan blocks unsafe bindings, stale publication inputs, and all apply attempts', () => {
  const f = fixture();
  const unknownType = structuredClone(f.binding); unknownType.mappings[0].keyColumns[0].valueType = 'UNKNOWN';
  const blocked = compileUslLifecyclePlan(f.manifest, f.input, unknownType);
  assert.equal(blocked.status, 'BLOCKED');
  assert.ok(blocked.gates.some(gate => gate.code === 'source_binding_key_column_text_mapping_required'));
  const changedBinding = structuredClone(f.binding); changedBinding.mappings[0].keyColumns[0].physicalColumn = 'changed_key';
  const plan = compileUslLifecyclePlan(f.manifest, f.input, f.binding);
  assert.equal(checkUslLifecyclePlan(plan, f.manifest, f.input, changedBinding).status, 'STALE');
  assert.equal(assessUslLifecycleApplyGate(plan, { status: 'STALE', staleInputs: ['workflow_inputs'] }).canApply, false);
});

test('live target catalog and verification reads fail closed on incomplete pages and unowned objects', async () => {
  const f = fixture(), plan = compileUslLifecyclePlan(f.manifest, f.input, f.binding);
  let catalogCalls = 0;
  const incompleteClient: any = { runSql: async () => { catalogCalls++; const rows = Array.from({ length: 50 }, (_, index) => [`namespace_${index}`, 'namespace']); return { rows, rawRowsReceived: rows.length, totalReported: false, continuationPresent: false }; } };
  const grant: any = { schemaVersion: 1, grantId: 'synthetic', scope: 'LIVE_USL_PUBLICATION' };
  const incompleteAdapter = new ZetarisUslLifecycleAdapter(plan, grant, incompleteClient, {}, `catalog-incomplete-${randomUUID()}`, ROOT);
  await assert.rejects(incompleteAdapter.readSnapshot(), /USL_PARENT_CATALOG_INCOMPLETE/);
  assert.equal(catalogCalls, 1);

  const completeCatalogClient: any = { runSql: async (sql: string) => {
    const rows = sql.includes('lightning.metastore.synthetic') ? [['legacy_unrecognized_model', 'usl']] : [[plan.target.namespace.split('.').at(-1), 'namespace']];
    return { rows, rawRowsReceived: rows.length, totalReported: true, reportedTotal: rows.length, continuationPresent: false };
  } };
  const foreignAdapter = new ZetarisUslLifecycleAdapter(plan, grant, completeCatalogClient, {}, `catalog-foreign-${randomUUID()}`, ROOT);
  const snapshot = await foreignAdapter.readSnapshot();
  assert.equal(snapshot.namespaceState, 'FOREIGN');
  assert.equal(snapshot.versions.length, 0);
});
test('live source preflight compares fresh key projection with the sealed evidence projection', () => {
  const expected = { transportStatus: 'OK', truncated: false, measuredTuples: [['01', 'a'], ['2', 'b']] };
  assert.equal(sourceKeyProjectionMatches(expected, { ...expected, measuredTuples: [['2', 'b'], ['01', 'a']] }), true);
  assert.equal(sourceKeyProjectionMatches(expected, { ...expected, measuredTuples: [['01', 'a'], ['3', 'b']] }), false);
  assert.equal(sourceKeyProjectionMatches(expected, { ...expected, truncated: true }), false);
  assert.equal(sourceKeyProjectionMatches(expected, { ...expected, transportStatus: 'ERROR' }), false);
});
test('default Zetaris catalog adapter recognizes only confirmed ownership and exposes activated versions provisionally', async () => {
  const f = fixture(), plan = compileUslLifecyclePlan(f.manifest, f.input, f.binding), runId = `catalog-receipt-${randomUUID().replaceAll('-', '')}`;
  const journalPath = `.concordia/publication-runs/${runId}/journal.jsonl`, versionRef = `${plan.target.namespace}.${plan.target.model}`;
  const journal = new FilePublicationJournal(path.join(ROOT, journalPath), ROOT), contentFingerprint = 'c'.repeat(64);
  try {
    await journal.withExclusiveLock(async locked => {
      const base: any = { schemaVersion: 1, runId, manifestId: `publication:${plan.fingerprint.slice(0, 24)}`, fingerprint: plan.fingerprint,
        idempotencyToken: plan.fingerprint, universeId: plan.universeId, targetKey: versionRef, adapterId: 'zetaris-usl-plan-scoped-v1',
        executionMode: 'LIVE', dataOrigin: 'SYNTHETIC', at: '2026-10-23T00:00:00Z', versionId: versionRef, contentFingerprint,
        requestId: 'synthetic-request', queryId: 'synthetic-query', operationStatus: 'OK', lifecyclePlanSnapshot: plan };
      locked.append({ ...base, sequence: 1, eventId: `${plan.fingerprint}:1:applied`, state: 'applied', operationId: 'create_target_namespace' });
      locked.append({ ...base, sequence: 2, eventId: `${plan.fingerprint}:2:applied`, state: 'applied', operationId: 'activate_observed_relation' });
    });
    const client: any = { runSql: async (sql: string) => {
      const rows = sql === 'SHOW NAMESPACES OR TABLES IN ' + plan.target.namespace ? [[plan.target.model, 'usl']] : [[plan.target.namespace.split('.').at(-1), 'namespace']];
      return { rows, rawRowsReceived: rows.length, totalReported: true, reportedTotal: rows.length, continuationPresent: false };
    } };
    const grant: any = { schemaVersion: 1, grantId: 'synthetic', scope: 'LIVE_USL_PUBLICATION' };
    const first = new ZetarisUslLifecycleAdapter(plan, grant, client, {}, `${runId}-first`, ROOT);
    const snapshot = await first.readSnapshot();
    assert.equal(snapshot.namespaceState, 'OWNED');
    assert.deepEqual(snapshot.versions, [{ versionId: versionRef, planFingerprint: plan.fingerprint, contentFingerprint, servable: true }]);
    assert.equal(snapshot.activeVersionRef, versionRef);
    const reconstructed = new ZetarisUslLifecycleAdapter(plan, grant, client, {}, `${runId}-second`, ROOT);
    assert.equal((await reconstructed.readSnapshot()).versions[0].versionId, versionRef);
  } finally {
    const absoluteJournal = path.join(ROOT, journalPath), runDirectory = path.dirname(absoluteJournal);
    if (fs.existsSync(absoluteJournal)) fs.rmSync(absoluteJournal);
    if (fs.existsSync(runDirectory)) fs.rmdirSync(runDirectory);
  }
});
test('default Zetaris adapter completes apply, cross-run reuse, and cross-version recovery with a fake SQL transport', async () => {
  const runId = `default-live-${randomUUID().replaceAll('-', '')}`, projectRoot = path.join(ROOT, '.concordia', `${runId}-project`);
  fs.mkdirSync(path.join(projectRoot, '.concordia'), { recursive: true });
  const priorFetch = globalThis.fetch, f = fixture();
  try {
    const schemaRows = [['key_a', 'string'], ['key_b', 'string']], sourceRows = [['01', 'a'], ['1', 'b']];
    const makeTable = (tableId: string, sourceId: string, logicalObjectId: string, physicalTable: string, columns: { name: string; kind: 'string' }[]) => ({
      manifestId: 'synthetic.manifest', profileAlias: 'SYNTHETIC', tableId, sourceId, logicalObjectId, physicalDatabase: 'json2', physicalTable, columns,
      expectedRows: 2, maxRows: 20, readLimit: 50, observedSchemaSha256: canonicalJson2SchemaSha256(columns.map(column => [column.name, column.kind])),
      typedMultisetSha256: canonicalJson2TypedMultisetSha256(sourceRows, columns), fingerprintAlgorithm: 'CANONICAL_TYPED_ROWS_MULTISET_V1' as const, dataOrigin: 'SYNTHETIC' as const
    });
    const bindingDocument: any = { schemaVersion: 1, bindingId: 'synthetic-binding', bindingVersion: '1.0.0', status: 'ROOT_REVIEWED_FOR_BOUNDED_READ_ONLY_CONSUMPTION',
      reviewedAtUtc: '2026-10-23T12:00:00Z', registrationPlanFingerprint: 'a'.repeat(64), packageSealSha256: 'b'.repeat(64), registrationJournalSha256: 'c'.repeat(64),
      backendEngineVersion: 'synthetic-json2-1', profileConfigPath: 'universes/synthetic.json', wireEncoding: 'SQL_EDITOR_STRING_CELLS_CANONICAL_INTEGER_V1', wireEvidenceSha256: 'd'.repeat(64),
      readLimit: 50, maxRowsPerTable: 20, requiresFreshSchemaAndTypedMultisetCheckBeforeUse: true, sqlMutationAllowed: false, uslAllowed: false,
      tables: [makeTable('child', 'source-child', 'child', 'trips', [{ name: 'key_a', kind: 'string' }, { name: 'key_b', kind: 'string' }]),
        makeTable('parent', 'source-parent', 'parent', 'routes', [{ name: 'key_x', kind: 'string' }, { name: 'key_y', kind: 'string' }])] };
    const rawBindingBytes = Buffer.from(JSON.stringify(bindingDocument));
    const binding: PublicationSourceBinding = { bindingId: bindingDocument.bindingId, bindingVersion: bindingDocument.bindingVersion, bindingSha256: createHash('sha256').update(rawBindingBytes).digest('hex'), uslAllowed: false,
      mappings: [{ sourceId: 'source-child', logicalObjectId: 'child', physicalDatabase: 'json2', physicalTable: 'trips', keyColumns: [{ logicalColumn: 'key_a', physicalColumn: 'key_a', valueType: 'TEXT' }, { logicalColumn: 'key_b', physicalColumn: 'key_b', valueType: 'TEXT' }] },
        { sourceId: 'source-parent', logicalObjectId: 'parent', physicalDatabase: 'json2', physicalTable: 'routes', keyColumns: [{ logicalColumn: 'key_x', physicalColumn: 'key_x', valueType: 'TEXT' }, { logicalColumn: 'key_y', physicalColumn: 'key_y', valueType: 'TEXT' }] }] };
    const makePlan = (input: any) => { const manifest = compilePublicationPlan(input); return { manifest, plan: compileUslLifecyclePlan(manifest, input, binding) }; };
    const initialSnapshotState = { parent: 'lightning.metastore', parentEntries: [], namespace: f.input.target.namespace, childEntries: [], namespaceState: 'ABSENT', receipts: [] };
    const initialSnapshotJson = JSON.stringify(initialSnapshotState, (_key, item) => !item || typeof item !== 'object' || Array.isArray(item) ? item : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))));
    const initialTargetFingerprint = createHash('sha256').update(initialSnapshotJson).digest('hex');
    const initialInput = { ...f.input, targetState: { ...f.input.targetState!, fingerprint: initialTargetFingerprint } };
    const first = makePlan(initialInput), outputRows = [['01', '01', 'a', 'a'], ['1', '1', 'b', 'b']];
    const plans = new Map([[first.plan.target.model, first.plan]]);
    let namespaceCreated = false, activatedModels = new Set<string>(), failLoadModel: string | null = null;
    const activeModel = (sql: string) => sql.match(/^LOAD USL ([A-Za-z0-9_]+) NAMESPACE /)?.[1] ?? '';
    globalThis.fetch = async (_url, init) => {
      const { sql } = JSON.parse(String(init?.body)); let rows: unknown[][] = [];
      if (sql === 'SHOW NAMESPACES OR TABLES IN lightning.metastore') rows = namespaceCreated ? [[first.plan.target.namespace.split('.').at(-1), 'namespace']] : [];
      else if (sql === `SHOW NAMESPACES OR TABLES IN ${first.plan.target.namespace}`) rows = [...activatedModels].map(model => [model, 'usl']);
      else if (sql.startsWith('DESCRIBE DATASOURCE TABLE')) rows = sql.endsWith('.routes') ? [['key_x', 'string'], ['key_y', 'string']] : schemaRows;
      else if (sql.startsWith('SELECT key_a, key_b FROM json2.trips') || sql.startsWith('SELECT key_x, key_y FROM json2.routes')) rows = sourceRows;
      else if (sql.startsWith('CREATE NAMESPACE')) namespaceCreated = true;
      else if (sql.startsWith('ACTIVATE USL TABLE')) { const model = sql.match(/^ACTIVATE USL TABLE (.+?)\.ObservedRelation AS /)?.[1]?.split('.').at(-1); if (model) activatedModels.add(model); }
      else if (sql.startsWith('LOAD USL')) {
        const modelName = activeModel(sql);
        if (failLoadModel === modelName) return new Response(JSON.stringify({ success: false, error: 'synthetic load failure' }), { status: 200, headers: { 'content-type': 'application/json' } });
        const modelPlan = plans.get(modelName)!;
        const activation = modelPlan.operations.find(operation => operation.operationId === 'activate_observed_relation')!.sql!.replace(/^ACTIVATE USL TABLE \S+ AS /, '');
        const loaded = { namespace: modelPlan.target.namespace.split('.').slice(1), name: modelName, tables: [{ namespace: [...modelPlan.target.namespace.split('.'), modelName], name: 'ObservedRelation',
          columnSpecs: modelPlan.columnDefinitions.map(column => ({ name: column.name, dataType: column.type })), unique: [], foreignKeys: [], checks: [], dqAnnotations: [], acAnnotations: [], activateQuery: activation }] };
        rows = [[JSON.stringify(loaded)]];
      } else if (sql.startsWith('SELECT source_key_')) rows = outputRows;
      return new Response(JSON.stringify({ data: rows, total: rows.length }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const makeGrant = (plan: ReturnType<typeof compileUslLifecyclePlan>, manifest: ReturnType<typeof compilePublicationPlan>, input: any) => {
      const dialect = { schemaVersion: 1, status: 'CONFIRMED', dialectId: 'synthetic-dialect', backendEngineVersion: 'synthetic-1',
        supportedOperationIds: plan.operations.filter(operation => operation.sql).map(operation => operation.operationId), reviewedBy: 'synthetic-test', reviewedAt: '2026-10-23T12:00:00Z' };
      const dialectBytes = Buffer.from(JSON.stringify(dialect));
      const grant: any = { schemaVersion: 1, grantId: `grant-${plan.fingerprint.slice(0, 12)}`, scope: 'LIVE_USL_PUBLICATION', planFingerprint: plan.fingerprint,
        targetRef: `${plan.target.namespace}.${plan.target.model}`, sourceBindingSha256: binding.bindingSha256, sourceBindingFingerprint: plan.inputFingerprints.binding,
        operationSqlSha256s: plan.operations.flatMap(operation => operation.sqlSha256 ? [operation.sqlSha256] : []), approvedBy: 'synthetic-test',
        approvedAt: '2026-10-23T12:00:00Z', expiresAt: '2027-10-23T12:00:00Z', dialectId: dialect.dialectId, dialectEvidenceSha256: createHash('sha256').update(dialectBytes).digest('hex') };
      return { grant, dialectBytes };
    };
    const client = new Zetaris({ base: 'http://localhost', key: 'synthetic', org: '1' });
    const journal = (id: string) => new FilePublicationJournal(path.join(projectRoot, '.concordia', 'publication-runs', id, 'journal.jsonl'), projectRoot);
    const makeAdapter = (plan: ReturnType<typeof compileUslLifecyclePlan>, grant: any, id: string, input: any) => new ZetarisUslLifecycleAdapter(plan, grant, client, {}, id, projectRoot, bindingDocument, input);
    const firstAuth = makeGrant(first.plan, first.manifest, initialInput), firstAdapter = makeAdapter(first.plan, firstAuth.grant, `${runId}-apply`, initialInput);
    const applied = await executeAuthorizedUslLifecycle(first.plan, first.manifest, initialInput, binding, rawBindingBytes, firstAuth.dialectBytes, firstAuth.grant, firstAdapter, journal(`${runId}-apply`), `${runId}-apply`);
    assert.equal(applied.status, 'VERIFIED', JSON.stringify(applied));
    assert.ok(readNamespacePublicationEvents(first.plan.target.namespace, projectRoot).some(event => event.state === 'verified' && event.fingerprint === first.plan.fingerprint));
    const reuseAuth = makeGrant(first.plan, first.manifest, initialInput), reuseAdapter = makeAdapter(first.plan, reuseAuth.grant, `${runId}-reuse`, initialInput);
    const reused = await executeAuthorizedUslLifecycle(first.plan, first.manifest, initialInput, binding, rawBindingBytes, reuseAuth.dialectBytes, reuseAuth.grant, reuseAdapter, journal(`${runId}-reuse`), `${runId}-reuse`, Date.now(), 'REUSE');
    assert.equal(reused.status, 'REUSED', JSON.stringify(reused));
    const current = await reuseAdapter.readSnapshot(); reuseAdapter.drainAuditReads();
    const inputV2 = { ...f.input, target: { ...f.input.target, model: 'concordia_l4_observed_v2' }, targetState: { fingerprint: current.targetStateFingerprint, observedAt: new Date().toISOString() } };
    const second = makePlan(inputV2); plans.set(second.plan.target.model, second.plan);
    const secondAuth = makeGrant(second.plan, second.manifest, inputV2); failLoadModel = second.plan.target.model;
    const secondAdapter = makeAdapter(second.plan, secondAuth.grant, `${runId}-v2`, inputV2);
    const failed = await executeAuthorizedUslLifecycle(second.plan, second.manifest, inputV2, binding, rawBindingBytes, secondAuth.dialectBytes, secondAuth.grant, secondAdapter, journal(`${runId}-v2`), `${runId}-v2`);
    assert.equal(failed.status, 'RECOVERED');
    assert.equal(failed.passed, false);
    const recoveryAdapter = makeAdapter(second.plan, secondAuth.grant, `${runId}-recover`, inputV2);
    const recovered = await recoverAuthorizedUslLifecycle(second.plan, second.manifest, inputV2, binding, rawBindingBytes, secondAuth.dialectBytes, secondAuth.grant, recoveryAdapter, journal(`${runId}-recover`), `${runId}-recover`);
    assert.equal(recovered.status, 'RECOVERED');
    assert.equal(recovered.passed, true);
  } finally {
    globalThis.fetch = priorFetch;
    const resolvedProject = path.resolve(projectRoot), allowed = path.resolve(ROOT, '.concordia');
    const relative = path.relative(allowed, resolvedProject);
    if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && fs.existsSync(resolvedProject)) fs.rmSync(resolvedProject, { recursive: true });
  }
});
test('observed Zetaris metadata parsers and adapter perform fresh plan-specific LOAD/SELECT reads', async () => {
  const f = fixture(), plan = compileUslLifecyclePlan(f.manifest, f.input, f.binding);
  assert.deepEqual(parseNamespaceCatalogRows([['concordia_u1', 'namespace', null, '1', null], ['concordia_l4_test', 'namespace', null, '1', null]]), [
    { name: 'concordia_u1', kind: 'namespace' }, { name: 'concordia_l4_test', kind: 'namespace' }
  ]);
  const activation = plan.operations.find(item => item.operationId === 'activate_observed_relation')!.sql!.replace(/^ACTIVATE USL TABLE \S+ AS /, '');
  const model = { namespace: plan.target.namespace.split('.').slice(1), name: plan.target.model, tables: [{
    namespace: [...plan.target.namespace.split('.'), plan.target.model], name: 'ObservedRelation',
    columnSpecs: plan.columnDefinitions.map(column => ({ name: column.name, dataType: JSON.stringify(column.type) })), unique: [], foreignKeys: [], checks: [], ifNotExit: false,
    dqAnnotations: [], acAnnotations: [], activateQuery: activation
  }] };
  assert.deepEqual(decodeLoadedUslModelRows([[JSON.stringify(model)]]), model);
  const outputRows = [['01', '01', 'a', 'a'], ['1', '1', 'b', 'b']];
  const queryLog: string[] = [], priorFetch = globalThis.fetch; let continuationForNext = false;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)), sql = String(body.sql); queryLog.push(sql);
    const rows = sql.startsWith('LOAD USL') ? [[JSON.stringify(model)]] : outputRows;
    const hasMore = continuationForNext; continuationForNext = false;
    return new Response(JSON.stringify({ data: rows, hasMore }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new Zetaris({ base: 'http://localhost', key: 'synthetic', org: '1' });
    const readers = {
      readTargetSnapshot: async () => ({ targetStateFingerprint: 'a'.repeat(64), observedAt: '2026-10-23T00:00:00Z', namespaceState: 'ABSENT' as const, namespaceOwnerFingerprint: null, activeVersionRef: null, versions: [] }),
      recheckInputs: async () => ({ status: 'CURRENT' as const })
    };
    const grant: any = { schemaVersion: 1, grantId: 'test-grant', scope: 'LIVE_USL_PUBLICATION', planFingerprint: plan.fingerprint, targetRef: `${plan.target.namespace}.${plan.target.model}`, sourceBindingSha256: f.binding.bindingSha256, operationSqlSha256s: plan.operations.flatMap(item => item.sqlSha256 ? [item.sqlSha256] : []), approvedBy: 'test', approvedAt: '2026-10-23T00:00:00Z', expiresAt: '2027-10-23T00:00:00Z' };
    const adapter1 = new ZetarisUslLifecycleAdapter(plan, grant, client, readers, 'readback-one', ROOT);
    const load = plan.operations.find(item => item.operationId === 'load_model_for_definition_check')!;
    const sample = plan.operations.find(item => item.operationId === 'verify_observed_relation_sample')!;
    continuationForNext = true;
    assert.equal((await adapter1.runOperation(load, plan)).status, 'UNKNOWN');
    assert.equal((await adapter1.runOperation(load, plan)).status, 'OK');
    assert.deepEqual(await adapter1.readLoadedModel(plan), model);
    assert.deepEqual(await adapter1.readLoadedModel(plan), model);
    assert.equal(queryLog.filter(sql => sql.startsWith('LOAD USL')).length, 3);
    continuationForNext = true;
    assert.equal((await adapter1.runOperation(sample, plan)).status, 'UNKNOWN');
    assert.equal((await adapter1.runOperation(sample, plan)).status, 'OK');
    assert.deepEqual(await adapter1.readObservedRows(plan), outputRows);
    assert.deepEqual(await adapter1.readObservedRows(plan), outputRows);
    assert.equal(queryLog.filter(sql => sql.startsWith('SELECT')).length, 3);
    const adapter2 = new ZetarisUslLifecycleAdapter(plan, grant, client, readers, 'readback-two', ROOT);
    assert.deepEqual(await adapter2.readLoadedModel(plan), model);
    assert.equal(queryLog.filter(sql => sql.startsWith('LOAD USL')).length, 4);
  } finally { globalThis.fetch = priorFetch; }
});

test('live client pointer store uses confined compare-and-set semantics', () => {
  const namespace = `lightning.metastore.synthetic_${randomUUID().replaceAll('-', '')}`, pointer = new FileUslClientPointerStore(namespace, ROOT);
  const target = 'lightning.metastore.synthetic.model_v1';
  assert.equal(pointer.read(), null);
  assert.equal(pointer.compareAndSet(null, 'lightning.metastore.synthetic.model_v1'), true);
  assert.equal(pointer.compareAndSet(null, 'lightning.metastore.synthetic.model_v2'), false);
  assert.equal(pointer.read(), 'lightning.metastore.synthetic.model_v1');
  assert.equal(new FileUslClientPointerStore(namespace, ROOT).read(), 'lightning.metastore.synthetic.model_v1');
  assert.equal(pointer.compareAndSet('lightning.metastore.synthetic.model_v1', 'lightning.metastore.synthetic.model_v2'), true);
  assert.equal(pointer.read(), 'lightning.metastore.synthetic.model_v2');
});

test('publication target lock excludes a second run id for the same target', async () => {
  const runs = path.join(ROOT, '.concordia', 'publication-runs'), tag = randomUUID().replaceAll('-', ''), runA = path.join(runs, `target-a-${tag}`), runB = path.join(runs, `target-b-${tag}`);
  const first = new FilePublicationJournal(path.join(runA, 'journal.jsonl'), ROOT), second = new FilePublicationJournal(path.join(runB, 'journal.jsonl'), ROOT);
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const active = first.withTargetLock('lightning.metastore.synthetic.model_v1', async () => { entered(); await hold; });
  try {
    await ready;
    await assert.rejects(second.withTargetLock('lightning.metastore.synthetic.model_v1', async () => undefined), /PUBLICATION_TARGET_WRITER_EXISTS/);
  } finally { release(); await active; }
  assert.equal(fs.existsSync(path.join(runs, 'target-locks', `${createHash('sha256').update('lightning.metastore.synthetic.model_v1').digest('hex')}.lock`)), false);
  for (const directory of [runA, runB]) if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
});

test('namespace history keeps numeric sequence order for same-time events', async () => {
  const runId = `same-time-${randomUUID().replaceAll('-', '')}`, namespace = `lightning.metastore.${runId}`, fingerprint = 'd'.repeat(64);
  const journalPath = `.concordia/publication-runs/${runId}/journal.jsonl`, absoluteJournal = path.join(ROOT, journalPath);
  const journal = new FilePublicationJournal(absoluteJournal, ROOT);
  try {
    await journal.withExclusiveLock(async locked => {
      for (let sequence = 1; sequence <= 12; sequence++) locked.append({ schemaVersion: 1, eventId: `${fingerprint}:${sequence}:read`, sequence, runId, state: 'read',
        manifestId: `publication:${fingerprint.slice(0, 24)}`, fingerprint, idempotencyToken: fingerprint, universeId: 'synthetic.universe', targetKey: `${namespace}.model`,
        adapterId: 'synthetic-history', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', at: '2026-10-23T00:00:00Z', operationId: `read-${sequence}`,
        requestId: `request-${sequence}`, queryId: `query-${sequence}`, operationStatus: 'OK' });
    });
    assert.deepEqual(readNamespacePublicationEvents(namespace, ROOT).map(event => event.sequence), Array.from({ length: 12 }, (_, index) => index + 1));
  } finally {
    if (fs.existsSync(absoluteJournal)) fs.rmSync(absoluteJournal);
    if (fs.existsSync(path.dirname(absoluteJournal))) fs.rmdirSync(path.dirname(absoluteJournal));
  }
});
test('publication history is bounded, read-only, and confined to the isolated run tree', () => {
  const concordia = path.join(ROOT, '.concordia'), runs = path.join(concordia, 'publication-runs'), run = `test-${randomUUID().replaceAll('-', '')}`;
  const directory = path.join(runs, run), journal = path.join(directory, 'journal.jsonl');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(journal, '');
  const before = fs.statSync(journal).mtimeMs;
  assert.deepEqual(readPublicationJournalHistory(journal, ROOT), []);
  assert.equal(fs.statSync(journal).mtimeMs, before);
  assert.throws(() => readPublicationJournalHistory(path.join(ROOT, '.concordia', 'outside', 'journal.jsonl'), ROOT), /OUTSIDE_PROJECT_RUNS/);
  fs.rmSync(journal);
  fs.rmdirSync(directory);
});

test('publication lifecycle CLI plans, simulates apply/reuse/recovery, and reads history without env or network', () => {
  const directory = path.join(ROOT, '.concordia', 'publication-plans'), runs = path.join(ROOT, '.concordia', 'publication-runs');
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(runs, { recursive: true });
  const slug = `lifecycle-${randomUUID().replaceAll('-', '')}`;
  const inputPath = `.concordia/publication-plans/${slug}.input.json`, absoluteInput = path.join(ROOT, inputPath);
  const guard = path.join(directory, `${slug}.guard.mjs`), statePath = path.join(directory, `${slug}.simulation.json`), runDir = path.join(runs, slug), journal = path.join(runDir, 'journal.jsonl');
  const syntheticRows = [['01', '01', 'a', 'a'], ['1', '1', 'b', 'b']];
  const f = fixture();
  const makeGrant = (plan: ReturnType<typeof compileUslLifecyclePlan>) => ({ schemaVersion: 1 as const, grantId: `grant-${plan.fingerprint.slice(0, 12)}`, scope: 'LOCAL_SYNTHETIC_SIMULATION' as const,
    planFingerprint: plan.fingerprint, targetRef: `${plan.target.namespace}.${plan.target.model}`, sourceBindingSha256: f.binding.bindingSha256, sourceBindingFingerprint: plan.inputFingerprints.binding,
    operationSqlSha256s: plan.operations.flatMap(operation => operation.sqlSha256 ? [operation.sqlSha256] : []), approvedBy: 'synthetic-test', approvedAt: '2026-10-22T00:00:00.000Z', expiresAt: '2027-10-22T00:00:00.000Z' });
  const plan1 = compileUslLifecyclePlan(f.manifest, f.input, f.binding);
  let v2PlanPath = '';
  let v1PlanPath = '';
  fs.writeFileSync(guard, `import http from 'node:http'; import https from 'node:https'; globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); }; for (const client of [http, https]) for (const method of ['request', 'get']) client[method] = () => { throw new Error('NETWORK_FORBIDDEN'); };`);
  const state = { schemaVersion: 1, adapterId: 'local-synthetic-usl-fixture', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', targetStateFingerprint: f.input.targetState!.fingerprint,
    observedAt: f.input.targetState!.observedAt, namespaceState: 'ABSENT', namespaceOwnerFingerprint: null, activeVersionRef: null, localClientPointer: null, versions: [], loadedModelsByVersion: {}, observedRowsByPlanFingerprint: { [plan1.fingerprint]: syntheticRows } };
  fs.writeFileSync(statePath, JSON.stringify(state));
  const runCli = (args: string[]) => spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, fileURLToPath(import.meta.resolve('tsx/cli')), path.join(ROOT, 'src/cli.ts'), 'publication', ...args],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CONCORDIA_LOCAL_ENV_FILE: path.join(directory, `${slug}.missing.env`) } });
  const journalPath = `.concordia/publication-runs/${slug}/journal.jsonl`, reuseJournalPath = `.concordia/publication-runs/${slug}-reuse/journal.jsonl`, journal2Path = `.concordia/publication-runs/${slug}-v2/journal.jsonl`, stateArg = `.concordia/publication-plans/${slug}.simulation.json`;
  try {
    const envelope1 = { publicationManifest: f.manifest, publicationInput: f.input, sourceBinding: f.binding, authorizationGrant: makeGrant(plan1) };
    fs.writeFileSync(absoluteInput, JSON.stringify(envelope1));
    const first = runCli(['lifecycle-plan', '--input', inputPath]);
    assert.equal(first.status, 0, first.stderr);
    const response1 = JSON.parse(first.stdout);
    assert.equal(response1.executable, false);
    v1PlanPath = `.concordia/publication-plans/${slug}.${response1.fingerprint.slice(0, 24)}.plan.json`;
    const absolutePlan1 = path.join(ROOT, v1PlanPath);
    assert.equal(fs.existsSync(absolutePlan1), false);
    fs.writeFileSync(absolutePlan1, JSON.stringify(response1.plan));
    const check = runCli(['lifecycle-check', '--input', inputPath, '--plan', v1PlanPath]);
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).status, 'CURRENT');
    assert.equal(JSON.parse(check.stdout).canApply, false);

    const badGrantEnvelope = { ...envelope1, authorizationGrant: { ...envelope1.authorizationGrant, planFingerprint: '0'.repeat(64) } };
    fs.writeFileSync(absoluteInput, JSON.stringify(badGrantEnvelope));
    const denied = runCli(['lifecycle-simulate', '--action', 'apply', '--input', inputPath, '--plan', v1PlanPath, '--simulation-state', stateArg, '--journal', journalPath, '--run-id', `${slug}-denied`]);
    assert.equal(denied.status, 1);
    assert.equal(JSON.parse(denied.stdout).reason, 'EXACT_LOCAL_SYNTHETIC_GRANT_REQUIRED');
    assert.equal(fs.existsSync(journal), false);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).localClientPointer, null);
    const staleState = JSON.parse(fs.readFileSync(statePath, 'utf8')); staleState.staleOnRecheck = true; fs.writeFileSync(statePath, JSON.stringify(staleState));
    fs.writeFileSync(absoluteInput, JSON.stringify(envelope1));
    const staleApply = runCli(['lifecycle-simulate', '--action', 'apply', '--input', inputPath, '--plan', v1PlanPath, '--simulation-state', stateArg, '--journal', journalPath, '--run-id', `${slug}-stale`]);
    assert.equal(staleApply.status, 1);
    assert.match(JSON.parse(staleApply.stdout).reason, /STALE_SOURCE_INPUTS/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).versions.length, 0);
    const freshState = JSON.parse(fs.readFileSync(statePath, 'utf8')); freshState.staleOnRecheck = false; fs.writeFileSync(statePath, JSON.stringify(freshState));
    const apply = runCli(['lifecycle-simulate', '--action', 'apply', '--input', inputPath, '--plan', v1PlanPath, '--simulation-state', stateArg, '--journal', journalPath, '--run-id', `${slug}-v1`]);
    assert.equal(apply.status, 0, `stderr=${apply.stderr} stdout=${apply.stdout}`);
    assert.equal(JSON.parse(apply.stdout).status, 'VERIFIED');
    assert.equal(JSON.parse(apply.stdout).liveSqlExecuted, false);
    const eventsAfterApply = readPublicationJournalHistory(journal, ROOT);
    assert.ok(eventsAfterApply.find(event => event.state === 'verified' && event.versionId === `${plan1.target.namespace}.${plan1.target.model}`)?.lifecyclePlanSnapshot);
    const operationCount = eventsAfterApply.filter(event => event.operationId).length;
    const mutationOperationCount = eventsAfterApply.filter(event => event.state === 'applied' && event.operationId).length;
    assert.ok(operationCount > 0);
    assert.ok(eventsAfterApply.filter(event => event.operationId).every(event => event.requestId && event.queryId && event.operationSha256));

    const reuse = runCli(['lifecycle-simulate', '--action', 'reuse', '--input', inputPath, '--plan', v1PlanPath, '--simulation-state', stateArg, '--journal', reuseJournalPath, '--run-id', `${slug}-v1-reuse`]);
    assert.equal(reuse.status, 0, reuse.stderr);
    assert.equal(JSON.parse(reuse.stdout).status, 'REUSED');
    const eventsAfterReuse = readPublicationJournalHistory(journal, ROOT).filter(event => event.operationId);
    assert.equal(eventsAfterReuse.filter(event => event.state === 'applied').length, mutationOperationCount);
    assert.ok(eventsAfterReuse.filter(event => event.state === 'read').length >= 2);

    const currentState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const input2 = { ...f.input, target: { ...f.input.target, model: 'concordia_l4_observed_v2' }, targetState: { fingerprint: currentState.targetStateFingerprint, observedAt: '2026-01-01T00:04:00Z' } };
    const manifest2 = compilePublicationPlan(input2), plan2 = compileUslLifecyclePlan(manifest2, input2, f.binding);
    currentState.observedRowsByPlanFingerprint[plan2.fingerprint] = syntheticRows;
    currentState.failOnOperationId = 'load_model_for_definition_check'; currentState.failOnPlanFingerprint = plan2.fingerprint;
    fs.writeFileSync(statePath, JSON.stringify(currentState));
    const envelope2 = { publicationManifest: manifest2, publicationInput: input2, sourceBinding: f.binding, authorizationGrant: makeGrant(plan2) };
    fs.writeFileSync(absoluteInput, JSON.stringify(envelope2));
    const secondPlan = runCli(['lifecycle-plan', '--input', inputPath]);
    assert.equal(secondPlan.status, 0, secondPlan.stderr);
    const response2 = JSON.parse(secondPlan.stdout);
    v2PlanPath = `.concordia/publication-plans/${slug}.${response2.fingerprint.slice(0, 24)}.plan.json`;
    fs.writeFileSync(path.join(ROOT, v2PlanPath), JSON.stringify(response2.plan));
    const failedV2 = runCli(['lifecycle-simulate', '--action', 'apply', '--input', inputPath, '--plan', v2PlanPath, '--simulation-state', stateArg, '--journal', journal2Path, '--run-id', `${slug}-v2`]);
    assert.equal(failedV2.status, 1);
    assert.equal(JSON.parse(failedV2.stdout).status, 'RECOVERED');
    assert.equal(JSON.parse(failedV2.stdout).passed, false);
    const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const version1Ref = `${plan1.target.namespace}.${plan1.target.model}`, version2Ref = `${plan2.target.namespace}.${plan2.target.model}`;
    assert.equal(recoveredState.localClientPointer, version1Ref);
    assert.equal(recoveredState.activeVersionRef, version2Ref);
    assert.ok(recoveredState.versions.find((version: any) => version.versionId === version1Ref)?.servable);
    assert.ok(recoveredState.versions.find((version: any) => version.versionId === version2Ref)?.servable);
    const recovery = runCli(['lifecycle-simulate', '--action', 'recover', '--input', inputPath, '--plan', v2PlanPath, '--simulation-state', stateArg, '--journal', journal2Path, '--run-id', `${slug}-v2-recover`]);
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(JSON.parse(recovery.stdout).status, 'RECOVERED');
    const corruptedPrevious = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    corruptedPrevious.loadedModelsByVersion[version1Ref].tables[0].columnSpecs[0].dataType = 'varchar(1)';
    fs.writeFileSync(statePath, JSON.stringify(corruptedPrevious));
    const unsafeRecovery = runCli(['lifecycle-simulate', '--action', 'recover', '--input', inputPath, '--plan', v2PlanPath, '--simulation-state', stateArg, '--journal', journal2Path, '--run-id', `${slug}-v2-corrupt-recover`]);
    assert.equal(unsafeRecovery.status, 1);
    assert.equal(JSON.parse(unsafeRecovery.stdout).reason, 'PREVIOUS_VERSION_CONTENT_UNVERIFIED');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).localClientPointer, version1Ref);
    const history = runCli(['history', '--journal', journalPath]);
    assert.equal(history.status, 0, history.stderr);
    assert.ok(JSON.parse(history.stdout).count > 0);
    assert.equal(fs.existsSync(path.join(runDir, 'journal.jsonl.lock')), false);
    assert.equal(fs.existsSync(path.join(directory, `${slug}.missing.env`)), false);
  } finally {
    for (const file of [absoluteInput, guard, statePath, journal, path.join(ROOT, reuseJournalPath), path.join(ROOT, journal2Path), v1PlanPath ? path.join(ROOT, v1PlanPath) : '', v2PlanPath ? path.join(ROOT, v2PlanPath) : '']) if (file && fs.existsSync(file)) fs.rmSync(file);
    for (const directoryPath of [runDir, path.dirname(path.join(ROOT, reuseJournalPath)), path.dirname(path.join(ROOT, journal2Path))]) if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
  }
});

test('B1: the approved namespace is an allowlist (sealed v1 or dated agentpub), and anything else still blocks the plan', () => {
  assert.equal(isApprovedL4Namespace('lightning.metastore.concordia_l4_json2_20261023'), true);
  assert.equal(isApprovedL4Namespace('lightning.metastore.concordia_l4_agentpub_20261025'), true);
  for (const bad of ['lightning.metastore.concordia_l4_agentpub_2026', 'lightning.metastore.concordia_l4_agentpub_20261025_x', 'lightning.metastore.concordia_u1', 'other.metastore.concordia_l4_agentpub_20261025', 'lightning.metastore.concordia_l4_json2_20261024', 'lightning.metastore.concordia_l4_agentpub_20261025.extra']) assert.equal(isApprovedL4Namespace(bad), false, bad);
  const f = fixture();
  const input = { ...f.input, target: { namespace: 'lightning.metastore.concordia_l4_agentpub_20261025', model: 'concordia_l4_agent_gtfs_route_v1' } };
  const plan = compileUslLifecyclePlan(compilePublicationPlan(input), input, f.binding);
  assert.equal(plan.gates.some(gate => gate.code === 'target_namespace_not_approved_candidate'), false);
  assert.equal(plan.operations.find(item => item.operationId === 'create_target_namespace')?.sql, 'CREATE NAMESPACE IF NOT EXISTS lightning.metastore.concordia_l4_agentpub_20261025');
  const foreign = { ...f.input, target: { namespace: 'lightning.metastore.concordia_u1', model: 'concordia_l4_agent_gtfs_route_v1' } };
  assert.ok(compileUslLifecyclePlan(compilePublicationPlan(foreign), foreign, f.binding).gates.some(gate => gate.code === 'target_namespace_not_approved_candidate'));
});

test('B3: the live grant is built from the plan, self-validated, short-lived, and refuses what the executor would reject', () => {
  const f = fixture();
  const mappings = f.binding.mappings.map(mapping => ({ ...mapping, keyColumns: mapping.keyColumns.map(column => ({ ...column, physicalColumn: column.logicalColumn })) }));
  const tables = mappings.map((mapping, index) => ({ manifestId: 'synthetic.manifest', profileAlias: 'SYNTHETIC', tableId: mapping.logicalObjectId, sourceId: mapping.sourceId, logicalObjectId: mapping.logicalObjectId,
    physicalDatabase: mapping.physicalDatabase, physicalTable: mapping.physicalTable, columns: mapping.keyColumns.map(column => ({ name: column.logicalColumn, kind: 'string' })), expectedRows: 1, maxRows: 20, readLimit: 50,
    observedSchemaSha256: String(index + 1).padStart(64, '0'), typedMultisetSha256: String(index + 3).padStart(64, '0'), fingerprintAlgorithm: 'CANONICAL_TYPED_ROWS_MULTISET_V1', dataOrigin: 'SYNTHETIC' }));
  const payload = { schemaVersion: 1, bindingId: f.binding.bindingId, bindingVersion: '1.0.0', status: 'ROOT_REVIEWED_FOR_BOUNDED_READ_ONLY_CONSUMPTION', reviewedAtUtc: '2026-10-23T12:00:00Z',
    registrationPlanFingerprint: 'a'.repeat(64), packageSealSha256: 'b'.repeat(64), registrationJournalSha256: 'c'.repeat(64), backendEngineVersion: 'synthetic-json2-1', profileConfigPath: 'synthetic/profile.json',
    wireEncoding: 'SQL_EDITOR_STRING_CELLS_CANONICAL_INTEGER_V1', wireEvidenceSha256: 'd'.repeat(64), readLimit: 50, maxRowsPerTable: 20, requiresFreshSchemaAndTypedMultisetCheckBeforeUse: true, sqlMutationAllowed: false, uslAllowed: false, tables };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const binding = { ...f.binding, bindingVersion: '1.0.0', mappings, bindingSha256: createHash('sha256').update(raw).digest('hex') };
  const plan = compileUslLifecyclePlan(f.manifest, f.input, binding);
  const dialect = Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'CONFIRMED', dialectId: 'synthetic-dialect', backendEngineVersion: 'x', reviewedBy: 'human', reviewedAt: '2026-10-23T00:00:00Z',
    supportedOperationIds: plan.operations.filter(operation => operation.sql).map(operation => operation.operationId) }), 'utf8');
  const base = { plan, manifest: f.manifest, input: f.input, binding, rawBindingBytes: raw, dialectBytes: dialect, approvedBy: 'synthetic-test', now: Date.parse('2026-10-25T12:00:00Z') };
  const grant = buildLiveUslGrant(base);
  assert.equal(grant.scope, 'LIVE_USL_PUBLICATION');
  assert.equal(grant.planFingerprint, plan.fingerprint);
  assert.deepEqual(grant.operationSqlSha256s, plan.operations.flatMap(operation => operation.sqlSha256 ? [operation.sqlSha256] : []));
  assert.equal(grant.dialectEvidenceSha256, createHash('sha256').update(dialect).digest('hex'));
  assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.approvedAt), 30 * 60_000 + 1000);
  assert.throws(() => buildLiveUslGrant({ ...base, approvedBy: ' ' }), /LIVE_GRANT_APPROVER_REQUIRED/);
  assert.throws(() => buildLiveUslGrant({ ...base, ttlMinutes: 61 }), /LIVE_GRANT_TTL_INVALID/);
  assert.throws(() => buildLiveUslGrant({ ...base, dialectBytes: Buffer.from('{') }), /BACKEND_DIALECT_EVIDENCE_INVALID/);
  assert.throws(() => buildLiveUslGrant({ ...base, rawBindingBytes: Buffer.from(raw.toString('utf8') + ' ') }), /SEALED_SOURCE_BINDING_BYTES_REQUIRED/);
  assert.throws(() => buildLiveUslGrant({ ...base, dialectBytes: Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'CONFIRMED', dialectId: 'd', backendEngineVersion: 'x', reviewedBy: 'h', reviewedAt: '2026-10-23T00:00:00Z', supportedOperationIds: [] })) }), /BACKEND_DIALECT_EVIDENCE_INVALID/);
});

test('B5: retargeting keeps contract, evidence and decision, drops the old target state, and changes the plan fingerprint', () => {
  const f = fixture();
  const target = { namespace: 'lightning.metastore.concordia_l4_agentpub_20261025', model: 'concordia_l4_agent_gtfs_route_v1' };
  const bare = retargetPublicationInput(f.input, target);
  assert.equal(bare.targetState, undefined, 'the old namespace fingerprint is never carried over');
  assert.deepEqual([bare.contract, bare.evidence, bare.decision], [f.input.contract, f.input.evidence, f.input.decision]);
  const snapshot = { fingerprint: 'c'.repeat(64), observedAt: '2026-10-25T12:00:00Z' };
  const input = retargetPublicationInput(f.input, target, snapshot);
  assert.deepEqual(input.targetState, snapshot);
  assert.notEqual(compilePublicationPlan(input).fingerprint, f.manifest.fingerprint);
  assert.throws(() => retargetPublicationInput(f.input, { ...target, namespace: 'lightning.metastore.concordia_u1' }), /RETARGET_NAMESPACE_NOT_APPROVED/);
  assert.throws(() => retargetPublicationInput(f.input, { ...target, model: 'bad model' }), /RETARGET_MODEL_INVALID/);
  assert.throws(() => retargetPublicationInput(f.input, f.input.target), /RETARGET_SAME_TARGET/);
});
