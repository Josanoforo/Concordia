import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT } from '../runtime.ts';
import { validateUniverseRegistry, type UniverseManifest } from './universes.ts';

export type CapturedRunStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED';
export interface CapturedRunRecord {
  schemaVersion: 1; manifestVersion: '1.0'; entryId: string; runId: string; semanticFingerprint: string;
  universeId: string; universeVersion: string; contractVersions: string[]; policyVersion: string;
  action: 'universe.evaluate'; executionMode: 'LIVE' | 'REPLAY' | 'LOCAL'; dataOrigin: string; status: CapturedRunStatus;
  hashes: { code: string; manifest: string; config: string; contracts: string; policy: string; inputs: string; evidence: string; artifacts: string };
  /** Present for bounded local-snapshot captures; hashes profile, contracts, candidates, and every pinned JSON/CSV input. */
  sourceInputHash?: string;
  sourceValidation?: CapturedSourceValidation;
  evidenceRefs: string[]; artifactRefs: string[]; capturedAt: string;
}
export interface CapturedSourceTable {
  sourceId: string; logicalObjectId: string; status: 'VERIFIED' | 'ERROR' | 'NOT_REQUESTED';
  expectedRows?: number; actualRows?: number; describeRequestId?: string; describeQueryId?: string; describeRequestedAt?: string;
  describeStatement?: string; describeDurationMs?: number; describeRawRowsReceived?: number; describeRequestedLimit?: number; describeReportedTotal?: number; describeTotalReported?: boolean; describeContinuationPresent?: boolean; describePaginationStatus?: 'TOTAL_MATCHED' | 'TOTAL_UNREPORTED'; selectRequestId?: string; selectQueryId?: string; selectRequestedAt?: string;
  selectStatement?: string; selectDurationMs?: number; observedSchemaSha256?: string; observedTypedMultisetSha256?: string;
  rawRowsReceived?: number; requestedLimit?: number; reportedTotal?: number; totalReported?: boolean; continuationPresent?: boolean;
  paginationScope?: 'CLOSED_BINDING'; paginationStatus?: 'TOTAL_MATCHED' | 'TOTAL_UNREPORTED';
}
export interface CapturedSourceValidation { status: 'COMPLETE' | 'PARTIAL' | 'ERROR' | 'UNKNOWN'; tables: CapturedSourceTable[]; failure?: { sourceId: string; code: string; http?: number; retryAfter?: string }; }
export interface RunRegistryWriteResult { status: 'RECORDED' | 'REUSED'; record: CapturedRunRecord; }
export interface RunRegistryOptions { projectRoot?: string; registryDir?: string; }
const maxRegistryBytes = 16 * 1024 * 1024, maxRegistryEntries = 20000, maxLineBytes = 128 * 1024, maxRefs = 2000;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en')));
});
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const hashBytes = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validRunId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const projectRootOf = (options: RunRegistryOptions) => path.resolve(options.projectRoot ?? ROOT);

