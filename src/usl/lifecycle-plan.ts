import { createHash } from 'node:crypto';
import type { RelationContract } from '../contracts/types.ts';
import { validateJson2LiveBinding, type Json2LiveBindingDocument } from '../relations/adapters/zetaris-json2.ts';
import {
  checkPublicationPlanPreconditions, type PublicationManifest, type PublicationPlanInput
} from './publication-plan.ts';

export const L4_OBSERVED_RELATION_NAMESPACE = 'lightning.metastore.concordia_l4_json2_20261023';
/** Approved publication namespaces: the sealed v1 namespace, or a dated agent-publication namespace (concordia_l4_agentpub_<yyyymmdd>) under lightning.metastore. */
export const APPROVED_L4_NAMESPACE = /^lightning\.metastore\.concordia_l4_(?:json2_20261023|agentpub_\d{8})$/;
export const isApprovedL4Namespace = (namespace: string) => APPROVED_L4_NAMESPACE.test(namespace);
export const USL_LIFECYCLE_RENDERER_VERSION = 'concordia-usl-lifecycle/1';

export interface PublicationSourceMapping {
  sourceId: string;
  logicalObjectId: string;
  physicalDatabase: string;
  physicalTable: string;
  keyColumns: readonly { logicalColumn: string; physicalColumn: string; valueType: 'TEXT' | 'UNKNOWN' | 'NON_TEXT' }[];
}
export interface PublicationSourceBinding {
  bindingId: string;
  bindingVersion: string;
  bindingSha256: string;
  /** The original sealed binding remains read-only and does not authorize USL use. */
  uslAllowed: false;
  mappings: readonly PublicationSourceMapping[];
}
export interface UslLifecycleOperation {
  sequence: number;
  operationId: string;
  role: 'PREFLIGHT' | 'DDL' | 'ACTIVATION' | 'VERIFY' | 'READ';
  objectRef: string;
  sql: string | null;
  sqlSha256: string | null;
  condition: string;
  persistentEffect: boolean;
}
export interface UslLifecycleGate { code: string; status: 'PENDING' | 'FAILED'; }
export interface UslLifecyclePlan {
  schemaVersion: 1;
  rendererVersion: typeof USL_LIFECYCLE_RENDERER_VERSION;
  status: 'PREPARED' | 'BLOCKED';
  executable: false;
  executionStatus: 'NOT_RUN';
  publicationManifestRef: string;
  publicationManifestFingerprint: string;
  universeId: string;
  target: { namespace: string; model: string; table: 'ObservedRelation' };
  columnDefinitions: { name: string; type: 'varchar(512)' }[];
  relationRef: string;
  contractVersion: string;
  decisionRef: string;
  policyVersion: string;
  evidenceRefs: string[];
  publicationBasis: 'ObservedRelation';
  executionMode: string;
  dataOrigin: string;
  sourceBinding: { bindingId: string; bindingVersion: string; bindingSha256: string; uslAllowed: false; sha256Status: 'CLAIMED_UNVERIFIED'; mappingRefs: string[] };
  inputFingerprints: { publication: string; contract: string; evidence: string; decision: string; targetState: string | null; binding: string; renderer: string };
  operations: UslLifecycleOperation[];
  expectedProjection: { rowCount: number; fingerprint: string } | null;
  gates: UslLifecycleGate[];
  reuse: { requiredChecks: string[]; skipMutationsOnlyAfterAllChecks: true };
  recovery: { previousVersionRef: 'UNKNOWN'; previousServableVersionRequired: true; backendDisableSupported: 'UNKNOWN'; localClientPointerOnly: true; otherClientsMayStillReachNewVersion: true; firstPublicationHasNoPreviousVersion: true };
  fingerprint: string;
}
export interface UslLifecycleCheck { status: 'CURRENT' | 'STALE'; staleInputs: string[]; }
export interface UslLifecycleApplyGate { status: 'BLOCKED' | 'STALE'; canApply: false; reasons: string[]; }
export type SourceBindingBytesCheck = { status: 'VERIFIED'; sha256: string } | { status: 'REJECTED'; reason: 'BINDING_BYTES_INVALID' | 'BINDING_BYTES_HASH_MISMATCH' | 'BINDING_BYTES_CONTENT_MISMATCH' };

const validIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const validSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en')));
});
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const hashSql = (sql: string) => createHash('sha256').update(sql, 'utf8').digest('hex');
const sqlPath = (database: string, table: string) => validIdentifier(database) && validIdentifier(table) ? `${database}.${table}` : null;
const normalizeSqlWhitespace = (sql: string) => sql.trim().replace(/\s+/g, ' ');

function resolveMapping(binding: PublicationSourceBinding, endpoint: RelationContract['from']): PublicationSourceMapping | undefined {
  const matches = binding.mappings.filter(item => item.sourceId === endpoint.sourceId && item.logicalObjectId === endpoint.objectId);
  return matches.length === 1 ? matches[0] : undefined;
}
function validBindingShape(value: unknown): value is PublicationSourceBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Partial<PublicationSourceBinding>;
  return typeof binding.bindingId === 'string' && binding.bindingId.length > 0 &&
    typeof binding.bindingVersion === 'string' && binding.bindingVersion.length > 0 &&
    validSha256(binding.bindingSha256) && binding.uslAllowed === false && Array.isArray(binding.mappings) &&
    binding.mappings.every((mapping: PublicationSourceMapping) => Boolean(mapping && typeof mapping.sourceId === 'string' && mapping.sourceId.length > 0 &&
      typeof mapping.logicalObjectId === 'string' && mapping.logicalObjectId.length > 0 &&
      typeof mapping.physicalDatabase === 'string' && typeof mapping.physicalTable === 'string' && Array.isArray(mapping.keyColumns) &&
      mapping.keyColumns.every((column: any) => Boolean(column && typeof column.logicalColumn === 'string' && typeof column.physicalColumn === 'string' &&
        ['TEXT', 'UNKNOWN', 'NON_TEXT'].includes(column.valueType)))));
}
/** Verify exact sealed binding document bytes against both the declared digest and parsed DTO. */
export function verifyPublicationSourceBindingBytes(raw: Uint8Array, binding: PublicationSourceBinding): SourceBindingBytesCheck {
  if (!(raw instanceof Uint8Array) || !validBindingShape(binding)) return { status: 'REJECTED', reason: 'BINDING_BYTES_INVALID' };
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (sha256 !== binding.bindingSha256.toLowerCase()) return { status: 'REJECTED', reason: 'BINDING_BYTES_HASH_MISMATCH' };
  let parsed: Json2LiveBindingDocument;
  try { parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as Json2LiveBindingDocument; }
  catch { return { status: 'REJECTED', reason: 'BINDING_BYTES_INVALID' }; }
  if (validateJson2LiveBinding(parsed).length || parsed.bindingId !== binding.bindingId || parsed.bindingVersion !== binding.bindingVersion || parsed.uslAllowed !== false) return { status: 'REJECTED', reason: 'BINDING_BYTES_CONTENT_MISMATCH' };
  for (const mapping of binding.mappings) {
    const matches = parsed.tables.filter(table => table.sourceId === mapping.sourceId && table.logicalObjectId === mapping.logicalObjectId);
    if (matches.length !== 1) return { status: 'REJECTED', reason: 'BINDING_BYTES_CONTENT_MISMATCH' };
    const table = matches[0];
    const columnsMatch = mapping.keyColumns.every(mapped => {
      const sourceColumn = table.columns.find(column => column.name === mapped.logicalColumn);
      return Boolean(sourceColumn && mapped.physicalColumn === mapped.logicalColumn && mapped.valueType === (sourceColumn.kind === 'string' ? 'TEXT' : 'NON_TEXT'));
    });
    if (table.physicalDatabase !== mapping.physicalDatabase || table.physicalTable !== mapping.physicalTable || !columnsMatch) return { status: 'REJECTED', reason: 'BINDING_BYTES_CONTENT_MISMATCH' };
  }
  return { status: 'VERIFIED', sha256 };
}

