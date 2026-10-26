/**
 * Factory of the R-1 reviewer the engine takes as `AgentDeps.candidateReview` (src/agent/model-review-contract.ts): a closure over `reviewBlindCandidates` with its judges,
 * adversary and thresholds. The engine never holds a model client; the caller (the CLI) builds this with the agent's own model client or with the offline stand-in.
 *
 *   createCandidateReview({ model: nightshift, thresholds })      live: the agent's Nightshift client, 2 judges + 1 adversary (own roles, optionally another route)
 *   createCandidateReview({ standIn: true, thresholds })          offline: scripted stand-ins; refused in a LIVE run
 *   createCandidateReview({ judges, adversary, thresholds })      explicit models (tests, other clients)
 */
import type { Nightshift } from '../../clients/nightshift.ts';
import type { CandidateReview, CandidateReviewRequest } from '../model-review-contract.ts';
import { reviewBlindCandidates } from './candidates.ts';
import type { ContractDefaults } from './contract.ts';
import type { PacketContext, ProbedProposalInput, TieBreakResolver } from './evidence.ts';
import { NightshiftReviewModel } from './nightshift-model.ts';
import { standInAdversary, standInJudge } from './standin.ts';
import type { GlobalUniqueness, ModelReviewConfig, ReviewDecisionMemory, ReviewModel, ReviewTraceEvent, TieBreakMode } from './types.ts';

export interface CandidateReviewOptions {
  /** Live: the agent's model client. Judges are `judge-a`, `judge-b`, ... on the client's route; the adversary may use another route. */
  model?: Nightshift;
  /** Offline: scripted stand-ins (semantic judges + adversary). Never accepted in a LIVE run. */
  standIn?: boolean;
  /** Explicit models; both are required together and override `model` / `standIn`. */
  judges?: readonly ReviewModel[];
  adversary?: ReviewModel;
  /** Independent judges when the models are built here (1-3, default 2). */
  judgeCount?: number;
  /** Route for the adversary when it should not share the judges' model. */
  adversaryRoute?: string;
  /** Only `minDistinctKeys` is read (config/thresholds.json); pass the whole object. */
  thresholds: { minDistinctKeys: number };
  config?: Pick<ModelReviewConfig, 'attackScope' | 'cascade' | 'maxOutputTokensPerCall' | 'maxOutputTokensJudge' | 'maxOutputTokensAdversary' | 'maxTraceResponseChars' | 'progressEveryCalls'>;
  /** C4: receives the start event, a progress event every `config.progressEveryCalls` counted calls, and every call and decision event as they happen. Also read from `request.onEvent` when the engine supplies one. */
  onEvent?: (event: ReviewTraceEvent) => void;
  /** E5-02 (confirmed by the project-owner, Round 10): the live models built here answer through a forced tool call (`tools` + `tool_choice`), the only structured-output route the gateway honours. Default 'TOOL_CALL'; 'NONE' asks for plain text (the schema costs input tokens on every call). There is no repair retry in either mode: an unparsable answer stays INVALID. */
  structuredOutput?: 'TOOL_CALL' | 'NONE';
  /** R10b: the adversary's own transport. Default 'NONE' (plain text, the R10 path that was clean live: 0 invalid of 93): its answer is a nested array of objects, and over a forced tool call the model returned it in four wrong encodings (25 of 182 invalid, the judges' flat schema 0 of 260). `structuredOutput` is the judges'. */
  adversaryStructuredOutput?: 'TOOL_CALL' | 'NONE';
  /** N2: the review decision memory: a rejection or deferral already taken on the same evidence (fingerprint) and prompt version is reused without a call; new ones are recorded. Also read from `request.reviewDecisionMemory` when the engine supplies one. Without it the review is unchanged. */
  reviewDecisionMemory?: ReviewDecisionMemory;
  /** Tie-break of a group of tied relations (ids), from the pure functions of src/agent/tie-break.ts. Also read from `request.tieBreak` when the engine supplies one. */
  tieBreak?: TieBreakResolver;
  /** What the prompt carries of the tie-break: 'compact' (default) or 'full' (audits). The review record always keeps the whole one. */
  tieBreakMode?: TieBreakMode;
  /** Alternative endpoints probed for the same columns (the negative control), as `negativeControlEntries(artifact)` builds them. */
  negativeControl?: PacketContext['negativeControl'];
  /** Contract fields the universe fixes. Default: database from the proposals, text normalization (`text-exact-v1`, `exact-text`). */
  /** Review the candidates the engine already reuses from memory (default false: they are skipped to save tokens and listed as reused). */
  reviewReusable?: boolean;
  contractDefaults?: Partial<ContractDefaults> | ((request: CandidateReviewRequest) => ContractDefaults);
}

