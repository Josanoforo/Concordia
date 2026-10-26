import path from 'node:path';
import { ROOT, SafeError, trace } from '../runtime.ts';
import { Reconciler } from '../reconcile/index.ts';
import { AGENT_MEMORY_ACTOR, resolveMemoryScope } from './memory.ts';

export interface MemoryResolveStaleOptions { universe?: string; claim?: string; decision?: string; reviewer?: string; reason?: string; dryRun?: boolean; executionMode?: string; dataOrigin?: string; dir?: string; now?: () => string }

/**
 * `concordia memory-resolve-stale`: a named human closes a STALE claim of the agent memory (M8-2). `keep` re-affirms it (CONFIRM, observed now), `close` invalidates it (INVALIDATE,
 * its own dependents then go STALE). The reviewer and the reason are mandatory and are recorded in the claim, the ledger and the trace; the agent's own actor is refused by the API.
 * `--dry-run` reports what would change and writes nothing. The memory scope is the one of `--execution-mode` + `--data-origin` (no guessing); `--dir` (inside .concordia) is for tests.
 */
export function runMemoryResolveStaleCommand(options: MemoryResolveStaleOptions) {
  const { universe, claim, reviewer, reason } = options;
  if (!universe) throw new SafeError('UNIVERSE_REQUIRED');
  if (!claim) throw new SafeError('STALE_CLAIM_REQUIRED');
  if (options.decision !== 'keep' && options.decision !== 'close') throw new SafeError('STALE_DECISION_INVALID', undefined, '--decision must be keep or close');
  if (!reviewer?.trim()) throw new SafeError('HUMAN_REVIEWER_REQUIRED');
  if (!reason?.trim()) throw new SafeError('STALE_REASON_REQUIRED');
  let dir = options.dir;
  if (dir) { dir = path.resolve(dir); const rel = path.relative(path.join(ROOT, '.concordia'), dir); if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new SafeError('MEMORY_SCOPE_OUTSIDE_APPROVED_ROOT'); }
  const origin = options.executionMode && options.dataOrigin ? { executionMode: options.executionMode, dataOrigin: options.dataOrigin } : undefined;
  if (!dir && !origin) throw new SafeError('MEMORY_ORIGIN_REQUIRED', undefined, '--execution-mode and --data-origin select the memory scope');
  const scope = resolveMemoryScope(universe, { dir, origin }, false);
  const reconciler = new Reconciler(universe, scope.dir, AGENT_MEMORY_ACTOR, { strictSustained: true, origin: scope.origin, ...(options.now ? { now: options.now } : {}) });
  const found = reconciler.claims.find(item => item.id === claim);
  if (!found) throw new SafeError('CLAIM_NOT_FOUND');
  if (found.staleAt === undefined || found.invalidatedAt !== undefined) throw new SafeError('CLAIM_NOT_STALE');
  if (reviewer === AGENT_MEMORY_ACTOR) throw new SafeError('HUMAN_REVIEWER_REQUIRED');
  const decision = options.decision === 'keep' ? 'CONFIRM' as const : 'INVALIDATE' as const;
  const summary: Record<string, unknown> = { mode: options.dryRun ? 'DRY_RUN' : 'RESOLVED', universe, claimId: claim, entity: found.entity, attribute: found.attribute, value: found.value, staleAt: found.staleAt, staleReason: found.staleReason ?? null,
    decision: options.decision, apiDecision: decision, reviewer, reason };
  if (options.dryRun) {
    summary.wouldChange = decision === 'CONFIRM' ? 'the claim is believed and reusable again (staleAt cleared, lastObservedAt = now) and leaves the review queue' : 'the claim is invalidated and its own dependents go STALE';
    summary.written = 0;
  } else {
    const observedAt = (options.now ?? (() => new Date().toISOString()))();
    const result = reconciler.resolveStale(claim, decision, reviewer, { note: reason, ...(decision === 'CONFIRM' ? { observedAt } : {}) });
    summary.result = result; summary.written = 1;
    trace({ kind: 'memory-resolve-stale', universe, claimId: claim, decision: options.decision, apiDecision: decision, reviewer, reason, status: 'PASS' });
  }
  console.log(JSON.stringify(summary));
  return summary;
}
