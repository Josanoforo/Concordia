import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface StateManifest {
  schemaVersion: 1;
  formatVersion: '1.0';
  universeId: string;
  namespace: string;
  contractVersion: string;
  policyVersion: string;
  migrationState: 'CURRENT' | 'MIGRATED';
  migratedFrom?: string;
}
type FileDigest = { sha256: string; byteLength: number };
type SourceFiles = { 'claims.json': FileDigest; 'state.json': FileDigest; 'ledger.jsonl': FileDigest | null };
type MigrationCounts = {
  claims: number; conflicts: number; alternatives: number; memoryRecords: number;
  ledgerEvents: number; ledgerDecisions: number; conflictDecisionHistory: number;
};
export interface MigrationReceipt {
  schemaVersion: 1; receiptVersion: '1.0'; migrationId: string; contentChecksum: string;
  source: { path: string; universeId: string; namespace: string; files: SourceFiles };
  target: { path: string; universeId: string; namespace: string; files: Record<string, FileDigest> };
  sourceBackup: { path: string; manifestSha256: string };
  contractVersion: string; policyVersion: string; idMap: Record<string, string>; counts: MigrationCounts;
  createdAt: string; receiptSha256: string;
}
export type MigrationResult = { status: 'MIGRATED' | 'REUSED'; manifest: StateManifest; idMap: Record<string, string>; checksum: string; receipt: MigrationReceipt };

const manifestFile = 'state-manifest.json';
const receiptFile = 'migration-receipt.json';
const backupManifestFile = 'source-backup-manifest.json';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const approvedRoot = path.join(projectRoot, '.concordia');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digestBytes = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const validScope = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
const fileDigest = (bytes: Buffer): FileDigest => ({ sha256: digestBytes(bytes), byteLength: bytes.length });
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');

export function makeStateManifest(universeId: string, namespace = `${universeId}/claims`, migratedFrom?: string): StateManifest {
  if (!validScope(universeId) || !validScope(namespace)) throw new TypeError('INVALID_STATE_SCOPE');
  return { schemaVersion: 1, formatVersion: '1.0', universeId, namespace, contractVersion: '1.0', policyVersion: '1.0', migrationState: migratedFrom ? 'MIGRATED' : 'CURRENT', ...(migratedFrom ? { migratedFrom } : {}) };
}

export function validateStateManifest(value: unknown): value is StateManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return manifest.schemaVersion === 1 && manifest.formatVersion === '1.0' && validScope(manifest.universeId) && validScope(manifest.namespace) &&
    manifest.contractVersion === '1.0' && manifest.policyVersion === '1.0' && ['CURRENT', 'MIGRATED'].includes(String(manifest.migrationState)) &&
    (manifest.migrationState === 'CURRENT' ? manifest.migratedFrom === undefined : validScope(manifest.migratedFrom));
}

export function assertStateScope(dir: string, universeId: string, expectedNamespace = `${universeId}/claims`): StateManifest {
  const file = path.join(dir, manifestFile);
  if (!fs.existsSync(file)) throw new Error('LEGACY_SCOPE_UNKNOWN');
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('INVALID_STATE_MANIFEST_JSON'); }
  if (!validateStateManifest(parsed)) throw new Error('INVALID_STATE_MANIFEST');
  if (parsed.universeId !== universeId || parsed.namespace !== expectedNamespace) throw new Error('STATE_SCOPE_MISMATCH');
  return parsed;
}

