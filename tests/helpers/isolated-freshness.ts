// Preloaded into every test process (`npm test` passes --import): each process gets its own freshness history root, so parallel
// test files never contend for the shared per-relation writer lock in .concordia/freshness-v2 (WRITER_EXISTS).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.CONCORDIA_FRESHNESS_DIR) {
  const concordia = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.concordia');
  fs.mkdirSync(concordia, { recursive: true });
  const directory = fs.mkdtempSync(path.join(concordia, 'freshness-test-'));
  process.env.CONCORDIA_FRESHNESS_DIR = directory;
  process.on('exit', () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ } });
}