function semanticBody(record: CapturedRunRecord) {
  return { schemaVersion: record.schemaVersion, manifestVersion: record.manifestVersion, universeId: record.universeId, universeVersion: record.universeVersion,
    contractVersions: [...record.contractVersions].sort(), policyVersion: record.policyVersion, action: record.action, executionMode: record.executionMode,
    dataOrigin: record.dataOrigin, status: record.status, hashes: record.hashes, ...(record.sourceInputHash ? { sourceInputHash: record.sourceInputHash } : {}), ...(record.sourceValidation ? { sourceValidation: record.sourceValidation } : {}), evidenceRefs: [...record.evidenceRefs].sort(), artifactRefs: [...record.artifactRefs].sort() };
}
function sanitizeSourceValidation(value: unknown): CapturedSourceValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RUN_REGISTRY_SOURCE_VALIDATION_INVALID');
  const input = value as any;
  const status = ['COMPLETE','PARTIAL','ERROR','UNKNOWN'].includes(input.status) ? input.status : 'UNKNOWN';
  if (!Array.isArray(input.tables) || input.tables.length > 100) throw new Error('RUN_REGISTRY_SOURCE_VALIDATION_INVALID');
  const textFields = ['sourceId','logicalObjectId','describeRequestId','describeQueryId','describeRequestedAt','describeStatement','selectRequestId','selectQueryId','selectRequestedAt','selectStatement'];
  const numberFields = ['expectedRows','actualRows','describeDurationMs','selectDurationMs','rawRowsReceived','requestedLimit','reportedTotal','describeRawRowsReceived','describeRequestedLimit','describeReportedTotal'];
  const booleanFields = ['totalReported','continuationPresent','describeTotalReported','describeContinuationPresent'];
  const enumFields: Record<string, readonly string[]> = { paginationScope: ['CLOSED_BINDING'], paginationStatus: ['TOTAL_MATCHED','TOTAL_UNREPORTED'], describePaginationStatus: ['TOTAL_MATCHED','TOTAL_UNREPORTED'] };
  const hashFields = ['observedSchemaSha256','observedTypedMultisetSha256'];
  const tables = input.tables.map((table: any) => {
    if (!table || typeof table !== 'object' || Array.isArray(table) || typeof table.sourceId !== 'string' || typeof table.logicalObjectId !== 'string' || !['VERIFIED','ERROR','NOT_REQUESTED'].includes(table.status)) throw new Error('RUN_REGISTRY_SOURCE_VALIDATION_INVALID');
    const output: Record<string, unknown> = { sourceId: table.sourceId, logicalObjectId: table.logicalObjectId, status: table.status };
    for (const key of textFields.slice(2)) if (table[key] !== undefined) { if (typeof table[key] !== 'string') throw new Error('RUN_REGISTRY_SOURCE_VALIDATION_INVALID'); output[key] = table[key]; }
    for (const key of numberFields) if (table[key] !== undefined) { if (!Number.isFinite(table[key]) || table[key] < 0) throw new Error('RUN_REGISTRY_SOURCE_VALIDATION_INVALID'); output[key] = table[key]; }
    for (const key of hashFields) if (table[key] !== undefined) { if (!isHash(table[key])) throw new Error('RUN_REGISTRY_SOURCE_VALIDATION_INVALID'); output[key] = table[key]; }
    for (const key of booleanFields) if (table[key] !== undefined) { if (typeof table[key] !== 'boolean') throw new Error('RUN_REGISTRY_SOURCE_VALIDATION_INVALID'); output[key] = table[key]; }
    for (const [key, allowedValues] of Object.entries(enumFields)) if (table[key] !== undefined) { if (!allowedValues.includes(table[key])) throw new Error('RUN_REGISTRY_SOURCE_VALIDATION_INVALID'); output[key] = table[key]; }
    return output as unknown as CapturedSourceTable;
  });
  let failure: CapturedSourceValidation['failure'];
  if (input.failure !== undefined) {
    if (!input.failure || typeof input.failure.sourceId !== 'string' || typeof input.failure.code !== 'string') throw new Error('RUN_REGISTRY_SOURCE_VALIDATION_INVALID');
    failure = { sourceId: input.failure.sourceId, code: input.failure.code, ...(input.failure.http !== undefined && Number.isInteger(input.failure.http) && input.failure.http >= 100 && input.failure.http <= 599 ? { http: input.failure.http } : {}), ...(typeof input.failure.retryAfter === 'string' && input.failure.retryAfter.length <= 128 && !input.failure.retryAfter.includes(String.fromCharCode(10)) && !input.failure.retryAfter.includes(String.fromCharCode(13)) ? { retryAfter: input.failure.retryAfter } : {}) };
  }
  return { status, tables, ...(failure ? { failure } : {}) };
}
function validSourceValidation(value: unknown): value is CapturedSourceValidation {
  try { return canonical(sanitizeSourceValidation(value)) === canonical(value); } catch { return false; }
}
function validateRecord(value: any): value is CapturedRunRecord {
  const allowed = new Set(['schemaVersion','manifestVersion','entryId','runId','semanticFingerprint','universeId','universeVersion','contractVersions','policyVersion','action','executionMode','dataOrigin','status','hashes','sourceInputHash','sourceValidation','evidenceRefs','artifactRefs','capturedAt']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))) return false;
  if (value.schemaVersion !== 1 || value.manifestVersion !== '1.0' || !validRunId(value.runId) || value.entryId !== 'run:' + value.runId ||
    typeof value.universeId !== 'string' || typeof value.universeVersion !== 'string' || value.action !== 'universe.evaluate' ||
    !['LIVE','REPLAY','LOCAL'].includes(value.executionMode) || typeof value.dataOrigin !== 'string' || !['COMPLETE','PARTIAL','FAILED'].includes(value.status) ||
    typeof value.policyVersion !== 'string' || !/^\d+\.\d+$/.test(value.policyVersion) || !Array.isArray(value.contractVersions) || (value.contractVersions.length === 0 && !(value.executionMode === 'LIVE' && value.status === 'PARTIAL')) ||
    value.contractVersions.some((version: unknown) => typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) || new Set(value.contractVersions).size !== value.contractVersions.length ||
    (value.sourceInputHash !== undefined && !isHash(value.sourceInputHash)) || (value.sourceValidation !== undefined && !validSourceValidation(value.sourceValidation)) ||
    !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > maxRefs || value.evidenceRefs.some((ref: unknown) => typeof ref !== 'string' || !ref) ||
    new Set(value.evidenceRefs).size !== value.evidenceRefs.length || typeof value.capturedAt !== 'string' || Number.isNaN(Date.parse(value.capturedAt))) return false;
  const hashKeys = ['code','manifest','config','contracts','policy','inputs','evidence','artifacts'];
  if (!value.hashes || Object.keys(value.hashes).length !== hashKeys.length || hashKeys.some(key => !isHash(value.hashes[key]))) return false;
  if (value.hashes.inputs !== hash({ manifest: value.hashes.manifest, config: value.hashes.config, contracts: value.hashes.contracts, policy: value.hashes.policy })) return false;
  if (!Array.isArray(value.artifactRefs) || value.artifactRefs.length !== 1 || typeof value.artifactRefs[0] !== 'string') return false;
  const artifactRef = value.artifactRefs[0].replaceAll('\\', '/');
  if (!/^\.concordia\/run-registry(?:\/[A-Za-z0-9._-]+)*\/captures\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(artifactRef) || !artifactRef.endsWith('/captures/' + value.runId + '.json')) return false;
  if (artifactRef.split('/').some(segment => segment === '.' || segment === '..')) return false;
  if (!isHash(value.semanticFingerprint)) return false;
  try { return value.semanticFingerprint === hash(semanticBody(value)); } catch { return false; }
}
function resolveRegistryDir(projectRoot: string, requested?: string): { absolute: string; relative: string } {
  const relative = (requested ?? '.concordia/run-registry').replaceAll('\\','/');
  if (!/^\.concordia\/run-registry(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/.test(relative)) throw new TypeError('RUN_REGISTRY_PATH_INVALID');
  const absolute = path.resolve(projectRoot, ...relative.split('/'));
  const rel = path.relative(path.resolve(projectRoot, '.concordia', 'run-registry'), absolute);
  if (rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new TypeError('RUN_REGISTRY_PATH_INVALID');
  return { absolute, relative };
}
function ensureDirectory(projectRoot: string, directory: string): void {
  const root = path.resolve(projectRoot), concordia = path.join(root, '.concordia');
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TypeError('RUN_REGISTRY_PROJECT_ROOT_UNSAFE');
  if (!fs.existsSync(concordia)) fs.mkdirSync(concordia);
  const concordiaStat = fs.lstatSync(concordia);
  if (!concordiaStat.isDirectory() || concordiaStat.isSymbolicLink()) throw new TypeError('RUN_REGISTRY_DIRECTORY_UNSAFE');
  const realRoot = fs.realpathSync(root), realConcordia = fs.realpathSync(concordia);
  if (path.relative(realRoot, realConcordia) !== '.concordia') throw new TypeError('RUN_REGISTRY_DIRECTORY_UNSAFE');
  let current = concordia;
  for (const segment of path.relative(concordia, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('RUN_REGISTRY_DIRECTORY_UNSAFE');
  }
  const realDirectory = fs.realpathSync(directory), relative = path.relative(realConcordia, realDirectory);
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new TypeError('RUN_REGISTRY_DIRECTORY_UNSAFE');
}

function readRecords(registryPath: string): CapturedRunRecord[] {
  if (!fs.existsSync(registryPath)) return [];
  const stat = fs.lstatSync(registryPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxRegistryBytes) throw new Error('RUN_REGISTRY_FILE_UNSAFE_OR_TOO_LARGE');
  const content = fs.readFileSync(registryPath, 'utf8');
  if (content && !content.endsWith('\n')) throw new Error('RUN_REGISTRY_CORRUPT');
  const lines = content ? content.slice(0, -1).split('\n') : [];
  if (lines.length > maxRegistryEntries || lines.some(line => !line || Buffer.byteLength(line) > maxLineBytes)) throw new Error('RUN_REGISTRY_LIMIT_EXCEEDED');
  const records = lines.map(line => { try { return JSON.parse(line); } catch { throw new Error('RUN_REGISTRY_CORRUPT'); } });
  if (records.some(record => !validateRecord(record)) || new Set(records.map(record => record.runId)).size !== records.length) throw new Error('RUN_REGISTRY_CORRUPT');
  return records;
}function withRegistryLock<T>(projectRoot: string, registryDir: string, work: (registryPath: string, captureDir: string) => Promise<T>): Promise<T> {
  ensureDirectory(projectRoot, registryDir);
  const registryPath = path.join(registryDir, 'runs.jsonl'), lockPath = path.join(registryDir, 'runs.lock');
  let fd: number;
  try { fd = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error: any) { if (error?.code === 'EEXIST') return Promise.reject(new Error('RUN_REGISTRY_WRITER_EXISTS')); return Promise.reject(error); }
  const token = randomUUID();
  try { fs.writeFileSync(fd, token); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const captureDir = path.join(registryDir, 'captures');
  return Promise.resolve().then(() => {
    ensureDirectory(projectRoot, captureDir);
    return work(registryPath, captureDir);
  }).finally(() => {
    try {
      const stat = fs.lstatSync(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(lockPath, 'utf8') !== token) throw new Error('RUN_REGISTRY_LOCK_OWNERSHIP_LOST');
      fs.unlinkSync(lockPath);
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  });
}
function appendRecord(registryPath: string, entry: CapturedRunRecord): RunRegistryWriteResult {
  const records = readRecords(registryPath);
  if (fs.existsSync(registryPath) && fs.statSync(registryPath).size > 0) {
    const fd = fs.openSync(registryPath, 'r');
    try { const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, fs.fstatSync(fd).size - 1); if (last[0] !== 10) throw new Error('RUN_REGISTRY_CORRUPT'); } finally { fs.closeSync(fd); }
  }
  const existing = records.find(record => record.runId === entry.runId);
  if (existing) {
    if (existing.semanticFingerprint !== entry.semanticFingerprint) throw new Error('RUN_REGISTRY_IDENTITY_COLLISION');
    return { status: 'REUSED', record: existing };
  }
  const line = JSON.stringify(entry) + '\n';
  if (records.length >= maxRegistryEntries || Buffer.byteLength(line) > maxLineBytes ||
    (fs.existsSync(registryPath) ? fs.statSync(registryPath).size : 0) + Buffer.byteLength(line) > maxRegistryBytes) throw new Error('RUN_REGISTRY_LIMIT_EXCEEDED');
  const fd = fs.openSync(registryPath, 'a', 0o600);
  try { fs.writeFileSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { status: 'RECORDED', record: entry };
}

interface FixtureEvaluation {
  manifestId: string; version: string; universeId: string; executionMode: 'LIVE' | 'LOCAL'; dataOrigin: string; status?: string; sourceValidation?: unknown;
  contractDeclarations?: unknown[]; results: { relationId: string; contract: unknown; evidence: unknown; probeStatus: string; decision: { decisionId: string; verdict: string; reasonCodes: string[]; policyVersion: string } }[];
}
function readProjectFile(projectRoot: string, relative: string): { file: string; bytes: Buffer } {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('RUN_REGISTRY_INPUT_PATH_INVALID');
  const root = path.resolve(projectRoot), rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('RUN_REGISTRY_PROJECT_ROOT_UNSAFE');
  const parts = relative.split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('RUN_REGISTRY_INPUT_PATH_UNSAFE');
  }
  const realRoot = fs.realpathSync(root), realFile = fs.realpathSync(current), rel = path.relative(realRoot, realFile);
  if (rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('RUN_REGISTRY_INPUT_PATH_UNSAFE');
  return { file: current, bytes: fs.readFileSync(current) };
}
function listSourceFiles(projectRoot: string, relativeDir = 'src'): string[] {
  const directory = readProjectDirectory(projectRoot, relativeDir);
  const files: string[] = [];
  const walk = (absolute: string, relative: string) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = path.join(absolute, entry.name), childRelative = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('RUN_REGISTRY_CODE_INPUT_UNSAFE');
      if (entry.isDirectory()) walk(child, childRelative);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(childRelative);
    }
  };
  walk(directory, relativeDir);
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}
function readProjectDirectory(projectRoot: string, relative: string): string {
  const root = path.resolve(projectRoot), parts = relative.split(/[\\/]/).filter(Boolean);
  if (path.isAbsolute(relative) || parts.includes('..')) throw new Error('RUN_REGISTRY_INPUT_PATH_INVALID');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('RUN_REGISTRY_CODE_INPUT_UNSAFE');
  }
  const realRoot = fs.realpathSync(root), realDirectory = fs.realpathSync(current), rel = path.relative(realRoot, realDirectory);
  if (rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('RUN_REGISTRY_CODE_INPUT_UNSAFE');
  return current;
}
function environmentHashes(universeId: string, projectRoot: string, policyVersion?: string) {
  const registryFile = readProjectFile(projectRoot, 'universes/registry.json'), registryText = registryFile.bytes.toString('utf8');
  let manifests: UniverseManifest[];
  try { manifests = JSON.parse(registryText); } catch { throw new Error('RUN_REGISTRY_MANIFEST_INVALID'); }
  if (validateUniverseRegistry(manifests).length) throw new Error('RUN_REGISTRY_MANIFEST_INVALID');
  const manifest = manifests.find(item => item.manifestId === universeId || item.aliases.includes(universeId));
  if (!manifest?.source.configPath) throw new Error('RUN_REGISTRY_UNIVERSE_CONFIG_MISSING');
  const configFile = readProjectFile(projectRoot, manifest.source.configPath), configText = configFile.bytes.toString('utf8');
  let config: any;
  try { config = JSON.parse(configText); } catch { throw new Error('RUN_REGISTRY_UNIVERSE_CONFIG_INVALID'); }
  let sourceInputHash: string | undefined, thresholds: any;
  if (manifest.source.adapterId === 'local-snapshot') {
    if (!Array.isArray(config)) throw new Error('RUN_REGISTRY_SNAPSHOT_CONFIG_INVALID');
    try { thresholds = JSON.parse(readProjectFile(projectRoot, 'config/thresholds.json').bytes.toString('utf8')); } catch { throw new Error('RUN_REGISTRY_POLICY_CONFIG_INVALID'); }
    const profile = config.find((item: any) => item?.manifestId === manifest.manifestId);
    if (!profile || !Array.isArray(profile.tables) || !Array.isArray(profile.relations) || !Array.isArray(profile.candidates)) throw new Error('RUN_REGISTRY_SNAPSHOT_PROFILE_INVALID');
    const files = profile.tables.map((table: any) => {
      if (!table || typeof table.dataPath !== 'string' || typeof table.csvPath !== 'string' || !isHash(table.sha256) || !isHash(table.csvSha256)) throw new Error('RUN_REGISTRY_SNAPSHOT_PROFILE_INVALID');
      const json = readProjectFile(projectRoot, table.dataPath), csv = readProjectFile(projectRoot, table.csvPath);
      const jsonHash = hashBytes(json.bytes), csvHash = hashBytes(csv.bytes);
      if (jsonHash !== table.sha256 || csvHash !== table.csvSha256) throw new Error('RUN_REGISTRY_SNAPSHOT_HASH_MISMATCH');
      return { tableId: table.tableId, dataPath: table.dataPath, jsonHash, csvPath: table.csvPath, csvHash };
    }).sort((a: any, b: any) => String(a.tableId).localeCompare(String(b.tableId), 'en'));
    sourceInputHash = hash({ manifestId: profile.manifestId, version: profile.version, sourceCommit: profile.sourceCommit, profileHash: hash(profile), relationsHash: hash(profile.relations), candidatesHash: hash(profile.candidates), thresholdsHash: hash(thresholds), files });
  }
  else if (manifest.source.adapterId === 'zetaris-json2-live') {
    if (!Array.isArray(config.tables) || typeof config.profileConfigPath !== 'string' || !/^universes\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(config.profileConfigPath)) throw new Error('RUN_REGISTRY_LIVE_BINDING_INVALID');
    const thresholdFile = readProjectFile(projectRoot, 'config/thresholds.json');
    try { thresholds = JSON.parse(thresholdFile.bytes.toString('utf8')); } catch { throw new Error('RUN_REGISTRY_POLICY_CONFIG_INVALID'); }
    const profileFile = readProjectFile(projectRoot, config.profileConfigPath);
    let profiles: any;
    try { profiles = JSON.parse(profileFile.bytes.toString('utf8')); } catch { throw new Error('RUN_REGISTRY_LIVE_PROFILE_INVALID'); }
    const profile = Array.isArray(profiles) ? profiles.find((item: any) => item?.manifestId === manifest.source.profileManifestId) : undefined;
    if (!profile || !Array.isArray(profile.tables) || !Array.isArray(profile.relations) || !Array.isArray(profile.candidates) || !Array.isArray(config.tables)) throw new Error('RUN_REGISTRY_LIVE_PROFILE_INVALID');
    const files = profile.tables.map((table: any) => {
      if (!table || typeof table.dataPath !== 'string' || typeof table.csvPath !== 'string' || !isHash(table.sha256) || !isHash(table.csvSha256)) throw new Error('RUN_REGISTRY_LIVE_PROFILE_INVALID');
      const json = readProjectFile(projectRoot, table.dataPath), csv = readProjectFile(projectRoot, table.csvPath);
      const jsonHash = hashBytes(json.bytes), csvHash = hashBytes(csv.bytes);
      if (jsonHash !== table.sha256 || csvHash !== table.csvSha256) throw new Error('RUN_REGISTRY_SNAPSHOT_HASH_MISMATCH');
      return { tableId: table.tableId, dataPath: table.dataPath, jsonHash, csvPath: table.csvPath, csvHash };
    }).sort((a: any, b: any) => String(a.tableId).localeCompare(String(b.tableId), 'en'));
    sourceInputHash = hash({ adapterId: manifest.source.adapterId, manifestId: manifest.manifestId, manifestVersion: manifest.version,
      bindingHash: hashBytes(configFile.bytes), bindingId: config.bindingId, bindingVersion: config.bindingVersion,
      profileConfigPath: config.profileConfigPath, profileConfigHash: hashBytes(profileFile.bytes), profileHash: hash(profile),
      relationsHash: hash(profile.relations), candidatesHash: hash(profile.candidates), thresholdsHash: hash(thresholds), files });
  }  const closurePaths = [...listSourceFiles(projectRoot), 'scripts/run-tsx.mjs', 'package.json', 'package-lock.json', 'tsconfig.json'].sort((a, b) => a.localeCompare(b, 'en'));
  const codeHash = hash({ runtime: process.version, files: closurePaths.map(file => [file, hashBytes(readProjectFile(projectRoot, file).bytes)]) });
  const effectivePolicyVersion = policyVersion ?? config.relationPolicyVersion ?? thresholds?.relationPolicyVersion;
  if (typeof effectivePolicyVersion !== 'string' || !/^\d+\.\d+$/.test(effectivePolicyVersion)) throw new Error('RUN_REGISTRY_POLICY_VERSION_INVALID');
  const policyConfig = ['local-snapshot','zetaris-json2-live'].includes(manifest.source.adapterId) ? thresholds : config;
  const policyHash = hash({ policyVersion: effectivePolicyVersion, minimumDistinctKeys: policyConfig.minimumDistinctKeys ?? null, minimumOverlapRatio: policyConfig.minimumOverlapRatio ?? null, ...(['local-snapshot','zetaris-json2-live'].includes(manifest.source.adapterId) ? { thresholdsHash: hash(policyConfig) } : {}) });
  return { manifest, config, codeHash, manifestHash: hashBytes(registryFile.bytes), configHash: hashBytes(configFile.bytes), policyHash, policyVersion: effectivePolicyVersion, sourceInputHash };
}
function buildRecord(evaluation: FixtureEvaluation, runId: string, registryRelative: string, projectRoot: string): CapturedRunRecord {
  if (!validRunId(runId)) throw new TypeError('RUN_REGISTRY_RUN_ID_INVALID');
  if (!['LOCAL','LIVE'].includes(evaluation.executionMode) || !['SYNTHETIC','PUBLIC','UNKNOWN','USER','MIXED'].includes(evaluation.dataOrigin)) throw new Error('RUN_REGISTRY_PROVENANCE_INVALID');
  const env = environmentHashes(evaluation.universeId, projectRoot);
  if (env.manifest.manifestId !== evaluation.manifestId || env.manifest.version !== evaluation.version) throw new Error('RUN_REGISTRY_MANIFEST_DRIFT');
  const resultContracts = evaluation.results.map(result => result.contract);
  const contracts = resultContracts.length ? resultContracts : evaluation.contractDeclarations ?? [];
  const evidence = evaluation.results.map(result => result.evidence);
  const contractVersions = [...new Set(contracts.map((contract: any) => contract?.contractVersion).filter((version: unknown): version is string => typeof version === 'string'))].sort();
  if ((!contractVersions.length && !(evaluation.executionMode === 'LIVE' && evaluation.status === 'PARTIAL')) || contractVersions.some(version => !/^\d+\.\d+$/.test(version))) throw new Error('RUN_REGISTRY_CONTRACT_VERSION_INVALID');
  const policyVersions = [...new Set(evaluation.results.map(result => result.decision.policyVersion))];
  if (policyVersions.length > 1) throw new Error('RUN_REGISTRY_POLICY_VERSION_MIXED');
  const policyVersion = policyVersions[0] ?? env.policyVersion;
  if (!/^\d+\.\d+$/.test(policyVersion)) throw new Error('RUN_REGISTRY_POLICY_VERSION_INVALID');
  const actualEnv = environmentHashes(evaluation.universeId, projectRoot, policyVersion);
  const evidenceRefs = [...new Set(evidence.map((bundle: any) => bundle?.evidenceBundleId).filter((id: unknown): id is string => typeof id === 'string'))].sort();
  const summaries = evaluation.results.map(result => ({ relationId: result.relationId, probeStatus: result.probeStatus, decisionId: result.decision.decisionId, verdict: result.decision.verdict, reasonCodes: [...result.decision.reasonCodes].sort(), evidenceBundleRef: (result.evidence as any)?.evidenceBundleId })).sort((a, b) => a.relationId.localeCompare(b.relationId, 'en'));
  const hashes = {
    code: actualEnv.codeHash, manifest: actualEnv.manifestHash, config: actualEnv.configHash, contracts: hash(contracts), policy: actualEnv.policyHash,
    inputs: hash({ manifest: actualEnv.manifestHash, config: actualEnv.configHash, contracts: hash(contracts), policy: actualEnv.policyHash }),
    evidence: hash(evidence), artifacts: hash(summaries)
  };
  const failedStatuses = new Set(['ERROR', 'FAILED']);
  const status: CapturedRunStatus = evaluation.status === 'PARTIAL' ? 'PARTIAL' : evaluation.status === 'ERROR' ? 'FAILED' : !evaluation.results.length || evaluation.results.every(result => failedStatuses.has(result.probeStatus)) ? 'FAILED' :
    evaluation.results.every(result => result.probeStatus === 'COMPLETE') ? 'COMPLETE' : 'PARTIAL';
  const artifactRef = `${registryRelative.replaceAll('\\','/')}/captures/${runId}.json`;
  const body = { schemaVersion: 1 as const, manifestVersion: '1.0' as const, universeId: evaluation.manifestId, universeVersion: evaluation.version, contractVersions, policyVersion,
    action: 'universe.evaluate' as const, executionMode: evaluation.executionMode, dataOrigin: evaluation.dataOrigin, status, hashes, ...(actualEnv.sourceInputHash ? { sourceInputHash: actualEnv.sourceInputHash } : {}), ...(evaluation.sourceValidation ? { sourceValidation: sanitizeSourceValidation(evaluation.sourceValidation) } : {}), evidenceRefs };
  return { ...body, entryId: `run:${runId}`, runId, semanticFingerprint: hash(semanticBody({ ...body, entryId: `run:${runId}`, runId, semanticFingerprint: '', artifactRefs: [artifactRef], capturedAt: '' } as CapturedRunRecord)), evidenceRefs, artifactRefs: [artifactRef], capturedAt: new Date().toISOString() };
}
function safeCaptureFile(captureDir: string, runId: string): string {
  if (!validRunId(runId)) throw new TypeError('RUN_REGISTRY_RUN_ID_INVALID');
  const file = path.join(captureDir, `${runId}.json`), relative = path.relative(captureDir, file);
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new TypeError('RUN_REGISTRY_CAPTURE_PATH_INVALID');
  return file;
}
function readCaptureFile(file: string, runId: string): CapturedRunRecord {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxLineBytes) throw new Error('RUN_REGISTRY_CAPTURE_UNSAFE');
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('RUN_REGISTRY_CAPTURE_CORRUPT'); }
  if (!validateRecord(value) || value.runId !== runId) throw new Error('RUN_REGISTRY_CAPTURE_CORRUPT');
  return value;
}
function writeCaptureFile(file: string, entry: CapturedRunRecord): CapturedRunRecord {
  const content = JSON.stringify(entry) + '\n';
  if (Buffer.byteLength(content) > maxLineBytes) throw new Error('RUN_REGISTRY_CAPTURE_TOO_LARGE');
  let fd: number;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readCaptureFile(file, entry.runId);
    if (existing.semanticFingerprint !== entry.semanticFingerprint) throw new Error('RUN_REGISTRY_IDENTITY_COLLISION');
    return existing;
  }
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return entry;
}

