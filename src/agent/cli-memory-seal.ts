import path from 'node:path';
import { ROOT, SafeError } from '../runtime.ts';
import { planLegacySeals, sealLegacyAgentMemory } from './memory.ts';

/**
 * `concordia memory-seal-legacy [--dry-run]`: seals the agent memory scopes written before the origin seal (G0-5/G0-6). Each scope is sealed once, from its directory name
 * (LIVE-PUBLIC ...) or quarantined as LEGACY_UNSCOPED (origin UNKNOWN, never reused). Idempotent; it never rewrites a claim or the ledger. `--dry-run` lists what it would do.
 * `--root <dir>` (a directory inside .concordia) exists for tests and rehearsals; the default is .concordia/agent-memory.
 */
export function runMemorySealLegacyCommand(options: { dryRun: boolean; root?: string }) {
  const defaultRoot = path.join(ROOT, '.concordia', 'agent-memory'), root = options.root ? path.resolve(options.root) : defaultRoot;
  const inside = path.relative(path.join(ROOT, '.concordia'), root);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new SafeError('MEMORY_SEAL_ROOT_OUTSIDE_APPROVED_ROOT');
  const before = planLegacySeals(root);
  const sealed = options.dryRun ? [] : sealLegacyAgentMemory(root).filter(item => item.sealedBy !== 'ALREADY_SEALED');
  const summary = { mode: options.dryRun ? 'DRY_RUN' : 'SEALED', root: path.relative(ROOT, root).split(path.sep).join('/'), written: options.dryRun ? 0 : sealed.length,
    sealed: sealed.map(item => ({ scope: path.relative(ROOT, item.dir).split(path.sep).join('/'), sealedBy: item.sealedBy, origin: item.origin })),
    scopes: before.scopes.map(scope => ({ scope: scope.scope, universeId: scope.universeId, status: scope.status, sealedBy: scope.sealedBy, origin: scope.origin, claims: scope.claims })), totals: before.totals,
    note: 'reusable counts provenance only; the source version and the TTL are still checked when a run plans its warm start. No claim and no ledger entry is touched.' };
  console.log(JSON.stringify(summary));
  return summary;
}
