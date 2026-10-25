import { createHash } from 'node:crypto';

export type FreshnessState = 'CURRENT_FOR_CHECK' | 'STALE' | 'UNKNOWN' | 'INCOMPLETE';
export interface EvidenceValidity {
  observedAt: string | null;
  checkedAt: string;
  sourceToken: string | null;
  sourceFingerprint: string | null;
  schemaFingerprint: string;
  contractFingerprint: string;
  normalizationFingerprint: string;
  completeness: 'COMPLETE' | 'PARTIAL' | 'TRUNCATED' | 'ERROR' | 'UNKNOWN';
  requestIds: string[];
  state: FreshnessState;
  requiresReview: boolean;
}

export interface DependencyRef { id: string; kind: 'claim' | 'evidence' | 'decision' | 'output'; dependsOn: string[]; sourceVersion: string; state: 'CURRENT' | 'STALE' | 'PENDING'; }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Freshness is based on source evidence and scope; cache age/checksum is deliberately not an input. */
export function assessEvidenceValidity(input: Omit<EvidenceValidity, 'state' | 'requiresReview'>, previous?: EvidenceValidity, maxAgeMs?: number, now = Date.now()): EvidenceValidity {
  if (!input.checkedAt || Number.isNaN(Date.parse(input.checkedAt))) throw new TypeError('INVALID_CHECKED_AT');
  if (input.observedAt && Number.isNaN(Date.parse(input.observedAt))) throw new TypeError('INVALID_OBSERVED_AT');
  const checkedMs = Date.parse(input.checkedAt);
  const staleByAge = maxAgeMs !== undefined && (maxAgeMs < 0 || now - checkedMs > maxAgeMs);
  const state: FreshnessState = input.completeness !== 'COMPLETE' ? 'INCOMPLETE' : !input.sourceToken && !input.sourceFingerprint ? 'UNKNOWN' : staleByAge ? 'STALE' : 'CURRENT_FOR_CHECK';
  const changed = !!previous && (previous.sourceToken !== input.sourceToken || previous.sourceFingerprint !== input.sourceFingerprint || previous.schemaFingerprint !== input.schemaFingerprint || previous.contractFingerprint !== input.contractFingerprint || previous.normalizationFingerprint !== input.normalizationFingerprint);
  return { ...input, requestIds: [...new Set(input.requestIds)].sort(), state, requiresReview: state === 'UNKNOWN' || state === 'STALE' || (!!changed && state === 'CURRENT_FOR_CHECK') };
}

export function createDependencyRef(id: string, kind: DependencyRef['kind'], dependsOn: string[], sourceVersion: string): DependencyRef {
  return { id, kind, dependsOn: [...new Set(dependsOn)].sort(), sourceVersion, state: 'CURRENT' };
}

export function invalidateDependencies(refs: readonly DependencyRef[], changedIds: readonly string[]): DependencyRef[] {
  const changed = new Set(changedIds), stale = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const ref of refs) if (!stale.has(ref.id) && ref.dependsOn.some(id => changed.has(id) || stale.has(id))) { stale.add(ref.id); progress = true; }
  }
  return refs.map(ref => ({ ...ref, dependsOn: [...ref.dependsOn], state: stale.has(ref.id) ? 'STALE' : ref.state }));
}

export function canonicalEvidenceFingerprint(value: unknown): string { return hash(value); }
