import fs from 'node:fs';
import path from 'node:path';
import type { ReviewDecisionClaim, ReviewDecisionMemory, ReviewDecisionRecord } from './model-review-contract.ts';
import { resolveMemoryScope, type MemoryOrigin } from './memory.ts';

/**
 * N2: negative memory of the model review. A reject or defer of the review is remembered per relation, keyed by the fingerprint of what the prompt saw and the prompt version,
 * so a later pass does not pay for the same "no" again. It lives in `<scope>/review-decisions.jsonl`, an append-only ledger OUTSIDE the Reconciler claims: it is never a
 * `status` claim, so it can never read as an approval, never produce SOSTENIDA, never fill a HUMAN slot and never appear in the warm start `reused`. The scope seal
 * (execution mode + data origin) applies as for every claim: an entry stamped with another origin is ignored.
 */
export const REVIEW_DECISIONS_FILE = 'review-decisions.jsonl';

interface LedgerEntry {
  schemaVersion: 1; relationId: string; decision: 'reject' | 'defer' | 'approve'; reasons: string[]; evidenceFingerprint: string; promptVersion: string; models: string[];
  runId: string; origin: 'MODEL_REVIEWED'; executionMode: string; dataOrigin: string; recordedAt: string;
}
export interface ReviewDecisionStats { reused: number; recorded: number; invalidated: number; reusedIds: string[]; invalidatedIds: string[] }

function readLedger(file: string): LedgerEntry[] {
  if (!fs.existsSync(file)) return [];
  const entries: LedgerEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const item = JSON.parse(line); if (item && typeof item.relationId === 'string' && typeof item.evidenceFingerprint === 'string' && typeof item.promptVersion === 'string') entries.push(item as LedgerEntry); } catch { /* a torn line is history we cannot trust: skipped */ }
  }
  return entries;
}

/**
 * The object the engine hands to the review. `lookup` answers only the LATEST entry of the relation, and only when fingerprint and prompt version both match and it is a reject/defer;
 * anything else is a miss (a changed fingerprint or version counts the relation as invalidated: the old entry stays as history). `record` appends and never rewrites.
 */
export function createReviewDecisionMemory(input: { universeId: string; dir: string; origin: MemoryOrigin; runId: string; now: () => string }): ReviewDecisionMemory & { approve(relationIds: string[]): void; stats(): ReviewDecisionStats } {
  const file = path.join(input.dir, REVIEW_DECISIONS_FILE);
  const stats: ReviewDecisionStats = { reused: 0, recorded: 0, invalidated: 0, reusedIds: [], invalidatedIds: [] };
  const mine = (entry: LedgerEntry) => entry.executionMode === input.origin.executionMode && entry.dataOrigin === input.origin.dataOrigin && entry.origin === 'MODEL_REVIEWED';
  const latest = (): Map<string, LedgerEntry> => { const map = new Map<string, LedgerEntry>(); for (const entry of readLedger(file)) if (mine(entry)) map.set(entry.relationId, entry); return map; };
  const append = (entries: LedgerEntry[]) => {
    if (!entries.length) return;
    resolveMemoryScope(input.universeId, { dir: input.dir, origin: input.origin }, true);
    fs.mkdirSync(input.dir, { recursive: true });
    fs.appendFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  };
  const stamp = (relationId: string, decision: LedgerEntry['decision'], rest: Partial<LedgerEntry>): LedgerEntry => ({ schemaVersion: 1, relationId, decision, reasons: [], evidenceFingerprint: '', promptVersion: '', models: [], runId: input.runId, origin: 'MODEL_REVIEWED', executionMode: input.origin.executionMode, dataOrigin: input.origin.dataOrigin, recordedAt: input.now(), ...rest });
  return {
    lookup(relationId, evidenceFingerprint, promptVersion): ReviewDecisionClaim | null {
      const entry = latest().get(relationId);
      if (!entry || entry.decision === 'approve') return null;
      if (entry.evidenceFingerprint !== evidenceFingerprint || entry.promptVersion !== promptVersion) { if (!stats.invalidatedIds.includes(relationId)) { stats.invalidated++; stats.invalidatedIds.push(relationId); } return null; }
      if (!stats.reusedIds.includes(relationId)) { stats.reused++; stats.reusedIds.push(relationId); }
      const { decision, reasons, models, runId, recordedAt } = entry;
      return { relationId, decision: decision as 'reject' | 'defer', reasons: [...reasons], evidenceFingerprint, promptVersion, models: [...models], runId, origin: 'MODEL_REVIEWED', recordedAt };
    },
    record(decisions: ReviewDecisionRecord[]) {
      const current = latest(), fresh: LedgerEntry[] = [];
      for (const item of decisions) {
        if ((item.decision !== 'reject' && item.decision !== 'defer') || !item.relationId || !item.evidenceFingerprint || !item.promptVersion) continue;
        const before = current.get(item.relationId);
        if (before && before.decision === item.decision && before.evidenceFingerprint === item.evidenceFingerprint && before.promptVersion === item.promptVersion && before.reasons.join('|') === (item.reasons ?? []).join('|')) continue;
        const entry = stamp(item.relationId, item.decision, { reasons: [...(item.reasons ?? [])], evidenceFingerprint: item.evidenceFingerprint, promptVersion: item.promptVersion, models: [...(item.models ?? [])] });
        fresh.push(entry); current.set(item.relationId, entry);
      }
      append(fresh); stats.recorded += fresh.length;
    },
    /** A later approval retires the relation's remembered "no" (a stale reject must not come back if the old evidence does). The marker is internal: lookup never returns it. */
    approve(relationIds: string[]) {
      const current = latest(), fresh = relationIds.filter(id => current.get(id) && current.get(id)!.decision !== 'approve').map(id => stamp(id, 'approve', {}));
      append(fresh);
    },
    stats: () => ({ ...stats, reusedIds: [...stats.reusedIds], invalidatedIds: [...stats.invalidatedIds] }),
  };
}

/** Read-only view for reports and tests: every entry of the ledger (history included). */
export const readReviewDecisionLedger = (dir: string): LedgerEntry[] => readLedger(path.join(dir, REVIEW_DECISIONS_FILE));
