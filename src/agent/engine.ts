import fs from 'node:fs';
import path from 'node:path';
import type { Zetaris } from '../clients/zetaris.ts';
import { criticize } from '../critic/adversarial.ts';
import type { ComaBridge } from '../discovery/coma-provider.ts';
import { resolveUniverseManifest, type UniverseManifest } from '../registry/universes.ts';
import { failure, readJson, ROOT, SafeError, setTraceRun, trace, writeJson } from '../runtime.ts';
import { discoverUniverse, probeUniverse, universeConfig } from '../universe-pipeline.ts';
import { catalogOf, type ExplorationCatalog } from './catalog.ts';
import type { ActionChooser } from './chooser.ts';
import { runComaPhase, type ComaPhaseResult } from './coma-input.ts';
import { runExploration, type ExplorationResult } from './exploration.ts';
import { selectProbes, type ProbeSelection } from './probe-selector.ts';
import { budgetedClient, limitsFromBounds, RunBudget } from './run-budget.ts';

export const AGENT_RUN_ID = /^agent-[a-z0-9][A-Za-z0-9._-]{0,48}$/;
type Mode = 'LIVE' | 'REPLAY' | 'LOCAL';
type AgentClient = Pick<Zetaris, 'describe' | 'runSql'>;

export interface AgentDeps {
  client: AgentClient;
  /** Chooses exploration actions; absent means no adaptive reads (recorded, never silently skipped). */
  chooser?: ActionChooser;
  /** Optional model-driven probe ranking; absent means every affordable configured relation is probed. */
  probeChooser?: ActionChooser;
  comaBridge?: ComaBridge;
  executionMode?: Mode;
  /** Label for the data actually read (e.g. SYNTHETIC for offline fixtures); defaults to the manifest's origin. */
  dataOrigin?: AgentContext['dataOrigin'];
  now?: () => string;
  critic?: boolean;
  persist?: boolean;
}

/** Everything a phase needs; built once per run from the registry manifest, never from the model. */
export interface AgentContext {
  universeId: string; manifest: UniverseManifest; cfg: any; catalog: ExplorationCatalog; budget: RunBudget; client: AgentClient;
  executionMode: Mode; dataOrigin: 'UNKNOWN' | 'PUBLIC' | 'USER' | 'SYNTHETIC'; runId: string; prefix: string; persist: boolean;
}

export function prepareAgentContext(universe: string, runId: string, deps: Pick<AgentDeps, 'client' | 'executionMode' | 'dataOrigin' | 'persist'>): AgentContext {
  if (!AGENT_RUN_ID.test(runId)) throw new SafeError('AGENT_RUN_ID_INVALID');
  const manifest = resolveUniverseManifest(universe);
  if (!manifest) throw new SafeError('INVALID_UNIVERSE');
  if (!manifest.capabilities.includes('AGENT_EXPLORATION')) throw new SafeError('UNIVERSE_LACKS_AGENT_EXPLORATION');
  const cfg = universeConfig(universe), catalog = catalogOf(cfg);
  if (!catalog) throw new SafeError('EXPLORATION_CATALOG_REQUIRED');
  const budget = new RunBudget(limitsFromBounds(manifest.capabilityBounds?.AGENT_EXPLORATION));
  return { universeId: cfg.id, manifest, cfg, catalog, budget, client: budgetedClient(deps.client as any, budget) as AgentClient, executionMode: deps.executionMode ?? 'LIVE',
    dataOrigin: deps.dataOrigin ?? manifest.source.dataOrigin, runId, prefix: `.concordia/agent-runs/${runId}/`, persist: deps.persist !== false };
}

export function describedColumns(discovery: any): Record<string, { name: string; type: string }[]> {
  return Object.fromEntries(Object.entries<any>(discovery.tables).map(([name, table]) => [name, (table.sourceMetadata?.rows ?? []).flatMap((row: unknown[]) =>
    typeof row[0] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(row[0]) ? [{ name: row[0], type: typeof row[1] === 'string' ? row[1] : 'unknown' }] : [])]));
}

export interface DiscoveryPhase { discovery: any; sourceColumns: Record<string, { name: string; type: string }[]>; relations: any[] }
export async function runDiscoveryPhase(ctx: AgentContext, replay?: any): Promise<DiscoveryPhase> {
  const discovery = replay ?? await discoverUniverse(ctx.universeId, { client: ctx.client, persist: false, runId: ctx.runId, executionMode: ctx.executionMode });
  const available = new Set(Object.keys(discovery.tables));
  return { discovery, sourceColumns: describedColumns(discovery),
    relations: ctx.cfg.relations.filter((relation: any) => available.has(relation.from.table) && available.has(relation.to.table)) };
}

export function runComaStage(ctx: AgentContext, phase: DiscoveryPhase, bridge?: ComaBridge): Promise<ComaPhaseResult> {
  return runComaPhase({ universeId: ctx.universeId, cfg: ctx.cfg, catalog: ctx.catalog, discovery: phase.discovery, sourceColumns: phase.sourceColumns, relations: phase.relations,
    bridge, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin });
}

export function runExplorationStage(ctx: AgentContext, phase: DiscoveryPhase, chooser: ActionChooser | undefined, coma: ComaPhaseResult): Promise<ExplorationResult> {
  return runExploration({ runId: ctx.runId, cfg: ctx.cfg, catalog: ctx.catalog, discovery: phase.discovery, sourceColumns: phase.sourceColumns, client: ctx.client, chooser, budget: ctx.budget,
    extraObservation: coma.production?.outOfScopeProposals ?? [], executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin, persistPrefix: ctx.persist ? ctx.prefix : undefined });
}

