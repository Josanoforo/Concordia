/**
 * Local lint of a prepared USL lifecycle plan's SQL (R6-Z2 / R6-Z3). It runs before any source is reached and produces typed
 * findings instead of a backend HTTP 400. It is stricter than the backend on purpose: the plan's statements have exactly four
 * allowed shapes, so anything else is a finding. Pure and offline; it never executes or rewrites SQL.
 *
 * Known backend rejections encoded here (evidence in the repo, not general SQL knowledge):
 * - Inline column COMMENT inside a COMPILE USL ... DDL statement: HTTP 400 "Invalid DDL statement" (D3 report, 04b probe,
 *   a COMPILE without DEPLOY with `COMMENT '...'` on a column). Any COMMENT is therefore a finding; comments belong in the dossier.
 * - Nullable column activated against a NOT NULL primary key: HTTP 400 (USL_REFLECTION). The plan declares no constraints at all, so
 *   NOT NULL / PRIMARY KEY / FOREIGN KEY / UNIQUE / CHECK / DEFAULT in a column definition is a finding.
 */
import { isApprovedL4Namespace, type UslLifecyclePlan } from './lifecycle-plan.ts';

export type DdlLintCode =
  | 'PLAN_NOT_PREPARED' | 'SQL_NOT_PRINTABLE_ASCII' | 'FORBIDDEN_KEYWORD' | 'COMMENT_FORM_REJECTED_BY_BACKEND' | 'NAMESPACE_NOT_APPROVED' | 'MODEL_NAME_INVALID'
  | 'NAMESPACE_STATEMENT_SHAPE' | 'COMPILE_STATEMENT_SHAPE' | 'COMPILE_WITHOUT_DEPLOY' | 'MULTIPLE_STATEMENTS' | 'COLUMN_DEFINITION_SHAPE' | 'CONSTRAINT_NOT_ALLOWED'
  | 'ACTIVATION_STATEMENT_SHAPE' | 'ACTIVATION_NEEDS_INNER_JOIN' | 'ACTIVATION_FORBIDDEN_CLAUSE'
  | 'LOAD_STEP_MISSING_OR_SHAPE' | 'VERIFY_STEP_MISSING' | 'VERIFY_STEP_ORDER' | 'VERIFY_STATEMENT_SHAPE' | 'VERIFY_LIMIT_INVALID' | 'VERIFY_TARGET_MISMATCH';
export interface DdlLintFinding { operationId: string | null; code: DdlLintCode; detail: string }
export interface DdlLintResult { status: 'PASS' | 'FAIL'; findings: DdlLintFinding[]; checkedOperations: string[] }

export class UslDdlLintError extends Error {
  readonly code = 'DDL_LINT_FAILED' as const;
  constructor(readonly findings: readonly DdlLintFinding[]) { super(`DDL_LINT_FAILED:${findings.map(item => item.code).join(',')}`); this.name = 'UslDdlLintError'; }
}

const FORBIDDEN = /\b(DROP|ALTER|TRUNCATE|DELETE|UPDATE|INSERT|MERGE|GRANT|REVOKE|RENAME|REPLACE|OVERWRITE)\b/i;
const CONSTRAINT = /\b(NOT\s+NULL|NULL|PRIMARY|FOREIGN|REFERENCES|UNIQUE|CHECK|DEFAULT|AUTO_INCREMENT|IDENTITY)\b/i;
const MODEL = /^concordia_l4_[a-z0-9_]+_v[1-9][0-9]*$/;
const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

