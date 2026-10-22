import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationDecision, splitCatalogSql } from '../src/register.ts';
test('catalog splitting preserves quoted semicolons, ignores teardown and comments',()=>{
  const statements=splitCatalogSql('-- DROP TABLE bad;\nCREATE LIGHTNING DATABASE good DESCRIBE BY "x;y"; /* ; */ CACHE TABLE good.raw; -- tail');
  assert.equal(statements.length,2); assert.ok(statements[0].includes('"x;y"')); assert.ok(!statements.join(' ').includes('DROP'));
  assert.throws(()=>splitCatalogSql('SELECT "unterminated'));
});
test('registration policy prevents remote joins, aggregates, destructive and wildcard SQL',()=>{
  assert.equal(registrationDecision('CREATE LIGHTNING DATABASE good DESCRIBE BY "Good"'),null);
  for(const sql of ['DROP VIEW x','CREATE SCHEMASTORE VIEW x WITH CONTAINER y AS SELECT a FROM z JOIN w ON z.a=w.a','CREATE SCHEMASTORE VIEW x WITH CONTAINER y AS SELECT * FROM z'])assert.ok(registrationDecision(sql));
});
