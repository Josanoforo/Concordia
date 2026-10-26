import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTokenCapOverride } from './run-budget.ts';
import { readBudget } from '../budget.ts';
import { Nightshift } from '../clients/nightshift.ts';
import { Zetaris } from '../clients/zetaris.ts';
import { createInstalledComaBridge } from '../discovery/coma-provider.ts';
import { resolveUniverseManifest } from '../registry/universes.ts';
import { failure, loadLocalEnv, readJson, ROOT, SafeError } from '../runtime.ts';
import { requiredReviewMode, type ReviewMode } from '../registry/review-mode.ts';
import { createCandidateReview } from './model-review/index.ts';
import { universeConfig } from '../universe-pipeline.ts';
import { catalogOf } from './catalog.ts';
import { GENERIC_CODE_PREFIX, NightshiftChooser, type ActionChooser, type ChoiceCall } from './chooser.ts';
import { agentFixtures } from '../eval/agent-eval.ts';
import { offlineAgentDeps } from './offline-deps.ts';
import { withReviewOverlay } from './review-overlay.ts';
import { runAgent, type AgentDeps } from './engine.ts';
import { NightshiftAssistChooser } from './critic-assist.ts';
import { NightshiftSecondaryJudge } from './secondary-judge.ts';
import { continueAgentExploration } from './continuation.ts';
import { guardJson2Client } from './json2-guard.ts';

/** The probe-ranking chooser is the exploration chooser only when the run opts in with --probe-model; otherwise probes are all-affordable and cost no generation. */
export function probeChooserFor<T>(chooser: T | undefined, argv: readonly string[], explicit?: boolean): T | undefined {
  return (explicit ?? argv.includes('--probe-model')) ? chooser : undefined;
}

/** The live client of a universe: plain Zetaris, or one guarded by its root-reviewed JSON2 binding (fresh schema + typed multiset check before use, bound tables/columns/limits only). */
export function liveClientFor(universe: string) {
  const cfg = universeConfig(universe), zetaris = new Zetaris();
  return typeof cfg.liveBinding === 'string' ? guardJson2Client(cfg, zetaris) : zetaris;
}

/** Summary fields derived from the engine report. Probe ranking counts only real calls; the exploration error and every degradation are surfaced. */
export function liveSummaryFields(report: any) {
  // The engine is the single source of the probe-ranking label.
  const probeModelRanking = report.probeSelection?.modelRanking ?? null;
  return { probeModelRanking, explorationError: report.phases?.exploration?.plannerError ?? null,
    explorationErrors: report.phases?.exploration?.explorationErrors ?? [], explorationReadFailures: report.phases?.exploration?.explorationErrors?.length ?? 0,
    modelParticipation: report.modelParticipation ?? null, modelParticipationReason: report.modelParticipationReason ?? null, degradations: report.degradations ?? [], statusExplanation: report.statusExplanation ?? null,
    coma: report.phases?.coma?.status ?? null, critic: report.phases?.critic?.status ?? null, criticAssist: report.criticAssist?.status ?? null,
    secondaryJudge: report.secondaryJudge?.status ?? null, memory: report.memory?.status ?? null,
    explorationCalls: report.phases?.exploration?.calls?.length ?? 0, tokensUsed: report.budget?.used?.tokens ?? null };
}

/** `eval-agent` exits 1 when any universe misses the agent-loop PASS criteria (criteria.passed false or absent). */
export function evalAgentExitCode(result: { criteria?: { passed?: boolean } }): 0 | 1 { return result.criteria?.passed === true ? 0 : 1; }

/** Model-dependent flags never degrade silently: without a chooser they fail with the cause (--no-model is the only legitimate path without a model). */
export function assertModelFlags(input: { chooser: boolean; chooserError?: { code: string }; probeModel?: boolean; criticAssist?: boolean; secondaryJudge?: boolean }) {
  if (input.chooser) return;
  for (const [on, flag] of [[input.probeModel, '--probe-model'], [input.criticAssist, '--critic-assist'], [input.secondaryJudge, '--secondary-judge']] as const)
    if (on) throw new SafeError(input.chooserError?.code ?? 'MODEL_REQUIRED_FOR_FLAG', undefined, flag);
}