function captureLocation(runId: string, options: RunRegistryOptions) {
  if (!validRunId(runId)) throw new TypeError('RUN_REGISTRY_RUN_ID_INVALID');
  const projectRoot = projectRootOf(options), resolved = resolveRegistryDir(projectRoot, options.registryDir);
  return { projectRoot, ...resolved, captureFile: safeCaptureFile(path.join(resolved.absolute, 'captures'), runId) };
}

/** Read only the metadata capture. This never invokes the evaluator or a source adapter. */
export function readCapturedRun(runId: string, options: RunRegistryOptions = {}): CapturedRunRecord | null {
  const location = captureLocation(runId, options);
  ensureDirectory(location.projectRoot, path.join(location.absolute, 'captures'));
  try {
    const record = readCaptureFile(location.captureFile, runId);
    const expectedRef = location.relative.replaceAll('\\', '/') + '/captures/' + runId + '.json';
    if (record.artifactRefs[0] !== expectedRef) throw new Error('RUN_REGISTRY_CAPTURE_CORRUPT');
    return record;
  } catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
}
/** Append a previously captured run. Safe to retry after an interrupted registry append. */
export async function registerCapturedRun(runId: string, options: RunRegistryOptions = {}): Promise<RunRegistryWriteResult> {
  const location = captureLocation(runId, options);
  return withRegistryLock(location.projectRoot, location.absolute, async (registryPath, captureDir) => {
    const entry = readCaptureFile(safeCaptureFile(captureDir, runId), runId);
    const expectedRef = location.relative.replaceAll('\\', '/') + '/captures/' + runId + '.json';
    if (entry.artifactRefs[0] !== expectedRef) throw new Error('RUN_REGISTRY_CAPTURE_CORRUPT');
    assertCapturedRunInputsCurrent(entry, location.projectRoot);
    return appendRecord(registryPath, entry);
  });
}
/** Capture a local synthetic fixture result, then append its metadata-only registry record. */
export async function captureLocalFixtureRun(evaluation: FixtureEvaluation, runId: string, options: RunRegistryOptions = {}): Promise<RunRegistryWriteResult> {
  if (evaluation.executionMode !== 'LOCAL') throw new Error('RUN_REGISTRY_LOCAL_PROVENANCE_INVALID');
  const location = captureLocation(runId, options);
  return withRegistryLock(location.projectRoot, location.absolute, async (registryPath, captureDir) => {
    const entry = buildRecord(evaluation, runId, location.relative, location.projectRoot);
    const captured = writeCaptureFile(safeCaptureFile(captureDir, runId), entry);
    return appendRecord(registryPath, captured);
  });
}

