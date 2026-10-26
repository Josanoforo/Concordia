// Round 9 integration closure (lane X9): the OFFLINE full run on the TPCDS fixture with every Round 9 piece active as it exists, compared relation by relation with act 3.
// Usage: node scripts/run-tsx.mjs scripts/round9-integration.ts [--report [file]] [--json] [--bridge standin]
//   (default)    prints the summary with denominators
//   --report     writes the markdown report (default: out/reports/RONDA9_INTEGRACION_OFFLINE_<date>.md)
//   --bridge standin   uses the deterministic name-token COMA stand-in instead of the installed COMA (also the fallback when COMA is not installed)
// Hard rules: nothing live, no `.env`, no budget ledger, nothing persisted (persist:false). The F-04 labels (tests/fixtures/round9/eval-labels.json) and the live decoys are an OFFLINE
// EVALUATION set read only AFTER the run to score it; they are never a runtime input (checked by goldAtRuntimeViolations). Data is SYNTHETIC; a stand-in model is a pipeline measurement, not model evidence.
// A piece that has not landed is reported NOT_YET_LANDED; the harness never fails because of it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { formFixtureClient } from '../tests/helpers/form-fixture-client.ts';
import { nameTokenComaBridge } from '../src/eval/fixture-coma.ts';
import { createInstalledComaBridge, type ComaBridge } from '../src/discovery/coma-provider.ts';
import { FORBIDDEN_COLUMN } from '../src/agent/catalog.ts';
import { RUN_BUDGET_CEILINGS, RunBudget, limitsFromBounds } from '../src/agent/run-budget.ts';
import { resolveUniverseManifest } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { loadTpcdsGold, scoreTpcdsCandidates } from '../src/eval/tpcds-gold.ts';
import { ROOT, readJson } from '../src/runtime.ts';
import { buildPackets, reviewBlindCandidates, runModelReview, measureAgreement, type EvaluationLabel, type ModelReview, type ModelReviewRun, type ProbedProposalInput } from '../src/agent/model-review/index.ts';
import { standInAdversary, standInJudge, type StandInJudgeKind } from '../src/agent/model-review/standin.ts';
import { createCandidateReview } from '../src/agent/model-review/index.ts';
import os from 'node:os';
import { planWarmStart } from '../src/agent/memory.ts';

export type PieceStatus = 'LANDED' | 'NOT_YET_LANDED';
export interface PieceReport { id: string; name: string; owner: string; status: PieceStatus; detail: string }
export interface LabelsFile { schema: string; source: { file: string; sha256: string }; yes: string[]; deferred: { id: string; reason: string }[]; decoys: { id: string; liveOutcome: string }[] }
export type LabelClass = 'YES' | 'DEFERRED' | 'DECOY';
export interface RelationRow {
  id: string; label: LabelClass; found: 'DIRECT' | 'REVERSED' | 'ABSENT'; probe: string; distinctKeys: number | null; coverage: string | null; suspect: string[];
  floorCap: string | null; decision: string; confidence: string | null; adversarialPass: string | null; attacksSustained: string[]; accepted: boolean;
}
export interface ReviewConfigResult { name: string; scope: ReviewScope; packets: number; estimatedTokens: number; judges: StandInJudgeKind[]; attackScope: 'ACCEPTED_ONLY' | 'NONE'; counts: ModelReviewRun['counts']; status: string; provenance: string; rows: RelationRow[];
  agreement: { yesAccepted: number; yesN: number; deferredNotAccepted: number; deferredN: number; decoysNotAccepted: number; decoysN: number; falseAccepts: string[]; missedAccepts: string[]; measureAgreementLine: string };
  originConfusions: number; reviewsOfOtherOrigin: number; adversarialCompleted: number }

const FIXTURE_LABELS = path.join(ROOT, 'tests', 'fixtures', 'round9', 'eval-labels.json');
const DOCS_DIR = path.resolve(ROOT, 'out', 'reports');
/** PIPELINE_ACCEPTED: probed candidates with HIGH coverage that no post-COMA guard flagged (the set the e2e test calls accepted). HIGH_COVERAGE: every candidate whose key membership passed, flagged or not: the model then carries the load the guards carry otherwise. */
export type ReviewScope = 'PIPELINE_ACCEPTED' | 'HIGH_COVERAGE';
export interface ReviewConfig { name: string; judges: StandInJudgeKind[]; attackScope: 'ACCEPTED_ONLY' | 'NONE'; scope: ReviewScope }
export const REVIEW_CONFIGS: ReviewConfig[] = [
  { name: 'MODEL_ADVERSARIAL (2 semantic stand-in judges + adversarial pass)', judges: ['SEMANTIC', 'SEMANTIC'], attackScope: 'ACCEPTED_ONLY', scope: 'PIPELINE_ACCEPTED' },
  { name: 'Ablation: evidence-only judges, no adversarial pass (what bounded membership alone gives)', judges: ['EVIDENCE_ONLY', 'EVIDENCE_ONLY'], attackScope: 'NONE', scope: 'PIPELINE_ACCEPTED' },
  { name: 'Budget probe: MODEL_ADVERSARIAL over every HIGH-coverage candidate, flagged or not', judges: ['SEMANTIC', 'SEMANTIC'], attackScope: 'ACCEPTED_ONLY', scope: 'HIGH_COVERAGE' }
];

const read = (file: string) => { try { return fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { return ''; } };
const exists = (file: string) => fs.existsSync(path.join(ROOT, file));
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel)); else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}
const importedElsewhere = (needle: string, own: string) => sourceFiles('src').filter(file => file !== own && read(file).includes(needle));

/** Offline evaluation sets are labels, never inputs: no module of the runtime may name them. src/eval is the evaluation side and is allowed to. */
export function goldAtRuntimeViolations(): string[] {
  const forbidden = ['eval-labels', 'F04_TPCDS_CONTRACTS', 'tests/fixtures/round9', 'ACTO3_CONTROL_NEGATIVO'];
  return sourceFiles('src').filter(file => !file.startsWith('src/eval/')).flatMap(file => { const text = read(file); return forbidden.filter(item => text.includes(item)).map(item => `${file} names ${item}`); });
}

