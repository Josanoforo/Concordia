import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, SafeError } from '../runtime.ts';
import { resolveUniverseManifest } from '../registry/universes.ts';
import { isReviewMode, requiredReviewMode, type ReviewOrigin } from '../registry/review-mode.ts';
import { universeConfig, withReviewedRelations } from '../universe-pipeline.ts';

/**
 * F-04 review overlay: a separate file that carries a HUMAN review of relations for a universe whose config declares none (TPCDS, blind discovery).
 * The overlay never edits relations[] of the universe config. It is read ONLY when a caller names it (`--review <file>`), applied for that one call and then dropped,
 * so a run that does not name it stays blind. It fails closed: no approval block, no run.
 *
 * {
 *   "schemaVersion": 1, "universe": "TPCDS", "origin": "HUMAN_REVIEW" | "MODEL_REVIEW" | "SYNTHETIC_TEST",
 *   "approval": { "approver", "approvedAt", "quote" (verbatim), "session" },
 *   "relations": [ { "id", "from": {table, column}, "to": {table, column}, "kind": "FOREIGN_KEY", "reviewState": "REVIEWED", "identifierSpace",
 *                    "normalization", "normalizationVersion", "normalizationLossless": true, "normalizationAdapterCapability", "minDistinctKeys"? } ]
 * }
 */
export interface ReviewApproval { approver: string; approvedAt: string; quote: string; session: string }
export interface ReviewOverlay { schemaVersion: 1; universe: string; origin: 'HUMAN_REVIEW' | 'MODEL_REVIEW' | 'SYNTHETIC_TEST'; approval: ReviewApproval; relations: any[] }
/** The review origin a contract carries into claims and memory: a model overlay is MODEL_REVIEWED and never passes for human; a synthetic test overlay has none. */
export const reviewOriginOf = (origin: ReviewOverlay['origin']): ReviewOrigin | undefined => (origin === 'HUMAN_REVIEW' ? 'HUMAN_REVIEWED' : origin === 'MODEL_REVIEW' ? 'MODEL_REVIEWED' : undefined);
export interface ReviewIssue { path: string; code: string }
const REVIEW_ROOTS = [path.join(ROOT, 'universes', 'reviews'), path.join(ROOT, '.concordia')];
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const safeId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

