import test from 'node:test';
import assert from 'node:assert/strict';
import { identifier, parseSqlResponse } from '../src/clients/zetaris.ts';
import { jsonRequest, SafeError } from '../src/runtime.ts';

test('detects application errors even when transport succeeds', () => {
  for (const body of [{ error: 'bad', data: [] }, { success: false, data: [] }, { status: 'FAILED', data: [] }, { data: { error: 'bad' } }, { data: [['ok']], errors: ['bad'] }]) assert.throws(() => parseSqlResponse(body));
  assert.deepEqual(parseSqlResponse({ data: [['1'], [null]] }), [['1'], [null]]);
});
test('Zetaris HTTP diagnostics preserve the schema error and redact a credential', async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.ZETARIS_API_KEY;
  process.env.ZETARIS_API_KEY = 'fixture-secret-not-real';
  globalThis.fetch = async () => new Response('Schema mismatch LocationID nullable -> NOT NULL; fixture-secret-not-real', { status: 400 });
  try {
    await assert.rejects(jsonRequest('http://localhost/sql', {}, 1000, true), (error: unknown) => {
      assert.ok(error instanceof SafeError); assert.equal(error.http, 400);
      assert.ok(error.detail?.includes('nullable -> NOT NULL'));
      assert.ok(error.detail?.includes('[REDACTED]'));
      assert.ok(!error.detail?.includes('fixture-secret-not-real')); return true;
    });
    await assert.rejects(jsonRequest('http://localhost/sql', {}, 1000), (error: unknown) => error instanceof SafeError && error.detail === undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ZETARIS_API_KEY; else process.env.ZETARIS_API_KEY = originalKey;
  }
});
test('429 transport diagnostics preserve Retry-After without response values', async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'rate limited'}),{status:429,headers:{'Retry-After':'37','Content-Type':'application/json'}});
  try{await assert.rejects(jsonRequest('http://localhost/sql',{},1000,true),(error:unknown)=>{assert.ok(error instanceof SafeError);assert.equal(error.http,429);assert.equal(error.retryAfter,'37');assert.equal(error.detail,'rate limited');return true;});}
  finally{globalThis.fetch=originalFetch;}
});
test('identifiers cannot inject SQL', () => {
  assert.equal(identifier('PULocationID'), 'PULocationID');
  assert.throws(() => identifier('x;DROP TABLE x'));
});
