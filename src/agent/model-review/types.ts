/**
 * Round 9 piece R: review built into the agent. Contract of the model reviewer (X8). Judges evaluate each candidate relation from its bounded evidence;
 * an adversarial pass then attacks those evaluations (homonyms, insufficient keys, siblings, inverted orientation). The output is one review per relation:
 * accept / defer / reject, with reasons and the attacks it survived.
 *
 * Binding invariants (RONDA9_PLAN_EJECUCION_20261025):
 *  1. The origin of every review here is `MODEL_REVIEWED`. It is never `HUMAN_REVIEWED`; X5 seals it in claim and memory, X3 declares which mode a universe requires.
 *  2. Honest labeling: MODEL_REVIEW_LABEL ("revisado por modelo con pase adversarial"), and only when the adversarial pass completed. Never "validated".
 *  3. Full traceability: every evaluation and attack, prompts by hash, raw responses and tokens, stay in the review run.
 *  4. This module only ever reads evidence and lowers: the evidence floors cap what a model may accept, and the adversarial pass can only lower a decision.
 *  5. No gold at runtime. The human F-04 labels are an offline evaluation set (evaluation.ts takes them as an argument; nothing here imports them).
 */
import type { Receipt } from '../../clients/nightshift.ts';

/** Same string X3's `ReviewOrigin` uses (src/registry/review-mode.ts); declared here so this module has no dependency on that file. */
export const MODEL_REVIEWED = 'MODEL_REVIEWED' as const;
export type ModelReviewOrigin = typeof MODEL_REVIEWED;
export const MODEL_REVIEW_LABEL = 'revisado por modelo con pase adversarial';
/** Used when the adversarial pass did not run or did not complete (nothing to attack, budget, failure): the review must not be labelled as adversarial. */
export const MODEL_REVIEW_LABEL_NO_ADVERSARIAL = 'revisado por modelo (sin pase adversarial)';
export const MODEL_REVIEW_PROMPT_VERSION = 'model-review-prompts-v4';
export const MODEL_REVIEW_SCHEMA_VERSION = 1 as const;

/** LIVE_MODEL: generations came from the model client. STAND_IN_OFFLINE: scripted stand-in; it proves the plumbing, never counts as a model review in a live run. */
export type ReviewProvenance = 'LIVE_MODEL' | 'STAND_IN_OFFLINE';

export type Decision = 'accept' | 'defer' | 'reject';
export const DECISIONS: readonly Decision[] = ['reject', 'defer', 'accept'];
/** reject < defer < accept. Everything that combines decisions takes the lower rank. */
export const decisionRank = (decision: Decision) => DECISIONS.indexOf(decision);
export const lowerOf = (a: Decision, b: Decision): Decision => (decisionRank(a) <= decisionRank(b) ? a : b);
export type Confidence = 'low' | 'medium' | 'high';
export const CONFIDENCES: readonly Confidence[] = ['low', 'medium', 'high'];
export const lowerConfidence = (a: Confidence, b: Confidence): Confidence => (CONFIDENCES.indexOf(a) <= CONFIDENCES.indexOf(b) ? a : b);

/** Closed vocabulary: a judge cites codes, not free claims. The rationale text is bounded and never a verdict. */
export const REASON_CODES = [
  'NAME_ENTITY_MATCH', 'NAME_ENTITY_MISMATCH', 'NAME_AMBIGUOUS',
  'KEY_MEMBERSHIP_COMPLETE', 'KEY_MEMBERSHIP_PARTIAL', 'KEY_MEMBERSHIP_CONTRADICTED',
  'INSUFFICIENT_DISTINCT_KEYS', 'AT_MINIMUM_KEYS', 'TARGET_UNIQUE_IN_SAMPLE', 'TARGET_NOT_UNIQUE',
  'ORIENTATION_CONSISTENT', 'ORIENTATION_DOUBTFUL', 'HOMONYM_RISK', 'SIBLINGS_WEAKER', 'SIBLING_BETTER_MATCH', 'EVIDENCE_NOT_DISCRIMINATING', 'ONE_TO_ONE_EXTENSION',
  'LABELS_AGREE', 'LABELS_CONFLICT', 'SEMANTICS_NOT_ESTABLISHED', 'NO_EVIDENCE'
] as const;
export type ReasonCode = typeof REASON_CODES[number];
/**
 * Reasons that argue AGAINST an accept. A judge that accepts must not cite one: the parser refuses such a response (the live NWCH run showed judges citing
 * SIBLING_BETTER_MATCH inside an accept to mean "this one beats its siblings"; that meaning has its own code, SIBLINGS_WEAKER).
 */
