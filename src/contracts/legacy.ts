import type { MigrationResult, RelationContract, Unknown } from './types.ts';
import { validateRelationContract, type ContractAllowlist } from './validate.ts';

type LegacyUniverse = { id: string; database?: string; tables?: Record<string, { columns?: { name: string }[] }>; relations?: any[] };
const unknown = <T = never>(): Unknown<T> => ({ state: 'UNKNOWN' });

/** Explicit, deterministic adapter. It records legacy declarations but does not infer relation kind or semantics. */
export function migrateLegacyUniverseConfig(config: LegacyUniverse): MigrationResult<RelationContract[]> {
  if (!config || typeof config.id !== 'string' || !config.id) throw new TypeError('legacyUniverse.id:REQUIRED_STRING');
  const relations = Array.isArray(config.relations) ? config.relations : [];
  const warnings: string[] = [];
  const idMap: Record<string, string> = {};
  const value = relations.map((legacy, index): RelationContract => {
    const id = typeof legacy?.id === 'string' && legacy.id ? legacy.id : `legacy-${config.id}-${index + 1}`;
    idMap[id] = id;
    const from = legacy?.from ?? {}, to = legacy?.to ?? {};
    const fromColumns = [from.column].filter((column): column is string => typeof column === 'string' && column.length > 0);
    const toColumns = [to.column].filter((column): column is string => typeof column === 'string' && column.length > 0);
    const fromNamespace = from.db ?? config.database;
    const toNamespace = to.db ?? config.database;
    const namespace = (v: unknown): Unknown<string> => typeof v === 'string' && v.length ? { state: 'KNOWN', value: v, provenance: 'legacy-config' } : unknown<string>();
    const operation = typeof legacy?.normalization === 'string' ? legacy.normalization : null;
    const contract: RelationContract = {
      schemaVersion: 1,
      id,
      contractVersion: '1.0',
      universeRef: { universeId: config.id, universeVersion: unknown(), namespace: namespace(config.database), configFingerprint: unknown() },
      kind: 'UNKNOWN',
      from: { sourceId: `${config.id}:${String(from.db ?? config.database ?? 'UNKNOWN')}`, namespace: namespace(fromNamespace), objectId: String(from.table ?? ''), orderedColumns: fromColumns },
      to: { sourceId: `${config.id}:${String(to.db ?? config.database ?? 'UNKNOWN')}`, namespace: namespace(toNamespace), objectId: String(to.table ?? ''), orderedColumns: toColumns },
      identifierSpace: unknown(),
      normalization: fromColumns.map((_, componentIndex) => ({ componentIndex, operation: operation ? { state: 'KNOWN', value: operation, provenance: 'legacy-config' } : unknown(), version: unknown(), lossless: unknown(), adapterCapability: unknown() })),
      semanticContext: { grain: unknown(), unit: unknown(), scale: unknown(), period: unknown(), timezone: unknown() },
      assertions: [],
      evidencePolicy: { requiredObservationTypes: ['KEY_MEMBERSHIP'], minimumCompleteness: 'COMPLETE_FOR_SCOPE', nulls: 'UNKNOWN', cardinality: 'UNKNOWN', declarationsAdmissible: 'UNKNOWN', minimumDistinctKeys: Number.isInteger(legacy?.minDistinctKeys) ? legacy.minDistinctKeys : 'UNKNOWN' },
      reviewState: 'PENDING'
    };
    warnings.push(`${id}: relation kind, identifier space, normalization losslessness/capability, semantic context, evidence scope and version remain UNKNOWN; manual review is pending.`);
    const allowlist: ContractAllowlist = { tables: Object.fromEntries(Object.entries(config.tables ?? {}).map(([name, spec]) => [name, (spec.columns ?? []).map(column => column.name)])) };
    const issues = validateRelationContract(contract, allowlist);
    if (issues.length) throw new TypeError(`legacy relation ${id} is invalid: ${issues.map(issue => `${issue.path}:${issue.code}`).join(', ')}`);
    return contract;
  });
  return { compatibility: 'MIGRATED', sourceVersion: 'legacy-unversioned', targetVersion: '1.0', idMap, warnings, value };
}