function resolvedKeys(binding: PublicationSourceBinding, endpoint: RelationContract['from']) {
  const mapping = resolveMapping(binding, endpoint);
  if (!mapping || !sqlPath(mapping.physicalDatabase, mapping.physicalTable)) return undefined;
  const columns = endpoint.orderedColumns.map(logicalColumn => {
    const matches = mapping.keyColumns.filter(item => item.logicalColumn === logicalColumn);
    return matches.length === 1 && validIdentifier(matches[0].physicalColumn) && matches[0].valueType === 'TEXT' ? matches[0] : undefined;
  });
  return columns.every(Boolean) ? { mapping, columns: columns as NonNullable<(typeof columns)[number]>[] } : undefined;
}
function expectedProjectionRows(contract: RelationContract, input: PublicationPlanInput): string[][] | undefined {
  const bundles = input.evidence.filter(bundle => input.decision.evidenceBundleRefs.includes(bundle.evidenceBundleId) &&
    bundle.relationRef === contract.id && bundle.contractVersion === contract.contractVersion && bundle.completeness === 'COMPLETE_FOR_SCOPE');
  const endpointTuples = (endpoint: RelationContract['from']): string[][] | undefined => {
    const observations = bundles.flatMap(bundle => bundle.observations.filter(observation => observation.sourceRef === endpoint.sourceId &&
      observation.type === 'KEY_MEMBERSHIP' && observation.transportStatus === 'OK' && observation.truncated === false &&
      JSON.stringify(observation.projection) === JSON.stringify(endpoint.orderedColumns)));
    if (observations.length !== 1 || !Array.isArray(observations[0].measuredTuples)) return undefined;
    const tuples = observations[0].measuredTuples;
    if (!tuples.every(tuple => Array.isArray(tuple) && tuple.length === endpoint.orderedColumns.length && tuple.every(value => typeof value === 'string'))) return undefined;
    return tuples as string[][];
  };
  const source = endpointTuples(contract.from), target = endpointTuples(contract.to);
  if (!source || !target) return undefined;
  return source.flatMap(sourceTuple => target.filter(targetTuple => sourceTuple.every((value, index) => value === targetTuple[index]))
    .map(targetTuple => sourceTuple.flatMap((value, index) => [value, targetTuple[index]])));
}
function addOperation(operations: UslLifecycleOperation[], role: UslLifecycleOperation['role'], operationId: string, objectRef: string, sql: string | null, condition: string, persistentEffect = false) {
  operations.push({ sequence: operations.length + 1, operationId, role, objectRef, sql, sqlSha256: sql === null ? null : hashSql(sql), condition, persistentEffect });
}