export const BLOCKING_REASON_CODES: readonly ReasonCode[] = ['NAME_ENTITY_MISMATCH', 'KEY_MEMBERSHIP_CONTRADICTED', 'INSUFFICIENT_DISTINCT_KEYS', 'TARGET_NOT_UNIQUE', 'LABELS_CONFLICT', 'NO_EVIDENCE', 'HOMONYM_RISK', 'SIBLING_BETTER_MATCH'];
export const isReasonCode = (value: unknown): value is ReasonCode => typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value);

/** The four attack families of the human F-04 process, plus nothing else: the adversary must answer each one. */
export const ATTACK_FAMILIES = ['HOMONYM', 'INSUFFICIENT_KEYS', 'SIBLING', 'INVERTED_ORIENTATION'] as const;
export type AttackFamily = typeof ATTACK_FAMILIES[number];
/** Round 10 E5-03: INSUFFICIENT_KEYS and INVERTED_ORIENTATION are computed from the packet (deterministic-attacks.ts); the adversary model argues only these two. */
export const MODEL_ATTACK_FAMILIES = ['HOMONYM', 'SIBLING'] as const satisfies readonly AttackFamily[];
export const DETERMINISTIC_ATTACK_FAMILIES = ['INSUFFICIENT_KEYS', 'INVERTED_ORIENTATION'] as const satisfies readonly AttackFamily[];
export type AttackSeverity = 'none' | 'minor' | 'blocking';
export type AttackRecommend = 'keep' | 'defer' | 'reject';

// ---------------------------------------------------------------- evidence packet
export interface Endpoint { table: string; column: string }
export interface KeyStats { rows: number; distinctKeys: number; maxRowsPerKey: number }
/**
 * Where the distinct source keys were counted: the bounded discovery sample, or the global distinct keys the widened read (F4) took from the source column.
 * The minimum of distinct keys is the same for both; the basis only says what the count is a count of.
 */
export type SourceKeysBasis = 'DISCOVERY_SAMPLE' | 'GLOBAL_DISTINCT_F4';
export const SOURCE_KEYS_BASES: readonly SourceKeysBasis[] = ['DISCOVERY_SAMPLE', 'GLOBAL_DISTINCT_F4'];
export const SOURCE_KEYS_BASIS_TEXT: Record<SourceKeysBasis, string> = { DISCOVERY_SAMPLE: 'discovery sample', GLOBAL_DISTINCT_F4: 'global distinct keys read with F4' };
/** `basis` is always set by `buildPackets`; a packet built by hand without it is read as the discovery sample. */
export interface SourceKeyStats extends KeyStats { basis?: SourceKeysBasis }
export const sourceKeysBasisText = (stats: SourceKeyStats): string => SOURCE_KEYS_BASIS_TEXT[stats.basis ?? 'DISCOVERY_SAMPLE'];
/** Whole-table uniqueness of a column, when it was measured (F1). A column that is NOT_UNIQUE cannot be the target of a foreign key. Absent = not measured. */
export type GlobalUniqueness = 'UNIQUE' | 'NOT_UNIQUE';
export interface SiblingInfo {
  relationId: string;
  /** Which endpoint of the reviewed relation the sibling shares. */
  shares: 'SOURCE' | 'TARGET';
  other: Endpoint;
  /** Global uniqueness of the sibling's TARGET column (when `shares` is SOURCE, `other` is that target). */
  otherGlobalUniqueness?: GlobalUniqueness;
  executed: boolean;
  coverage?: { matched: number; probed: number };
  /** E2-04: the sibling shares this relation's TARGET and comes from the SAME source table (sold/ship/return date -> date_dim). A role of one dimension, not a competing alternative. */
  role?: true;
}
/** E3-04: Wilson score interval (95%) of the sample coverage. Annotation only: no floor or policy reads it. */
export interface WilsonBound { lower: number; upper: number; confidence: 0.95; method: 'wilson' }
/** E2-04: columns of the source table that point at the same target column. */
export interface RoleDimension { target: Endpoint; sourceColumns: string[] }
/**
 * Tie-break of the sibling group (this relation plus the candidates that share its SOURCE), computed by the pure functions of src/agent/tie-break.ts (X10) and handed in by the caller.
 * What the prompt carries is COMPACT by default (the full vector of every sibling cost +56% tokens at the TPCDS ceiling): who won, whether it is decisive, the step that decided it with
 * the winner's and the runner-up's value, and which listed siblings are still tied. The full ordering and vectors stay in the review (`ModelReview.tieBreak`), not in the prompt.
 * `decisive` with `winner` = THIS resolves the tie by structure; otherwise the tie stands (defer).
 */
