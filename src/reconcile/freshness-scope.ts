import { SafeError } from '../runtime.ts';
import type { Svp1Profile } from '../svp1.ts';
import { synthesizeCandidateContract } from '../svp1.ts';

function candidateFor(profile: Svp1Profile | undefined, requestedRelationId: string) {
  return profile?.candidates.find(item => item.candidateId === requestedRelationId || item.relationContractRef === requestedRelationId);
}

/** Maps a user-facing candidate alias to the stable relation contract identity. */
export function resolveFreshnessRelationId(profile: Svp1Profile | undefined, requestedRelationId: string): string {
  const candidate = candidateFor(profile, requestedRelationId);
  if (!candidate) return requestedRelationId;
  if (candidate.inputVariant) return `${candidate.baseRelationContractRef}:ablation:${candidate.candidateId}`;
  return candidate.relationContractRef ?? synthesizeCandidateContract(candidate, profile!)?.id ?? requestedRelationId;
}

/** Rejects unsupported SVP1 candidates before credentials, adapters, or source checks are reached. */
export function assertFreshnessRelationSupported(profile: Svp1Profile | undefined, requestedRelationId: string): void {
  const candidate = candidateFor(profile, requestedRelationId);
  if (!candidate) throw new SafeError('FRESHNESS_RELATION_NOT_FOUND');
  if (candidate.inputVariant) throw new SafeError('FRESHNESS_CONTROL_REVALIDATE_UNSUPPORTED');
  const contract = candidate.relationContractRef
    ? profile!.relations.find(item => item.id === candidate.relationContractRef)
    : synthesizeCandidateContract(candidate, profile!);
  if (!contract) throw new SafeError('FRESHNESS_RELATION_UNSUPPORTED');
}
