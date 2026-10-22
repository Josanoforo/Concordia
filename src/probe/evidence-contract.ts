/** A fresh probe is required before a stored relation can be described as current. */
export function assessFreshness(previous: { sourceVersion: string; schemaVersion: string; normalization: string; observedAt: string; verdict: string } | null,
  current: { sourceVersion: string; schemaVersion: string; normalization: string; observedAt: string; verdict: string; complete?: boolean }) {
  if (current.complete === false) return { state: 'INCOMPLETA' as const, verdict: 'INDETERMINADA' as const, requiresReview: true,
    preserveHistorical: true, supersedePrevious: false, reusedAsFresh: false, sourceObservedAt: previous?.observedAt ?? null, changed: false };
  if (!previous) return { state: 'FRIA' as const, verdict: current.verdict, requiresReview: false,
    preserveHistorical: true, supersedePrevious: false, reusedAsFresh: false, sourceObservedAt: current.observedAt, changed: false };
  const changed = previous.sourceVersion !== current.sourceVersion || previous.schemaVersion !== current.schemaVersion || previous.normalization !== current.normalization;
  if (previous.verdict === 'SOSTENIDA' && current.verdict !== 'SOSTENIDA') return { state: 'DEGRADADA' as const, verdict: 'INDETERMINADA' as const,
    requiresReview: true, preserveHistorical: true, supersedePrevious: true, reusedAsFresh: false, sourceObservedAt: current.observedAt, changed };
  return { state: 'REVALIDADA' as const, verdict: current.verdict, requiresReview: changed,
    preserveHistorical: true, supersedePrevious: false, reusedAsFresh: false, sourceObservedAt: current.observedAt, changed };
}

export function assessPartialTransport(input: { fragments: { requestId: string; rows: number }[]; error: { status: number; retryAfter?: string } }) {
  return { evidenceState: 'INCOMPLETA' as const, verdict: 'INDETERMINADA' as const, complete: false,
    fragmentRequestIds: input.fragments.map(fragment => fragment.requestId), fragmentRows: input.fragments.reduce((sum, fragment) => sum + fragment.rows, 0),
    errorStatus: input.error.status, retryAfter: input.error.retryAfter ?? null, automaticRetry: false };
}