export type TieBreakMode = 'compact' | 'full';
export interface TieBreakInfo {
  decisive: boolean;
  /** THIS: the relation under review. `siblings[i]`: the winner is that listed sibling. OTHER: a sibling that is not listed (the list is capped). */
  winner?: string;
  /** Stable code only (DECIDED_BY_NAME_VS_TABLE, NOT_DECISIVE, ...). The sentence is in the audit. */
  reason: string;
  /** The step that left one survivor, with the value of the winner and of the runner-up in that step (strings as the tie-break reports them). */
  decidedBy?: string;
  values?: { winner: string; runnerUp: string };
  /** Indexes into `siblings` of the candidates that stay tied with this relation (only when the tie-break lists them). */
  tiedWith?: number[];
  mode: TieBreakMode;
  /** Only in mode 'full': the whole group, the order, the sentence and the flattened traits of every member. */
  full?: { group: string[]; ordered: string[]; sentence: string; vectors?: Record<string, Record<string, string | number | boolean | null>> };
}
/** The whole tie-break for the audit trail (review record, overlay): never reduced, never in the prompt unless mode is 'full'. */
export interface TieBreakAudit {
  group: string[];
  ordered: string[];
  decisive: boolean;
  winner?: string;
  reason: string;
  decidedBy?: string;
  values?: { winner: string; runnerUp: string };
  tied?: string[];
  vectors?: Record<string, Record<string, string | number | boolean | null>>;
  /** The resolver's own detail (X10: raw vectors and trace), bounded. */
  detail?: unknown;
  guard?: string;
}
/** The packet trait for a pair whose two ends are both unique over the whole table (X4: ONE_TO_ONE_EXTENSION, an evidence trait, not a suspicion). */
export interface OneToOneTrait { globalUniqueness: { source: GlobalUniqueness | 'NOT_MEASURED'; target: GlobalUniqueness | 'NOT_MEASURED' }; meaning: string }
export const ONE_TO_ONE_MEANING = 'Both ends are unique over the whole table. This may be a one-to-one extension of the same entity (not a foreign key) or a foreign key whose column happens to be unique; uniqueness cannot say which, and the direction is the one COMA proposed. The names decide. Not a reason to reject on its own.';
/** Result of probing an ALTERNATIVE target (or source) for the same endpoint, e.g. a decoy. `passedMembership` true means key membership did not discriminate. */
export interface NegativeControlEntry {
  id: string;
  shares: 'SOURCE' | 'TARGET';
  other: Endpoint;
  passedMembership?: boolean;
  hypotheticalVerdict?: string;
  outcome?: string;
}
/** What a judge may see. Counts and names only: no sampled key values, no row content. */
export interface ReviewPacket {
  relationId: string;
  universeId?: string;
  source: Endpoint & { tableColumns?: string[] };
  target: Endpoint & { tableColumns?: string[]; /** Global uniqueness of this relation's target column, when measured. */ globalUniqueness?: GlobalUniqueness };
  orientation: 'AS_PROPOSED' | 'SWAPPED_TARGET_UNIQUE' | 'UNKNOWN';
  coverage: { level: 'HIGH' | 'LOW' | 'NONE'; matched: number; probed: number; threshold: number | null; /** 95% interval of matched/probed: 5/5 is not 49/49. */ wilson?: WilsonBound };
  sourceKeys: SourceKeyStats;
  targetKeys: KeyStats;
  keyRules: { inclusion: 'NO_VIOLATION_IN_SAMPLE' | 'VIOLATION_OBSERVED' | 'UNKNOWN'; missingCount: number; targetUniqueness: 'NO_DUPLICATES_IN_SAMPLE' | 'DUPLICATES_OBSERVED' | 'UNKNOWN'; duplicateKeyCount: number };
  structure?: { sourceShape: string; targetShape: string; rankClass: string; targetDeclaredKey: boolean };
  labels: { signal: 'LABEL_CONFLICT' | 'LABEL_UNCERTAIN' | 'LABELS_AGREE' | 'NOT_COMPARABLE'; agree?: number; compared?: number };
  /** Present when the post-COMA diagnostic flagged the candidate (e.g. COMPETING_TARGET with the preferred target). Normally such candidates are not reviewed; this is for callers that choose to. */
  suspect?: { reasons: string[]; preferredTarget?: string };
  /** Outcome of the typed critic counterprobe, when the relation went through one. Information for the judges; the floor does not read it. */
  critic?: { status: string };
  minDistinctKeys: number;
  siblings: SiblingInfo[];
  /** Present when other columns of the source table point at the same target column (E2-04). */
  roles?: RoleDimension;
  /** Present when the caller supplied the tie-break for the sibling group (E2-01/X10). */
  tieBreak?: TieBreakInfo;
  /** E2-02/X4: both ends globally unique. Evidence for the judges and the adversary, never a block on its own. */
  oneToOne?: OneToOneTrait;
  negativeControl: NegativeControlEntry[];
  limitations: string[];
}
/** A candidate that has no usable probe evidence: it is never sent to a model. */
export interface UnprobedCandidate { relationId: string; source: Endpoint; target: Endpoint; reason: string }

