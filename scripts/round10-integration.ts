// Round 10 integration closure, phases A and B (lane X9): the TPCDS fixture run TWICE, offline, and compared relation by relation.
//   (a) BASELINE  every Round 10 switch the HEAD exposes is off (consistency, review cascade, extended profile, tie-break vector in the review).
//   (b) ROUND 10  consistency + review cascade + extended profile (F1x) + tie-break vector in the review, on top of what is always on at HEAD
//                 (the per-run profile cache E1-06, the orientation by global uniqueness E2-02 and the role dimensions E2-04, which have no off switch).
// Usage: node scripts/run-tsx.mjs scripts/round10-integration.ts [--report [file]] [--json] [--bridge standin]
// Hard rules: nothing live, no `.env`, no budget ledger, nothing persisted (persist:false), no gold at runtime. The gold (eval/gold/TPCDS_fk_gold.json) and the F-04 labels are read only AFTER
// the runs, to score them (src/eval and this script are the evaluation side; goldAtRuntimeViolations checks that no runtime module names them). Data is SYNTHETIC; the review models are
// scripted stand-ins (STAND_IN_OFFLINE): a measurement of the pipeline, never of model quality. Anything that does not wire up is an OPEN ITEM with its owner, not a fix in a file that is not mine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { formFixtureClient } from '../tests/helpers/form-fixture-client.ts';
import { clusteredTpcdsTables } from '../tests/helpers/tpcds-clustered.ts';
import type { FixtureTable } from '../src/eval/fixture-client.ts';
import { nameTokenComaBridge } from '../src/eval/fixture-coma.ts';
import { createInstalledComaBridge, type ComaBridge } from '../src/discovery/coma-provider.ts';
import { resolveUniverseManifest } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { loadTpcdsGold, scoreTpcdsCandidates, type TpcdsGold } from '../src/eval/tpcds-gold.ts';
import { buildRecallFunnel, type RecallFunnel } from '../src/eval/recall-funnel.ts';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, readJson } from '../src/runtime.ts';
import { RUN_BUDGET_CEILINGS } from '../src/agent/run-budget.ts';
import { candidateReviewFor } from '../src/agent/cli-run.ts';
import type { CandidateReview } from '../src/agent/model-review-contract.ts';
import type { TieBreakResolver } from '../src/agent/model-review/evidence.ts';
import { orderTies, type TieCandidate, type TieOrdering, type ProfileLike } from '../src/agent/tie-break.ts';
import { parseProfile } from '../src/probe/column-profile.ts';
import { HARNESS_OVERRIDES, withHarnessOverrides, loadLabels, goldAtRuntimeViolations, type LabelsFile, type Overrides } from './round9-integration.ts';

// ------------------------------------------------------------------------------------------------------------------------------------------------ configurations

/** The Round 10 switches the HEAD exposes. `profileCache`, `orientationByGlobalUniqueness` and `roleDimensions` are always on at HEAD (no switch): they are reported, not toggled. */
export interface R10Switches { consistency: boolean; cascade: boolean; /** manifest.fullEvidenceExtendedProfile */ extendedProfile: boolean; /** manifest.tieBreak.enabled: the engine puts the X10 vector into post-COMA and the review */ tieBreak: boolean }
export type ConfigName = 'A_BASELINE' | 'B_ROUND10' | 'A_CASCADE' | 'B_NO_CASCADE' | 'B_NO_EXTENDED' | 'B_NO_TIEBREAK' | 'B_SHIPPED';
/** The two compared runs are A_BASELINE and B_ROUND10. The other three isolate one switch for the cost and attribution rows: a + cascade, b minus cascade, b minus the extended profile. */
export const SWITCHES: Record<ConfigName, R10Switches> = {
  A_BASELINE: { consistency: false, cascade: false, extendedProfile: false, tieBreak: false },
  B_ROUND10: { consistency: true, cascade: true, extendedProfile: true, tieBreak: true },
  A_CASCADE: { consistency: false, cascade: true, extendedProfile: false, tieBreak: false },
  B_NO_CASCADE: { consistency: true, cascade: false, extendedProfile: true, tieBreak: true },
  B_NO_EXTENDED: { consistency: true, cascade: true, extendedProfile: false, tieBreak: true },
  B_NO_TIEBREAK: { consistency: true, cascade: true, extendedProfile: true, tieBreak: false },
  /** Display only: the run declares NOTHING; it takes the manifest as shipped (asShipped). */
  B_SHIPPED: { consistency: true, cascade: true, extendedProfile: true, tieBreak: true }
};
/** SHIPPED: the manifest token ceiling of the shipped TPCDS config (3,000,000). MAX: the run ceiling (4,000,000), so the review is not cut and the cost of the switches is comparable. */
export interface RunSpec { name: ConfigName | 'R9_CODE'; switches: R10Switches; tokenCeiling: 'SHIPPED' | 'MAX'; /** The harness declares no switch: the manifest is used as shipped (the real path). */ asShipped?: true }
export const R9_COMMIT = '0d0dec3';
export const specOf = (name: ConfigName, tokenCeiling: 'SHIPPED' | 'MAX' = 'SHIPPED'): RunSpec => ({ name, switches: SWITCHES[name], tokenCeiling, ...(name === 'B_SHIPPED' ? { asShipped: true as const } : {}) });
export const specKey = (spec: RunSpec) => `${spec.name}${spec.tokenCeiling === 'MAX' ? '@MAX' : ''}`;

const DOCS_DIR = path.resolve(ROOT, 'out', 'reports');
const REFERENCE_FILE = path.join(ROOT, 'tests', 'fixtures', 'round10', 'r9-reference.json');
export const loadPrevious = (): PreviousReport => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'round10', 'previous-ab.json'), 'utf8'));
export interface PreviousReport { schema: string; label: string; confirmedAt?: string; source: { commit: string; report: string }; numbers: Record<string, number | string> }
export const loadReference = (): R9Reference => JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8'));
export interface R9Reference { schema: string; label: string; source: { report: string; commit: string }; fixture: string; numbers: Record<string, number>; notes: string[] }

/** Names read at runtime would be gold at runtime. The Round 9 list plus this lane's fixtures. */
export function goldAtRuntimeViolationsR10(): string[] {
  const out = goldAtRuntimeViolations();
  const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith('.ts') ? [`${dir}/${entry.name}`] : []);
  for (const file of walk('src').filter(item => !item.startsWith('src/eval/'))) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const needle of ['tests/fixtures/round10', 'r9-reference', 'round10-integration']) if (text.includes(needle)) out.push(`${file} names ${needle}`);
  }
  return out;
}

class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-25T00:00:00.000Z' };
  }
}
const memoBridge = (bridge: ComaBridge): ComaBridge => { const cache = new Map<string, ReturnType<ComaBridge>>(); return (input, timeout) => { const key = JSON.stringify(input); if (!cache.has(key)) cache.set(key, bridge(input, timeout)); return cache.get(key)!; }; };
let sharedBridge: { key: string; bridge: ComaBridge; label: string } | undefined;
function comaBridgeFor(kind: 'installed' | 'standin') {
  const python = path.join(ROOT, '.concordia', 'python', 'coma-valentine-1.1.0', 'Scripts', 'python.exe');
  const useInstalled = kind !== 'standin' && fs.existsSync(python), key = useInstalled ? 'installed' : 'standin';
  if (!sharedBridge || sharedBridge.key !== key) sharedBridge = { key, bridge: useInstalled ? memoBridge(createInstalledComaBridge(python, ROOT)) : nameTokenComaBridge, label: useInstalled ? 'installed COMA (valentine.Coma 1.1.0, local)' : 'deterministic name-token COMA stand-in (not COMA)' };
  return sharedBridge;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ SQL observer

export type SqlForm = 'F1' | 'F1x' | 'F2' | 'F3a' | 'F3b' | 'F3c' | 'F4' | 'OTHER';
export interface SqlRecord { form: SqlForm; key: string | null; sql: string }
const SRC = String.raw`(?:\(SELECT [\w, ]+ FROM (\w+)\.(\w+)\) concordia_source|(\w+)\.(\w+))`;
const F1_RE = new RegExp(String.raw`^SELECT COUNT\(\*\) AS concordia_rows, COUNT\(DISTINCT (\w+)\) AS concordia_distinct, SUM\(CASE WHEN \w+ IS NULL THEN 1 ELSE 0 END\) AS concordia_nulls FROM ${SRC}$`);
const F1X_RE = new RegExp(String.raw`^SELECT COUNT\(\*\) AS concordia_rows, COUNT\(DISTINCT (\w+)\) AS concordia_distinct, SUM\(CASE WHEN \w+ IS NULL THEN 1 ELSE 0 END\) AS concordia_nulls, MIN\(\w+\) AS concordia_min, MAX\(\w+\) AS concordia_max, AVG\(LENGTH\(CAST\(\w+ AS STRING\)\)\) AS concordia_avg_len FROM ${SRC}$`);
/** Which closed form a statement is. `key` is the `table.column` a profile scan reads (logical table name, through the config's physical table names). */
export function classifySql(sql: string, physicalToLogical: (physical: string) => string | undefined): SqlRecord {
  const keyOf = (m: RegExpExecArray) => { const physical = m[3] ?? m[5]; const table = physical ? physicalToLogical(physical) : undefined; return table ? `${table}.${m[1]}` : null; };
  const f1x = F1X_RE.exec(sql); if (f1x) return { form: 'F1x', key: keyOf(f1x), sql };
  const f1 = F1_RE.exec(sql); if (f1) return { form: 'F1', key: keyOf(f1), sql };
  if (/^SELECT COUNT\(\*\) AS concordia_missing_rows FROM /.test(sql)) return { form: 'F3c', key: null, sql };
  if (/^SELECT COUNT\(\*\) AS concordia_missing FROM /.test(sql)) return { form: 'F3b', key: null, sql };
  if (/^SELECT concordia_s\.k FROM /.test(sql)) return { form: 'F3a', key: null, sql };
  if (/^SELECT \w+, COUNT\(\*\) AS concordia_count FROM .* GROUP BY \w+ HAVING COUNT\(\*\) > 1 LIMIT \d+$/.test(sql)) return { form: 'F2', key: null, sql };
  if (/^SELECT DISTINCT \w+ FROM .* WHERE \w+ IS NOT NULL LIMIT \d+$/.test(sql)) return { form: 'F4', key: null, sql };
  return { form: 'OTHER', key: null, sql };
}
type ObservedProfile = Extract<ProfileLike, { provenance: 'GLOBAL_WHOLE_TABLE' }>;
interface Observer { client: any; records: SqlRecord[]; profiles: Map<string, ObservedProfile>; blockedF4: string[] }
/** Wraps the fixture client: every statement is classified, and the answer of each F1/F1x scan is kept (zero extra SQL) so the harness can hand the same profiles to the tie-break resolver the engine reads through its own cache. */
function observe(base: { describe: any; runSql: (sql: string, limit?: number, options?: unknown) => Promise<any> }, cfg: any, observeOptions: { blockF4?: () => boolean } = {}): Observer {
  const logical = (physical: string) => Object.entries<any>(cfg.tables).find(([, spec]) => spec.physicalTable === physical)?.[0];
  const records: SqlRecord[] = [], profiles = new Map<string, ObservedProfile>(), blockedF4: string[] = [];
  const client = {
    describe: base.describe,
    async runSql(sql: string, limit?: number, options?: unknown) {
      const record = classifySql(sql, logical);
      if (observeOptions.blockF4?.() && record.form === 'F4') { blockedF4.push(sql); throw Object.assign(new Error('F4_BLOCKED_BY_HARNESS'), { code: 'F4_BLOCKED_BY_HARNESS' }); }
      records.push(record);
      const answer = await base.runSql(sql, limit, options);
      if ((record.form === 'F1' || record.form === 'F1x') && record.key) {
        const parsed = parseProfile(answer.rows, record.form === 'F1x');
        if (parsed) profiles.set(record.key, { provenance: 'GLOBAL_WHOLE_TABLE', rows: parsed.rows, distinct: parsed.distinct, nulls: parsed.nulls, ...(parsed.min !== undefined ? { min: parsed.min as any } : {}), ...(parsed.max !== undefined ? { max: parsed.max as any } : {}), ...(parsed.avgLen !== undefined ? { avgLen: parsed.avgLen } : {}) });
      }
      return answer;
    }
  };
  return { client, records, profiles, blockedF4 };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ tie-break in the review

export interface TieRecord { group: string[]; ordered: string[]; decisive: boolean; decidedBy: string | null; reason: string; notMeasured: string[] }
const endpointOfId = (id: string) => { const [from, to] = id.split('__'), split = (text: string) => { const i = text.indexOf('.'); return { table: text.slice(0, i), column: text.slice(i + 1) }; }; return { from: split(from!), to: split(to!) }; };
const isHigh = (proposal: any) => proposal?.coverageProbe?.status === 'EXECUTED' && proposal.coverageProbe.diagnostic?.coverage?.level === 'HIGH';
const flatVector = (vector: Record<string, any>) => Object.fromEntries(Object.entries(vector).filter(([key]) => key !== 'candidateId').map(([key, feature]) => [key, feature?.status === 'MEASURED' ? feature.value : null]));
const notMeasuredOf = (ordering: TieOrdering) => [...new Set(ordering.vectors.flatMap(vector => Object.entries(vector).filter(([, feature]) => (feature as any)?.status === 'NOT_MEASURED').map(([key]) => key)))].sort();
const recordOf = (group: string[], ordering: TieOrdering): TieRecord => ({ group: [...group].sort(), ordered: ordering.ordered.map(item => item.id), decisive: ordering.decisive, decidedBy: ordering.decidedBy, reason: ordering.reason, notMeasured: notMeasuredOf(ordering) });

/** The candidates of a tie group with the profiles the run measured; `reachesHigh` from the post-COMA probe. Nothing is invented: an unmeasured profile stays absent. */
function candidatesFor(ids: readonly string[], proposals: Map<string, any>, profiles: Map<string, ObservedProfile>): TieCandidate[] {
  return ids.map(id => {
    const proposal = proposals.get(id), ends = proposal ? { from: proposal.from, to: proposal.to } : endpointOfId(id);
    const sp = profiles.get(`${ends.from.table}.${ends.from.column}`), tp = profiles.get(`${ends.to.table}.${ends.to.column}`);
    return { id, from: { db: ends.from.db, table: ends.from.table, column: ends.from.column }, to: { db: ends.to.db, table: ends.to.table, column: ends.to.column }, ...(proposal ? { reachesHigh: isHigh(proposal) && !proposal.coverageProbe.diagnostic?.suspect?.value } : {}), ...(sp ? { sourceProfile: sp } : {}), ...(tp ? { targetProfile: tp } : {}) };
  });
}
/** Wraps the resolver the ENGINE hands the review (manifest tieBreak.enabled) so every answer is recorded; the answer itself is untouched. Nothing is injected by this harness. */
function recordingTieBreak(inner: ((group: readonly string[]) => { ordered: readonly string[]; decisive: boolean; reason: string } | undefined) | undefined, records: Map<string, TieRecord>) {
  if (!inner) return undefined;
  return (group: readonly string[]) => {
    const answer = inner(group);
    if (answer) {
      const step = /^DECIDED_BY_([A-Z_]+)/.exec(answer.reason)?.[1] ?? null, nm = /[(]not measured: ([^)]*)[)]/.exec(answer.reason)?.[1]?.split(',').map(item => item.trim()).filter(Boolean) ?? [];
      records.set([...group].sort().join('|'), { group: [...group].sort(), ordered: [...answer.ordered], decisive: answer.decisive, decidedBy: answer.decisive ? step : null, reason: answer.reason, notMeasured: nm });
    }
    return answer;
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ one run

export interface RunOutcome {
  spec: RunSpec; runId: string; status: string; bridge: string; durationMs: number; report: any; overlay: any | null; sql: SqlRecord[]; profiles: Map<string, ObservedProfile>; reviewTies: TieRecord[]; appliedSwitches: string[]; blockedF4: number;
}
/** The four Round 10 switches as the TPCDS manifest declares them (true only when explicitly on). */
export function manifestSwitchesOf(manifest: any): R10Switches & { /** the raw declarations */ raw: Record<string, unknown> } {
  return { consistency: manifest?.consistency?.enabled === true, cascade: manifest?.reviewCascade?.enabled === true, extendedProfile: manifest?.fullEvidenceExtendedProfile === true, tieBreak: manifest?.tieBreak?.enabled === true,
    raw: { consistency: manifest?.consistency, reviewCascade: manifest?.reviewCascade, fullEvidenceExtendedProfile: manifest?.fullEvidenceExtendedProfile, tieBreak: manifest?.tieBreak } };
}
/**
 * Declares the four Round 10 manifest fields EXPLICITLY for one run, on or off, on the in-memory manifest (consistency.enabled, reviewCascade.enabled, fullEvidenceExtendedProfile, tieBreak.enabled), and puts the manifest
 * back as it was. The run never inherits a switch from what TPCDS ships. Nothing is written to disk. A spec marked asShipped declares nothing.
 */
async function withManifestSwitches<T>(spec: RunSpec, fn: () => Promise<T>): Promise<T> {
  if (spec.asShipped) return fn();
  const switches = spec.switches, manifest: any = resolveUniverseManifest('TPCDS'), keys = ['consistency', 'reviewCascade', 'fullEvidenceExtendedProfile', 'tieBreak'] as const, original = Object.fromEntries(keys.map(key => [key, manifest[key]]));
  manifest.consistency = { enabled: switches.consistency }; manifest.reviewCascade = { enabled: switches.cascade }; manifest.fullEvidenceExtendedProfile = switches.extendedProfile; manifest.tieBreak = { enabled: switches.tieBreak };
  try { return await fn(); } finally { for (const key of keys) { if (original[key] === undefined) delete manifest[key]; else manifest[key] = original[key]; } }
}

export interface RunOptions { bridge?: 'installed' | 'standin'; runId?: string; /** Replaces the fixture tables (the live-shaped M12 case). */ tables?: Record<string, FixtureTable>; /** Refuses the F4 reads of the post-COMA source pool (every F4 before the review starts): the arm without the widening. The contract probes keep their own reads. */ blockF4?: boolean; /** Writes the run folder under .concordia/agent-runs (needed by the post-COMA journal and the resume); the caller removes it. */ persist?: boolean; resume?: boolean }
export async function runConfig(spec: RunSpec, options: RunOptions = {}): Promise<RunOutcome> {
  const switches = spec.switches, fixture = agentFixtures().find(item => item.alias === 'TPCDS')!, { bridge, label } = comaBridgeFor(options.bridge ?? 'installed');
  const runId = options.runId ?? `agent-round10-${spec.name.toLowerCase()}-${Date.now()}`, started = Date.now();
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'concordia-round10-memory-')), memoryDir = path.join(memoryRoot, 'LOCAL-SYNTHETIC');
  const overrides: Overrides = { ...HARNESS_OVERRIDES, reviewMode: 'MODEL_ADVERSARIAL', ...(spec.tokenCeiling === 'MAX' ? { manifestTokens: RUN_BUDGET_CEILINGS.maxTokensPerRun } : {}) };
  try {
    return await withManifestSwitches(spec, () => withHarnessOverrides(overrides, async () => {
      const cfg = universeConfig('TPCDS'), observer = observe(formFixtureClient(cfg, options.tables ?? fixture.tables) as any, cfg, { blockF4: options.blockF4 ? () => !state.reviewStarted : undefined });
      const state = { records: new Map<string, TieRecord>(), reviewStarted: false };
      let overlay: any = null;
      // The review is built by the product path (cli-run candidateReviewFor, offline): the cascade comes from the manifest's reviewCascade, nothing is injected here.
      const built = candidateReviewFor('TPCDS', { offline: true });
      if (!built.review) throw new Error('CANDIDATE_REVIEW_NOT_BUILT:' + built.status);
      const inner = built.review;
      const review: CandidateReview = async request => {
        state.reviewStarted = true;
        const outcome = await inner({ ...request, tieBreak: recordingTieBreak(request.tieBreak, state.records) }); overlay = outcome.overlay; return outcome;
      };
      const report: any = await runAgent('TPCDS', runId, { client: observer.client, chooser: new Script([...fixture.chooserScript]), comaBridge: bridge, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: options.persist === true, critic: false, postComaPrior: false, candidateReview: review, memory: { dir: memoryDir }, ...(options.resume ? { resume: { runId } } : {}) });
      return { spec, runId, status: report.status, bridge: label, durationMs: Date.now() - started, report, overlay, sql: observer.records, profiles: observer.profiles, reviewTies: [...state.records.values()], blockedF4: observer.blockedF4.length,
        appliedSwitches: [spec.asShipped ? 'none declared: manifest as shipped' : '', !spec.asShipped && switches.consistency ? 'manifest.consistency.enabled' : '', !spec.asShipped && switches.cascade ? 'manifest.reviewCascade.enabled' : '', !spec.asShipped && switches.extendedProfile ? 'manifest.fullEvidenceExtendedProfile' : '', !spec.asShipped && switches.tieBreak ? 'manifest.tieBreak.enabled' : ''].filter(Boolean) };
    }));
  } finally { fs.rmSync(memoryRoot, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ measures (evaluation side: the gold and the labels are read here, after the run)

const reverseId = (id: string) => { const [a, b] = id.split('__'); return `${b}__${a}`; };
const goldIdOf = (edge: TpcdsGold['edges'][number]) => `${edge.from.table}.${edge.from.column}__${edge.to.table}.${edge.to.column}`;
const countBy = (items: readonly string[]) => items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item]: (acc[item] ?? 0) + 1 }), {});
const frac = (n: number, d: number) => `${n}/${d}`;

