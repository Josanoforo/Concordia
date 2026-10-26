import { createHash } from 'node:crypto';
import type { PublicationManifest, PublicationPlanInput } from './publication-plan.ts';
import { uslOperationBindings, type PublicationSourceBinding, type UslLifecyclePlan } from './lifecycle-plan.ts';
import { validateUslLiveExecutionRequest, type UslLiveExecutionGrant } from './lifecycle-simulator.ts';

/** A live grant lives minutes, not hours: long enough for one apply plus its reuse check. */
export const MAX_LIVE_GRANT_TTL_MINUTES = 60;

export interface BuildLiveGrantOptions {
  plan: UslLifecyclePlan; manifest: PublicationManifest; input: PublicationPlanInput; binding: PublicationSourceBinding;
  /** Exact bytes of the sealed source binding and of the reviewed backend-dialect evidence. */
  rawBindingBytes: Uint8Array; dialectBytes: Uint8Array;
  /** The human who approves; the builder never invents an approver. */
  approvedBy: string; now?: number; ttlMinutes?: number; grantId?: string;
}

/**
 * Builds the LIVE_USL_PUBLICATION grant for one prepared lifecycle plan: hashes of exactly the plan's SQL, its target, the sealed binding and the dialect evidence.
 * It only assembles and self-validates the document; it never executes anything, and it refuses a plan or inputs the executor would reject.
 */
export function buildLiveUslGrant(options: BuildLiveGrantOptions): UslLiveExecutionGrant {
  const { plan, approvedBy } = options, now = options.now ?? Date.now(), ttl = options.ttlMinutes ?? 30;
  if (typeof approvedBy !== 'string' || !approvedBy.trim()) throw new Error('LIVE_GRANT_APPROVER_REQUIRED');
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_LIVE_GRANT_TTL_MINUTES) throw new Error('LIVE_GRANT_TTL_INVALID');
  let dialect: { dialectId?: unknown };
  try { dialect = JSON.parse(Buffer.from(options.dialectBytes).toString('utf8')); } catch { throw new Error('BACKEND_DIALECT_EVIDENCE_INVALID'); }
  if (typeof dialect?.dialectId !== 'string' || !dialect.dialectId) throw new Error('BACKEND_DIALECT_EVIDENCE_INVALID');
  const grant: UslLiveExecutionGrant = {
    schemaVersion: 1, grantId: options.grantId ?? `live-usl-${plan.fingerprint.slice(0, 12)}-${now}`, scope: 'LIVE_USL_PUBLICATION', planFingerprint: plan.fingerprint,
    targetRef: `${plan.target.namespace}.${plan.target.model}`, sourceBindingSha256: plan.sourceBinding.bindingSha256, sourceBindingFingerprint: plan.inputFingerprints.binding,
    operationSqlSha256s: plan.operations.flatMap(operation => operation.sqlSha256 ? [operation.sqlSha256] : []), approvedBy: approvedBy.trim(),
    approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + ttl * 60_000).toISOString(),
    dialectId: dialect.dialectId, dialectEvidenceSha256: createHash('sha256').update(options.dialectBytes).digest('hex'), operationBindings: uslOperationBindings(plan) };
  const issue = validateUslLiveExecutionRequest(plan, options.manifest, options.input, options.binding, options.rawBindingBytes, grant, options.dialectBytes, now);
  if (issue) throw new Error(`LIVE_GRANT_REJECTED_${issue}`);
  return grant;
}