/** Codes of the report's degradations (deduplicated, in order), or the status itself when none were recorded. */
export function degradationCodes(report: any): string[] {
  const codes = [...new Set<string>((report.degradations ?? []).map((item: any) => String(item?.code)))];
  return codes.length ? codes : ['UNSPECIFIED'];
}

/** Every WARNING line that applies (stderr): the model did not participate, and/or the run ended with status DEGRADED. Informational degradations of a run that kept its status are NOTEs (runNotes), never a WARNING. */
export function runWarnings(report: any, modelRequested: boolean): string[] {
  const missing = modelDidNotParticipate(report, modelRequested), out: string[] = [];
  if (missing !== undefined) out.push(`WARNING: MODEL_DID_NOT_PARTICIPATE(${missing})`);
  if (report.status === 'DEGRADED') out.push(`WARNING: RUN_DEGRADED(${degradationCodes(report).join(',')})`);
  return out;
}

/** Statuses that exit 0: the core is complete (COMPLETED_WITH_WARNINGS only adds warnings from auxiliary phases). */
export const SUCCESS_STATUSES: readonly string[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS'];

/** `warnings(<phase>:<code>,...)` of a COMPLETED_WITH_WARNINGS run: the auxiliary phases that degraded. */
export function warningPairs(report: any): string[] {
  const pairs = (report.phaseStatus ?? []).filter((item: any) => item?.role === 'auxiliary' && item.state === 'DEGRADED').flatMap((item: any) => (item.codes?.length ? item.codes : ['UNSPECIFIED']).map((code: string) => `${item.phase}:${code}`));
  return pairs.length ? pairs : degradationCodes(report).map(code => `run:${code}`);
}

/** Informational degradations that did not change the status (a COMPLETED run can still skip the critic or hit a step cap): listed, not a warning. A COMPLETED_WITH_WARNINGS run lists its auxiliary warnings as a NOTE. */
export function runNotes(report: any): string[] {
  if (report.status === 'COMPLETED_WITH_WARNINGS') return [`NOTE: warnings(${warningPairs(report).join(',')})`];
  return report.status !== 'DEGRADED' && (report.degradations ?? []).length > 0 ? [`NOTE: degradations(${degradationCodes(report).join(',')})`] : [];
}

/** Exit code of a live run: 0 only when COMPLETED or COMPLETED_WITH_WARNINGS, the ledger kept its prior attempts, and a requested model really participated. */
export function liveExitCode(report: any, modelRequested: boolean, priorAttemptsPreserved: boolean): 0 | 1 {
  return SUCCESS_STATUSES.includes(report.status) && priorAttemptsPreserved && modelDidNotParticipate(report, modelRequested) === undefined ? 0 : 1;
}

/** A run that asked for the model passes only if the model really participated (X5 contract: modelParticipation 'USED'); otherwise it exits non-zero with a WARNING.
 *  COMPLETED_WITH_WARNINGS already says the model took part in the core (the review) even if the exploration did not use it. */
export function modelDidNotParticipate(report: any, modelRequested: boolean): string | undefined {
  if (!modelRequested || report.modelParticipation === 'USED' || report.status === 'COMPLETED_WITH_WARNINGS') return undefined;
  return String(report.modelParticipationReason ?? report.modelParticipation ?? 'NO_PARTICIPATION_RECORDED');
}

/**
 * The built-in model review of blind candidates (R-1). Only a universe whose required review mode is MODEL_ADVERSARIAL or BOTH needs one; any other mode gets none.
 * Live uses the agent's real model client (the same Nightshift as the chooser); --offline uses the scripted stand-in. A live run that needs the review and has no model
 * (--no-model, or the model client could not be built) fails closed before the first SQL: it never silently degrades.
 */
/** Manifest `reviewCascade.enabled === true` -> `{config:{cascade:true}}`; anything else adds nothing (the review is built as before). */
export function reviewCascadeOptions(manifest: unknown): { config?: { cascade: true } } {
  return (manifest as { reviewCascade?: { enabled?: boolean } } | undefined)?.reviewCascade?.enabled === true ? { config: { cascade: true } } : {};
}

export function candidateReviewFor(universe: string, input: { offline: boolean; nightshift?: Nightshift; cause?: { code: string }; manifest?: ReturnType<typeof resolveUniverseManifest> }): { reviewMode: ReviewMode; review?: AgentDeps['candidateReview']; status: 'NOT_REQUIRED' | 'MODEL' | 'STAND_IN_OFFLINE' } {
  const manifest = input.manifest ?? resolveUniverseManifest(universe);
  const reviewMode = requiredReviewMode(manifest);
  if (reviewMode !== 'MODEL_ADVERSARIAL' && reviewMode !== 'BOTH') return { reviewMode, status: 'NOT_REQUIRED' };
  const thresholds = readJson<any>('config/thresholds.json');
  // Manifest `reviewCascade.enabled` (OFF by default) turns on the cheap review cascade; without it the review is built exactly as before.
  const cascade = reviewCascadeOptions(manifest);
  if (input.offline) return { reviewMode, review: createCandidateReview({ standIn: true, thresholds, ...cascade }), status: 'STAND_IN_OFFLINE' };
  if (!input.nightshift) throw new SafeError(input.cause?.code ?? 'MODEL_REVIEW_REQUIRES_MODEL', undefined, `review mode ${reviewMode} needs a model; --no-model cannot run it`);
  return { reviewMode, review: createCandidateReview({ model: input.nightshift, thresholds, ...cascade }), status: 'MODEL' };
}

/** Runs `fn` with the human review overlay in force when `--review <file>` was given (fail-closed, scoped to the call); without it the universe stays as configured (blind universes stay blind). */
export function withReview<T>(universe: string, review: string | undefined, fn: () => Promise<T>): Promise<T> {
  return review === undefined ? fn() : withReviewOverlay(universe, { file: review }, fn);
}

/** C1: a live run that requests the model checks the gateway answers (GET /models, no generation, no ledger) before the first SQL; otherwise it fails closed. */
export async function preflightModelGateway(client: { ping(timeoutMs?: number): Promise<void> }): Promise<void> {
  try { await client.ping(); } catch (error) { throw new SafeError('MODEL_GATEWAY_UNREACHABLE', undefined, `the model gateway did not answer (0 SQL sent); start it or use --no-model: ${failure(error).code ?? 'UNKNOWN'}`); }
}

/** Engine dependencies of a live run: the CLI states what was requested (model, COMA) so the engine can tell a degraded run from a requested-and-delivered one. */
export function liveAgentDeps(input: { candidateReview?: AgentDeps['candidateReview']; client: any; chooser?: NightshiftChooser; chooserError?: { code: string; message?: string }; comaBridge?: AgentDeps['comaBridge']; criticAssist?: AgentDeps['criticAssist']; secondaryJudge?: AgentDeps['secondaryJudge'];
  options: { model: boolean; coma: boolean; probeModel?: boolean; memory?: boolean; probeLimit?: number; phaseBudget?: boolean; negativeControl?: string; resume?: boolean }; runId?: string; argv: readonly string[] }): AgentDeps {
  const { options, chooser, chooserError } = input;
  return { client: input.client, chooser, probeChooser: probeChooserFor(chooser, input.argv, options.probeModel), comaBridge: input.comaBridge, executionMode: 'LIVE', memory: options.memory, probeLimit: options.probeLimit,
    phaseBudget: options.phaseBudget, criticAssist: input.criticAssist, secondaryJudge: input.secondaryJudge, modelRequested: options.model, comaRequested: options.coma, ...(input.candidateReview ? { candidateReview: input.candidateReview } : {}), ...(options.negativeControl === undefined ? {} : { negativeControl: options.negativeControl }), ...(options.resume && input.runId ? { resume: { runId: input.runId } } : {}),
    ...(chooserError ? { chooserError: { code: chooserError.code, message: chooserError.message ?? chooserError.code } } : {}) };
}

/** `concordia agent --universe <id>`: the product's single agent path for any registered AGENT_EXPLORATION universe. */
export async function runAgentCommand(universe: string, options: { resume?: boolean; review?: string; negativeControl?: string; runId?: string; model: boolean; coma: boolean; probeModel?: boolean; maxTokens?: number; memory?: boolean; probeLimit?: number; phaseBudget?: boolean; criticAssist?: boolean; secondaryJudge?: boolean }) {
  setTokenCapOverride(options.maxTokens);
  // Model ranking of probes costs one generation per chosen probe; it is opt-in (--probe-model) and off by default.
  const manifest = resolveUniverseManifest(universe);
  if (!manifest) throw new SafeError('INVALID_UNIVERSE');
  // R-03: a local-files universe has no remote source and no model: it always runs over its own rows, never reads .env or the ledger.
  if (manifest.source.adapterId === 'local-files') return runOfflineAgentCommand(universe, { resume: options.resume, review: options.review, negativeControl: options.negativeControl, runId: options.runId, memory: options.memory, probeLimit: options.probeLimit, phaseBudget: options.phaseBudget });
  loadLocalEnv();
  const runId = options.runId ?? `agent-${manifest.aliases[0].toLowerCase()}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const catalog = catalogOf(universeConfig(universe));
  let chooser: NightshiftChooser | undefined, chooserError: { code: string; message?: string } | undefined, nightshift: Nightshift | undefined;
  if (options.model) {
    if (!catalog) chooserError = { code: 'EXPLORATION_CATALOG_REQUIRED' };
    else try { nightshift = new Nightshift(); chooser = new NightshiftChooser(nightshift, runId, catalog, GENERIC_CODE_PREFIX); } catch (error) { chooserError = failure(error); }
  }
  if (nightshift) await preflightModelGateway(nightshift);
  assertModelFlags({ chooser: !!chooser, chooserError, probeModel: options.probeModel || process.argv.includes('--probe-model'), criticAssist: options.criticAssist, secondaryJudge: options.secondaryJudge });
  // The assisted critic needs a model: requested without one it already failed above.
  let criticAssist: AgentDeps['criticAssist'];
  if (options.criticAssist) { try { criticAssist = { chooser: new NightshiftAssistChooser(new Nightshift()) }; } catch (error) { throw new SafeError(failure(error).code ?? 'CRITIC_ASSIST_UNAVAILABLE', undefined, '--critic-assist'); } }
  // The secondary judge needs a model too (same rule).
  let secondaryJudge: AgentDeps['secondaryJudge'];
  if (options.secondaryJudge) { try { secondaryJudge = { judge: new NightshiftSecondaryJudge(new Nightshift()) }; } catch (error) { throw new SafeError(failure(error).code ?? 'SECONDARY_JUDGE_UNAVAILABLE', undefined, '--secondary-judge'); } }
  // Fail closed before the first SQL when the universe needs the model review and there is no model.
  const review = candidateReviewFor(universe, { offline: false, nightshift: options.model ? nightshift : undefined, cause: chooserError });
  const python = path.join(ROOT, '.concordia', 'python', 'coma-valentine-1.1.0', 'Scripts', 'python.exe');
  const comaBridge = options.coma && fs.existsSync(python) ? createInstalledComaBridge(python, ROOT) : undefined;
  const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const before = readBudget(), beforePrefix = sha(before.attempts);
  const report = await withReview(universe, options.review, () => runAgent(universe, runId, liveAgentDeps({ runId, candidateReview: review.review, client: liveClientFor(universe), chooser, chooserError, comaBridge, criticAssist, secondaryJudge, options, argv: process.argv })));
  const after = readBudget();
  const ledger = { attemptsBefore: before.consumed, attemptsAfter: after.consumed, attemptsAdded: after.consumed - before.consumed, priorAttemptsPreserved: sha(after.attempts.slice(0, before.attempts.length)) === beforePrefix };
  const summary = { status: report.status, runId, universeId: report.universeId, report: `.concordia/agent-runs/${runId}/engine-run.json`, probes: report.phases?.probes?.selected ?? [], probeSelection: report.probeSelection?.mode ?? null, ...liveSummaryFields(report),
    decisions: report.decisions ?? [], budget: report.budget, ledger, chooserError: chooserError ?? null, review: options.review ?? null, negativeControl: options.negativeControl ?? null, reviewMode: review.reviewMode, candidateReview: report.phases?.candidateReview?.status ?? review.status };
  console.log(JSON.stringify(summary));
  for (const line of [...runWarnings(report, options.model), ...runNotes(report)]) console.error(line);
  process.exitCode = liveExitCode(report, options.model, ledger.priorAttemptsPreserved);
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
  const record = await continueAgentExploration(universe, runId, { client: liveClientFor(universe), chooser: new NightshiftChooser(new Nightshift(), runId, catalog, GENERIC_CODE_PREFIX) }, attempt);
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
export async function runOfflineAgent(universe: string, options: { resume?: boolean; review?: string; negativeControl?: string; runId?: string; memory?: boolean | { dir?: string }; probeLimit?: number; phaseBudget?: boolean }) {
  const manifest = resolveUniverseManifest(universe);
  if (!manifest) throw new SafeError('INVALID_UNIVERSE');
  const fixture = agentFixtures().find(item => manifest.aliases.some(alias => alias.toUpperCase() === item.alias.toUpperCase()));
  if (!fixture) throw new SafeError('NO_OFFLINE_FIXTURE');
  const runId = options.runId ?? `agent-${manifest.aliases[0].toLowerCase()}-offline-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const reviewer = candidateReviewFor(universe, { offline: true });
  const report = await withReview(universe, options.review, () => runAgent(universe, runId, { ...offlineAgentDeps(universe, fixture, new FixtureScriptChooser([...fixture.chooserScript])), ...(reviewer.review ? { candidateReview: reviewer.review } : {}), memory: options.memory, probeLimit: options.probeLimit, phaseBudget: options.phaseBudget, critic: true, ...(options.negativeControl === undefined ? {} : { negativeControl: options.negativeControl }), ...(options.resume ? { resume: { runId } } : {}) }));
  const summary = { status: report.status, runId, universeId: report.universeId, mode: 'OFFLINE_FIXTURE', dataOrigin: 'SYNTHETIC', report: `.concordia/agent-runs/${runId}/engine-run.json`, probes: report.phases?.probes?.selected ?? [], decisions: report.decisions ?? [], budget: report.budget,
    modelParticipation: report.modelParticipation ?? null, degradations: report.degradations ?? [], review: options.review ?? null, negativeControl: options.negativeControl ?? null,
    reviewMode: reviewer.reviewMode, candidateReview: report.phases?.candidateReview?.status ?? reviewer.status };
  return { report, summary };
}

export async function runOfflineAgentCommand(universe: string, options: { resume?: boolean; review?: string; negativeControl?: string; runId?: string; memory?: boolean; probeLimit?: number; phaseBudget?: boolean }) {
  const { report, summary } = await runOfflineAgent(universe, options);
  console.log(JSON.stringify(summary));
  for (const line of [...runWarnings(report, false), ...runNotes(report)]) console.error(line);
  process.exitCode = SUCCESS_STATUSES.includes(report.status) ? 0 : 1;
  return summary;
}
