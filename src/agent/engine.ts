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
import { compareDeclaredAlternatives, type TableRowsView } from './join-compare.ts';
import { normalizeComaInputVersion, runComaPhase, type ComaPhaseResult } from './coma-input.ts';
import { agentMemoryDir, planWarmStart, recordRunMemory, type WarmStartReport } from './memory.ts';
import { runExploration, type ExplorationResult } from './exploration.ts';
import { runPostComa } from './post-coma.ts';
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
  /** Explicit COMA input version; absent means the implicit legacy v1 (hash-compatible with historic runs). */
  comaInputVersion?: 1 | 2;
  executionMode?: Mode;
  /** Label for the data actually read (e.g. SYNTHETIC for offline fixtures); defaults to the manifest's origin. */
  dataOrigin?: AgentContext['dataOrigin'];
  now?: () => string;
  critic?: boolean;
  persist?: boolean;
  /** Opt-in memory (Reconciler/H-MEM): REUSED relations skip their probes and the run's claims are written with its run id. */
  memory?: boolean | { dir?: string; ttlMs?: number };
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

export function runComaStage(ctx: AgentContext, phase: DiscoveryPhase, bridge?: ComaBridge, comaInputVersion?: number): Promise<ComaPhaseResult> {
  return runComaPhase({ universeId: ctx.universeId, cfg: ctx.cfg, catalog: ctx.catalog, discovery: phase.discovery, sourceColumns: phase.sourceColumns, relations: phase.relations,
    bridge, comaInputVersion, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin });
}

/**
 * Join comparison for universes that declare joinAlternatives. The comparator reads nothing: it measures rows already observed
 * (a bounded exploration read of the table, else the discovery sample). It runs only while the SQL budget still has room;
 * otherwise it is recorded as not executed. Universes without joinAlternatives are untouched (returns undefined).
 */
export function runJoinComparisonStage(ctx: AgentContext, phase: DiscoveryPhase, exploration: ExplorationResult) {
  const specs = ctx.catalog?.joinAlternatives;
  if (!specs?.length) return undefined;
  if (!ctx.budget.canQuery()) return { status: 'NOT_EXECUTED_BUDGET', reason: 'AGENT_QUERY_BUDGET_EXHAUSTED', alternatives: [] };
  const readOf = (table: string) => Object.values(exploration.reads).find(read => ctx.catalog.actions?.some((action: any) => action.id === read.actionId && action.table === table));
  const view = (table: string): TableRowsView => {
    const read = readOf(table), sample = phase.discovery.tables[table], useRead = Boolean(read?.rows.length);
    return { rows: useRead ? read!.rows : sample?.sample?.rows ?? [], columns: useRead ? read!.columns : sample?.columns ?? [], evidenceRefs: [useRead ? read!.queryId : sample?.sample?.queryId].filter(Boolean) };
  };
  try { return { status: 'COMPARED', queriesCharged: 0, alternatives: compareDeclaredAlternatives(ctx.cfg, specs, view) }; }
  catch (error) { return { status: 'ERROR', error: failure(error), alternatives: [] }; }
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
  const coma = await runComaStage(ctx, phase, deps.comaBridge, deps.comaInputVersion);
  report.phases.coma = { status: coma.status, comaInputVersion: coma.comaInputVersion ?? normalizeComaInputVersion(deps.comaInputVersion), comaInputVersionExplicit: deps.comaInputVersion !== undefined, inputHash: coma.inputHash ?? null, providerStates: coma.production?.providerStates ?? [], candidates: coma.production?.candidates.length ?? 0,
    outOfScopeProposals: coma.production?.outOfScopeProposals ?? [] };
  const exploration = await runExplorationStage(ctx, phase, deps.chooser, coma);
  report.phases.exploration = { actions: exploration.actions, calls: exploration.calls.map(({ responseText: _text, ...call }) => call), plannerError: exploration.plannerError ?? null,
    reads: Object.fromEntries(Object.entries(exploration.reads).map(([id, read]) => [id, { source: read.source, columns: read.columns, rows: read.rows.length, queryId: read.queryId }])) };
  const joinComparison = runJoinComparisonStage(ctx, phase, exploration);
  if (joinComparison) report.phases.joinComparison = joinComparison;
  const requestedMemory = deps.memory ? (deps.memory === true ? {} : deps.memory) : undefined;
  // Memory is scoped per execution mode and data origin unless the caller pins a directory.
  const memoryOptions = requestedMemory ? { ...requestedMemory, dir: requestedMemory.dir ?? agentMemoryDir(ctx.universeId, { executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin }) } : undefined;
  let warmStart: WarmStartReport | undefined, memoryError: object | undefined;
  if (memoryOptions) { try { warmStart = planWarmStart({ universeId: ctx.universeId, discovery: phase.discovery, relations: phase.relations, ...memoryOptions }); } catch (error) { memoryError = failure(error); } }
  const reusedIds = new Set(warmStart?.reused.map(item => item.relationId) ?? []);
  const probes = await runProbeStage(ctx, reusedIds.size ? { ...phase, relations: phase.relations.filter((relation: any) => !reusedIds.has(relation.id)) } : phase, deps.probeChooser, deps.now);
  report.probeSelection = { mode: probes.selection.mode, modelRanking: deps.probeChooser ? 'USED' : 'NOT_USED', fallback: probes.selection.fallback ?? null, selected: probes.selection.selected, skipped: probes.selection.skipped,
    calls: probes.selection.calls.map(({ responseText: _text, ...call }) => call) };
  report.phases.probes = { mode: probes.selection.mode, selected: probes.selection.selected, skipped: probes.selection.skipped, error: probes.error ?? null };
  report.phases.critic = deps.critic === false ? { status: 'DISABLED' } : await runCriticStage(ctx, phase, probes);
  // Post-COMA runs last, on whatever budget is left: out-of-scope proposals become coverage diagnostics, never verdicts.
  report.postComa = await runPostComa({ cfg: ctx.cfg, catalog: ctx.catalog, discovery: phase.discovery, proposals: coma.production?.outOfScopeProposals ?? [], client: ctx.client, budget: ctx.budget });
  report.decisions = [...decisionsOf(probes.relations), ...(warmStart?.reused ?? []).map(item => ({ relationId: item.relationId, verdict: 'SOSTENIDA', reasonCodes: ['REUSED_FROM_MEMORY'], reused: { claimId: item.claimId, version: item.version, fromRunId: item.reusedFromRunId } }))];
  if (memoryOptions) report.memory = memoryError ? { schemaVersion: 1, status: 'ERROR', runId, universeId: ctx.universeId, error: memoryError }
    : recordRunMemory({ universeId: ctx.universeId, runId, discovery: phase.discovery, probes: probes.relations, warmStart, dir: memoryOptions.dir });
  // Full typed probe results (relation contract, typed evidence, freshness) are kept in memory as report.artifacts and
  // persisted next to the run as artifacts.json, so a run can be re-evaluated offline without new reads.
  Object.defineProperty(report, 'artifacts', { value: { discovery: phase.discovery, probes: probes.relations }, enumerable: false });
  if (deps.persist !== false) {
    writeJson(`${ctx.prefix}artifacts.json`, { schemaVersion: 1, runId, universeId: ctx.universeId, executionMode: ctx.executionMode, dataOrigin: ctx.dataOrigin, utc: report.utc, probes: probes.relations });
    report.artifactsFile = `${ctx.prefix}artifacts.json`;
  }
  report.status = probes.error ? 'PARTIAL' : 'COMPLETED';
  return finish();
}
