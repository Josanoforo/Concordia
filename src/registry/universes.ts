import { readJson } from '../runtime.ts';
import { validateExplorationCatalog } from '../agent/catalog.ts';
import { isReviewMode } from './review-mode.ts';
import { RUN_BUDGET_CEILINGS } from '../agent/run-budget.ts';
import { validateKeyContractDeclaration } from '../relations/key-contract.ts';

export type UniverseCapability = 'DISCOVERY' | 'BOUNDED_RELATION_PROBE' | 'LIVE_RELATION_PROBE' | 'RELATION_EVALUATION' | 'USL' | 'SCHEMA_MATCHING' | 'LOCAL_EVALUATION' | 'METADATA_ONLY' | 'AGENT_EXPLORATION';
export type CapabilityBounds = Record<string, number>;
export interface UniverseManifest {
  schemaVersion: 1;
  manifestId: string;
  version: string;
  aliases: readonly string[];
  source: { sourceId: string; adapterId: 'zetaris' | 'zetaris-json2-live' | 'local-files' | 'local-snapshot' | 'madi-schema' | 'manifest-only'; configPath?: string; profileManifestId?: string; dataOrigin: 'UNKNOWN' | 'PUBLIC' | 'USER' | 'SYNTHETIC' };
  capabilities: readonly UniverseCapability[];
  relationIds: readonly string[];
  capabilityBounds?: Partial<Record<UniverseCapability, CapabilityBounds>>;
  /** R-config: required review (HUMAN default) for the universe and, optionally, per relation id. Declared config; see review-mode.ts. */
  /** P3: whole-table evidence (global profile, duplicates, anti-join) for the contract probes; the engine reads manifest.fullEvidence === true. Off unless declared. */
  fullEvidence?: boolean;
  /** E2-03: global consistency pass between the model review and the contract probes (the engine reads manifest.consistency.enabled === true). Off unless declared. `aliases`: a source column (`table.column`) that may reference several targets (`table.column` or `table`). */
  consistency?: { enabled: boolean; aliases?: { source: string; targets: string[] }[] };
  /** F1x: extended whole-table profile (MIN, MAX, AVG length) with the full evidence. A separate declaration; `fullEvidence` keeps its meaning. Off unless declared. */
  fullEvidenceExtendedProfile?: boolean;
  /** E2-02: tie-break between sibling candidates of one source column. Off unless declared. */
  tieBreak?: { enabled: boolean };
  reviewCascade?: { enabled: boolean };
  reviewMode?: 'HUMAN' | 'MODEL_ADVERSARIAL' | 'HUMAN_OR_MODEL' | 'BOTH';
  reviewModeByRelation?: Record<string, 'HUMAN' | 'MODEL_ADVERSARIAL' | 'HUMAN_OR_MODEL' | 'BOTH'>;
}

/** Registry is data-driven; validation remains a pure function over supplied manifests. */
export const universeManifests: readonly UniverseManifest[] = readJson<UniverseManifest[]>('universes/registry.json');

export interface RegistryIssue { path: string; code: string; }
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
const safeColumn = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const semver = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
const capabilitySet = new Set<UniverseCapability>(['DISCOVERY', 'BOUNDED_RELATION_PROBE', 'LIVE_RELATION_PROBE', 'RELATION_EVALUATION', 'USL', 'SCHEMA_MATCHING', 'LOCAL_EVALUATION', 'METADATA_ONLY', 'AGENT_EXPLORATION']);
const adapterCapabilities: Record<UniverseManifest['source']['adapterId'], ReadonlySet<UniverseCapability>> = {
  zetaris: new Set(['DISCOVERY', 'BOUNDED_RELATION_PROBE', 'RELATION_EVALUATION', 'USL', 'SCHEMA_MATCHING', 'METADATA_ONLY', 'AGENT_EXPLORATION']),
  'zetaris-json2-live': new Set(['BOUNDED_RELATION_PROBE', 'LIVE_RELATION_PROBE', 'RELATION_EVALUATION']),
  'local-files': new Set(['RELATION_EVALUATION', 'SCHEMA_MATCHING', 'LOCAL_EVALUATION', 'METADATA_ONLY', 'AGENT_EXPLORATION']),
  'local-snapshot': new Set(['RELATION_EVALUATION', 'LOCAL_EVALUATION']),
  'madi-schema': new Set(['DISCOVERY', 'BOUNDED_RELATION_PROBE', 'RELATION_EVALUATION', 'SCHEMA_MATCHING', 'LOCAL_EVALUATION', 'AGENT_EXPLORATION']),
  'manifest-only': new Set(['METADATA_ONLY'])
};
const normalizedIdentity = (value: string) => value.toLowerCase();
const safeConfigPath = (value: unknown): value is string => typeof value === 'string' && /^universes\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(value);
const boundRequirements: Partial<Record<UniverseCapability, readonly string[]>> = {
  DISCOVERY: ['sampleLimit'], BOUNDED_RELATION_PROBE: ['probeLimit', 'maxRelationsPerRun', 'maxKeyColumns'], LIVE_RELATION_PROBE: ['probeLimit', 'maxRelationsPerRun', 'maxKeyColumns'],
  SCHEMA_MATCHING: ['sampleLimit', 'probeLimit', 'maxCandidatesPerRun'], LOCAL_EVALUATION: ['sampleLimit', 'probeLimit', 'maxRelationsPerRun', 'maxKeyColumns'],
  AGENT_EXPLORATION: ['maxQueriesPerRun', 'readLimit', 'maxTokensPerRun', 'maxSteps']
};
const boundCeilings: Record<string, number> = { sampleLimit: 1000, probeLimit: 50, maxRelationsPerRun: 500, maxCandidatesPerRun: 10000, maxKeyColumns: 32, maxQueriesPerRun: RUN_BUDGET_CEILINGS.maxQueriesPerRun, readLimit: RUN_BUDGET_CEILINGS.readLimit, maxTokensPerRun: RUN_BUDGET_CEILINGS.maxTokensPerRun, maxSteps: RUN_BUDGET_CEILINGS.maxSteps };

