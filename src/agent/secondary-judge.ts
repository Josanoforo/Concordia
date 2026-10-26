/**
 * Optional secondary judge (R5-6), OFF by default. It acts on the ELECTOR's choice of a catalog id, never on a verdict.
 * Invoked only when (1) the flag is on, (2) the deterministic validator already accepted the id, (3) there is real ambiguity
 * (low margin, tie, or disagreement among cheap re-samples) and (4) the token pre-estimate fits. Cheap-first: free signals,
 * then k re-samples, and only then the judge. The judge sees the question and 2-4 already-valid candidates in a seeded random
 * order, blind to the elector's pick, and may only choose one of them or abstain. Its answer is re-validated against the
 * candidates. Disagreement is recorded as a NOTE (`secondaryJudge`, with its receipt); it never overwrites the elector's
 * selection, the catalog, the SQL or any verdict. Limitation to report: with a single provider the judge may share the
 * elector's self-preference; `sameModelAsElector` records when the receipts show the same model.
 */
import { createHash } from 'node:crypto';
import { NightshiftChatError, type Nightshift, type Receipt } from '../clients/nightshift.ts';
import type { ActionChooser, ChoiceCall } from './chooser.ts';
import { estimateCallTokens } from './run-budget.ts';
import { modelJsonText } from './model-json.ts';
import type { AssistBudget, AssistCall } from './critic-assist.ts';

export const SECONDARY_JUDGE_DEFAULT_ENABLED = false;
export const JUDGE_MIN_CANDIDATES = 2, JUDGE_MAX_CANDIDATES = 4, JUDGE_MAX_OUTPUT_TOKENS = 120, JUDGE_QUESTION_MAX_CHARS = 1500;
export const NO_CHOICE = 'NONE';
export const JUDGE_LABEL = 'NOTA_NO_DECISORIA';

export type JudgeStatus = 'DISABLED' | 'NOT_AMBIGUOUS' | 'SKIPPED_BUDGET' | 'TOO_FEW_CANDIDATES' | 'AGREES' | 'DISAGREES' | 'ABSTAINED' | 'INVALID' | 'FAILED';
export interface AmbiguitySignals { margin?: number; tie?: boolean; candidates?: readonly string[] }
export interface SecondaryJudgeNote {
  label: typeof JUDGE_LABEL;
  status: JudgeStatus;
  electorChoice: string;
  judgeChoice?: string;
  /** Candidates in the order the judge saw them. */
  candidates?: string[];
  seed?: string;
  signals: { margin?: number; tie?: boolean; resamples: number; resampleDisagreed: boolean; trigger?: 'MARGIN' | 'TIE' | 'RESAMPLE_DISAGREEMENT' };
  call?: { made: boolean; receipt?: Receipt; decisionStatus?: string; estimatedTokens?: number; error?: object };
  sameModelAsElector?: boolean;
  /** Tokens spent on re-samples (the judge call is in call.receipt). */
  resampleTokens?: number;
  reason?: string;
}

export interface SecondaryJudge {
  estimateTokens?(question: string, orderedCandidates: readonly string[]): number;
  judge(question: string, orderedCandidates: readonly string[]): Promise<AssistCall>;
}

/** Deterministic PRNG so the shuffle is reproducible from the recorded seed. */
export function seededRandom(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffleSeeded<T>(items: readonly T[], seed: string): T[] {
  const out = items.slice(), random = seededRandom(seed);
  for (let index = out.length - 1; index > 0; index--) { const other = Math.floor(random() * (index + 1)); [out[index], out[other]] = [out[other], out[index]]; }
  return out;
}

export function judgeMessages(question: string, orderedCandidates: readonly string[]) {
  const prompt = JSON.stringify({ question, candidates: orderedCandidates,
    constraints: [`Return only JSON: {"choice":"one exact candidate"} or {"choice":"${NO_CHOICE}"} to abstain.`, 'Never write SQL or invent ids. Candidate order carries no meaning.'] });
  return [{ role: 'system' as const, content: 'You pick the best candidate id for a question, or abstain. Return only the requested JSON.' }, { role: 'user' as const, content: prompt }];
}
export const estimateJudgeTokens = (question: string, orderedCandidates: readonly string[]) => estimateCallTokens(judgeMessages(question, orderedCandidates), JUDGE_MAX_OUTPUT_TOKENS);

/** Re-validation of the judge's raw answer against the candidates it was shown. */
export function parseJudgeChoice(text: string, candidates: readonly string[]): { ok: true; choice: string } | { ok: false } {
  let value: any;
  try { value = JSON.parse(modelJsonText(text)); } catch { return { ok: false }; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'choice') || typeof value.choice !== 'string') return { ok: false };
  return value.choice === NO_CHOICE || candidates.includes(value.choice) ? { ok: true, choice: value.choice } : { ok: false };
}