// ---------------------------------------------------------------- model calls and trace
/** How the answer reached us: the arguments of the forced tool call (E5-02), or the message text. */
export type CallTransport = 'TOOL_CALL' | 'TEXT';
/** R10b: the run-level label of the transport of the roles: one value when judges and adversary share it, MIXED when they differ. */
export type RunTransport = CallTransport | 'MIXED';
export interface ReviewCall { status: string; responseText?: string; receipt?: Receipt; error?: object; /** The model stopped at the output-token cap: the response is cut and will not parse. */ truncated?: boolean; /** Set by live clients: the answer came as tool-call arguments or as message text. */ transport?: CallTransport }
export interface ModelMessage { role: 'system' | 'user'; content: string }
/** One model behind one role. `kind` marks a stand-in so it can never pass for a live model. */
export interface ReviewModel {
  readonly id: string;
  readonly kind: ReviewProvenance;
  /** Route or model name asked for (recorded with every call); the model that answered is in the receipt. */
  readonly requestedModel?: string;
  /** How this client gets the answer (live clients only): the arguments of a forced tool call, or the message text. */
  readonly transport?: CallTransport;
  /** `stage` lets a client add what only it sends (the tool schema of a forced tool call). */
  estimateTokens(messages: readonly ModelMessage[], maxOutputTokens: number, stage?: TraceStage): number;
  complete(messages: readonly ModelMessage[], options: { maxOutputTokens: number; stage?: TraceStage }): Promise<ReviewCall>;
}