/** Deterministic SQL/lifecycle preview from the shared publication manifest and an exact sealed-source mapping. */
export function compileUslLifecyclePlan(manifest: PublicationManifest, input: PublicationPlanInput, binding: PublicationSourceBinding): UslLifecyclePlan {
  const stale = checkPublicationPlanPreconditions(manifest, input);
  const reasons = new Set<string>();
  const contract = input.contract, target = input.target;
  if (stale.status !== 'CURRENT') reasons.add('publication_inputs_stale');
  if (manifest.eligibility !== 'publishable') reasons.add('publication_eligibility_not_publishable');
  if (manifest.publicationBasis !== 'ObservedRelation') reasons.add('observed_relation_basis_required');
  if (!isApprovedL4Namespace(target.namespace)) reasons.add('target_namespace_not_approved_candidate');
  if (!/^concordia_l4_[a-z0-9_]+_v[1-9][0-9]*$/.test(target.model)) reasons.add('target_model_must_be_new_and_versioned');
  if (!validBindingShape(binding)) reasons.add('sealed_read_only_source_binding_required');
  if (contract.kind !== 'FOREIGN_KEY') reasons.add('foreign_key_relation_required');
  if (contract.normalization.length !== contract.from.orderedColumns.length || contract.from.orderedColumns.length !== contract.to.orderedColumns.length || !contract.normalization.every((component, index) => component.componentIndex === index && component.operation.state === 'KNOWN' && component.operation.value === 'text' && component.version.state === 'KNOWN' && component.version.value === '1' && component.lossless.state === 'KNOWN' && component.lossless.value === true && component.adapterCapability.state === 'KNOWN' && component.adapterCapability.value === 'exact-text')) reasons.add('exact_text_v1_contract_required');
  const safeBinding = validBindingShape(binding) ? binding : undefined;
  const from = safeBinding && resolveMapping(safeBinding, contract.from), to = safeBinding && resolveMapping(safeBinding, contract.to);
  const fromResolved = safeBinding && resolvedKeys(safeBinding, contract.from), toResolved = safeBinding && resolvedKeys(safeBinding, contract.to);
  if (!from || !to) reasons.add('source_binding_object_mapping_missing_or_ambiguous');
  if (!fromResolved || !toResolved) reasons.add('source_binding_key_column_text_mapping_required');
  if (manifest.changes.length !== 1 || manifest.changes[0]?.relationRef !== contract.id || manifest.changes[0]?.contractVersion !== contract.contractVersion) reasons.add('single_exact_relation_change_required');
  const expectedRows = expectedProjectionRows(contract, input);
  if (!expectedRows) reasons.add('bounded_endpoint_projection_unavailable');
  else if (expectedRows.length === 0) reasons.add('empty_expected_projection_not_publishable');
  else if (expectedRows.length >= 50) reasons.add('expected_projection_exceeds_unambiguous_read_limit');

  const blocked = reasons.size > 0;
  const operations: UslLifecycleOperation[] = [];
  const fullModel = `${target.namespace}.${target.model}`;
  const tableName = 'ObservedRelation';
  const outputColumns = contract.from.orderedColumns.flatMap((_, index) => [`source_key_${index + 1}`, `target_key_${index + 1}`]);
  let activationSql: string | null = null;
  let compileSql: string | null = null;
  if (!blocked && fromResolved && toResolved) {
    const sourceObject = sqlPath(fromResolved.mapping.physicalDatabase, fromResolved.mapping.physicalTable)!;
    const targetObject = sqlPath(toResolved.mapping.physicalDatabase, toResolved.mapping.physicalTable)!;
    const select = contract.from.orderedColumns.flatMap((_, index) => [`src.${fromResolved.columns[index].physicalColumn} AS source_key_${index + 1}`, `tgt.${toResolved.columns[index].physicalColumn} AS target_key_${index + 1}`]).join(', ');
    const join = contract.from.orderedColumns.map((_, index) => `src.${fromResolved.columns[index].physicalColumn} = tgt.${toResolved.columns[index].physicalColumn}`).join(' AND ');
    activationSql = `ACTIVATE USL TABLE ${fullModel}.${tableName} AS SELECT ${select} FROM ${sourceObject} AS src INNER JOIN ${targetObject} AS tgt ON ${join}`;
    const columnSpecs = outputColumns.map(column => `  ${column} varchar(512)`).join(',\n');
    const ddl = `CREATE TABLE ${tableName} (\n${columnSpecs}\n);`;
    compileSql = `COMPILE USL ${target.model} DEPLOY NAMESPACE ${target.namespace} DDL\n${ddl}`;
    addOperation(operations, 'PREFLIGHT', 'recheck_contract_decision_evidence_policy_freshness_and_target', `${target.namespace}.${target.model}`, null, 'Recompute the common publication plan and confirm the exact target snapshot immediately before the first mutation.');
    addOperation(operations, 'PREFLIGHT', 'inspect_namespace_ownership', target.namespace, null, 'Proceed only if absent or if ownership and loaded manifest/content exactly match this plan; never adopt an unowned namespace.');
    addOperation(operations, 'DDL', 'create_target_namespace', target.namespace, `CREATE NAMESPACE IF NOT EXISTS ${target.namespace}`, 'Run only after the namespace preflight gate passes.', true);
    addOperation(operations, 'DDL', 'compile_versioned_model', fullModel, compileSql, 'Run only after exact-plan authorization and confirmed dialect; append a new versioned model.', true);
    addOperation(operations, 'ACTIVATION', 'activate_observed_relation', `${fullModel}.${tableName}`, activationSql, 'Run only after exact-plan authorization; textual INNER JOIN, preserving duplicate output rows.', true);
    addOperation(operations, 'VERIFY', 'load_model_for_definition_check', fullModel, `LOAD USL ${target.model} NAMESPACE ${target.namespace}`, 'Require exact model/table/column/activation definition before accepting reuse or continuing.');
    addOperation(operations, 'VERIFY', 'verify_observed_relation_sample', `${fullModel}.${tableName}`, `SELECT ${outputColumns.join(', ')} FROM ${fullModel}.${tableName} LIMIT 50`, 'Require a successful bounded read and text-shaped columns; no uniqueness or global coverage inference.');
  }
  if (!input.targetState) reasons.add('current_target_snapshot_required');
  reasons.add('source_binding_hash_confirmation_required');
  reasons.add('backend_dialect_and_server_capability_unconfirmed');
  reasons.add('explicit_plan_bound_authorization_required');
  reasons.add('live_sql_execution_not_supported_in_this_cut');
  const sourceBinding = {
    bindingId: typeof binding?.bindingId === 'string' ? binding.bindingId : 'UNKNOWN',
    bindingVersion: typeof binding?.bindingVersion === 'string' ? binding.bindingVersion : 'UNKNOWN',
    bindingSha256: validSha256(binding?.bindingSha256) ? binding.bindingSha256 : 'UNKNOWN',
    uslAllowed: false as const,
    sha256Status: 'CLAIMED_UNVERIFIED' as const,
    mappingRefs: [contract.from, contract.to].map(endpoint => `${endpoint.sourceId}:${endpoint.objectId}`).sort()
  };
  const body = {
    schemaVersion: 1 as const, rendererVersion: USL_LIFECYCLE_RENDERER_VERSION as typeof USL_LIFECYCLE_RENDERER_VERSION,
    status: blocked ? 'BLOCKED' as const : 'PREPARED' as const, executable: false as const, executionStatus: 'NOT_RUN' as const,
    publicationManifestRef: manifest.manifestId, publicationManifestFingerprint: manifest.fingerprint,
    universeId: input.universeId, target: { namespace: target.namespace, model: target.model, table: tableName as 'ObservedRelation' },
    columnDefinitions: outputColumns.map(name => ({ name, type: 'varchar(512)' as const })),
    relationRef: contract.id, contractVersion: contract.contractVersion, decisionRef: input.decision.decisionId, policyVersion: input.decision.policyVersion,
    evidenceRefs: [...input.decision.evidenceBundleRefs].sort(), publicationBasis: 'ObservedRelation' as const,
    executionMode: manifest.executionMode, dataOrigin: manifest.dataOrigin, sourceBinding,
    inputFingerprints: { publication: manifest.fingerprint, contract: manifest.inputFingerprints.contract, evidence: manifest.inputFingerprints.evidence,
      decision: manifest.inputFingerprints.decision, targetState: input.targetState?.fingerprint ?? null,
      binding: hash(binding ?? null), renderer: hash(USL_LIFECYCLE_RENDERER_VERSION) },
    operations, expectedProjection: expectedRows && expectedRows.length < 50 ? { rowCount: expectedRows.length, fingerprint: hash([...expectedRows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))) } : null, gates: [...reasons].sort().map(code => ({ code, status: code === 'publication_inputs_stale' || code === 'publication_eligibility_not_publishable' || code === 'observed_relation_basis_required' || code === 'target_namespace_not_approved_candidate' || code === 'target_model_must_be_new_and_versioned' || code === 'sealed_read_only_source_binding_required' || code === 'foreign_key_relation_required' || code === 'exact_text_v1_contract_required' || code === 'source_binding_object_mapping_missing_or_ambiguous' || code === 'source_binding_key_column_text_mapping_required' || code === 'single_exact_relation_change_required' || code === 'bounded_endpoint_projection_unavailable' || code === 'empty_expected_projection_not_publishable' || code === 'expected_projection_exceeds_unambiguous_read_limit' ? 'FAILED' as const : 'PENDING' as const })),
    reuse: { requiredChecks: ['LOAD exact versioned model', 'compare column names/types and empty constraints', 'compare ACTIVATE query using documented whitespace normalization only', 'repeat bounded output SELECT and record row count without deduplication'], skipMutationsOnlyAfterAllChecks: true as const },
    recovery: { previousVersionRef: 'UNKNOWN' as const, previousServableVersionRequired: true as const, backendDisableSupported: 'UNKNOWN' as const,
      localClientPointerOnly: true as const, otherClientsMayStillReachNewVersion: true as const, firstPublicationHasNoPreviousVersion: true as const }
  };
  return { ...body, fingerprint: hash(body) };
}

