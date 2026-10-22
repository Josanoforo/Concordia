import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertEffectiveModel, assertGenerationAllowed, Nightshift, normalizeBase, reserveGeneration, resolveReceipt } from '../src/clients/nightshift.ts';
import { ROOT } from '../src/runtime.ts';

test('base URL normalization avoids duplicate v1', () => {
  for (const suffix of ['', '/v1', '/v1/models', '/v1/chat/completions', '/healthz']) assert.equal(normalizeBase('127.0.0.1:8088' + suffix), 'http://127.0.0.1:8088/v1');
  assert.throws(() => normalizeBase('https://remote.example/v1'));
});
test('construction accepts Anthropic Haiku/Sonnet and rejects Opus/Fable regardless of predicted model', () => {
  const policy = { route: 'meterless/cheap', requiredProvider: 'anthropic', allowedModelFamilies: ['haiku','sonnet'], forbiddenModelFamilies: ['opus','fable'], generationBlocked: false };
  const receipt = { receiptId: 'fixture', provider: 'anthropic', model: 'claude-haiku-fixture', inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, fromCache: false, requestedMode: 'cheap', routedMode: 'cheap', modeCoerced: false };
  assert.doesNotThrow(() => assertGenerationAllowed('meterless/cheap', policy));
  assert.doesNotThrow(() => assertEffectiveModel(receipt, policy));
  assert.throws(() => assertGenerationAllowed('meterless/auto', policy));
  assert.throws(() => assertEffectiveModel({ ...receipt, model: 'claude-opus-fixture' }, policy));
  assert.doesNotThrow(() => assertEffectiveModel({ ...receipt, model: 'claude-sonnet-fixture', predicted: 'claude-haiku-fixture', winner: 'claude-sonnet-fixture', routingReason: 'cold-explore' }, policy));
  assert.throws(() => assertEffectiveModel({ ...receipt, model: 'claude-fable-fixture' }, policy));
  assert.throws(() => assertEffectiveModel({ ...receipt, model: 'claude-haiku-opus-fixture' }, policy));
  assert.throws(() => assertEffectiveModel({ ...receipt, provider: 'other' }, policy));
  assert.throws(() => assertEffectiveModel({ ...receipt, model: 'unknown-model', predicted: 'claude-haiku-fixture' }, policy));
  assert.throws(() => assertGenerationAllowed('meterless/cheap', { ...policy, generationBlocked: true }));
  assert.throws(() => assertEffectiveModel({ ...receipt, routedMode: 'auto', modeCoerced: true }, policy));
  assert.throws(() => assertEffectiveModel({ ...receipt, requestedMode: 'auto', routedMode: 'auto', modeCoerced: false }, policy));
  assert.throws(() => assertEffectiveModel({ ...receipt, modeCoerced: undefined }, policy));
});
test('generation accounting continues above old ceilings without resetting receipts', () => {
  const temp=fs.mkdtempSync(path.join(ROOT,'.concordia','test-accounting-'));
  const attempts=Array.from({length:100},(_,i)=>({id:'fixture-'+i,route:'meterless/cheap',status:'PASS',receipt:{receiptId:'fixture-receipt-'+i}}));
  fs.writeFileSync(path.join(temp,'budget.json'),JSON.stringify({limit:20,consumed:100,attempts}));
  const next=reserveGeneration('meterless/cheap',temp);
  const state=JSON.parse(fs.readFileSync(path.join(temp,'budget.json'),'utf8'));
  assert.equal(state.limit,null);assert.equal(state.consumed,101);
  assert.deepEqual(state.attempts.slice(0,100),attempts);
  assert.equal(state.attempts[100].id,next.id);assert.equal(state.attempts[100].status,'RESERVED');
});

test('generation accounting rejects a corrupt ledger without erasing history',()=>{
  const temp=fs.mkdtempSync(path.join(ROOT,'.concordia','test-accounting-invalid-'));
  const file=path.join(temp,'budget.json'),original=JSON.stringify({limit:20,consumed:99,attempts:[]});
  fs.writeFileSync(file,original);
  assert.throws(()=>reserveGeneration('meterless/cheap',temp),/INVALID_BUDGET_STATE/);
  assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal(fs.existsSync(path.join(temp,'budget.lock')),false);
});

