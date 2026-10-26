import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, SafeError } from '../runtime.ts';
import type { ActiveReviewOverlay } from './review-overlay.ts';

/**
 * Act 3 negative control. A previous run produced `.concordia/agent-runs/<runId>/negative-control.json` (decoy relations that must NOT be in the human contract).
 * A review run may link it: the file is validated before the first SQL, copied into the new run as negative-control.json and recorded with its hash.
 * Nothing here interprets the decoys beyond "none of them is a contract relation".
 */
export const NEGATIVE_CONTROL_KIND = 'ACT3_NEGATIVE_CONTROL';
export const NEGATIVE_CONTROL_FILE = 'negative-control.json';
export interface NegativeControlRecord { artifact: typeof NEGATIVE_CONTROL_FILE; sourceRun: string; sha256: string; label: string | null }
export interface LoadedNegativeControl { record: NegativeControlRecord; bytes: Buffer }
const SOURCE = /^\.concordia\/agent-runs\/(agent-[a-z0-9][A-Za-z0-9._-]{0,48})\/negative-control\.json$/;
const endpointKey = (ref: any) => ref && typeof ref === 'object' ? `${ref.table}.${ref.column}` : '';

export function loadNegativeControl(file: string, input: { universeId: string; review: ActiveReviewOverlay | undefined; relations: readonly any[] }): LoadedNegativeControl {
  if (!input.review) throw new SafeError('NEGATIVE_CONTROL_REQUIRES_REVIEW');
  const resolved = path.resolve(ROOT, file), relative = path.relative(ROOT, resolved).split(path.sep).join('/');
  const match = SOURCE.exec(relative);
  if (!match || path.isAbsolute(relative)) throw new SafeError('NEGATIVE_CONTROL_PATH_INVALID');
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new SafeError('NEGATIVE_CONTROL_PATH_INVALID');
  const real = path.relative(fs.realpathSync(ROOT), fs.realpathSync(resolved));
  if (real.startsWith('..') || path.isAbsolute(real)) throw new SafeError('NEGATIVE_CONTROL_PATH_INVALID');
  const bytes = fs.readFileSync(resolved);
  let artifact: any; try { artifact = JSON.parse(bytes.toString('utf8')); } catch { throw new SafeError('NEGATIVE_CONTROL_INVALID'); }
  if (!artifact || typeof artifact !== 'object' || artifact.kind !== NEGATIVE_CONTROL_KIND || artifact.universe !== input.universeId || !Array.isArray(artifact.decoys)) throw new SafeError('NEGATIVE_CONTROL_INVALID');
  const contractIds = new Set(input.review.relations), contractEnds = new Set(input.relations.flatMap(relation => [`${endpointKey(relation.from)}>${endpointKey(relation.to)}`, `${endpointKey(relation.to)}>${endpointKey(relation.from)}`]));
  for (const decoy of artifact.decoys) {
    const id = typeof decoy === 'string' ? decoy : decoy?.id;
    const ends = decoy && typeof decoy === 'object' && decoy.from && decoy.to ? `${endpointKey(decoy.from)}>${endpointKey(decoy.to)}` : undefined;
    if ((typeof id === 'string' && contractIds.has(id)) || (ends !== undefined && contractEnds.has(ends))) throw new SafeError('NEGATIVE_CONTROL_DECOY_IN_CONTRACT');
  }
  return { bytes, record: { artifact: NEGATIVE_CONTROL_FILE, sourceRun: match[1], sha256: createHash('sha256').update(bytes).digest('hex'), label: typeof artifact.label === 'string' && artifact.label.length <= 200 ? artifact.label : null } };
}
