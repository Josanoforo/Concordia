import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { legacyRelationContract } from '../relations/legacy.ts';
import type { Candidate as SharedCandidate, RelationContract } from '../contracts/types.ts';
import type { CandidateContribution, CandidateProvider, CandidateProviderContext, OutOfScopeProposal } from './candidates.ts';
import { withUniverseContext } from './candidates.ts';

export interface ComaPair { source: string; target: string; sourceDb?: string; targetDb?: string; normalizationMode?: string; allowed: readonly { sourceColumn: string; targetColumn: string; caseIds: readonly string[] }[]; }
export interface ComaSchemaInput { database?: string; tableDatabases?: Readonly<Record<string, string>>; normalizationMode: string; tables: Record<string, { columns: readonly string[]; types: Readonly<Record<string, string>> }>; pairs: readonly ComaPair[]; }
export interface ComaRawMatch { sourceColumn: string; targetColumn: string; rawScore: number; }
export const COMA_EFFECTIVE_CONFIGURATION = { max_n: 0, use_instances: false, use_schema: true, delta: 0.15, threshold: 0.0, instance_weight: 1.0 } as const;
export interface ComaBridgeOutput { schemaVersion: 1; provider: 'valentine.Coma' | typeof COMA_STANDIN_PROVIDER; version: string; configuration?: typeof COMA_EFFECTIVE_CONFIGURATION; matches: { source: string; target: string; matches: ComaRawMatch[] }[]; }
/** Identity of the offline stand-in (src/eval/fixture-coma.ts): it is never COMA, and reports must tell the two apart. */
export const COMA_STANDIN_PROVIDER = 'fixture.coma-standin';
export type ComaBridge = (input: ComaSchemaInput, timeoutMs?: number) => ComaBridgeOutput;

const BRIDGE_RELATIVE = 'scripts/coma/bridge.py';
const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))) : item);

function validateOutput(value: unknown, requireConfiguration = false, standIn = false): ComaBridgeOutput {
  if (!value || typeof value !== 'object') throw new Error('COMA_BRIDGE_JSON_INVALID');
  const output = value as Partial<ComaBridgeOutput> & { error?: unknown };
  if (output.error) throw new Error(`COMA_BRIDGE_${String(output.error)}`);
  if (output.schemaVersion !== 1 || !Array.isArray(output.matches) || (standIn ? output.provider !== COMA_STANDIN_PROVIDER || typeof output.version !== 'string' || !output.version : output.provider !== 'valentine.Coma' || output.version !== '1.1.0')) throw new Error('COMA_BRIDGE_CONTRACT_INVALID');
  if ((requireConfiguration && !output.configuration) || (output.configuration && Object.entries(COMA_EFFECTIVE_CONFIGURATION).some(([key, expected]) => output.configuration?.[key as keyof typeof COMA_EFFECTIVE_CONFIGURATION] !== expected))) throw new Error('COMA_BRIDGE_CONFIGURATION_MISMATCH');
  for (const pair of output.matches) {
    if (!pair || typeof pair.source !== 'string' || typeof pair.target !== 'string' || !Array.isArray(pair.matches)) throw new Error('COMA_BRIDGE_PAIR_INVALID');
    for (const match of pair.matches) if (!match || typeof match.sourceColumn !== 'string' || typeof match.targetColumn !== 'string' || typeof match.rawScore !== 'number' || !Number.isFinite(match.rawScore)) throw new Error('COMA_BRIDGE_MATCH_INVALID');
  }
  return output as ComaBridgeOutput;
}

