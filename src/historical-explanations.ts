import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Nightshift, type Receipt } from './clients/nightshift.ts';
import { ROOT, SafeError, failure, loadLocalEnv } from './runtime.ts';
import { resolveUniverseManifest, type UniverseManifest } from './registry/universes.ts';
import { validateDecision, validateEvidenceBundle, validateRelationContract } from './contracts/validate.ts';
import { buildExplanationInput, modelMessages, parseExplanationResponse, validReceipt, type LiveEvaluationForExplanation, type ExplanationArtifact, type ExplanationRunResult } from './live-explanations.ts';

export type ExplanationCapturePin = {
  captureId: string; inputRef: string; inputSha256: string; runId: string; manifestId: string; manifestVersion: string; sourceAdapterId: string;
  sourceExecutionMode: 'REPLAY'; sourceCaptureExecutionMode: 'LIVE'; modelExecutionMode: 'LIVE'; producerCommit: string;
  captureTime: { status: 'UPPER_BOUND_ONLY'; upperBound: string };
  sourceValidation: { status: 'COMPLETE'; tableStatus: 'VERIFIED'; tableCount: number; totalRows: number };
  bounds: { maxInputBytes: number; maxCandidates: number };
};
export type ExplanationCaptureRegistry = { schemaVersion: 1; captures: ExplanationCapturePin[] };
export const EXPLANATION_CAPTURE_REGISTRY_PATH = 'universes/explanation-captures.json';
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const hashBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Client = { chat(messages: { role: 'system' | 'user'; content: string }[], options: { maxTokens: number; route: string; preserveTextOnFailure: true }): Promise<{ text: string; receipt: Receipt; policyAlerts: string[]; finishReason?: string; stopReason?: string; truncated?: boolean }> };
type CaptureMetadata = { sourceCommit: string; sourcePackage: string; semanticFingerprint: string; frozenInputHash: string; adaptedConfigSha256: string; sourceBindingId: string; sourceBindingVersion: string; sourceTablesVerified: number; sourceRowsVerified: number };
export type HistoricalExplanationArtifact = ExplanationArtifact & {
  taskId: string; sourceExecutionMode: 'REPLAY'; sourceCaptureExecutionMode: 'LIVE'; modelExecutionMode: 'LIVE'; sourceCaptureRunId: string;
  sourceCapturedAt: 'UNKNOWN'; sourceCaptureTimeStatus: 'UPPER_BOUND_ONLY'; sourceCaptureTimeUpperBound: string; sourceProductCommit: string; inputRef: string; inputSha256: string; captureMetadata: CaptureMetadata;
};

