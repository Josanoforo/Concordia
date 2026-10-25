import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_REASON_LIMIT, GENERIC_CODE_PREFIX, parseAdaptiveChoice, REASON_LIMIT } from '../src/agent/chooser.ts';

const allowed = ['READ_X', 'STOP_EXPLORATION'];

test('generic agent names model-response errors without the U2 prefix', () => {
  assert.throws(() => parseAdaptiveChoice('nope', allowed, REASON_LIMIT, false, GENERIC_CODE_PREFIX), /^SafeError: MODEL_RESPONSE_NOT_JSON|MODEL_RESPONSE_NOT_JSON/);
  assert.throws(() => parseAdaptiveChoice('{"action":"DROP","reason":"long enough reason"}', allowed, REASON_LIMIT, false, GENERIC_CODE_PREFIX), /MODEL_RESPONSE_INVALID/);
});

test('the U2 path keeps its recorded legacy codes and the shared limits are 500/60', () => {
  assert.throws(() => parseAdaptiveChoice('nope', allowed), /U2_ADAPTIVE_RESPONSE_NOT_JSON/);
  assert.equal(REASON_LIMIT, 500);
  assert.equal(COMPACT_REASON_LIMIT, 60);
});