export async function detectPieces(): Promise<PieceReport[]> {
  const pieces: PieceReport[] = [];
  const add = (id: string, name: string, owner: string, landed: boolean, detail: string) => pieces.push({ id, name, owner, status: landed ? 'LANDED' : 'NOT_YET_LANDED', detail });
  add('P1', 'probe every candidate (coverAll, budget pre-estimation)', 'X4+X5', read('src/agent/post-coma.ts').includes('coverAll') && typeof (RunBudget.prototype as any).estimate === 'function', 'postComa.coverAll and RunBudget.estimate present');
  const samplingUsers = importedElsewhere('probe/sampling', 'src/probe/sampling.ts');
  add('P2', 'dispersed sampling + distinct-keys by default', 'X7+X4', exists('src/probe/sampling.ts') && samplingUsers.length > 0, exists('src/probe/sampling.ts') ? (samplingUsers.length ? `wired from ${samplingUsers.join(', ')}` : 'src/probe/sampling.ts present, not wired into the pipeline yet') : 'src/probe/sampling.ts absent');
  const fullUsers = importedElsewhere('probe/full-evidence', 'src/probe/full-evidence.ts');
  const fullInEngine = /fullEvidenceOf/.test(read('src/agent/engine.ts'));
  add('P3', 'full evidence (global coverage/uniqueness)', 'X7+X4+X5', exists('src/probe/full-evidence.ts') && fullUsers.length > 0 && fullInEngine, exists('src/probe/full-evidence.ts') ? (fullUsers.length ? `wired from ${fullUsers.join(', ')}; ${fullInEngine ? 'the engine turns it on when the manifest declares fullEvidence: true' : 'the engine does not pass it to the probes'}` : 'src/probe/full-evidence.ts present, not wired into the pipeline yet') : 'src/probe/full-evidence.ts absent');
  add('P4', 'key-column filter (*_sk, *_id) vs content columns', 'X1', !FORBIDDEN_COLUMN.test('ca_address_sk') && !FORBIDDEN_COLUMN.test('cs_item_sk') && FORBIDDEN_COLUMN.test('c_email_address') && FORBIDDEN_COLUMN.test('ca_street_name'), 'FORBIDDEN_COLUMN exempts key columns and still forbids content columns');
  add('P5', 'homonym discrimination (homonymGuard)', 'X4', read('src/agent/post-coma.ts').includes('homonymGuard'), 'postComa.homonymGuard present');
  const hintSelector = /hint/i.test(read('src/agent/probe-selector.ts')), hintRanking = /hint/i.test(read('src/agent/post-coma.ts'));
  add('P6', 'exploration -> probe ranking hint', 'X1+X4', hintSelector, hintSelector ? `hints in the probe selector${hintRanking ? ' and in the post-COMA ranking' : '; the post-COMA ranking does not take them (moot under coverAll: every candidate is probed)'}` : 'no hint in the selector');
  add('P7', 'budget at the full-run level', 'X5', RUN_BUDGET_CEILINGS.maxQueriesPerRun >= 2000 && RUN_BUDGET_CEILINGS.maxTokensPerRun >= 2_000_000, `ceilings ${JSON.stringify(RUN_BUDGET_CEILINGS)}`);
  add('G', 'read guard closed forms F1-F4', 'X6', /F4/.test(read('src/clients/zetaris.ts')), 'closed forms in src/clients/zetaris.ts');
  add('R', 'model review module (judges + adversarial pass)', 'X8', exists('src/agent/model-review/reviewer.ts') && typeof runModelReview === 'function', 'runModelReview exported');
  add('R-1', 'model review before the contract probes (reviewBlindCandidates)', 'X8', exists('src/agent/model-review/candidates.ts') && typeof reviewBlindCandidates === 'function', 'reviewBlindCandidates builds MODEL_REVIEWED contracts and the model-review overlay');
  const appliesOverlay = /MODEL_REVIEW_OVERLAY|modelReviewOverlay|model-review-overlay/.test(read('src/agent/engine.ts') + read('src/agent/review-overlay.ts') + read('src/universe-pipeline.ts'));
  add('R-1-apply', 'engine applies the model-review overlay and keeps MODEL_REVIEWED on the verdict', 'X5/X4/X3', appliesOverlay, appliesOverlay ? 'the engine, the overlay reader or the pipeline names the model-review overlay' : 'no module applies a MODEL_REVIEW overlay yet; the harness applies the contracts through withReviewedRelations, the only hook that exists');
  add('R-config', 'required review mode per universe/relation', 'X3', exists('src/registry/review-mode.ts'), 'src/registry/review-mode.ts present');
  const engine = read('src/agent/engine.ts');
  add('R-stage', 'engine runs the candidate review (deps.candidateReview, R-1)', 'X5', /deps\.candidateReview/.test(engine), /deps\.candidateReview/.test(engine) ? 'engine reviews the blind candidates, applies the approved contracts and decides them in the same run' : 'no deps.candidateReview in engine.ts');
  let sealOk = false;
  try { const mode = await import('../src/registry/review-mode.ts'); sealOk = mode.reviewModeSatisfied('HUMAN', ['MODEL_REVIEWED']) === false && mode.reviewModeSatisfied('MODEL_ADVERSARIAL', ['MODEL_REVIEWED']) === true; } catch { sealOk = false; }
  add('R-seal', 'MODEL_REVIEWED never satisfies a HUMAN slot', 'X5+X3', sealOk && read('src/agent/memory.ts').includes('MODEL_REVIEWED'), sealOk ? 'reviewModeSatisfied(HUMAN, [MODEL_REVIEWED]) is false; memory carries reviewOrigin' : 'review-mode seal or memory origin missing');
  add('R-label', 'labeling "revisado por modelo con pase adversarial"', 'X2', exists('src/report/review-origin.ts') && read('src/report/agent-run-report.ts').includes('review-origin'), 'src/report/review-origin.ts used by the run report');
  return pieces;
}

class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-25T00:00:00.000Z' };
  }
}

/** What the harness switches on for the run, on top of the shipped TPCDS config. Everything here is reported next to what the shipped config already says. */
export interface Overrides { postComa: Record<string, unknown>; manifestQueries: number; manifestTokens: number; manifestRelations: number; /** Manifest review mode for the run: the shipped TPCDS manifest stays HUMAN (X3), so the integrated run declares MODEL_ADVERSARIAL in process. */ reviewMode?: 'HUMAN' | 'MODEL_ADVERSARIAL'; /** P3: the manifest flag that turns whole-table evidence on for the contract probes (engine fullEvidenceOf). */ fullEvidence?: boolean }
export const HARNESS_OVERRIDES: Overrides = { postComa: { coverAll: true, homonymGuard: true }, manifestQueries: 2000, manifestTokens: 2_000_000, manifestRelations: 200, fullEvidence: true };
export interface ShippedState { reviewMode: string; fullEvidence: boolean; postComa: Record<string, unknown>; maxQueriesPerRun: number | null; maxTokensPerRun: number | null; maxRelationsPerRun: number | null }

/** In-process only: the TPCDS config is read through fs.readFileSync and the manifest is a plain object, so both are restored before returning. Nothing is written to disk. */
export async function withHarnessOverrides<T>(overrides: Overrides, fn: (shipped: ShippedState) => Promise<T>): Promise<T> {
  const realRead = fs.readFileSync, manifest: any = resolveUniverseManifest('TPCDS');
  const original = manifest.capabilityBounds?.AGENT_EXPLORATION, originalProbe = manifest.capabilityBounds?.BOUNDED_RELATION_PROBE;
  const shippedConfig = JSON.parse((realRead as any).call(fs, path.join(ROOT, 'universes', 'TPCDS.json'), 'utf8'));
  const shipped: ShippedState = { reviewMode: String(manifest.reviewMode ?? 'HUMAN'), fullEvidence: manifest.fullEvidence === true, postComa: shippedConfig.explorationCatalog?.postComa ?? {}, maxQueriesPerRun: original?.maxQueriesPerRun ?? null, maxTokensPerRun: original?.maxTokensPerRun ?? null, maxRelationsPerRun: manifest.capabilityBounds?.BOUNDED_RELATION_PROBE?.maxRelationsPerRun ?? null };
  (fs as any).readFileSync = function (file: unknown, ...rest: unknown[]) {
    const out = (realRead as any).call(fs, file, ...rest);
    if (typeof file === 'string' && file.replace(/\\/g, '/').endsWith('/universes/TPCDS.json') && typeof out === 'string') {
      const cfg = JSON.parse(out); cfg.explorationCatalog.postComa = { ...cfg.explorationCatalog.postComa, ...overrides.postComa }; return JSON.stringify(cfg);
    }
    return out;
  };
  manifest.capabilityBounds = { ...(manifest.capabilityBounds ?? {}), AGENT_EXPLORATION: { ...(original ?? {}), maxQueriesPerRun: Math.max(original?.maxQueriesPerRun ?? 0, overrides.manifestQueries), maxTokensPerRun: Math.max(original?.maxTokensPerRun ?? 0, overrides.manifestTokens) },
    ...(originalProbe ? { BOUNDED_RELATION_PROBE: { ...originalProbe, maxRelationsPerRun: Math.max(originalProbe.maxRelationsPerRun ?? 0, overrides.manifestRelations) } } : {}) };
  const originalMode = manifest.reviewMode;
  const originalFull = manifest.fullEvidence;
  if (overrides.reviewMode) manifest.reviewMode = overrides.reviewMode;
  if (overrides.fullEvidence !== undefined) manifest.fullEvidence = overrides.fullEvidence;
  try { return await fn(shipped); }
  finally { (fs as any).readFileSync = realRead; if (originalMode === undefined) delete manifest.reviewMode; else manifest.reviewMode = originalMode; if (originalFull === undefined) delete manifest.fullEvidence; else manifest.fullEvidence = originalFull; if (original === undefined) delete manifest.capabilityBounds.AGENT_EXPLORATION; else manifest.capabilityBounds.AGENT_EXPLORATION = original; if (originalProbe) manifest.capabilityBounds.BOUNDED_RELATION_PROBE = originalProbe; }
}

