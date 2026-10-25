import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CandidateContribution } from '../discovery/candidates.ts';
import { fingerprint, produceCandidates } from '../discovery/candidates.ts';
import { createU1HeuristicProvider } from '../discovery/index.ts';
import { COMA_EFFECTIVE_CONFIGURATION, createComaProvider, createInstalledComaBridge, type ComaPair, type ComaSchemaInput } from '../discovery/coma-provider.ts';
import type { CandidateProductionEnvelope } from '../discovery/candidates.ts';
import { evaluateRelation, type RelationPolicy } from '../relations/decision.ts';
import type { Candidate, Decision } from '../contracts/types.ts';

const INPUT_DIR = '.concordia/level2-runs/E05D-comparison-20261023-01';
const INPUTS = { snapshot: `${INPUT_DIR}/input.json`, cases: `${INPUT_DIR}/case-universe.json`, freeze: `${INPUT_DIR}/input-freeze.json`, codeFreeze: `${INPUT_DIR}/code-policy-freeze.json` } as const;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const endpointKey = (value: { db: string; table: string; column: string }) => JSON.stringify([value.db, value.table, value.column]);
const safeRunId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);

function readFixedProjectJson<T>(root: string, relative: string): { value: T; bytes: Buffer } {
  const bytes = readFixedProjectBytes(root, relative);
  return { value: JSON.parse(bytes.toString('utf8')) as T, bytes };
}

function readFixedProjectBytes(root: string, relative: string): Buffer {
  const full = path.resolve(root, relative), rootPath = path.resolve(root);
  if (!full.startsWith(rootPath + path.sep)) throw new Error('COMA_INPUT_PATH_INVALID');
  let current = rootPath;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('COMA_INPUT_SYMLINK_REJECTED');
    if (current !== full && !stat.isDirectory()) throw new Error('COMA_INPUT_PATH_INVALID');
  }
  if (!fs.statSync(full).isFile()) throw new Error('COMA_INPUT_PATH_INVALID');
  return fs.readFileSync(full);
}

function ensureRunDirectory(root: string, runId: string): string {
  if (!safeRunId(runId)) throw new TypeError('COMA_RUN_ID_INVALID');
  const base = path.resolve(root, '.concordia/coma-runs');
  const relative = `.concordia/coma-runs/${runId}`;
  const concordia = path.join(root, '.concordia');
  const concordiaStat = fs.lstatSync(concordia);
  if (!concordiaStat.isDirectory() || concordiaStat.isSymbolicLink()) throw new Error('COMA_RUN_ROOT_INVALID');
  if (fs.existsSync(base)) {
    const stat = fs.lstatSync(base);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('COMA_RUN_ROOT_INVALID');
  } else fs.mkdirSync(base);
  const directory = path.resolve(root, relative);
  if (!directory.startsWith(base + path.sep) || fs.existsSync(directory)) throw new Error('COMA_RUN_ALREADY_EXISTS');
  fs.mkdirSync(directory);
  return directory;
}

