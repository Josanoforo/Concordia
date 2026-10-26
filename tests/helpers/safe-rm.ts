import fs from 'node:fs';

/**
 * Test cleanup that survives Windows file holders (indexer, antivirus, a child process still closing its handles): a remove that fails with EBUSY is retried with a
 * growing wait; every other error is thrown at once, so a real bug in cleanup is never hidden. Each test keeps its own unique temp path; this only closes the race on removal.
 */
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function removePath(target: string, options: { attempts?: number; delayMs?: number } = {}): void {
  const attempts = options.attempts ?? 8, delay = options.delayMs ?? 100;
  for (let attempt = 1; ; attempt++) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt >= attempts) throw error; sleep(delay * attempt); }
  }
}
export const removeFile = (file: string, options?: { attempts?: number; delayMs?: number }) => { if (fs.existsSync(file)) removePath(file, options); };
