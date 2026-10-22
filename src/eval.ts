import { readJson, writeJson } from './runtime.ts';
export function evaluate() {
  const config = readJson('eval/cases/U1.json'), relations = readJson('out/U1/relaciones.json').relations;
  const endpoint = (e: any) => `${e.table}.${e.column}`;
  const results = config.cases.map((c: any) => {
    const found = relations.find((r: any) => endpoint(r.from) === c.from && endpoint(r.to) === c.to || c.symmetric && endpoint(r.from) === c.to && endpoint(r.to) === c.from);
    return { id: c.id, expected: c.expected, actual: found?.verdict ?? 'NOT_FOUND', relationId: found?.relationId,
      pass: Boolean(found && c.expected.includes(found.verdict) && (!c.requireAlert || found.evidence.alerts.length > 0)),
      alerts: found?.evidence.alerts ?? [] };
  });
  const correct = results.filter((r: any) => r.pass).length;
  const result = { utc: new Date().toISOString(), correct, total: results.length, status: correct >= config.minCorrect && results.every((r: any) => r.actual !== 'NOT_FOUND') ? 'PASS' : 'FAIL', results };
  writeJson('out/U1/eval.json', result);
  for (const r of results) console.log(r.pass ? 'PASS' : 'FAIL', r.id, r.actual);
  console.log(`${correct}/${results.length} correct`);
  if (result.status !== 'PASS') process.exitCode = 1;
  return result;
}
