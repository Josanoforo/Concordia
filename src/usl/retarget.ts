import { isApprovedL4Namespace } from './lifecycle-plan.ts';
import type { PublicationPlanInput } from './publication-plan.ts';

const MODEL = /^concordia_l4_[a-z0-9_]+_v[1-9][0-9]*$/;

/**
 * Copies an already-sealed publication input onto a new approved target. The old target state (a catalog fingerprint of the OLD namespace) is dropped:
 * the fingerprint of the new target comes only from a fresh catalog snapshot, passed in by whoever read it. Contract, evidence and decision are carried unchanged,
 * so the SOSTENIDA bounded label and its pending conditions are exactly those of the source input.
 */
export function retargetPublicationInput(base: PublicationPlanInput, target: { namespace: string; model: string }, snapshot?: { fingerprint: string; observedAt: string }): PublicationPlanInput {
  if (!isApprovedL4Namespace(target.namespace)) throw new TypeError('RETARGET_NAMESPACE_NOT_APPROVED');
  if (!MODEL.test(target.model)) throw new TypeError('RETARGET_MODEL_INVALID');
  if (target.namespace === base.target.namespace && target.model === base.target.model) throw new TypeError('RETARGET_SAME_TARGET');
  const { targetState: _stale, ...rest } = base;
  return { ...rest, target: { namespace: target.namespace, model: target.model }, ...(snapshot ? { targetState: { fingerprint: snapshot.fingerprint, observedAt: snapshot.observedAt } } : {}) };
}