function validateFrozenInput(snapshot: any, cases: any, freeze: any, codeFreeze: any, raw: Record<string, Buffer>) {
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.universeId !== 'U1' || snapshot.database !== 'NY_TAXI' || !snapshot.tables ||
      !cases || cases.schemaVersion !== 1 || !Array.isArray(cases.cases) || !freeze || !codeFreeze?.policy) throw new Error('COMA_SNAPSHOT_INVALID');
  if (sha256(raw.snapshot) !== freeze.inputSha256 || sha256(raw.cases) !== freeze.caseUniverseSha256) throw new Error('COMA_FREEZE_HASH_MISMATCH');
  if (freeze.originalSourceSha256 !== snapshot.provenance?.sourceSha256 || Object.keys(snapshot.tables).length !== freeze.tables ||
      cases.cases.length !== freeze.caseCount || Object.values(snapshot.tables).reduce((n: number, table: any) => n + (table?.sample?.rows?.length ?? 0), 0) !== freeze.rows ||
      freeze.executionMode !== snapshot.executionMode || freeze.dataOrigin !== snapshot.dataOrigin) throw new Error('COMA_FROZEN_INPUT_MISMATCH');
  if (!['REPLAY', 'LOCAL'].includes(snapshot.executionMode) || !['UNKNOWN', 'SYNTHETIC'].includes(snapshot.dataOrigin) ||
      (snapshot.executionMode === 'REPLAY' && snapshot.dataOrigin !== 'UNKNOWN') || (snapshot.executionMode === 'LOCAL' && snapshot.dataOrigin !== 'SYNTHETIC')) throw new Error('COMA_PROVENANCE_INVALID');
  for (const [name, table] of Object.entries(snapshot.tables) as [string, any][]) {
    if (!Array.isArray(table.columns) || !Array.isArray(table.schema) || !Array.isArray(table.keyColumns) || !Array.isArray(table.labels) ||
      table.schema.length !== table.columns.length || table.schema.some((column: any) => !table.columns.includes(column.name)) ||
      table.sample.rows.some((row: unknown) => !Array.isArray(row) || row.length !== table.columns.length)) throw new Error(`COMA_TABLE_ALLOWLIST_INVALID:${name}`);
  }
  const policy = codeFreeze.policy as RelationPolicy;
  if (!/^\d+\.\d+$/.test(policy.policyVersion)) throw new Error('COMA_POLICY_FREEZE_INVALID');
}

function schemaInput(snapshot: any, cases: readonly any[]): ComaSchemaInput {
  const pairsByTable = new Map<string, ComaPair>();
  for (const item of cases) {
    const source = item.fromEndpoint?.table, target = item.toEndpoint?.table;
    const sourceTable = snapshot.tables[source], targetTable = snapshot.tables[target];
    if (!item.caseId || item.universeId !== snapshot.universeId || item.fromEndpoint?.db !== snapshot.database || item.toEndpoint?.db !== snapshot.database || !sourceTable || !targetTable ||
        !sourceTable.columns.includes(item.fromEndpoint.column) || !targetTable.columns.includes(item.toEndpoint.column)) throw new Error('COMA_CASE_ALLOWLIST_INVALID');
    const key = `${source}\0${target}`;
    let pair = pairsByTable.get(key);
    if (!pair) { pair = { source, target, allowed: [] }; pairsByTable.set(key, pair); }
    const allowed = pair.allowed as { sourceColumn: string; targetColumn: string; caseIds: string[] }[];
    let mapping = allowed.find(entry => entry.sourceColumn === item.fromEndpoint.column && entry.targetColumn === item.toEndpoint.column);
    if (!mapping) { mapping = { sourceColumn: item.fromEndpoint.column, targetColumn: item.toEndpoint.column, caseIds: [] }; allowed.push(mapping); }
    mapping.caseIds.push(item.caseId);
  }
  const tables = Object.fromEntries(Object.entries(snapshot.tables).map(([name, table]: [string, any]) => [name, {
    columns: [...table.columns], types: Object.fromEntries(table.schema.map((column: any) => [column.name, column.type]))
  }]));
  return { database: snapshot.database, normalizationMode: snapshot.normalizationContract.defaultMode, tables, pairs: [...pairsByTable.values()] };
}

function scopeHeuristicProvider(base: ReturnType<typeof createU1HeuristicProvider>, input: ComaSchemaInput) {
  const allowed = new Set(input.pairs.flatMap(pair => pair.allowed.map(mapping => `${pair.source}\0${mapping.sourceColumn}\0${pair.target}\0${mapping.targetColumn}`)));
  return { ...base, produce(context: Parameters<typeof base.produce>[0]) {
    const output = base.produce(context);
    if (output instanceof Promise) throw new Error('COMA_BASELINE_PROVIDER_NOT_SYNC');
    const contributions = output.contributions.filter((item: CandidateContribution) => {
      const contract = item.candidate.relationDraft;
      const fromTable = contract.from.objectId.slice(contract.from.objectId.lastIndexOf('.') + 1);
      const toTable = contract.to.objectId.slice(contract.to.objectId.lastIndexOf('.') + 1);
      return allowed.has(`${fromTable}\0${contract.from.orderedColumns[0]}\0${toTable}\0${contract.to.orderedColumns[0]}`);
    });
    return { ...output, contributions, abstentions: contributions.length ? [] : [{ reason: 'BASELINE_NO_MATCHES_FOR_CONFIGURED_SCOPE' }] };
  } };
}