export interface JudgeConfig {
  /** Flag. Default OFF: with false the wrapper is a pass-through. */
  enabled: boolean;
  judge: SecondaryJudge;
  budget: AssistBudget;
  /** Cheap re-samples of the elector before escalating (0-3). */
  k?: number;
  /** Margin below which the free signal alone counts as ambiguity. */
  marginThreshold?: number;
  /** Free, deterministic ambiguity signals for a stage (margin of the scoring, ties, candidate ids). */
  ambiguity?: (stage: string, observation: unknown, allowed: readonly string[]) => AmbiguitySignals | undefined;
  /** Seed namespace recorded with each note, e.g. the runId. */
  seedBase: string;
}

/** Core decision, exported for tests and for harness use. Never throws and never changes `primary.selected`. */
export async function evaluateSecondaryJudge(cfg: JudgeConfig, inner: ActionChooser, primary: ChoiceCall, observation: unknown, allowed: readonly string[], options?: { compact?: boolean }): Promise<SecondaryJudgeNote | undefined> {
  const electorChoice = primary.selected!;
  const base = (status: JudgeStatus, extra: Partial<SecondaryJudgeNote> = {}): SecondaryJudgeNote =>
    ({ label: JUDGE_LABEL, status, electorChoice, signals: { resamples: 0, resampleDisagreed: false }, ...extra });
  if (!cfg.enabled) return undefined;
  if (primary.decisionStatus !== 'VALID' || !primary.selected || !allowed.includes(primary.selected)) return undefined;
  const free = cfg.ambiguity?.(primary.stage, observation, allowed);
  const lowMargin = free?.margin !== undefined && free.margin < (cfg.marginThreshold ?? 0);
  const k = Math.max(0, Math.min(3, cfg.k ?? 2));
  const signals: SecondaryJudgeNote['signals'] = { ...(free?.margin !== undefined ? { margin: free.margin } : {}), ...(free?.tie ? { tie: true } : {}), resamples: 0, resampleDisagreed: false };
  let pool: string[] | undefined = free?.candidates ? [...free.candidates] : undefined;
  let trigger: SecondaryJudgeNote['signals']['trigger'] = free?.tie ? 'TIE' : lowMargin ? 'MARGIN' : undefined;
  let resampleTokens = 0;

  // Cheap-first: the free signals decide before any extra model call is made.
  if (!trigger && k > 0) {
    const picks = new Set<string>([electorChoice]);
    const perCall = inner.estimateTokens?.(primary.stage, observation, allowed, options);
    for (let index = 0; index < k; index++) {
      if (!cfg.budget.canAskModel() || (perCall !== undefined && !cfg.budget.canAfford(perCall))) break;
      let again: ChoiceCall;
      try { again = await inner.choose(primary.stage, observation, allowed, options); } catch { signals.resamples++; continue; }
      signals.resamples++;
      const spent = again.tokensCharged ?? again.receipt?.totalTokens ?? 0; resampleTokens += spent; cfg.budget.chargeTokens(spent);
      if (again.decisionStatus === 'VALID' && again.selected && allowed.includes(again.selected)) picks.add(again.selected);
      else signals.resampleDisagreed = true;
    }
    if (picks.size > 1) { signals.resampleDisagreed = true; pool = [...picks]; }
    if (signals.resampleDisagreed) trigger = 'RESAMPLE_DISAGREEMENT';
  }
  if (!trigger) return base('NOT_AMBIGUOUS', { signals, ...(resampleTokens ? { resampleTokens } : {}) });
  signals.trigger = trigger;

  const candidates = [...new Set([electorChoice, ...(pool ?? [])])].filter(id => allowed.includes(id)).slice(0, JUDGE_MAX_CANDIDATES);
  if (candidates.length < JUDGE_MIN_CANDIDATES) return base('TOO_FEW_CANDIDATES', { signals, reason: 'fewer than 2 valid candidates', ...(resampleTokens ? { resampleTokens } : {}) });
  const seed = `${cfg.seedBase}|${primary.stage}|${primary.promptHash}`;
  const ordered = shuffleSeeded(candidates, seed);
  const question = `${primary.stage}: ${JSON.stringify(observation) ?? ''}`.slice(0, JUDGE_QUESTION_MAX_CHARS);
  const estimated = cfg.judge.estimateTokens?.(question, ordered) ?? estimateJudgeTokens(question, ordered);
  const primaryTokens = primary.receipt?.totalTokens ?? 0; // the caller charges the primary call after we return; reserve it here
  if (!cfg.budget.canAskModel() || !cfg.budget.canAfford(estimated + primaryTokens)) {
    return base('SKIPPED_BUDGET', { signals, candidates: ordered, seed, call: { made: false, estimatedTokens: estimated, decisionStatus: 'TOKEN_BUDGET_WOULD_EXCEED' }, reason: 'secondary judge omitted for budget', ...(resampleTokens ? { resampleTokens } : {}) });
  }
  let call: AssistCall;
  try { call = await cfg.judge.judge(question, ordered); }
  catch (error) { call = { status: 'FAIL', error: { code: error instanceof Error ? error.name : 'JUDGE_CALL_FAILED' } }; }
  cfg.budget.chargeTokens(call.receipt?.totalTokens ?? 0);
  const sameModelAsElector = call.receipt && primary.receipt ? call.receipt.model === primary.receipt.model : undefined;
  const common = { signals, candidates: ordered, seed, ...(sameModelAsElector !== undefined ? { sameModelAsElector } : {}), ...(resampleTokens ? { resampleTokens } : {}) };
  const callInfo = { made: true, estimatedTokens: estimated, ...(call.receipt ? { receipt: call.receipt } : {}) };
  if (call.status !== 'PASS' || typeof call.responseText !== 'string') return base('FAILED', { ...common, call: { ...callInfo, decisionStatus: 'MODEL_CALL_FAILED', ...(call.error ? { error: call.error } : {}) } });
  const parsed = parseJudgeChoice(call.responseText, ordered);
  if (!parsed.ok) return base('INVALID', { ...common, call: { ...callInfo, decisionStatus: 'INVALID_RESPONSE' } });
  if (parsed.choice === NO_CHOICE) return base('ABSTAINED', { ...common, judgeChoice: NO_CHOICE, call: { ...callInfo, decisionStatus: 'VALID' } });
  return base(parsed.choice === electorChoice ? 'AGREES' : 'DISAGREES', { ...common, judgeChoice: parsed.choice, call: { ...callInfo, decisionStatus: 'VALID' } });
}

