import fs from 'node:fs';
import path from 'node:path';
import type { Zetaris } from '../clients/zetaris.ts';
import type { ActionChooser } from './chooser.ts';
import { prepareAgentContext, runDiscoveryPhase, runExplorationStage, type AgentContext, type DiscoveryPhase } from './engine.ts';
import { legacyRelationContract } from '../relations/legacy.ts';
import { addSampleQualitySignals, executeProbe, planProbe, type ProbeAdapter, type ProbeReadRequest, type ProbeReadResult } from '../relations/probes.ts';
import { ZetarisProbeAdapter, zetarisTableSpecs } from '../relations/adapters/zetaris.ts';
import { evaluateRelation } from '../relations/decision.ts';
import { relationPolicyFromConfig } from '../relations/policy.ts';
import { measureMultiplicity, sharedRowPairs } from '../probe/index.ts';
import { normalizeKey } from '../universe-pipeline.ts';
import { universeConfig } from '../universe-pipeline.ts';
import { resolveUniverseManifest, universeManifests, validateCrossConfig } from '../registry/universes.ts';
import { readJson, ROOT, SafeError, setTraceRun, trace, writeJson } from '../runtime.ts';
import type { NormalizationMode } from '../universe.ts';
import { randomUUID } from 'node:crypto';
import { liveClientFor } from './cli-run.ts';
import { loadLocalEnv } from '../runtime.ts';

type Client = Pick<Zetaris, 'describe' | 'runSql'>;
type Mode = 'LIVE' | 'REPLAY' | 'LOCAL';
const CROSS_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Loads and validates universes/cross/<id>.json against the allowlists of the universes it names. An already-built declaration (tests, previews) goes through the same validation. */
export function crossConfig(input: string | object): any {
  if (typeof input === 'string' && !CROSS_ID.test(input)) throw new SafeError('CROSS_ID_INVALID');
  const cross = typeof input === 'string' ? readJson(`universes/cross/${input}.json`) : input as any, id = typeof input === 'string' ? input : cross.id;
  const known = new Set(universeManifests.flatMap(manifest => manifest.relationIds.map(item => item.toLowerCase())));
  const issues = validateCrossConfig(cross, alias => { const manifest = resolveUniverseManifest(alias); return manifest ? { manifest, config: universeConfig(alias) } : undefined; }, known);
  if (issues.length) throw new SafeError('CROSS_CONFIG_INVALID', undefined, JSON.stringify(issues));
  if (cross.id !== id) throw new SafeError('CROSS_CONFIG_INVALID', undefined, JSON.stringify([{ path: 'cross.id', code: 'CROSS_ID_FILE_MISMATCH' }]));
  return cross;
}

interface Side { alias: string; ctx: AgentContext; phase?: DiscoveryPhase; specs: ReturnType<typeof zetarisTableSpecs>; client: Client }

/** Routes each endpoint of a cross relation to the client of ITS universe. There is never a query that names two sources. */
class CrossAdapter implements ProbeAdapter {
  readonly adapterId = 'cross-universe';
  readonly reads: { universe: string; requestId?: string; queryId?: string; objectId: string }[] = [];
  private readonly adapters = new Map<string, ZetarisProbeAdapter>();
  constructor(sides: Map<string, Side>) { for (const [alias, side] of sides) this.adapters.set(alias, new ZetarisProbeAdapter(side.specs, side.client)); }
  async read(request: ProbeReadRequest): Promise<ProbeReadResult> {
    const separator = request.objectId.indexOf(':'), alias = request.objectId.slice(0, separator), adapter = this.adapters.get(alias);
    if (separator < 1 || !adapter) throw new SafeError('CROSS_OBJECT_OUTSIDE_RUN');
    const result = await adapter.read({ ...request, objectId: request.objectId.slice(separator + 1) });
    this.reads.push({ universe: alias, requestId: result.requestId, queryId: result.queryId, objectId: request.objectId });
    return result;
  }
}

export interface MultiDeps {
  /** One client per universe alias, each with its own budget. */
  clients: Record<string, Client>;
  /** Optional exploration chooser per universe alias; absent means no adaptive reads on that side (recorded, never skipped silently). */
  choosers?: Record<string, ActionChooser>;
  executionMode?: Mode;
  /** Label of the data actually read, per universe alias (e.g. SYNTHETIC for offline fixtures); defaults to each manifest's origin. */
  dataOrigins?: Record<string, AgentContext['dataOrigin']>;
  now?: () => string;
  persist?: boolean;
}