export function runComaBridge(input: ComaSchemaInput, pythonExecutable: string, projectRoot: string, timeoutMs = 60_000): ComaBridgeOutput {
  if (!path.isAbsolute(pythonExecutable) || !path.isAbsolute(projectRoot)) throw new TypeError('COMA_EXECUTABLE_PATH_INVALID');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new TypeError('COMA_TIMEOUT_INVALID');
  const expectedPython = path.resolve(projectRoot, '.concordia/python/coma-valentine-1.1.0/Scripts/python.exe');
  if (path.resolve(pythonExecutable) !== expectedPython) throw new TypeError('COMA_EXECUTABLE_PATH_INVALID');
  const bridge = path.resolve(projectRoot, BRIDGE_RELATIVE);
  if (!bridge.startsWith(path.resolve(projectRoot) + path.sep)) throw new TypeError('COMA_BRIDGE_PATH_INVALID');
  for (const target of [expectedPython, bridge]) {
    let current = path.parse(target).root;
    for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('COMA_PATH_SYMLINK_REJECTED');
    }
  }
  const payload = JSON.stringify({ schemaVersion: 1, tables: Object.entries(input.tables).map(([name, table]) => ({ name,
    columns: table.columns.map(column => ({ name: column, type: table.types[column] ?? 'unknown' })) })), pairs: input.pairs.map(pair => ({ source: pair.source, target: pair.target })) });
  if (Buffer.byteLength(payload) > 2_000_000) throw new Error('COMA_INPUT_TOO_LARGE');
  const temp = ensureLocalTemp(projectRoot);
  const result = spawnSync(pythonExecutable, [bridge], { cwd: projectRoot, input: payload, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_STDOUT,
    windowsHide: true, shell: false, env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: temp, TMP: temp, TMPDIR: temp,
      PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' } });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new Error(code === 'ETIMEDOUT' || result.error.name === 'TimeoutError' ? 'COMA_TIMEOUT' : code === 'ENOBUFS' ? 'COMA_OUTPUT_TOO_LARGE' : 'COMA_PROCESS_FAILED');
  }
  if (result.status !== 0) throw new Error('COMA_PROCESS_FAILED');
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('COMA_BRIDGE_JSON_INVALID'); }
  return validateOutput(parsed, true);
}

function ensureLocalTemp(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  let current = root;
  for (const part of ['.concordia', 'tmp', 'coma']) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('COMA_TEMP_PATH_INVALID');
    } else {
      fs.mkdirSync(current);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('COMA_TEMP_PATH_INVALID');
    }
  }
  return current;
}

function makeContribution(context: CandidateProviderContext, input: ComaSchemaInput, pair: ComaPair, match: ComaRawMatch, configHash: string, identity = { id: 'valentine.Coma', version: '1.1.0' }): CandidateContribution {
  const fromDb = pair.sourceDb ?? input.tableDatabases?.[pair.source] ?? input.database;
  const toDb = pair.targetDb ?? input.tableDatabases?.[pair.target] ?? input.database;
  if (!fromDb || !toDb) throw new Error('COMA_TABLE_DATABASE_REQUIRED');
  const from = { db: fromDb, table: pair.source, column: match.sourceColumn };
  const to = { db: toDb, table: pair.target, column: match.targetColumn };
  const relationId = `${from.table}.${from.column}__${to.table}.${to.column}`;
  const mode = pair.normalizationMode ?? input.normalizationMode;
  const relationDraft: RelationContract = withUniverseContext(legacyRelationContract({ id: relationId, from, to, kind: 'UNKNOWN', reviewState: 'UNKNOWN' },
    context.descriptor.universeId, '1.0', mode as 'text' | 'integer' | 'integer-pad10', 1),
  { id: context.descriptor.universeId, configFingerprint: context.descriptor.configFingerprint });
  const version = context.descriptor.sourceVersion.state === 'KNOWN' ? context.descriptor.sourceVersion.value : 'UNKNOWN';
  relationDraft.from.sourceId = `${context.descriptor.sourceId}:${from.table}@${version}:from`;
  relationDraft.to.sourceId = `${context.descriptor.sourceId}:${to.table}@${version}:to`;
  const fromType = input.tables[from.table]?.types[from.column], toType = input.tables[to.table]?.types[to.column];
  relationDraft.semanticContext.properties = { fromDeclaredType: fromType ? { state: 'KNOWN', value: fromType } : { state: 'UNKNOWN' }, toDeclaredType: toType ? { state: 'KNOWN', value: toType } : { state: 'UNKNOWN' } };
  const candidate: SharedCandidate = { schemaVersion: 1, candidateId: relationId, relationDraft, proposedBy: 'candidate-provider', provenance: [], createdAt: { state: 'UNKNOWN' }, status: 'UNKNOWN' };
  const allowlisted = pair.allowed.find(item => item.sourceColumn === match.sourceColumn && item.targetColumn === match.targetColumn);
  return { candidate, methodId: 'valentine-coma-1.1.0', reasons: ['Valentine COMA schema match; proposal only, semantics unknown'],
    evidenceRefs: [...context.evidenceRefs], diagnostics: [{ provider: identity.id, version: identity.version, method: 'COMA', rawScore: match.rawScore, matcherExecutionMode: 'LOCAL',
      configHash, inputHash: context.descriptor.inputHash, caseIds: allowlisted?.caseIds ?? [], source: pair.source, target: pair.target,
      orderedColumns: [match.sourceColumn, match.targetColumn], scope: allowlisted ? 'ALLOWLISTED' : 'OUT_OF_SCOPE' }] };
}

