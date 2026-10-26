/**
 * Proposed rollback of a USL publication (R6-Z4). A document, never an action: it describes what a human could ask for, with the
 * hash of every statement, and is marked NOT_EXECUTABLE_WITHOUT_NEW_GRANT. Nothing in the code base executes it: the live client
 * only runs the three plan operation ids (create_target_namespace, compile_versioned_model, activate_observed_relation), the plan
 * DDL lint rejects DROP, and `executable` is the literal false. The DROP syntax is a proposal: the backend dialect for it is not
 * confirmed in this repository, so it needs its own reviewed dialect evidence and an exact grant before anyone could run it.
 */
import { createHash } from 'node:crypto';
import { isApprovedL4Namespace, type UslLifecyclePlan } from './lifecycle-plan.ts';
import { lintUslLifecyclePlan } from './ddl-lint.ts';

export const ROLLBACK_STATUS = 'NOT_EXECUTABLE_WITHOUT_NEW_GRANT' as const;
export interface UslRollbackOperation { sequence: number; operationId: string; role: 'READ' | 'ROLLBACK'; objectRef: string; sql: string; sqlSha256: string; condition: string; persistentEffect: boolean }
export interface UslRollbackProposal {
  schemaVersion: 1;
  kind: 'USL_ROLLBACK_PROPOSAL';
  status: typeof ROLLBACK_STATUS;
  executable: false;
  executionStatus: 'NOT_RUN';
  /** The publication plan this proposal reverses; a different plan needs a different proposal. */
  planFingerprint: string;
  target: { namespace: string; model: string };
  scope: 'OWN_NAMESPACE_ONLY';
  dialect: 'UNVERIFIED_PROPOSAL';
  preconditions: string[];
  operations: UslRollbackOperation[];
  blockedBy: string[];
  limits: string[];
  fingerprint: string;
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => !item || typeof item !== 'object' || Array.isArray(item) ? item : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))));
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Builds the proposal for a PREPARED plan that passes the DDL lint. Throws instead of proposing for anything else. */
export function proposeUslRollbackPlan(plan: UslLifecyclePlan): UslRollbackProposal {
  if (!plan || plan.status !== 'PREPARED') throw new Error('ROLLBACK_PROPOSAL_REQUIRES_PREPARED_PLAN');
  if (lintUslLifecyclePlan(plan).status !== 'PASS') throw new Error('ROLLBACK_PROPOSAL_REQUIRES_LINTED_PLAN');
  const { namespace, model } = plan.target;
  if (!isApprovedL4Namespace(namespace)) throw new Error('ROLLBACK_PROPOSAL_NAMESPACE_NOT_APPROVED');
  const parent = namespace.split('.').slice(0, -1).join('.');
  const statements: Omit<UslRollbackOperation, 'sequence' | 'sqlSha256'>[] = [
    { operationId: 'rollback_confirm_ownership', role: 'READ', objectRef: namespace, sql: `SHOW NAMESPACES OR TABLES IN ${namespace}`, persistentEffect: false,
      condition: `Read-only. Proceed only if the namespace holds nothing but ${model} and the local publication journal proves this plan created it; otherwise stop.` },
    { operationId: 'rollback_drop_target_namespace', role: 'ROLLBACK', objectRef: namespace, sql: `DROP NAMESPACE IF EXISTS ${namespace}`, persistentEffect: true,
      condition: 'Proposed only. Removes the whole dedicated namespace, never an object outside it. Needs reviewed dialect evidence for this statement and a new exact grant.' },
    { operationId: 'rollback_verify_absent', role: 'READ', objectRef: parent, sql: `SHOW NAMESPACES OR TABLES IN ${parent}`, persistentEffect: false,
      condition: 'Read-only. The namespace must no longer be listed; the local client pointer is then restored by the existing recovery path, not by this proposal.' }
  ];
  const body = {
    schemaVersion: 1 as const, kind: 'USL_ROLLBACK_PROPOSAL' as const, status: ROLLBACK_STATUS, executable: false as const, executionStatus: 'NOT_RUN' as const,
    planFingerprint: plan.fingerprint, target: { namespace, model }, scope: 'OWN_NAMESPACE_ONLY' as const, dialect: 'UNVERIFIED_PROPOSAL' as const,
    preconditions: ['publication journal shows this plan created the namespace', `namespace lists only ${model}`, 'no other plan version or foreign object in the namespace'],
    operations: statements.map((statement, index) => ({ sequence: index + 1, ...statement, sqlSha256: sha(statement.sql) })),
    blockedBy: ['new_exact_rollback_grant_required', 'rollback_sql_dialect_unconfirmed', 'ownership_proof_required'],
    limits: ['Never executed by Concordia code; a human decides and a new grant would bind these hashes.', 'A first publication has no previous version to fall back to: rollback means removing the dedicated namespace.',
      'Other clients may already have reached the published model; removing it can break them.']
  };
  return { ...body, fingerprint: sha(stable(body)) };
}

export function isUslRollbackProposalValid(value: unknown): value is UslRollbackProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { fingerprint, ...body } = value as UslRollbackProposal;
  return (value as UslRollbackProposal).status === ROLLBACK_STATUS && (value as UslRollbackProposal).executable === false && sha(stable(body)) === fingerprint
    && Array.isArray(body.operations) && body.operations.every(operation => operation.sqlSha256 === sha(operation.sql));
}
