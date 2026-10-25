import fs from 'node:fs';
import path from 'node:path';
import { Zetaris } from './clients/zetaris.ts';
import { loadLocalEnv, SafeError, ROOT, readJson } from './runtime.ts';
import { loadSvp1Profiles, loadSvp1ProfileRows, evaluateSvp1Snapshot, synthesizeCandidateContract, type Svp1Profile } from './svp1.ts';
import type { ProbeAdapter } from './relations/probes.ts';
import { recordFreshnessPreflightFailure, sourceSchemaFingerprintFromHash } from './reconcile/freshness-history.ts';
import { relationPolicyFromConfig } from './relations/policy.ts';
import type { UniverseManifest } from './registry/universes.ts';
import {
  canonicalJson2TypedMultisetSha256,
  validateJson2LiveBinding,
  ZetarisJson2ProbeAdapter,
  type Json2LiveBindingDocument,
  type Json2LiveTableBinding
} from './relations/adapters/zetaris-json2.ts';

const safeUniversePath = (value: unknown): value is string => typeof value === 'string' && /^universes\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(value);
const hashPattern = /^[a-f0-9]{64}$/;

function readApprovedJson(relative: string): unknown {
  if (!safeUniversePath(relative)) throw new SafeError('JSON2_BINDING_PATH_INVALID');
  const parts = relative.split('/');
  let current = ROOT;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) || (index === parts.length - 1 && !stat.isFile())) throw new SafeError('JSON2_BINDING_PATH_UNSAFE');
  }
  const base = fs.realpathSync(path.join(ROOT, 'universes'));
  const file = fs.realpathSync(current);
  const rel = path.relative(base, file);
  if (!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new SafeError('JSON2_BINDING_PATH_UNSAFE');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function validateSvp1LiveManifest(manifest: UniverseManifest, bindingInput: unknown, profiles: readonly Svp1Profile[] = loadSvp1Profiles()): { path: string; code: string }[] {
  const issues: { path: string; code: string }[] = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !manifest.source || typeof manifest.source !== 'object' || manifest.source.adapterId !== 'zetaris-json2-live') return [{ path: 'manifest.source.adapterId', code: 'JSON2_LIVE_ADAPTER_REQUIRED' }];
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const aliases = Array.isArray(manifest.aliases) ? manifest.aliases : [];
  const relationIds = Array.isArray(manifest.relationIds) ? manifest.relationIds : [];
  if (!Array.isArray(manifest.capabilities) || !capabilities.includes('LIVE_RELATION_PROBE') || !capabilities.includes('BOUNDED_RELATION_PROBE') || !capabilities.includes('RELATION_EVALUATION')) issues.push({ path: 'manifest.capabilities', code: 'JSON2_LIVE_CAPABILITIES_REQUIRED' });
  if (!Array.isArray(manifest.aliases)) issues.push({ path: 'manifest.aliases', code: 'INVALID_ALIASES' });
  if (!Array.isArray(manifest.relationIds)) issues.push({ path: 'manifest.relationIds', code: 'INVALID_RELATION_IDS' });

  if (!safeUniversePath(manifest.source.configPath)) issues.push({ path: 'manifest.source.configPath', code: 'JSON2_BINDING_PATH_INVALID' });
  const profileId = manifest.source.profileManifestId;
  const profile = profiles.find(item => item.manifestId === profileId);
  if (!profile) return [...issues, { path: 'manifest.source.profileManifestId', code: 'SVP1_PROFILE_NOT_FOUND' }];
  if (manifest.source.dataOrigin !== profile.dataOrigin) issues.push({ path: 'manifest.source.dataOrigin', code: 'PROFILE_ORIGIN_MISMATCH' });
  if (manifest.manifestId !== profile.manifestId + '-live' || aliases.length !== 1 || aliases[0] !== profile.alias + '_LIVE') issues.push({ path: 'manifest', code: 'UNSTABLE_LIVE_PROFILE_IDENTITY' });
  const expectedRelations = [...profile.relations.map(item => profile.alias + '_LIVE_' + item.id)].sort();
  if (JSON.stringify([...relationIds].sort()) !== JSON.stringify(expectedRelations)) issues.push({ path: 'manifest.relationIds', code: 'PROFILE_RELATION_IDS_MISMATCH' });
  const liveBounds = manifest.capabilityBounds?.LIVE_RELATION_PROBE;
  const boundedBounds = manifest.capabilityBounds?.BOUNDED_RELATION_PROBE;
  const expectedRelationsPerRun = profile.candidates.length;
  for (const [name, bounds] of [['LIVE_RELATION_PROBE', liveBounds], ['BOUNDED_RELATION_PROBE', boundedBounds]] as const) {
    if (!bounds || bounds.probeLimit !== 50 || bounds.maxKeyColumns !== profile.bounds.maxKeyColumns || bounds.maxRelationsPerRun < expectedRelationsPerRun || bounds.maxRelationsPerRun > 20) issues.push({ path: 'manifest.capabilityBounds.' + name, code: 'PROFILE_BOUND_MISMATCH' });
  }
  if (!bindingInput || typeof bindingInput !== 'object' || Array.isArray(bindingInput)) return [...issues, { path: 'binding', code: 'EXPECTED_BINDING_OBJECT' }];
  const binding = bindingInput as Json2LiveBindingDocument;
  if (typeof binding.profileConfigPath !== 'string' || binding.profileConfigPath !== 'universes/svp1-snapshots.json') issues.push({ path: 'binding.profileConfigPath', code: 'PROFILE_CONFIG_PATH_MISMATCH' });
  if (typeof binding.backendEngineVersion !== 'string' || !binding.backendEngineVersion.trim()) issues.push({ path: 'binding.backendEngineVersion', code: 'BACKEND_ENGINE_VERSION_REQUIRED' });
  const profileTables = Array.isArray(binding.tables) ? binding.tables.filter(table => table && typeof table === 'object' && table.manifestId === profile.manifestId) : [];
  if (profileTables.length !== profile.tables.length) issues.push({ path: 'binding.tables', code: 'PROFILE_TABLE_BINDING_COUNT_MISMATCH' });
  for (const snapshot of profile.tables) {
    const matches = profileTables.filter(table => table.sourceId === snapshot.sourceId);
    if (matches.length !== 1) { issues.push({ path: 'binding.tables', code: 'PROFILE_TABLE_BINDING_MISSING_OR_DUPLICATE' }); continue; }
    const table = matches[0];
    const oneProfileBinding = { ...binding, tables: [table] };
    const expected = {
      manifestId: profile.manifestId, profileAlias: profile.alias, sourceId: snapshot.sourceId,
      logicalObjectId: snapshot.objectId, tableId: snapshot.tableId,
      columns: snapshot.columns.map((name, index) => ({ name, kind: snapshot.types[index] as 'string' | 'integer' })),
      expectedRows: snapshot.rowCount, rowLimit: snapshot.rowLimit, dataOrigin: snapshot.dataOrigin
    };
    issues.push(...validateJson2LiveBinding(oneProfileBinding, expected).map(issue => ({ path: issue.path.replace('binding', 'binding.tables.' + snapshot.tableId), code: issue.code })));
  }
  const sourceHashFields = [binding.registrationPlanFingerprint, binding.packageSealSha256, binding.registrationJournalSha256, binding.wireEvidenceSha256];
  if (sourceHashFields.some(value => !hashPattern.test(value))) issues.push({ path: 'binding', code: 'BINDING_RECEIPT_INVALID' });
  return issues;
}