export function planLegacyStateMigration(input: { sourceUniverse: string; targetUniverse: string; targetNamespace?: string; claims: unknown; conflicts: unknown; memoryState: unknown; ledger?: unknown }): { manifest: StateManifest; claims: any[]; conflicts: any[]; memoryState: any; idMap: Record<string, string>; checksum: string; counts: MigrationCounts } {
  if (!validScope(input.sourceUniverse) || !validScope(input.targetUniverse)) throw new Error('INVALID_MIGRATION_SCOPE');
  if (input.sourceUniverse !== input.targetUniverse) throw new Error('CROSS_UNIVERSE_MIGRATION_FORBIDDEN');
  const claims = input.claims as any, conflicts = input.conflicts as any, memoryState = input.memoryState as any;
  if (!Array.isArray(claims) || !Array.isArray(conflicts) || !memoryState || !Array.isArray(memoryState.records) || !Number.isSafeInteger(memoryState.seq) || memoryState.seq < 0) throw new Error('INVALID_LEGACY_STATE_SHAPE');
  if (!claims.length || !memoryState.records.length) throw new Error('LEGACY_SCOPE_UNKNOWN');

  const claimIds = new Set<string>();
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object' || !validId(claim.id) || claimIds.has(claim.id) || !validScope(claim.entity) || !validScope(claim.attribute) || typeof claim.value !== 'string' || typeof claim.source !== 'string') throw new Error('INVALID_OR_DUPLICATE_CLAIM');
    if (claim.domain !== input.sourceUniverse) throw new Error('LEGACY_SCOPE_UNKNOWN');
    claimIds.add(claim.id);
  }
  const records = memoryState.records as any[];
  const memoryIds = new Set<string>();
  let sourceNamespace: string | undefined;
  for (const record of records) {
    if (!record || typeof record !== 'object' || !validId(record.id) || memoryIds.has(record.id) || !validScope(record.namespace)) throw new Error('INVALID_OR_DUPLICATE_HMEM_RECORD');
    if (record.domain !== input.sourceUniverse) throw new Error('LEGACY_SCOPE_UNKNOWN');
    memoryIds.add(record.id);
    sourceNamespace ??= record.namespace;
    if (record.namespace !== sourceNamespace) throw new Error('LEGACY_SCOPE_UNKNOWN');
  }
  if (!sourceNamespace || sourceNamespace !== `${input.sourceUniverse}/claims` || (input.targetNamespace !== undefined && input.targetNamespace !== sourceNamespace)) throw new Error('LEGACY_SCOPE_UNKNOWN');
  const recordById = new Map(records.map(record => [record.id, record]));
  for (const claim of claims) {
    const record = recordById.get(claim.id);
    if (!record) throw new Error('CLAIM_MEMORY_LINK_INVALID');
    if (record.content !== `${claim.entity}.${claim.attribute} = ${claim.value}` || record.source !== claim.source) throw new Error('CLAIM_MEMORY_CONTENT_MISMATCH');
  }
  const ledger = input.ledger ?? [];
  if (!Array.isArray(ledger)) throw new Error('INVALID_LEDGER_SHAPE');
  const deletedIds = new Set((ledger as any[]).filter(entry => entry?.action === 'delete' && entry.previousState?.id === entry.memoryId).map(entry => entry.memoryId));
  const knownIds = new Set([...memoryIds, ...deletedIds]);
  validateMemoryLinks(records, knownIds);
  const recordSequences = records.map(record => /^mem-(\d+)$/.exec(record.id)).filter(Boolean).map(match => Number(match![1]));
  if (recordSequences.length && memoryState.seq < Math.max(...recordSequences)) throw new Error('MEMORY_SEQUENCE_BEHIND_IDS');
  const conflictIds = new Set<string>();
  for (const conflict of conflicts) {
    if (!conflict || typeof conflict !== 'object' || !validId(conflict.id) || conflictIds.has(conflict.id) || !validScope(conflict.entity) || !validScope(conflict.attribute) || !Array.isArray(conflict.claimIds) || conflict.claimIds.length < 2 || !validScope(conflict.strategy) || !Number.isSafeInteger(conflict.ledgerRef) || (conflict.version !== undefined && (!Number.isSafeInteger(conflict.version) || conflict.version < 1)) || !['queued', 'auto_resolved', 'human_resolved'].includes(conflict.status)) throw new Error('INVALID_CONFLICT_RECORD');
    conflictIds.add(conflict.id);
    const alternatives = new Set<string>();
    for (const id of conflict.claimIds) {
      if (!validId(id) || alternatives.has(id) || !claimIds.has(id)) throw new Error('INVALID_CONFLICT_REFERENCES');
      alternatives.add(id);
      const claim = claims.find(item => item.id === id);
      if (claim.entity !== conflict.entity || claim.attribute !== conflict.attribute) throw new Error('CONFLICT_SCOPE_MISMATCH');
    }
    if (conflict.winner !== undefined && !alternatives.has(conflict.winner)) throw new Error('INVALID_CONFLICT_WINNER');
    if (conflict.correction !== undefined && !memoryIds.has(conflict.correction)) throw new Error('INVALID_CONFLICT_CORRECTION');
    if (conflict.status !== 'queued' && conflict.winner === undefined) throw new Error('CONFLICT_DECISION_UNKNOWN');
    if (conflict.decisionHistory !== undefined) {
      if (!Array.isArray(conflict.decisionHistory)) throw new Error('INVALID_CONFLICT_DECISION_HISTORY');
      for (const decision of conflict.decisionHistory) {
        if (!decision || !Number.isSafeInteger(decision.version) || decision.version < 1 || !alternatives.has(decision.winner) || (decision.correction !== undefined && !memoryIds.has(decision.correction)) || !validScope(decision.actor) || !validScope(decision.reason) || !Number.isFinite(decision.at)) throw new Error('INVALID_CONFLICT_DECISION_HISTORY');
      }
    }
  }

  const ledgerIds = new Set<string>();
  for (const entry of ledger as any[]) {
    if (!entry || typeof entry !== 'object' || !validId(entry.memoryId) || typeof entry.action !== 'string' || !validScope(entry.actor) || !Number.isFinite(entry.timestamp)) throw new Error('INVALID_LEDGER_ENTRY');
    ledgerIds.add(entry.memoryId);
    const sequence = /^mem-(\d+)$/.exec(entry.memoryId);
    if (sequence && memoryState.seq < Number(sequence[1])) throw new Error('MEMORY_SEQUENCE_BEHIND_IDS');
  }
  for (const entry of ledger as any[]) {
    if (!knownIds.has(entry.memoryId)) throw new Error('INVALID_LEDGER_REFERENCES');
    const details = entry.details;
    if (details !== undefined) {
      if (details === null || typeof details !== 'object' || Array.isArray(details)) throw new Error('INVALID_LEDGER_REFERENCES');
      if (details.conflictId !== undefined && !conflictIds.has(details.conflictId)) throw new Error('INVALID_LEDGER_REFERENCES');
      for (const key of ['winner', 'selectedSourceClaim', 'correction', 'supersededBy', 'priorDecision']) {
        const id = details[key]; if (id !== undefined && id !== null && (!validId(id) || !knownIds.has(id))) throw new Error('INVALID_LEDGER_REFERENCES');
      }
      if (details.alternatives !== undefined && (!Array.isArray(details.alternatives) || details.alternatives.some((id: unknown) => !validId(id) || !knownIds.has(id)))) throw new Error('INVALID_LEDGER_REFERENCES');
    }
  }
  for (const conflict of conflicts) {
    // Legacy ledgerRef is preserved as a timestamp marker. For resolved conflicts it
    // can be recorded after the actual ledger events, so it is not an event ID/FK.
    const linked = (ledger as any[]).filter(entry => entry?.details?.conflictId === conflict.id);
    const detection = (ledger as any[]).some(entry => entry?.action === 'conflict_detected' &&
      (entry.details?.conflictId === conflict.id || Array.isArray(entry.details?.alternatives) && conflict.claimIds.every((id: string) => entry.details.alternatives.includes(id))));
    let decisionEvidence = false;
    if (conflict.status === 'queued') {
      decisionEvidence = detection && (ledger as any[]).some(entry => entry?.action === 'conflict_detected' &&
        entry.timestamp === conflict.ledgerRef && (entry.details?.conflictId === conflict.id || Array.isArray(entry.details?.alternatives) && conflict.claimIds.every((id: string) => entry.details.alternatives.includes(id))));
    } else {
      decisionEvidence = linked.some(entry => {
        if (entry.action !== 'conflict_resolved') return false;
        const details = entry.details ?? {};
        const identifiesWinner = details.selectedSourceClaim === conflict.winner || details.winner === conflict.winner;
        const correctionMatches = details.correction === undefined || details.correction === null || details.correction === conflict.correction || details.winner === conflict.correction;
        const noteMatches = details.note === undefined && details.reason === undefined ||
          details.note === conflict.note || details.reason === conflict.note;
        return identifiesWinner && correctionMatches && noteMatches;
      });
    }
    if (!detection || !decisionEvidence) throw new Error('INVALID_CONFLICT_LEDGER_REFERENCE');
  }
  const sourceIds = [...new Set([...claimIds, ...memoryIds, ...ledgerIds])].sort();
  const idMap = Object.fromEntries(sourceIds.map(id => [id, id])) as Record<string, string>;
  if (Object.keys(idMap).length !== sourceIds.length || sourceIds.some(id => !Object.prototype.hasOwnProperty.call(idMap, id) || idMap[id] !== id) || new Set(Object.values(idMap)).size !== sourceIds.length) throw new Error('MIGRATION_ID_MAP_INVALID');
  const target = { manifest: makeStateManifest(input.targetUniverse, sourceNamespace, input.sourceUniverse), claims: structuredClone(claims), conflicts: structuredClone(conflicts), memoryState: structuredClone(memoryState), idMap };
  const counts: MigrationCounts = {
    claims: claims.length, conflicts: conflicts.length, alternatives: conflicts.reduce((sum: number, conflict: any) => sum + conflict.claimIds.length, 0),
    memoryRecords: records.length, ledgerEvents: ledger.length,
    ledgerDecisions: (ledger as any[]).filter(entry => entry.action === 'conflict_resolved').length,
    conflictDecisionHistory: conflicts.reduce((sum: number, conflict: any) => sum + (conflict.decisionHistory?.length ?? 0), 0)
  };
  return { ...target, checksum: digest(target), counts };
}

