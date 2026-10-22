import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsl } from '../src/usl/index.ts';
test('USL refuses unsupported FK and keeps multi-table compile intact', () => {
  const relation = { verdict: 'INDETERMINADA', from: { table: 'yellow_taxi', column: 'PULocationID' }, to: { table: 'taxi_zones', column: 'LocationID' } };
  assert.throws(() => buildUsl([relation]));
  const plan = buildUsl([{ ...relation, verdict: 'SOSTENIDA' }]);
  assert.equal(plan.statements.filter(s => s.sql.startsWith('COMPILE')).length, 1);
  assert.ok(plan.ddl.includes('FOREIGN KEY REFERENCES taxi_zones(LocationID)'));
  assert.equal(plan.statements.filter(s => s.sql.startsWith('ACTIVATE')).length, 2);
  assert.ok(plan.statements.find(s => s.stage === 'activate_taxi_zones')?.sql.includes("WHERE LocationID IS NOT NULL AND LocationID <> ''"));
});
