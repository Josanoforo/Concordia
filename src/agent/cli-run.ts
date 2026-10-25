import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTokenCapOverride } from './run-budget.ts';
import { readBudget } from '../budget.ts';
import { Nightshift } from '../clients/nightshift.ts';
import { Zetaris } from '../clients/zetaris.ts';
import { createInstalledComaBridge } from '../discovery/coma-provider.ts';
import { resolveUniverseManifest } from '../registry/universes.ts';
import { failure, loadLocalEnv, ROOT, SafeError } from '../runtime.ts';
import { universeConfig } from '../universe-pipeline.ts';
import { catalogOf } from './catalog.ts';
import { GENERIC_CODE_PREFIX, NightshiftChooser, type ActionChooser, type ChoiceCall } from './chooser.ts';
import { agentFixtures } from '../eval/agent-eval.ts';
import { fixtureClient } from '../eval/fixture-client.ts';
import { runAgent } from './engine.ts';
import { continueAgentExploration } from './continuation.ts';

/** The probe-ranking chooser is the exploration chooser only when the run opts in with --probe-model; otherwise probes are all-affordable and cost no generation. */
export function probeChooserFor<T>(chooser: T | undefined, argv: readonly string[], explicit?: boolean): T | undefined {
  return (explicit ?? argv.includes('--probe-model')) ? chooser : undefined;
}

/** `concordia agent --universe <id>`: the product's single agent path for any registered AGENT_EXPLORATION universe. */
export async function runAgentCommand(universe: string, options: { runId?: string; model: boolean; coma: boolean; probeModel?: boolean; maxTokens?: number; memory?: boolean }) {
  setTokenCapOverride(options.maxTokens);
  // Model ranking of probes costs one generation per chosen probe; it is opt-in (--probe-model) and off by default.
  const manifest = resolveUniverseManifest(universe);
  if (!manifest) throw new SafeError('INVALID_UNIVERSE');
  // R-03: a local-files universe has no remote source and no model: it always runs over its own rows, never reads .env or the ledger.
  if (manifest.source.adapterId === 'local-files') return runOfflineAgentCommand(universe, { runId: options.runId, memory: options.memory });
  loadLocalEnv();
  const runId = options.runId ?? `agent-${manifest.aliases[0].toLowerCase()}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const catalog = catalogOf(universeConfig(universe));
  let chooser: NightshiftChooser | undefined, plannerError: object | undefined;
  if (options.model && catalog) {
    try { chooser = new NightshiftChooser(new Nightshift(), runId, catalog, GENERIC_CODE_PREFIX); } catch (error) { plannerError = failure(error); }
  }
  const python = path.join(ROOT, '.concordia', 'python', 'coma-valentine-1.1.0', 'Scripts', 'python.exe');
  const comaBridge = options.coma && fs.existsSync(python) ? createInstalledComaBridge(python, ROOT) : undefined;
  const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const before = readBudget(), beforePrefix = sha(before.attempts);
  const report = await runAgent(universe, runId, { client: new Zetaris(), chooser, probeChooser: probeChooserFor(chooser, process.argv, options.probeModel), comaBridge, executionMode: 'LIVE', memory: options.memory });
  const after = readBudget();
  const ledger = { attemptsBefore: before.consumed, attemptsAfter: after.consumed, attemptsAdded: after.consumed - before.consumed, priorAttemptsPreserved: sha(after.attempts.slice(0, before.attempts.length)) === beforePrefix };
  const summary = { status: report.status, runId, universeId: report.universeId, report: `.concordia/agent-runs/${runId}/engine-run.json`, probes: report.phases?.probes?.selected ?? [], probeSelection: report.probeSelection?.mode ?? null, probeModelRanking: report.probeSelection?.modelRanking ?? null,
    decisions: report.decisions ?? [], budget: report.budget, ledger, plannerError: plannerError ?? null };
  console.log(JSON.stringify(summary));
  process.exitCode = report.status === 'COMPLETED' && ledger.priorAttemptsPreserved ? 0 : 1;
  return summary;
}

/** concordia agent continue --universe ID --run-id RUN: the single compact retry of a stopped exploration (one model generation). */
export async function continueAgentCommand(universe: string, runId: string, attempt = 1, maxTokens?: number) {
  setTokenCapOverride(maxTokens);
  const manifest = resolveUniverseManifest(universe);
  if (!manifest) throw new SafeError('INVALID_UNIVERSE');
  loadLocalEnv();
  const catalog = catalogOf(universeConfig(universe));
  if (!catalog) throw new SafeError('EXPLORATION_CATALOG_REQUIRED');
  const record = await continueAgentExploration(universe, runId, { client: new Zetaris(), chooser: new NightshiftChooser(new Nightshift(), runId, catalog, GENERIC_CODE_PREFIX) }, attempt);
  console.log(JSON.stringify(record));
  process.exitCode = record.outcome === 'COMPLETED' && record.ledger.priorAttemptsPreserved ? 0 : 1;
  return record;
}

/** Replays the fixture's declared id script, then stops; it can only pick permitted ids. Offline stand-in for the model. */
class FixtureScriptChooser implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _observation: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION';
    const selected = allowed.includes(next) ? next : undefined;
    return { stage, status: 'PASS', decisionStatus: selected ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'fixture-script', selected, reason: 'fixture script choice', promptHash: 'fixture', utc: new Date().toISOString() };
  }
}

/** `concordia agent --universe <id> --offline`: the same loop over the universe's synthetic fixture. No model, no network, no .env, no budget ledger. */
export async function runOfflineAgentCommand(universe: string, options: { runId?: string; memory?: boolean }) {
  const manifest = resolveUniverseManifest(universe);
  if (!manifest) throw new SafeError('INVALID_UNIVERSE');
  const fixture = agentFixtures().find(item => manifest.aliases.some(alias => alias.toUpperCase() === item.alias.toUpperCase()));
  if (!fixture) throw new SafeError('NO_OFFLINE_FIXTURE');
  const runId = options.runId ?? `agent-${manifest.aliases[0].toLowerCase()}-offline-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const report = await runAgent(universe, runId, { client: fixtureClient(universeConfig(universe), fixture.tables) as any, chooser: new FixtureScriptChooser([...fixture.chooserScript]), memory: options.memory, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', critic: true });
  const summary = { status: report.status, runId, universeId: report.universeId, mode: 'OFFLINE_FIXTURE', dataOrigin: 'SYNTHETIC', report: `.concordia/agent-runs/${runId}/engine-run.json`, probes: report.phases?.probes?.selected ?? [], decisions: report.decisions ?? [], budget: report.budget };
  console.log(JSON.stringify(summary));
  process.exitCode = report.status === 'COMPLETED' ? 0 : 1;
  return summary;
}