export type TraceStage = 'EVALUATION' | 'ATTACK';
export interface ReceiptSummary { receiptId: string; provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number }
export interface ReviewTraceEvent {
  kind: 'model-review-start' | 'model-review-progress' | 'model-review-call' | 'model-review-parse' | 'model-review-decision' | 'model-review-run';
  stage?: TraceStage;
  relationId?: string;
  /** Judge id (EVALUATION) or adversary id (ATTACK). */
  actor?: string;
  promptVersion?: string;
  /** sha256 of the exact messages sent. The prompts themselves are not stored. */
  promptHash?: string;
  requestedModel?: string;
  /** Tool-call arguments or message text; absent for stand-ins. */
  transport?: CallTransport;
  /** The model hit the output-token cap: the response is cut. */
  truncated?: boolean;
  estimatedTokens?: number;
  callStatus?: 'PASS' | 'FAIL' | 'SKIPPED_BUDGET' | 'SKIPPED_BY_CASCADE';
  parseStatus?: 'VALID' | 'INVALID' | 'NOT_PARSED';
  /** R10b: fields of a tool call read one level decoded (`attacks:json-string`); only on a parse that came out VALID. */
  normalized?: string[];
  /** Raw response text, bounded. Kept verbatim so every evaluation and attack can be audited. */
  responseText?: string;
  tokens?: number;
  receipt?: ReceiptSummary;
  error?: object;
  detail?: object;
}

// ---------------------------------------------------------------- evaluations, attacks, reviews
/** Tokens, receipt, requested model and raw response (bounded) of one generation. */
export interface CallRecord { status: 'PASS' | 'FAIL' | 'SKIPPED_BUDGET' | 'SKIPPED_BY_CASCADE'; requestedModel?: string; transport?: CallTransport; tokens: number; /** Output-token cap of the call, and whether the model hit it. */ maxOutputTokens?: number; truncated?: boolean; receipt?: ReceiptSummary; responseText?: string; /** R10b: fields of the tool-call arguments that came as a JSON string and were read decoded, e.g. `attacks:json-string`. Set only when the answer then parsed; the response text stays verbatim. */ normalized?: string[] }
export interface Evaluation {
  judgeId: string;
  status: 'VALID' | 'INVALID' | 'CALL_FAILED' | 'SKIPPED_BUDGET' | 'SKIPPED_BY_CASCADE';
  decision?: Decision;
  confidence?: Confidence;
  reasonCodes: ReasonCode[];
  rationale?: string;
  /** Deterministic flags on the response text (e.g. appeal to the public benchmark instead of the packet). */
  flags: string[];
  promptHash?: string;
  /** The generation behind this record, kept on the record itself so a report never has to join against the trace. */
  call?: CallRecord;
  /** Tokens of the generation (also in `call.tokens`), flat for readers that sum by evaluation. */
  tokens?: number;
}
export type AttackOutcomeKind = 'NO_ATTACK' | 'SURVIVED' | 'SUSTAINED' | 'UNGROUNDED' | 'REFUTED';
export interface AttackRecord {
  family: AttackFamily;
  severity: AttackSeverity;
  recommend: AttackRecommend;
  argument: string;
  evidenceRefs: string[];
  /** DETERMINISTIC: computed from the packet (no model call). MODEL: argued by the adversary. */
  source?: 'DETERMINISTIC' | 'MODEL';
  /** Share of the adversary call's tokens: the single call is split evenly over the four attack records (remainder to the first), so a sum over attacks equals the call's tokens. */
  tokens?: number;
  /** NO_ATTACK: none found. SURVIVED: raised but the evaluations stand. SUSTAINED: lowered the decision. UNGROUNDED: cited evidence that is not in the packet; discarded. REFUTED: a SIBLING attack whose cited siblings are all excluded by measured evidence (target NOT globally unique), are roles of one dimension (E2-04) or lose a decisive tie-break to this relation; discarded. */
  outcome: AttackOutcomeKind;
}
export interface AdversaryRecord {
  actor: string;
  /** NOT_NEEDED: no judge accepted, so there was nothing to attack (and nothing an attack could raise). */
  status: 'COMPLETED' | 'INVALID' | 'CALL_FAILED' | 'SKIPPED_BUDGET' | 'SKIPPED_BY_CASCADE' | 'NOT_NEEDED';
  attacks: AttackRecord[];
  promptHash?: string;
  /** The generation behind this record, kept on the record itself so a report never has to join against the trace. */
  call?: CallRecord;
  /** Tokens of the whole adversary call. */
  tokens?: number;
}
export type AdversarialPass = 'COMPLETED' | 'NOT_NEEDED' | 'INCOMPLETE' | 'NOT_RUN';