/** Pure validation of an overlay against the allowlist of the universe's own config. */
export function validateReviewOverlay(overlay: unknown, universe: string, options: { allowSynthetic?: boolean } = {}): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return [{ path: 'overlay', code: 'REVIEW_OVERLAY_INVALID' }];
  const item = overlay as any, manifest = resolveUniverseManifest(universe);
  if (item.schemaVersion !== 1) issues.push({ path: 'overlay.schemaVersion', code: 'REVIEW_OVERLAY_INVALID' });
  if (!manifest || !manifest.aliases.includes(item.universe) || !manifest.aliases.some(alias => alias.toLowerCase() === universe.toLowerCase())) issues.push({ path: 'overlay.universe', code: 'REVIEW_UNIVERSE_MISMATCH' });
  if (!['HUMAN_REVIEW', 'MODEL_REVIEW', 'SYNTHETIC_TEST'].includes(item.origin)) issues.push({ path: 'overlay.origin', code: 'REVIEW_OVERLAY_INVALID' });
  else if (item.origin === 'SYNTHETIC_TEST' && !options.allowSynthetic) issues.push({ path: 'overlay.origin', code: 'REVIEW_SYNTHETIC_NOT_ALLOWED' });
  const approval = item.approval;
  if (!approval || typeof approval !== 'object' || !text(approval.approver, 120) || !text(approval.approvedAt, 40) || Number.isNaN(Date.parse(approval.approvedAt)) || !text(approval.quote, 600) || !text(approval.session, 200)) issues.push({ path: 'overlay.approval', code: 'REVIEW_APPROVAL_MISSING' });
  if (!Array.isArray(item.relations) || !item.relations.length) { issues.push({ path: 'overlay.relations', code: 'REVIEW_OVERLAY_INVALID' }); return issues; }
  let cfg: any; try { cfg = universeConfig(universe); } catch { return [...issues, { path: 'overlay.universe', code: 'REVIEW_UNIVERSE_MISMATCH' }]; }
  const modes = Object.keys(cfg.normalizationContract?.modes ?? {}), seen = new Set<string>();
  item.relations.forEach((relation: any, index: number) => {
    const here = `overlay.relations[${index}]`;
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) { issues.push({ path: here, code: 'REVIEW_RELATION_INVALID' }); return; }
    if (!safeId(relation.id) || seen.has(relation.id)) issues.push({ path: `${here}.id`, code: 'REVIEW_RELATION_INVALID' }); else seen.add(relation.id);
    for (const side of ['from', 'to'] as const) {
      const ref = relation[side], table = cfg.tables?.[ref?.table];
      if (!table || !(table.columns ?? []).some((column: any) => (typeof column === 'string' ? column : column?.name) === ref?.column)) issues.push({ path: `${here}.${side}`, code: 'REVIEW_RELATION_OUTSIDE_ALLOWLIST' });
    }
    if (relation.kind !== 'FOREIGN_KEY' || relation.reviewState !== 'REVIEWED' || !text(relation.identifierSpace, 120) || !modes.includes(relation.normalization) || !text(relation.normalizationVersion, 60)
      || relation.normalizationLossless !== true || !text(relation.normalizationAdapterCapability, 60) || (relation.minDistinctKeys !== undefined && (!Number.isInteger(relation.minDistinctKeys) || relation.minDistinctKeys < 1)) || (relation.reviewMode !== undefined && !isReviewMode(relation.reviewMode))) issues.push({ path: here, code: 'REVIEW_RELATION_INVALID' });
  });
  return issues;
}