export function lintUslLifecyclePlan(plan: UslLifecyclePlan): DdlLintResult {
  const findings: DdlLintFinding[] = [];
  const add = (operationId: string | null, code: DdlLintCode, detail: string) => findings.push({ operationId, code, detail });
  if (!plan || plan.status !== 'PREPARED' || !Array.isArray(plan.operations)) { add(null, 'PLAN_NOT_PREPARED', 'only a PREPARED plan has SQL to lint'); return { status: 'FAIL', findings, checkedOperations: [] }; }
  const { namespace, model } = plan.target, fullModel = `${namespace}.${model}`, table = `${fullModel}.ObservedRelation`;
  if (!isApprovedL4Namespace(namespace)) add(null, 'NAMESPACE_NOT_APPROVED', namespace);
  if (!MODEL.test(model)) add(null, 'MODEL_NAME_INVALID', model);
  const withSql = plan.operations.filter(operation => typeof operation.sql === 'string');
  for (const operation of withSql) {
    const id = operation.operationId, sql = operation.sql as string;
    if (/[^\x20-\x7E\n]/.test(sql)) add(id, 'SQL_NOT_PRINTABLE_ASCII', 'only printable ASCII and LF are allowed');
    if (FORBIDDEN.test(sql)) add(id, 'FORBIDDEN_KEYWORD', sql.match(FORBIDDEN)![1].toUpperCase());
    if (/\bCOMMENT\b|--|\/\*/i.test(sql)) add(id, 'COMMENT_FORM_REJECTED_BY_BACKEND', 'COMMENT (inline column form) is rejected with HTTP 400 in COMPILE USL; keep comments in the dossier');
  }
  const byId = (id: string) => plan.operations.find(operation => operation.operationId === id);

  const ns = byId('create_target_namespace')?.sql;
  if (ns !== `CREATE NAMESPACE IF NOT EXISTS ${namespace}`) add('create_target_namespace', 'NAMESPACE_STATEMENT_SHAPE', 'must be exactly CREATE NAMESPACE IF NOT EXISTS <approved target namespace>');

  const compile = byId('compile_versioned_model')?.sql;
  if (typeof compile !== 'string') add('compile_versioned_model', 'COMPILE_STATEMENT_SHAPE', 'missing');
  else {
    if (/^COMPILE\s+USL\s+\S+\s+NAMESPACE\b/i.test(compile)) add('compile_versioned_model', 'COMPILE_WITHOUT_DEPLOY', 'the COMPILE ... NAMESPACE form without DEPLOY is not the applied form');
    const head = `COMPILE USL ${model} DEPLOY NAMESPACE ${namespace} DDL\n`;
    if (!compile.startsWith(head)) add('compile_versioned_model', 'COMPILE_STATEMENT_SHAPE', 'header must be COMPILE USL <model> DEPLOY NAMESPACE <approved namespace> DDL');
    else {
      const body = compile.slice(head.length);
      const match = new RegExp(`^CREATE TABLE ObservedRelation \\(\\n((?:  ${IDENT} varchar\\(512\\),?\\n)+)\\);$`).exec(body);
      if ((body.match(/;/g) ?? []).length !== 1 || (body.match(/\bCREATE\s+TABLE\b/gi) ?? []).length !== 1) add('compile_versioned_model', 'MULTIPLE_STATEMENTS', 'exactly one CREATE TABLE ObservedRelation statement');
      if (!match) {
        add('compile_versioned_model', CONSTRAINT.test(body.replace(/varchar\(512\)/gi, '')) ? 'CONSTRAINT_NOT_ALLOWED' : 'COLUMN_DEFINITION_SHAPE', 'columns must be <name> varchar(512) with no constraints');
      } else {
        const lines = match[1].trimEnd().split('\n');
        lines.forEach((line, index) => { if (index < lines.length - 1 ? !line.endsWith(',') : line.endsWith(',')) add('compile_versioned_model', 'COLUMN_DEFINITION_SHAPE', `comma placement at column ${index + 1}`); });
        const names = lines.map(line => line.trim().split(' ')[0]);
        if (new Set(names).size !== names.length) add('compile_versioned_model', 'COLUMN_DEFINITION_SHAPE', 'duplicate column name');
      }
    }
  }

  const activate = byId('activate_observed_relation')?.sql;
  if (typeof activate !== 'string') add('activate_observed_relation', 'ACTIVATION_STATEMENT_SHAPE', 'missing');
  else {
    if (!activate.startsWith(`ACTIVATE USL TABLE ${table} AS SELECT `)) add('activate_observed_relation', 'ACTIVATION_STATEMENT_SHAPE', 'must be ACTIVATE USL TABLE <target>.ObservedRelation AS SELECT ...');
    if (!/\bINNER\s+JOIN\b/i.test(activate)) add('activate_observed_relation', 'ACTIVATION_NEEDS_INNER_JOIN', 'the published relation is a textual INNER JOIN');
    if (/\b(DISTINCT|CAST|COUNT|GROUP\s+BY|LIMIT|UNION|LEFT|RIGHT|FULL|CROSS|OUTER)\b/i.test(activate) || activate.includes(';')) add('activate_observed_relation', 'ACTIVATION_FORBIDDEN_CLAUSE', 'no DISTINCT/CAST/aggregation/LIMIT/other joins/semicolon');
  }

  const load = byId('load_model_for_definition_check')?.sql;
  if (load !== `LOAD USL ${model} NAMESPACE ${namespace}`) add('load_model_for_definition_check', 'LOAD_STEP_MISSING_OR_SHAPE', 'must be exactly LOAD USL <model> NAMESPACE <namespace>');

  // R6-Z3: the post-apply verification is a bounded plain read of the published table, after the activation.
  const verify = byId('verify_observed_relation_sample');
  if (!verify || typeof verify.sql !== 'string') add('verify_observed_relation_sample', 'VERIFY_STEP_MISSING', 'the plan must carry a bounded SELECT verification');
  else {
    const activationIndex = plan.operations.findIndex(operation => operation.operationId === 'activate_observed_relation');
    if (activationIndex < 0 || plan.operations.indexOf(verify) < activationIndex) add(verify.operationId, 'VERIFY_STEP_ORDER', 'verification must come after activation');
    const m = new RegExp(`^SELECT (${IDENT}(?:, ${IDENT})*) FROM (\\S+) LIMIT ([0-9]+)$`).exec(verify.sql);
    if (!m) add(verify.operationId, 'VERIFY_STATEMENT_SHAPE', 'must be SELECT <columns> FROM <target table> LIMIT <n> (no JOIN, WHERE, aggregation or DISTINCT)');
    else {
      if (m[2] !== table) add(verify.operationId, 'VERIFY_TARGET_MISMATCH', 'must read the published target table');
      const limit = Number(m[3]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) add(verify.operationId, 'VERIFY_LIMIT_INVALID', 'LIMIT must be 1..50');
      const expected = plan.columnDefinitions.map(column => column.name).join(', ');
      if (m[1] !== expected) add(verify.operationId, 'VERIFY_STATEMENT_SHAPE', 'projection must be exactly the declared output columns');
    }
    if (verify.persistentEffect) add(verify.operationId, 'VERIFY_STATEMENT_SHAPE', 'a verification step cannot have a persistent effect');
  }
  return { status: findings.length ? 'FAIL' : 'PASS', findings, checkedOperations: withSql.map(operation => operation.operationId) };
}

/** Throws the typed lint error; callers that prefer a value use lintUslLifecyclePlan. */
export function assertUslDdlLint(plan: UslLifecyclePlan): void {
  const result = lintUslLifecyclePlan(plan);
  if (result.status === 'FAIL') throw new UslDdlLintError(result.findings);
}

/** The read-only post-apply steps of a plan (R6-Z3), as the report and the rollback proposal cite them. */
export function postApplyVerificationSteps(plan: UslLifecyclePlan): { operationId: string; kind: 'READ'; sql: string; sqlSha256: string; limit: number | null }[] {
  return plan.operations.filter(operation => ['load_model_for_definition_check', 'verify_observed_relation_sample'].includes(operation.operationId) && operation.sql && operation.sqlSha256)
    .map(operation => ({ operationId: operation.operationId, kind: 'READ' as const, sql: operation.sql!, sqlSha256: operation.sqlSha256!, limit: Number(/ LIMIT ([0-9]+)$/.exec(operation.sql!)?.[1] ?? NaN) || null }));
}