/** Pure registry validation. It does not read manifests, configs or any source. */
export function validateUniverseRegistry(manifests: readonly UniverseManifest[]): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  if (!Array.isArray(manifests)) return [{ path: 'manifests', code: 'EXPECTED_MANIFEST_ARRAY' }];
  const manifestIds = new Set<string>(), sourceIds = new Set<string>(), aliases = new Set<string>(), identities = new Map<string, number>(), relationOwners = new Map<string, number>();
  manifests.forEach((manifest: any, index) => {
    const path = `manifests[${index}]`;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) { issues.push({ path, code: 'EXPECTED_MANIFEST_OBJECT' }); return; }
    if (manifest.schemaVersion !== 1) issues.push({ path: `${path}.schemaVersion`, code: 'UNSUPPORTED_MANIFEST_SCHEMA' });
    if (!safeId(manifest.manifestId)) issues.push({ path: `${path}.manifestId`, code: 'INVALID_MANIFEST_ID' });
    else {
      const id = normalizedIdentity(manifest.manifestId);
      if (manifestIds.has(id)) issues.push({ path: `${path}.manifestId`, code: 'DUPLICATE_MANIFEST_ID' });
      manifestIds.add(id);
      if (identities.has(id)) issues.push({ path: `${path}.manifestId`, code: 'MANIFEST_ID_ALIAS_COLLISION' }); else identities.set(id, index);
    }
    if (!semver(manifest.version)) issues.push({ path: `${path}.version`, code: 'INVALID_MANIFEST_VERSION' });
    if (!Array.isArray(manifest.aliases) || !manifest.aliases.length || manifest.aliases.some((alias: unknown) => !safeId(alias))) issues.push({ path: `${path}.aliases`, code: 'INVALID_ALIASES' });
    else for (const alias of manifest.aliases) {
      const identity = normalizedIdentity(alias);
      if (aliases.has(identity)) issues.push({ path: `${path}.aliases`, code: 'DUPLICATE_ALIAS' });
      aliases.add(identity);
      const owner = identities.get(identity);
      if (owner !== undefined) issues.push({ path: `${path}.aliases`, code: 'MANIFEST_ID_ALIAS_COLLISION' }); else identities.set(identity, index);
    }
    const source = manifest.source;
    if (source?.profileManifestId !== undefined && !safeId(source.profileManifestId)) issues.push({ path: `${path}.source.profileManifestId`, code: 'INVALID_PROFILE_MANIFEST_ID' });
    if (source?.adapterId === 'zetaris-json2-live' && !safeId(source.profileManifestId)) issues.push({ path: `${path}.source.profileManifestId`, code: 'LIVE_PROFILE_MANIFEST_ID_REQUIRED' });
    if (!source || typeof source !== 'object' || Array.isArray(source)) issues.push({ path: `${path}.source`, code: 'EXPECTED_SOURCE_OBJECT' });
    if (!safeId(source?.sourceId)) issues.push({ path: `${path}.source.sourceId`, code: 'INVALID_SOURCE_ID' });
    else { const sourceIdentity = normalizedIdentity(source.sourceId); if (sourceIds.has(sourceIdentity)) issues.push({ path: `${path}.source.sourceId`, code: 'DUPLICATE_SOURCE_ID' }); sourceIds.add(sourceIdentity); }
    const adapterValid = source && ['zetaris', 'zetaris-json2-live', 'local-files', 'local-snapshot', 'madi-schema', 'manifest-only'].includes(source.adapterId);
    if (!adapterValid) issues.push({ path: `${path}.source.adapterId`, code: 'UNSUPPORTED_ADAPTER' });
    if (adapterValid && Array.isArray(manifest.capabilities)) manifest.capabilities.forEach((capability: unknown, capabilityIndex: number) => {
      if (capabilitySet.has(capability as UniverseCapability) && !adapterCapabilities[source.adapterId as UniverseManifest['source']['adapterId']].has(capability as UniverseCapability)) issues.push({ path: `${path}.capabilities[${capabilityIndex}]`, code: 'CAPABILITY_UNSUPPORTED_BY_ADAPTER' });
    });
    if (source?.adapterId === 'manifest-only') {
      if (source.configPath !== undefined) issues.push({ path: `${path}.source.configPath`, code: 'MANIFEST_ONLY_SOURCE_HAS_CONFIG_PATH' });
      if (Array.isArray(manifest.capabilities) && manifest.capabilities.some((capability: unknown) => capability !== 'METADATA_ONLY')) issues.push({ path: `${path}.capabilities`, code: 'MANIFEST_ONLY_CAPABILITY_EXCEEDED' });
    } else if (!safeConfigPath(source?.configPath)) issues.push({ path: `${path}.source.configPath`, code: 'INVALID_CONFIG_PATH' });
    if (!source || !['UNKNOWN', 'PUBLIC', 'USER', 'SYNTHETIC'].includes(source.dataOrigin)) issues.push({ path: `${path}.source.dataOrigin`, code: 'INVALID_DATA_ORIGIN' });
    if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0 || manifest.capabilities.some((capability: unknown) => !capabilitySet.has(capability as UniverseCapability))) issues.push({ path: `${path}.capabilities`, code: 'INVALID_CAPABILITIES' });
    if (Array.isArray(manifest.capabilities) && new Set(manifest.capabilities).size !== manifest.capabilities.length) issues.push({ path: `${path}.capabilities`, code: 'DUPLICATE_CAPABILITY' });
    if (!Array.isArray(manifest.capabilities) || !Array.isArray(manifest.relationIds) || manifest.relationIds.some((id: unknown) => !safeId(id)) || new Set(manifest.relationIds).size !== manifest.relationIds.length) issues.push({ path: `${path}.relationIds`, code: 'INVALID_RELATION_IDS' });
    else for (const relationId of manifest.relationIds) {
      const identity = normalizedIdentity(relationId), owner = relationOwners.get(identity);
      if (owner !== undefined && owner !== index) issues.push({ path: `${path}.relationIds`, code: 'DUPLICATE_RELATION_ID' }); else relationOwners.set(identity, index);
    }
    if (manifest.fullEvidence !== undefined && (typeof manifest.fullEvidence !== 'boolean' || (manifest.fullEvidence === true && !(Array.isArray(manifest.capabilities) && manifest.capabilities.includes('BOUNDED_RELATION_PROBE'))))) issues.push({ path: `${path}.fullEvidence`, code: 'INVALID_FULL_EVIDENCE' });
    if (manifest.consistency !== undefined) {
      const c: any = manifest.consistency, ok = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/.test(v);
      const aliasesOk = c?.aliases === undefined || (Array.isArray(c.aliases) && c.aliases.every((a: any) => a && typeof a === 'object' && typeof a.source === 'string' && /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(a.source) && Array.isArray(a.targets) && a.targets.length > 0 && a.targets.every(ok)));
      if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.enabled !== 'boolean' || !aliasesOk) issues.push({ path: `${path}.consistency`, code: 'INVALID_CONSISTENCY' });
    }
    if (manifest.fullEvidenceExtendedProfile !== undefined && (typeof manifest.fullEvidenceExtendedProfile !== 'boolean' || (manifest.fullEvidenceExtendedProfile === true && !(Array.isArray(manifest.capabilities) && manifest.capabilities.includes('BOUNDED_RELATION_PROBE'))))) issues.push({ path: `${path}.fullEvidenceExtendedProfile`, code: 'INVALID_FULL_EVIDENCE_EXTENDED_PROFILE' });
    if (manifest.tieBreak !== undefined) {
      const t: any = manifest.tieBreak;
      if (!t || typeof t !== 'object' || Array.isArray(t) || typeof t.enabled !== 'boolean') issues.push({ path: `${path}.tieBreak`, code: 'INVALID_TIE_BREAK' });
    }
    if (manifest.reviewCascade !== undefined) {
      const r: any = manifest.reviewCascade;
      if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.enabled !== 'boolean') issues.push({ path: `${path}.reviewCascade`, code: 'INVALID_REVIEW_CASCADE' });
    }
    if (manifest.reviewMode !== undefined && !isReviewMode(manifest.reviewMode)) issues.push({ path: `${path}.reviewMode`, code: 'INVALID_REVIEW_MODE' });
    if (manifest.reviewModeByRelation !== undefined) {
      const byRelation = manifest.reviewModeByRelation;
      if (!byRelation || typeof byRelation !== 'object' || Array.isArray(byRelation)) issues.push({ path: `${path}.reviewModeByRelation`, code: 'INVALID_REVIEW_MODE_BY_RELATION' });
      else for (const [relationId, mode] of Object.entries(byRelation)) {
        if (!safeId(relationId)) issues.push({ path: `${path}.reviewModeByRelation`, code: 'INVALID_REVIEW_MODE_RELATION_ID' });
        if (!isReviewMode(mode)) issues.push({ path: `${path}.reviewModeByRelation.${relationId}`, code: 'INVALID_REVIEW_MODE' });
      }
    }
    const bounds = manifest.capabilityBounds ?? {};
    if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) issues.push({ path: `${path}.capabilityBounds`, code: 'INVALID_CAPABILITY_BOUNDS' });
    else {
      for (const capability of Object.keys(bounds)) if (!manifest.capabilities?.includes(capability as UniverseCapability)) issues.push({ path: `${path}.capabilityBounds.${capability}`, code: 'BOUND_FOR_UNDECLARED_CAPABILITY' });
      for (const capabilityValue of manifest.capabilities ?? []) {
        const capability = capabilityValue as UniverseCapability;
        const required = boundRequirements[capability]; if (!required) continue;
        const capabilityBound = bounds[capability];
        if (!capabilityBound || required.some((name: string) => !Number.isInteger(capabilityBound[name]) || capabilityBound[name] <= 0)) { issues.push({ path: `${path}.capabilityBounds.${capability}`, code: 'MISSING_OR_INVALID_CAPABILITY_BOUND' }); continue; }
        for (const [name, value] of Object.entries(capabilityBound)) if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > (boundCeilings[name] ?? 0)) issues.push({ path: `${path}.capabilityBounds.${capability}.${name}`, code: 'INVALID_CAPABILITY_BOUND' });
      }
    }
    if (Array.isArray(manifest.capabilities) && manifest.capabilities.includes('METADATA_ONLY') && manifest.capabilities.includes('BOUNDED_RELATION_PROBE')) issues.push({ path: `${path}.capabilities`, code: 'CONFLICTING_METADATA_ONLY_CAPABILITY' });
  });
  if (['U1', 'U2', 'U3'].some(alias => !aliases.has(normalizedIdentity(alias)))) issues.push({ path: 'manifests', code: 'LEGACY_UNIVERSE_ALIASES_REQUIRED' });
  return issues;
}

