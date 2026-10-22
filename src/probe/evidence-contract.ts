/** Offline policy contracts for freshness and partial transport. P4 will wire these to its watcher. */
export function assessFreshness(previous: { sourceVersion: string; schemaVersion: string; normalization: string; observedAt: string; verdict: string }, current: { sourceVersion: string; schemaVersion: string; normalization: string }) {
  const changed = previous.sourceVersion !== current.sourceVersion || previous.schemaVersion !== current.schemaVersion || previous.normalization !== current.normalization;
  return changed
    ? { state: 'DEGRADADA' as const, verdict: 'INDETERMINADA' as const, requiresReview: true, preserveHistorical: true, reusedAsFresh: false }
    : { state: 'REUTILIZADA' as const, verdict: previous.verdict, requiresReview: false, preserveHistorical: true, reusedAsFresh: false, sourceObservedAt: previous.observedAt };
}

export function assessPartialTransport(input: { fragments: { requestId: string; rows: number }[]; error: { status: number; retryAfter?: string } }) {
  return { evidenceState: 'INCOMPLETA' as const, verdict: 'INDETERMINADA' as const, complete: false,
    fragmentRequestIds: input.fragments.map(fragment => fragment.requestId), fragmentRows: input.fragments.reduce((sum, fragment) => sum + fragment.rows, 0),
    errorStatus: input.error.status, retryAfter: input.error.retryAfter ?? null, automaticRetry: false };
}