export function loadLabels(): LabelsFile { return JSON.parse(fs.readFileSync(FIXTURE_LABELS, 'utf8')); }
export function labelsOf(file: LabelsFile): { id: string; label: LabelClass }[] {
  return [...file.yes.map(id => ({ id, label: 'YES' as const })), ...file.deferred.map(item => ({ id: item.id, label: 'DEFERRED' as const })), ...file.decoys.map(item => ({ id: item.id, label: 'DECOY' as const }))];
}
const reverseId = (id: string) => { const [from, to] = id.split('__'); return `${to}__${from}`; };

export interface RunResult { runId: string; status: string; bridge: string; durationMs: number; report: any; shipped: ShippedState; overrides: Overrides }
const memoBridge = (bridge: ComaBridge): ComaBridge => { const cache = new Map<string, ReturnType<ComaBridge>>(); return (input, timeout) => { const key = JSON.stringify(input); if (!cache.has(key)) cache.set(key, bridge(input, timeout)); return cache.get(key)!; }; };
let sharedBridge: { key: string; bridge: ComaBridge; label: string } | undefined;
function comaBridgeFor(kind: 'installed' | 'standin') {
  const python = path.join(ROOT, '.concordia', 'python', 'coma-valentine-1.1.0', 'Scripts', 'python.exe');
  const useInstalled = kind !== 'standin' && fs.existsSync(python), key = useInstalled ? 'installed' : 'standin';
  // The installed COMA is slow and deterministic over the same input: the three runs of one integration share its answers.
  if (!sharedBridge || sharedBridge.key !== key) sharedBridge = { key, bridge: useInstalled ? memoBridge(createInstalledComaBridge(python, ROOT)) : nameTokenComaBridge, label: useInstalled ? 'installed COMA (valentine.Coma 1.1.0, local)' : 'deterministic name-token COMA stand-in (not COMA)' };
  return sharedBridge;
}
/** One offline agent run over the TPCDS fixture. MODEL_ADVERSARIAL (default) hands the engine the stand-in candidate review (R-1): it reviews the blind candidates, applies the approved contracts, probes and decides them, sealed MODEL_REVIEWED. */
export async function runBlind(options: { bridge?: 'installed' | 'standin'; runId?: string; reviewMode?: 'HUMAN' | 'MODEL_ADVERSARIAL'; memoryDir?: string } = {}): Promise<RunResult> {
  const fixture = agentFixtures().find(item => item.alias === 'TPCDS')!;
  const { bridge, label } = comaBridgeFor(options.bridge ?? 'installed');
  const reviewMode = options.reviewMode ?? 'MODEL_ADVERSARIAL', runId = options.runId ?? `agent-round9-integration-${Date.now()}`, started = Date.now();
  const overrides: Overrides = { ...HARNESS_OVERRIDES, reviewMode };
  return withHarnessOverrides(overrides, async shipped => {
    const report: any = await runAgent('TPCDS', runId, { client: formFixtureClient(universeConfig('TPCDS'), fixture.tables) as any, chooser: new Script([...fixture.chooserScript]), comaBridge: bridge,
      executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, postComaPrior: false,
      ...(reviewMode === 'MODEL_ADVERSARIAL' ? { candidateReview: createCandidateReview({ standIn: true, thresholds: readJson('config/thresholds.json') }) } : {}), ...(options.memoryDir ? { memory: { dir: options.memoryDir } } : {}) });
    return { runId, status: report.status, bridge: label, durationMs: Date.now() - started, report, shipped, overrides };
  });
}

function rowFor(id: string, label: LabelClass, proposals: Map<string, any>, review: Map<string, ModelReview>, notEvaluated: Map<string, string>, floorOf: Map<string, string>): RelationRow {
  const direct = proposals.get(id), reversed = direct ? undefined : proposals.get(reverseId(id));
  const proposal = direct ?? reversed, rid = direct ? id : reverseId(id);
  const probe = proposal?.coverageProbe, d = probe?.diagnostic, r = review.get(rid);
  const decision = r ? r.decision : proposal ? (notEvaluated.has(rid) ? `not reviewed (${notEvaluated.get(rid)})` : 'no review') : 'NOT_PROPOSED';
  return { id, label, found: direct ? 'DIRECT' : reversed ? 'REVERSED' : 'ABSENT', probe: probe ? `${probe.status}${probe.reason ? `:${probe.reason}` : ''}` : '-',
    distinctKeys: d?.multiplicity?.from?.distinctKeys ?? null, coverage: d ? `${d.coverage.matched}/${d.coverage.probed} ${d.coverage.level}` : null, suspect: d?.suspect?.reasons ?? [],
    floorCap: floorOf.get(rid) ?? null, decision, confidence: r?.confidence ?? null, adversarialPass: r?.adversarialPass ?? null, attacksSustained: r?.attacksSustained.map(a => a.family) ?? [], accepted: r?.decision === 'accept' && direct !== undefined };
}