export function migrateLegacyStateDirectory(sourceDir: string, targetDir: string, sourceUniverse: string, targetUniverse = sourceUniverse): MigrationResult {
  const sourcePath = approvedMigrationPath(sourceDir, 'source'), targetPath = approvedMigrationPath(targetDir, 'target');
  if (sourcePath === targetPath) throw new Error('MIGRATION_SOURCE_EQUALS_TARGET');
  if (isWithin(sourcePath, targetPath) || isWithin(targetPath, sourcePath)) throw new Error('MIGRATION_PATHS_OVERLAP');
  assertNoReparsePoints(sourcePath, true); assertNoReparsePoints(targetPath, false); assertNoReparsePoints(path.dirname(targetPath), true);
  if (!fs.statSync(sourcePath).isDirectory()) throw new Error('MIGRATION_SOURCE_NOT_DIRECTORY');
  const readSourceFile = (name: string, required: boolean): Buffer | null => {
    const filePath = path.join(sourcePath, name);
    if (!fs.existsSync(filePath)) { if (required) throw new Error('MIGRATION_SOURCE_FILE_MISSING'); return null; }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(fs.realpathSync(filePath), approvedRoot)) throw new Error('MIGRATION_SOURCE_FILE_INVALID');
    return fs.readFileSync(filePath);
  };
  if (fs.existsSync(path.join(sourcePath, manifestFile))) throw new Error('MIGRATION_SOURCE_ALREADY_MANIFESTED');
  const sourceBytes = { 'claims.json': readSourceFile('claims.json', true)!, 'state.json': readSourceFile('state.json', true)!, 'ledger.jsonl': readSourceFile('ledger.jsonl', false) };
  const claimsFile = parseJsonObject(sourceBytes['claims.json'], 'INVALID_CLAIMS_JSON');
  const memoryState = parseJsonObject(sourceBytes['state.json'], 'INVALID_MEMORY_STATE_JSON');
  if (!Array.isArray(claimsFile.claims) || !Array.isArray(claimsFile.conflicts)) throw new Error('INVALID_LEGACY_STATE_SHAPE');
  const ledger = parseLedger(sourceBytes['ledger.jsonl']);
  const plan = planLegacyStateMigration({ sourceUniverse, targetUniverse, claims: claimsFile.claims, conflicts: claimsFile.conflicts, memoryState, ledger });
  const sourceFiles: SourceFiles = {
    'claims.json': fileDigest(sourceBytes['claims.json']), 'state.json': fileDigest(sourceBytes['state.json']),
    'ledger.jsonl': sourceBytes['ledger.jsonl'] === null ? null : fileDigest(sourceBytes['ledger.jsonl'])
  };
  const sourceScope = { path: relativeApproved(sourcePath), universeId: sourceUniverse, namespace: plan.manifest.namespace };
  const targetScope = { path: relativeApproved(targetPath), universeId: targetUniverse, namespace: plan.manifest.namespace };
  const migrationId = digest({ receiptVersion: '1.0', source: sourceScope, target: targetScope, contractVersion: plan.manifest.contractVersion, policyVersion: plan.manifest.policyVersion, files: sourceFiles });
  const operationDir = path.join(approvedRoot, 'migration-operations', migrationId);
  const backupDir = path.join(operationDir, 'source-backup');
  if (isWithin(operationDir, sourcePath) || isWithin(sourcePath, operationDir) || isWithin(operationDir, targetPath) || isWithin(targetPath, operationDir)) throw new Error('MIGRATION_OPERATION_PATH_OVERLAP');
  const backupManifest = { schemaVersion: 1, migrationId, source: sourceScope, files: sourceFiles };
  const backupManifestBytes = jsonBytes(backupManifest), backupManifestSha256 = digestBytes(backupManifestBytes);
  const targetBytes: Record<string, Buffer> = {
    'claims.json': jsonBytes({ claims: plan.claims, conflicts: plan.conflicts }), 'state.json': jsonBytes(plan.memoryState),
    [manifestFile]: jsonBytes(plan.manifest), ...(sourceBytes['ledger.jsonl'] === null ? {} : { 'ledger.jsonl': sourceBytes['ledger.jsonl'] })
  };
  const targetFiles = Object.fromEntries(Object.entries(targetBytes).map(([name, bytes]) => [name, fileDigest(bytes)]));
  const receiptBody = {
    schemaVersion: 1 as const, receiptVersion: '1.0' as const, migrationId, contentChecksum: plan.checksum,
    source: { ...sourceScope, files: sourceFiles }, target: { ...targetScope, files: targetFiles },
    sourceBackup: { path: relativeApproved(backupDir), manifestSha256: backupManifestSha256 },
    contractVersion: plan.manifest.contractVersion, policyVersion: plan.manifest.policyVersion,
    idMap: plan.idMap, counts: plan.counts
  };

  if (fs.existsSync(targetPath)) {
    try { verifyOwnedDirectory(targetPath, sourcePath, receiptBody, sourceBytes, backupDir, backupManifestBytes, targetBytes, plan); }
    catch (error) { writeAttemptDiagnostic(operationDir, migrationId, error); throw safeMigrationError(error); }
    const receipt = readReceipt(path.join(targetPath, receiptFile));
    return { status: 'REUSED', manifest: plan.manifest, idMap: plan.idMap, checksum: plan.checksum, receipt };
  }

  ensureDirectory(path.dirname(operationDir));

  try {
    if (!fs.existsSync(operationDir)) fs.mkdirSync(operationDir);
    else assertNoReparsePoints(operationDir, true);
    if (fs.existsSync(backupDir)) verifyBackup(backupDir, sourceBytes, backupManifestBytes);
    else {
      fs.mkdirSync(backupDir);
      assertNoReparsePoints(backupDir, true);
      for (const [name, bytes] of Object.entries(sourceBytes)) if (bytes !== null) writeNewFile(path.join(backupDir, name), bytes);
      writeNewFile(path.join(backupDir, backupManifestFile), backupManifestBytes);
      verifyBackup(backupDir, sourceBytes, backupManifestBytes);
    }
  } catch (error) {
    writeAttemptDiagnostic(operationDir, migrationId, error);
    throw safeMigrationError(error);
  }

  const stageDir = `${targetPath}.migration-${migrationId.slice(0, 12)}`;
  if (!isWithin(stageDir, approvedRoot)) throw new Error('MIGRATION_STAGE_OUTSIDE_APPROVED_ROOT');
  if (fs.existsSync(stageDir)) { writeAttemptDiagnostic(operationDir, migrationId, new Error('MIGRATION_STAGE_ALREADY_EXISTS')); throw new Error('MIGRATION_STAGE_ALREADY_EXISTS'); }
  let stageCreated = false;
  try {
    fs.mkdirSync(stageDir); stageCreated = true; assertNoReparsePoints(stageDir, true);
    const receiptWithoutChecksum = { ...receiptBody, createdAt: new Date().toISOString() };
    const receipt = { ...receiptWithoutChecksum, receiptSha256: digest(receiptWithoutChecksum) } as MigrationReceipt;
    const files = { ...targetBytes, [receiptFile]: jsonBytes(receipt) };
    for (const [name, bytes] of Object.entries(files)) writeNewFile(path.join(stageDir, name), bytes);
    verifyTargetBytes(stageDir, files);
    const readbackReceipt = readReceipt(path.join(stageDir, receiptFile));
    if (readbackReceipt.migrationId !== migrationId || readbackReceipt.receiptSha256 !== receipt.receiptSha256 || digest(readbackReceiptBody(readbackReceipt)) !== readbackReceipt.receiptSha256) throw new Error('MIGRATION_STAGE_RECEIPT_MISMATCH');
    if (!sameBytes(sourcePath, sourceBytes)) throw new Error('MIGRATION_SOURCE_CHANGED_DURING_OPERATION');
    fs.renameSync(stageDir, targetPath);
    verifyTargetBytes(targetPath, files);
    return { status: 'MIGRATED', manifest: plan.manifest, idMap: plan.idMap, checksum: plan.checksum, receipt };
  } catch (error) {
    if (stageCreated) safeRemoveOwnedStage(stageDir);
    writeAttemptDiagnostic(operationDir, migrationId, error);
    throw safeMigrationError(error);
  }
}