/** Capture a LIVE evaluation summary and safe source DTOs; no sampled rows are persisted. */
export async function captureLiveRun(evaluation: FixtureEvaluation, runId: string, options: RunRegistryOptions = {}): Promise<RunRegistryWriteResult> {
  if (evaluation.executionMode !== 'LIVE') throw new Error('RUN_REGISTRY_LIVE_PROVENANCE_REQUIRED');
  const env = environmentHashes(evaluation.universeId, projectRootOf(options));
  if (env.manifest.source.adapterId !== 'zetaris-json2-live' || !env.sourceInputHash) throw new Error('RUN_REGISTRY_LIVE_UNIVERSE_REQUIRED');
  const location = captureLocation(runId, options);
  return withRegistryLock(location.projectRoot, location.absolute, async (registryPath, captureDir) => {
    const entry = buildRecord(evaluation, runId, location.relative, location.projectRoot);
    const captured = writeCaptureFile(safeCaptureFile(captureDir, runId), entry);
    return appendRecord(registryPath, captured);
  });
}
/** Capture only a registered local-snapshot result, after hashing its pinned inputs. */
export async function captureLocalSnapshotRun(evaluation: FixtureEvaluation, runId: string, options: RunRegistryOptions = {}): Promise<RunRegistryWriteResult> {
  const env=environmentHashes(evaluation.universeId,projectRootOf(options));
  if(env.manifest.source.adapterId!=='local-snapshot'||!env.sourceInputHash)throw new Error('RUN_REGISTRY_LOCAL_SNAPSHOT_REQUIRED');
  return captureLocalFixtureRun(evaluation,runId,options);
}

/** Check offline code/config inputs before reusing a prior capture; this does not evaluate. */
export function assertCapturedRunInputsCurrent(record: CapturedRunRecord, projectRoot = ROOT, policyVersion?: string): void {
  const env = environmentHashes(record.universeId, path.resolve(projectRoot), policyVersion);
  if (env.manifest.manifestId !== record.universeId || env.manifest.version !== record.universeVersion ||
    env.codeHash !== record.hashes.code || env.manifestHash !== record.hashes.manifest || env.configHash !== record.hashes.config ||
    env.policyHash !== record.hashes.policy || env.policyVersion !== record.policyVersion || env.sourceInputHash !== record.sourceInputHash) throw new Error('RUN_REGISTRY_IDENTITY_COLLISION');
}