export async function reviewCandidates(report: any, config: ReviewConfig, labels: LabelsFile): Promise<{ result: ReviewConfigResult; run: ModelReviewRun }> {
  const cfg = universeConfig('TPCDS'), thresholds = readJson('config/thresholds.json');
  const tableColumns = Object.fromEntries(Object.entries<any>(cfg.tables).map(([name, spec]) => [name, (spec.columns ?? []).map((c: any) => c.name)]));
  const high = (p: any) => p.coverageProbe?.diagnostic?.coverage?.level === 'HIGH';
  const inScope = (p: any) => high(p) && (config.scope === 'HIGH_COVERAGE' || !p.coverageProbe.diagnostic.suspect?.value);
  const { packets, unprobed } = buildPackets((report.postComa.proposals as any[]).filter(inScope) as ProbedProposalInput[], { universeId: 'TPCDS', minDistinctKeys: thresholds.minDistinctKeys, tableColumns });
  const budget = new RunBudget(limitsFromBounds({ maxTokensPerRun: RUN_BUDGET_CEILINGS.maxTokensPerRun }));
  const judges = config.judges.map((kind, i) => standInJudge(`standin-${kind.toLowerCase()}-${i + 1}`, kind)), adversary = standInAdversary('standin-adversary');
  // The primary configuration goes through the sanctioned entry (decision R-1: review before the contract probes, eligible = probed, HIGH coverage, no suspicion); the others call the reviewer directly.
  const viaR1 = config.scope === 'PIPELINE_ACCEPTED' && config.attackScope !== 'NONE';
  const defaults = { universeId: 'TPCDS', database: cfg.database, normalization: cfg.normalizationContract.defaultMode, normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text' };
  const r1 = viaR1 ? await reviewBlindCandidates({ proposals: report.postComa.proposals as ProbedProposalInput[], universeId: 'TPCDS', context: { minDistinctKeys: thresholds.minDistinctKeys, tableColumns }, judges, adversary, budget,
    config: { minDistinctKeys: thresholds.minDistinctKeys, attackScope: config.attackScope }, defaults, allowStandIn: true }) : undefined;
  const run = r1 ? r1.run : await runModelReview({ packets, unprobed, judges, adversary, budget, config: { minDistinctKeys: thresholds.minDistinctKeys, attackScope: config.attackScope } });
  const proposals = new Map<string, any>(report.postComa.proposals.map((p: any) => [p.proposalId, p]));
  const byId = new Map(run.reviews.map(r => [r.relationId, r])), notEvaluated = new Map<string, string>([...(report.postComa.proposals as any[]).filter(p => !inScope(p)).map(p => [p.proposalId, high(p) ? `stopped by post-COMA before review: ${(p.coverageProbe.diagnostic.suspect?.reasons ?? []).join(',')}` : `outside review scope, coverage ${p.coverageProbe?.diagnostic?.coverage?.level ?? p.coverageProbe?.status}`] as [string, string]), ...run.notEvaluated.map(item => [item.relationId, item.reason] as [string, string])]);
  const { evidenceFloor } = await import('../src/agent/model-review/floors.ts');
  const floorOf = new Map(packets.map(p => [p.relationId, evidenceFloor(p).cap as string]));
  const rows = labelsOf(labels).map(item => rowFor(item.id, item.label, proposals, byId, notEvaluated, floorOf));
  const of = (label: LabelClass) => rows.filter(row => row.label === label);
  const evalLabels: EvaluationLabel[] = rows.map(row => ({ relationId: row.found === 'REVERSED' ? reverseId(row.id) : row.id, label: row.label }));
  const x8 = measureAgreement(run.reviews, evalLabels);
  const reviewsOfOtherOrigin = run.reviews.filter(r => r.origin !== 'MODEL_REVIEWED' || (r as any).humanReviewed !== false).length;
  // A model review that stands in a human slot would be a confusion; the seal itself is checked by the R-seal piece, here we count reviews that carry any other origin.
  const { estimateModelReviewCost } = await import('../src/agent/model-review/index.ts');
  const estimate = estimateModelReviewCost(packets, config.judges.length, { attackScope: config.attackScope });
  const result: ReviewConfigResult = { name: config.name, scope: config.scope, packets: packets.length, estimatedTokens: estimate.estimatedTokens, judges: config.judges, attackScope: config.attackScope, counts: run.counts, status: run.status, provenance: run.provenance, rows,
    agreement: { yesAccepted: of('YES').filter(r => r.accepted).length, yesN: of('YES').length, deferredNotAccepted: of('DEFERRED').filter(r => !r.accepted).length, deferredN: of('DEFERRED').length,
      decoysNotAccepted: of('DECOY').filter(r => !r.accepted).length, decoysN: of('DECOY').length, falseAccepts: rows.filter(r => r.label !== 'YES' && r.accepted).map(r => r.id), missedAccepts: of('YES').filter(r => !r.accepted).map(r => r.id),
      measureAgreementLine: `YES accepted ${x8.classes.YES.exact}/${x8.classes.YES.n}; DEFERRED not accepted ${x8.classes.DEFERRED.acceptable}/${x8.classes.DEFERRED.n}; DECOYS not accepted ${x8.classes.DECOY.acceptable}/${x8.classes.DECOY.n}` },
    originConfusions: reviewsOfOtherOrigin, reviewsOfOtherOrigin, adversarialCompleted: run.counts.adversarialCompleted };
  return { result, run, ...(r1 ? { contracts: r1.contracts } : {}) };
}

// ---------------------------------------------------------------- pass two: model-reviewed contracts -> verdicts, stage, sealed memory
export interface PassTwoResult {
  status: 'RAN' | 'NOT_YET_LANDED'; detail: string; contracts: number;
  run?: { runId: string; status: string; durationMs: number; queries: number; tokens: number; exhausted: string[]; degradations: string[] };
  verdicts: Record<string, number>; reviewOrigins: Record<string, number>;
  review?: { status: string; approved: number; notApproved: number; label: string; provenance: string; counts: unknown; probed: number };
  agreement?: { yesN: number; yesSostenida: number; yesApproved: number; deferredN: number; deferredSostenida: number; decoyN: number; decoyWithContract: number };
  sampling: Record<string, number>;
  caveats: { status: PieceStatus; decisions: number; withGlobalCoverageCaveat: number; withGlobalUniquenessCaveat: number; detail: string };
  /** claims: written by run 1, by origin. warmStart*: planWarmStart over those claims for the applied relations, once as a MODEL_ADVERSARIAL slot and once as a HUMAN slot. nextRunReused: verdicts the engine reused in run 2 (same mode, same memory). */
  memory?: { claimsWritten: number; claimsModelReviewed: number; warmStartModelSlotReused: number; warmStartHumanSlotReused: number; warmStartHumanSlotMismatch: number; nextRunReused: number };
  /** Verdicts of contracts that were MODEL_REVIEWED but whose verdict says another origin: the confusion the seal exists to prevent. */
  originLost: number;
}
const countBy = (items: readonly string[]) => items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item]: (acc[item] ?? 0) + 1 }), {});

