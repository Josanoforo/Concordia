import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readSealedBindingBytes } from '../src/usl/sealed-binding.ts';
import { ROOT } from '../src/runtime.ts';

test('a CRLF working copy of a sealed binding is read as the canonical LF bytes; LF bytes are untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-'));
  const lf = Buffer.from('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'crlf.json'), lf.toString('utf8').replaceAll('\n', '\r\n'));
  fs.writeFileSync(path.join(dir, 'lf.json'), lf);
  assert.deepEqual(readSealedBindingBytes(path.join(dir, 'crlf.json')), lf);
  assert.deepEqual(readSealedBindingBytes(path.join(dir, 'lf.json')), lf);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the repo svp1 live binding reads as the bytes its plans pin', () => {
  const digest = createHash('sha256').update(readSealedBindingBytes(path.join(ROOT, 'universes', 'svp1-live-bindings.json'))).digest('hex');
  assert.equal(digest, '7bf285a4c0e1f791447db8e509631c7d14a6f54da4000f73775513dc2be9fcd9');
});
