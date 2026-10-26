import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeFile, removePath } from './helpers/safe-rm.ts';

/** N32: cleanup retries only on EBUSY; any other error is thrown at once. */
const fail = (code: string) => Object.assign(new Error(code), { code });
function withRmSync<T>(impl: typeof fs.rmSync, body: () => T): T { const original = fs.rmSync; (fs as any).rmSync = impl; try { return body(); } finally { (fs as any).rmSync = original; } }

test('removePath removes a directory tree and a missing path is not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-rm-')); fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  removePath(dir); assert.equal(fs.existsSync(dir), false);
  assert.doesNotThrow(() => removePath(dir)); assert.doesNotThrow(() => removeFile(path.join(dir, 'nope')));
});

test('EBUSY is retried until the remove succeeds', () => {
  let calls = 0, real = fs.rmSync;
  withRmSync(((target: any, options: any) => { calls++; if (calls < 3) throw fail('EBUSY'); return real(target, options); }) as any, () => removePath(path.join(os.tmpdir(), 'safe-rm-never-existed'), { delayMs: 1 }));
  assert.equal(calls, 3);
});

test('EBUSY that never clears is thrown after the attempts, and any other error is thrown at once', () => {
  let calls = 0;
  assert.throws(() => withRmSync((() => { calls++; throw fail('EBUSY'); }) as any, () => removePath('x', { attempts: 4, delayMs: 1 })), /EBUSY/);
  assert.equal(calls, 4);
  calls = 0;
  assert.throws(() => withRmSync((() => { calls++; throw fail('EACCES'); }) as any, () => removePath('x', { attempts: 4, delayMs: 1 })), /EACCES/);
  assert.equal(calls, 1, 'a real cleanup bug is never retried or hidden');
});
