import { Nightshift } from './clients/nightshift.ts';
import { failure, readJson, stamp, writeJson } from './runtime.ts';

export function receiptSnapshot(body: any) {
  const rows = Array.isArray(body) ? body : body.data ?? body.receipts ?? [];
  return rows.map((e: any) => {
    const r = e.body?.receipt ?? e.receipt ?? e;
    return { receipt_id: r.receipt_id ?? null, request_id: r.request_id ?? null, created_at: r.created_at ?? null,
      app: r.app ?? null, status: r.status ?? null };
  });
}
export function hasHaiku(preview: any) {
  return preview.candidates.some((c: any) => typeof c.id === 'string' && /haiku/i.test(c.id) && c.provider === 'anthropic');
}
export function eligiblePreview(preview: any) {
  if (preview.http !== 200 || !racedAcceptedConstruction(preview) || preview.mode_coerced === true) return false;
  const requestedMode = preview.payload.mode;
  if (requestedMode && preview.bound_mode && preview.bound_mode !== requestedMode) return false;
  if (requestedMode && preview.routed_mode && preview.routed_mode !== requestedMode) return false;
  return true;
}
export function racedHaiku(preview: any): boolean {
  // A catalog candidate is insufficient: every actually raced id must map to
  // the Anthropic Haiku candidate. Reject mixed races and unknown providers.
  return Array.isArray(preview.raced) && preview.raced.length > 0 && preview.raced.every((id: unknown) =>
    typeof id === 'string' && /haiku/i.test(id) && preview.candidates.some((c: any) => c.id === id && c.provider === 'anthropic'));
}
export function racedAcceptedConstruction(preview: any): boolean {
  return Array.isArray(preview.raced) && preview.raced.length > 0 && preview.raced.every((id: unknown) =>
    typeof id === 'string' && /haiku|sonnet/i.test(id) && !/opus|fable/i.test(id) &&
    preview.candidates.some((c: any) => c.id === id && c.provider === 'anthropic'));
}
export async function routePreviews() {
  const n = new Nightshift();
  const consumedBefore = readJson('.concordia/budget.json').consumed;
  const before = receiptSnapshot(await n.receipts(5));
  const expectedLatest = 'chatcmpl-bf7af0f4-d5b2-4a32-a5ac-cb5f6eb1ea00';
  const previews: any[] = [];
  async function run(configuration: { mode?: string; model?: string }) {
    const result = { utc: new Date().toISOString(), ...await n.routePreview(configuration) };
    const file = `evidence/route-preview-${stamp()}.json`;
    writeJson(file, result); previews.push({ ...result, file });
    console.log(JSON.stringify({ file, ...result }));
    return result;
  }
  let endpointMissing = false;
  for (const mode of ['cheap', 'fast', 'auto']) {
    const result = await run({ mode });
    if (result.http === 404 || result.http === 405) { endpointMissing = true; break; }
  }
  if (!endpointMissing) {
    const model = 'claude-haiku-4-5-20251001';
    const result = await run({ model });
    if (result.http === 404 || result.http === 405) endpointMissing = true;
    else if (result.http === 400 || result.http === 422) {
      const fallback = await run({ mode: 'auto', model });
      if (fallback.http === 404 || fallback.http === 405) endpointMissing = true;
    }
    if (!endpointMissing && !previews.some(hasHaiku)) await run({ mode: 'deep' });
  }
  const after = receiptSnapshot(await n.receipts(5));
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const expectedLastReceipt = after[0]?.request_id === expectedLatest && after[0]?.status === 'failed';
  const consumedAfter = readJson('.concordia/budget.json').consumed;
  const selected = !endpointMissing && unchanged && expectedLastReceipt && consumedBefore === consumedAfter ? previews.find(eligiblePreview) : null;
  const summary = { utc: new Date().toISOString(), endpointMissing, previews, receiptsBefore: before, receiptsAfter: after,
    noNewReceipts: unchanged, lastStillExpectedFailure: expectedLastReceipt, consumedBefore, consumedAfter,
    selected: selected ?? null, decision: selected ? 'ACCEPTED_CONSTRUCTION_PREVIEW_NO_GENERATION' : 'STOP_NO_ACCEPTED_CONSTRUCTION_PREVIEW', generationsSent: 0 };
  writeJson('evidence/route-preview-summary.json', summary);
  console.log(JSON.stringify({ decision: summary.decision, noNewReceipts: unchanged, lastStillExpectedFailure: expectedLastReceipt, consumedBefore, consumedAfter }));
  return summary;
}