/** Pure config validation for an already-approved manifest/config pair. */
export function validateUniverseConfig(manifest: UniverseManifest, config: unknown): RegistryIssue[] {
  const issues: RegistryIssue[] = [], path = `configs.${manifest.manifestId}`;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [{ path, code: 'EXPECTED_CONFIG_OBJECT' }];
  const cfg = config as any;
  if (!safeId(cfg.id) || !manifest.aliases.includes(cfg.id)) issues.push({ path: `${path}.id`, code: 'CONFIG_ID_NOT_MANIFEST_ALIAS' });
  if (!safeId(cfg.namespace)) issues.push({ path: `${path}.namespace`, code: 'INVALID_CONFIG_NAMESPACE' });
  const tables = cfg.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) issues.push({ path: `${path}.tables`, code: 'EXPECTED_TABLE_MAP' });
  const tableEntries = tables && typeof tables === 'object' && !Array.isArray(tables) ? Object.entries<any>(tables) : [];
  const columnsByTable = new Map<string, Set<string>>();
  for (const [tableId, table] of tableEntries) {
    if (!safeId(tableId) || !table || typeof table !== 'object' || Array.isArray(table)) { issues.push({ path: `${path}.tables.${tableId}`, code: 'INVALID_TABLE_CONFIG' }); continue; }
    const columns = Array.isArray(table.columns) ? table.columns.map((column: any) => typeof column === 'string' ? column : column?.name) : [];
    if (!Array.isArray(table.columns) || columns.some((column: unknown) => !safeColumn(column)) || new Set(columns).size !== columns.length) issues.push({ path: `${path}.tables.${tableId}.columns`, code: 'INVALID_COLUMN_ALLOWLIST' });
    columnsByTable.set(tableId, new Set(columns.filter(safeColumn)));
    if (table.db !== undefined && !safeId(table.db)) issues.push({ path: `${path}.tables.${tableId}.db`, code: 'INVALID_TABLE_NAMESPACE' });
    if (table.keyColumns !== undefined && (!Array.isArray(table.keyColumns) || table.keyColumns.some((column: unknown) => !safeColumn(column) || !columnsByTable.get(tableId)?.has(column as string)))) issues.push({ path: `${path}.tables.${tableId}.keyColumns`, code: 'INVALID_TABLE_KEY_COLUMNS' });
    // N41: a declared key contract is validated here, and may only name columns of the table's own allowlist.
    if (table.keyContract !== undefined) {
      issues.push(...validateKeyContractDeclaration(table.keyContract, `${path}.tables.${tableId}.keyContract`));
      if (table.keyContract && typeof table.keyContract === 'object' && !Array.isArray(table.keyContract)) for (const column of Object.keys(table.keyContract)) if (!columnsByTable.get(tableId)?.has(column)) issues.push({ path: `${path}.tables.${tableId}.keyContract.${column}`, code: 'KEY_CONTRACT_COLUMN_OUTSIDE_ALLOWLIST' });
    }
    if (table.fixtureRows !== undefined && (!Array.isArray(table.fixtureRows) || table.fixtureRows.some((row: unknown) => !Array.isArray(row) || row.length !== columns.length))) issues.push({ path: `${path}.tables.${tableId}.fixtureRows`, code: 'INVALID_FIXTURE_ROWS' });
  }
  const capabilities = new Set(manifest.capabilities);
  const bounds = manifest.capabilityBounds ?? {};
  const requireLimit = (key: 'sampleLimit' | 'probeLimit', capability: UniverseCapability) => {
    if (!capabilities.has(capability)) return;
    const bound = bounds[capability]?.[key];
    const value = cfg[key];
    if (!Number.isInteger(value) || value < 1) issues.push({ path: `${path}.${key}`, code: 'MISSING_OR_INVALID_CONFIG_LIMIT' });
    else if (!Number.isInteger(bound) || value > bound!) issues.push({ path: `${path}.${key}`, code: 'CONFIG_LIMIT_EXCEEDS_CAPABILITY_BOUND' });
  };
  requireLimit('sampleLimit', 'DISCOVERY');
  requireLimit('probeLimit', 'BOUNDED_RELATION_PROBE');
  requireLimit('sampleLimit', 'SCHEMA_MATCHING'); requireLimit('probeLimit', 'SCHEMA_MATCHING');
  if (manifest.source.adapterId === 'local-files' && capabilities.has('LOCAL_EVALUATION')) { requireLimit('sampleLimit', 'LOCAL_EVALUATION'); requireLimit('probeLimit', 'LOCAL_EVALUATION'); }
  const relations = cfg.relations;
  if (relations !== undefined && (!Array.isArray(relations) || relations.some((relation: unknown) => !relation || typeof relation !== 'object' || Array.isArray(relation)))) issues.push({ path: `${path}.relations`, code: 'INVALID_RELATIONS' });
  const relationList = Array.isArray(relations) ? relations : [];
  const relationIds = relationList.map((relation: any) => relation?.id);
  if (relationIds.some((id: unknown) => !safeId(id)) || new Set(relationIds).size !== relationIds.length) issues.push({ path: `${path}.relations`, code: 'INVALID_OR_DUPLICATE_RELATION_ID' });
  if (manifest.relationIds.length && (!Array.isArray(relations) || JSON.stringify([...relationIds].sort()) !== JSON.stringify([...manifest.relationIds].sort()))) issues.push({ path: `${path}.relations`, code: 'CONFIG_RELATION_IDS_MISMATCH' });
  if (relationList.length) {
    const endpoint = (relation: any, side: 'from' | 'to', index: number) => {
      const ref = relation?.[side], refPath = `${path}.relations[${index}].${side}`;
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) { issues.push({ path: refPath, code: 'INVALID_RELATION_ENDPOINT' }); return; }
      if (!safeId(ref.table) || !tableEntries.some(([tableId]) => tableId === ref.table)) { issues.push({ path: `${refPath}.table`, code: 'CONFIG_OBJECT_OUTSIDE_ALLOWLIST' }); return; }
      const approvedDb = tables[ref.table].db ?? cfg.database;
      if (!safeId(ref.db) || !safeId(approvedDb) || ref.db !== approvedDb) issues.push({ path: `${refPath}.db`, code: 'CONFIG_OBJECT_OUTSIDE_ALLOWLIST' });
      const orderedKeyColumns: unknown[] = Array.isArray(ref.columns) ? ref.columns : ref.column === undefined ? [] : [ref.column];
      if (!Array.isArray(tables[ref.table].keyColumns)) issues.push({ path: `${refPath}.table`, code: 'MISSING_TABLE_KEY_COLUMNS' });
      if (!orderedKeyColumns.length || orderedKeyColumns.some(column => !safeColumn(column))) issues.push({ path: `${refPath}.column`, code: 'MISSING_RELATION_KEY' });
      const maxKeyColumns = bounds.BOUNDED_RELATION_PROBE?.maxKeyColumns ?? bounds.LOCAL_EVALUATION?.maxKeyColumns ?? 1;
      if (orderedKeyColumns.length > maxKeyColumns) issues.push({ path: `${refPath}.columns`, code: 'COMPOSITE_KEY_UNSUPPORTED_BY_ADAPTER' });
      for (const column of orderedKeyColumns) {
        if (!safeColumn(column)) continue;
        if (!columnsByTable.get(ref.table)?.has(column)) issues.push({ path: `${refPath}.column`, code: 'CONFIG_COLUMN_OUTSIDE_ALLOWLIST' });
        else if (Array.isArray(tables[ref.table].keyColumns) && !tables[ref.table].keyColumns.includes(column)) issues.push({ path: `${refPath}.column`, code: 'RELATION_KEY_NOT_DECLARED' });
      }
    };
    relationList.forEach((relation: any, index: number) => {
      const hasOrderedKey = (ref: any) => Array.isArray(ref?.columns) ? ref.columns.length > 0 && ref.columns.every(safeColumn) : safeColumn(ref?.column);
      if (!hasOrderedKey(relation?.from)) issues.push({ path: `${path}.relations[${index}].from.column`, code: 'MISSING_RELATION_KEY' });
      if (!hasOrderedKey(relation?.to)) issues.push({ path: `${path}.relations[${index}].to.column`, code: 'MISSING_RELATION_KEY' });
      endpoint(relation, 'from', index); endpoint(relation, 'to', index);
      if (relation?.reviewMode !== undefined && !isReviewMode(relation.reviewMode)) issues.push({ path: `${path}.relations[${index}].reviewMode`, code: 'INVALID_REVIEW_MODE' });
      if (relation?.normalization !== undefined && !cfg.normalizationContract?.modes?.[relation.normalization]) issues.push({ path: `${path}.relations[${index}].normalization`, code: 'NORMALIZATION_NOT_IN_CONFIG' });
    });
  }
  for (const capability of ['BOUNDED_RELATION_PROBE', 'LOCAL_EVALUATION'] as const) {
    if (!capabilities.has(capability)) continue;
    const maxRelations = bounds[capability]?.maxRelationsPerRun;
    if (Number.isInteger(maxRelations) && relationList.length > maxRelations!) issues.push({ path: `${path}.relations`, code: 'RELATION_COUNT_EXCEEDS_CAPABILITY_BOUND' });
  }
  // Opt-in probe mode (approved for TPCDS only in practice): the only value is "distinct-keys"; absence keeps the default probe for every other universe.
  if (cfg.probeMode !== undefined && cfg.probeMode !== 'distinct-keys') issues.push({ path: `${path}.probeMode`, code: 'UNKNOWN_PROBE_MODE' });
  if (cfg.probeMode !== undefined && !(manifest.capabilities as string[]).includes('BOUNDED_RELATION_PROBE')) issues.push({ path: `${path}.probeMode`, code: 'PROBE_MODE_REQUIRES_BOUNDED_RELATION_PROBE' });
  // M7-6: an optional declaration that the schema is a known public benchmark; only these two keys, as plain text.
  if (cfg.publicBenchmark !== undefined) {
    const declared = cfg.publicBenchmark;
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) issues.push({ path: `${path}.publicBenchmark`, code: 'INVALID_PUBLIC_BENCHMARK' });
    else {
      for (const key of Object.keys(declared)) if (!['name', 'note'].includes(key)) issues.push({ path: `${path}.publicBenchmark.${key}`, code: 'UNKNOWN_PUBLIC_BENCHMARK_KEY' });
      if (typeof declared.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(declared.name)) issues.push({ path: `${path}.publicBenchmark.name`, code: 'INVALID_PUBLIC_BENCHMARK' });
      if (typeof declared.note !== 'string' || !declared.note.trim() || declared.note.length > 300 || /[ -]/.test(declared.note)) issues.push({ path: `${path}.publicBenchmark.note`, code: 'INVALID_PUBLIC_BENCHMARK' });
    }
  }
  if (capabilities.has('AGENT_EXPLORATION')) {
    issues.push(...validateExplorationCatalog(cfg, `${path}.explorationCatalog`));
    // R-01: the generic loop never reads a gold mapping; a catalog that names one is rejected so a universe cannot route the agent to it.
    if (/gold/i.test(JSON.stringify(cfg.explorationCatalog ?? null))) issues.push({ path: `${path}.explorationCatalog`, code: 'AGENT_CATALOG_REFERENCES_GOLD' });
    // R-03: a local-files universe replays its own fixtureRows, so LOCAL_EVALUATION stands in for the live DISCOVERY and probe capabilities.
    const localReplay = manifest.source.adapterId === 'local-files' && capabilities.has('LOCAL_EVALUATION');
    if (!localReplay && (!capabilities.has('DISCOVERY') || !capabilities.has('BOUNDED_RELATION_PROBE'))) issues.push({ path: `${path}.capabilities`, code: 'AGENT_EXPLORATION_REQUIRES_DISCOVERY_AND_PROBE' });
    // The generic loop reads each table through db + physicalTable; there is no fallback to the catalog, so both must be declared and safe (F-05).
    for (const [tableId, table] of tableEntries) {
      if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
      if (!safeId(table.db ?? cfg.database)) issues.push({ path: `${path}.tables.${tableId}.db`, code: 'AGENT_TABLE_DB_MISSING_OR_INVALID' });
      if (!safeId(table.physicalTable)) issues.push({ path: `${path}.tables.${tableId}.physicalTable`, code: 'AGENT_TABLE_PHYSICAL_TABLE_MISSING_OR_INVALID' });
    }
  }
  if (capabilities.has('SCHEMA_MATCHING')) {
    const maxCandidates = bounds.SCHEMA_MATCHING?.maxCandidatesPerRun;
    const candidateCount = tableEntries.reduce((count, [, table]) => count + (Array.isArray(table?.columns) ? table.columns.length : 0), 0);
    if (Number.isInteger(maxCandidates) && candidateCount > maxCandidates!) issues.push({ path: `${path}.tables`, code: 'CANDIDATE_COUNT_EXCEEDS_CAPABILITY_BOUND' });
  }
  if (manifest.source.adapterId === 'local-files' && capabilities.has('LOCAL_EVALUATION')) {
    const maxRows = bounds.LOCAL_EVALUATION?.sampleLimit;
    if (Number.isInteger(maxRows) && tableEntries.some(([, table]) => Array.isArray(table?.fixtureRows) && table.fixtureRows.length > maxRows!)) issues.push({ path: `${path}.tables`, code: 'FIXTURE_ROWS_EXCEED_CAPABILITY_BOUND' });
  }
  return issues;
}

