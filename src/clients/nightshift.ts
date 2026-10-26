import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { failure, jsonHttp, localUrl, readJson, required, ROOT, SafeError, trace, writeJson } from '../runtime.ts';
import { budgetFilePath, readBudget, writeBudget } from '../budget.ts';

export type Receipt = { receiptId: string; provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; latencyMs: number; fromCache: boolean; requestedMode?: string; routedMode?: string; modeCoerced?: boolean; boundMode?: string; predicted?: string | null; winner?: string | null; routingReason?: string | null; routingPolicy?: string | null; costUsd?: number };
export type CompletionMetadata = { finishReason?: string; stopReason?: string; truncated: boolean };
type Attempt = { id: string; utc: string; route: string; status: string; receipt?: Receipt; policyAlerts?: string[]; error?: object };
type Budget = { limit: null; consumed: number; attempts: Attempt[] };
export class NightshiftChatError extends SafeError {
  constructor(code: string, http: number | undefined, detail: string | undefined, retryAfter: string | undefined,
    readonly attemptId: string, readonly responseText?: string, readonly receipt?: Receipt, readonly receiptValidated = false, readonly finishReason?: string, readonly stopReason?: string, readonly responseTruncated = false) {
    super(code, http, detail, retryAfter);
    this.name = 'NightshiftChatError';
  }
}
export type ModelPolicy = { route: string; preferredProvider: string; preferredModelFamilies: string[]; watchModelFamilies: string[]; modelPolicy: 'observe_and_continue' };
export function assertGenerationAllowed(route: string, policy: ModelPolicy) {
  if (route !== policy.route) throw new SafeError('CONSTRUCTION_REQUIRES_CHEAP_ROUTE');
}
export function assertEffectiveModel(receipt: Receipt, policy: ModelPolicy): string[] {
  const model = receipt.model.toLowerCase();
  const alerts = policy.watchModelFamilies.filter(family => model.includes(family.toLowerCase())).map(family => `WATCHED_MODEL_FAMILY:${family.toLowerCase()}`);
  if (receipt.provider !== policy.preferredProvider) alerts.push('PROVIDER_NOT_PREFERRED');
  if (!policy.preferredModelFamilies.some(family => model.includes(family.toLowerCase()))) alerts.push('MODEL_NOT_PREFERRED');
  const requiredMode = policy.route.replace(/^meterless\//, '');
  if (receipt.requestedMode !== requiredMode || receipt.routedMode !== requiredMode || receipt.modeCoerced !== false) alerts.push('ROUTING_POLICY_DRIFT');
  return [...new Set(alerts)];
}
function receiptSummary(receipt: Receipt): Omit<Receipt, 'receiptId'> {
  const { receiptId: _receiptId, ...summary } = receipt;
  return summary;
}
// Record dispatch before HTTP. The user removed all generation-count ceilings
// and reserves on 2026-10-22; the continued ledger is telemetry, never a quota.
export function reserveGeneration(route: string, budgetDir?: string): Attempt {
  const file = budgetDir ? path.join(budgetDir, 'budget.json') : budgetFilePath();
  const stateDir = path.dirname(file);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = file + '.lock';
  let lock: number;
  try { lock = fs.openSync(lockPath, 'wx'); } catch { throw new SafeError('BUDGET_LOCKED'); }
  try {
    const state: Budget = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { limit: null, consumed: 0, attempts: [] };
    if (!Number.isInteger(state.consumed) || state.consumed < 0 || state.consumed !== state.attempts.length) throw new SafeError('INVALID_BUDGET_STATE');
    const attempt: Attempt = { id: randomUUID(), utc: new Date().toISOString(), route, status: 'RESERVED' };
    state.limit = null; state.consumed++; state.attempts.push(attempt);
    const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(state, null, 2)); fs.renameSync(temp, file);
    return attempt;
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
function finishAttempt(attempt: Attempt) {
  const state: Budget = readBudget();
  const index = state.attempts.findIndex(a => a.id === attempt.id);
  if (index < 0) throw new SafeError('BUDGET_ATTEMPT_MISSING');
  state.attempts[index] = attempt;
  writeBudget(state);
  writeJson('evidence/generations.json', { ...state, attempts: state.attempts.map(({ receipt, ...saved }) => ({ ...saved, ...(receipt ? { receipt: receiptSummary(receipt) } : {}) })) });
}
export function normalizeBase(value: string): string {
  const url = localUrl(value.includes('://') ? value : 'http://' + value);
  return url.replace(/\/(?:v1(?:\/(?:chat\/completions|models))?|healthz)$/, '') + '/v1';
}
export function extractCompletionMetadata(response: any): CompletionMetadata {
  const finishReason = typeof response?.choices?.[0]?.finish_reason === 'string' ? response.choices[0].finish_reason : undefined;
  const choiceStopReason = response?.choices?.[0]?.stop_reason;
  const stopReason = typeof response?.stop_reason === 'string' ? response.stop_reason : typeof choiceStopReason === 'string' ? choiceStopReason : undefined;
  const truncated = [finishReason, stopReason].some(reason => typeof reason === 'string' && /(?:length|max[_-]?tokens?|max[_-]?output[_-]?tokens?|token[_-]?limit)/i.test(reason));
  return { ...(finishReason ? { finishReason } : {}), ...(stopReason ? { stopReason } : {}), truncated };
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
  const costUsd = [usage?.cost_usd, receipt.cost_usd].find(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? receipt.input_tokens;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? receipt.output_tokens;
  const latencyMs = usage?.latency_ms ?? receipt.latency_ms ?? receipt.duration_ms ?? row.latency_ms;
  if (typeof provider !== 'string' || typeof model !== 'string' || ![inputTokens, outputTokens, latencyMs].every(v => typeof v === 'number' && v >= 0)) throw new SafeError('RECEIPT_METADATA_INCOMPLETE');
  const cacheStatus = receipt.cache?.status;
  const fromCache = Boolean(receipt.from_cache ?? row.from_cache ?? (typeof cacheStatus === 'string' && /^(hit|cached)$/i.test(cacheStatus)));
  return { receiptId, provider, model, inputTokens, outputTokens, totalTokens: usage?.total_tokens ?? inputTokens + outputTokens, latencyMs, fromCache,
    requestedMode: receipt.app_policy?.requested_mode, routedMode: receipt.app_policy?.routed_mode, modeCoerced: receipt.app_policy?.mode_coerced, boundMode: receipt.app_policy?.bound_mode,
    predicted: receipt.routing?.predicted ?? null, winner: receipt.routing?.winner ?? null,
    routingReason: receipt.routing?.reason ?? null, routingPolicy: receipt.routing?.policy ?? null, ...(costUsd !== undefined ? { costUsd } : {}) };
}
export class Nightshift {
  readonly route: string; private base: string; private token: string;
  constructor(options?: { base: string; token: string; route: string }) {
    this.base = normalizeBase(options?.base ?? required('METERLESS_BASE_URL'));
    this.token = options?.token ?? required('METERLESS_RUNTIME_TOKEN');
    this.route = options?.route ?? required('METERLESS_MODEL');
    if (!this.route.startsWith('meterless/') || /(?:^|[/.])(?:local|fusion)(?:$|[/.])/.test(this.route)) throw new SafeError('FORBIDDEN_METERLESS_ROUTE');
  }
  private requestWithStatus(path: string, body?: unknown, app = 'concordia', timeoutMs = 180_000) {
    return jsonHttp(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'meterless-app': app, 'meterless-scope': 'user', 'meterless-tier-split': 'off' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, timeoutMs);
  }
  private async request(path: string, body?: unknown) { return (await this.requestWithStatus(path, body)).body; }
  async models(): Promise<string[]> {
    const result = await this.request('/models');
    if (!Array.isArray(result.data)) throw new SafeError('MODELS_RESPONSE_SHAPE');
    return result.data.map((r: any) => r.id).filter((id: unknown): id is string => typeof id === 'string');
  }
  /** Reachability only: GET /models with a short timeout. No generation, no ledger entry. Throws the transport/HTTP failure. */
  async ping(timeoutMs = 5000): Promise<void> { await this.requestWithStatus('/models', undefined, 'concordia', timeoutMs); }
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
  async chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], options: { maxTokens: number; route?: string; preserveTextOnFailure?: boolean; responseFormat?: object; tools?: object[]; toolChoice?: object }): Promise<{ text: string; receipt: Receipt; policyAlerts: string[]; toolCall?: { name: string } } & CompletionMetadata> {
    const config = readJson('config/budget.json');
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > Math.min(3000, config.maxTokensPerGeneration)) throw new SafeError('INVALID_MAX_TOKENS');
    const route = options.route ?? this.route;
    if (!route.startsWith('meterless/') || /(?:^|[/.])(?:local|fusion)(?:$|[/.])/.test(route)) throw new SafeError('FORBIDDEN_METERLESS_ROUTE');
    const policy = readJson<ModelPolicy>('config/model-policy.json');
    // Keep cheap as the requested route. Model/provider differences are telemetry,
    // not a dispatch or post-receipt gate.
    assertGenerationAllowed(route, policy);
    const attempt = reserveGeneration(route);
    let receivedText: string | undefined;
    let completion: CompletionMetadata = { truncated: false };
    try {
      // Optional structured-output fields are appended only when passed: without them the body is exactly what it always was.
      const body = { model: route, messages, max_tokens: options.maxTokens, stream: false,
        ...(options.responseFormat ? { response_format: options.responseFormat } : {}), ...(options.tools ? { tools: options.tools } : {}), ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}) };
      const response = await this.request('/chat/completions', body);
      completion = extractCompletionMetadata(response);
      const message = response.choices?.[0]?.message;
      const call = Array.isArray(message?.tool_calls) ? message.tool_calls[0]?.function : undefined;
      const toolCall = call && typeof call.arguments === 'string' ? { name: String(call.name ?? '') } : undefined;
      const text = toolCall ? call.arguments : message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new SafeError('NO_GENERATED_TEXT');
      receivedText = text;
      const receiptId = response.meterless?.receipt_id;
      if (typeof receiptId !== 'string') throw new SafeError('RECEIPT_ID_MISSING');
      writeJson(`evidence/generation-${attempt.id}.json`, { utc: attempt.utc, attemptId: attempt.id, route, status: 'TEXT_RECEIVED_RECEIPT_PENDING', responsePresent: true, receiptObserved: true });
      const receipt = resolveReceipt(await this.receipts(), receiptId);
      attempt.receipt = receipt;
      if (response.meterless?.from_cache || receipt.fromCache) throw new SafeError('CACHED_GENERATION_NOT_LIVE');
      const policyAlerts = assertEffectiveModel(receipt, policy);
      attempt.policyAlerts = policyAlerts;
      attempt.status = policyAlerts.length ? 'PASS_WITH_POLICY_ALERT' : 'PASS';
      writeJson(`evidence/generation-${attempt.id}.json`, { utc: attempt.utc, attemptId: attempt.id, route, responsePresent: true, receiptObserved: true, receipt: receiptSummary(receipt), policyAlerts, status: attempt.status });
      finishAttempt(attempt); trace({ kind: 'nightshift', attemptId: attempt.id, status: attempt.status, route, ...receiptSummary(receipt), policyAlerts });
      return { text, receipt, policyAlerts, ...(toolCall ? { toolCall } : {}), ...completion };
    } catch (error) {
      attempt.status = 'FAIL'; attempt.error = failure(error); finishAttempt(attempt);
      if (receivedText) writeJson('evidence/generation-' + attempt.id + '.json', { utc: attempt.utc, attemptId: attempt.id, route,
        responsePresent: true, receiptObserved: Boolean(attempt.receipt), ...(attempt.receipt ? { receipt: receiptSummary(attempt.receipt) } : {}), ...(options.preserveTextOnFailure ? { generatedText: receivedText } : {}), status: 'FAIL', error: attempt.error });
      trace({ kind: 'nightshift', attemptId: attempt.id, status: 'FAIL', route, ...failure(error) });
      if (options.preserveTextOnFailure) { const diagnostic = failure(error); throw new NightshiftChatError(diagnostic.code, diagnostic.http, diagnostic.detail, diagnostic.retryAfter, attempt.id, receivedText, attempt.receipt, Boolean(attempt.receipt), completion.finishReason, completion.stopReason, completion.truncated); }
      throw error;
    }
  }
}
