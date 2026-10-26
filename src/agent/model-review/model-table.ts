/**
 * Round 10 E5-07: one row per role (judge-a, judge-b, ..., adversary) with the model id that the receipts report (not the alias that was asked for: live-01 saw one alias answer with
 * two different models) and the call counts. Built from the review records alone, so a report never has to join against the trace.
 */
import type { CallRecord, ModelDrift, ModelReview, ModelRoleRow } from './types.ts';

export interface RoleModel { readonly id: string; readonly requestedModel?: string }
export const judgeRole = (index: number) => `judge-${String.fromCharCode(97 + index)}`;

export function buildModelTable(reviews: readonly ModelReview[], judges: readonly RoleModel[], adversary: RoleModel): ModelRoleRow[] {
  const blank = (role: string, model: RoleModel): ModelRoleRow => ({ role, actor: model.id, ...(model.requestedModel ? { requestedModel: model.requestedModel } : {}), models: [], drift: [], calls: 0, invalid: 0, callFailed: 0, truncated: 0, normalizedCalls: 0, skippedBudget: 0, skippedByCascade: 0, tokens: 0, inputTokens: 0, outputTokens: 0 });
  const rows = [...judges.map((judge, index) => blank(judgeRole(index), judge)), blank('adversary', adversary)];
  const seen = rows.map(() => new Map<string, number>());
  const add = (rowIndex: number, status: string, call: CallRecord | undefined) => {
    const row = rows[rowIndex]!;
    if (status === 'INVALID') row.invalid++;
    if (status === 'CALL_FAILED') row.callFailed++;
    if (call?.status === 'SKIPPED_BUDGET' || status === 'SKIPPED_BUDGET') row.skippedBudget++;
    if (call?.status === 'SKIPPED_BY_CASCADE' || status === 'SKIPPED_BY_CASCADE') row.skippedByCascade++;
    if (call?.status !== 'PASS' && call?.status !== 'FAIL') return;
    row.calls++;
    if (call.truncated) row.truncated++;
    if (call.normalized?.length) row.normalizedCalls++;
    row.tokens += call.tokens;
    if (call.receipt) { row.inputTokens += call.receipt.inputTokens; row.outputTokens += call.receipt.outputTokens; seen[rowIndex]!.set(call.receipt.model, (seen[rowIndex]!.get(call.receipt.model) ?? 0) + 1); }
  };
  for (const review of reviews) {
    review.evaluations.forEach((evaluation, index) => { if (index < judges.length) add(index, evaluation.status, evaluation.call); });
    if (review.adversary.status !== 'NOT_NEEDED') add(judges.length, review.adversary.status, review.adversary.call);
  }
  rows.forEach((row, index) => {
    row.models = [...seen[index]!].map(([model, calls]) => ({ model, calls })).sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
    // C4: the route (`meterless/cheap`) is an alias; the dominant model is the role's effective one and the rest is drift, recorded and not corrected.
    if (row.models[0]) row.effectiveModel = row.models[0].model;
    row.drift = row.models.slice(1);
  });
  return rows;
}

/** C4: the drift of the route over the whole review, from the table alone. Pinning a model per role would remove it; it is proposed, not active. */
export function buildModelDrift(table: readonly ModelRoleRow[]): ModelDrift {
  const totals = new Map<string, number>();
  for (const row of table) for (const entry of row.models) totals.set(entry.model, (totals.get(entry.model) ?? 0) + entry.calls);
  const models = [...totals].map(([model, calls]) => ({ model, calls })).sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
  const receiptCalls = models.reduce((sum, entry) => sum + entry.calls, 0), driftedCalls = table.reduce((sum, row) => sum + row.drift.reduce((inner, entry) => inner + entry.calls, 0), 0);
  return {
    homogeneous: models.length <= 1, models, driftedCalls, receiptCalls,
    perRole: table.map(row => ({ role: row.role, ...(row.requestedModel ? { requestedModel: row.requestedModel } : {}), ...(row.effectiveModel ? { effectiveModel: row.effectiveModel } : {}), calls: row.calls, drifted: row.drift })),
    pinned: false
  };
}