export interface FloorResult { cap: Decision; reasons: ReasonCode[]; annotations: ReasonCode[]; notes: string[] }

export interface ModelReview {
  schemaVersion: typeof MODEL_REVIEW_SCHEMA_VERSION;
  kind: 'MODEL_ADVERSARIAL_REVIEW';
  origin: ModelReviewOrigin;
  provenance: ReviewProvenance;
  label: string;
  relationId: string;
  from: Endpoint;
  to: Endpoint;
  decision: Decision;
  confidence: Confidence;
  reasons: ReasonCode[];
  notes: string[];
  floor: FloorResult;
  evaluations: Evaluation[];
  adversary: AdversaryRecord;
  adversarialPass: AdversarialPass;
  /** Attacks that were raised and the decision still stood (the "attacks it survived"). */
  attacksSurvived: AttackRecord[];
  attacksSustained: AttackRecord[];
  /** Always true: a review is a bounded-sample judgment, not a global claim and not a human review. */
  boundedSampleOnly: true;
  humanReviewed: false;
  calls: number;
  tokens: number;
  /** The whole tie-break of the sibling group, when the caller supplied one (the prompt carried the compact form). */
  tieBreak?: TieBreakAudit;
}

export interface ModelReviewConfig {
  /** E5-01 cheap cascade (default false until the integration measures it): judge A first; the other judges and the adversary only if every judge before accepted. A skipped call is recorded as SKIPPED_BY_CASCADE. */
  cascade?: boolean;
  /** ACCEPTED_ONLY (default): the adversary runs when at least one judge accepted. ALL: every evaluated relation. NONE: no adversarial pass (offline ablation; reviews are then labelled without it and never satisfy MODEL_ADVERSARIAL). */
  attackScope?: 'ACCEPTED_ONLY' | 'ALL' | 'NONE';
  minDistinctKeys: number;
  /** Output-token cap of every call (overrides the two below). The model client caps one generation at 2000. */
  maxOutputTokensPerCall?: number;
  /** Judges: default 1500. A reasoning model spends output tokens before the JSON; 400 truncated 5 of 11 live judge answers. */
  maxOutputTokensJudge?: number;
  /** Adversary: default 3000. */
  maxOutputTokensAdversary?: number;
  /** Raw responses are cut to this many characters in the trace. */
  maxTraceResponseChars?: number;
  /** C4: a `model-review-progress` event every this many counted calls (default 25; 0 turns progress events off). The start event is always emitted. */
  progressEveryCalls?: number;
}

/** E5-07. `models` are the ids the receipts report (the alias can resolve to different models: live-01 saw it), with the number of calls each answered. */
export interface ModelRoleRow {
  role: string;
  actor: string;
  requestedModel?: string;
  models: { model: string; calls: number }[];
  /** C4: the model that answered most of this role's calls, and the others that answered some (model drift inside the route). */
  effectiveModel?: string;
  drift: { model: string; calls: number }[];
  calls: number;
  invalid: number;
  callFailed: number;
  truncated: number;
  /** R10b: calls whose tool-call arguments were read one level decoded (not invalid, not retried). */
  normalizedCalls: number;
  skippedBudget: number;
  skippedByCascade: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
}
/** E5-08. `rank` starts at 1 (reviewed first). */
export interface PriorityEntry { relationId: string; rank: number; keyClass: string; targetDeclaredKey: boolean; nameAffinity: number; siblings: number; reason?: string }