/** Cross-manifest explicit config namespace checks over already-approved JSON configs. */
export function validateUniverseConfigSet(entries: readonly { manifest: UniverseManifest; config: unknown }[]): RegistryIssue[] {
  const issues: RegistryIssue[] = [], namespaceOwners = new Map<string, string>();
  for (const { manifest, config } of entries) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    const cfg = config as any, namespaces = new Set<string>();
    if (safeId(cfg.namespace)) namespaces.add(cfg.namespace);
    for (const namespace of namespaces) {
      const identity = normalizedIdentity(namespace), owner = namespaceOwners.get(identity);
      if (owner && owner !== manifest.manifestId) issues.push({ path: `configs.${manifest.manifestId}.namespace`, code: 'CONFIG_NAMESPACE_COLLISION' });
      else namespaceOwners.set(identity, manifest.manifestId);
    }
  }
  return issues;
}

export function resolveUniverseManifest(idOrAlias: string, manifests: readonly UniverseManifest[] = universeManifests): UniverseManifest | undefined {
  return manifests.find(manifest => manifest.manifestId === idOrAlias || manifest.aliases.includes(idOrAlias));
}

export function assertValidUniverseRegistry(manifests: readonly UniverseManifest[] = universeManifests): void {
  const issues = validateUniverseRegistry(manifests);
  if (issues.length) throw new TypeError(`Universe registry invalid: ${issues.map(issue => `${issue.path}:${issue.code}`).join(', ')}`);
}

