import { retargetPublicationInput } from '../usl/retarget.ts';
import { compileUslLifecyclePlan, isApprovedL4Namespace, type PublicationSourceBinding, type UslLifecyclePlan } from '../usl/lifecycle-plan.ts';
import { compilePublicationPlan, type PublicationManifest, type PublicationPlanInput } from '../usl/publication-plan.ts';

export const AGENT_USL_PLAN_LABEL = 'SOSTENIDA acotada · policy 1.1 · SYNTHETIC (subset GTFS importado) · muestra acotada · sin unicidad ni cobertura global · requiere revisión';

export interface UslRelationSelector { fromTable: string; fromColumns: string[]; toTable: string; toColumns: string[] }
export interface UslPlanRequest {
  /** Sealed publication input (contract, typed evidence, decision) and the sealed source binding, as the agent holds them from the probes' artifacts. */
  input: PublicationPlanInput; binding: PublicationSourceBinding;
  relation: UslRelationSelector; target: { namespace: string; model: string };
  /** Fresh catalog snapshot of the new target; without it the plan carries no target state and the executor refuses to apply it (TARGET_STATE_SNAPSHOT_REQUIRED). */
  snapshot?: { fingerprint: string; observedAt: string };
}
export interface AgentUslPlan {
  status: 'PLAN_PREPARED' | 'PLAN_BLOCKED' | 'NOT_PUBLISHABLE';
  origin: 'AGENT_ORIGINATED_PLAN_ONLY'; applyExecuted: false; liveSqlExecuted: false;
  label: string; reasons: string[];
  publicationManifest?: PublicationManifest; publicationInput?: PublicationPlanInput; sourceBinding?: PublicationSourceBinding; lifecyclePlan?: UslLifecyclePlan;
  authorizationState: 'PENDING_HUMAN_EXACT_SCOPE_APPROVAL';
}

const tableOf = (objectId: string) => objectId.split('.').at(-1) ?? objectId;
const sameColumns = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((column, index) => column === b[index]);

/**
 * Plan-only: turns a candidate relation the agent holds evidence for into a USL lifecycle plan for a human to approve. It publishes a relation only when its decision is
 * SOSTENIDA and CURRENT; an abstention (INDETERMINADA) or anything else is reported as NOT_PUBLISHABLE and never planned. It never executes SQL and never builds a grant.
 */
export function originateUslPlan(request: UslPlanRequest): AgentUslPlan {
  const base = { origin: 'AGENT_ORIGINATED_PLAN_ONLY' as const, applyExecuted: false as const, liveSqlExecuted: false as const, label: AGENT_USL_PLAN_LABEL, authorizationState: 'PENDING_HUMAN_EXACT_SCOPE_APPROVAL' as const };
  const { input, relation } = request, { contract, decision } = input;
  const matches = contract.kind === 'FOREIGN_KEY' && tableOf(contract.from.objectId) === relation.fromTable && sameColumns(contract.from.orderedColumns, relation.fromColumns) &&
    tableOf(contract.to.objectId) === relation.toTable && sameColumns(contract.to.orderedColumns, relation.toColumns);
  const reasons: string[] = [];
  if (!matches) reasons.push('candidate_relation_not_in_evidence');
  if (decision.verdict !== 'SOSTENIDA') reasons.push(`verdict_${String(decision.verdict).toLowerCase()}_is_not_publishable`);
  if (decision.status !== 'CURRENT') reasons.push('decision_not_current');
  if (!isApprovedL4Namespace(request.target.namespace)) reasons.push('target_namespace_not_approved');
  if (reasons.length) return { ...base, status: 'NOT_PUBLISHABLE', reasons };
  const publicationInput = retargetPublicationInput(input, request.target, request.snapshot);
  const publicationManifest = compilePublicationPlan(publicationInput);
  const lifecyclePlan = compileUslLifecyclePlan(publicationManifest, publicationInput, request.binding);
  const blocked = lifecyclePlan.status !== 'PREPARED';
  return { ...base, status: blocked ? 'PLAN_BLOCKED' : 'PLAN_PREPARED', reasons: blocked ? lifecyclePlan.gates.filter(gate => gate.status === 'FAILED').map(gate => gate.code) : [],
    publicationManifest, publicationInput, sourceBinding: request.binding, lifecyclePlan };
}