/** C4: what the review is about to do, emitted before the first call. Calls are bounds (the cascade and the model answers decide where between them the run lands); tokens use the live per-call figure. */
export interface ReviewStartDetail {
  candidates: number;
  /** Candidates with probe evidence that reach this stage / candidates that never reach a model. */
  relations: number;
  notEvaluated: number;
  judges: number;
  attackScope: string;
  cascade: boolean;
  transport: RunTransport;
  /** R10b: the transport of each role. */
  transports: { judges: CallTransport; adversary: CallTransport };
  /** The evidence floor already decides these: no call. */
  floorRejected: number;
  evaluated: number;
  /** Evaluated relations whose floor is accept: the adversary may run. Of those, the ones a packet attack already sustains need no adversary call. */
  attackEligible: number;
  decidedByPacket: number;
  calls: { minimum: number; maximum: number };
  tokensPerCall: number;
  projectedTokens: { minimum: number; maximum: number; upperBound: number };
  tokenBudget?: { used: number; limit: number };
  progressEveryCalls: number;
  promptVersion: string;
  /** N2: relations whose rejection or deferral came from the review decision memory (no call). Present only when a memory was supplied; `relations` and the bounds above exclude them. */
  reusedNegative?: number;
}
/** C4: which model answered which role, and how far the route drifted from one model. */
export interface ModelDrift {
  /** Every call of every role was answered by one model. */
  homogeneous: boolean;
  models: { model: string; calls: number }[];
  /** Calls answered by a model other than the role's dominant one, over all calls with a receipt. */
  driftedCalls: number;
  receiptCalls: number;
  perRole: { role: string; requestedModel?: string; effectiveModel?: string; calls: number; drifted: { model: string; calls: number }[] }[];
  /** Pinning a model per role is proposed (PROPUESTAS_X8) and not active. */
  pinned: false;
}

export interface ModelReviewRun {
  schemaVersion: typeof MODEL_REVIEW_SCHEMA_VERSION;
  kind: 'MODEL_ADVERSARIAL_REVIEW_RUN';
  origin: ModelReviewOrigin;
  provenance: ReviewProvenance;
  label: string;
  promptVersion: string;
  config: { judges: number; attackScope: string; minDistinctKeys: number; maxOutputTokensJudge: number; maxOutputTokensAdversary: number; cascade: boolean };
  status: 'COMPLETE' | 'PARTIAL_BUDGET' | 'EMPTY';
  reviews: ModelReview[];
  /** E5-07: one row per role (judge-a, judge-b, ..., adversary) with the real model id from the receipts and the call counts. */
  modelTable: ModelRoleRow[];
  /** C4: effective model per role and the drift of the route. */
  modelDrift: ModelDrift;
  /** C4: the start event's detail, kept in the run so the overlay shows what the review set out to do. */
  start: ReviewStartDetail;
  /** E5-08: the order the relations were reviewed in (structure first) and, when the budget cut the run, the ones left without a full review, each with its rank. */
  priority: { order: PriorityEntry[]; skipped: PriorityEntry[] };
  /** Candidates that never reached a model (no probe evidence). They carry a defer decision with the reason. */
  notEvaluated: { relationId: string; decision: 'defer'; reason: string }[];
  /** N2: rejections and deferrals taken from the review decision memory instead of a model call (same evidence fingerprint and prompt version). Absent without a memory. */
  reusedDecisions?: ReusedReviewDecision[];
  /** N2: what the memory did in this run (lookups, hits, claims refused, decisions recorded, errors swallowed). Absent without a memory. */
  decisionMemory?: DecisionMemoryActivity;
  counts: { reusedNegative?: number; reusedNegativeCallsAvoided?: number; reusedNegativeTokensAvoided?: number; relations: number; accept: number; defer: number; reject: number; calls: number; tokens: number; skippedBudget: number; skippedByCascade: number; /** Estimated tokens of the calls the cascade did not make. */ cascadeEstimatedTokensAvoided: number; /** The same calls valued at the mean tokens per call this run measured for the same stage (the live figure), not at the upper-bound estimate. */ cascadeTokensAvoidedObserved: number; adversarialCompleted: number };
  trace: ReviewTraceEvent[];
  /** Judges and adversary answered from receipts of the same model: the self-preference caveat of the secondary judge applies. */
  sameModelAcrossRoles?: boolean;
  limitations: string[];
}

