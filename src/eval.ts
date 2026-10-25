import { readJson, writeJson } from './runtime.ts';
import { evaluateRelation } from './relations/decision.ts';
import { relationPolicyFromConfig } from './relations/policy.ts';

export function evaluate() {
  const config = readJson('eval/cases/U1.json'), relations = readJson('out/U1/relaciones.json').relations;
  const thresholds = readJson('config/thresholds.json');
  const relationPolicy = relationPolicyFromConfig(thresholds);
  const endpoint = (e: any) => `${e.table}.${e.column}`;
  const results = config.cases.map((c: any) => {
    const found = relations.find((r: any) => endpoint(r.from) === c.from && endpoint(r.to) === c.to || c.symmetric && endpoint(r.from) === c.to && endpoint(r.to) === c.from);
    const probe = found?.evidence;
    const contract = found?.relationContract ?? probe?.relationContract;
    const evidence = found?.typedEvidence ?? probe?.typedEvidence;
    const typed = Boolean(contract && evidence);
    const typedDecision = typed ? evaluateRelation(contract, [evidence], relationPolicy) : undefined;
    const freshness = found?.freshness ?? probe?.freshness;
    const freshVerdict = freshness?.state === 'DEGRADADA' || freshness?.state === 'INCOMPLETA' ? 'INDETERMINADA' : undefined;
    const actual = !found ? 'NOT_FOUND' : !typed ? 'NOT_EVALUABLE' : freshVerdict ?? typedDecision!.verdict;
    const alerts = probe?.alerts ?? [];
    return { id: c.id, expected: c.expected, actual, relationId: found?.relationId,
      pass: Boolean(found && typed && c.expected.includes(actual) && (!c.requireAlert || alerts.length > 0)),
      ...(found && !typed ? { legacyVerdict: found.verdict ?? null } : {}),
      evaluationMode: typed ? 'REPLAY' : 'NOT_EVALUABLE',
      evaluationPolicyVersion: relationPolicy.policyVersion,
      sourcePolicyVersion: found?.decision?.policyVersion ?? probe?.decision?.policyVersion ?? null,
      sourceContractVersion: contract?.contractVersion ?? null,
      sourceEvidenceContractVersion: evidence?.contractVersion ?? null,
      sourceExecutionMode: evidence?.runRef?.executionMode ?? null,
      sourceDataOrigin: evidence?.runRef?.dataOrigin ?? null,
      alerts };
  });
  const correct = results.filter((r: any) => r.pass).length;
  const incomplete = results.some((r: any) => r.actual === 'NOT_EVALUABLE');
  const result = { utc: new Date().toISOString(), evaluationMode: 'REPLAY', evaluationPolicyVersion: relationPolicy.policyVersion, correct, total: results.length, status: incomplete ? 'INCOMPLETE' : correct >= config.minCorrect && results.every((r: any) => r.actual !== 'NOT_FOUND') ? 'PASS' : 'FAIL', results };
  writeJson('out/U1/eval.json', result);
  for (const r of results) console.log(r.pass ? 'PASS' : 'FAIL', r.id, r.actual);
  console.log(`${correct}/${results.length} correct`);
  if (result.status !== 'PASS') process.exitCode = 1;
  return result;
}