export async function evaluateSvp1Live(manifest: UniverseManifest, options: {
  runId?: string; policyVersion?: string; now?: () => string; binding?: Json2LiveBindingDocument; adapter?: ProbeAdapter; persistFreshness?:boolean; relationIds?:readonly string[];
} = {}) {
  if (!manifest || manifest.source?.adapterId !== 'zetaris-json2-live') throw new SafeError('JSON2_LIVE_ADAPTER_REQUIRED');
  const binding = options.binding ?? readApprovedJson(manifest.source.configPath ?? '') as Json2LiveBindingDocument;
  const profiles = loadSvp1Profiles(binding.profileConfigPath);
  const issues = validateSvp1LiveManifest(manifest, binding, profiles);
  if (issues.length) throw new SafeError('JSON2_LIVE_MANIFEST_INVALID', undefined, JSON.stringify(issues));
  const profile = profiles.find(item => item.manifestId === manifest.source.profileManifestId)!;
  const profileRows = loadSvp1ProfileRows(profile);
  const profileBindings = binding.tables.filter(table => table.manifestId === profile.manifestId);
  const pinnedSnapshotValidation = profile.tables.map(snapshot => {
    const bound = profileBindings.find(table => table.sourceId === snapshot.sourceId);
    const rows = profileRows.get(snapshot.sourceId + ':' + snapshot.objectId);
    if (!bound || !rows || canonicalJson2TypedMultisetSha256(rows, snapshot.columns.map((name, index) => ({ name, kind: snapshot.types[index] as 'string' | 'integer' }))) !== bound.typedMultisetSha256) throw new SafeError('JSON2_BINDING_PINNED_SNAPSHOT_MISMATCH');
    return { tableId: snapshot.tableId, status: 'VERIFIED' as const, rowCount: rows.length, snapshotSha256: snapshot.sha256, typedMultisetSha256: bound.typedMultisetSha256 };
  });
  const activeBinding = { ...binding, tables: profileBindings };

  const adapter = options.adapter ?? (() => { loadLocalEnv(); return new ZetarisJson2ProbeAdapter(activeBinding, new Zetaris()); })();
  const liveAdapter = adapter as ProbeAdapter & { verifyAllTables?: () => Promise<unknown>; getRunSummary?: () => unknown };
  const verify = liveAdapter.verifyAllTables;
  const preflightResult = verify ? await verify.call(adapter) : undefined;
  const sourceValidation = verify ? (liveAdapter.getRunSummary?.call(adapter) ?? preflightResult ?? { status: 'UNAVAILABLE', tables: [] }) : { status: 'UNAVAILABLE', tables: [] };
  const sourceStatus = sourceValidation && typeof sourceValidation === 'object' && 'status' in sourceValidation ? (sourceValidation as { status: string }).status : 'UNKNOWN';
  const pinnedValidation = { status: 'VERIFIED', sourceCommit: profile.sourceCommit, tables: pinnedSnapshotValidation };
  const contractDeclarations = profile.candidates.map(candidate => synthesizeCandidateContract(candidate, profile)).filter((contract): contract is NonNullable<typeof contract> => contract !== undefined);
  const sourceSchemaFingerprints=Array.isArray((sourceValidation as any)?.tables)?(sourceValidation as any).tables.filter((table:any)=>typeof table.sourceId==='string'&&typeof table.logicalObjectId==='string').map((table:any)=>sourceSchemaFingerprintFromHash(table.sourceId,table.logicalObjectId,table.observedSchemaSha256,'JSON2_SOURCE_PREFLIGHT',table.describeRequestedAt)):[];
  if (sourceStatus !== 'COMPLETE') {
    if(options.persistFreshness){
      const selected=profile.candidates.filter(candidate=>!candidate.inputVariant).filter(candidate=>!options.relationIds||options.relationIds.includes(candidate.candidateId)||options.relationIds.includes(candidate.relationContractRef??''));
      const policy=relationPolicyFromConfig(readJson('config/thresholds.json'));
      for(const candidate of selected){
        const contract=candidate.relationContractRef?profile.relations.find(item=>item.id===candidate.relationContractRef):synthesizeCandidateContract(candidate,profile);
        if(contract)recordFreshnessPreflightFailure({universeId:manifest.manifestId,relationId:contract.id,contract,policy,sourceValidation,executionMode:'LIVE',dataOrigin:manifest.source.dataOrigin,checkedAt:options.now?.()??new Date().toISOString()});
      }
    }
    return {
      schemaVersion: 1, runId: options.runId ?? ('svp1-live-preflight:' + profile.manifestId + ':' + profile.version),
      manifestId: manifest.manifestId, version: manifest.version, alias: manifest.aliases[0], executionMode: 'LIVE',
      dataOrigin: manifest.source.dataOrigin, sourceCommit: profile.sourceCommit, sourcePackage: profile.sourcePackage,
      candidateCount: 0, decisions: [], predictions: [], causalControls: [],
      status: sourceStatus === 'ERROR' ? 'ERROR' : 'PARTIAL', sourceValidation, contractDeclarations,
      pinnedSnapshotValidation: pinnedValidation, sourceBindingId: binding.bindingId, sourceBindingVersion: binding.bindingVersion,
      evaluationMeaning: 'Live preflight incomplete; relation evaluation was not run.'
    };
  }
  const result = await evaluateSvp1Snapshot(profile.alias, {
    runId: options.runId, policyVersion: options.policyVersion, now: options.now, adapter, executionMode: 'LIVE',
    routeManifest: manifest, profileManifestId: profile.manifestId, profileConfigPath: binding.profileConfigPath,
    bindingId: binding.bindingId, scope: 'Root-reviewed JSON2 read-only bounded source projection',persistFreshness:options.persistFreshness,relationIds:options.relationIds,sourceSchemaFingerprints
  });
  return { ...result, status: 'EVALUATED', sourceValidation, pinnedSnapshotValidation: pinnedValidation, sourceBindingId: binding.bindingId, sourceBindingVersion: binding.bindingVersion };
}