export function isUslLifecyclePlanFingerprintValid(plan: unknown): plan is UslLifecyclePlan {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
  const candidate = plan as UslLifecyclePlan;
  if (!validSha256(candidate.fingerprint)) return false;
  const { fingerprint, ...body } = candidate;
  return hash(body) === fingerprint;
}

export function checkUslLifecyclePlan(plan: UslLifecyclePlan, manifest: PublicationManifest, input: PublicationPlanInput, binding: PublicationSourceBinding): UslLifecycleCheck {
  const staleInputs = new Set<string>();
  if (!isUslLifecyclePlanFingerprintValid(plan)) return { status: 'STALE', staleInputs: ['workflow_manifest'] };
  const baseCheck = checkPublicationPlanPreconditions(manifest, input);
  if (baseCheck.status !== 'CURRENT') for (const item of baseCheck.staleInputs) staleInputs.add(item);
  let recomputed: UslLifecyclePlan;
  try { recomputed = compileUslLifecyclePlan(manifest, input, binding); }
  catch { return { status: 'STALE', staleInputs: [...new Set([...staleInputs, 'workflow_inputs'])].sort() }; }
  if (recomputed.fingerprint !== plan.fingerprint) staleInputs.add('workflow_inputs');
  return { status: staleInputs.size ? 'STALE' : 'CURRENT', staleInputs: [...staleInputs].sort() };
}