/** Reads an overlay from an approved folder (universes/reviews or .concordia), as a regular non-symlink *.review.json file. Returns the parsed overlay and its sha256. */
export function readReviewOverlayFile(file: string): { overlay: unknown; sha256: string } {
  const resolved = path.resolve(ROOT, file);
  if (!/\.review\.json$/.test(resolved) || !REVIEW_ROOTS.some(root => path.relative(root, resolved) !== '' && !path.relative(root, resolved).startsWith('..') && !path.isAbsolute(path.relative(root, resolved)))) throw new SafeError('REVIEW_FILE_PATH_INVALID');
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new SafeError('REVIEW_FILE_PATH_INVALID');
  const bytes = fs.readFileSync(resolved);
  let overlay: unknown; try { overlay = JSON.parse(bytes.toString('utf8')); } catch { throw new SafeError('REVIEW_OVERLAY_INVALID'); }
  return { overlay, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * The relations of a validated overlay in the shape of a universe config, each carrying who approved it and the overlay's hash.
 * A relation of a HUMAN_REVIEW overlay that declares no mode requires HUMAN: it was reviewed by a human by construction, so a universe that asks for a model review (MODEL_ADVERSARIAL)
 * for its own candidates does not make the human contract unusable (act 3 with --review). The relation's own declaration still wins.
 */
export function reviewedRelations(overlay: ReviewOverlay, universe: string, sha256: string): any[] {
  const cfg = universeConfig(universe);
  return overlay.relations.map(relation => {
    const table = (ref: { table: string }) => cfg.tables[ref.table];
    return { id: relation.id, from: { db: table(relation.from).db ?? cfg.database, table: relation.from.table, column: relation.from.column }, to: { db: table(relation.to).db ?? cfg.database, table: relation.to.table, column: relation.to.column },
      normalization: relation.normalization, ...(relation.reviewMode !== undefined ? { reviewMode: relation.reviewMode } : overlay.origin === 'HUMAN_REVIEW' ? { reviewMode: 'HUMAN' } : {}), ...(relation.minDistinctKeys !== undefined ? { minDistinctKeys: relation.minDistinctKeys } : {}), reason: 'Human-reviewed foreign key (F-04 review overlay)',
      kind: relation.kind, reviewState: relation.reviewState, identifierSpace: relation.identifierSpace, normalizationVersion: relation.normalizationVersion, normalizationLossless: relation.normalizationLossless, normalizationAdapterCapability: relation.normalizationAdapterCapability,
      ...(reviewOriginOf(overlay.origin) ? { reviewOrigin: reviewOriginOf(overlay.origin) } : {}),
      reviewAuthorization: { ...overlay.approval, overlayOrigin: overlay.origin, overlaySha256: sha256 } };
  });
}

/**
 * Runs `fn` with the overlay's relations applied to the universe, and only for the duration of the call. Fails closed (REVIEW_APPROVAL_MISSING, REVIEW_RELATION_OUTSIDE_ALLOWLIST ...)
 * before anything runs. `allowSynthetic` exists for tests; the CLI never sets it, so a SYNTHETIC_TEST overlay cannot be mistaken for a real review.
 */
/** What the run records about the overlay in force (engine-run.reviewOverlay): taken from the overlay this call already validated, never re-read. negativeControl stays null until the live control run attaches its artifact. */
export interface ActiveReviewOverlay { origin: ReviewOverlay['origin']; sha256: string; file: string | null; approval: ReviewApproval & Record<string, unknown>; relations: string[]; deferred: { id: string; reason: string }[]; negativeControl: { artifact: string | null } }
const activeOverlays = new Map<string, ActiveReviewOverlay>();
/** The overlay in force for this universe inside the current withReviewOverlay call; undefined when none (a run without --review). */
export function activeReviewOverlay(universe: string): ActiveReviewOverlay | undefined {
  const manifest = resolveUniverseManifest(universe);
  const active = manifest ? activeOverlays.get(manifest.manifestId) : undefined;
  return active ? structuredClone(active) : undefined;
}

export async function withReviewOverlay<T>(universe: string, input: { file: string } | { overlay: unknown; sha256?: string }, fn: () => Promise<T>, options: { allowSynthetic?: boolean } = {}): Promise<T> {
  const { overlay, sha256 } = 'file' in input ? readReviewOverlayFile(input.file) : { overlay: input.overlay, sha256: input.sha256 ?? createHash('sha256').update(JSON.stringify(input.overlay)).digest('hex') };
  const issues = validateReviewOverlay(overlay, universe, options);
  if (issues.length) throw new SafeError(issues.find(issue => issue.code === 'REVIEW_APPROVAL_MISSING')?.code ?? issues[0].code, undefined, JSON.stringify(issues));
  // A model contract is never accepted where a human one is required (reviewMode HUMAN, the default): fail closed before anything runs.
  if ((overlay as ReviewOverlay).origin === 'MODEL_REVIEW') {
    const manifestForMode = resolveUniverseManifest(universe)!;
    if ((overlay as ReviewOverlay).relations.some(relation => requiredReviewMode(manifestForMode, String(relation.id), relation) === 'HUMAN')) throw new SafeError('REVIEW_MODEL_NOT_ACCEPTED_FOR_MODE');
  }
  const checked = overlay as ReviewOverlay & { deferred?: { id?: unknown; reason?: unknown }[] }, manifest = resolveUniverseManifest(universe)!;
  const block: ActiveReviewOverlay = { origin: checked.origin, sha256, file: 'file' in input ? path.relative(ROOT, path.resolve(ROOT, input.file)).split(path.sep).join('/') : null, approval: { ...checked.approval },
    relations: checked.relations.map(relation => String(relation.id)), deferred: (Array.isArray(checked.deferred) ? checked.deferred : []).map(item => ({ id: String(item?.id ?? ''), reason: String(item?.reason ?? '') })), negativeControl: { artifact: null } };
  return withReviewedRelations(universe, reviewedRelations(overlay as ReviewOverlay, universe, sha256), async () => {
    activeOverlays.set(manifest.manifestId, block);
    try { return await fn(); } finally { activeOverlays.delete(manifest.manifestId); }
  });
}
