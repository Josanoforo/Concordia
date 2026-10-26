import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeShaOf } from '../src/agent/engine.ts';

/** C2: a clean copy (git archive, no .git) pins its code SHA from the stamp gate:clean writes; explicit dep and CONCORDIA_CODE_SHA win over it. */
// GIT_CEILING_DIRECTORIES keeps git from finding a repository above the temp folder: the folder must look like a git archive.
const withoutEnv = <T>(fn: () => T): T => { const saved = [process.env.CONCORDIA_CODE_SHA, process.env.GIT_CEILING_DIRECTORIES]; delete process.env.CONCORDIA_CODE_SHA; process.env.GIT_CEILING_DIRECTORIES = os.tmpdir(); try { return fn(); } finally { if (saved[0] !== undefined) process.env.CONCORDIA_CODE_SHA = saved[0]; if (saved[1] === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = saved[1]; } };
const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'code-sha-'));

test('no .git and no env: the .code-sha stamp is the SHA; without the stamp it stays UNKNOWN', () => {
  const dir = folder();
  try {
    withoutEnv(() => {
      assert.equal(codeShaOf({}, dir), 'UNKNOWN');
      fs.writeFileSync(path.join(dir, '.code-sha'), 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12\n');
      assert.equal(codeShaOf({}, dir), 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12');
      fs.writeFileSync(path.join(dir, '.code-sha'), 'not a sha');
      assert.equal(codeShaOf({}, dir), 'UNKNOWN', 'a malformed stamp is ignored');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('precedence: deps.codeSha, then CONCORDIA_CODE_SHA, then the stamp', () => {
  const dir = folder();
  try {
    fs.writeFileSync(path.join(dir, '.code-sha'), 'abcdef1234567');
    withoutEnv(() => {
      process.env.CONCORDIA_CODE_SHA = 'envsha';
      try {
        assert.equal(codeShaOf({ codeSha: 'dep' }, dir), 'dep');
        assert.equal(codeShaOf({}, dir), 'envsha');
      } finally { delete process.env.CONCORDIA_CODE_SHA; }
      assert.equal(codeShaOf({}, dir), 'abcdef1234567');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