test('external budget reference appends to the original ledger and fails closed if it is missing',()=>{
  const temp=fs.mkdtempSync(path.join(ROOT,'.concordia','test-external-budget-'));
  const file=path.join(temp,'original-budget.json');
  const attempts=[{id:'prior-attempt',route:'meterless/cheap',status:'PASS',receipt:{receiptId:'prior-receipt'}}];
  fs.writeFileSync(file,JSON.stringify({limit:null,consumed:1,attempts}));
  const previous=process.env.CONCORDIA_BUDGET_FILE;
  try {
    process.env.CONCORDIA_BUDGET_FILE=file;
    const next=reserveGeneration('meterless/cheap');
    const state=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(state.consumed,2);assert.deepEqual(state.attempts[0],attempts[0]);assert.equal(state.attempts[1].id,next.id);
    assert.equal(fs.existsSync(path.join(ROOT,'.concordia','budget.json')),false);
    process.env.CONCORDIA_BUDGET_FILE=path.join(temp,'missing-budget.json');
    assert.throws(()=>reserveGeneration('meterless/cheap'),/BUDGET_STATE_MISSING/);
    assert.equal(fs.existsSync(path.join(temp,'missing-budget.json')),false);
  } finally {
    if(previous===undefined)delete process.env.CONCORDIA_BUDGET_FILE;else process.env.CONCORDIA_BUDGET_FILE=previous;
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

test('disallowed construction route blocks HTTP and does not consume a generation', async () => {
  const budgetFile = path.join(ROOT, '.concordia/budget.json');
  const snapshot = () => fs.existsSync(budgetFile) ? fs.readFileSync(budgetFile, 'utf8') : null;
  const before = snapshot();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('Network must not be reached'); };
  try {
    const client = new Nightshift({ base: 'http://127.0.0.1:8088', token: 'fixture', route: 'meterless/auto' });
    await assert.rejects(client.chat([{ role: 'user', content: 'fixture' }], { maxTokens: 10 }), /CONSTRUCTION_REQUIRES_CHEAP_ROUTE/);
    assert.equal(calls, 0);
    assert.equal(snapshot(), before);
  } finally { globalThis.fetch = original; }
});
test('accounting records every dispatch beyond twenty without a reserve or count quota', () => {
  const temp=fs.mkdtempSync(path.join(ROOT,'.concordia','test-accounting-new-'));
  for(let i=0;i<25;i++)assert.ok(reserveGeneration('meterless/cheap',temp));
  const state=JSON.parse(fs.readFileSync(path.join(temp,'budget.json'),'utf8'));
  assert.equal(state.consumed,25);assert.equal(state.attempts.length,25);assert.equal(state.limit,null);
  assert.equal(new Set(state.attempts.map((a:any)=>a.id)).size,25);
});

test('receipt resolution requires exact id and measured metadata', () => {
  const row = { receipt_id: 'fixture-1', winning_route: { provider: 'anthropic', model: 'fixture-model' }, usage: { prompt_tokens: 12, completion_tokens: 3 }, latency_ms: 60 };
  assert.equal(resolveReceipt({ receipts: [row] }, 'fixture-1').totalTokens, 15);
  assert.throws(() => resolveReceipt({ receipts: [row] }, 'unrelated'));
  const signed = { data: [{ body: { receipt: { ...row, usage: { input_tokens: 12, output_tokens: 3, latency_ms: 61 } } } }] };
  assert.equal(resolveReceipt(signed, 'fixture-1').latencyMs, 61);
  const hit = { data: [{ body: { receipt: { ...row, cache: { status: 'hit' }, app_policy: { requested_mode: 'cheap', routed_mode: 'auto', mode_coerced: true } } } }] };
  assert.equal(resolveReceipt(hit, 'fixture-1').fromCache, true);
  assert.equal(resolveReceipt(hit, 'fixture-1').modeCoerced, true);
  const routed = { data: [{ body: { receipt: { ...row, routing: { predicted: 'haiku-fixture', winner: 'sonnet-fixture', reason: 'cold-explore', policy: 'learned-router' } } } }] };
  assert.equal(resolveReceipt(routed, 'fixture-1').predicted, 'haiku-fixture');
  assert.equal(resolveReceipt(routed, 'fixture-1').winner, 'sonnet-fixture');
  assert.equal(resolveReceipt(routed, 'fixture-1').routingReason, 'cold-explore');
});