// ---------------------------------------------------------------- N2: negative review memory
/** Reason the reviewer assigns to a decision it took from memory. Not part of REASON_CODES: a model can neither cite it nor be offered it in a tool schema. */
export const REUSED_REVIEW_DECISION_REASON = 'REUSED_REVIEW_DECISION_FROM_MEMORY' as const;
/**
 * What the memory holds for one relation. Only a rejection or a deferral is ever reused: a claim whose decision is `accept` (or anything else) is ignored,
 * because approvals come back through the existing reuse of MODEL_REVIEWED SOSTENIDA contracts and never from here.
 */
export interface ReviewDecisionClaim {
  decision: Decision;
  evidenceFingerprint: string;
  promptVersion: string;
  /** The reason codes the original review gave. */
  reasons: readonly string[];
  confidence?: Confidence;
  origin?: ModelReviewOrigin;
  provenance?: ReviewProvenance;
  /** What the original review cost, so the saving can be reported with its own figures. */
  calls?: number;
  tokens?: number;
  /** The run that recorded it: `recordedRunId`, or `runId` as the engine's ledger names it. */
  recordedRunId?: string;
  runId?: string;
}
/** One new rejection or deferral the review hands to the memory when it ends. */
export interface ReviewDecisionRecord {
  relationId: string;
  decision: 'reject' | 'defer';
  evidenceFingerprint: string;
  promptVersion: string;
  reasons: ReasonCode[];
  confidence: Confidence;
  origin: ModelReviewOrigin;
  provenance: ReviewProvenance;
  /** The models that answered for this relation (from the receipts), and the ones asked for. */
  models: string[];
  requestedModels: string[];
  config: { judges: number; attackScope: string; cascade: boolean };
  calls: number;
  tokens: number;
}
/** The dependency the reviewer takes (X5 implements it and wires it in the engine). `lookup` returns null when nothing valid is held. */
export interface ReviewDecisionMemory {
  lookup(relationId: string, evidenceFingerprint: string, promptVersion: string): ReviewDecisionClaim | null;
  record(decisions: ReviewDecisionRecord[]): void;
}
/** A relation whose decision came from memory: 0 calls, origin MODEL_REVIEWED, reasonCode REUSED_REVIEW_DECISION_FROM_MEMORY. */
export interface ReusedReviewDecision {
  relationId: string;
  from: Endpoint;
  to: Endpoint;
  decision: 'reject' | 'defer';
  reasonCode: typeof REUSED_REVIEW_DECISION_REASON;
  /** The reasons of the original review. */
  originalReasons: string[];
  confidence?: Confidence;
  origin: ModelReviewOrigin;
  evidenceFingerprint: string;
  promptVersion: string;
  calls: 0;
  tokens: 0;
  /** What the call(s) this reuse spared cost, as the original review reported (or the planning figure when the claim does not say). */
  callsAvoided: number;
  tokensAvoided: number;
  /** Where tokensAvoided comes from: the claim's own figures, this run's measured mean per judge call, or the planning figure (no live call to measure). */
  tokensBasis: 'CLAIM' | 'OBSERVED_THIS_RUN' | 'PLANNING';
  recordedRunId?: string;
}
export interface DecisionMemoryActivity { lookups: number; hits: number; ignoredClaims: number; recorded: number; errors: string[] }

/**
 * The only test X5/X3 should use for a MODEL_ADVERSARIAL slot: a model review that accepted, with a completed adversarial pass, from a live model.
 * Never true for a stand-in, for an incomplete pass, or for a defer/reject.
 */
export function satisfiesModelAdversarialSlot(review: Pick<ModelReview, 'origin' | 'provenance' | 'decision' | 'adversarialPass'>): boolean {
  return review.origin === MODEL_REVIEWED && review.provenance === 'LIVE_MODEL' && review.decision === 'accept' && review.adversarialPass === 'COMPLETED';
}