/**
 * Elector decorator: returns exactly what the inner chooser returned, plus an optional `secondaryJudge` note. With the flag off
 * (default) the result is identical to the inner chooser's. `selected` is never modified.
 */
export class SecondaryJudgeChooser implements ActionChooser {
  constructor(private readonly inner: ActionChooser, private readonly cfg: JudgeConfig) {}
  estimateTokens(stage: string, observation: unknown, allowed: readonly string[], options?: { compact?: boolean }) { return this.inner.estimateTokens?.(stage, observation, allowed, options) ?? 0; }
  async choose(stage: string, observation: unknown, allowed: readonly string[], options?: { compact?: boolean }): Promise<ChoiceCall> {
    const primary = await this.inner.choose(stage, observation, allowed, options);
    if (!this.cfg.enabled) return primary;
    const note = await evaluateSecondaryJudge(this.cfg, this.inner, primary, observation, allowed, options);
    return note ? { ...primary, secondaryJudge: note } : primary;
  }
}

/** Model-backed judge (Nightshift). Same-provider caveat applies; see the header. */
export class NightshiftSecondaryJudge implements SecondaryJudge {
  constructor(private readonly nightshift: Nightshift) {}
  estimateTokens(question: string, ordered: readonly string[]) { return estimateJudgeTokens(question, ordered); }
  async judge(question: string, ordered: readonly string[]): Promise<AssistCall> {
    try {
      const generated = await this.nightshift.chat(judgeMessages(question, ordered), { maxTokens: JUDGE_MAX_OUTPUT_TOKENS, preserveTextOnFailure: true });
      return { status: 'PASS', responseText: generated.text, receipt: generated.receipt };
    } catch (error) {
      const base: AssistCall = { status: 'FAIL', error: { code: error instanceof Error ? error.name : 'JUDGE_CALL_FAILED' } };
      return error instanceof NightshiftChatError ? { ...base, ...(error.receipt ? { receipt: error.receipt } : {}), ...(error.responseText ? { responseText: error.responseText } : {}) } : base;
    }
  }
}

// ---------------------------------------------------------------- offline measurement harness
export interface LabelledCase {
  id: string;
  question: string;
  /** 2-4 already-valid candidate ids. */
  candidates: string[];
  /** Human label: the correct candidate, or NONE when abstaining is correct. */
  label: string;
  electorChoice: string;
  /** Recorded raw judge answer (and optional receipt) so the set can be scored offline; live recording is a separate, authorised step. */
  judgeResponse?: string;
  receiptId?: string;
  origin: 'SYNTHETIC' | 'LIVE';
}
export interface LabelledSet { schemaVersion: 1; description?: string; cases: LabelledCase[] }