/**
 * R5-1: one run over N>=2 universes. Each side runs its own discovery (and optional exploration) with its own client and budget;
 * the declared cross relations are then probed by reading each side with its own client and comparing in the executor, and decided
 * by the same deterministic relation policy. The output keeps provenance per side.
 */
export async function runMultiAgent(crossInput: string | object, runId: string, deps: MultiDeps) {
  const cross = crossConfig(crossInput), crossId: string = cross.id, mode: Mode = deps.executionMode ?? 'LIVE', now = deps.now ?? (() => new Date().toISOString()), persist = deps.persist !== false;
  const runPrefix = `.concordia/agent-runs/${runId}/`, runDirectory = path.join(ROOT, runPrefix);
  if (persist) { if (fs.existsSync(runDirectory)) throw new SafeError('AGENT_RUN_ALREADY_EXISTS'); fs.mkdirSync(runDirectory, { recursive: true }); setTraceRun(runId); }
  const sides = new Map<string, Side>(), sideReports: any[] = [];
  for (const alias of cross.universes as string[]) {
    const client = deps.clients[alias];
    if (!client) throw new SafeError('CROSS_CLIENT_MISSING_FOR_UNIVERSE');
    const prepared = prepareAgentContext(alias, runId, { client: client as any, executionMode: mode, dataOrigin: deps.dataOrigins?.[alias], persist });
    const ctx: AgentContext = { ...prepared, prefix: `${runPrefix}sides/${alias}/` };
    if (persist) fs.mkdirSync(path.join(ROOT, ctx.prefix), { recursive: true });
    sides.set(alias, { alias, ctx, specs: zetarisTableSpecs(ctx.cfg), client: ctx.client });
  }
  const crossReport: any = { schemaVersion: 1, kind: 'MULTI_UNIVERSE_RUN', runId, crossId, executionMode: mode, utc: now(), sides: sideReports, crossRelations: [] };
  for (const side of sides.values()) {
    const entry: any = { universe: side.alias, manifestId: side.ctx.manifest.manifestId, executionMode: mode, dataOrigin: side.ctx.dataOrigin, prefix: side.ctx.prefix };
    sideReports.push(entry);
    try { side.phase = await runDiscoveryPhase(side.ctx); entry.discovery = { status: 'PASS', tables: Object.keys(side.phase.discovery.tables) }; if (persist) writeJson(`${side.ctx.prefix}discovery.json`, side.phase.discovery); }
    catch (error) { entry.discovery = { status: 'ERROR', code: (error as { code?: string }).code ?? 'DISCOVERY_FAILED' }; entry.status = 'DISCOVERY_FAILED'; entry.budget = side.ctx.budget.snapshot(); continue; }
    const chooser = deps.choosers?.[side.alias];
    if (chooser) {
      const exploration = await runExplorationStage(side.ctx, side.phase, chooser, { status: 'SKIPPED' } as any);
      // Same rule as the engine (S1): a chooser was asked for, so zero VALID decisions means the model did not participate (DEGRADED_NO_MODEL); a later non-budget planner error degrades the side.
      const valid = exploration.calls.filter(call => call.decisionStatus === 'VALID').length, plannerCode = (exploration.plannerError as { code?: string } | undefined)?.code;
      const scripted = exploration.calls.length > 0 && exploration.calls.every(call => call.requestedModel === 'fixture-script');
      entry.modelParticipation = valid === 0 ? 'FAILED' : scripted ? 'SCRIPTED_OFFLINE' : 'USED';
      entry.status = valid === 0 ? 'DEGRADED_NO_MODEL' : plannerCode && !['AGENT_TOKEN_BUDGET_EXHAUSTED', 'TOKEN_BUDGET_WOULD_EXCEED'].includes(plannerCode) ? 'DEGRADED' : 'COMPLETED';
      entry.exploration = { actions: exploration.actions, plannerError: exploration.plannerError ?? null, reads: Object.fromEntries(Object.entries(exploration.reads).map(([id, read]) => [id, { source: read.source, rows: read.rows.length, queryId: read.queryId }])) };
    } else { entry.exploration = { status: 'NOT_RUN', reason: 'no chooser for this universe' }; entry.modelParticipation = 'NOT_REQUESTED'; entry.status = 'COMPLETED'; }
    entry.budget = side.ctx.budget.snapshot();
  }
  for (const side of sides.values()) side.ctx.budget.enterPhase('probes');
  const policy = relationPolicyFromConfig(readJson('config/thresholds.json')), thresholds = readJson('config/thresholds.json');
  const dataOrigins = new Set([...sides.values()].map(side => side.ctx.dataOrigin)), origin = dataOrigins.size === 1 ? [...dataOrigins][0] : 'UNKNOWN';
  for (const relation of cross.relations as any[]) {
    const fromSide = sides.get(relation.from.universe)!, toSide = sides.get(relation.to.universe)!, record: any = { relationId: relation.id, from: relation.from, to: relation.to, reviewState: relation.reviewState ?? 'PENDING' };
    crossReport.crossRelations.push(record);
    if (!fromSide.phase || !toSide.phase) { record.verdict = 'INDETERMINADA'; record.reasonCodes = ['side_discovery_failed']; continue; }
    const modeName = relation.normalization as NormalizationMode;
    const a = fromSide.phase.discovery.tables[relation.from.table], colIndex = a.columns.indexOf(relation.from.column);
    const seeds = [...new Set(a.sample.rows.map((row: any[]) => row[colIndex]).filter((value: unknown) => value !== null && value !== undefined).map((value: unknown) => normalizeKey(value, modeName, cross.normalizationContract)))].filter((value): value is string => typeof value === 'string');
    const endpoint = (ref: any, side: Side, role: 'from' | 'to') => ({ db: side.specs[ref.table].db, table: ref.table, column: ref.column, role });
    const fromEndpoint = endpoint(relation.from, fromSide, 'from'), toEndpoint = endpoint(relation.to, toSide, 'to');
    const contractRelation = { id: relation.id, from: { db: fromEndpoint.db, table: fromEndpoint.table, column: fromEndpoint.column }, to: { db: toEndpoint.db, table: toEndpoint.table, column: toEndpoint.column },
      kind: relation.kind, reviewState: relation.reviewState, identifierSpace: relation.identifierSpace, normalizationVersion: relation.normalizationVersion, normalizationLossless: relation.normalizationLossless, normalizationAdapterCapability: relation.normalizationAdapterCapability };
    const contract: any = legacyRelationContract(contractRelation as any, `cross:${crossId}`, '1.0', modeName as any, relation.minDistinctKeys ?? thresholds.minDistinctKeys);
    // Each side keeps its own namespace unless the human-reviewed declaration names a shared one: that is the only way two universes become comparable.
    const sideNamespace = (side: Side, db: string) => relation.sharedNamespace ?? `${side.alias}:${side.ctx.cfg.namespace ?? db}`;
    contract.from = { ...contract.from, sourceId: `${fromSide.alias}:${fromEndpoint.db}:${fromEndpoint.table}:from`, objectId: `${fromSide.alias}:${fromEndpoint.db}.${fromEndpoint.table}`, namespace: { state: 'KNOWN', value: sideNamespace(fromSide, fromEndpoint.db) } };
    contract.to = { ...contract.to, sourceId: `${toSide.alias}:${toEndpoint.db}:${toEndpoint.table}:to`, objectId: `${toSide.alias}:${toEndpoint.db}.${toEndpoint.table}`, namespace: { state: 'KNOWN', value: sideNamespace(toSide, toEndpoint.db) } };
    const limit = Math.min(cross.probeLimit, ...[fromSide, toSide].map(side => side.ctx.budget.limits.readLimit));
    const filterValues = seeds.slice(0, limit);
    const allowlist = { [contract.from.objectId]: fromSide.ctx.cfg.tables[relation.from.table].columns.map((column: any) => column.name), [contract.to.objectId]: toSide.ctx.cfg.tables[relation.to.table].columns.map((column: any) => column.name) };
    const filters = filterValues.length ? { [contract.from.objectId]: { column: relation.from.column, values: filterValues }, [contract.to.objectId]: { column: relation.to.column, values: filterValues } } : {};
    const plan = planProbe(contract, allowlist, limit, 50, {}, filters);
    const adapter = new CrossAdapter(sides), checkedAt = now();
    const execution = await executeProbe(plan, adapter, { runId: `${runId}:${relation.id}`, checkedAt, scope: 'allowlisted bounded key lookup, one read per side', executionMode: mode, dataOrigin: origin });
    const reads = new Map(execution.reads.map(read => [read.sourceId, read])), fromRows = reads.get(contract.from.sourceId)?.tuples ?? [], toRows = reads.get(contract.to.sourceId)?.tuples ?? [];
    const toMultiplicity = measureMultiplicity(toRows as any[][], 0, modeName), pairs = sharedRowPairs(fromRows as any[][], 0, toRows as any[][], 0, modeName);
    const signals: string[] = [];
    if (pairs.manyToManyKeys.length) signals.push('MANY_TO_MANY');
    if (toMultiplicity.duplicateKeys.length) signals.push('DUPLICATE_REFERENCED_KEYS');
    if (execution.status === 'PARTIAL' || execution.status === 'ERROR') signals.push('SAMPLE_ALERT');
    addSampleQualitySignals(execution.bundle, signals, checkedAt);
    const decision = evaluateRelation(contract, [execution.bundle], policy);
    const targetKeys = new Set((toRows as any[][]).map(row => normalizeKey(row[0], modeName, cross.normalizationContract)).filter((value): value is string => value !== null));
    const matched = seeds.filter(key => targetKeys.has(key)).length;
    Object.assign(record, { verdict: decision.verdict, reasonCodes: decision.reasonCodes, decision, relationContract: contract, overlap: { matched, probed: seeds.length, ratio: seeds.length ? matched / seeds.length : null },
      provenance: Object.fromEntries((['from', 'to'] as const).map(role => { const side = role === 'from' ? fromSide : toSide, read = reads.get(contract[role].sourceId);
        return [role, { universe: side.alias, manifestId: side.ctx.manifest.manifestId, executionMode: mode, dataOrigin: side.ctx.dataOrigin, objectId: contract[role].objectId, requestId: read?.requestId ?? null, queryId: read?.queryId ?? null, rows: read?.tuples.length ?? 0, truncated: read ? read.tuples.length >= limit : null }]; })),
      status: execution.status, scope: 'bounded observed sample; keys compared in the executor, no SQL spans two sources' });
    if (persist) writeJson(`${runPrefix}cross-${relation.id}.json`, { relationContract: contract, typedEvidence: execution.bundle, decision });
    trace({ kind: 'agent-multi-cross-probe', runId, relationId: relation.id, verdict: decision.verdict });
  }
  for (const entry of sideReports) entry.budget = sides.get(entry.universe)!.ctx.budget.snapshot();
  // The run status carries the sides' status (A32): PARTIAL when something did not run, else DEGRADED_NO_MODEL / DEGRADED from a side, else COMPLETED.
  const incomplete = !crossReport.crossRelations.every((item: any) => item.verdict) || sideReports.some(side => side.discovery?.status !== 'PASS');
  crossReport.status = incomplete ? 'PARTIAL' : sideReports.some(side => side.status === 'DEGRADED_NO_MODEL') ? 'DEGRADED_NO_MODEL' : sideReports.some(side => side.status === 'DEGRADED') ? 'DEGRADED' : 'COMPLETED';
  crossReport.degradedSides = sideReports.filter(side => side.status === 'DEGRADED' || side.status === 'DEGRADED_NO_MODEL').map(side => ({ universe: side.universe, status: side.status }));
  crossReport.decisions = crossReport.crossRelations.map((item: any) => ({ relationId: item.relationId, verdict: item.verdict, reasonCodes: item.reasonCodes }));
  crossReport.limitations = ['Read-only: bounded SELECT templates per side; no cross-source SQL, no DDL, no gold, no model-written SQL.', 'Verdicts come from the deterministic relation policy; a cross relation is comparable only under a human-reviewed shared identifier space.', 'Bounded samples are not table-wide claims.'];
  if (persist) writeJson(`${runPrefix}multi-run.json`, crossReport);
  trace({ kind: 'agent-multi-run-complete', runId, crossId, decisions: crossReport.decisions });
  return crossReport;
}

/** `concordia agent-multi --cross <id>`: the live run. Each universe gets the client of its own universe (the JSON2 guard where a binding is declared); no model is involved unless choosers are passed. */
export async function runMultiAgentCommand(crossId: string, options: { runId?: string } = {}) {
  const cross = crossConfig(crossId);
  loadLocalEnv();
  const runId = options.runId ?? `agent-multi-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const clients = Object.fromEntries((cross.universes as string[]).map(alias => [alias, liveClientFor(alias) as Client]));
  const report = await runMultiAgent(cross, runId, { clients, executionMode: 'LIVE' });
  const summary = { status: report.status, runId, crossId, report: `.concordia/agent-runs/${runId}/multi-run.json`, decisions: report.decisions, sides: report.sides.map((side: any) => ({ universe: side.universe, dataOrigin: side.dataOrigin, queries: side.budget?.used?.queries ?? null })) };
  console.log(JSON.stringify(summary));
  process.exitCode = report.status === 'COMPLETED' ? 0 : 1;
  return summary;
}