/** Blind discovery asks about table pairs with nothing in scope, so every match is an out-of-scope proposal by design and not a problem. */
const isBlindInput = (input: ComaSchemaInput) => input.pairs.length > 0 && input.pairs.every(pair => pair.allowed.length === 0);

export function createComaProvider(options: { input: ComaSchemaInput; bridge: ComaBridge; blind?: boolean }): CandidateProvider {
  const standIn = (options.bridge as { standInId?: string }).standInId === COMA_STANDIN_PROVIDER;
  const providerId = standIn ? COMA_STANDIN_PROVIDER : 'valentine.coma';
  return {
    descriptor: { providerId, version: '1.1.0', method: 'schema-match', capability: 'SUPPORTED' },
    produce(context) {
      const configHash = hash(canonical({ database: options.input.database, tableDatabases: options.input.tableDatabases, normalizationMode: options.input.normalizationMode,
        tables: options.input.tables, pairs: options.input.pairs.map(pair => ({ source: pair.source, target: pair.target, normalizationMode: pair.normalizationMode, allowed: pair.allowed })), configuration: COMA_EFFECTIVE_CONFIGURATION }));
      if (!['text', 'integer', 'integer-pad10'].includes(options.input.normalizationMode)) return { contributions: [], abstentions: [], errors: [{ code: 'COMA_NORMALIZATION_MODE_INVALID', partial: false }], partial: false, limitations: [] };
      let output: ComaBridgeOutput;
      try { output = validateOutput(options.bridge(options.input), false, standIn); }
      catch (error) { return { contributions: [], abstentions: [], errors: [{ code: error instanceof Error ? error.message : 'COMA_PROVIDER_FAILED', partial: false }], partial: false, limitations: ['COMA did not produce a candidate result; no contradiction inferred'] }; }
      const tables = options.input.tables;
      const configuredPairs = new Map(options.input.pairs.map(pair => [`${pair.source}\0${pair.target}`, pair]));
      const blind = options.blind ?? isBlindInput(options.input);
      const contributions: CandidateContribution[] = [], outOfScopeProposals: OutOfScopeProposal[] = [], issues: string[] = [];
      const expectedOutOfScope = (code: string) => { if (!blind) issues.push(code); };
      for (const result of output.matches) {
        const pair = configuredPairs.get(`${result.source}\0${result.target}`);
        if (!pair) {
          expectedOutOfScope('COMA_PAIR_OUT_OF_SCOPE');
          const fromDb = options.input.tableDatabases?.[result.source] ?? options.input.database;
          const toDb = options.input.tableDatabases?.[result.target] ?? options.input.database;
          for (const match of result.matches) {
            if (typeof match.rawScore !== 'number' || !Number.isFinite(match.rawScore)) { issues.push('COMA_SCORE_INVALID'); continue; }
            if (!tables[result.source]?.columns.includes(match.sourceColumn) || !tables[result.target]?.columns.includes(match.targetColumn)) { issues.push('COMA_COLUMN_OUT_OF_ALLOWLIST'); continue; }
            if (!fromDb || !toDb) { issues.push('COMA_TABLE_DATABASE_REQUIRED'); continue; }
            outOfScopeProposals.push({ providerId, providerVersion: output.version, method: 'COMA',
              from: { db: fromDb, table: result.source, column: match.sourceColumn }, to: { db: toDb, table: result.target, column: match.targetColumn },
              rawScore: match.rawScore, reason: 'COMA_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING',
              inputHash: context.descriptor.inputHash, configHash, evidenceRefs: [...context.evidenceRefs] });
          }
          continue;
        }
        for (const match of result.matches) {
          if (typeof match.rawScore !== 'number' || !Number.isFinite(match.rawScore)) { issues.push('COMA_SCORE_INVALID'); continue; }
          if (!tables[pair.source]?.columns.includes(match.sourceColumn) || !tables[pair.target]?.columns.includes(match.targetColumn)) { issues.push('COMA_COLUMN_OUT_OF_ALLOWLIST'); continue; }
          const allowlisted = pair.allowed.some(item => item.sourceColumn === match.sourceColumn && item.targetColumn === match.targetColumn);
          if (!allowlisted) {
            expectedOutOfScope('COMA_COLUMN_PAIR_OUT_OF_SCOPE');
            const fromDb = pair.sourceDb ?? options.input.tableDatabases?.[pair.source] ?? options.input.database;
            const toDb = pair.targetDb ?? options.input.tableDatabases?.[pair.target] ?? options.input.database;
            if (!fromDb || !toDb) { issues.push('COMA_TABLE_DATABASE_REQUIRED'); continue; }
            outOfScopeProposals.push({ providerId, providerVersion: output.version, method: 'COMA',
              from: { db: fromDb, table: pair.source, column: match.sourceColumn }, to: { db: toDb, table: pair.target, column: match.targetColumn },
              rawScore: match.rawScore, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING',
              inputHash: context.descriptor.inputHash, configHash, evidenceRefs: [...context.evidenceRefs] });
            continue;
          }
          contributions.push(makeContribution(context, options.input, pair, match, configHash, { id: standIn ? COMA_STANDIN_PROVIDER : 'valentine.Coma', version: output.version }));
        }
      }
      // One proposal per endpoint pair (database included): the higher rawScore, then the lexicographic id.
      const endpoint = (e: OutOfScopeProposal['from']) => `${e.db}.${e.table}.${e.column}`, byPair = new Map<string, OutOfScopeProposal>();
      for (const proposal of outOfScopeProposals) {
        const key = `${endpoint(proposal.from)}__${endpoint(proposal.to)}`, kept = byPair.get(key);
        if (!kept || proposal.rawScore > kept.rawScore || (proposal.rawScore === kept.rawScore && proposal.reason.localeCompare(kept.reason, 'en') < 0)) byPair.set(key, proposal);
      }
      outOfScopeProposals.splice(0, outOfScopeProposals.length, ...byPair.values());
      const partial = issues.length > 0;
      return { contributions, ...(outOfScopeProposals.length ? { outOfScopeProposals } : {}), abstentions: contributions.length ? [] : [{ reason: 'COMA_NO_MATCHES_FOR_CONFIGURED_SCOPE' }],
        errors: issues.map(code => ({ code, partial })), partial,
        limitations: ['raw COMA scores are diagnostics only and never alter relation kind, review state or decision',
          'COMA received schema names and empty tables only; row values and embeddings were not used'] };
    }
  };
}

export function createInstalledComaBridge(pythonExecutable: string, projectRoot: string): ComaBridge {
  return input => runComaBridge(input, pythonExecutable, projectRoot);
}