/**
 * F1 from the engine: whole-table uniqueness of target columns, keyed `table.column` (no db). The counts (`targetGlobalUniqueness`) are the measurement and win; the verdict map
 * (`globalTargetUniqueness`) is accepted for a column the counts do not cover. A column that was not measured is absent, never UNIQUE by default.
 */
export function globalUniquenessOf(request: Pick<CandidateReviewRequest, 'targetGlobalUniqueness' | 'globalTargetUniqueness'>): Record<string, GlobalUniqueness> | undefined {
  const out: Record<string, GlobalUniqueness> = { ...(request.globalTargetUniqueness ?? {}) };
  for (const [column, counts] of Object.entries(request.targetGlobalUniqueness ?? {})) if (counts && typeof counts.unique === 'boolean') out[column] = counts.unique ? 'UNIQUE' : 'NOT_UNIQUE';
  return Object.keys(out).length ? out : undefined;
}

export function createCandidateReview(options: CandidateReviewOptions): CandidateReview {
  const count = options.judgeCount ?? 2;
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('MODEL_REVIEW_JUDGES_OUT_OF_RANGE');
  if (!options.thresholds || !Number.isInteger(options.thresholds.minDistinctKeys) || options.thresholds.minDistinctKeys < 1) throw new Error('MODEL_REVIEW_MIN_DISTINCT_KEYS_INVALID');
  const structuredOutput = options.structuredOutput ?? 'TOOL_CALL', adversaryStructuredOutput = options.adversaryStructuredOutput ?? 'NONE';
  let judges: readonly ReviewModel[], adversary: ReviewModel;
  if (options.judges || options.adversary) {
    if (!options.judges?.length || !options.adversary) throw new Error('MODEL_REVIEW_MODELS_INCOMPLETE');
    judges = options.judges; adversary = options.adversary;
  } else if (options.model) {
    judges = Array.from({ length: count }, (_, index) => new NightshiftReviewModel(`judge-${String.fromCharCode(97 + index)}`, options.model!, { structuredOutput }));
    adversary = new NightshiftReviewModel('adversary', options.model, { ...(options.adversaryRoute ? { route: options.adversaryRoute } : {}), structuredOutput: adversaryStructuredOutput });
  } else if (options.standIn) {
    judges = Array.from({ length: count }, (_, index) => standInJudge(`standin-semantic-${index + 1}`, 'SEMANTIC'));
    adversary = standInAdversary('standin-adversary');
  } else throw new Error('MODEL_REVIEW_NO_MODEL');
  if ((options.config?.attackScope ?? 'ACCEPTED_ONLY') === 'NONE') throw new Error('MODEL_REVIEW_ADVERSARIAL_PASS_REQUIRED');
  const standIn = [...judges, adversary].some(model => model.kind !== 'LIVE_MODEL');

  return async request => {
    if (standIn && request.executionMode === 'LIVE') throw Object.assign(new Error('MODEL_REVIEW_STAND_IN_IN_LIVE_RUN'), { code: 'MODEL_REVIEW_STAND_IN_IN_LIVE_RUN' });
    const proposals = request.proposals as ProbedProposalInput[];
    const onEvent = options.onEvent ?? (request as { onEvent?: (event: ReviewTraceEvent) => void }).onEvent;
    const reviewDecisionMemory = options.reviewDecisionMemory ?? (request as { reviewDecisionMemory?: ReviewDecisionMemory }).reviewDecisionMemory;
    const globalTargetUniqueness = globalUniquenessOf(request), tieBreak = options.tieBreak ?? (request as { tieBreak?: TieBreakResolver }).tieBreak;
    const defaults: ContractDefaults = typeof options.contractDefaults === 'function' ? options.contractDefaults(request) : {
      universeId: request.universeId, database: proposals.find(item => item?.from?.db)?.from.db ?? '', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text', ...options.contractDefaults };
    const result = await reviewBlindCandidates({
      proposals, universeId: request.universeId, context: { minDistinctKeys: options.thresholds.minDistinctKeys, tableColumns: request.tableColumns, ...(globalTargetUniqueness ? { globalTargetUniqueness } : {}), ...(tieBreak ? { tieBreak, tieBreakMode: options.tieBreakMode ?? 'compact' } : {}), ...(options.negativeControl ? { negativeControl: options.negativeControl } : {}) },
      judges, adversary, budget: request.budget, config: { ...options.config, minDistinctKeys: options.thresholds.minDistinctKeys }, defaults, now: request.now, runId: request.runId, allowStandIn: standIn, ...(onEvent ? { onEvent } : {}), ...(reviewDecisionMemory ? { reviewDecisionMemory } : {}), ...(request.reusable ? { reusable: request.reusable } : {}), ...(options.reviewReusable ? { reviewReusable: true } : {}) });
    return { overlay: { ...result.overlay }, contracts: result.contracts };
  };
}