/** This preparation cut never enables SQL apply, even if callers supply authorization flags. */
export function assessUslLifecycleApplyGate(plan: UslLifecyclePlan, check: UslLifecycleCheck): UslLifecycleApplyGate {
  const reasons = new Set<string>();
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.gates)) {
    return { status: 'STALE', canApply: false, reasons: ['workflow_manifest_invalid', 'live_sql_apply_not_supported'] };
  }
  if (check.status === 'STALE') reasons.add('stale_workflow_plan');
  if (plan.status !== 'PREPARED') reasons.add('workflow_plan_blocked');
  if (plan.gates.some(gate => gate.code === 'current_target_snapshot_required')) reasons.add('target_state_preflight_required');
  if (plan.gates.some(gate => gate.code === 'source_binding_hash_confirmation_required')) reasons.add('source_binding_hash_confirmation_required');
  if (plan.gates.some(gate => gate.code === 'backend_dialect_and_server_capability_unconfirmed')) reasons.add('sql_dialect_confirmation_required');
  if (plan.gates.some(gate => gate.code === 'explicit_plan_bound_authorization_required')) reasons.add('explicit_apply_authorization_required');
  reasons.add('live_sql_apply_not_supported');
  return { status: check.status === 'STALE' ? 'STALE' : 'BLOCKED', canApply: false, reasons: [...reasons].sort() };
}

