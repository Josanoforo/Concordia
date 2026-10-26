import path from 'node:path';
import { ROOT, SafeError } from '../runtime.ts';
import { exportOdcs, exportUslOdcs } from '../export/odcs.ts';
import { exportNegativeDossier } from '../export/negative-dossier.ts';

const inside = (parent: string, child: string) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** `--out` must stay inside the repo (or the run directory, which lives in it); anything else is OUT_PATH_INVALID. */
export function resolveExportOut(out: string | undefined): string | undefined {
  if (out === undefined) return undefined;
  if (!out || out.includes('\0')) throw new SafeError('OUT_PATH_INVALID');
  const resolved = path.resolve(ROOT, out);
  if (!inside(ROOT, resolved)) throw new SafeError('OUT_PATH_INVALID');
  return resolved;
}

export function exportNegativeCommand(runId: string | undefined, out: string | undefined, runsDir?: string) {
  if (!runId) throw new SafeError('AGENT_RUN_ID_REQUIRED');
  const resolved = resolveExportOut(out);
  try {
    const result = exportNegativeDossier({ runId, ...(resolved ? { out: resolved } : {}), ...(runsDir ? { runsDir } : {}) });
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    if (error instanceof SafeError && /^NEGATIVE_DOSSIER_(INVALID_RUN_ID|RUN_NOT_FOUND)$/.test(error.message)) throw new SafeError(error.message.replace(/^NEGATIVE_DOSSIER_/, ''));
    throw error;
  }
}

/** `--out` here is the contract FILE (default: <runDir>/contract.odcs.yaml). */
export function exportOdcsCommand(runId: string | undefined, out: string | undefined, runsDir?: string) {
  if (!runId) throw new SafeError('AGENT_RUN_ID_REQUIRED');
  const resolved = resolveExportOut(out);
  try {
    const result = exportOdcs({ runId, ...(resolved ? { out: resolved } : {}) }, runsDir ? { runsDir } : {});
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    if (error instanceof SafeError && /^(INVALID_RUN_ID|AGENT_RUN_NOT_FOUND)$/.test(error.message)) throw new SafeError(error.message === 'INVALID_RUN_ID' ? 'INVALID_RUN_ID' : 'RUN_NOT_FOUND');
    throw error;
  }
}

/** USL plan to ODCS. Without --out the file lands next to the plan, and that place must also be inside the repo. */
export function exportUslOdcsCommand(opts: { plan?: string; run?: string; grant?: string; out?: string }) {
  if (!opts.plan) throw new SafeError('USL_PLAN_NOT_FOUND');
  const plan = path.resolve(opts.plan);
  const out = resolveExportOut(opts.out) ?? (inside(ROOT, path.dirname(plan)) ? undefined : (() => { throw new SafeError('OUT_PATH_INVALID'); })());
  const result = exportUslOdcs({ plan, ...(opts.run ? { run: path.resolve(opts.run) } : {}), ...(opts.grant ? { grant: path.resolve(opts.grant) } : {}), ...(out ? { out } : {}) });
  console.log(JSON.stringify(result));
  return result;
}