export function validateLabelledSet(value: any): string[] {
  const issues: string[] = [];
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.cases)) return ['SET_SHAPE_INVALID'];
  if (value.cases.length < 1 || value.cases.length > 50) issues.push('CASE_COUNT_OUT_OF_RANGE');
  const ids = new Set<string>();
  value.cases.forEach((c: any, index: number) => {
    const at = `cases[${index}]`;
    if (!c || typeof c.id !== 'string' || ids.has(c.id)) issues.push(`${at}.id`); else ids.add(c.id);
    if (!Array.isArray(c?.candidates) || c.candidates.length < JUDGE_MIN_CANDIDATES || c.candidates.length > JUDGE_MAX_CANDIDATES || new Set(c.candidates).size !== c.candidates.length || c.candidates.some((x: unknown) => typeof x !== 'string')) issues.push(`${at}.candidates`);
    else {
      if (typeof c.label !== 'string' || (c.label !== NO_CHOICE && !c.candidates.includes(c.label))) issues.push(`${at}.label`);
      if (typeof c.electorChoice !== 'string' || !c.candidates.includes(c.electorChoice)) issues.push(`${at}.electorChoice`);
    }
    if (typeof c?.question !== 'string' || !c.question) issues.push(`${at}.question`);
    if (!['SYNTHETIC', 'LIVE'].includes(c?.origin)) issues.push(`${at}.origin`);
    if (c?.judgeResponse !== undefined && typeof c.judgeResponse !== 'string') issues.push(`${at}.judgeResponse`);
  });
  return issues;
}

export interface JudgeMeasurement {
  cases: number; scored: number; withoutRecordedJudge: number;
  electorCorrect: number; judgeCorrect: number; judgeAbstained: number; judgeInvalid: number;
  judgeAgreesWithElector: number; judgeDisagrees: number; disagreeJudgeRight: number; disagreeElectorRight: number;
  /** Cases where the label is the elector's choice and the judge flipped it away (harm), and where it rescued a wrong elector pick (help). */
  harmed: number; rescued: number;
  origins: { SYNTHETIC: number; LIVE: number };
  summary: string;
}
/** Scores recorded judge answers against human labels. Every figure carries its denominator; this is not evidence unless origin is LIVE. */
export function measureJudge(set: LabelledSet): JudgeMeasurement {
  const m = { cases: set.cases.length, scored: 0, withoutRecordedJudge: 0, electorCorrect: 0, judgeCorrect: 0, judgeAbstained: 0, judgeInvalid: 0, judgeAgreesWithElector: 0, judgeDisagrees: 0, disagreeJudgeRight: 0, disagreeElectorRight: 0, harmed: 0, rescued: 0,
    origins: { SYNTHETIC: set.cases.filter(c => c.origin === 'SYNTHETIC').length, LIVE: set.cases.filter(c => c.origin === 'LIVE').length } };
  for (const c of set.cases) {
    if (c.electorChoice === c.label) m.electorCorrect++;
    if (c.judgeResponse === undefined) { m.withoutRecordedJudge++; continue; }
    const shown = shuffleSeeded(c.candidates, `measure|${c.id}`);
    const parsed = parseJudgeChoice(c.judgeResponse, shown);
    m.scored++;
    if (!parsed.ok) { m.judgeInvalid++; continue; }
    if (parsed.choice === NO_CHOICE) { m.judgeAbstained++; if (c.label === NO_CHOICE) m.judgeCorrect++; continue; }
    if (parsed.choice === c.label) m.judgeCorrect++;
    if (parsed.choice === c.electorChoice) m.judgeAgreesWithElector++;
    else {
      m.judgeDisagrees++;
      if (parsed.choice === c.label) { m.disagreeJudgeRight++; m.rescued++; }
      else if (c.electorChoice === c.label) { m.disagreeElectorRight++; m.harmed++; }
    }
  }
  const lines = [`judge correct ${m.judgeCorrect} of ${m.scored} scored (elector alone: ${m.electorCorrect} of ${m.cases})`,
    `abstained ${m.judgeAbstained} of ${m.scored}; invalid ${m.judgeInvalid} of ${m.scored}`,
    `disagreed ${m.judgeDisagrees} of ${m.scored}: judge right ${m.disagreeJudgeRight}, elector right ${m.disagreeElectorRight}`,
    `origin: SYNTHETIC ${m.origins.SYNTHETIC} of ${m.cases}, LIVE ${m.origins.LIVE} of ${m.cases}${m.origins.LIVE === 0 ? ' (no LIVE case: not evidence)' : ''}`];
  return { ...m, summary: lines.join('\n') };
}
