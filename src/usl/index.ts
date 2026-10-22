import fs from 'node:fs';
import path from 'node:path';
import { Zetaris, type SqlResult } from '../clients/zetaris.ts';
import { failure, readJson, ROOT, SafeError, sanitize, writeJson } from '../runtime.ts';
import { projection, universe } from '../universe.ts';
const namespace = 'lightning.metastore.concordia_u1';
const model = namespace + '.u1_usl';
export function buildUsl(relations: any[]) {
  const supported = relations.find(r => r.verdict === 'SOSTENIDA' && r.from.table === 'yellow_taxi' && r.from.column === 'PULocationID' && r.to.table === 'taxi_zones' && r.to.column === 'LocationID');
  if (!supported) throw new SafeError('USL_REQUIRES_SUSTAINED_YELLOW_PICKUP_RELATION');
  const u = universe();
  const zoneColumns = ['LocationID','zone','borough'], yellowColumns = u.tables.yellow_taxi.columns.map(c => c.name);
  projection('taxi_zones', zoneColumns); projection('yellow_taxi', yellowColumns);
  const ddl = `COMPILE USL IF NOT EXISTS u1_usl DEPLOY NAMESPACE ${namespace} DDL\nCREATE TABLE taxi_zones (\n  LocationID varchar(16) NOT NULL PRIMARY KEY,\n  zone varchar(300),\n  borough varchar(100)\n);\nCREATE TABLE yellow_taxi (\n${yellowColumns.map(c => `  ${c} varchar(128)${c === 'PULocationID' ? ' FOREIGN KEY REFERENCES taxi_zones(LocationID)' : ''}`).join(',\n')}\n);`;
  return { supported, zoneColumns, yellowColumns, ddl, statements: [
    { stage: 'parent_namespace', sql: 'CREATE NAMESPACE IF NOT EXISTS lightning.metastore;' },
    { stage: 'namespace', sql: `CREATE NAMESPACE IF NOT EXISTS ${namespace};` },
    { stage: 'compile_one_complete_payload', sql: ddl },
    { stage: 'activate_taxi_zones', sql: `ACTIVATE USL TABLE ${model}.taxi_zones AS SELECT COALESCE(LocationID, '') AS LocationID, zone, borough FROM NY_TAXI.taxi_zones WHERE LocationID IS NOT NULL AND LocationID <> ''` },
    { stage: 'activate_yellow_taxi', sql: `ACTIVATE USL TABLE ${model}.yellow_taxi AS SELECT ${projection('yellow_taxi', yellowColumns)} FROM NY_TAXI.yellow_taxi` },
    { stage: 'verify_taxi_zones', sql: `SELECT ${projection('taxi_zones', zoneColumns)} FROM ${model}.taxi_zones LIMIT 3` },
    { stage: 'verify_yellow_taxi', sql: `SELECT ${projection('yellow_taxi', yellowColumns)} FROM ${model}.yellow_taxi LIMIT 3` }
  ] };
}
export async function usl() {
  const relations = readJson('out/U1/relaciones.json').relations;
  const evidence: any = { utc: new Date().toISOString(), status: 'FAIL', steps: [] };
  let plan: ReturnType<typeof buildUsl> | undefined;
  try {
    plan = buildUsl(relations);
    const z = new Zetaris();
    for (const statement of plan.statements) {
      console.log('USL', statement.stage);
      const limit = statement.stage.startsWith('verify') ? 3 : 1;
      evidence.failedStatement = statement;
      const result = await z.runSql(statement.sql, limit);
      evidence.steps.push({ stage: statement.stage, ...result });
      delete evidence.failedStatement;
      if (statement.stage.startsWith('verify') && !result.rows.length) throw new SafeError('USL_EMPTY_VERIFICATION');
      writeJson('out/U1/usl.json', evidence);
    }
    evidence.status = 'PASS';
  } catch (error) { evidence.error = failure(error); console.log('FAIL USL', JSON.stringify(evidence.error)); process.exitCode = 1; }
  evidence.ddl = plan?.ddl; evidence.includedRelation = plan?.supported.relationId;
  writeJson('out/U1/usl.json', evidence);
  const lines = ['# USL U1', '', 'Estado real: ' + evidence.status, '', 'Namespace: ' + model, '',
    'Se usa la sintaxis inline FOREIGN KEY REFERENCES del script preexistente 02_sic_edgar_usl_create.sql. El bloque COMPILE multi-tabla se envió íntegro en una sola petición, sin separar sus punto y coma.', '',
    'La PK de taxi_zones es parte del modelo declarado: las sondas acotadas no prueban unicidad global ni integridad de toda la fuente. No se impuso una PK inventada a yellow_taxi, que no dispone de una clave natural acreditada en la lista blanca.', '',
    "La activación inicial falló HTTP 400: LocationID nullable -> NOT NULL. La activación corregida filtra LocationID IS NOT NULL y LocationID <> ''; COALESCE(LocationID, '') solo da un esquema no nullable al resultado ya filtrado. No se fabrica ninguna clave para filas nulas, no se escriben datos fuente y no se materializa la vista. Las filas sin clave quedan fuera de esta dimensión virtual; su cantidad no se midió.", '',
    '## DDL emitido', '', '```sql', plan?.ddl ?? 'No se construyó DDL: faltó relación sostenida.', '```', '',
    '## Relación incluida', '', plan?.supported.explanation ?? 'Ninguna', '',
    'Evidencia: ' + (plan?.supported.relationId ?? 'no disponible'), '', '## Relaciones excluidas', ''];
  for (const r of relations.filter((r: any) => r.verdict !== 'SOSTENIDA')) {
    lines.push(`- ${r.relationId}: ${r.verdict}. ${r.explanation}`);
    for (const pair of r.evidence.labelAgreement?.examples.slice(0, 3) ?? []) lines.push(`  Clave ${pair.key}: ${pair.fromLabel.join(' / ')} ↔ ${pair.toLabel.join(' / ')}.`);
  }
  lines.push('', 'Las otras relaciones SOSTENIDAS quedan fuera de este USL mínimo por alcance; no se afirma que hayan sido rechazadas por calidad.', '', '## Ejecución y verificación', '');
  for (const step of evidence.steps) lines.push(`- ${step.stage}: requestId=${step.requestId}; filas=${step.rows.length}; duración=${step.durationMs}ms.`, '', '```sql', step.sql, '```');
  if (evidence.error) lines.push('', 'Error exacto disponible (sanitizado): ' + JSON.stringify(evidence.error));
  lines.push('', 'Datos/errores acotados: out/U1/usl.json. No se ejecutó MATERIALIZE, REGISTER DQ, agregados ni joins remotos.');
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/USL_U1.md'), sanitize(lines.join('\n')) + '\n');
  return evidence;
}
