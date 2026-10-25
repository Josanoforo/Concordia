import fs from 'node:fs';

/**
 * Reads a sealed source binding as its canonical (git blob) bytes. A Windows checkout with core.autocrlf rewrites the working copy to CRLF, which changes the SHA-256
 * the plan pins; the sealed JSON has no meaningful CR, so CRLF is folded back to LF before the digest is checked. The digest comparison itself is unchanged.
 */
export function readSealedBindingBytes(file: string): Buffer {
  const bytes = fs.readFileSync(file);
  return bytes.includes(13) ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'), 'utf8') : bytes;
}
