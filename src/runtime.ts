import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const stamp = () => new Date().toISOString().replace(/[-:.]/g, '');
export class SafeError extends Error {
  constructor(public code: string, public http?: number, public detail?: string, public retryAfter?: string) { super(code); }
}
let loaded = false;
export function loadLocalEnv() {
  if (loaded) return;
  const localEnvFile = process.env.CONCORDIA_LOCAL_ENV_FILE
    ? path.resolve(process.env.CONCORDIA_LOCAL_ENV_FILE)
    : path.join(ROOT, '.env');
  if (!fs.existsSync(localEnvFile)) throw new SafeError('ENV_FILE_MISSING');
  // Only the running application loads the local file; never log its contents.
  try { process.loadEnvFile(localEnvFile); } catch { throw new SafeError('ENV_LOAD_FAILED'); }
  loaded = true;
}
export function required(name: string): string {
  const value = process.env[name];
  if (!value || /^(YOUR_|PLACEHOLDER|REPLACE_)/i.test(value)) throw new SafeError('MISSING_' + name);
  return value.trim();
}
export function sanitize(value: unknown): string {
  let text = String(value);
  for (const name of ['ZETARIS_API_KEY', 'METERLESS_RUNTIME_TOKEN']) {
    const secret = process.env[name];
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(new RegExp('\\b(?:sk-' + 'ant|nv' + 'api-)[A-Za-z0-9_-]+', 'g'), '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}
export function failure(error: unknown): { code: string; http?: number; detail?: string; retryAfter?: string } {
  return error instanceof SafeError ? { code: error.code, http: error.http, ...(error.detail ? { detail: sanitize(error.detail) } : {}), ...(error.retryAfter ? {retryAfter:error.retryAfter} : {}) } : { code: 'UNEXPECTED_ERROR' };
}
export function writeJson(relative: string, data: unknown) {
  const dest = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, sanitize(JSON.stringify(data, null, 2)) + '\n');
}
export function readJson<T = any>(relative: string): T { return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8')); }
let activeRun: string | undefined;
export function setTraceRun(run?: string) { activeRun = run; }
export function traceFileForRun(run?:string) { return path.join(ROOT,run?.startsWith('d3-')&&run.includes('U3')?'out/U3/trace.jsonl':'evidence/trace.jsonl'); }
export function trace(event: object) {
  const dest = traceFileForRun(activeRun);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const utc = new Date().toISOString();
  fs.appendFileSync(dest, sanitize(JSON.stringify({ utc, ts: utc, ...(activeRun ? {run:activeRun} : {}), ...event })) + '\n');
}
export function localUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SafeError('INVALID_BASE_URL'); }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) throw new SafeError('BASE_URL_MUST_BE_LOCAL');
  return url.href.replace(/\/$/, '');
}
export async function jsonRequest(url: string, init: RequestInit, timeout = 60_000, includeErrorDetail = false): Promise<any> {
  return (await jsonHttp(url, init, timeout, includeErrorDetail)).body;
}
export async function jsonHttp(url: string, init: RequestInit, timeout = 60_000, includeErrorDetail = false): Promise<{ http: number; body: any }> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
  catch (error) { throw new SafeError(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK_ERROR'); }
  if (!response.ok && !includeErrorDetail) { await response.body?.cancel(); throw new SafeError('HTTP_ERROR', response.status); }
  // Bound response size before parsing; no raw error bodies are persisted.
  const reader = response.body?.getReader();
  if (!reader) throw new SafeError('EMPTY_HTTP_BODY');
  let size = 0; const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new SafeError('RESPONSE_TOO_LARGE'); }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let body: any;
  try { body = JSON.parse(raw); }
  catch { throw new SafeError(response.ok ? 'INVALID_JSON_RESPONSE' : 'HTTP_ERROR', response.status,
    !response.ok && includeErrorDetail ? sanitize(raw.slice(0, 2000)) : undefined, !response.ok ? response.headers.get('retry-after')??undefined : undefined); }
  if (!response.ok) {
    const detail = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message ?? body?.detail ?? body?.errorMessage ?? body?.msg ?? raw;
    throw new SafeError('HTTP_ERROR', response.status, typeof detail === 'string' ? sanitize(detail.slice(0, 2000)) : undefined, response.headers.get('retry-after')??undefined);
  }
  return { http: response.status, body };
}
