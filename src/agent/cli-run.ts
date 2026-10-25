import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readBudget } from '../budget.ts';
import { Nightshift } from '../clients/nightshift.ts';
import { Zetaris } from '../clients/zetaris.ts';
import { createInstalledComaBridge } from '../discovery/coma-provider.ts';
import { resolveUniverseManifest } from '../registry/universes.ts';
import { failure, loadLocalEnv, ROOT, SafeError } from '../runtime.ts';
import { universeConfig } from '../universe-pipeline.ts';
import { catalogOf } from './catalog.ts';
import { NightshiftChooser } from './chooser.ts';
import { runAgent } from './engine.ts';

/** `concordia agent --universe <id>`: the product's single agent path for any registered AGENT_EXPLORATION universe. */
export async function runAgentCommand(universe: string, options: { runId?: string; model: boolean; coma: boolean }) {
  const manifest = resolveUniverseManifest(universe);
  if (!manifest) throw new SafeError('INVALID_UNIVERSE');
  loadLocalEnv();
  const runId = options.runId ?? `agent-${manifest.aliases[0].toLowerCase()}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const catalog = catalogOf(universeConfig(universe));
  let chooser: NightshiftChooser | undefined, plannerError: object | undefined;
  if (options.model && catalog) {
    try { chooser = new NightshiftChooser(new Nightshift(), runId, catalog); } catch (error) { plannerError = failure(error); }
  }
  const python = path.join(ROOT, '.concordia', 'python', 'coma-valentine-1.1.0', 'Scripts', 'python.exe');
  const comaBridge = options.coma && fs.existsSync(python) ? createInstalledComaBridge(python, ROOT) : undefined;
  const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const before = readBudget(), beforePrefix = sha(before.attempts);
  const report = await runAgent(universe, runId, { client: new Zetaris(), chooser, comaBridge, executionMode: 'LIVE' });
  const after = readBudget();
  const ledger = { attemptsBefore: before.consumed, attemptsAfter: after.consumed, attemptsAdded: after.consumed - before.consumed, priorAttemptsPreserved: sha(after.attempts.slice(0, before.attempts.length)) === beforePrefix };
  const summary = { status: report.status, runId, universeId: report.universeId, report: `.concordia/agent-runs/${runId}/engine-run.json`, probes: report.phases?.probes?.selected ?? [],
    decisions: report.decisions ?? [], budget: report.budget, ledger, plannerError: plannerError ?? null };
  console.log(JSON.stringify(summary));
  process.exitCode = report.status === 'COMPLETED' && ledger.priorAttemptsPreserved ? 0 : 1;
  return summary;
}
