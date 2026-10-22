// Inspect tracked/staged blobs only. Never open credential files.
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20_000_000 });
const staged = process.argv.includes('--staged');
const files = git(...(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'] : ['ls-files', '-z'])).split('\0').filter(Boolean);
const patterns = [new RegExp('nv' + 'api-[A-Za-z0-9_-]{20,}'), new RegExp('sk-' + 'ant[A-Za-z0-9_-]{20,}'), new RegExp('Bearer' + '\\s+[A-Za-z0-9._~+/-]{20,}', 'i'), /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/];
let fail = false;
for (const file of files) {
  if ((/(^|\/)\.env(?:\.|$)|\.env$/i.test(file)) && file !== '.env.example') {
    console.error('FAIL credential filename tracked:', file); fail = true; continue;
  }
  const content = git('show', staged ? ':' + file : 'HEAD:' + file);
  if (patterns.some(p => p.test(content))) { console.error('FAIL secret-like pattern:', file); fail = true; }
}
console.log(fail ? 'FAIL revisión de secretos' : `PASS revisión de ${files.length} archivos ${staged ? 'staged' : 'committed'}`);
process.exitCode = fail ? 1 : 0;