export interface TieGroupRow {
  source: string; members: { id: string; target: string; guardFlagged: boolean; approved: boolean; gold: boolean }[];
  guardResolved: boolean;
  vector: { decisive: boolean; decidedBy: string | null; winner: string | null; reason: string; deferralReason: string | null; skippedSteps: string[]; equalSteps: string[] };
  winnerIsGold: boolean | null;
}
export interface Measures {
  spec: RunSpec; runId: string; status: string; durationMs: number; degradations: string[];
  candidates: { proposals: number; executed: number; executable: number; notExecutable: number; notExecutedByBudget: number };
  approvedIds: string[]; /** What happened to each post-COMA proposal (evaluation aid for the R9 -> R10 diff). */ fates: Record<string, string>; funnel: RecallFunnel; funnelStages: Record<string, string>; funnelDetail: Record<string, string | null>;
  review: { status: string; mode: string | null; label: string | null; provenance: string | null; candidates: number; reviewed: number; approved: number; deferred: number; rejected: number; notReviewed: number; calls: number; tokens: number; skippedByCascade: number; cascadeTokensAvoided: number; skippedBudget: number;
    cutRelations: number; healthCalls: number; healthCodes: string[]; invalidCalls: number; truncatedCalls: number; modelTable: any[]; prioritySkipped: number; tieTargets: number; tieMeasured: number; tieQueries: number; tieCached: number; consistencyStatus: string };
  ties: { groups: TieGroupRow[]; guardResolved: number; vectorDecisive: number; vectorDecisiveOfUnresolved: number; unresolved: number; deferred: number; decisiveWinnerGold: number; decisiveWinnerNotGold: number; decisiveNoGold: number;
    byStep: Record<string, number>; deferralReasons: Record<string, number>; review: { groups: number; decisive: number; deferred: number; byStep: Record<string, number>; deferralReasons: Record<string, number>; decisiveWinnerApproved: number; decisiveWinnerGold: number; winnersNotGold: string[]; rows: TieRecord[] }; wrongDecisive: { source: string; winner: string; step: string; goldTargets: string[] }[] };
  reversed: { rows: ReversedRow[]; recovered: number; stillReversed: number; misOriented: number; denominator: number; recoveredSustained: number; promotion: ReversedRow[]; promotionDetail: PromotionDetail[] };
  consistency: { status: string; approvedBefore: number; kept: number; demoted: { id: string; rule: string; winner: string | null; reason: string; goldFk: boolean; goldReversed: boolean; winnerGold: boolean }[]; byRule: Record<string, number>; trueFkDemoted: number; unresolved: number };
  sql: { statements: number; budgetQueries: number; totalSourceQueries: number; forms: Record<string, number>; profileScans: number; profileColumns: number; maxScansPerColumn: number; columnsScannedOnce: number; repeatedColumns: string[]; cachedUses: { fullEvidence: number; tieTargets: number }; byPhase: Record<string, number> };
  invariants: { yesApproved: number; yesSostenida: number; yesN: number; deferredApproved: number; deferredSostenida: number; deferredN: number; decoyContracts: number; decoyN: number; decoyFlagged: number; m12Reached: number; m12N: number;
    decisions: number; nonModelOrigin: number; humanOrigin: number; claims: number; claimsNonModel: number; confusions: number;
    approved: number; approvedTrue: number; approvedFalse: number; approvedReversed: number; sustained: number; sustainedTrue: number; goldEdges: number; recall: number; falseAccepts: string[]; missedYes: string[]; missedYesWhy: { id: string; stage: string; detail: string | null }[] };
  memory: { status: string | null; total: number | null; admitted: number | null; rejected: number | null; written: boolean | null; quarantineFile: string | null };
  liveVector: number; oneToOneTraits: number; flaggedGold: Record<string, number>; rangeBias: { flagged: number; onlyReason: number; onlyReasonGold: number }; roleDimensions: number; oneToOne: number;
}
export interface PromotionDetail { goldId: string; proposal: string | null; orientation: string | null; rankClass: string | null; globalUniqueness: unknown; fromProfile: unknown; toProfile: unknown; suspect: string[]; coverage: string | null }
export interface ReversedRow { goldId: string; how: 'RECOVERED_BY_SAMPLE' | 'RECOVERED_BY_GLOBAL_UNIQUENESS' | 'STILL_REVERSED' | 'MIS_ORIENTED_BY_POST_COMA' | 'OK_AS_PROPOSED' | 'NOT_PROPOSED'; stage: string; verdict: string | null }