/** Validate a proposed third-party manifest against registry identity constraints, offline. */
export function validateThirdPartyUniverseManifest(manifest: UniverseManifest, existing: readonly UniverseManifest[] = universeManifests): RegistryIssue[] {
  const existingIssues = validateUniverseRegistry(existing);
  const combinedIssues = validateUniverseRegistry([...existing, manifest]);
  return [...existingIssues, ...combinedIssues.filter(issue => !(issue.path === 'manifests' && issue.code === 'LEGACY_UNIVERSE_ALIASES_REQUIRED'))];
}

assertValidUniverseRegistry();

export interface CrossSide { manifest: UniverseManifest; config: any }

/**
 * R5-1: pure validation of a cross-universe config (universes/cross/<id>.json) against the allowlists of the universes it names.
 * A cross relation compares keys read by each side's own client; the declaration can never widen either side's table or column allowlist,
 * and a REVIEWED declaration must carry the human authorization that makes it so.
 */
export function validateCrossConfig(cross: unknown, resolve: (alias: string) => CrossSide | undefined, knownRelationIds: ReadonlySet<string> = new Set()): RegistryIssue[] {
  const issues: RegistryIssue[] = [], path = 'cross';
  if (!cross || typeof cross !== 'object' || Array.isArray(cross)) return [{ path, code: 'EXPECTED_CROSS_OBJECT' }];
  const c = cross as any;
  if (c.schemaVersion !== 1) issues.push({ path: `${path}.schemaVersion`, code: 'UNSUPPORTED_CROSS_SCHEMA' });
  if (!safeId(c.id)) issues.push({ path: `${path}.id`, code: 'INVALID_CROSS_ID' });
  const aliases: unknown = c.universes;
  if (!Array.isArray(aliases) || aliases.length < 2 || aliases.length > 4 || aliases.some(alias => !safeId(alias)) || new Set(aliases.map(alias => String(alias).toLowerCase())).size !== aliases.length) { issues.push({ path: `${path}.universes`, code: 'INVALID_CROSS_UNIVERSES' }); return issues; }
  const sides = new Map<string, CrossSide>();
  for (const alias of aliases as string[]) {
    const side = resolve(alias);
    if (!side) { issues.push({ path: `${path}.universes.${alias}`, code: 'CROSS_UNIVERSE_UNKNOWN' }); continue; }
    if (!side.manifest.capabilities.includes('AGENT_EXPLORATION')) issues.push({ path: `${path}.universes.${alias}`, code: 'CROSS_UNIVERSE_LACKS_AGENT_EXPLORATION' });
    sides.set(alias, side);
  }
  const ceiling = Math.min(50, ...[...sides.values()].map(side => side.manifest.capabilityBounds?.BOUNDED_RELATION_PROBE?.probeLimit ?? side.manifest.capabilityBounds?.LOCAL_EVALUATION?.probeLimit ?? 0));
  if (!Number.isInteger(c.probeLimit) || c.probeLimit < 1 || c.probeLimit > ceiling) issues.push({ path: `${path}.probeLimit`, code: 'CROSS_PROBE_LIMIT_INVALID' });
  const modes = c.normalizationContract?.modes;
  if (!modes || typeof modes !== 'object' || Array.isArray(modes) || !Object.keys(modes).length) issues.push({ path: `${path}.normalizationContract`, code: 'CROSS_NORMALIZATION_CONTRACT_REQUIRED' });
  if (!Array.isArray(c.relations) || !c.relations.length) { issues.push({ path: `${path}.relations`, code: 'EXPECTED_CROSS_RELATION_LIST' }); return issues; }
  const seen = new Set<string>();
  c.relations.forEach((relation: any, index: number) => {
    const here = `${path}.relations[${index}]`;
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) { issues.push({ path: here, code: 'INVALID_CROSS_RELATION' }); return; }
    if (!safeId(relation.id) || seen.has(String(relation.id).toLowerCase()) || knownRelationIds.has(String(relation.id).toLowerCase())) issues.push({ path: `${here}.id`, code: 'INVALID_OR_DUPLICATE_CROSS_RELATION_ID' });
    else seen.add(String(relation.id).toLowerCase());
    for (const side of ['from', 'to'] as const) {
      const ref = relation[side], owner = sides.get(ref?.universe);
      if (!owner) { issues.push({ path: `${here}.${side}.universe`, code: 'CROSS_ENDPOINT_UNIVERSE_NOT_LISTED' }); continue; }
      const table = owner.config?.tables?.[ref.table];
      if (!table) { issues.push({ path: `${here}.${side}.table`, code: 'CROSS_ENDPOINT_OUTSIDE_ALLOWLIST' }); continue; }
      const columns = (table.columns ?? []).map((column: any) => typeof column === 'string' ? column : column?.name);
      if (!columns.includes(ref.column) || !safeColumn(ref.column)) issues.push({ path: `${here}.${side}.column`, code: 'CROSS_ENDPOINT_OUTSIDE_ALLOWLIST' });
    }
    if (relation.from?.universe === relation.to?.universe) issues.push({ path: here, code: 'CROSS_RELATION_NOT_CROSS_UNIVERSE' });
    if (!modes?.[relation.normalization]) issues.push({ path: `${here}.normalization`, code: 'NORMALIZATION_NOT_IN_CONFIG' });
    if (relation.reviewState === 'REVIEWED') {
      const auth = relation.reviewAuthorization;
      if (!auth || typeof auth.approver !== 'string' || typeof auth.approvedAt !== 'string' || typeof auth.quote !== 'string' || !auth.approver || !auth.approvedAt || !auth.quote) issues.push({ path: `${here}.reviewAuthorization`, code: 'CROSS_REVIEW_WITHOUT_AUTHORIZATION' });
      if (relation.kind !== 'FOREIGN_KEY' || typeof relation.identifierSpace !== 'string' || typeof relation.sharedNamespace !== 'string') issues.push({ path: here, code: 'CROSS_REVIEW_REQUIRES_KIND_SPACE_AND_NAMESPACE' });
    }
  });
  return issues;
}