export interface ProbeStage { selection: ProbeSelection; result?: any; relations: any[]; error?: object }
export async function runProbeStage(ctx: AgentContext, phase: DiscoveryPhase, probeChooser?: ActionChooser, now?: () => string): Promise<ProbeStage> {
  const selection = await selectProbes({ relations: phase.relations, budget: ctx.budget, chooser: probeChooser, observation: { scope: ctx.cfg.scope } });
  if (!selection.selected.length) return { selection, relations: [] };
  try {
    const result = await probeUniverse(ctx.universeId, { inventory: phase.discovery, client: ctx.client, persist: false, recordFreshness: ctx.executionMode === 'LIVE', relationIds: selection.selected, now, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin });
    return { selection, result, relations: (result as any).relations ?? (result as any).probes ?? [] };
  } catch (error) { return { selection, relations: [], error: failure(error) }; }
}

export async function runCriticStage(ctx: AgentContext, phase: DiscoveryPhase, probes: ProbeStage) {
  if (!probes.relations.length) return { status: 'SKIPPED', reason: 'no probe results' } as const;
  try {
    const critic = await criticize(ctx.universeId, { relationIds: probes.relations.map((item: any) => item.relationId ?? item.relation?.id) }, {
      config: ctx.cfg, relations: { relations: probes.relations }, inventory: phase.discovery, thresholds: readJson('config/thresholds.json'), client: ctx.client as any, persist: false });
    return { status: 'EVALUATED', eligible: critic.results.length, summary: { confirmed: critic.confirmed, degraded: critic.degraded, insufficient: critic.insufficient, errors: critic.errors, skipped: critic.skipped } } as const;
  } catch (error) { return { status: 'ERROR', error: failure(error) } as const; }
}

export const decisionsOf = (relations: any[]) => relations.map((item: any) => ({ relationId: item.relationId ?? item.relation?.id, verdict: item.verdict ?? item.decision?.verdict,
  reasonCodes: item.reasonCodes ?? item.decision?.reasonCodes ?? (item.rule ? [item.rule] : []) }));

/**
 * The product's agent loop for any registered universe: discovery -> COMA candidates -> bounded exploration ->
 * budgeted probes -> adversarial critic -> deterministic decisions. Read-only; the model only ever chooses ids.
 */
export async function runAgent(universe: string, runId: string, deps: AgentDeps) {
  const ctx = prepareAgentContext(universe, runId, deps);
  const runDirectory = path.join(ROOT, ctx.prefix);
  if (deps.persist !== false) { if (fs.existsSync(runDirectory)) throw new SafeError('AGENT_RUN_ALREADY_EXISTS'); fs.mkdirSync(runDirectory, { recursive: true }); setTraceRun(runId); }
  const report: any = { schemaVersion: 1, runId, universeId: ctx.universeId, manifestId: ctx.manifest.manifestId, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin, utc: new Date().toISOString(), phases: {} };
  const finish = () => {
    report.budget = ctx.budget.snapshot();
    report.limitations = ['Read-only: bounded SELECT templates and configured probes only; no DDL, no gold, no model-written SQL.',
      'Verdicts come from the deterministic relation policy; COMA proposals and model choices never change them.', 'Bounded samples are not table-wide claims.'];
    if (deps.persist !== false) writeJson(`${ctx.prefix}engine-run.json`, report);
    trace({ kind: 'agent-run-complete', runId, universeId: ctx.universeId, budget: report.budget });
    return report;
  };
  let phase: DiscoveryPhase;
  try { phase = await runDiscoveryPhase(ctx); report.phases.discovery = { status: 'PASS', tables: Object.keys(phase.discovery.tables), relations: phase.relations.map((relation: any) => relation.id) }; }
  catch (error) { report.phases.discovery = { status: 'ERROR', error: failure(error) }; report.status = 'DISCOVERY_FAILED'; return finish(); }
  if (deps.persist !== false) writeJson(`${ctx.prefix}discovery.json`, phase.discovery);
  const coma = await runComaStage(ctx, phase, deps.comaBridge);
  report.phases.coma = { status: coma.status, inputHash: coma.inputHash ?? null, providerStates: coma.production?.providerStates ?? [], candidates: coma.production?.candidates.length ?? 0,
    outOfScopeProposals: coma.production?.outOfScopeProposals ?? [] };
  const exploration = await runExplorationStage(ctx, phase, deps.chooser, coma);
  report.phases.exploration = { actions: exploration.actions, calls: exploration.calls.map(({ responseText: _text, ...call }) => call), plannerError: exploration.plannerError ?? null,
    reads: Object.fromEntries(Object.entries(exploration.reads).map(([id, read]) => [id, { source: read.source, columns: read.columns, rows: read.rows.length, queryId: read.queryId }])) };
  const probes = await runProbeStage(ctx, phase, deps.probeChooser, deps.now);
  report.phases.probes = { mode: probes.selection.mode, selected: probes.selection.selected, skipped: probes.selection.skipped, error: probes.error ?? null };
  report.phases.critic = deps.critic === false ? { status: 'DISABLED' } : await runCriticStage(ctx, phase, probes);
  report.decisions = decisionsOf(probes.relations);
  // Full typed probe results stay in memory for evaluation; they are not persisted in engine-run.json.
  Object.defineProperty(report, 'artifacts', { value: { discovery: phase.discovery, probes: probes.relations }, enumerable: false });
  report.status = probes.error ? 'PARTIAL' : 'COMPLETED';
  return finish();
}