function validateMemoryLinks(records: any[], knownIds: Set<string>): void {
  for (const record of records) {
    for (const key of ['relatedTo', 'derivedFrom']) {
      const refs = record[key];
      if (refs !== undefined && (!Array.isArray(refs) || refs.some((id: unknown) => !validId(id) || !knownIds.has(id)))) throw new Error('INVALID_HMEM_REFERENCES');
    }
    for (const key of ['supersedes', 'supersededBy']) {
      const ref = record[key]; if (ref !== undefined && (!validId(ref) || !knownIds.has(ref))) throw new Error('INVALID_HMEM_REFERENCES');
    }
  }
}
function parseJsonObject(bytes: Buffer, code: string): any {
  try { const value = JSON.parse(bytes.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new Error(code); }
}
function parseLedger(bytes: Buffer | null): any[] {
  if (bytes === null) return [];
  const lines = bytes.toString('utf8').split(/\r?\n/).filter(Boolean), entries: any[] = [];
  for (const line of lines) {
    let entry: any; try { entry = JSON.parse(line); } catch { throw new Error('INVALID_LEDGER_JSON'); }
    entries.push(entry);
  }
  return entries;
}
function relativeApproved(input: string): string {
  const relative = path.relative(approvedRoot, input);
  if (!isWithin(input, approvedRoot)) throw new Error('MIGRATION_PATH_OUTSIDE_APPROVED_ROOT');
  return path.posix.join('.concordia', relative.split(path.sep).join('/'));
}
function ensureDirectory(directory: string): void {
  if (fs.existsSync(directory)) { assertNoReparsePoints(directory, true); if (!fs.statSync(directory).isDirectory()) throw new Error('MIGRATION_OPERATION_DIRECTORY_INVALID'); return; }
  const parent = path.dirname(directory); ensureDirectory(parent); fs.mkdirSync(directory);
}
function writeNewFile(file: string, bytes: Buffer): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function verifyBackup(directory: string, sourceBytes: Record<string, Buffer | null>, manifestBytes: Buffer): void {
  if (!fs.existsSync(directory)) throw new Error('MIGRATION_BACKUP_MISSING');
  assertNoReparsePoints(directory, true);
  const expected = Object.entries(sourceBytes).filter(([, bytes]) => bytes !== null).map(([name]) => name).concat(backupManifestFile).sort();
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(expected)) throw new Error('MIGRATION_BACKUP_CONTENT_MISMATCH');
  for (const [name, bytes] of Object.entries(sourceBytes)) if (bytes !== null && !readVerifiedOwnedFile(directory, name, 'MIGRATION_BACKUP_FILE_INVALID').equals(bytes)) throw new Error('MIGRATION_BACKUP_BYTES_MISMATCH');
  if (!readVerifiedOwnedFile(directory, backupManifestFile, 'MIGRATION_BACKUP_FILE_INVALID').equals(manifestBytes)) throw new Error('MIGRATION_BACKUP_MANIFEST_MISMATCH');
}
function verifyTargetBytes(directory: string, expected: Record<string, Buffer>): void {
  assertNoReparsePoints(directory, true);
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(Object.keys(expected).sort())) throw new Error('MIGRATION_TARGET_CONTENT_MISMATCH');
  for (const [name, bytes] of Object.entries(expected)) if (!readVerifiedOwnedFile(directory, name, 'MIGRATION_TARGET_FILE_INVALID').equals(bytes)) throw new Error('MIGRATION_TARGET_BYTES_MISMATCH');
}
function readVerifiedOwnedFile(directory: string, name: string, errorCode: string): Buffer {
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(errorCode);
  const resolvedDirectory = fs.realpathSync(directory), resolvedFile = fs.realpathSync(file);
  if (!isWithin(resolvedFile, resolvedDirectory) || !isWithin(resolvedFile, fs.realpathSync(approvedRoot))) throw new Error(errorCode);
  return fs.readFileSync(file);
}
function readReceipt(file: string): MigrationReceipt {
  const value = parseJsonObject(readVerifiedOwnedFile(path.dirname(file), path.basename(file), 'MIGRATION_RECEIPT_INVALID'), 'MIGRATION_RECEIPT_JSON_INVALID') as MigrationReceipt;
  if (value.schemaVersion !== 1 || value.receiptVersion !== '1.0' || !/^[a-f0-9]{64}$/.test(value.receiptSha256) || digest(readbackReceiptBody(value)) !== value.receiptSha256) throw new Error('MIGRATION_RECEIPT_INVALID');
  return value;
}
function readbackReceiptBody(receipt: MigrationReceipt): Omit<MigrationReceipt, 'receiptSha256'> {
  const { receiptSha256: _receiptSha256, ...body } = receipt;
  return body;
}
function verifyOwnedDirectory(targetPath: string, sourcePath: string, expectedReceiptBody: Record<string, any>, sourceBytes: Record<string, Buffer | null>, backupDir: string, backupManifestBytes: Buffer, targetBytes: Record<string, Buffer>, plan: { checksum: string; idMap: Record<string, string>; counts: MigrationCounts }): void {
  assertNoReparsePoints(targetPath, true);
  if (!fs.statSync(targetPath).isDirectory()) throw new Error('MIGRATION_TARGET_NOT_DIRECTORY');
  if (!fs.existsSync(path.join(targetPath, receiptFile))) throw new Error('MIGRATION_RECEIPT_MISSING');
  const receipt = readReceipt(path.join(targetPath, receiptFile));
  const body = readbackReceiptBody(receipt);
  const expectedBody = { ...expectedReceiptBody, createdAt: receipt.createdAt };
  if (JSON.stringify(body) !== JSON.stringify(expectedBody) || receipt.contentChecksum !== plan.checksum || digest(plan.idMap) !== digest(receipt.idMap) || digest(plan.counts) !== digest(receipt.counts)) throw new Error('MIGRATION_RECEIPT_IDENTITY_MISMATCH');
  verifyBackup(backupDir, sourceBytes, backupManifestBytes);
  const allTargetBytes = { ...targetBytes, [receiptFile]: jsonBytes(receipt) };
  verifyTargetBytes(targetPath, allTargetBytes);
  if (!sameBytes(sourcePath, sourceBytes)) throw new Error('MIGRATION_SOURCE_CHANGED_SINCE_BACKUP');
}
function sameBytes(directory: string, expected: Record<string, Buffer | null>): boolean {
  for (const [name, bytes] of Object.entries(expected)) {
    const file = path.join(directory, name);
    if (bytes === null) { if (fs.existsSync(file)) return false; }
    else if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) return false;
  }
  return true;
}
function safeRemoveOwnedStage(stageDir: string): void {
  try {
    if (!fs.existsSync(stageDir)) return;
    assertNoReparsePoints(stageDir, true);
    const resolved = fs.realpathSync(stageDir);
    if (!isWithin(resolved, fs.realpathSync(approvedRoot))) throw new Error('MIGRATION_STAGE_CLEANUP_OUTSIDE_APPROVED_ROOT');
    fs.rmSync(stageDir, { recursive: true, force: false });
  } catch { /* keep ambiguous paths for manual inspection */ }
}
function writeAttemptDiagnostic(operationDir: string, migrationId: string, error: unknown): void {
  try {
    if (!fs.existsSync(operationDir) || !fs.statSync(operationDir).isDirectory()) return;
    assertNoReparsePoints(operationDir, true);
    const attempts = path.join(operationDir, 'attempts');
    if (!fs.existsSync(attempts)) fs.mkdirSync(attempts);
    assertNoReparsePoints(attempts, true);
    const code = migrationFailureCode(error);
    writeNewFile(path.join(attempts, `${Date.now()}-${randomUUID()}.json`), jsonBytes({ schemaVersion: 1, migrationId, status: 'FAILED', errorCode: code, recordedAt: new Date().toISOString() }));
  } catch { /* diagnostics are best effort and never replace the migration error */ }
}
function migrationFailureCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]*(?::[A-Z][A-Z0-9_]*)?$/.test(raw) ? raw.split(':')[0] : 'MIGRATION_IO_FAILED';
}
function safeMigrationError(error: unknown): Error {
  const code = migrationFailureCode(error);
  return new Error(code.startsWith('MIGRATION_TARGET_INCOMPLETE:') ? code : `MIGRATION_TARGET_INCOMPLETE:${code}`);
}
function approvedMigrationPath(input: string, label: string): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error(`INVALID_MIGRATION_${label.toUpperCase()}_PATH`);
  const resolved = path.resolve(input);
  if (!isWithin(resolved, approvedRoot) || resolved === approvedRoot) throw new Error(`MIGRATION_${label.toUpperCase()}_OUTSIDE_APPROVED_ROOT`);
  return resolved;
}
function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function assertNoReparsePoints(candidate: string, includeLeaf: boolean): void {
  const rootStat = fs.lstatSync(approvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('MIGRATION_REPARSE_POINT_FORBIDDEN');
  const resolvedRoot = fs.realpathSync(approvedRoot), relative = path.relative(approvedRoot, candidate), segments = relative.split(path.sep).filter(Boolean);
  let current = approvedRoot;
  const count = includeLeaf ? segments.length : Math.max(0, segments.length - 1);
  for (const segment of segments.slice(0, count)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('MIGRATION_REPARSE_POINT_FORBIDDEN');
    const actual = fs.realpathSync(current);
    if (!isWithin(actual, resolvedRoot)) throw new Error('MIGRATION_PATH_ESCAPES_APPROVED_ROOT');
  }
}