/** Limited SQL whitespace normalization; string literals are not rewritten. */
export function verifyLoadedUslModel(plan: UslLifecyclePlan, loaded: unknown): { status: 'PASS' | 'FAIL'; reasons: string[] } {
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return { status: 'FAIL', reasons: ['loaded_model_shape_invalid'] };
  const model = loaded as any, loadOperation = plan.operations.find(operation => operation.operationId === 'load_model_for_definition_check');
  const activation = plan.operations.find(operation => operation.operationId === 'activate_observed_relation')?.sql;
  const sampleQuery = plan.operations.find(operation => operation.operationId === 'verify_observed_relation_sample')?.sql;
  const columnNames = plan.target.table === 'ObservedRelation' ? sampleQuery?.match(/^SELECT (.+) FROM /)?.[1].split(', ') ?? [] : [];
  const expectedActivationQuery = activation?.match(/^ACTIVATE USL TABLE \S+ AS (SELECT .+)$/i)?.[1];
  const reasons: string[] = [];
  const expectedModelNamespace = plan.target.namespace.split('.').slice(1);
  const expectedTableNamespace = [...plan.target.namespace.split('.'), plan.target.model];
  if (!loadOperation || !activation || !sampleQuery || model.name !== plan.target.model || JSON.stringify(model.namespace) !== JSON.stringify(expectedModelNamespace)) reasons.push('loaded_model_identity_mismatch');
  if (!Array.isArray(model.tables) || model.tables.length !== 1 || model.tables[0]?.name !== plan.target.table) reasons.push('loaded_table_set_mismatch');
  const table = model.tables?.[0];
  if (!table || JSON.stringify(table.namespace) !== JSON.stringify(expectedTableNamespace) || !Array.isArray(table.columnSpecs) || JSON.stringify(table.columnSpecs.map((column: any) => column?.name)) !== JSON.stringify(columnNames)) reasons.push('loaded_column_schema_mismatch');
  const loadedColumnTypes = Array.isArray(table?.columnSpecs) ? table.columnSpecs.map((column: any) => column?.type ?? column?.dataType ?? column?.columnType ?? column?.sqlType) : [];
  if (loadedColumnTypes.length !== plan.columnDefinitions.length || loadedColumnTypes.some((value: unknown, index: number) => typeof value !== 'string' || value.toLowerCase().replaceAll(' ', '').replace(/^['\"]|['\"]$/g, '') !== plan.columnDefinitions[index]?.type)) reasons.push('loaded_column_type_mismatch');
  const nonEmptyConstraint = (value: unknown) => value !== undefined && value !== null && value !== false && value !== '' && !(Array.isArray(value) && value.length === 0) && !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0);
  if (table && (!['unique', 'foreignKeys', 'checks', 'dqAnnotations', 'acAnnotations'].every(key => Array.isArray(table[key]) && table[key].length === 0) || (Array.isArray(table.columnSpecs) && table.columnSpecs.some((column: any) => nonEmptyConstraint(column?.foreignKey) || column?.primaryKey === true || column?.notNull === true)))) reasons.push('loaded_constraints_unexpected');
  if (!table || typeof table.activateQuery !== 'string' || normalizeSqlWhitespace(table.activateQuery) !== normalizeSqlWhitespace(expectedActivationQuery ?? '')) reasons.push('loaded_activation_definition_mismatch');
  return { status: reasons.length ? 'FAIL' : 'PASS', reasons: reasons.sort() };
}

/** Validate bounded output shape only; duplicate tuples remain counted and retained by the caller. */
export function verifyObservedRelationRows(plan: UslLifecyclePlan, rows: readonly (readonly unknown[])[]): { status: 'PASS' | 'FAIL'; rowCount: number; duplicateRowCount: number | null; reasons: string[] } {
  const limit = 50, width = plan.operations.find(operation => operation.operationId === 'verify_observed_relation_sample')?.sql?.match(/^SELECT (.+) FROM /)?.[1].split(', ').length ?? 0;
  const reasons: string[] = [];
  if (!Array.isArray(rows) || rows.length === 0 || rows.length >= limit) reasons.push('bounded_output_rows_missing_or_at_limit');
  if (!width || rows.some(row => !Array.isArray(row) || row.length !== width || row.some(value => typeof value !== 'string'))) reasons.push('bounded_output_text_shape_invalid');
  const duplicateRowCount = Array.isArray(rows) && rows.every(Array.isArray) ? rows.length - new Set(rows.map(row => JSON.stringify(row))).size : null;
  if (!plan.expectedProjection || !Array.isArray(rows) || rows.length !== plan.expectedProjection.rowCount || hash([...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))) !== plan.expectedProjection.fingerprint) reasons.push('bounded_output_content_or_multiplicity_mismatch');
  return { status: reasons.length ? 'FAIL' : 'PASS', rowCount: Array.isArray(rows) ? rows.length : 0, duplicateRowCount, reasons: [...new Set(reasons)].sort() };
}