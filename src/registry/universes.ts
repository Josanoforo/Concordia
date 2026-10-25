import { readJson } from '../runtime.ts';
import { validateExplorationCatalog } from '../agent/catalog.ts';

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
  'local-files': new Set(['RELATION_EVALUATION', 'SCHEMA_MATCHING', 'LOCAL_EVALUATION', 'METADATA_ONLY']),
  'local-snapshot': new Set(['RELATION_EVALUATION', 'LOCAL_EVALUATION']),
  'madi-schema': new Set(['DISCOVERY', 'BOUNDED_RELATION_PROBE', 'RELATION_EVALUATION', 'SCHEMA_MATCHING', 'LOCAL_EVALUATION']),
  'manifest-only': new Set(['METADATA_ONLY'])
};
const normalizedIdentity = (value: string) => value.toLowerCase();
const safeConfigPath = (value: unknown): value is string => typeof value === 'string' && /^universes\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(value);
const boundRequirements: Partial<Record<UniverseCapability, readonly string[]>> = {
  DISCOVERY: ['sampleLimit'], BOUNDED_RELATION_PROBE: ['probeLimit', 'maxRelationsPerRun', 'maxKeyColumns'], LIVE_RELATION_PROBE: ['probeLimit', 'maxRelationsPerRun', 'maxKeyColumns'],
  SCHEMA_MATCHING: ['sampleLimit', 'probeLimit', 'maxCandidatesPerRun'], LOCAL_EVALUATION: ['sampleLimit', 'probeLimit', 'maxRelationsPerRun', 'maxKeyColumns'],
  AGENT_EXPLORATION: ['maxQueriesPerRun', 'readLimit', 'maxTokensPerRun', 'maxSteps']
};
const boundCeilings: Record<string, number> = { sampleLimit: 1000, probeLimit: 50, maxRelationsPerRun: 500, maxCandidatesPerRun: 10000, maxKeyColumns: 32, maxQueriesPerRun: 200, readLimit: 1000, maxTokensPerRun: 200000, maxSteps: 20 };

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
      if (relation?.normalization !== undefined && !cfg.normalizationContract?.modes?.[relation.normalization]) issues.push({ path: `${path}.relations[${index}].normalization`, code: 'NORMALIZATION_NOT_IN_CONFIG' });
    });
  }
  for (const capability of ['BOUNDED_RELATION_PROBE', 'LOCAL_EVALUATION'] as const) {
    if (!capabilities.has(capability)) continue;
    const maxRelations = bounds[capability]?.maxRelationsPerRun;
    if (Number.isInteger(maxRelations) && relationList.length > maxRelations!) issues.push({ path: `${path}.relations`, code: 'RELATION_COUNT_EXCEEDS_CAPABILITY_BOUND' });
  }
  if (capabilities.has('AGENT_EXPLORATION')) {
    issues.push(...validateExplorationCatalog(cfg, `${path}.explorationCatalog`));
    if (!capabilities.has('DISCOVERY') || !capabilities.has('BOUNDED_RELATION_PROBE')) issues.push({ path: `${path}.capabilities`, code: 'AGENT_EXPLORATION_REQUIRES_DISCOVERY_AND_PROBE' });
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
