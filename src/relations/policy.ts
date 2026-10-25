import type { RelationPolicy } from './decision.ts';

/** Resolve historical threshold names and typed policy names in one place. */
export function relationPolicyFromConfig(value: unknown): RelationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('RELATION_POLICY_CONFIG_REQUIRED');
  const config = value as Record<string, unknown>;
  const aliases: Array<[string, string]> = [
    ['relationPolicyVersion', 'policyVersion'],
    ['minDistinctKeys', 'minimumDistinctKeys'],
    ['sustainedOverlap', 'minimumOverlapRatio']
  ];
  for (const [legacyName, typedName] of aliases) {
    if (config[legacyName] !== undefined && config[typedName] !== undefined && config[legacyName] !== config[typedName]) {
      throw new TypeError('RELATION_POLICY_CONFIG_ALIAS_CONFLICT');
    }
  }
  const policyVersion = config.relationPolicyVersion ?? config.policyVersion;
  const minimumDistinctKeys = config.minDistinctKeys ?? config.minimumDistinctKeys;
  const minimumOverlapRatio = config.sustainedOverlap ?? config.minimumOverlapRatio;
  if (typeof policyVersion !== 'string' || !/^\d+\.\d+$/.test(policyVersion)) throw new TypeError('RELATION_POLICY_VERSION_REQUIRED');
  if (minimumDistinctKeys !== undefined && (!Number.isInteger(minimumDistinctKeys) || (minimumDistinctKeys as number) < 0)) throw new TypeError('RELATION_POLICY_MINIMUM_DISTINCT_KEYS_INVALID');
  if (minimumOverlapRatio !== undefined && (typeof minimumOverlapRatio !== 'number' || !Number.isFinite(minimumOverlapRatio) || minimumOverlapRatio < 0 || minimumOverlapRatio > 1)) throw new TypeError('RELATION_POLICY_MINIMUM_OVERLAP_INVALID');
  return {
    policyVersion,
    ...(minimumDistinctKeys === undefined ? {} : { minimumDistinctKeys: minimumDistinctKeys as number }),
    ...(minimumOverlapRatio === undefined ? {} : { minimumOverlapRatio: minimumOverlapRatio as number })
  };
}
