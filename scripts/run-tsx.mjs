// Keep CLI scratch files within the project; never cache transpiled code in OS temp.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = path.join(root, '.concordia/tmp');
fs.mkdirSync(temp, { recursive: true });
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, TSX_DISABLE_CACHE: '1', TMPDIR: temp, TEMP: temp, TMP: temp }
});
process.exitCode = result.status ?? 1;