export function measureRun(run: RunOutcome, labels: LabelsFile, gold: TpcdsGold): Measures {
  const report = run.report, section = report.phases?.candidateReview ?? {}, proposals: any[] = report.postComa?.proposals ?? [], byId = new Map<string, any>(proposals.map(p => [String(p.proposalId), p]));
  const approved: string[] = section.approved ?? [], approvedSet = new Set(approved), hasContract = (id: string) => approvedSet.has(id) || approvedSet.has(reverseId(id));
  const decisions: any[] = report.decisions ?? [], decisionById = new Map<string, any>(decisions.map(d => [d.relationId, d])), decisionOf = (id: string) => decisionById.get(id) ?? decisionById.get(reverseId(id));
  const goldIds = new Set(gold.edges.map(goldIdOf)), goldReversedIds = new Set(gold.edges.map(edge => reverseId(goldIdOf(edge))));
  const minKeys = readJson<any>('config/thresholds.json').minDistinctKeys as number;

  // --- recall funnel (X3), with the consistency demotions told apart from the model's own defers
  const funnelOverlay = run.overlay ? { ...run.overlay, relations: (run.overlay.relations ?? []).filter((relation: any) => approvedSet.has(relation.id)), notApproved: section.notApproved ?? run.overlay.notApproved } : undefined;
  const funnel = buildRecallFunnel({ report, ...(funnelOverlay ? { overlay: funnelOverlay } : {}), gold });
  const funnelStages = Object.fromEntries(funnel.edges.map(edge => [edge.id, edge.stage === 'REVIEW_DEFER' && /CONSISTENCY_/.test(edge.detail ?? '') ? 'CONSISTENCY_DEMOTED' : edge.stage]));
  const funnelDetail = Object.fromEntries(funnel.edges.map(edge => [edge.id, edge.detail]));

  // --- review
  const counts = section.counts ?? {}, health = section.health ?? {}, tie = section.tieEvidence ?? {}, modelBudget = report.budget?.phases?.byPhase?.modelReview?.used ?? {};
  const review = { status: String(section.status ?? 'NONE'), mode: section.mode ?? null, label: section.label ?? null, provenance: section.provenance ?? null, candidates: counts.candidates ?? 0, reviewed: counts.reviewed ?? 0, approved: counts.approved ?? 0, deferred: counts.deferred ?? 0, rejected: counts.rejected ?? 0, notReviewed: counts.notReviewed ?? 0,
    calls: counts.calls ?? 0, tokens: modelBudget.tokens ?? counts.tokens ?? 0, skippedByCascade: counts.skippedByCascade ?? 0, cascadeTokensAvoided: counts.cascadeEstimatedTokensAvoided ?? 0, skippedBudget: (run.overlay?.reviews ?? []).reduce((sum: number, r: any) => sum + (r.evaluations ?? []).filter((e: any) => e.status === 'SKIPPED_BUDGET').length, 0),
    cutRelations: (run.overlay?.reviews ?? []).filter((r: any) => (r.evaluations ?? []).some((e: any) => e.status === 'SKIPPED_BUDGET') || r.adversary?.status === 'SKIPPED_BUDGET').length,
    healthCalls: health.calls ?? 0, healthCodes: health.codes ?? [], invalidCalls: health.invalidCalls ?? 0, truncatedCalls: health.truncatedCalls ?? 0, modelTable: run.overlay?.modelTable ?? [], prioritySkipped: run.overlay?.priority?.skipped?.length ?? 0,
    tieTargets: (tie.targets ?? []).length, tieMeasured: Object.keys(tie.measured ?? {}).length, tieQueries: tie.queries ?? 0, tieCached: (tie.cached ?? []).length, consistencyStatus: String(section.consistency?.status ?? 'NONE') };

  // --- ties: the groups of HIGH, unsuspected candidates that share a source column, replayed through X10's orderTies with the profiles the run measured
  const high = (p: any) => p.coverageProbe?.status === 'EXECUTED' && p.coverageProbe.diagnostic?.coverage?.level === 'HIGH';
  const reasonsOf = (p: any): string[] => p.coverageProbe?.diagnostic?.suspect?.reasons ?? [];
  const pool = proposals.filter(p => high(p) && reasonsOf(p).every(reason => reason === 'COMPETING_TARGET'));
  const tieCandidates = (ids: readonly string[]) => candidatesFor(ids, byId, run.profiles);
  const context = tieCandidates(pool.map(p => p.proposalId));
  const bySource = new Map<string, any[]>(); for (const p of pool) bySource.set(`${p.from.table}.${p.from.column}`, [...(bySource.get(`${p.from.table}.${p.from.column}`) ?? []), p]);
  const groups: TieGroupRow[] = [];
  for (const [source, members] of [...bySource].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (members.length < 2) continue;
    const ordering = orderTies(tieCandidates(members.map(p => p.proposalId)), { candidates: context });
    const winner = ordering.decisive ? ordering.ordered[0]!.id : null, flagged = (p: any) => reasonsOf(p).includes('COMPETING_TARGET');
    const skippedSteps = ordering.trace.filter(step => step.outcome === 'SKIPPED_NOT_MEASURED').map(step => step.step), equalSteps = ordering.trace.filter(step => step.outcome === 'EQUAL').map(step => step.step);
    groups.push({ source, members: members.map(p => ({ id: p.proposalId, target: `${p.to.table}.${p.to.column}`, guardFlagged: flagged(p), approved: hasContract(p.proposalId), gold: goldIds.has(p.proposalId) })), guardResolved: members.some(flagged),
      vector: { decisive: ordering.decisive, decidedBy: ordering.decidedBy, winner, reason: ordering.reason, deferralReason: ordering.decisive ? null : skippedSteps.length ? `NOT_MEASURED:${skippedSteps.join('+')}` : 'TIED_ON_EVERY_STEP', skippedSteps, equalSteps },
      winnerIsGold: winner ? goldIds.has(winner) : null });
  }
  const unresolvedGroups = groups.filter(group => !group.guardResolved), decisive = groups.filter(group => group.vector.decisive);
  const reviewDecisive = run.reviewTies.filter(item => item.decisive);
  const ties: Measures['ties'] = { groups, guardResolved: groups.length - unresolvedGroups.length, vectorDecisive: decisive.length, vectorDecisiveOfUnresolved: unresolvedGroups.filter(group => group.vector.decisive).length, unresolved: unresolvedGroups.length, deferred: groups.length - decisive.length,
    decisiveWinnerGold: decisive.filter(group => group.winnerIsGold === true).length, decisiveWinnerNotGold: decisive.filter(group => group.winnerIsGold === false && group.members.some(m => m.gold)).length, decisiveNoGold: decisive.filter(group => !group.members.some(m => m.gold)).length,
    byStep: countBy(decisive.map(group => group.vector.decidedBy ?? 'NONE')), deferralReasons: countBy(groups.filter(group => !group.vector.decisive).map(group => group.vector.deferralReason ?? 'NONE')),
    review: { groups: run.reviewTies.length, decisive: reviewDecisive.length, deferred: run.reviewTies.length - reviewDecisive.length, byStep: countBy(reviewDecisive.map(item => item.decidedBy ?? 'NONE')), deferralReasons: countBy(run.reviewTies.filter(item => !item.decisive).map(item => item.notMeasured.length ? `NOT_MEASURED:${item.notMeasured.join('+')}` : 'TIED_ON_EVERY_STEP')),
      decisiveWinnerApproved: reviewDecisive.filter(item => hasContract(item.ordered[0]!)).length, decisiveWinnerGold: reviewDecisive.filter(item => goldIds.has(item.ordered[0]!)).length, winnersNotGold: reviewDecisive.filter(item => !goldIds.has(item.ordered[0]!)).map(item => item.ordered[0]!), rows: run.reviewTies },
    wrongDecisive: decisive.filter(group => group.winnerIsGold === false && group.members.some(m => m.gold)).map(group => ({ source: group.source, winner: group.vector.winner!.split('__')[1]!, step: group.vector.decidedBy ?? 'NONE', goldTargets: group.members.filter(m => m.gold).map(m => m.target) })) };

  // --- reversed edges: which gold edges COMA gave the wrong way round, and which of them the pipeline turned back
  const reversedRows: ReversedRow[] = gold.edges.map(edge => {
    const id = goldIdOf(edge), rid = reverseId(id), direct = byId.get(id), rev = byId.get(rid), orientation = (p: any) => p?.structure?.orientation as string | undefined;
    const how: ReversedRow['how'] = direct ? (orientation(direct) === 'SWAPPED_GLOBAL_UNIQUENESS' ? 'RECOVERED_BY_GLOBAL_UNIQUENESS' : orientation(direct) === 'SWAPPED_TARGET_UNIQUE' ? 'RECOVERED_BY_SAMPLE' : 'OK_AS_PROPOSED') : rev ? (orientation(rev) && orientation(rev) !== 'AS_PROPOSED' ? 'MIS_ORIENTED_BY_POST_COMA' : 'STILL_REVERSED') : 'NOT_PROPOSED';
    return { goldId: id, how, stage: funnelStages[edge.id] ?? '?', verdict: decisionOf(id)?.verdict ?? null };
  });
  const recoveredRows = reversedRows.filter(row => row.how.startsWith('RECOVERED')), stillRows = reversedRows.filter(row => row.how === 'STILL_REVERSED');
  const reversed = { rows: reversedRows.filter(row => row.how !== 'OK_AS_PROPOSED' && row.how !== 'NOT_PROPOSED'), recovered: recoveredRows.length, stillReversed: stillRows.length, misOriented: reversedRows.filter(row => row.how === 'MIS_ORIENTED_BY_POST_COMA').length, denominator: recoveredRows.length + stillRows.length,
    recoveredSustained: recoveredRows.filter(row => row.verdict === 'SOSTENIDA').length, promotion: reversedRows.filter(row => /p_end_date_sk/.test(row.goldId)),
    promotionDetail: gold.edges.filter(edge => /p_end_date_sk/.test(goldIdOf(edge))).map(edge => { const id = goldIdOf(edge), p = byId.get(id) ?? byId.get(reverseId(id)); const ps = (end: { table: string; column: string }) => run.profiles.get(`${end.table}.${end.column}`) ?? null;
      return { goldId: id, proposal: p?.proposalId ?? null, orientation: p?.structure?.orientation ?? null, rankClass: p?.structure?.rankClass ?? null, globalUniqueness: p?.structure?.globalUniqueness ?? null, fromProfile: p ? ps(p.from) : null, toProfile: p ? ps(p.to) : null, suspect: p?.coverageProbe?.diagnostic?.suspect?.reasons ?? [], coverage: p?.coverageProbe?.diagnostic?.coverage ? `${p.coverageProbe.diagnostic.coverage.matched}/${p.coverageProbe.diagnostic.coverage.probed} ${p.coverageProbe.diagnostic.coverage.level}` : null }; }) };

  // --- consistency
  const cons = section.consistency ?? { status: 'OFF' };
  const demoted = (cons.demoted ?? []).map((item: any) => ({ id: item.id, rule: item.rule, winner: item.winner ?? null, reason: item.reason ?? '', goldFk: goldIds.has(item.id), goldReversed: goldReversedIds.has(item.id), winnerGold: typeof item.winner === 'string' ? goldIds.has(item.winner) : false }));
  const consistency = { status: String(cons.status ?? 'OFF'), approvedBefore: approved.length + demoted.length, kept: approved.length, demoted, byRule: countBy(demoted.map((item: any) => item.rule)), trueFkDemoted: demoted.filter((item: any) => item.goldFk).length, unresolved: (cons.unresolved ?? []).length };

  // --- SQL
  const scans = run.sql.filter(r => r.form === 'F1' || r.form === 'F1x'), perColumn = countBy(scans.map(r => r.key ?? 'UNKNOWN'));
  const probes: any[] = (report.artifacts?.probes ?? []);
  const fullQueries = probes.flatMap(item => item.evidence?.fullEvidence?.queries ?? []);
  const sql = { statements: run.sql.length, budgetQueries: report.budget?.used?.queries ?? 0, totalSourceQueries: report.budget?.used?.totalSourceQueries ?? 0, forms: countBy(run.sql.map(r => r.form)), profileScans: scans.length, profileColumns: Object.keys(perColumn).length, maxScansPerColumn: Math.max(0, ...Object.values(perColumn)),
    columnsScannedOnce: Object.values(perColumn).filter(n => n === 1).length, repeatedColumns: Object.entries(perColumn).filter(([, n]) => n > 1).map(([key, n]) => `${key} x${n}`), cachedUses: { fullEvidence: fullQueries.filter((q: any) => q.cached === true).length, tieTargets: (tie.cached ?? []).length },
    byPhase: Object.fromEntries(Object.entries<any>(report.budget?.phases?.byPhase ?? {}).map(([phase, item]) => [phase, item.used?.queries ?? 0])) };

  // --- invariants against F-04 and the gold (labels read here, after the run)
  const sostenida = (id: string) => decisionOf(id)?.verdict === 'SOSTENIDA';
  const mapped = (ids: readonly string[]) => ids.map(id => byId.get(id)).filter(Boolean).map((p: any) => ({ from: { table: p.from.table, column: p.from.column }, to: { table: p.to.table, column: p.to.column } }));
  const score = scoreTpcdsCandidates(mapped(approved), gold);
  const sustainedIds = decisions.filter(d => d.verdict === 'SOSTENIDA').map(d => d.relationId), scoreSustained = scoreTpcdsCandidates(mapped(sustainedIds), gold);
  const claims: any[] = report.memory?.claims ?? [];
  const decoyHit = (item: { id: string }) => byId.get(item.id) ?? byId.get(reverseId(item.id));
  const invariants = { yesN: labels.yes.length, yesApproved: labels.yes.filter(hasContract).length, yesSostenida: labels.yes.filter(sostenida).length,
    deferredN: labels.deferred.length, deferredApproved: labels.deferred.filter(item => hasContract(item.id)).length, deferredSostenida: labels.deferred.filter(item => sostenida(item.id)).length,
    decoyN: labels.decoys.length, decoyContracts: labels.decoys.filter(item => hasContract(item.id)).length, decoyFlagged: labels.decoys.filter(item => reasonsOf(decoyHit(item) ?? {}).length > 0).length,
    m12N: labels.deferred.length, m12Reached: labels.deferred.filter(item => (decoyHit(item)?.coverageProbe?.diagnostic?.multiplicity?.from?.distinctKeys ?? 0) >= minKeys).length,
    decisions: decisions.length, nonModelOrigin: decisions.filter(d => d.reviewOrigin !== 'MODEL_REVIEWED').length, humanOrigin: decisions.filter(d => d.reviewOrigin === 'HUMAN_REVIEWED').length, claims: claims.length, claimsNonModel: claims.filter(c => c.reviewOrigin !== 'MODEL_REVIEWED').length,
    confusions: decisions.filter(d => d.reviewOrigin === 'HUMAN_REVIEWED').length + claims.filter(c => c.reviewOrigin === 'HUMAN_REVIEWED').length + (report.reviewOverlay ? 1 : 0),
    approved: approved.length, approvedTrue: score.truePositives, approvedFalse: score.falsePositives, approvedReversed: score.reversed.length, sustained: scoreSustained.candidates, sustainedTrue: scoreSustained.truePositives, goldEdges: score.goldEdges, recall: score.truePositives,
    falseAccepts: [...labels.deferred.map(item => item.id), ...labels.decoys.map(item => item.id)].filter(hasContract), missedYes: labels.yes.filter(id => !hasContract(id)),
    missedYesWhy: labels.yes.filter(id => !hasContract(id)).map(id => { const gid = gold.edges.find(edge => goldIdOf(edge) === id)?.id ?? id; return { id, stage: funnelStages[gid] ?? 'NOT_IN_GOLD', detail: funnelDetail[gid] ?? null }; }) };

  const notApprovedBy = new Map<string, any>((section.notApproved ?? []).map((item: any) => [String(item.relationId), item]));
  const fates: Record<string, string> = {};
  for (const p of proposals) {
    const probe = p.coverageProbe, level = probe?.diagnostic?.coverage?.level, id = String(p.proposalId), na = notApprovedBy.get(id);
    fates[id] = probe?.status !== 'EXECUTED' ? `NOT_PROBED:${probe?.status ?? 'NONE'}${probe?.reason ? `:${probe.reason}` : ''}` : level !== 'HIGH' ? `COVERAGE_${level}` : reasonsOf(p).length ? `FLAGGED:${reasonsOf(p).join(',')}` : approvedSet.has(id) ? 'APPROVED' : na ? `${String(na.decision).toUpperCase()}:${(na.reasons ?? []).join(',')}` : 'NOT_REVIEWED';
  }
  const batch = report.memory?.batch;
  return { spec: run.spec, runId: run.runId, status: run.status, durationMs: run.durationMs, degradations: (report.degradations ?? []).map((d: any) => `${d.phase}/${d.code}${d.detail ? ` (${String(d.detail).slice(0, 110)})` : ''}`),
    candidates: { proposals: proposals.length, executed: proposals.filter(p => p.coverageProbe?.status === 'EXECUTED').length, executable: proposals.length - (report.postComa?.counts?.notExecutable ?? 0), notExecutable: report.postComa?.counts?.notExecutable ?? 0, notExecutedByBudget: (report.postComa?.notExecutedByBudget ?? []).length },
    approvedIds: approved, fates, funnel, funnelStages, funnelDetail, review, ties, reversed, consistency, sql, invariants,
    memory: { status: report.memory?.status ?? null, total: batch?.total ?? null, admitted: batch?.admitted ?? null, rejected: batch?.rejected ?? null, written: batch?.written ?? null, quarantineFile: batch?.quarantineFile ?? null },
    liveVector: proposals.filter(p => p.coverageProbe?.diagnostic?.tieBreak).length, oneToOneTraits: proposals.filter(p => (p.coverageProbe?.diagnostic?.traits ?? []).includes('ONE_TO_ONE_EXTENSION')).length,
    flaggedGold: countBy(funnel.edges.filter(edge => edge.stage === 'FLAGGED').map(edge => edge.detail ?? 'UNSPECIFIED')),
    rangeBias: { flagged: proposals.filter(p => reasonsOf(p).includes('RANGE_BIASED')).length, onlyReason: proposals.filter(p => high(p) && reasonsOf(p).length === 1 && reasonsOf(p)[0] === 'RANGE_BIASED').length, onlyReasonGold: proposals.filter(p => high(p) && reasonsOf(p).length === 1 && reasonsOf(p)[0] === 'RANGE_BIASED' && goldIds.has(p.proposalId)).length }, roleDimensions: proposals.filter(p => p.coverageProbe?.diagnostic?.roleDimension).length, oneToOne: proposals.filter(p => p.structure?.rankClass === 'ONE_TO_ONE').length };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ live M12: a degenerate discovery sample widened by F4

/** The six source columns that stayed at ONE distinct key in the interrupted live pass 1 (tables stored in key order): the first rows carry one value, more than the 20-row discovery sample. The first three are the F-04 M12 relations. */
export const LIVE_DEGENERATE_COLUMNS = [
  { table: 'inventory', column: 'inv_warehouse_sk' }, { table: 'inventory', column: 'inv_date_sk' }, { table: 'catalog_page', column: 'cp_end_date_sk' },
  { table: 'catalog_page', column: 'cp_start_date_sk' }, { table: 'catalog_sales', column: 'cs_sold_date_sk' }, { table: 'store_sales', column: 'ss_sold_date_sk' }
] as const;
/** The table stored in key order: the first 30 rows carry one value of the column (more than the 20-row discovery sample), the rest carry five. Padded to 45 rows when the fixture is shorter. */
function clusterColumn(tables: Record<string, FixtureTable>, table: string, column: string) {
  const t = tables[table]!, index = t.columns.findIndex(item => item.name === column);
  if (index < 0) throw new Error(`FIXTURE_COLUMN_UNKNOWN:${table}.${column}`);
  while (t.rows.length < 45) t.rows.push([...t.rows[t.rows.length % Math.max(1, t.rows.length)]!]);
  t.rows.forEach((row, position) => { row[index] = column.endsWith('warehouse_sk') ? (position < 30 ? 1 : 1 + (position % 5)) : position < 30 ? 2450001 : 2450002 + (position % 4); });
}
/** The TPCDS fixture with the live M12 shape on the six columns: a 20-row sample sees 1 key where the table holds 5. */
export function liveShapedTables(): Record<string, FixtureTable> {
  const tables = clusteredTpcdsTables();
  for (const { table, column } of LIVE_DEGENERATE_COLUMNS) clusterColumn(tables, table, column);
  return tables;
}
export interface M12Row { id: string; found: 'DIRECT' | 'REVERSED' | 'ABSENT'; samplingSource: string | null; sampleDistinct: number | null; distinctKeys: number | null; /** basis of the source key count (X4: multiplicity.from.fromBasis) */ fromBasis: string | null; /** keys the coverage probe actually sent (after any F4 widening) */ probedKeys: number | null; coverage: string | null; approved: boolean; verdict: string | null; reasonCodes: string[]; whyNot: string | null }
export interface M12Arm { label: string; status: string; f4PoolReads: number; f4Blocked: number; widenedProbes: number; degenerateProbes: number; sourcePool: unknown; f4Reads: number | null; queries: number; approved: number; rows: M12Row[]; decoyContracts: number; confusions: number }
export interface M12Case { columns: number; withF4: M12Arm; withoutF4: M12Arm }

function m12Arm(label: string, run: RunOutcome, m: Measures, labels: LabelsFile): M12Arm {
  const proposals: any[] = run.report.postComa?.proposals ?? [], byId = new Map<string, any>(proposals.map(p => [String(p.proposalId), p]));
  const decisions = new Map<string, any>((run.report.decisions ?? []).map((d: any) => [d.relationId, d])), notApproved = new Map<string, any>((run.report.phases?.candidateReview?.notApproved ?? []).map((n: any) => [String(n.relationId), n]));
  const approvedSet = new Set(m.approvedIds);
  const rows: M12Row[] = labels.deferred.map(item => {
    const id = item.id, direct = byId.get(id), p = direct ?? byId.get(reverseId(id)), rid = direct ? id : reverseId(id), sampling = p?.coverageProbe?.sampling, d = decisions.get(rid), na = notApproved.get(rid);
    return { id, found: direct ? 'DIRECT' : p ? 'REVERSED' : 'ABSENT', samplingSource: sampling?.source ?? null, sampleDistinct: typeof sampling?.sampleDistinct === 'number' ? sampling.sampleDistinct : null, distinctKeys: p?.coverageProbe?.diagnostic?.multiplicity?.from?.distinctKeys ?? null, probedKeys: p?.coverageProbe?.diagnostic?.coverage?.probed ?? null, fromBasis: p?.coverageProbe?.diagnostic?.multiplicity?.from?.fromBasis ?? null,
      coverage: p?.coverageProbe?.diagnostic?.coverage ? `${p.coverageProbe.diagnostic.coverage.matched}/${p.coverageProbe.diagnostic.coverage.probed} ${p.coverageProbe.diagnostic.coverage.level}` : null, approved: approvedSet.has(rid), verdict: d?.verdict ?? null, reasonCodes: d?.reasonCodes ?? [],
      whyNot: approvedSet.has(rid) ? null : na ? `${na.decision}: ${(na.reasons ?? []).join(',')}` : p ? m.fates[rid] ?? 'NOT_REVIEWED' : 'NOT_PROPOSED' };
  });
  return { label, status: run.status, f4PoolReads: Number((run.report.postComa?.sourcePool as any)?.queries ?? 0) - Number((run.report.postComa?.sourcePool as any)?.failures ?? 0), f4Blocked: run.blockedF4, widenedProbes: proposals.filter(p => p.coverageProbe?.sampling?.source === 'GLOBAL_DISTINCT_F4').length,
    degenerateProbes: proposals.filter(p => p.coverageProbe?.sampling?.reason === 'SAMPLE_BELOW_MINIMUM').length, sourcePool: run.report.postComa?.sourcePool ?? null, f4Reads: run.report.postComa?.policy?.f4Reads ?? null, queries: run.report.budget?.used?.queries ?? 0, approved: m.approvedIds.length, rows,
    decoyContracts: m.invariants.decoyContracts, confusions: m.invariants.confusions };
}
/** Run (b) on the live-shaped fixture twice: with the engine's F4 widening, and with the F4 read refused by the client (what the engine did before E3-07a: the sample stays at 1 key). */
export async function runM12(bridgeKind: 'installed' | 'standin', labels: LabelsFile, gold: TpcdsGold): Promise<M12Case> {
  const spec = specOf('B_ROUND10'), tables = liveShapedTables();
  const withF4 = await runConfig(spec, { bridge: bridgeKind, tables }), without = await runConfig(spec, { bridge: bridgeKind, tables, blockF4: true });
  return { columns: LIVE_DEGENERATE_COLUMNS.length, withF4: m12Arm('with F4 widening (engine as shipped)', withF4, measureRun(withF4, labels, gold), labels), withoutF4: m12Arm('F4 refused by the client (sample stays degenerate)', without, measureRun(without, labels, gold), labels) };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ resume (E1-03): kill the run after k post-COMA probes, resume, compare

export interface ResumeCase {
  status: 'RAN' | 'INTERRUPT_MISSED' | 'UNAVAILABLE'; detail: string; targetK: number; journaledAtKill: number; tornTail: boolean;
  full?: { queries: number; reviewTokens: number; status: string; verdicts: number; approved: number };
  resumed?: { queries: number; reviewTokens: number; status: string; verdicts: number; approved: number; resume: { resumedProbes: number; newProbes: number; interruptions: number; journalFound: boolean } | null; resumedFrom: string | null };
  identicalVerdicts?: boolean; verdictDiffs?: string[]; queriesSaved?: number; sameApproved?: boolean;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const agentRunDir = (runId: string) => path.join(ROOT, '.concordia', 'agent-runs', runId);
const journalLines = (runId: string) => { try { return fs.readFileSync(path.join(agentRunDir(runId), 'post-coma-journal.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return [] as string[]; } };
const decisionKey = (report: any) => Object.fromEntries((report.decisions ?? []).map((d: any) => [d.relationId, `${d.verdict}|${(d.reasonCodes ?? []).join(',')}`]));
const cleanRun = (runId: string) => { if (runId.startsWith('agent-round10-')) fs.rmSync(agentRunDir(runId), { recursive: true, force: true }); };

/**
 * The run is started in a child process and killed ("power cut") once its post-COMA journal holds k probes; the same run id is then resumed in this process against the same manifest and code,
 * and compared with an uninterrupted run of the same configuration. The run folders live under the ignored `.concordia/agent-runs` and are removed afterwards; the budget ledger is not involved.
 */
export async function runResume(bridgeKind: 'installed' | 'standin', targetK: number): Promise<ResumeCase> {
  const spec = specOf('B_ROUND10'), stamp = Date.now(), interruptedId = `agent-round10-resume-${stamp}`, fullId = `agent-round10-resumefull-${stamp}`;
  const empty = { targetK, journaledAtKill: 0, tornTail: false };
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-tsx.mjs'), path.join(ROOT, 'scripts', 'round10-integration.ts'), '--child-run', interruptedId, bridgeKind], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
    let exited = false; child.on('exit', () => { exited = true; });
    const deadline = Date.now() + 240_000;
    while (!exited && Date.now() < deadline && Math.max(0, journalLines(interruptedId).length - 1) < targetK) await sleep(10);
    if (!exited) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); }
    for (let i = 0; i < 200 && !exited; i++) await sleep(25);
    if (fs.existsSync(path.join(agentRunDir(interruptedId), 'engine-run.json'))) return { status: 'INTERRUPT_MISSED', detail: 'the child finished before the kill', ...empty };
    const lines = journalLines(interruptedId), probeLines = lines.slice(1);
    let torn = false; const valid = probeLines.filter(line => { try { JSON.parse(line); return true; } catch { torn = true; return false; } });
    if (valid.length === 0) return { status: 'UNAVAILABLE', detail: 'no probe reached the journal before the kill', ...empty };
    const resumed = await runConfig(spec, { bridge: bridgeKind, runId: interruptedId, persist: true, resume: true }), full = await runConfig(spec, { bridge: bridgeKind, runId: fullId, persist: true });
    const keyR = decisionKey(resumed.report), keyF = decisionKey(full.report), ids = [...new Set([...Object.keys(keyR), ...Object.keys(keyF)])].sort();
    const diffs = ids.filter(id => keyR[id] !== keyF[id]).map(id => `${id}: full ${keyF[id] ?? 'none'} / resumed ${keyR[id] ?? 'none'}`);
    const tokens = (run: RunOutcome) => run.report.budget?.phases?.byPhase?.modelReview?.used?.tokens ?? 0, approvedOf = (run: RunOutcome) => [...(run.report.phases?.candidateReview?.approved ?? [])].sort();
    const shape = (run: RunOutcome) => ({ queries: run.report.budget?.used?.queries ?? 0, reviewTokens: tokens(run), status: run.status, verdicts: (run.report.decisions ?? []).length, approved: approvedOf(run).length });
    return { status: 'RAN', detail: 'killed mid post-COMA, resumed with deps.resume', targetK, journaledAtKill: valid.length, tornTail: torn, full: shape(full), resumed: { ...shape(resumed), resume: resumed.report.resume ? { resumedProbes: resumed.report.resume.resumedProbes, newProbes: resumed.report.resume.newProbes, interruptions: resumed.report.resume.interruptions, journalFound: resumed.report.resume.journalFound } : null, resumedFrom: resumed.report.resume?.resumedFrom ?? null },
      identicalVerdicts: diffs.length === 0, verdictDiffs: diffs.slice(0, 10), queriesSaved: (full.report.budget?.used?.queries ?? 0) - (resumed.report.budget?.used?.queries ?? 0), sameApproved: JSON.stringify(approvedOf(resumed)) === JSON.stringify(approvedOf(full)) };
  } catch (error) { return { status: 'UNAVAILABLE', detail: error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}`.trim() : String(error), ...empty }; }
  finally { cleanRun(interruptedId); cleanRun(fullId); }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ the Round 9 code, re-run

const R9_DUMP = `import fs from 'node:fs';
import path from 'node:path';
import { runBlind } from './round9-integration.ts';
const [out, bridge, memory] = process.argv.slice(2);
const result = await runBlind({ bridge: bridge === 'standin' ? 'standin' : 'installed', reviewMode: 'MODEL_ADVERSARIAL', memoryDir: path.join(memory, 'LOCAL-SYNTHETIC') });
fs.writeFileSync(out, JSON.stringify({ report: result.report, durationMs: result.durationMs, bridge: result.bridge, status: result.status }));
`;
export interface R9CodeRun { ok: true; report: any; durationMs: number; bridge: string; status: string }
/**
 * The Round 9 code, run again today on the same fixture: `git archive` of the last Round 9 commit into a temp folder (a junction to node_modules and a copy of the installed COMA, nothing else shared),
 * where this lane's own Round 9 harness runs unchanged. It is the only way to tell what Round 10 changed from what the A/B switches change, because three Round 10 pieces have no switch.
 * Offline, nothing persisted, the budget ledger is not in the copy. Returns { ok: false } with the reason when git, tar or the junctions are not available.
 */
export function runR9Code(bridgeKind: 'installed' | 'standin'): R9CodeRun | { ok: false; reason: string } {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'concordia-r9code-')), copy = path.join(work, 'repo'), tar = path.join(work, 'head.tar');
  const run = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...(env ? { env } : {}), timeout: 600_000 });
  try {
    fs.mkdirSync(copy);
    if (run('git', ['archive', '--format=tar', '-o', tar, R9_COMMIT], ROOT).status !== 0) return { ok: false, reason: `git archive ${R9_COMMIT} failed` };
    if (run('tar', ['-xf', 'head.tar', '-C', 'repo'], work).status !== 0) return { ok: false, reason: 'tar extraction failed' };
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), 'junction');
    const python = path.join(ROOT, '.concordia', 'python');
    if (bridgeKind === 'installed' && fs.existsSync(python)) { fs.mkdirSync(path.join(copy, '.concordia')); fs.cpSync(python, path.join(copy, '.concordia', 'python'), { recursive: true }); /* the COMA provider rejects symlinked paths, so the installed COMA is copied (about 700 MB, removed afterwards) */ }
    const out = path.join(work, 'r9-report.json'), memory = path.join(work, 'memory');
    fs.writeFileSync(path.join(copy, 'scripts', 'r9-dump.ts'), R9_DUMP);
    const result = run(process.execPath, ['scripts/run-tsx.mjs', 'scripts/r9-dump.ts', out, bridgeKind, memory], copy, { ...process.env, TEMP: work, TMP: work, TMPDIR: work });
    if (result.status !== 0 || !fs.existsSync(out)) return { ok: false, reason: `the Round 9 harness exited ${result.status}: ${(result.stderr ?? '').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)}` };
    return { ok: true, ...JSON.parse(fs.readFileSync(out, 'utf8')) };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  finally {
    try { fs.rmdirSync(path.join(copy, 'node_modules')); } catch { /* not created */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ the integration

export interface R9CodeDiff { approvedOnlyR9: { id: string; gold: boolean; yes: boolean; fateInA: string }[]; approvedOnlyA: { id: string; gold: boolean; yes: boolean }[] }
export interface Integration {
  date: string; code: { head: string; uncommittedSrcFiles: number }; bridge: string; labelsSha: string; goldViolations: string[]; reference: R9Reference;
  m12: M12Case | null; resume: ResumeCase | null; previous: PreviousReport; shippedRun: Measures | null; shippedSwitches: R10Switches; cascadeWired: boolean; shipped: { reviewMode: string }; runs: Record<string, Measures>; primary: { a: Measures; b: Measures }; cost: Measures[]; r9Code: Measures | { unavailable: string } | null; r9Diff: { a: R9CodeDiff; b: R9CodeDiff } | null;
  diffs: { approvedOnlyA: string[]; approvedOnlyB: string[]; stageChanges: { id: string; a: string; b: string }[] };
  openItems: OpenItem[];
}
export interface OpenItem { id: number; owner: string; files: string; title: string; detail: string }
export const isMeasures = (value: Measures | { unavailable: string } | null): value is Measures => Boolean(value && 'funnel' in value);

export async function runIntegration(options: { bridge?: 'installed' | 'standin'; cost?: boolean; ceilings?: boolean; r9Code?: boolean; m12?: boolean; resume?: number; shipped?: boolean } = {}): Promise<Integration> {
  const labels = loadLabels(), gold = loadTpcdsGold(), bridgeKind = options.bridge ?? 'installed';
  const specs: RunSpec[] = [specOf('A_BASELINE'), specOf('B_ROUND10')];
  if (options.cost !== false) specs.push(specOf('A_CASCADE'), specOf('B_NO_CASCADE'), specOf('B_NO_EXTENDED'), specOf('B_NO_TIEBREAK'));
  if (options.ceilings) specs.push(specOf('A_BASELINE', 'MAX'), specOf('A_CASCADE', 'MAX'), specOf('B_NO_CASCADE', 'MAX'), specOf('B_ROUND10', 'MAX'), specOf('B_NO_TIEBREAK', 'MAX'));
  const runs: Record<string, Measures> = {}; let bridge = '';
  for (const spec of specs) { const run = await runConfig(spec, { bridge: bridgeKind }); bridge = run.bridge; runs[specKey(spec)] = measureRun(run, labels, gold); }
  const a = runs[specKey(specs[0]!)]!, b = runs[specKey(specs[1]!)]!;
  let r9Code: Integration['r9Code'] = null, r9Diff: { a: R9CodeDiff; b: R9CodeDiff } | null = null;
  if (options.r9Code) {
    const ran = runR9Code(bridgeKind);
    if (!ran.ok) r9Code = { unavailable: ran.reason };
    else {
      const spec: RunSpec = { name: 'R9_CODE', switches: SWITCHES.A_BASELINE, tokenCeiling: 'SHIPPED' };
      r9Code = measureRun({ spec, runId: String(ran.report.runId), status: ran.status, bridge: ran.bridge, durationMs: ran.durationMs, report: ran.report, overlay: null, sql: [], profiles: new Map(), reviewTies: [], appliedSwitches: [], blockedF4: 0 }, labels, gold);
      const goldIds = new Set(gold.edges.map(goldIdOf)), yes = new Set(labels.yes), setR9 = new Set(r9Code.approvedIds);
      const r9m = r9Code as Measures;
      const against = (m: Measures): R9CodeDiff => { const set = new Set(m.approvedIds); return { approvedOnlyR9: r9m.approvedIds.filter(id => !set.has(id)).sort().map(id => ({ id, gold: goldIds.has(id), yes: yes.has(id), fateInA: m.fates[id] ?? (m.fates[reverseId(id)] ? `ONLY_REVERSE_PROPOSED:${m.fates[reverseId(id)]}` : 'NOT_PROPOSED') })),
        approvedOnlyA: m.approvedIds.filter(id => !setR9.has(id)).sort().map(id => ({ id, gold: goldIds.has(id), yes: yes.has(id) })) }; };
      r9Diff = { a: against(a), b: against(b) };
    }
  }
  const m12 = options.m12 === false ? null : await runM12(bridgeKind, labels, gold), resume = options.resume ? await runResume(bridgeKind, options.resume) : null;
  const shippedRun = options.shipped === false ? null : measureRun(await runConfig(specOf('B_SHIPPED'), { bridge: bridgeKind }), labels, gold);
  const approvedA = new Set(a.approvedIds), approvedB = new Set(b.approvedIds);
  const git = (args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';
  const diffs = { approvedOnlyA: [...approvedA].filter(id => !approvedB.has(id)).sort(), approvedOnlyB: [...approvedB].filter(id => !approvedA.has(id)).sort(),
    stageChanges: gold.edges.filter(edge => a.funnelStages[edge.id] !== b.funnelStages[edge.id]).map(edge => ({ id: edge.id, a: a.funnelStages[edge.id]!, b: b.funnelStages[edge.id]! })) };
  const result: Integration = { date: new Date().toISOString().slice(0, 10), code: { head: git(['rev-parse', '--short', 'HEAD']) || 'unknown', uncommittedSrcFiles: git(['status', '--porcelain', '--', 'src']).split('\n').filter(Boolean).length }, bridge, labelsSha: labels.source.sha256,
    goldViolations: goldAtRuntimeViolationsR10(), reference: loadReference(), m12, resume, previous: loadPrevious(), shippedRun, shippedSwitches: (({ raw: _raw, ...rest }) => rest)(manifestSwitchesOf(resolveUniverseManifest('TPCDS'))), cascadeWired: fs.readFileSync(path.join(ROOT, 'src', 'agent', 'cli-run.ts'), 'utf8').includes('reviewCascade'), shipped: { reviewMode: String((resolveUniverseManifest('TPCDS') as any).reviewMode ?? 'HUMAN') }, runs, primary: { a, b }, cost: specs.slice(2).map(spec => runs[specKey(spec)]!), r9Code, r9Diff, diffs, openItems: [] };
  result.openItems = deriveOpenItems(result);
  return result;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ open items (derived from the measurements, so the list cannot go stale)

function deriveOpenItems(r: Integration): OpenItem[] {
  const items: Omit<OpenItem, 'id'>[] = [], { a, b } = r.primary;
  const manifestSchema = fs.readFileSync(path.join(ROOT, 'src', 'registry', 'universes.ts')).toString('latin1'), engineText = fs.readFileSync(path.join(ROOT, 'src', 'agent', 'engine.ts'), 'utf8');
  const find = (name: string, ceiling: 'SHIPPED' | 'MAX') => [a, b, ...r.cost].find(m => m.spec.name === name && m.spec.tokenCeiling === ceiling);
  if (manifestSchema.includes('fullEvidence?: boolean') && !engineText.includes('fullEvidenceExtendedProfile'))
    items.push({ owner: 'X3 (manifest schema) + X5 (engine)', files: 'src/registry/universes.ts, src/agent/engine.ts', title: 'The extended profile (F1x) cannot be declared on a valid manifest', detail: 'The engine has no dedicated manifest field for F1x and `fullEvidence` is validated as a boolean.' });
  if (!/tieBreakEnabled/.test(engineText))
    items.push({ owner: 'X5', files: 'src/agent/engine.ts', title: 'The engine passes no tie-break vector to post-COMA or to the review', detail: 'The manifest has no tieBreak switch that the engine reads.' });
  if (b.review.skippedByCascade > 0 && b.review.healthCalls === b.review.calls + b.review.skippedByCascade)
    items.push({ owner: 'X5', files: 'src/agent/engine.ts (`reviewHealthOf`)', title: 'Review health counts cascade-skipped calls as calls',
      detail: `With the cascade on, the review made ${b.review.calls} calls and skipped ${b.review.skippedByCascade}, but \`phases.candidateReview.health.calls\` is ${b.review.healthCalls} (= both). \`tally\` skips SKIPPED_BUDGET and NOT_NEEDED only, so SKIPPED_BY_CASCADE inflates the denominator of the invalid-call share and can hide a real INVALID share below the 25% threshold.` });
  const withVector = find('B_ROUND10', 'MAX'), noVector = find('B_NO_TIEBREAK', 'MAX'), noCascade = find('B_NO_CASCADE', 'MAX');
  if (withVector && noVector && withVector.review.tokens > noVector.review.tokens * 1.1)
    items.push({ owner: 'X8 (packet)', files: 'src/agent/model-review/evidence.ts, src/agent/model-review/prompts.ts', title: 'The tie-break block in the packet still costs more than 10% of the review',
      detail: `At the 4M ceiling the review with the cascade and without the tie-break takes ${noVector.review.tokens} tokens; with the tie-break (compact block) it takes ${withVector.review.tokens} (+${((withVector.review.tokens / noVector.review.tokens - 1) * 100).toFixed(0)}%)${noCascade ? `; without the cascade it takes ${noCascade.review.tokens}` : ''}.` });
  if (a.review.healthCodes.includes('MODEL_REVIEW_PARTIAL_BUDGET') || b.review.healthCodes.includes('MODEL_REVIEW_PARTIAL_BUDGET'))
    items.push({ owner: 'Central decision (manifest bounds: X3)', files: 'universes/TPCDS.json, capabilityBounds', title: 'At the shipped 3,000,000-token ceiling the review is cut',
      detail: `(a): ${a.review.healthCodes.join(',') || 'complete'}, ${a.review.cutRelations} of ${a.review.reviewed} reviewed relations lost at least one call to the budget (${a.review.tokens} tokens); (b): ${b.review.healthCodes.join(',') || 'complete'}, ${b.review.cutRelations} cut (${b.review.tokens} tokens). Approved stays ${a.review.approved} / ${b.review.approved} because the priority order (E5-08) spends the budget on the most promising relations first. Whether the ceiling, the packet or the cascade default should move is not this lane's call.` });
  const lost = [...(r.r9Diff?.a.approvedOnlyR9 ?? []), ...(r.r9Diff?.b.approvedOnlyR9 ?? [])].filter(item => /^FLAGGED:.*ONE_TO_ONE_EXTENSION/.test(item.fateInA)), viaGlobal = a.reversed.rows.filter(row => row.how === 'RECOVERED_BY_GLOBAL_UNIQUENESS').length;
  const missedFlagged = [a, b].flatMap(m => m.invariants.missedYesWhy.filter(item => item.stage === 'FLAGGED' && /ONE_TO_ONE_EXTENSION/.test(item.detail ?? '')));
  if (lost.length || missedFlagged.length)
    items.push({ owner: 'X4 (flag) + X8/X5 (review eligibility)', files: 'src/agent/post-coma.ts, src/agent/model-review/candidates.ts', title: 'A 1:1 extension is suspect, so it is never reviewed, so it never gets a contract',
      detail: `E2-02 marks a pair whose two ends are both globally unique as ONE_TO_ONE_EXTENSION ("no FK contract without review"), but the candidate review only takes candidates with no suspicion, so no review ever happens. Against the Round 9 code on the same fixture this flag accounts for ${lost.length} lost approvals (${lost.filter(item => item.gold).length} of them gold FKs, ${lost.filter(item => item.yes).length} F-04 YES): ${lost.map(item => item.id).join(', ') || 'n/a (no Round 9 re-run)'}; E2-02 recovered ${viaGlobal} reversed edge(s) by whole-table uniqueness in return. On this 5-6 row fixture a foreign-key column is unique by chance, which a live table rarely is, so the live cost is not known from here. "Without review" asks for a review path for these, not a permanent stop.` });
  const wrong = b.ties.wrongDecisive;
  if (wrong.length)
    items.push({ owner: 'X10', files: 'src/agent/tie-break.ts', title: 'The vector is decisive for a group whose winner is not the gold edge',
      detail: `Replaying the tie-break over the ${b.ties.groups.length} tie groups of (b): decisive by step ${fmtCounts(b.ties.byStep)}; ${wrong.length} decisive winners are not the gold edge (${fmtCounts(countBy(wrong.map(item => item.step)))}; winners ${[...new Set(wrong.map(item => item.winner))].join(', ')}). In the review, ${b.ties.review.decisive - b.ties.review.decisiveWinnerGold} of ${b.ties.review.decisive} decisive winners are not gold.` });
  if (r.r9Diff && isMeasures(r.r9Code) && r.r9Diff.b.approvedOnlyR9.length)
    items.push({ owner: 'see the table in section 9', files: 'src/agent/post-coma.ts (flags), src/agent/model-review/* (eligibility, floors)', title: `Round 10 (b) approves ${b.review.approved} contracts where the Round 9 code approved ${r.r9Code.review.approved}`,
      detail: `${r.r9Diff.b.approvedOnlyR9.length} relations approved by the Round 9 code are not approved by (b) (fate in section 9), ${r.r9Diff.b.approvedOnlyA.length} are approved only by (b). Same fixture, same COMA, same stand-in models. The listed fates name the stage that now stops each one.` });
  const bias = b.rangeBias;
  if (bias.onlyReasonGold > 0)
    items.push({ owner: 'X4', files: 'src/agent/post-coma.ts', title: 'RANGE_BIASED keeps gold edges out of the review', detail: `With F1x, ${bias.onlyReason} HIGH candidates are suspect only because of RANGE_BIASED; ${bias.onlyReasonGold} of them are gold FKs.` });
  if (!fs.readFileSync(path.join(ROOT, 'src', 'agent', 'cli-run.ts'), 'utf8').includes('reviewCascade'))
    items.push({ owner: 'X1 (CLI wiring) with X8 (review config)', files: 'src/agent/cli-run.ts (lines building createCandidateReview), src/agent/model-review/types.ts', title: 'The cheap cascade is declared nowhere the live run reads',
      detail: 'The cascade is `ModelReviewConfig.cascade` (default false), passed through `createCandidateReview({ config: { cascade: true } })`. There is no manifest field for it, and `src/agent/cli-run.ts` builds the live and the offline review without `config`, so a TPCDS run does not use it. To turn it on for the definitive run: pass `config: { cascade: true }` in both `createCandidateReview` calls of cli-run.ts (X1), or give it a manifest field that cli-run reads. This harness passes it through the same `createCandidateReview` option.' });
  if (r.m12) {
    const f = r.m12.withF4;
    if (f.rows.length && f.rows.every(row => (row.probedKeys ?? 0) >= 3 && (row.distinctKeys ?? 0) < 3 && !row.approved))
      items.push({ owner: 'X4 (diagnostic) with X8 (packet)', files: 'src/agent/post-coma.ts (`diagnose` input), src/agent/model-review/evidence.ts', title: 'F4 widens the probe but the review packet still counts the 1-key discovery sample',
        detail: `On the live-shaped fixture F4 lifts the coverage probe of the ${f.rows.length} M12 relations from ${r.m12.withoutF4.rows.map(row => row.probedKeys ?? '-').join('/')} to ${f.rows.map(row => row.probedKeys ?? '-').join('/')} keys, but \`diagnostic.multiplicity.from\` is still computed from the discovery sample rows (\`diagnose({ sourceRows: fromTable.sample.rows })\`), so the packet says ${f.rows.map(row => row.distinctKeys ?? '-').join('/')} distinct source key(s) and the review defers all ${f.rows.length} with INSUFFICIENT_DISTINCT_KEYS: none gets a contract or a verdict. The live M12 relations would stay deferred even though the probe now has the keys. The multiplicity of the source side should come from the keys actually probed.` });
  }
  if (r.resume && r.resume.status === 'RAN' && r.resume.identicalVerdicts === false)
    items.push({ owner: 'X5 / X4', files: 'src/agent/engine.ts, src/agent/post-coma.ts', title: 'A resumed run does not reproduce the verdicts of an uninterrupted run', detail: `${r.resume.verdictDiffs?.length} verdict(s) differ: ${(r.resume.verdictDiffs ?? []).slice(0, 3).join('; ')}` });
  if (r.resume && r.resume.status !== 'RAN')
    items.push({ owner: 'X9 (this harness) / X5', files: 'scripts/round10-integration.ts', title: 'The resume case did not run', detail: `${r.resume.status}: ${r.resume.detail}` });
  const income = b.ties.review.winnersNotGold.filter(id => /__income_band\./.test(id));
  if (income.length)
    items.push({ owner: 'X10', files: 'src/agent/tie-break.ts', title: 'A decisive tie-break still points at income_band', detail: `${income.length} review tie group(s) have a decisive winner on income_band: ${income.slice(0, 4).join(', ')}.` });
  const bMaxItem = r.cost.find(m => m.spec.name === 'B_ROUND10' && m.spec.tokenCeiling === 'MAX');
  if (bMaxItem && bMaxItem.review.healthCodes.includes('MODEL_REVIEW_PARTIAL_BUDGET'))
    items.push({ owner: 'Central decision (manifest bounds: X3)', files: 'universes/TPCDS.json', title: '(b) is still cut at the 4,000,000-token run ceiling', detail: `${bMaxItem.review.cutRelations} relations lose a call at 4M (${bMaxItem.review.tokens} tokens used); see section 13 for the extrapolated need.` });
  if (r.shippedRun && r.shippedRun.review.tokens > 0.9 * 3_000_000)
    items.push({ owner: 'Central decision (manifest bounds: X3)', files: 'universes/registry.json (TPCDS capabilityBounds.AGENT_EXPLORATION.maxTokensPerRun)', title: 'The complete (b) review uses almost all of the shipped 3,000,000 tokens',
      detail: `Through the real path (b) is COMPLETED with ${r.shippedRun.review.tokens} stand-in tokens, ${(100 * r.shippedRun.review.tokens / 3_000_000).toFixed(0)}% of the shipped ceiling (margin ${3_000_000 - r.shippedRun.review.tokens} tokens). Stand-in tokens are chars/2 of scripted prompts, not what a live model reports, and this fixture is not the live table, so the margin says "close", not "fits". The run ceiling is 4,000,000 (${(100 * r.shippedRun.review.tokens / 4_000_000).toFixed(0)}% used).` });
  return items.map((item, index) => ({ id: index + 1, ...item }));
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ report

const cell = (n: number, d: number) => `${n}/${d}`;
const SHORT: Record<string, string> = { A_BASELINE: '(a) baseline', B_ROUND10: '(b) Round 10', A_CASCADE: 'a + cascade', B_NO_CASCADE: 'b minus cascade', B_NO_EXTENDED: 'b minus F1x', B_NO_TIEBREAK: 'b minus tie-break', R9_CODE: 'R9 code' };
const nameOf = (m: Measures) => `${SHORT[m.spec.name] ?? m.spec.name}${m.spec.tokenCeiling === 'MAX' ? ' @4M' : ''}`;
function fmtCounts(counts: Record<string, number>): string { const entries = Object.entries(counts).sort(([x], [y]) => x.localeCompare(y, 'en')); return entries.length ? entries.map(([key, n]) => `${key} ${n}`).join(', ') : 'none'; }
const onOff = (value: boolean) => (value ? 'on' : 'off');

export function renderReport(r: Integration): string {
  const { a, b } = r.primary, lines: string[] = [], push = (...items: string[]) => lines.push(...items);
  const gold = a.invariants.goldEdges, r9 = isMeasures(r.r9Code) ? r.r9Code : null, ia = a.invariants, ib = b.invariants, ref = r.reference.numbers;
  const cols = r9 ? [r9, a, b] : [a, b], colHead = (names: string[]) => `| ${names.join(' | ')} |`, sep = (n: number) => `|${'---|'.repeat(n)}`;
  push(`# Round 10 (phases A and B): offline A/B integration run (X9), ${r.date}`, '',
    `**Label: OFFLINE / SYNTHETIC fixture / SCRIPTED stand-in models (STAND_IN_OFFLINE).** Nothing live, no \`.env\`, no budget ledger, nothing persisted, no push. COMA: ${r.bridge}. The review models are scripted functions of the packet: they measure the pipeline (cost, wiring, invariants), never a model. Every number carries its denominator.`,
    `Code state: HEAD \`${r.code.head}\` plus ${r.code.uncommittedSrcFiles} uncommitted file(s) under src/ in the shared checkout. Reproduce: \`node scripts/run-tsx.mjs scripts/round10-integration.ts --report\` (about 1 minute with the installed COMA; \`--no-r9-code\` skips the Round 9 re-run).`,
    `The gold (${gold} single-column TPC-DS edges) and the F-04 labels (25 approved, 3 deferred, 3 decoys; sha256 \`${r.labelsSha.slice(0, 16)}…\`) are an **offline evaluation set** applied after the runs; \`goldAtRuntimeViolations\`: **${r.goldViolations.length}**${r.goldViolations.length ? ` (${r.goldViolations.join('; ')})` : ''}.`, '',
    '## 0. What was run', '| Run | Consistency | Review cascade | Extended profile F1x | Tie-break vector | Token ceiling | Status | Seconds |', '|---|---|---|---|---|---|---|---|',
    ...(r9 ? [`| R9 code (\`${R9_COMMIT}\`, git archive, re-run today) | n/a | n/a | n/a | n/a | 3,000,000 (shipped then) | ${r9.status} | ${(r9.durationMs / 1000).toFixed(0)} |`] : []),
    ...[a, b, ...r.cost].map(m => `| ${nameOf(m)} | ${m.spec.switches.consistency ? 'on' : 'off'} | ${m.spec.switches.cascade ? 'on' : 'off'} | ${onOff(m.spec.switches.extendedProfile)} | ${onOff(m.spec.switches.tieBreak)} | ${m.spec.tokenCeiling === 'MAX' ? '4,000,000 (harness)' : '3,000,000 (shipped)'} | ${m.status} | ${(m.durationMs / 1000).toFixed(0)} |`),
    '', 'Always on at HEAD, with no switch, in **both** (a) and (b): the per-run profile cache (E1-06), the orientation of ambiguous pairs by global uniqueness (E2-02, which also marks 1:1 pairs) and the role dimensions (E2-04), because the shipped TPCDS manifest already declares `fullEvidence`. So (a) is "every switchable Round 10 feature off", not the Round 9 code; ' + (r9 ? 'the first row re-runs the real Round 9 code on the same fixture, COMA and stand-ins, so the three always-on pieces show up as the difference between that row and (a).' : r.r9Code && 'unavailable' in r.r9Code ? `the Round 9 code could not be re-run here (${r.r9Code.unavailable}); the published Round 9 numbers (\`${R9_COMMIT}\`) are used as a REPLAY reference instead.` : 'the published Round 9 numbers (`' + R9_COMMIT + '`) are the REPLAY reference.') +
    ' In every run the shipped TPCDS config is used (post-COMA `coverAll`+`homonymGuard`, `fullEvidence`, 4,200 queries, 3,000,000 tokens, 200 relations); ' + (r.shipped.reviewMode === 'MODEL_ADVERSARIAL' ? 'the shipped manifest already declares reviewMode MODEL_ADVERSARIAL (753993a), so the run needs no override of the review mode' : 'the only in-process override is the manifest review mode ' + r.shipped.reviewMode + ' -> MODEL_ADVERSARIAL') + (r.cost.some(m => m.spec.tokenCeiling === 'MAX') ? ', plus the token ceiling 3,000,000 -> 4,000,000 on the rows marked @4M (the run ceiling), so the review is not budget-cut and the cost of each switch is comparable' : '') + '.', '');

  // ---- 1 headline
  push('## 1. Headline', colHead([ 'Measure', ...(r9 ? ['R9 code (re-run)'] : []), '(a) baseline', '(b) Round 10', ...(r9 ? [] : ['R9 published (REPLAY)']) ]), sep(r9 ? 4 : 4),
    `| Candidates probed | ${[...(r9 ? [cell(r9.candidates.executed, r9.candidates.proposals)] : []), cell(a.candidates.executed, a.candidates.proposals), cell(b.candidates.executed, b.candidates.proposals), ...(r9 ? [] : [cell(ref.candidatesProbed!, ref.candidates!)])].join(' | ')} |`,
    `| Eligible candidates reviewed (HIGH coverage, no flag) / candidates; approved | ${[...(r9 ? [`${cell(r9.review.reviewed, r9.review.candidates)}; approved ${r9.review.approved}`] : []), `${cell(a.review.reviewed, a.review.candidates)}; approved ${a.review.approved}`, `${cell(b.review.reviewed, b.review.candidates)}; approved ${b.review.approved}`, ...(r9 ? [] : [`${cell(ref.reviewed!, ref.candidatesProbed!)}; approved ${ref.approved}`])].join(' | ')} |`,
    `| F-04 YES (25) with an approved contract | ${[...(r9 ? [cell(r9.invariants.yesApproved, 25)] : []), cell(ia.yesApproved, 25), cell(ib.yesApproved, 25), ...(r9 ? [] : [cell(ref.yesAccepted!, 25)])].join(' | ')} |`,
    `| F-04 deferred (M12, 3) NOT approved | ${[...(r9 ? [cell(3 - r9.invariants.deferredApproved, 3)] : []), cell(3 - ia.deferredApproved, 3), cell(3 - ib.deferredApproved, 3), ...(r9 ? [] : [cell(ref.deferredNotAccepted!, 3)])].join(' | ')} |`,
    `| Decoys (3) without a contract | ${[...(r9 ? [cell(3 - r9.invariants.decoyContracts, 3)] : []), cell(3 - ia.decoyContracts, 3), cell(3 - ib.decoyContracts, 3), ...(r9 ? [] : [cell(ref.decoysWithoutContract!, 3)])].join(' | ')} |`,
    `| MODEL_REVIEWED confused with HUMAN_REVIEWED | ${[...(r9 ? [`**${r9.invariants.confusions}**`] : []), `**${ia.confusions}**`, `**${ib.confusions}**`, ...(r9 ? [] : ['0'])].join(' | ')} |`,
    `| Approved contracts that are true FKs (gold ${gold}); recall | ${[...(r9 ? [`${cell(r9.invariants.approvedTrue, r9.invariants.approved)}; ${cell(r9.invariants.recall, gold)}`] : []), `${cell(ia.approvedTrue, ia.approved)}; ${cell(ia.recall, gold)}`, `${cell(ib.approvedTrue, ib.approved)}; ${cell(ib.recall, gold)}`, ...(r9 ? [] : [`${cell(ref.approvedTrue!, ref.approved!)}; ${cell(ref.approvedTrue!, gold)}`])].join(' | ')} |`,
    `| M12 relations with ≥3 distinct source keys | ${[...(r9 ? [cell(r9.invariants.m12Reached, 3)] : []), cell(ia.m12Reached, 3), cell(ib.m12Reached, 3), ...(r9 ? [] : [cell(ref.m12Reached!, 3)])].join(' | ')} |`,
    `| Reversed gold edges recovered by post-COMA | ${[...(r9 ? [cell(r9.reversed.recovered, r9.reversed.denominator)] : []), cell(a.reversed.recovered, a.reversed.denominator), cell(b.reversed.recovered, b.reversed.denominator), ...(r9 ? [] : ['not recorded'])].join(' | ')} |`,
    `| Review calls made / tokens (STAND-IN) | ${[...(r9 ? [`${r9.review.calls} / ${r9.review.tokens}`] : []), `${a.review.calls} / ${a.review.tokens}`, `${b.review.calls} / ${b.review.tokens}`, ...(r9 ? [] : [`n/a (${ref.reviewTokens} tokens, other harness path)`])].join(' | ')} |`,
    `| SQL statements (budget count) | ${[...(r9 ? [String(r9.sql.budgetQueries)] : []), String(a.sql.budgetQueries), String(b.sql.budgetQueries), ...(r9 ? [] : [String(ref.sqlStatements)])].join(' | ')} |`,
    `| Memory batch (N74): admitted of total / quarantined | ${[...(r9 ? ['n/a (before N74)'] : []), `${a.memory.admitted ?? '-'} of ${a.memory.total ?? '-'} / ${a.memory.rejected ?? '-'}`, `${b.memory.admitted ?? '-'} of ${b.memory.total ?? '-'} / ${b.memory.rejected ?? '-'}`, ...(r9 ? [] : ['n/a (before N74)'])].join(' | ')} |`,
    `| Run status | ${[...(r9 ? [r9.status] : []), a.status, b.status, ...(r9 ? [] : ['COMPLETED'])].join(' | ')} |`, '');

  // ---- 1b against the previous report
  const pv = r.previous.numbers;
  push(`### 1b. Against the previous report (HEAD \`${r.previous.source.commit}\`) and the Round 9 code`, '', '| Measure | Previous (b) | (b) now | R9 code (re-run) |', '|---|---|---|---|',
    `| Approved contracts / true FKs | ${pv.bApproved} / ${pv.bApprovedTrue} | ${ib.approved} / ${ib.approvedTrue} | ${r9 ? `${r9.invariants.approved} / ${r9.invariants.approvedTrue}` : '-'} |`, `| F-04 YES approved | ${pv.bYesApproved}/25 | ${ib.yesApproved}/25 | ${r9 ? `${r9.invariants.yesApproved}/25` : '-'} |`, `| F-04 deferred not approved | ${pv.bDeferredNotApproved}/3 | ${3 - ib.deferredApproved}/3 | ${r9 ? `${3 - r9.invariants.deferredApproved}/3` : '-'} |`,
    `| Decoys without a contract | ${pv.bDecoysWithoutContract}/3 | ${3 - ib.decoyContracts}/3 | ${r9 ? `${3 - r9.invariants.decoyContracts}/3` : '-'} |`, `| Review calls / tokens | ${pv.bReviewCalls} / ${pv.bReviewTokens} | ${b.review.calls} / ${b.review.tokens} | ${r9 ? `${r9.review.calls} / ${r9.review.tokens}` : '-'} |`, `| SQL (budget) / status | ${pv.bSql} / ${pv.bStatus} | ${b.sql.budgetQueries} / ${b.status} | ${r9 ? `${r9.sql.budgetQueries} / ${r9.status}` : '-'} |`,
    `| Cascade-skipped calls / review tie groups / decisive / decisive winners that are gold | ${pv.bSkippedByCascade} / ${pv.bTieGroupsInReview} / ${pv.bReviewDecisive} / ${pv.bReviewDecisiveGold} | ${b.review.skippedByCascade} / ${b.ties.review.groups} / ${b.ties.review.decisive} / ${b.ties.review.decisiveWinnerGold} | n/a |`, '',
    r9 ? `Approvals of the R9 code that (b) does not have: ${r.r9Diff?.b.approvedOnlyR9.length ?? '?'} (${r.r9Diff?.b.approvedOnlyR9.filter(item => /ONE_TO_ONE/.test(item.fateInA)).length ?? '?'} of them stopped by the 1:1 trait); approvals of (b) that the R9 code does not have: ${r.r9Diff?.b.approvedOnlyA.length ?? '?'}.` : '', '');

  // ---- 2 funnel
  const stages = ['NOT_PROPOSED_BY_COMA', 'REVERSED', 'NOT_PROBED_BUDGET', 'NOT_EXECUTABLE', 'COVERAGE_NOT_HIGH', 'FLAGGED', 'NOT_REVIEWED_BUDGET', 'NOT_REVIEWED_NO_REVIEW', 'REVIEW_REJECT', 'REVIEW_DEFER', 'CONSISTENCY_DEMOTED', 'NO_DECISION', 'PROBE_INDETERMINADA', 'PROBE_ENGANOSA', 'SOSTENIDA'];
  const countStage = (m: Measures, stage: string) => Object.values(m.funnelStages).filter(value => value === stage).length;
  push(`## 2. Recall funnel (X3, \`a5e4880\`): the first stage that lost each of the ${gold} single-column gold edges`, colHead(['First stage that stopped the edge', ...cols.map(nameOf)]), sep(cols.length + 1),
    ...stages.filter(stage => cols.some(m => countStage(m, stage) > 0) || stage === 'SOSTENIDA').map(stage => `| ${stage} | ${cols.map(m => countStage(m, stage)).join(' | ')} |`), `| **Gold edges** | ${cols.map(() => gold).join(' | ')} |`, '',
    colHead(['Still alive after', ...cols.map(nameOf)]), sep(cols.length + 1),
    ...(['proposed', 'probed', 'coverageHigh', 'unflagged', 'reviewedOrConfigured', 'approvedOrConfigured', 'sostenida'] as const).map(key => `| ${({ proposed: 'proposed by COMA (direct direction)', probed: 'coverage probe executed', coverageHigh: 'coverage HIGH', unflagged: 'not flagged by post-COMA', reviewedOrConfigured: 'reviewed', approvedOrConfigured: 'approved (after consistency)', sostenida: 'SOSTENIDA' })[key]} | ${cols.map(m => cell(m.funnel.reach[key], gold)).join(' | ')} |`), '',
    `Gold edges stopped at FLAGGED, by reason: ${cols.map(m => `${nameOf(m)}: ${fmtCounts(m.flaggedGold)}`).join('; ')}.`, '');
  if (r.diffs.stageChanges.length) push('Gold edges whose losing stage differs between (a) and (b):', '', '| Gold edge | (a) | (b) | Detail (b) |', '|---|---|---|---|', ...r.diffs.stageChanges.map(item => `| ${item.id} | ${item.a} | ${item.b} | ${b.funnelDetail[item.id] ?? ''} |`), '');
  else push('**No gold edge changes its losing stage between (a) and (b)**: the switches change cost and trace, not which edges survive, on this fixture.', '');
  push('REVIEW_REJECT / REVIEW_DEFER are edges the model did not approve; NOT_REVIEWED_BUDGET would be eligible edges the ceiling left unreviewed (priority order, E5-08). CONSISTENCY_DEMOTED is this lane\'s split of X3\'s REVIEW_DEFER with detail `CONSISTENCY_*`.', '');

  // ---- 3 ties
  push('## 3. Ties between sibling targets (one source column, several HIGH targets)', '',
    'Groups are the HIGH, otherwise unsuspected candidates that share a source column, replayed through X10\'s `orderTies` with the whole-table profiles the run measured (zero extra SQL). With `manifest.tieBreak.enabled` ((b)) the ENGINE puts the vector into post-COMA (the guard uses it before name affinity; the "live" row counts the losers it marked) and into the review (the resolver the engine hands over, wrapped here only to record each answer). In (a) the guard decides by name affinity alone. The replay rows say what the vector decides over the same groups in either run.', '',
    '| Measure | (a) baseline | (b) Round 10 |', '|---|---|---|',
    `| Tie groups | ${a.ties.groups.length} | ${b.ties.groups.length} |`,
    `| Resolved by the post-COMA guard (name affinity; losers marked COMPETING_TARGET) | ${cell(a.ties.guardResolved, a.ties.groups.length)} | ${cell(b.ties.guardResolved, b.ties.groups.length)} |`,
    `| Left open by the guard | ${a.ties.unresolved} | ${b.ties.unresolved} |`,
    `| Vector decisive, all groups (replay) | ${cell(a.ties.vectorDecisive, a.ties.groups.length)} (${fmtCounts(a.ties.byStep)}) | ${cell(b.ties.vectorDecisive, b.ties.groups.length)} (${fmtCounts(b.ties.byStep)}) |`,
    `| Vector decisive among the groups the guard left open (replay) | ${cell(a.ties.vectorDecisiveOfUnresolved, a.ties.unresolved)} | ${cell(b.ties.vectorDecisiveOfUnresolved, b.ties.unresolved)} |`,
    `| Vector deferred, tie stays (replay) | ${cell(a.ties.deferred, a.ties.groups.length)}: ${fmtCounts(a.ties.deferralReasons)} | ${cell(b.ties.deferred, b.ties.groups.length)}: ${fmtCounts(b.ties.deferralReasons)} |`,
    `| Decisive winner is the gold edge / is not (a gold sibling exists) / group has no gold edge | ${a.ties.decisiveWinnerGold} / ${a.ties.decisiveWinnerNotGold} / ${a.ties.decisiveNoGold} | ${b.ties.decisiveWinnerGold} / ${b.ties.decisiveWinnerNotGold} / ${b.ties.decisiveNoGold} |`,
    `| Post-COMA losers marked by the engine with a tie-break (live) | ${a.liveVector} | ${b.liveVector} |`,
    `| **Groups the review received with the engine's resolver** | 0 (no resolver) | ${b.ties.review.groups}: ${b.ties.review.decisive} decisive (${fmtCounts(b.ties.review.byStep)}), ${b.ties.review.deferred} deferred (${fmtCounts(b.ties.review.deferralReasons)}) |`,
    `| Review: decisive winners that are gold / that the review approved | n/a | ${cell(b.ties.review.decisiveWinnerGold, b.ties.review.decisive)} / ${cell(b.ties.review.decisiveWinnerApproved, b.ties.review.decisive)} |`, '',
    `| Review: decisive winners that are not gold (and how many point at income_band) | n/a | ${b.ties.review.winnersNotGold.length} (${b.ties.review.winnersNotGold.filter(id => /__income_band./.test(id)).length}) |`, '',
    `Reading: replay winners that are the gold edge: ${b.ties.decisiveWinnerGold} of ${b.ties.vectorDecisive} decisive groups (${fmtCounts(b.ties.byStep)}); not the gold edge: ${b.ties.wrongDecisive.length}. Deferred review groups are the ones where nothing separated the siblings; every deferral keeps the defer (the tie is not settled by a guess).`, '');
  if (b.ties.wrongDecisive.length) push('Decisive winners that are not the gold edge (replay, (b)):', '', '| Source column | Winner by the vector | Decided by | Gold target(s) in the group |', '|---|---|---|---|', ...b.ties.wrongDecisive.map(item => `| ${item.source} | ${item.winner} | ${item.step} | ${item.goldTargets.join(', ')} |`), '');
  push('Every review tie group, with its reason, is in appendix A.', '');

  // ---- 4 reversed
  push('## 4. Reversed edges recovered', '', 'A gold edge counts as reversed when COMA proposed the pair the wrong way round. "Recovered" = post-COMA turned it (by the sample, SWAPPED_TARGET_UNIQUE, or by whole-table uniqueness, SWAPPED_GLOBAL_UNIQUENESS, E2-02); "still reversed" = the direct direction never entered the pipeline.', '',
    colHead(['Measure', ...cols.map(nameOf)]), sep(cols.length + 1),
    `| Reversed at COMA, recovered by post-COMA | ${cols.map(m => cell(m.reversed.recovered, m.reversed.denominator)).join(' | ')} |`,
    `| ... of those, reach SOSTENIDA | ${cols.map(m => cell(m.reversed.recoveredSustained, m.reversed.recovered)).join(' | ')} |`,
    `| ... by whole-table uniqueness (E2-02) | ${cols.map(m => cell(m.reversed.rows.filter(row => row.how === 'RECOVERED_BY_GLOBAL_UNIQUENESS').length, m.reversed.denominator)).join(' | ')} |`,
    `| Gold edges COMA had right that post-COMA turned the wrong way | ${cols.map(m => m.reversed.misOriented).join(' | ')} |`, '');
  const interesting = (m: Measures) => m.reversed.rows.filter(row => row.how === 'STILL_REVERSED' || row.how === 'MIS_ORIENTED_BY_POST_COMA');
  push(`Recovered edges end: ${fmtCounts(Object.fromEntries(Object.entries(countByStage(b.reversed.rows.filter(row => row.how.startsWith('RECOVERED')))).map(([k, v]) => [k, v])))} in (b). The edges still reversed in (b) (${interesting(b).length}), and the same edges in (a):`, '', '| Gold edge | (a) how / funnel | (b) how / funnel |', '|---|---|---|',
    ...interesting(b).map(row => { const other = a.reversed.rows.find(x => x.goldId === row.goldId); return `| ${row.goldId}${/p_end_date_sk/.test(row.goldId) ? ' **(promotion case)**' : ''} | ${other ? `${other.how} / ${other.stage}` : '-'} | ${row.how} / ${row.stage} |`; }), '');
  push('**The `promotion.p_end_date_sk` case** (evidence from the run, (b)):', '', '| Gold edge | Proposal in the run | Orientation | Rank class | Global uniqueness (from / to) | Coverage | Suspect | Profile of the source column of the proposal | Profile of the target column |', '|---|---|---|---|---|---|---|---|---|',
    ...b.reversed.promotionDetail.map(item => `| ${item.goldId} | ${item.proposal ?? 'none'} | ${item.orientation ?? '-'} | ${item.rankClass ?? '-'} | ${item.globalUniqueness ? `${(item.globalUniqueness as any).from} / ${(item.globalUniqueness as any).to}` : '-'} | ${item.coverage ?? '-'} | ${item.suspect.join(',') || 'none'} | ${profileText(item.fromProfile)} | ${profileText(item.toProfile)} |`), '',
    'Reading: on this fixture both ends of the pair are globally unique (the promotion table has 5 rows and `p_end_date_sk` repeats nothing), so neither the sample nor whole-table uniqueness can say which side is the key: E2-02 marks it ONE_TO_ONE and leaves the orientation as COMA proposed it. The orientation rule works when one side repeats; a foreign key that is unique by chance in a tiny table is outside what any uniqueness rule can orient. Whether the live table (300 promotions) repeats is a question for the live run.', '');

  // ---- 5 consistency
  push('## 5. Global consistency (E2-03): edges demoted by rule', '', '| Measure | (a) baseline | (b) Round 10 |', '|---|---|---|',
    `| Status | ${a.consistency.status} | ${b.consistency.status} |`, `| Approved contracts before / after the pass | ${a.consistency.approvedBefore} / ${a.consistency.kept} | ${b.consistency.approvedBefore} / ${b.consistency.kept} |`,
    `| Edges demoted (FK_ONCE / CYCLE / TRANSITIVE) | ${a.consistency.demoted.length} | ${b.consistency.demoted.length}${b.consistency.demoted.length ? ` (${fmtCounts(b.consistency.byRule)})` : ' (FK_ONCE 0, CYCLE 0, TRANSITIVE 0)'} |`,
    `| **Demoted edges that are true FKs in the gold** | n/a (pass off) | **${cell(b.consistency.trueFkDemoted, b.consistency.demoted.length)}** |`, `| Ties the pass left undecided (never dropped) | n/a | ${b.consistency.unresolved} |`, '');
  if (b.consistency.demoted.length) push('| Demoted edge | Rule | Winner | Gold FK | Winner gold FK |', '|---|---|---|---|---|', ...b.consistency.demoted.map(item => `| ${item.id} | ${item.rule} | ${item.winner ?? '-'} | ${item.goldFk ? '**yes (a true FK was demoted)**' : item.goldReversed ? 'reversed orientation' : 'no'} | ${item.winnerGold ? 'yes' : 'no'} |`), '');
  else push(`The pass ran (${b.consistency.status}) over ${b.consistency.approvedBefore} approved contracts and demoted none: no source column has a second approved target, there is no cycle and no transitive shortcut among them. That is a measurement. The pass acts on APPROVED edges, which on this fixture are already clean (${cell(ib.approvedTrue, ib.approved)} are gold FKs), so it has nothing to remove; it was not exercised against a dirty approved set here (its unit tests do that).`, '');

  // ---- 6 cost
  const rank = (m: Measures) => (m.spec.tokenCeiling === 'MAX' ? 1000 : 0) + ['A_BASELINE', 'A_CASCADE', 'B_NO_CASCADE', 'B_NO_EXTENDED', 'B_NO_TIEBREAK', 'B_ROUND10'].indexOf(m.spec.name);
  const costRows = [a, ...r.cost, b].filter((m, i, all) => all.indexOf(m) === i).sort((x, y) => rank(x) - rank(y));
  push('## 6. Review cost (STAND-IN tokens: chars/2 of the scripted prompt and answer; calls are scripted, nothing was generated)', '',
    '| Run | Candidates eligible and reviewed / candidates | Approved | Calls made | Tokens | Calls SKIPPED_BY_CASCADE | Est. tokens the cascade avoided | Relations cut by budget (calls skipped) | Review status / health codes | Tokens per approved |', '|---|---|---|---|---|---|---|---|---|---|',
    ...costRows.map(m => `| ${nameOf(m)} | ${cell(m.review.reviewed, m.review.candidates)} | ${m.review.approved} | ${m.review.calls} | ${m.review.tokens} | ${m.review.skippedByCascade} | ${m.review.cascadeTokensAvoided} | ${m.review.cutRelations} (${m.review.skippedBudget}) | ${m.review.status} / ${m.review.healthCodes.join(',') || 'none'} | ${m.review.approved ? Math.round(m.review.tokens / m.review.approved) : '-'} |`), '',
    ...costNotes(r), '');
  if (b.review.modelTable.length) push('Model table per role (E5-07, run (b)):', '', '| Role | Actor | Model ids in receipts | Calls | Skipped by cascade | Tokens |', '|---|---|---|---|---|---|', ...b.review.modelTable.map((row: any) => `| ${row.role} | ${row.actor} | ${(row.models ?? []).map((item: any) => `${item.model} x${item.calls}`).join(', ') || '-'} | ${row.calls} | ${row.skippedByCascade} | ${row.tokens} |`), '');

  // ---- 7 sql
  push('## 7. SQL (SYNTHETIC fixture; counted from the statements that reached the client)', '', '| Measure | (a) baseline | (b) Round 10 |', '|---|---|---|',
    `| Budget count, all phases | ${a.sql.budgetQueries} (of 4,200) | ${b.sql.budgetQueries} (of 4,200) |`, `| By phase | ${fmtCounts(a.sql.byPhase)} | ${fmtCounts(b.sql.byPhase)} |`, `| Statements by closed form | ${fmtCounts(a.sql.forms)} | ${fmtCounts(b.sql.forms)} |`,
    `| Whole-table profile scans (F1 or F1x, one scan each) | ${a.sql.profileScans} over ${a.sql.profileColumns} columns | ${b.sql.profileScans} over ${b.sql.profileColumns} columns |`,
    `| **Max scans of one column in the run** (expected ≤ 1) | **${a.sql.maxScansPerColumn}** | **${b.sql.maxScansPerColumn}** |`, `| Columns scanned exactly once | ${cell(a.sql.columnsScannedOnce, a.sql.profileColumns)} | ${cell(b.sql.columnsScannedOnce, b.sql.profileColumns)} |`,
    `| Columns scanned more than once | ${a.sql.repeatedColumns.join(', ') || 'none'} | ${b.sql.repeatedColumns.join(', ') || 'none'} |`,
    `| Profile uses served from the cache that the records show (full evidence + tie targets) | ${a.sql.cachedUses.fullEvidence} + ${a.sql.cachedUses.tieTargets} | ${b.sql.cachedUses.fullEvidence} + ${b.sql.cachedUses.tieTargets} |`, '',
    `With the extended profile (F1x) the same single scan also returns MIN, MAX and the average length: ${b.sql.forms.F1x ?? 0} F1x scans in (b) replace the ${a.sql.forms.F1 ?? 0} F1 scans of (a), with no extra statement. Without the cache each of the ${ia.approved} contract probes would scan its source and its target, the tie evidence its targets and post-COMA the endpoints of ambiguous pairs; the run sent ${a.sql.profileScans} profile scans. The post-COMA reader's own cache hits are not itemised by the engine (the cache statistics are not in the report).`, '');

  // ---- 8 invariants
  push('## 8. Invariants', '', '| Invariant | (a) baseline | (b) Round 10 | Holds |', '|---|---|---|---|',
    `| Decoys (3) without a contract | ${cell(3 - ia.decoyContracts, 3)} | ${cell(3 - ib.decoyContracts, 3)} | **${ia.decoyContracts === 0 && ib.decoyContracts === 0 ? 'yes' : 'NO'}** |`,
    `| MODEL_REVIEWED confused with HUMAN_REVIEWED | ${ia.confusions} | ${ib.confusions} | **${ia.confusions === 0 && ib.confusions === 0 ? 'yes (0)' : 'NO'}** |`,
    `| Every decision and memory claim carries MODEL_REVIEWED | ${cell(ia.decisions - ia.nonModelOrigin, ia.decisions)} and ${cell(ia.claims - ia.claimsNonModel, ia.claims)} | ${cell(ib.decisions - ib.nonModelOrigin, ib.decisions)} and ${cell(ib.claims - ib.claimsNonModel, ib.claims)} | **${ia.nonModelOrigin + ia.claimsNonModel + ib.nonModelOrigin + ib.claimsNonModel === 0 ? 'yes' : 'NO'}** |`,
    `| F-04 YES (25) with an approved contract | ${cell(ia.yesApproved, 25)} | ${cell(ib.yesApproved, 25)} | agreement, not an invariant |`,
    `| F-04 deferred (3) not approved | ${cell(3 - ia.deferredApproved, 3)} | ${cell(3 - ib.deferredApproved, 3)} | agreement, not an invariant: on the fixture M12 reaches ≥3 keys, so an approval is the intended effect of the sampling fix |`,
    `| Precision of the approved contracts against the gold | ${cell(ia.approvedTrue, ia.approved)} (${ia.approvedFalse} not in gold, ${ia.approvedReversed} reversed) | ${cell(ib.approvedTrue, ib.approved)} (${ib.approvedFalse} not in gold, ${ib.approvedReversed} reversed) | R9 published: ${cell(ref.approvedTrue!, ref.approved!)} |`,
    `| Precision of the SOSTENIDA verdicts against the gold | ${cell(ia.sustainedTrue, ia.sustained)} | ${cell(ib.sustainedTrue, ib.sustained)} | |`,
    `| Memory batch (N74) | ${a.memory.status}: ${a.memory.admitted} admitted, ${a.memory.rejected} quarantined of ${a.memory.total}; quarantine file ${a.memory.quarantineFile ?? 'none'} | ${b.memory.status}: ${b.memory.admitted} admitted, ${b.memory.rejected} quarantined of ${b.memory.total}; quarantine file ${b.memory.quarantineFile ?? 'none'} | |`, '',
    `Approved in (a) only: ${r.diffs.approvedOnlyA.length ? r.diffs.approvedOnlyA.join(', ') : 'none'}. Approved in (b) only: ${r.diffs.approvedOnlyB.length ? r.diffs.approvedOnlyB.join(', ') : 'none'}.`,
    `F-04 YES not approved in (b), and the stage that stopped each: ${ib.missedYesWhy.length ? ib.missedYesWhy.map(item => `${item.id} (${item.stage}${item.detail ? `: ${item.detail}` : ''})`).join('; ') : 'none'}. Non-YES approved in (b) (false accepts against F-04, with the M12 caveat above): ${ib.falseAccepts.length ? ib.falseAccepts.join(', ') : 'none'}.`, '');

  // ---- 9 vs R9 code
  if (r.r9Diff && r9) {
    push(`## 9. What changed since the Round 9 code, relation by relation (R9 code \`${R9_COMMIT}\` re-run)`, '', `R9 code: ${r9.review.approved} approved (${cell(r9.invariants.approvedTrue, r9.invariants.approved)} gold FKs, ${cell(r9.invariants.yesApproved, 25)} F-04 YES). (a): ${a.review.approved} approved (${cell(ia.approvedTrue, ia.approved)}, ${cell(ia.yesApproved, 25)} YES). (b): ${b.review.approved} approved (${cell(ib.approvedTrue, ib.approved)}, ${cell(ib.yesApproved, 25)} YES).`, '', '(a) runs at the shipped 3,000,000-token ceiling and its review is cut by the budget (section 6), so part of what (a) loses is the cut and not a rule; (b) is the Round 10 configuration without the cut.', '');
    for (const [name, diff] of [['(a)', r.r9Diff.a], ['(b)', r.r9Diff.b]] as const) {
      push(`Approved by the R9 code and not by ${name}: ${diff.approvedOnlyR9.length}. Approved by ${name} and not by the R9 code: ${diff.approvedOnlyA.length}.`, '');
      if (diff.approvedOnlyR9.length) push(`| Approved by the R9 code, not by ${name} | Gold FK | F-04 YES | What happens to it in ${name} |`, '|---|---|---|---|', ...diff.approvedOnlyR9.map(item => `| ${item.id} | ${item.gold ? 'yes' : 'no'} | ${item.yes ? 'yes' : 'no'} | ${item.fateInA} |`), '', `Fates by stage: ${fmtCounts(countStrings(diff.approvedOnlyR9.map(item => item.fateInA.split(':').slice(0, 2).join(':'))))}.`, '');
      if (diff.approvedOnlyA.length) push(`| Approved by ${name}, not by the R9 code | Gold FK | F-04 YES |`, '|---|---|---|', ...diff.approvedOnlyA.map(item => `| ${item.id} | ${item.gold ? 'yes' : 'no'} | ${item.yes ? 'yes' : 'no'} |`), '');
    }
  } else if (r.r9Code && 'unavailable' in r.r9Code) push('## 9. What changed since the Round 9 code', '', `NOT AVAILABLE: ${r.r9Code.unavailable}`, '');

  // ---- 10 health
  push('## 10. Health: degradations of the run', '', '| | (a) baseline | (b) Round 10 |', '|---|---|---|', `| Status | ${a.status} | ${b.status} |`,
    `| Degradations | ${a.degradations.join('<br>') || 'none'} | ${b.degradations.join('<br>') || 'none'} |`,
    `| Review health (E1-01) codes | ${a.review.healthCodes.join(', ') || 'none'} (calls ${a.review.healthCalls}, invalid ${a.review.invalidCalls}, truncated ${a.review.truncatedCalls}) | ${b.review.healthCodes.join(', ') || 'none'} (calls ${b.review.healthCalls}, invalid ${b.review.invalidCalls}, truncated ${b.review.truncatedCalls}) |`,
    `| Exploration read failures (N27, EXPLORATION_READ_FAILED) | ${a.degradations.some(d => /EXPLORATION_READ_FAILED/.test(d)) ? 'present' : 'none'} | ${b.degradations.some(d => /EXPLORATION_READ_FAILED/.test(d)) ? 'present' : 'none'} |`,
    `| Consistency (E2-03) | ${a.review.consistencyStatus} | ${b.review.consistencyStatus} |`,
    `| RANGE_BIASED flags (E2-06, needs F1x): all proposals / HIGH candidates flagged only for it / of those, gold FKs | ${a.rangeBias.flagged} / ${a.rangeBias.onlyReason} / ${a.rangeBias.onlyReasonGold} | ${b.rangeBias.flagged} / ${b.rangeBias.onlyReason} / ${b.rangeBias.onlyReasonGold} |`, '',
    'Expected on this harness and not findings: `CRITIC_DISABLED` (the harness runs with `critic: false`) and `BUDGET_EXHAUSTED_STEPS` (the scripted chooser spends the exploration steps). `MODEL_REVIEW_PARTIAL_BUDGET` is real: see section 6 and the open items. No `EXPLORATION_READ_FAILED` (N27) or `MEMORY_*` (N74) degradation appeared in either run.', '');

  // ---- 11 live M12
  if (r.m12) {
    const withF = r.m12.withF4, without = r.m12.withoutF4, cellRow = (row: M12Row) => `| ${row.id} | ${row.samplingSource ?? '-'} | ${row.sampleDistinct ?? '-'} | ${row.probedKeys ?? '-'} | ${row.distinctKeys ?? '-'} | ${row.fromBasis ?? '-'} | ${row.coverage ?? '-'} | ${row.approved ? '**approved**' : 'not approved'} | ${row.verdict ?? '-'} | ${row.whyNot ?? '-'} |`;
    push('## 11. Live M12: a degenerate discovery sample (20 rows, 1 key) widened by F4', '',
      `The fixture is reshaped like the live pass 1: ${r.m12.columns} source columns (${LIVE_DEGENERATE_COLUMNS.map(item => `${item.table}.${item.column}`).join(', ')}) sit in key order, so a 20-row discovery sample sees ONE distinct key where the table holds five. Run (b) is executed on it twice: with the engine as shipped (E3-07a widens a sample below \`minDistinctKeys\` with one F4 read per column), and with the F4 pool read refused by the client before the review starts (the sample stays degenerate; the contract probes keep their own reads).`, '',
      '| | F4 widening on | F4 refused |', '|---|---|---|', `| F4 pool reads that landed / refused | ${withF.f4PoolReads} / ${withF.f4Blocked} | ${without.f4PoolReads} / ${without.f4Blocked} |`, `| \`policy.f4Reads\` (pre-estimate) | ${withF.f4Reads ?? '-'} | ${without.f4Reads ?? '-'} |`, `| Probes whose sample was degenerate / widened to F4 keys | ${withF.degenerateProbes} / ${withF.widenedProbes} | ${without.degenerateProbes} / ${without.widenedProbes} |`,
      `| Source pool (queries, cached hits, failures) | ${JSON.stringify(withF.sourcePool)} | ${JSON.stringify(without.sourcePool)} |`, `| Approved contracts / decoy contracts / origin confusions | ${withF.approved} / ${withF.decoyContracts} / ${withF.confusions} | ${without.approved} / ${without.decoyContracts} / ${without.confusions} |`, `| Run status / budget SQL | ${withF.status} / ${withF.queries} | ${without.status} / ${without.queries} |`, '',
      '| M12 relation (F-04 deferred) | Sampling source | Distinct keys in the discovery sample | Keys the coverage probe sent | Distinct source keys in the review packet | Basis of that count | Coverage | Review | Verdict | Why not |', '|---|---|---|---|---|---|---|---|---|---|', ...withF.rows.map(cellRow), '', 'Same relations with the F4 pool read refused:', '', '| M12 relation | Sampling source | Distinct keys in the discovery sample | Keys the coverage probe sent | Distinct source keys in the review packet | Basis of that count | Coverage | Review | Verdict | Why not |', '|---|---|---|---|---|---|---|---|---|---|', ...without.rows.map(cellRow), '',
      withF.rows.every(row => (row.probedKeys ?? 0) >= 3) ? `Reading: F4 does what E3-07a says on the probe: the keys sent grow from ${without.rows.map(row => row.probedKeys ?? '-').join('/')} to ${withF.rows.map(row => row.probedKeys ?? '-').join('/')}. ${withF.rows.every(row => row.approved) ? `The review packet counts the F4 keys that were tested (basis ${[...new Set(withF.rows.map(row => row.fromBasis ?? '-'))].join(',')}), so all ${withF.rows.length} M12 relations reach a contract and the verdict ${[...new Set(withF.rows.map(row => row.verdict ?? '-'))].join(',')} (the stand-in review decides by names and evidence; a live judge may still defer). With the F4 read refused they stay at ${without.rows.map(row => row.distinctKeys ?? '-').join('/')} key(s) and the review defers them with INSUFFICIENT_DISTINCT_KEYS.` : withF.rows.some(row => /INSUFFICIENT_DISTINCT_KEYS/.test(row.whyNot ?? '')) ? 'But the review packet still counts the distinct source keys of the discovery sample (the column "Distinct source keys in the review packet"), so the review defers them with INSUFFICIENT_DISTINCT_KEYS. See the open item.' : `Not every M12 relation is approved, for a reason other than the key count: ${withF.rows.filter(row => !row.approved).map(row => `${row.id} (${row.whyNot})`).join('; ')}.`}` : 'F4 did not widen every M12 probe to at least 3 keys.', '');
  } else push('## 11. Live M12', '', 'Not run (`--no-m12`).', '');

  // ---- 12 resume
  if (r.resume) {
    const rs = r.resume;
    push('## 12. Resume (E1-03): kill the run after k post-COMA probes, resume it', '', `${rs.status}: ${rs.detail}.`, '');
    if (rs.status === 'RAN' && rs.full && rs.resumed) push(`Run (b) was started in a child process and killed once its post-COMA journal held at least ${rs.targetK} probes (the poll caught ${rs.journaledAtKill}; torn last line: ${rs.tornTail ? 'yes, dropped by the reader' : 'no'}). The same run id was then resumed against the same manifest and code (\`deps.resume\`), and compared with an uninterrupted run of the same configuration. Run folders live under the ignored \`.concordia/agent-runs\` and were removed afterwards.`, '',
      '| | Uninterrupted | Resumed |', '|---|---|---|', `| \`resume.resumedProbes\` (k) / \`newProbes\` / interruptions | n/a | **${rs.resumed.resume?.resumedProbes ?? '-'}** / ${rs.resumed.resume?.newProbes ?? '-'} / ${rs.resumed.resume?.interruptions ?? '-'} |`, `| Journaled probes at the kill | n/a | ${rs.journaledAtKill} (matches resumedProbes: ${rs.resumed.resume?.resumedProbes === rs.journaledAtKill ? 'yes' : 'NO'}) |`,
      `| SQL statements of the run (budget count) | ${rs.full.queries} | ${rs.resumed.queries} (**${rs.queriesSaved} fewer**) |`, `| Verdicts / approved contracts | ${rs.full.verdicts} / ${rs.full.approved} | ${rs.resumed.verdicts} / ${rs.resumed.approved} |`, `| Review tokens (STAND-IN; the review is not resumed, it runs again) | ${rs.full.reviewTokens} | ${rs.resumed.reviewTokens} |`, `| Run status | ${rs.full.status} | ${rs.resumed.status} (RESUMED_AFTER_INTERRUPTION degradation: ${rs.resumed.resume ? 'recorded' : 'absent'}) |`,
      `| **Identical verdicts** (relation, verdict and reason codes) | n/a | **${rs.identicalVerdicts ? `yes, ${rs.full.verdicts} of ${rs.full.verdicts}` : `NO: ${rs.verdictDiffs?.length} differ`}** |`, `| Same approved contracts | n/a | ${rs.sameApproved ? 'yes' : 'NO'} |`, '', ...(rs.verdictDiffs?.length ? ['Differences:', ...rs.verdictDiffs.map(item => `- ${item}`), ''] : []), 'Only post-COMA is resumed; the review and the contract probes run again on resume (their tokens are spent twice across an interruption).', '');
  } else push('## 12. Resume', '', 'Not run (`--no-resume`).', '');

  // ---- 13 ceiling
  const bShipped = b, bMax = r.cost.find(m => m.spec.name === 'B_ROUND10' && m.spec.tokenCeiling === 'MAX');
  push('## 13. The ceiling for (b): shipped 3,000,000 tokens and the 4,000,000 run ceiling', '', '| (b) at | Status | Review calls | Review tokens | SQL (budget) | Relations cut by budget | Health codes |', '|---|---|---|---|---|---|---|',
    `| 3,000,000 (shipped) | ${bShipped.status} | ${bShipped.review.calls} | ${bShipped.review.tokens} | ${bShipped.sql.budgetQueries} | ${bShipped.review.cutRelations} | ${bShipped.review.healthCodes.join(', ') || 'none'} |`,
    ...(bMax ? [`| 4,000,000 (run ceiling) | ${bMax.status} | ${bMax.review.calls} | ${bMax.review.tokens} | ${bMax.sql.budgetQueries} | ${bMax.review.cutRelations} | ${bMax.review.healthCodes.join(', ') || 'none'} |`] : []), '',
    bMax ? (bMax.review.healthCodes.includes('MODEL_REVIEW_PARTIAL_BUDGET')
      ? `At 4M the review is still cut (${bMax.review.cutRelations} relations). Extrapolated tokens for a COMPLETE review: about ${Math.round(bMax.review.tokens * bMax.review.reviewed / Math.max(1, bMax.review.reviewed - bMax.review.cutRelations))} (tokens used scaled by reviewed / fully reviewed relations; an estimate, not a measurement).`
      : `At 4M the review is COMPLETE using ${bMax.review.tokens} tokens (${(100 * bMax.review.tokens / RUN_BUDGET_CEILINGS.maxTokensPerRun).toFixed(0)}% of the ceiling); nothing more is needed for COMPLETE. At the shipped 3M it is ${bShipped.review.healthCodes.includes('MODEL_REVIEW_PARTIAL_BUDGET') ? 'cut' : 'also complete'} (${bShipped.review.tokens} tokens).`) : '', '');

  // ---- open items
  push('## 14. Open items (owner by file set; none fixed here)', '', ...(r.openItems.length ? r.openItems.flatMap(item => [`${item.id}. **${item.title}.** Owner: ${item.owner} (${item.files}). ${item.detail}`, '']) : ['None.', '']),
    '## 15. Limits of this run', '- SYNTHETIC fixture (24 tables, 5-6 rows): not the live TPCDS. Agreement with F-04 and the gold is on the fixture; the live numbers need the approved live run of phase F. Facts that depend on table size (a foreign key unique by chance, range prefixes) are measured on 5-6 rows.',
    '- Stand-in models: a pipeline measurement. A live model reviewer, its stability and its cost are measured separately and need approval. Token counts are the stand-in\'s estimate (chars/2), comparable between rows of this report only.',
    '- (a) is not the Round 9 code: three Round 10 pieces have no switch (profile cache, E2-02 orientation, E2-04 roles). The R9 row, when present, is the real Round 9 commit re-run in a temporary copy.',
    '- The tie table replays the vector over the groups the run produced (the engine applies it live in (b); the "live" rows count what it did). Profiles come from the scans the client saw, so the replay costs no SQL.',
    '- The cost of the tie-break block is the packet owner\'s choice; the row "b minus tie-break" bounds it from below.', '');

  // ---- 16 final validation on HEAD
  {
    const sh = r.shippedRun, sw = r.shippedSwitches, mf = r.m12, wf = mf?.withF4, wo = mf?.withoutF4;
    const yes = (value: boolean) => (value ? 'on' : '**OFF**');
    push(`## 16. Final validation on HEAD \`${r.code.head}\``, '',
      `The review is built by the product path (\`candidateReviewFor\` from the TPCDS manifest, offline stand-in) and the run declares no switch: the manifest is taken as shipped. Cascade, consistency, tie-break and the extended profile all come from \`universes/registry.json\`; nothing is injected by this harness. Runs (a) and (b) above declare their switches explicitly, on or off, so they no longer inherit them from the manifest.`, '',
      `1. **Shipped TPCDS manifest, the four switches:** consistency ${yes(sw.consistency)}, tieBreak ${yes(sw.tieBreak)}, fullEvidenceExtendedProfile ${yes(sw.extendedProfile)}, reviewCascade ${yes(sw.cascade)} (\`cli-run\` turns the cascade on from \`reviewCascade.enabled\`: ${r.cascadeWired ? 'wired' : '**NOT WIRED**'}).`);
    if (sh) {
      const iv = sh.invariants, pv2 = r.previous.numbers, ceiling = RUN_BUDGET_CEILINGS.maxTokensPerRun;
      push(`2. **Live M12, rerun with the key-basis fix:** ${wf && wo ? `the ${wf.rows.length} M12 relations, with F4 / without: keys the probe sent ${wf.rows.map(row => row.probedKeys ?? '-').join('/')} vs ${wo.rows.map(row => row.probedKeys ?? '-').join('/')}; distinct source keys in the review packet ${wf.rows.map(row => row.distinctKeys ?? '-').join('/')} vs ${wo.rows.map(row => row.distinctKeys ?? '-').join('/')}; basis ${[...new Set(wf.rows.map(row => row.fromBasis ?? '-'))].join(',')} vs ${[...new Set(wo.rows.map(row => row.fromBasis ?? '-'))].join(',')}; verdicts ${wf.rows.map(row => row.verdict ?? `deferred (${row.whyNot})`).join('; ')}. Approved contracts on the live-shaped fixture: ${wf.approved} with F4, ${wo.approved} without.` : 'not run'}`,
        `3. **(b) through the real path:** ${sh.status}; approved ${iv.approved}, of which ${iv.approvedTrue} true FKs (gold ${iv.goldEdges}); F-04 YES ${iv.yesApproved}/25, deferred not approved ${3 - iv.deferredApproved}/3, decoys without a contract ${3 - iv.decoyContracts}/3; MODEL_REVIEWED confused with HUMAN_REVIEWED **${iv.confusions}**; review tokens ${sh.review.tokens} (${(100 * sh.review.tokens / ceiling).toFixed(0)}% of the ${ceiling} ceiling, ${(100 * sh.review.tokens / 3_000_000).toFixed(0)}% of the shipped 3M), calls ${sh.review.calls}, ${sh.review.skippedByCascade} skipped by the cascade, health codes ${sh.review.healthCodes.join(',') || 'none'}; SQL ${sh.sql.budgetQueries} of 4,200; tie groups in the review ${sh.ties.review.groups}.`,
        `4. **Delta against \`${r.previous.confirmedAt ?? r.previous.source.commit}\`:** approved ${pv2.bApproved} -> ${iv.approved}, true FKs ${pv2.bApprovedTrue} -> ${iv.approvedTrue}, F-04 YES ${pv2.bYesApproved} -> ${iv.yesApproved}, review calls ${pv2.bReviewCalls} -> ${sh.review.calls}, tokens ${pv2.bReviewTokens} -> ${sh.review.tokens}, SQL ${pv2.bSql} -> ${sh.sql.budgetQueries}, status ${pv2.bStatus} -> ${sh.status}.`,
        `5. **Same as the explicitly declared (b)?** approved ${sh.approvedIds.length === b.approvedIds.length && sh.approvedIds.every(id => b.approvedIds.includes(id)) ? 'identical set' : '**DIFFERENT set**'}; tokens ${sh.review.tokens} vs ${b.review.tokens}; SQL ${sh.sql.budgetQueries} vs ${b.sql.budgetQueries}.`, '');
    } else push('2-5. The as-shipped run did not execute.', '');
  }

  // ---- appendix
  push('## Appendix A. Every tie group the review received in (b), with its reason', '', `${b.ties.review.groups} groups (siblings that share a source column, including candidates that did not reach HIGH coverage).`, '',
    '| Group (source column) | Siblings | Order (first = vector\'s pick) | Decisive | Decided by / deferral reason | Winner is gold |', '|---|---|---|---|---|---|',
    ...b.ties.review.rows.slice().sort((x, y) => x.group.join('|').localeCompare(y.group.join('|'), 'en')).map(item => { const first = item.ordered[0]!, src = first.split('__')[0]; return `| ${src} | ${item.group.length} | ${first.split('__')[1]} | ${item.decisive ? 'yes' : 'no'} | ${item.decisive ? item.decidedBy : item.notMeasured.length ? `NOT_MEASURED:${item.notMeasured.join('+')}` : 'TIED_ON_EVERY_STEP'} | ${item.decisive ? (goldHas(first) ? 'yes' : 'no') : '-'} |`; }), '');
  return lines.join('\n');
}

let goldCache: Set<string> | undefined;
const goldHas = (id: string) => (goldCache ??= new Set(loadTpcdsGold().edges.map(goldIdOf))).has(id);
const countStrings = (items: string[]) => countBy(items);
const countByStage = (rows: ReversedRow[]) => countBy(rows.map(row => row.stage));
function profileText(profile: unknown): string { const p = profile as any; return p && p.provenance === 'GLOBAL_WHOLE_TABLE' ? `${p.distinct} distinct of ${p.rows} rows${p.nulls ? `, ${p.nulls} null` : ''}${p.min !== undefined ? `, ${p.min}..${p.max}` : ''}` : 'not measured'; }

function costNotes(r: Integration): string[] {
  const find = (name: string, ceiling: 'SHIPPED' | 'MAX') => [r.primary.a, r.primary.b, ...r.cost].find(m => m.spec.name === name && m.spec.tokenCeiling === ceiling);
  const out: string[] = [], pct = (x: number, y: number) => x ? `${((1 - y / x) * 100).toFixed(0)}% fewer` : 'n/a';
  for (const ceiling of ['MAX', 'SHIPPED'] as const) {
    const label = ceiling === 'MAX' ? ' (4M, nothing cut: the clean comparison)' : ' (3M shipped, budget-bound: the baseline is cut, so the comparison mixes cost and coverage)';
    for (const [without, withIt, what] of [['A_BASELINE', 'A_CASCADE', 'cascade alone: a -> a + cascade'], ['B_NO_CASCADE', 'B_ROUND10', 'cascade with the vector: b minus cascade -> b']] as const) {
      const x = find(without, ceiling), y = find(withIt, ceiling);
      if (x && y) out.push(`- ${what}${label}: ${x.review.calls} -> ${y.review.calls} calls (${y.review.skippedByCascade} SKIPPED_BY_CASCADE), ${x.review.tokens} -> ${y.review.tokens} tokens (${pct(x.review.tokens, y.review.tokens)}), approved ${x.review.approved} -> ${y.review.approved}, relations cut by budget ${x.review.cutRelations} -> ${y.review.cutRelations}.`);
    }
  }
  const x = find('B_NO_TIEBREAK', 'MAX'), y = find('B_ROUND10', 'MAX');
  if (x && y) out.push(`- The tie-break block in the packet (4M, both with the cascade): b minus tie-break ${x.review.tokens} tokens -> b ${y.review.tokens} (${y.review.tokens >= x.review.tokens ? '+' : ''}${((y.review.tokens / x.review.tokens - 1) * 100).toFixed(0)}%), calls ${x.review.calls} -> ${y.review.calls}.`);
  return out;
}

export function defaultReportPath(date: string) { return path.join(DOCS_DIR, `RONDA10_INTEGRACION_OFFLINE_AB_${date.replace(/-/g, '')}.md`); }

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--child-run')) { const at = args.indexOf('--child-run'); await runConfig(specOf('B_ROUND10'), { runId: args[at + 1]!, bridge: args[at + 2] === 'standin' ? 'standin' : 'installed', persist: true }); return; }
  const result = await runIntegration({ bridge: args.includes('standin') ? 'standin' : 'installed', cost: !args.includes('--no-cost'), ceilings: !args.includes('--no-ceilings'), r9Code: !args.includes('--no-r9-code'), m12: !args.includes('--no-m12'), resume: args.includes('--no-resume') ? 0 : 300 });
  const markdown = renderReport(result);
  if (args.includes('--report')) {
    const next = args[args.indexOf('--report') + 1], file = next && !next.startsWith('--') ? path.resolve(next) : defaultReportPath(result.date);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, markdown); console.log(`ROUND10_INTEGRATION_REPORT ${file}`);
  }
  if (args.includes('--json')) console.log(JSON.stringify(result, (key, value) => key === 'edges' || key === 'fates' ? undefined : value, 2)); else console.log(markdown.split('\n').slice(0, 60).join('\n'));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