const inputRefPattern = /^\.concordia\/live-explanations\/inputs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;
const hash64 = /^[a-f0-9]{64}$/;
const hash40 = /^[a-f0-9]{40}$/i;
const safeRegistryId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function validateExplanationCaptureRegistry(value: unknown): string[] {
  const issues: string[] = [];
  if (!object(value) || value.schemaVersion !== 1 || (!Array.isArray(value.captures) || value.captures.length === 0)) return ['REGISTRY_SCHEMA_INVALID'];
  const ids = new Set<string>(), inputs = new Set<string>();
  for (const [index, pin] of value.captures.entries()) {
    if (!object(pin)) { issues.push(`captures[${index}]:EXPECTED_OBJECT`); continue; }
    if (!safeRegistryId(pin.captureId) || ids.has(pin.captureId)) issues.push(`captures[${index}].captureId:INVALID_OR_DUPLICATE`);
    if (typeof pin.captureId === 'string') ids.add(pin.captureId);
    if (typeof pin.inputRef !== 'string' || !inputRefPattern.test(pin.inputRef) || !hash64.test(pin.inputSha256 ?? '')) issues.push(`captures[${index}].input:INVALID_PATH_OR_HASH`);
    const inputIdentity = `${pin.inputRef}:${pin.inputSha256}`;
    if (inputs.has(inputIdentity)) issues.push(`captures[${index}].input:ALREADY_REGISTERED`); inputs.add(inputIdentity);
    if (!safeRegistryId(pin.runId) || !safeRegistryId(pin.manifestId) || !/^\d+\.\d+\.\d+$/.test(pin.manifestVersion ?? '') || !safeRegistryId(pin.sourceAdapterId)) issues.push(`captures[${index}].identity:INVALID`);
    if (pin.sourceExecutionMode !== 'REPLAY' || pin.sourceCaptureExecutionMode !== 'LIVE' || pin.modelExecutionMode !== 'LIVE') issues.push(`captures[${index}].modes:INVALID`);
    if (!hash40.test(pin.producerCommit ?? '')) issues.push(`captures[${index}].producerCommit:INVALID`);
    if (!object(pin.captureTime) || pin.captureTime.status !== 'UPPER_BOUND_ONLY' || typeof pin.captureTime.upperBound !== 'string' || Number.isNaN(Date.parse(pin.captureTime.upperBound))) issues.push(`captures[${index}].captureTime:INVALID`);
    if (!object(pin.sourceValidation) || pin.sourceValidation.status !== 'COMPLETE' || pin.sourceValidation.tableStatus !== 'VERIFIED' || !Number.isSafeInteger(pin.sourceValidation.tableCount) || pin.sourceValidation.tableCount < 1 || !Number.isSafeInteger(pin.sourceValidation.totalRows) || pin.sourceValidation.totalRows < 1) issues.push(`captures[${index}].sourceValidation:INVALID`);
    if (!object(pin.bounds) || !Number.isSafeInteger(pin.bounds.maxInputBytes) || pin.bounds.maxInputBytes < 1 || pin.bounds.maxInputBytes > 2_097_152 || !Number.isSafeInteger(pin.bounds.maxCandidates) || pin.bounds.maxCandidates < 1 || pin.bounds.maxCandidates > 512) issues.push(`captures[${index}].bounds:INVALID`);
  }
  return issues;
}
export function resolveExplanationCapturePin(inputRef: string, inputSha256: string, manifest: UniverseManifest, registry: unknown): ExplanationCapturePin {
  const issues = validateExplanationCaptureRegistry(registry);
  if (issues.length) throw new SafeError('EXPLANATION_CAPTURE_REGISTRY_INVALID', undefined, issues.join(','));
  const captures = (registry as ExplanationCaptureRegistry).captures.filter(pin => pin.inputRef === inputRef && pin.inputSha256 === inputSha256);
  if (captures.length !== 1) throw new SafeError('HISTORICAL_CAPTURE_NOT_REGISTERED');
  const pin = captures[0];
  if (pin.manifestId !== manifest.manifestId || pin.manifestVersion !== manifest.version || pin.sourceAdapterId !== manifest.source.adapterId) throw new SafeError('HISTORICAL_CAPTURE_MANIFEST_MISMATCH');
  return pin;
}
export function loadExplanationCaptureRegistry(projectRoot = ROOT): ExplanationCaptureRegistry {
  const file = path.resolve(projectRoot, EXPLANATION_CAPTURE_REGISTRY_PATH);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new SafeError('EXPLANATION_CAPTURE_REGISTRY_UNSAFE');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const issues = validateExplanationCaptureRegistry(value);
  if (issues.length) throw new SafeError('EXPLANATION_CAPTURE_REGISTRY_INVALID', undefined, issues.join(','));
  return value as ExplanationCaptureRegistry;
}
function approvedInputPath(inputRef: string, projectRoot: string, maxInputBytes: number): string {
  if (!inputRefPattern.test(inputRef)) throw new SafeError('HISTORICAL_INPUT_PATH_NOT_APPROVED');
  const root = path.resolve(projectRoot), file = path.resolve(root, inputRef.replaceAll('/', path.sep));
  if (!file.startsWith(path.resolve(root, '.concordia', 'live-explanations', 'inputs') + path.sep)) throw new SafeError('HISTORICAL_INPUT_PATH_INVALID');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part); const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new SafeError('HISTORICAL_INPUT_PATH_UNSAFE');
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxInputBytes) throw new SafeError('HISTORICAL_INPUT_FILE_INVALID');
  const realParent = fs.realpathSync(path.dirname(file)), realFile = fs.realpathSync(file);
  if (path.dirname(realFile) !== realParent) throw new SafeError('HISTORICAL_INPUT_PATH_UNSAFE');
  return file;
}
function taskDirectory(projectRoot: string, create: boolean): string | undefined {
  const root = path.resolve(projectRoot), rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new SafeError('EXPLANATION_PROJECT_ROOT_UNSAFE');
  const dirs = [path.join(root, '.concordia'), path.join(root, '.concordia', 'live-explanations'), path.join(root, '.concordia', 'live-explanations', 'tasks')];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SafeError('EXPLANATION_TASK_DIRECTORY_UNSAFE');
    } else if (create) fs.mkdirSync(dir);
    else return undefined;
  }
  const realBase = fs.realpathSync(dirs[1]), realDir = fs.realpathSync(dirs[2]);
  if (path.dirname(realDir) !== realBase) throw new SafeError('EXPLANATION_TASK_DIRECTORY_UNSAFE');
  return dirs[2];
}
function taskPaths(taskId: string, projectRoot: string, create: boolean) {
  if (!idPattern.test(taskId)) throw new SafeError('EXPLANATION_TASK_ID_INVALID');
  const dir = taskDirectory(projectRoot, create);
  if (!dir) return undefined;
  const file = path.join(dir, taskId + '.json'), intent = path.join(dir, taskId + '.intent'), dispatch = path.join(dir, taskId + '.dispatch');
  for (const target of [file, intent, dispatch]) if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new SafeError('EXPLANATION_TASK_ARTIFACT_UNSAFE');
  }
  return { dir, file, intent, dispatch };
}
export function validateHistoricalCapturePayload(value: any, manifest: UniverseManifest, pin: ExplanationCapturePin): { evaluation: LiveEvaluationForExplanation; metadata: CaptureMetadata } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.runId !== pin.runId || value.manifestId !== manifest.manifestId ||
      value.manifestId !== pin.manifestId || value.version !== manifest.version || value.version !== pin.manifestVersion ||
      value.executionMode !== pin.sourceCaptureExecutionMode || value.status !== 'EVALUATED' || value.sourceValidation?.status !== pin.sourceValidation.status ||
      typeof value.sourceBindingId !== 'string' || !value.sourceBindingId || typeof value.sourceBindingVersion !== 'string' || !value.sourceBindingVersion ||
      typeof value.sourceCommit !== 'string' || typeof value.sourcePackage !== 'string' || typeof value.frozenInputHash !== 'string' ||
      typeof value.adaptedConfigSha256 !== 'string' || typeof value.semanticFingerprint !== 'string' || !Array.isArray(value.decisions) ||
      value.decisions.length === 0 || !Number.isInteger(value.candidateCount) || value.decisions.length > value.candidateCount || value.candidateCount > pin.bounds.maxCandidates) throw new SafeError('HISTORICAL_CAPTURE_PROVENANCE_INVALID');
  if (!/^[a-f0-9]{40}$/i.test(value.sourceCommit) || !/^[a-f0-9]{64}$/.test(value.frozenInputHash) || !/^[a-f0-9]{64}$/.test(value.adaptedConfigSha256) || !/^[a-f0-9]{64}$/.test(value.semanticFingerprint)) throw new SafeError('HISTORICAL_CAPTURE_HASH_FIELDS_INVALID');
  const tables = value.sourceValidation.tables;
  if (!Array.isArray(tables) || tables.length !== pin.sourceValidation.tableCount || tables.some((table: any) => !table || table.status !== pin.sourceValidation.tableStatus || !Number.isInteger(table.expectedRows) || table.expectedRows < 0 || table.actualRows !== table.expectedRows) || tables.reduce((sum: number, table: any) => sum + table.actualRows, 0) !== pin.sourceValidation.totalRows) throw new SafeError('HISTORICAL_SOURCE_VALIDATION_INVALID');
  const candidateIds = new Set<string>();
  const candidateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  for (const item of value.decisions) {
    if (!item || typeof item !== 'object' || typeof item.candidateId !== 'string' || !candidateIdPattern.test(item.candidateId) || candidateIds.has(item.candidateId)) throw new SafeError('HISTORICAL_CANDIDATE_INVALID');
    candidateIds.add(item.candidateId);
    const contract = item.contract, evidence = item.evidenceBundle, decision = item.decision;
    if (!contract || !evidence || !decision || validateRelationContract(contract).length || contract.universeRef.universeId !== manifest.source.profileManifestId || contract.id !== item.relationContractRef || contract.contractVersion !== item.contractVersion) throw new SafeError('HISTORICAL_CONTRACT_INVALID');
    if (validateEvidenceBundle(evidence).length || evidence.relationRef !== contract.id || evidence.contractVersion !== contract.contractVersion || evidence.runRef.runId !== value.runId || evidence.runRef.executionMode !== 'LIVE') throw new SafeError('HISTORICAL_EVIDENCE_INVALID');
    if (validateDecision(decision).length || decision.relationRef !== contract.id || decision.contractVersion !== contract.contractVersion || !decision.evidenceBundleRefs.includes(evidence.evidenceBundleId)) throw new SafeError('HISTORICAL_DECISION_INVALID');
  }
  const evaluation: LiveEvaluationForExplanation = { runId: value.runId, manifestId: value.manifestId, version: value.version, executionMode: 'LIVE', dataOrigin: value.dataOrigin, status: value.status, sourceValidation: value.sourceValidation, decisions: value.decisions.map((item: any) => ({ candidateId: item.candidateId, contract: item.contract, decision: item.decision, evidenceBundle: item.evidenceBundle, evidenceRef: item.evidenceRef })) };
  return { evaluation, metadata: { sourceCommit: value.sourceCommit, sourcePackage: value.sourcePackage, semanticFingerprint: value.semanticFingerprint, frozenInputHash: value.frozenInputHash, adaptedConfigSha256: value.adaptedConfigSha256, sourceBindingId: value.sourceBindingId, sourceBindingVersion: value.sourceBindingVersion, sourceTablesVerified: tables.length, sourceRowsVerified: pin.sourceValidation.totalRows } };
}
function writeTaskAtomically(dir: string, file: string, task: Record<string, unknown>) {
  const body = JSON.stringify(task), taskSha256 = createHash('sha256').update(body).digest('hex'), temp = path.join(dir, '.' + randomUUID() + '.tmp');
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ ...task, taskSha256 }, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function readVerifiedTask(file: string, taskId: string, inputRef: string, inputSha256: string, runId: string) {
  const prior = JSON.parse(fs.readFileSync(file, 'utf8')), { taskSha256, ...body } = prior;
  if (prior.schemaVersion !== 1 || prior.taskId !== taskId || prior.inputSha256 !== inputSha256 || prior.inputRef !== inputRef || prior.sourceCaptureRunId !== runId || taskSha256 !== createHash('sha256').update(JSON.stringify(body)).digest('hex')) throw new SafeError('EXPLANATION_TASK_ID_CONFLICT');
  return prior;
}
function readVerifiedIntent(file: string, intent: any, inputSha256: string, taskId: string, runId: string, manifest: UniverseManifest, pin: ExplanationCapturePin, metadata: CaptureMetadata, messages: unknown[], promptSha256: string): string {
  if (!intent || intent.schemaVersion !== 1 || intent.taskId !== taskId || intent.inputRef !== pin.inputRef || intent.inputSha256 !== inputSha256 || intent.sourceCaptureRunId !== runId ||
      intent.sourceExecutionMode !== pin.sourceExecutionMode || intent.sourceCaptureExecutionMode !== pin.sourceCaptureExecutionMode || intent.modelExecutionMode !== pin.modelExecutionMode ||
      intent.manifestId !== manifest.manifestId || intent.manifestVersion !== manifest.version || intent.sourceProductCommit !== pin.producerCommit ||
      intent.sourceCapturedAt !== 'UNKNOWN' || intent.sourceCaptureTimeStatus !== pin.captureTime.status || intent.sourceCaptureTimeUpperBound !== pin.captureTime.upperBound ||
      JSON.stringify(intent.captureMetadata) !== JSON.stringify(metadata) || intent.promptSha256 !== promptSha256 || JSON.stringify(intent.messages) !== JSON.stringify(messages)) throw new SafeError('EXPLANATION_TASK_INTENT_MISMATCH');
  const bytes = fs.readFileSync(file), parsed = JSON.parse(bytes.toString('utf8'));
  if (JSON.stringify(parsed) !== JSON.stringify(intent)) throw new SafeError('EXPLANATION_TASK_INTENT_CORRUPT');
  return hashBytes(bytes);
}
export async function explainHistoricalCapture(inputRef: string, inputSha256: string, taskId: string, universeId: string, options: {
  projectRoot?: string; clientFactory?: () => Client; nightshiftFactory?: () => Client; environmentLoader?: () => void; now?: () => string;
  phase?: 'prepare' | 'dispatch'; captureRegistry?: unknown;
} = {}): Promise<ExplanationRunResult> {
  const projectRoot = options.projectRoot ?? ROOT, phase = options.phase ?? 'prepare';
  if (typeof inputSha256 !== 'string' || !hash64.test(inputSha256)) throw new SafeError('HISTORICAL_INPUT_HASH_INVALID');
  const manifest = resolveUniverseManifest(universeId);
  if (!manifest) throw new SafeError('INVALID_UNIVERSE');
  const registry = options.captureRegistry ?? loadExplanationCaptureRegistry(projectRoot);
  const pin = resolveExplanationCapturePin(inputRef, inputSha256, manifest, registry);
  const sourcePath = approvedInputPath(inputRef, projectRoot, pin.bounds.maxInputBytes), bytes = fs.readFileSync(sourcePath);
  if (bytes.length > pin.bounds.maxInputBytes || hashBytes(bytes) !== pin.inputSha256) throw new SafeError('HISTORICAL_CAPTURE_HASH_MISMATCH');
  let capture: any;
  try { capture = JSON.parse(bytes.toString('utf8')); } catch { throw new SafeError('HISTORICAL_CAPTURE_JSON_INVALID'); }
  const { evaluation, metadata } = validateHistoricalCapturePayload(capture, manifest, pin), paths = taskPaths(taskId, projectRoot, true)!;
  if (fs.existsSync(paths.file)) {
    const prior = readVerifiedTask(paths.file, taskId, inputRef, inputSha256, evaluation.runId);
    return { explanationStatus: 'HISTORICAL_OUTPUT_AVAILABLE', generationStatus: 'HISTORICAL', artifactRef: path.relative(projectRoot, paths.file).replaceAll('\\', '/'), artifact: prior.explanation };
  }
  const explanationInput = buildExplanationInput(evaluation);
  const allowlisted = {
    ...explanationInput, executionMode: pin.sourceExecutionMode, sourceExecutionMode: pin.sourceExecutionMode,
    semanticGrounding: { ...explanationInput.semanticGrounding, executionMode: pin.sourceExecutionMode },
    sourceCaptureExecutionMode: pin.sourceCaptureExecutionMode, historicalEvidence: true, sourceCapturedAt: 'UNKNOWN',
    sourceCaptureTimeStatus: pin.captureTime.status, sourceCaptureTimeUpperBound: pin.captureTime.upperBound, sourceProductCommit: pin.producerCommit
  };
  const messages = modelMessages(allowlisted as any), promptSha256 = hashBytes(Buffer.from(JSON.stringify(messages), 'utf8'));
  let intentSha256: string;
  if (fs.existsSync(paths.intent)) {
    const intent = JSON.parse(fs.readFileSync(paths.intent, 'utf8'));
    intentSha256 = readVerifiedIntent(paths.intent, intent, inputSha256, taskId, evaluation.runId, manifest, pin, metadata, messages, promptSha256);
  } else {
    if (phase === 'dispatch') throw new SafeError('EXPLANATION_TASK_NOT_PREPARED');
    const intent = {
      schemaVersion: 1, taskId, inputRef, inputSha256, sourceCaptureRunId: evaluation.runId,
      sourceExecutionMode: pin.sourceExecutionMode, sourceCaptureExecutionMode: pin.sourceCaptureExecutionMode, modelExecutionMode: pin.modelExecutionMode,
      manifestId: manifest.manifestId, manifestVersion: manifest.version, sourceProductCommit: pin.producerCommit,
      sourceCapturedAt: 'UNKNOWN', sourceCaptureTimeStatus: pin.captureTime.status, sourceCaptureTimeUpperBound: pin.captureTime.upperBound,
      captureMetadata: metadata, promptSha256, messages, reservedAt: (options.now ?? (() => new Date().toISOString()))()
    };
    const intentText = JSON.stringify(intent, null, 2) + '\n'; intentSha256 = hashBytes(Buffer.from(intentText, 'utf8'));
    let fd: number;
    try { fd = fs.openSync(paths.intent, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SafeError('EXPLANATION_TASK_PENDING_NO_RETRY'); throw error; }
    try { fs.writeFileSync(fd, intentText); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (phase === 'prepare') {
    if (fs.existsSync(paths.dispatch)) throw new SafeError('EXPLANATION_TASK_PENDING_NO_RETRY');
    return { explanationStatus: 'PREPARED_FOR_DISPATCH', generationStatus: 'NOT_RUN', artifactRef: path.relative(projectRoot, paths.intent).replaceAll('\\', '/'), intentSha256, promptSha256 };
  }
  let dispatchFd: number;
  try { dispatchFd = fs.openSync(paths.dispatch, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SafeError('EXPLANATION_TASK_PENDING_NO_RETRY'); throw error; }
  try { fs.writeFileSync(dispatchFd, JSON.stringify({ taskId, inputSha256, intentSha256, promptSha256, reservedAt: (options.now ?? (() => new Date().toISOString()))() }) + '\n'); fs.fsyncSync(dispatchFd); } finally { fs.closeSync(dispatchFd); }
  const ids = evaluation.decisions.map(item => item.candidateId);
  let responseText: string | undefined, receipt: Receipt | undefined, policyAlerts: string[] = [], err: ExplanationArtifact['error'];
  let generationStatus: ExplanationArtifact['generationStatus'] = 'ERROR', receiptStatus: ExplanationArtifact['receiptStatus'] = 'UNVERIFIED', explanations: any[] = [], status: ExplanationArtifact['status'] = 'ERROR';
  let finishReason: string | undefined, stopReason: string | undefined, responseTruncated = false;
  try {
    const client = options.clientFactory
      ? options.clientFactory()
      : (() => { (options.environmentLoader ?? loadLocalEnv)(); return (options.nightshiftFactory ?? (() => new Nightshift()))(); })();
    const result = await client.chat(messages, { maxTokens: 2000, route: 'meterless/cheap', preserveTextOnFailure: true });
    responseText = result.text; receipt = result.receipt; policyAlerts = Array.isArray(result.policyAlerts) ? [...result.policyAlerts] : [];
    finishReason = result.finishReason; stopReason = result.stopReason; responseTruncated = result.truncated === true;
    if (!validReceipt(receipt)) throw new SafeError('EXPLANATION_RECEIPT_INVALID');
    receiptStatus = receipt.fromCache ? 'VERIFIED_CACHED' : 'VERIFIED';
    if (receipt.fromCache) throw new SafeError('EXPLANATION_CACHED_RESPONSE_NOT_LIVE');
    generationStatus = 'PASS';
    if (responseTruncated) throw new SafeError('EXPLANATION_RESPONSE_TRUNCATED');
    explanations = parseExplanationResponse(responseText, ids); status = 'PASS';
  } catch (error) {
    const detail = error as { responseText?: unknown; receipt?: Receipt; receiptValidated?: boolean; finishReason?: string; stopReason?: string; responseTruncated?: boolean };
    if (!responseText && typeof detail.responseText === 'string') responseText = detail.responseText;
    if (!receipt && detail.receipt) receipt = detail.receipt;
    finishReason ??= detail.finishReason; stopReason ??= detail.stopReason; responseTruncated ||= detail.responseTruncated === true;
    if (detail.receiptValidated && receipt && !receipt.fromCache) { receiptStatus = 'VERIFIED'; generationStatus = 'PASS'; }
    else if (receipt?.fromCache) receiptStatus = 'VERIFIED_CACHED';
    err = failure(error);
  }
  const artifact: HistoricalExplanationArtifact = {
    schemaVersion: 1, taskId, runId: taskId, universeId: manifest.manifestId, universeVersion: manifest.version, status,
    generationStatus, receiptStatus, ...(finishReason ? { finishReason } : {}), ...(stopReason ? { stopReason } : {}), responseTruncated, evaluationFingerprint: createHash('sha256').update(JSON.stringify({ inputSha256, evaluation })).digest('hex'), semanticGrounding: allowlisted.semanticGrounding,
    ...(responseText !== undefined ? { responseText } : {}), explanations, ...(receipt ? { receipt } : {}), policyAlerts, ...(err ? { error: err } : {}),
    createdAt: (options.now ?? (() => new Date().toISOString()))(), sourceExecutionMode: pin.sourceExecutionMode,
    sourceCaptureExecutionMode: pin.sourceCaptureExecutionMode, modelExecutionMode: pin.modelExecutionMode, sourceCaptureRunId: evaluation.runId,
    sourceCapturedAt: 'UNKNOWN', sourceCaptureTimeStatus: pin.captureTime.status, sourceCaptureTimeUpperBound: pin.captureTime.upperBound,
    sourceProductCommit: pin.producerCommit, inputRef, inputSha256, captureMetadata: metadata
  };
  const task = {
    schemaVersion: 1, taskId, inputRef, inputSha256, sourceCaptureRunId: evaluation.runId,
    sourceCaptureExecutionMode: pin.sourceCaptureExecutionMode, sourceExecutionMode: pin.sourceExecutionMode, modelExecutionMode: pin.modelExecutionMode,
    manifestId: manifest.manifestId, manifestVersion: manifest.version, sourceProductCommit: pin.producerCommit, promptSha256,
    intentRef: path.relative(projectRoot, paths.intent).replaceAll('\\', '/'), intentSha256, explanation: artifact, createdAt: artifact.createdAt
  };
  writeTaskAtomically(paths.dir, paths.file, task);
  return { explanationStatus: status, generationStatus, artifactRef: path.relative(projectRoot, paths.file).replaceAll('\\', '/'), artifact, intentSha256, promptSha256, ...(err ? { error: err } : {}) };
}