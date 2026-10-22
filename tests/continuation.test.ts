import test from 'node:test';
import assert from 'node:assert/strict';
import { assertU1ContinuationSql, remainingU1Tables } from '../src/usl/resume.ts';
import { Zetaris } from '../src/clients/zetaris.ts';
import fs from 'node:fs';
import { completeUsl } from '../src/usl/complete.ts';
test('U1 continuation cannot replace or recompile the existing model',()=>{
  for(const sql of ['COMPILE USL u1_usl DEPLOY NAMESPACE lightning.metastore.concordia_u1 DDL CREATE TABLE x(id int)','UPDATE USL u1_usl NAMESPACE lightning.metastore.concordia_u1 AS {}','REMOVE USL u1_usl NAMESPACE lightning.metastore.concordia_u1','SELECT PULocationID FROM lightning.metastore.concordia_u1.u1_usl.hvv LIMIT 3; SELECT 1'])assert.throws(()=>assertU1ContinuationSql(sql));
  assert.doesNotThrow(()=>assertU1ContinuationSql('SELECT PULocationID FROM lightning.metastore.concordia_u1.u1_usl.hvv LIMIT 1'));
  assert.equal(new Set(remainingU1Tables).size,5);assert.ok(!remainingU1Tables.includes('hvv'));
});
test('SQL client rejects any timeout above the explicit 120 second ceiling before HTTP',async()=>{
  const client=new Zetaris({base:'http://127.0.0.1:8888/api/v1.0',key:'fixture',org:'1'});
  await assert.rejects(client.runSql('SELECT 1',1,{timeoutMs:120001}),/INVALID_SQL_TIMEOUT/);
});
test('full U1 replay after a continuation checkpoint fails before any network access',async()=>{
  const exists=fs.existsSync,fetchOriginal=globalThis.fetch;let calls=0;
  fs.existsSync=(file)=>String(file).replaceAll('\\','/').endsWith('/.concordia/03b-U1-continuation.json')||exists(file);
  globalThis.fetch=async()=>{calls++;throw new Error('must not send a replacement request');};
  try {await assert.rejects(completeUsl('U1'),/U1_FULL_MODEL_REPLAY_FORBIDDEN_AFTER_03B_CONTINUATION/);assert.equal(calls,0);}
  finally {fs.existsSync=exists;globalThis.fetch=fetchOriginal;}
});