export interface ComaCaseResult { caseId: string; taskId: string; status: 'EVALUATED' | 'NOT_PROPOSED'; candidateId?: string; candidateIdentity?: string; decision?: Decision; reasonCodes: string[]; }
export interface ComaRunResult { schemaVersion: 1; runId: string; status: string; inputHashes: Record<string, string>; implementationHashes: Record<string, string>; effectiveComaConfiguration: typeof COMA_EFFECTIVE_CONFIGURATION; policy: RelationPolicy; provider: unknown; production: CandidateProductionEnvelope; outOfScopeProposals?: CandidateProductionEnvelope['outOfScopeProposals']; candidates: Candidate[]; contributions: CandidateContribution[]; cases: ComaCaseResult[]; summary: Record<string, number>; limitations: string[]; }

export async function runComaDiscovery(options: { projectRoot: string; runId: string; pythonExecutable: string }): Promise<ComaRunResult> {
  const root = path.resolve(options.projectRoot);
  const files = Object.fromEntries(Object.entries(INPUTS).map(([key, relative]) => [key, readFixedProjectJson<any>(root, relative)])) as Record<keyof typeof INPUTS, { value: any; bytes: Buffer }>;
  const implementationBytes = {
    bridge: readFixedProjectBytes(root, 'scripts/coma/bridge.py'),
    provider: readFixedProjectBytes(root, 'src/discovery/coma-provider.ts'),
    runner: readFixedProjectBytes(root, 'src/eval/coma-run.ts')
  };
  const snapshot = files.snapshot.value, cases = files.cases.value, freeze = files.freeze.value, codeFreeze = files.codeFreeze.value;
  validateFrozenInput(snapshot, cases, freeze, codeFreeze, { snapshot: files.snapshot.bytes, cases: files.cases.bytes });
  const input = schemaInput(snapshot, cases.cases);
  if (!input.pairs.length) throw new Error('COMA_CONFIGURED_PAIR_SCOPE_EMPTY');
  const runDirectory = ensureRunDirectory(root, options.runId);
  const productionInput = {
    universeId: snapshot.universeId, sourceId: `zetaris:${snapshot.database}`, sourceVersion: { state: 'UNKNOWN' as const },
    configFingerprint: freeze.configSha256, inputHash: freeze.inputSha256,
    scope: { tables: Object.keys(snapshot.tables), columns: [...new Set(Object.values(snapshot.tables).flatMap((table: any) => table.columns))] },
    executionMode: snapshot.executionMode, dataOrigin: snapshot.dataOrigin,
    tableMetadata: Object.fromEntries(Object.entries(snapshot.tables).map(([name, table]: [string, any]) => [name, { columns: table.schema, keyColumns: table.keyColumns, role: table.role }])),
    evidenceRefs: [...new Set(Object.values(snapshot.tables).map((table: any) => table.sample.requestId).filter((value: unknown): value is string => typeof value === 'string'))],
    metadata: { liveTables: snapshot.tables, normalizationContract: snapshot.normalizationContract, database: snapshot.database }
  };
  const coma = createComaProvider({ input, bridge: createInstalledComaBridge(options.pythonExecutable, root) });
  const envelope = await produceCandidates(productionInput, [scopeHeuristicProvider(createU1HeuristicProvider(), input), coma]);
  const contributionByCase = new Map<string, { candidate: Candidate; identity: string }[]>();
  for (const item of envelope.contributions) {
    const contract = item.candidate.relationDraft;
    const endpoint = (contract: Candidate['relationDraft'], side: 'from' | 'to') => {
      const value = contract[side];
      const table = value.objectId.slice(value.objectId.lastIndexOf('.') + 1);
      return { db: snapshot.database, table, column: value.orderedColumns[0] };
    };
    const from = endpoint(contract, 'from'), to = endpoint(contract, 'to');
    for (const itemCase of cases.cases.filter((testCase: any) => endpointKey(testCase.fromEndpoint) === endpointKey(from) && endpointKey(testCase.toEndpoint) === endpointKey(to))) {
      const list = contributionByCase.get(itemCase.caseId) ?? [];
      list.push({ candidate: item.candidate, identity: item.candidate.candidateId }); contributionByCase.set(itemCase.caseId, list);
    }
  }
  const policy: RelationPolicy = structuredClone(codeFreeze.policy);
  const caseResults: ComaCaseResult[] = [];
  for (const itemCase of [...cases.cases].sort((a: any, b: any) => a.caseId.localeCompare(b.caseId, 'en'))) {
    const proposals = contributionByCase.get(itemCase.caseId) ?? [];
    if (!proposals.length) { caseResults.push({ caseId: itemCase.caseId, taskId: itemCase.taskId, status: 'NOT_PROPOSED', reasonCodes: ['no_provider_proposed_configured_endpoint_pair'] }); continue; }
    for (const proposal of proposals) {
      const decision = evaluateRelation(proposal.candidate.relationDraft, [], policy);
      caseResults.push({ caseId: itemCase.caseId, taskId: itemCase.taskId, status: 'EVALUATED', candidateId: proposal.candidate.candidateId,
        candidateIdentity: proposal.identity, decision, reasonCodes: decision.reasonCodes });
    }
  }
  const summary = {
    caseCount: cases.cases.length, proposedCases: new Set(caseResults.filter(item => item.status === 'EVALUATED').map(item => item.caseId)).size,
    candidateCount: envelope.candidates.length, evaluated: caseResults.filter(item => item.status === 'EVALUATED').length,
    notProposed: caseResults.filter(item => item.status === 'NOT_PROPOSED').length,
    indeterminate: caseResults.filter(item => item.decision?.verdict === 'INDETERMINADA').length,
    supported: caseResults.filter(item => item.decision?.verdict === 'SOSTENIDA').length,
    misleading: caseResults.filter(item => item.decision?.verdict === 'ENGAÑOSA').length
  };
  const comaState = envelope.providerStates.find(item => item.providerId === 'valentine.coma')?.status;
  const runStatus = comaState === 'ERROR' || comaState === 'PARTIAL' ? (envelope.candidates.length ? 'PARTIAL' : 'ERROR') : envelope.candidates.length ? 'COMPLETE' : 'ABSTAINED';
  const result: ComaRunResult = { schemaVersion: 1, runId: options.runId, status: runStatus, inputHashes: {
    snapshotSha256: sha256(files.snapshot.bytes), caseUniverseSha256: sha256(files.cases.bytes), configSha256: freeze.configSha256, policyHash: codeFreeze.policyHash
  }, implementationHashes: { bridgeSha256: sha256(implementationBytes.bridge), providerSha256: sha256(implementationBytes.provider), runnerSha256: sha256(implementationBytes.runner) },
  effectiveComaConfiguration: COMA_EFFECTIVE_CONFIGURATION, policy, provider: envelope.providers.find(item => item.providerId === 'valentine.coma'), production: envelope, candidates: envelope.candidates,
  outOfScopeProposals: envelope.outOfScopeProposals ?? [],
  contributions: envelope.contributions, cases: caseResults, summary,
  limitations: [...envelope.limitations, 'source values, labels and sample rows were excluded from COMA input',
    'COMA matches are candidate proposals only; every evaluated proposal has no semantic evidence and remains indeterminate'] };
  const report = { ...result, runDirectory: path.relative(root, runDirectory).replaceAll('\\', '/') };
  fs.writeFileSync(path.join(runDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return result;
}
