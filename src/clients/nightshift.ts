import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { failure, jsonHttp, localUrl, readJson, required, ROOT, SafeError, trace, writeJson } from '../runtime.ts';

export type Receipt = { receiptId: string; provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; latencyMs: number; fromCache: boolean; requestedMode?: string; routedMode?: string; modeCoerced?: boolean; boundMode?: string; predicted?: string | null; winner?: string | null; routingReason?: string | null; routingPolicy?: string | null };
type Attempt = { id: string; utc: string; route: string; status: string; receipt?: Receipt; error?: object };
type Budget = { limit: null; consumed: number; attempts: Attempt[] };
export type ModelPolicy = { route: string; requiredProvider: string; allowedModelFamilies: string[]; forbiddenModelFamilies: string[]; generationBlocked: boolean };
export function assertGenerationAllowed(route: string, policy: ModelPolicy) {
  if (route !== policy.route) throw new SafeError('CONSTRUCTION_REQUIRES_CHEAP_ROUTE');
  if (policy.generationBlocked) throw new SafeError('NIGHTSHIFT_CONSTRUCTION_ROUTE_BLOCKED');
}
export function assertEffectiveModel(receipt: Receipt, policy: ModelPolicy) {
  const model = receipt.model.toLowerCase();
  if (policy.forbiddenModelFamilies.some(family => model.includes(family.toLowerCase()))) throw new SafeError('FORBIDDEN_EFFECTIVE_MODEL');
  if (receipt.provider !== policy.requiredProvider || !policy.allowedModelFamilies.some(family => model.includes(family.toLowerCase()))) throw new SafeError('CONSTRUCTION_MODEL_NOT_ALLOWED');
  const requiredMode = policy.route.replace(/^meterless\//, '');
  if (receipt.requestedMode !== requiredMode || receipt.routedMode !== requiredMode || receipt.modeCoerced !== false) throw new SafeError('ROUTE_POLICY_COERCED_OR_UNCONFIRMED');
}
// Record dispatch before HTTP. The user removed all generation-count ceilings
// and reserves on 2026-10-22; the continued ledger is telemetry, never a quota.
export function reserveGeneration(route: string, budgetDir = path.join(ROOT, '.concordia')): Attempt {
  fs.mkdirSync(budgetDir, { recursive: true });
  const lockPath = path.join(budgetDir, 'budget.lock');
  let lock: number;
  try { lock = fs.openSync(lockPath, 'wx'); } catch { throw new SafeError('BUDGET_LOCKED'); }
  try {
    const file = path.join(budgetDir, 'budget.json');
    const state: Budget = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { limit: null, consumed: 0, attempts: [] };
    if (!Number.isInteger(state.consumed) || state.consumed < 0 || state.consumed !== state.attempts.length) throw new SafeError('INVALID_BUDGET_STATE');
    const attempt: Attempt = { id: randomUUID(), utc: new Date().toISOString(), route, status: 'RESERVED' };
    state.limit = null; state.consumed++; state.attempts.push(attempt);
    const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(state, null, 2)); fs.renameSync(temp, file);
    return attempt;
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
function finishAttempt(attempt: Attempt) {
  const state: Budget = readJson('.concordia/budget.json');
  const index = state.attempts.findIndex(a => a.id === attempt.id);
  if (index < 0) throw new SafeError('BUDGET_ATTEMPT_MISSING');
  state.attempts[index] = attempt;
  writeJson('.concordia/budget.json', state);
  writeJson('evidence/generations.json', state);
}
export function normalizeBase(value: string): string {
  const url = localUrl(value.includes('://') ? value : 'http://' + value);
  return url.replace(/\/(?:v1(?:\/(?:chat\/completions|models))?|healthz)$/, '') + '/v1';
}
function receiptRows(body: any): any[] {
  const rows = Array.isArray(body) ? body : body?.receipts ?? body?.data;
  if (!Array.isArray(rows)) throw new SafeError('RECEIPTS_RESPONSE_SHAPE');
  return rows;
}
export function resolveReceipt(body: any, receiptId: string): Receipt {
  const row = receiptRows(body).find(r => (r.body?.receipt?.receipt_id ?? r.receipt?.receipt_id ?? r.receipt_id ?? r.id) === receiptId);
  if (!row) throw new SafeError('RECEIPT_NOT_FOUND');
  const receipt = row.body?.receipt ?? row.receipt ?? row;
  const route = receipt.winning_route ?? row.winning_route;
  const usage = receipt.usage ?? row.usage;
  const provider = route?.provider ?? receipt.provider;
  const model = route?.model ?? receipt.model;
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? receipt.input_tokens;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? receipt.output_tokens;
  const latencyMs = usage?.latency_ms ?? receipt.latency_ms ?? receipt.duration_ms ?? row.latency_ms;
  if (typeof provider !== 'string' || typeof model !== 'string' || ![inputTokens, outputTokens, latencyMs].every(v => typeof v === 'number' && v >= 0)) throw new SafeError('RECEIPT_METADATA_INCOMPLETE');
  const cacheStatus = receipt.cache?.status;
  const fromCache = Boolean(receipt.from_cache ?? row.from_cache ?? (typeof cacheStatus === 'string' && /^(hit|cached)$/i.test(cacheStatus)));
  return { receiptId, provider, model, inputTokens, outputTokens, totalTokens: usage?.total_tokens ?? inputTokens + outputTokens, latencyMs, fromCache,
    requestedMode: receipt.app_policy?.requested_mode, routedMode: receipt.app_policy?.routed_mode, modeCoerced: receipt.app_policy?.mode_coerced, boundMode: receipt.app_policy?.bound_mode,
    predicted: receipt.routing?.predicted ?? null, winner: receipt.routing?.winner ?? null,
    routingReason: receipt.routing?.reason ?? null, routingPolicy: receipt.routing?.policy ?? null };
}
export class Nightshift {
  readonly route: string; private base: string; private token: string;
  constructor(options?: { base: string; token: string; route: string }) {
    this.base = normalizeBase(options?.base ?? required('METERLESS_BASE_URL'));
    this.token = options?.token ?? required('METERLESS_RUNTIME_TOKEN');
    this.route = options?.route ?? required('METERLESS_MODEL');
    if (!this.route.startsWith('meterless/') || /(?:^|[/.])(?:local|fusion)(?:$|[/.])/.test(this.route)) throw new SafeError('FORBIDDEN_METERLESS_ROUTE');
  }
  private requestWithStatus(path: string, body?: unknown, app = 'concordia') {
    return jsonHttp(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'meterless-app': app, 'meterless-scope': 'user', 'meterless-tier-split': 'off' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, 180_000);
  }
  private async request(path: string, body?: unknown) { return (await this.requestWithStatus(path, body)).body; }
  async models(): Promise<string[]> {
    const result = await this.request('/models');
    if (!Array.isArray(result.data)) throw new SafeError('MODELS_RESPONSE_SHAPE');
    return result.data.map((r: any) => r.id).filter((id: unknown): id is string => typeof id === 'string');
  }
  receipts(limit: 5 | 10 = 10) { return this.request('/meterless/receipts?limit=' + limit); }
  async routePreview(configuration: { mode?: string; model?: string; app?: string }) {
    const payload = { prompt: 'Reply only OK', app: 'concordia', width: 1, ...configuration };
    try {
      if (!/^[a-z0-9-]+$/.test(payload.app)) throw new SafeError('INVALID_PREVIEW_APP');
      const { http, body } = await this.requestWithStatus('/meterless/route/preview', payload, payload.app);
      return { payload, http, bound_mode: body.bound_mode ?? null, routed_mode: body.routed_mode ?? null,
        mode_coerced: body.mode_coerced ?? null, floor: body.floor ?? null, raced: body.raced ?? null,
        candidates: Array.isArray(body.candidates) ? body.candidates.map((c: any) => ({ id: c.id, provider: c.provider, kind: c.kind })) : [] };
    } catch (error) {
      return { payload, http: failure(error).http ?? null, error: failure(error).code,
        bound_mode: null, routed_mode: null, mode_coerced: null, floor: null, raced: null, candidates: [] };
    }
  }
  async chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], options: { maxTokens: number; route?: string }): Promise<{ text: string; receipt: Receipt }> {
    const config = readJson('config/budget.json');
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > Math.min(2000, config.maxTokensPerGeneration)) throw new SafeError('INVALID_MAX_TOKENS');
    const route = options.route ?? this.route;
    if (!route.startsWith('meterless/') || /(?:^|[/.])(?:local|fusion)(?:$|[/.])/.test(route)) throw new SafeError('FORBIDDEN_METERLESS_ROUTE');
    const policy = readJson<ModelPolicy>('config/model-policy.json');
    // Fail before reserving budget or making HTTP calls. A route name cannot
    // prevent an upstream override; leave dispatch blocked until human adjustment.
    assertGenerationAllowed(route, policy);
    const attempt = reserveGeneration(route);
    let receivedText: string | undefined;
    try {
      const response = await this.request('/chat/completions', { model: route, messages, max_tokens: options.maxTokens, stream: false });
      const text = response.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new SafeError('NO_GENERATED_TEXT');
      receivedText = text;
      const receiptId = response.meterless?.receipt_id;
      if (typeof receiptId !== 'string') throw new SafeError('RECEIPT_ID_MISSING');
      writeJson(`evidence/generation-${attempt.id}.json`, { utc: attempt.utc, attemptId: attempt.id, route, text, receiptId, status: 'TEXT_RECEIVED_RECEIPT_PENDING' });
      const receipt = resolveReceipt(await this.receipts(), receiptId);
      attempt.receipt = receipt;
      if (response.meterless?.from_cache || receipt.fromCache) throw new SafeError('CACHED_GENERATION_NOT_LIVE');
      assertEffectiveModel(receipt, policy);
      attempt.status = 'PASS'; attempt.receipt = receipt;
      writeJson(`evidence/generation-${attempt.id}.json`, { utc: attempt.utc, attemptId: attempt.id, route, text, receiptId, receipt, status: 'PASS' });
      finishAttempt(attempt); trace({ kind: 'nightshift', attemptId: attempt.id, status: 'PASS', route, ...receipt });
      return { text, receipt };
    } catch (error) {
      attempt.status = 'FAIL'; attempt.error = failure(error); finishAttempt(attempt);
      if (receivedText) writeJson(`evidence/generation-${attempt.id}.json`, { utc: attempt.utc, attemptId: attempt.id, route,
        text: receivedText, receipt: attempt.receipt, status: 'FAIL', error: attempt.error });
      const updatedPolicy = readJson('config/model-policy.json');
      updatedPolicy.generationBlocked = true; updatedPolicy.blockReason = failure(error).code;
      writeJson('config/model-policy.json', updatedPolicy);
      trace({ kind: 'nightshift', attemptId: attempt.id, status: 'FAIL', route, ...failure(error) });
      throw error;
    }
  }
}