function warmStartMeasures(first: RunResult, same: RunResult, memoryDir: string, reused: (r: any) => any[]) {
  const probes: any[] = first.report.artifacts?.probes ?? [], claims: any[] = first.report.memory?.claims ?? [];
  const relations = probes.map(p => ({ id: p.relationId ?? p.relation?.id, from: p.from, to: p.to, normalization: p.normalization ?? p.evidence?.normalization })).filter(r => r.id && r.from && r.to);
  const plan = (reviewMode: 'MODEL_ADVERSARIAL' | 'HUMAN') => planWarmStart({ universeId: 'TPCDS', discovery: first.report.artifacts.discovery, relations: relations.map(r => ({ ...r, reviewMode })), dir: memoryDir, origin: { executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' } });
  const asModel = plan('MODEL_ADVERSARIAL'), asHuman = plan('HUMAN');
  return { claimsWritten: claims.length, claimsModelReviewed: claims.filter(c => c.reviewOrigin === 'MODEL_REVIEWED').length, warmStartModelSlotReused: asModel.reused.length, warmStartHumanSlotReused: asHuman.reused.length,
    warmStartHumanSlotMismatch: asHuman.reprobe.filter(item => item.reason === 'REVIEW_ORIGIN_MISMATCH').length, nextRunReused: reused(same.report).length };
}

/** Pass two, measured on the engine's own R-1 flow: run 1 (MODEL_ADVERSARIAL, deps.candidateReview) reviewed the blind candidates, applied the approved contracts, probed and decided them; run 2 repeats it against the same memory; run 3 declares the universe HUMAN against that memory. */
export function summarizePassTwo(labels: LabelsFile, first: RunResult, same: RunResult, memoryDir: string): PassTwoResult {
  const report = first.report, section = report.phases?.candidateReview, decisions: any[] = report.decisions ?? [], byId = new Map(decisions.map(d => [d.relationId, d]));
  const approvedIds: string[] = section?.approved ?? [];
  const empty = { originLost: 0, verdicts: {}, reviewOrigins: {}, sampling: {}, caveats: { status: 'NOT_YET_LANDED' as PieceStatus, decisions: 0, withGlobalCoverageCaveat: 0, withGlobalUniquenessCaveat: 0, detail: 'pass two did not run' } };
  if (!section || section.status !== 'APPLIED') return { status: 'NOT_YET_LANDED', detail: `candidate review ${section ? `ended ${section.status}${section.reason ? ` (${section.reason})` : ''}` : 'did not run (the engine found no MODEL_ADVERSARIAL requirement or no reviewer)'}`, contracts: approvedIds.length, ...empty };
  const reused = (r: any) => (r.decisions ?? []).filter((d: any) => (d.reasonCodes ?? []).includes('REUSED_FROM_MEMORY'));
  const get = (id: string) => byId.get(id) ?? byId.get(reverseId(id));
  const isSustained = (d: any) => d?.verdict === 'SOSTENIDA';
  const sustainedArtifacts: any[] = (report.artifacts?.probes ?? []).filter((item: any) => (item.verdict ?? item.decision?.verdict) === 'SOSTENIDA');
  const missingOf = (item: any): string[] => item.decision?.requirementsMissing ?? item.evidence?.decision?.requirementsMissing ?? item.requirementsMissing ?? [];
  const engineWiresFull = /fullEvidence/.test(read('src/agent/engine.ts'));
  const sampling = countBy((report.artifacts?.probes ?? []).map((item: any) => String(item.evidence?.sampling?.method ?? item.sampling?.method ?? 'UNREPORTED')));
  const modelPhase = report.budget?.phases?.byPhase?.modelReview?.used;
  return { status: 'RAN', detail: `${approvedIds.length} model-approved contracts applied by the engine inside the same run (deps.candidateReview), probed and decided by the unchanged policy`, contracts: approvedIds.length,
    run: { runId: report.runId, status: report.status, durationMs: first.durationMs, queries: report.budget.used.queries, tokens: modelPhase?.tokens ?? report.budget.used.tokens, exhausted: report.budget.exhausted, degradations: (report.degradations ?? []).map((d: any) => `${d.code}${d.detail ? `(${String(d.detail).slice(0, 60)})` : ''}`).slice(0, 8) },
    originLost: decisions.filter(d => d.reviewOrigin !== 'MODEL_REVIEWED').length,
    verdicts: countBy(decisions.map(d => d.verdict)), reviewOrigins: countBy(decisions.map(d => String(d.reviewOrigin ?? 'NONE'))),
    review: { status: section.status, approved: approvedIds.length, notApproved: (section.notApproved ?? []).length, label: String(section.label), provenance: String(section.provenance), counts: section.counts ?? null, probed: (section.probed ?? []).length },
    agreement: { yesN: labels.yes.length, yesSostenida: labels.yes.filter(id => isSustained(get(id))).length, yesApproved: labels.yes.filter(id => approvedIds.includes(id) || approvedIds.includes(reverseId(id))).length,
      deferredN: labels.deferred.length, deferredSostenida: labels.deferred.filter(item => isSustained(get(item.id))).length, decoyN: labels.decoys.length, decoyWithContract: labels.decoys.filter(item => get(item.id)).length },
    sampling,
    caveats: { status: sustainedArtifacts.length > 0 && sustainedArtifacts.some(item => !missingOf(item).includes('global_coverage_not_established')) ? 'LANDED' : 'NOT_YET_LANDED', decisions: sustainedArtifacts.length, withGlobalCoverageCaveat: sustainedArtifacts.filter(item => missingOf(item).includes('global_coverage_not_established')).length,
      withGlobalUniquenessCaveat: sustainedArtifacts.filter(item => missingOf(item).includes('global_uniqueness_not_established')).length,
      detail: engineWiresFull ? `whole-table evidence is ${first.shipped.fullEvidence ? 'on in the shipped manifest' : 'switched on by the harness (the shipped manifest does not declare fullEvidence: true)'}` : 'the engine does not pass fullEvidence to probeUniverse, so every SOSTENIDA keeps both caveats' },
    memory: warmStartMeasures(first, same, memoryDir, reused) };
}

export interface IntegrationResult {
  date: string; code: { head: string; uncommittedSrcFiles: number }; pieces: PieceReport[]; run: Omit<RunResult, 'report'>; labelsSha: string; docsSha: { ok: boolean | null; detail: string };
  candidates: { proposals: number; executable: number; executed: number; notExecutable: number; notExecutedByBudget: number; postComaStatus: string; coverAll: boolean; budgetShortfall: unknown };
  sql: { totalSourceQueries: number; discoveryQueries: number; postComaQueries: number; limits: unknown; exhausted: string[] };
  reviews: ReviewConfigResult[];
  m12: { id: string; distinctKeys: number | null; reached: boolean; found: string }[];
  decoyGuard: { id: string; flagged: string[] }[];
  sealed: { modelVsHumanConfusions: number; humanSlotSatisfiedByModel: boolean | 'NOT_CHECKABLE'; engineReportHumanOverlay: boolean };
  goldViolations: string[];
  passTwo: PassTwoResult;
  /** Offline, outside the runtime: the contracts the model accepted scored against the 103-edge TPCDS gold (the same evaluation the e2e test uses). F-04 only offered 28 candidates to the human. */
  goldScore: { accepted: number; truePositives: number; falsePositives: number; reversed: number; goldEdges: number; precision: number | null; recall: number | null };
}

export async function runIntegration(options: { bridge?: 'installed' | 'standin' } = {}): Promise<IntegrationResult> {
  const pieces = await detectPieces(), labels = loadLabels();
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'concordia-round9-memory-')), memoryDir = path.join(memoryRoot, 'LOCAL-SYNTHETIC');
  try {
  const result = await runBlind({ ...options, memoryDir, reviewMode: 'MODEL_ADVERSARIAL' }), { report } = result;
  const proposals: any[] = report.postComa.proposals, executed = proposals.filter(p => p.coverageProbe.status === 'EXECUTED');
  const reviews: ReviewConfigResult[] = [];
  for (const config of REVIEW_CONFIGS) reviews.push((await reviewCandidates(report, config, labels)).result);
  const byId = new Map<string, any>(proposals.map(p => [p.proposalId, p]));
  const m12 = labels.deferred.map(item => { const p = byId.get(item.id) ?? byId.get(reverseId(item.id)); const keys = p?.coverageProbe?.diagnostic?.multiplicity?.from?.distinctKeys ?? null;
    return { id: item.id, distinctKeys: keys, reached: typeof keys === 'number' && keys >= 3, found: p ? (byId.has(item.id) ? 'DIRECT' : 'REVERSED') : 'ABSENT' }; });
  const decoyGuard = labels.decoys.map(item => ({ id: item.id, flagged: (byId.get(item.id) ?? byId.get(reverseId(item.id)))?.coverageProbe?.diagnostic?.suspect?.reasons ?? ['NOT_PROPOSED'] }));
  let humanSlot: boolean | 'NOT_CHECKABLE' = 'NOT_CHECKABLE';
  try { const mode = await import('../src/registry/review-mode.ts'); humanSlot = mode.reviewModeSatisfied('HUMAN', ['MODEL_REVIEWED']); } catch { /* R-config not landed */ }
  const docsFile = path.join(DOCS_DIR, 'F04_TPCDS_CONTRACTS_25_20261025.json');
  const docsSha = fs.existsSync(docsFile) ? (() => { const sha = createHash('sha256').update(fs.readFileSync(docsFile)).digest('hex'); return { ok: sha === labels.source.sha256, detail: sha === labels.source.sha256 ? 'F-04 file matches the label fixture' : 'F-04 file differs from the label fixture' }; })() : { ok: null, detail: 'F-04 file not next to the repo (docs folder absent)' };
  const same = await runBlind({ ...options, memoryDir, reviewMode: 'MODEL_ADVERSARIAL' });
  const passTwo = summarizePassTwo(labels, result, same, memoryDir);
  const approvedIds: string[] = report.phases?.candidateReview?.approved ?? [];
  const approvedEdges = approvedIds.map(id => byId.get(id)).filter(Boolean).map((p: any) => ({ from: { table: p.from.table, column: p.from.column }, to: { table: p.to.table, column: p.to.column } }));
  const gold = scoreTpcdsCandidates(approvedEdges, loadTpcdsGold());
  const goldScore = { accepted: gold.candidates, truePositives: gold.truePositives, falsePositives: gold.falsePositives, reversed: gold.reversed.length, goldEdges: gold.goldEdges, precision: gold.precision, recall: gold.recall };
  // R-1-apply is judged by its effect, not by a grep: the contracts of the model came out of the engine still sealed MODEL_REVIEWED.
  const apply = pieces.find(p => p.id === 'R-1-apply')!;
  if (passTwo.status === 'RAN') { const kept = passTwo.contracts - passTwo.originLost; apply.status = passTwo.originLost === 0 ? 'LANDED' : 'NOT_YET_LANDED'; apply.detail = `${kept} of ${passTwo.contracts} verdicts of model-reviewed contracts kept MODEL_REVIEWED when applied by the engine (deps.candidateReview)`; }
  const { report: _report, ...runMeta } = result;
  const git = (args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';
  const code = { head: git(['rev-parse', '--short', 'HEAD']) || 'unknown', uncommittedSrcFiles: git(['status', '--porcelain', '--', 'src']).split('\n').filter(Boolean).length };
  return { date: new Date().toISOString().slice(0, 10), code, pieces, run: runMeta, labelsSha: labels.source.sha256, docsSha,
    candidates: { proposals: proposals.length, executable: proposals.length - report.postComa.counts.notExecutable, executed: executed.length, notExecutable: report.postComa.counts.notExecutable, notExecutedByBudget: report.postComa.notExecutedByBudget.length,
      postComaStatus: report.postComa.status, coverAll: report.postComa.policy.coverAll === true, budgetShortfall: report.postComa.policy.budgetShortfall ?? null },
    sql: { totalSourceQueries: report.budget.used.totalSourceQueries, discoveryQueries: report.budget.used.discoveryQueries, postComaQueries: report.budget.phases?.byPhase?.postComa?.used?.queries ?? report.budget.used.queries - report.budget.used.discoveryQueries, limits: report.budget.limits, exhausted: report.budget.exhausted },
    reviews, m12, decoyGuard,
    sealed: { modelVsHumanConfusions: reviews.reduce((sum, r) => sum + r.originConfusions, 0) + (report.reviewOverlay ? 1 : 0) + passTwo.originLost, humanSlotSatisfiedByModel: humanSlot, engineReportHumanOverlay: Boolean(report.reviewOverlay) },
    goldViolations: goldAtRuntimeViolations(),
    passTwo, goldScore };
  } finally { fs.rmSync(memoryRoot, { recursive: true, force: true }); }
}

const pct = (n: number, d: number) => `${n}/${d}`;
export function renderReport(r: IntegrationResult): string {
  const [primary, , fullScope] = r.reviews as [ReviewConfigResult, ReviewConfigResult, ReviewConfigResult];
  const a = primary.agreement, lines: string[] = [];
  const push = (...items: string[]) => lines.push(...items);
  push(`# Round 9: offline integration run (X9), ${r.date}`, '',
    `**Label: OFFLINE / SYNTHETIC fixture / SCRIPTED stand-in models.** Nothing live, no \`.env\`, no budget ledger, nothing persisted. COMA: ${r.run.bridge}. Run \`${r.run.runId}\` ${r.run.status} in ${(r.run.durationMs / 1000).toFixed(0)} s.`,
    'The F-04 labels (25 approved, 3 deferred) and the 3 live decoys are an **offline evaluation set** applied after the run; they are not a runtime input (`goldAtRuntimeViolations`: ' + (r.goldViolations.length ? r.goldViolations.join('; ') : '0') + ').',
    `Label fixture: \`tests/fixtures/round9/eval-labels.json\` (F-04 sha256 \`${r.labelsSha.slice(0, 16)}…\`; ${r.docsSha.detail}).`,
    `Code state: HEAD \`${r.code.head}\` plus ${r.code.uncommittedSrcFiles} uncommitted file(s) under src/ in the shared checkout (the run reads the working tree, not a clean copy).`,
    'Reproduce: `node scripts/run-tsx.mjs scripts/round9-integration.ts --report`.', '',
    '## 1. Pieces', '| Piece | Name | Owner | Status | Detail |', '|---|---|---|---|---|',
    ...r.pieces.map(p => `| ${p.id} | ${p.name} | ${p.owner} | **${p.status}** | ${p.detail} |`), '',
    '## 2. Headline numbers (denominators in every cell)', '| Measure | Value |', '|---|---|',
    `| Candidates probed | ${pct(r.candidates.executed, r.candidates.proposals)} proposals (${pct(r.candidates.executed, r.candidates.executable)} executable; ${r.candidates.notExecutable} not executable; ${r.candidates.notExecutedByBudget} left out by cap/budget; post-COMA status ${r.candidates.postComaStatus}; coverAll ${r.candidates.coverAll}) |`,
    `| Model review agreement with F-04 (YES accepted) | ${pct(a.yesAccepted, a.yesN)} |`,
    `| Model review, F-04 deferred not accepted | ${pct(a.deferredNotAccepted, a.deferredN)} |`,
    `| Decoys rejected or deferred | ${pct(a.decoysNotAccepted, a.decoysN)} |`,
    `| False accepts (non-YES accepted) | ${a.falseAccepts.length} of ${a.deferredN + a.decoysN} non-YES labelled${a.falseAccepts.length ? `: ${a.falseAccepts.join(', ')}` : ''} |`,
    `| MODEL_REVIEWED confused with HUMAN_REVIEWED | **${r.sealed.modelVsHumanConfusions}** = reviews with another origin ${primary.reviewsOfOtherOrigin} of ${primary.counts.relations} + verdicts of model contracts that lost the MODEL_REVIEWED seal ${r.passTwo.originLost} of ${r.passTwo.contracts} (pass two); human overlay in the engine report: ${r.sealed.engineReportHumanOverlay}; reviewModeSatisfied(HUMAN, [MODEL_REVIEWED]) = ${r.sealed.humanSlotSatisfiedByModel} |`,
    `| Contracts the model accepted, scored against the 103-edge TPCDS gold (offline) | ${pct(r.goldScore.truePositives, r.goldScore.accepted)} are true foreign keys (precision ${r.goldScore.precision === null ? 'n/a' : r.goldScore.precision.toFixed(2)}), ${r.goldScore.falsePositives} not in the gold, ${r.goldScore.reversed} reversed; recall ${pct(r.goldScore.truePositives, r.goldScore.goldEdges)}. F-04 only offered 28 candidates to the human, so accepts outside F-04 are not counted as false accepts above |`,
    `| M12 relations with ≥3 distinct source keys | ${pct(r.m12.filter(m => m.reached).length, r.m12.length)} |`,
    `| Caveats turned into measurements | ${r.passTwo.caveats.status}: of ${r.passTwo.caveats.decisions} SOSTENIDA verdicts, ${r.passTwo.caveats.withGlobalCoverageCaveat} still carry the global-coverage caveat and ${r.passTwo.caveats.withGlobalUniquenessCaveat} the global-uniqueness caveat (measured: ${r.passTwo.caveats.decisions - r.passTwo.caveats.withGlobalCoverageCaveat} and ${r.passTwo.caveats.decisions - r.passTwo.caveats.withGlobalUniquenessCaveat}). ${r.passTwo.caveats.detail} |`,
    `| SQL (SYNTHETIC fixture, counted by the run budget) | ${r.sql.totalSourceQueries} source statements (${r.sql.discoveryQueries} discovery, ${r.sql.postComaQueries} post-COMA); budget limits ${JSON.stringify(r.sql.limits)}; exhausted: ${r.sql.exhausted.length ? r.sql.exhausted.join(',') : 'none'} |`,
    `| Review scope (primary) | ${pct(primary.packets, r.candidates.executed)} probed candidates reviewed (coverage HIGH and no post-COMA flag); the rest are listed as not reviewed with the reason |`,
    `| Tokens, primary review (STAND-IN, estimated chars/2, not a generation) | ${primary.counts.tokens} over ${primary.counts.calls} scripted calls (pre-estimate ${primary.estimatedTokens}; adversarial pass completed on ${primary.adversarialCompleted} of ${primary.counts.relations} reviewed relations; status ${primary.status}) |`,
    `| Tokens, same review over EVERY HIGH-coverage candidate, flagged or not | pre-estimate ${fullScope.estimatedTokens} for ${pct(fullScope.packets, r.candidates.executed)} packets; ran ${fullScope.counts.tokens} tokens, status **${fullScope.status}**, ${fullScope.counts.skippedBudget} skipped for budget (ceiling ${RUN_BUDGET_CEILINGS.maxTokensPerRun}) |`, '',
    '## 3. What the harness switched on (it is not the shipped config)',
    `Shipped TPCDS: post-COMA ${JSON.stringify(r.run.shipped.postComa)}, manifest review mode ${r.run.shipped.reviewMode}, fullEvidence ${r.run.shipped.fullEvidence}, maxQueriesPerRun ${r.run.shipped.maxQueriesPerRun ?? 'default'}, maxTokensPerRun ${r.run.shipped.maxTokensPerRun ?? 'default'}, maxRelationsPerRun ${r.run.shipped.maxRelationsPerRun ?? 'n/a'}.`,
    `In-process overrides that change something: ${overridesApplied(r).join('; ') || 'none'}. Everything else in the run is the shipped config. Whoever owns universes/TPCDS.json and the manifest (X3/X4) decides what ships.`,
    '## 4. Review configurations', '| Configuration | Scope | Status | Provenance | Reviews | accept / defer / reject | not evaluated | YES accepted | F-04 deferred not accepted | Decoys not accepted | False accepts |', '|---|---|---|---|---|---|---|---|---|---|---|',
    ...r.reviews.map(c => `| ${c.name} | ${c.scope} | ${c.status} | ${c.provenance} | ${c.counts.relations} | ${c.counts.accept} / ${c.counts.defer} / ${c.counts.reject} | ${c.rows.filter(x => x.decision.startsWith('not reviewed')).length} | ${pct(c.agreement.yesAccepted, c.agreement.yesN)} | ${pct(c.agreement.deferredNotAccepted, c.agreement.deferredN)} | ${pct(c.agreement.decoysNotAccepted, c.agreement.decoysN)} | ${c.agreement.falseAccepts.length} |`),
    '', `Cross-check with X8's \`measureAgreement\` (primary): ${primary.agreement.measureAgreementLine}.`, `Reading: the ablation row is what bounded key membership alone gives; the gap to the first row is the semantic judges plus the adversarial pass. Both use scripted stand-ins, so this measures the pipeline and its floors, not a model.`, '',
    '## 5. Relation by relation against F-04 (primary configuration)', '| Relation | F-04 | Proposed | Probe | Distinct src keys | Coverage | Post-COMA suspect | Floor | Model decision | Sustained attacks | Agrees |', '|---|---|---|---|---|---|---|---|---|---|---|',
    ...primary.rows.map(x => `| ${x.id} | ${x.label} | ${x.found} | ${x.probe} | ${x.distinctKeys ?? '-'} | ${x.coverage ?? '-'} | ${x.suspect.join(',') || '-'} | ${x.floorCap ?? '-'} | ${x.decision}${x.confidence ? ` (${x.confidence})` : ''} | ${x.attacksSustained.join(',') || '-'} | ${(x.label === 'YES' ? x.accepted : !x.accepted) ? 'yes' : '**NO**'} |`),
    '', 'A relation found only in the reversed orientation counts as not accepted (the contract is directed), shown as REVERSED.',
    `The F-04 deferrals are M12: on the live table the first rows carried 1 distinct source key, so the policy could not accept. On the fixture those same relations show ${r.m12.filter(m => m.reached).length} of ${r.m12.length} with ≥3 distinct keys, so an accept there is the intended effect of fixing the sampling, not a disagreement about semantics; it is still counted as a disagreement with F-04 in the headline, with its denominator.`, '',
    '## 6. M12 (distinct source keys, minimum 3)', '| Relation | Found | Distinct source keys | ≥3 |', '|---|---|---|---|', ...r.m12.map(m => `| ${m.id} | ${m.found} | ${m.distinctKeys ?? '-'} | ${m.reached ? 'yes' : 'no'} |`),
    '', 'The fixture has 5-6 rows per table, so this reflects the fixture, not the live table; P2 is judged on a live run.', '',
    '## 7. Decoys: what the post-COMA guard says before any review', '| Decoy | Post-COMA suspect reasons |', '|---|---|', ...r.decoyGuard.map(d => `| ${d.id} | ${d.flagged.join(', ') || 'none (not flagged)'} |`),
    '', ...passTwoLines(r.passTwo),
    '## 9. Open items (derived from this run)', ...(openItems(r).length ? openItems(r).map(item => `- ${item}`) : ['- none']), '',
    '## 10. Limits of this run', '- SYNTHETIC fixture (24 tables, 5-6 rows): not the live TPCDS. Agreement with F-04 is on the fixture; the live numbers need the approved live run.',
    '- Stand-in models: a pipeline measurement. A live model reviewer is measured separately and needs approval.',
    '- The F-04 comparison is per directed relation; relations COMA does not propose on the fixture count as not accepted and stay in the denominators.', '');
  return lines.join('\n');
}

/** The harness overrides that actually differ from the shipped config (the bounds only ever raise it). */
export function overridesApplied(r: IntegrationResult): string[] {
  const { shipped, overrides } = r.run, out: string[] = [];
  if (overrides.reviewMode && overrides.reviewMode !== shipped.reviewMode) out.push(`manifest review mode ${shipped.reviewMode} -> ${overrides.reviewMode}`);
  if (overrides.fullEvidence !== undefined && overrides.fullEvidence !== shipped.fullEvidence) out.push(`fullEvidence ${shipped.fullEvidence} -> ${overrides.fullEvidence}`);
  for (const [key, value] of Object.entries(overrides.postComa)) if (shipped.postComa[key] !== value) out.push(`postComa.${key} ${JSON.stringify(shipped.postComa[key] ?? null)} -> ${JSON.stringify(value)}`);
  if ((shipped.maxQueriesPerRun ?? 0) < overrides.manifestQueries) out.push(`maxQueriesPerRun ${shipped.maxQueriesPerRun} -> ${overrides.manifestQueries}`);
  if ((shipped.maxTokensPerRun ?? 0) < overrides.manifestTokens) out.push(`maxTokensPerRun ${shipped.maxTokensPerRun} -> ${overrides.manifestTokens}`);
  if ((shipped.maxRelationsPerRun ?? 0) < overrides.manifestRelations) out.push(`maxRelationsPerRun ${shipped.maxRelationsPerRun} -> ${overrides.manifestRelations}`);
  return out;
}

/** What stays open after this run, derived from the measurements so the list cannot go stale when a piece lands. */
export function openItems(r: IntegrationResult): string[] {
  const items: string[] = [], primary = r.reviews[0]!;
  for (const piece of r.pieces.filter(p => p.status === 'NOT_YET_LANDED')) items.push(`${piece.id} (${piece.owner}) NOT_YET_LANDED: ${piece.detail}`);
  if (r.passTwo.originLost > 0) items.push(`Origin seal lost in pass two: ${r.passTwo.originLost} of ${r.passTwo.contracts} verdicts of MODEL_REVIEWED contracts say another origin, and the same relations declared HUMAN were reused ${r.passTwo.memory?.warmStartHumanSlotReused ?? '?'} times from memory. The path that applies a model overlay must carry reviewOrigin into the probe result.`);
  if (r.passTwo.status === 'RAN' && r.passTwo.memory && r.passTwo.memory.nextRunReused === 0) items.push(`Warm start: the memory holds ${r.passTwo.memory.claimsModelReviewed} MODEL_REVIEWED claims, and the seal gate works (as a HUMAN slot: ${r.passTwo.memory.warmStartHumanSlotMismatch} refused, as MODEL_ADVERSARIAL: ${r.passTwo.memory.warmStartModelSlotReused} reusable), but the next engine run re-probes all ${r.passTwo.contracts} contracts the review applies: R-1 contracts do not go through the warm start.`);
  if (r.passTwo.caveats.status === 'NOT_YET_LANDED' && r.passTwo.caveats.decisions > 0) items.push(`Caveats still declared: ${r.passTwo.caveats.withGlobalCoverageCaveat} of ${r.passTwo.caveats.decisions} SOSTENIDA verdicts keep global_coverage_not_established and ${r.passTwo.caveats.withGlobalUniquenessCaveat} keep global_uniqueness_not_established: ${r.passTwo.caveats.detail}.`);
  if (primary.estimatedTokens > RUN_BUDGET_CEILINGS.maxTokensPerRun) items.push(`Token ceiling: the primary review pre-estimates ${primary.estimatedTokens} tokens against a ${RUN_BUDGET_CEILINGS.maxTokensPerRun} ceiling (it ran ${primary.counts.tokens}, status ${primary.status}); a review of every HIGH-coverage candidate does not fit at all.`);
  if (!r.run.shipped.postComa.coverAll) items.push(`The shipped TPCDS config does not enable postComa.coverAll / homonymGuard (shipped postComa: ${JSON.stringify(r.run.shipped.postComa)}) and the shipped manifest review mode is ${r.run.shipped.reviewMode}: a plain agent run still caps probes and runs no model review. The harness switches them on in process only.`);
  if (r.run.shipped.maxRelationsPerRun !== null && r.passTwo.contracts > r.run.shipped.maxRelationsPerRun) items.push(`Manifest maxRelationsPerRun is ${r.run.shipped.maxRelationsPerRun} but the model accepted ${r.passTwo.contracts} contracts: applying them needs a higher bound.`);
  if (r.run.shipped.maxTokensPerRun !== null && r.run.shipped.maxTokensPerRun < primary.counts.tokens) items.push(`Manifest maxTokensPerRun is ${r.run.shipped.maxTokensPerRun}, below the ${primary.counts.tokens} tokens the stand-in review uses.`);
  return items;
}

function passTwoLines(p: PassTwoResult): string[] {
  const lines = ['## 8. Verdict pass with model-reviewed contracts (pass two)', `${p.status}: ${p.detail}`, ''];
  if (p.status !== 'RAN' || !p.run) return [...lines, ''];
  const a = p.agreement!;
  lines.push('| Measure | Value |', '|---|---|',
    `| Run | ${p.run.runId} ${p.run.status}, ${(p.run.durationMs / 1000).toFixed(0)} s, ${p.run.queries} SQL, ${p.run.tokens} stage tokens (STAND-IN); exhausted: ${p.run.exhausted.join(',') || 'none'}; degradations: ${p.run.degradations.join('; ') || 'none'} |`,
    `| Verdicts | ${JSON.stringify(p.verdicts)} over ${p.contracts} contracts |`,
    `| Review origin on the verdicts | ${JSON.stringify(p.reviewOrigins)} (HUMAN_REVIEWED must not appear: no human reviewed these) |`,
    `| Candidate review in the engine (R-1) | ${p.review ? `${p.review.status}: approved ${p.review.approved}, not approved ${p.review.notApproved}, probed ${p.review.probed}; label "${p.review.label}"; provenance ${p.review.provenance}` : 'did not run'} |`,
    `| F-04 YES that reach SOSTENIDA | ${pct(a.yesSostenida, a.yesN)} (and model-APPROVED: ${pct(a.yesApproved, a.yesN)}) |`,
    `| F-04 deferred that reach SOSTENIDA | ${pct(a.deferredSostenida, a.deferredN)} |`,
    `| Decoys with a contract at all | ${pct(a.decoyWithContract, a.decoyN)} |`,
    `| Source key sampling per probe | ${JSON.stringify(p.sampling)} |`,
    `| Memory written by run 1 | ${p.memory!.claimsWritten} claims, ${p.memory!.claimsModelReviewed} sealed MODEL_REVIEWED |`,
    `| Warm start of those relations declared MODEL_ADVERSARIAL | ${p.memory!.warmStartModelSlotReused} of ${p.contracts} reusable |`,
    `| Warm start of the same relations declared HUMAN | ${p.memory!.warmStartHumanSlotReused} reused, ${p.memory!.warmStartHumanSlotMismatch} REVIEW_ORIGIN_MISMATCH (a model review never fills a slot that requires a human) |`,
    `| Next engine run on the same memory (same mode) | ${p.memory!.nextRunReused} of ${p.contracts} verdicts REUSED_FROM_MEMORY |`, '');
  return lines;
}

export function defaultReportPath(date: string) { return path.join(DOCS_DIR, `RONDA9_INTEGRACION_OFFLINE_${date.replace(/-/g, '')}.md`); }

async function main() {
  const args = process.argv.slice(2), result = await runIntegration({ bridge: args.includes('standin') ? 'standin' : 'installed' });
  const markdown = renderReport(result);
  if (args.includes('--report')) {
    const next = args[args.indexOf('--report') + 1], file = next && !next.startsWith('--') ? path.resolve(next) : defaultReportPath(result.date);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, markdown); console.log(`ROUND9_INTEGRATION_REPORT ${file}`);
  }
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2)); else console.log(markdown.split('\n').slice(0, 40).join('\n'));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
