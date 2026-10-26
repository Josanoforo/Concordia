import { SafeError } from '../runtime.ts';
import { MIN_TOKEN_CAP, RECOMMENDED_LIVE_TOKEN_CAP, RUN_BUDGET_CEILINGS } from './run-budget.ts';

/** Usage text for the agent-facing commands; `--help` prints it and errors point to it. */
const USAGE: Record<string, string> = {
  agent: `concordia agent --universe <id> [--run-id <agent-...>] [--no-model] [--no-coma] [--probe-model] [--offline] [--max-tokens <n>] [--probe-limit <n>] [--phase-budget] [--critic-assist] [--secondary-judge] [--review <file>] [--negative-control <file>] [--memory]
  Runs the generic exploration loop on a registered AGENT_EXPLORATION universe.
  --offline      replay the universe's synthetic fixture (no model, no network, no .env, no budget ledger)
  --memory       opt-in run memory (Reconciler/H-MEM): relations already sustained in earlier runs are reused instead of re-probed, and this run's claims are written with its run id
  --no-model     no adaptive reads; --no-coma skips the COMA phase; --probe-model lets the model rank probes (costs one generation each)
  --probe-limit  per-run override (integer 1..100) of the manifest's probeLimit; recorded in the run, never changes the policy; outside the range: PROBE_LIMIT_OUT_OF_RANGE
  --phase-budget reparte el techo de SQL y tokens por fase (discovery .4, exploración .2, sondas .3, crítica .1), corte limpio por fase; opt-in
  --critic-assist el modelo sugiere contrasondas del catálogo (1 llamada por lote); solo puede degradar, nunca elevar; requiere modelo
  --secondary-judge juez secundario a ciegas solo con ambigüedad real; nota no decisoria; OFF por defecto
  --review       human review overlay (an overlay file from the approved review folder): its approved contracts are applied to the universe for this run only, with the approval recorded; fail-closed (REVIEW_APPROVAL_MISSING, REVIEW_FILE_PATH_INVALID, REVIEW_UNIVERSE_MISMATCH ...). Without it a blind universe stays blind. A reviewed relation is a contract approved by a human, not something the agent discovered.
  --resume (E1-03) resumes an interrupted run after a power loss or crash: it needs --run-id of that run (AGENT_RESUME_REQUIRES_RUN_ID) and the same options as the original run; the engine refuses a mismatch through the journal header.
  --negative-control requires --review (NEGATIVE_CONTROL_REQUIRES_REVIEW); links an existing negative-control.json (act 3) into engine-run.reviewOverlay.negativeControl; the engine validates it, the CLI only passes the path
  --max-tokens   token cap for this run, ${MIN_TOKEN_CAP}..${RUN_BUDGET_CEILINGS.maxTokensPerRun} (guardrail, not a gate); recommended for live runs: ${RECOMMENDED_LIVE_TOKEN_CAP}. The cap and its source (flag|manifest) are recorded in the run budget.
  Model requested (default) but not used: exit 1 and WARNING: MODEL_DID_NOT_PARTICIPATE(<reason>) on stderr; --probe-model, --critic-assist or --secondary-judge without a model fail with the cause. --no-model is the only way to run without one.
  Status: core phases (discovery, post-COMA, candidate review, memory) decide it; auxiliary phases (exploration, critic) only add warnings. COMPLETED = nothing degraded; COMPLETED_WITH_WARNINGS = core complete, an auxiliary phase degraded (e.g. the exploration got an invalid reply); DEGRADED = a core phase degraded (COMA_FAILED, review FAILED/unhealthy, memory ERROR or quarantine); DEGRADED_NO_MODEL = the model did not take part in the review. engine-run.json carries phaseStatus (role core|auxiliary, state) and statusExplanation.
  Exit: 0 for COMPLETED and COMPLETED_WITH_WARNINGS (the latter prints NOTE: warnings(<phase>:<code>,...) on stderr); DEGRADED_NO_MODEL and DEGRADED exit 1, with WARNING: RUN_DEGRADED(<codes>) on stderr only for status DEGRADED (informational degradations of other statuses are a NOTE: degradations(<codes>) line). The summary reports a model-construction failure as chooserError and an exploration stop as explorationError.
  Output: one JSON line; the run is saved in .concordia/agent-runs/<run-id>/.`,
  'agent continue': `concordia agent continue --universe <id> --run-id <run> [--attempt <n>] [--max-tokens <n>]
  Accepts a run that ended COMPLETED, COMPLETED_WITH_WARNINGS or DEGRADED_NO_MODEL when its last model call was an invalid response or a transport failure.
  The single compact retry of an exploration that stopped on an invalid model response (one generation).`,
  'eval-agent': `concordia eval-agent
  Offline regression evaluation of the agent loop over the synthetic fixtures (scripted chooser, SCRIPTED_OFFLINE: no model; blind universes use the offline COMA stand-in); writes out/agent-eval/report.json. Exit 1 when any universe misses the PASS criteria (criteria.passed false).`,
  'agent-multi': `concordia agent-multi --cross <crossId> [--run-id <run>]
  Un run sobre dos universos con relaciones cruzadas declaradas en universes/cross/; cada lado con su cliente y presupuesto; sin SQL entre fuentes; sin modelo.
  --cross es obligatorio (AGENT_MULTI_CROSS_REQUIRED).`,
  'agent-compare': `concordia agent-compare --run-a <run> --run-b <run>
  Writes a side-by-side comparison of two existing agent runs.`,
  'memory-seal-legacy': `concordia memory-seal-legacy [--dry-run]
  Seals the agent memory scopes written before the origin seal: each one once, from its directory name (e.g. LIVE-PUBLIC), or quarantined as LEGACY_UNSCOPED (origin UNKNOWN, never reused).
  --dry-run lists every scope, the origin it would get and how many of its SOSTENIDA claims would be reusable (and why the others would not: NO_REVIEW_STATE, PLACEHOLDER_SOURCE_VERSION, SCOPE_ORIGIN_UNKNOWN ...). Writes nothing.
  Idempotent; it never rewrites a claim or the ledger. A claim without a review stamp becomes reusable after ONE strict re-probe that stamps it in place.`,
  'memory-resolve-stale': `concordia memory-resolve-stale --universe <U> --claim <id> --decision <keep|close> --reviewer <id> --reason <text> --execution-mode <m> --data-origin <o> [--dry-run]
  A named human closes a STALE claim of the agent memory: keep re-affirms it (observed now; it is believed and reusable again), close invalidates it (its own dependents then go STALE).
  --reviewer and --reason are mandatory (HUMAN_REVIEWER_REQUIRED, STALE_REASON_REQUIRED); the agent's own actor is refused. The reviewer is recorded in the claim, the ledger and the trace.
  --execution-mode and --data-origin pick the memory scope (no guessing). --dry-run shows what would change and writes nothing.`,
  'agent-compare-multi': `concordia agent-compare-multi --runs <run1,run2[,run3...]>
  Writes one comparison table of N (2 or more) existing agent runs (mode/origin, status, model participation, valid calls, tokens, queries, probes, claims, reuse, TPCDS gold score when the run is TPCDS), each number with its denominator. Output: one JSON line {runs, files}.
  --runs is required (AGENT_COMPARE_RUNS_REQUIRED); fewer than two runs is AGENT_COMPARE_NEEDS_TWO_RUNS; an unknown run is AGENT_REPORT_ENGINE_RUN_NOT_FOUND.`,
  'agent-usl-plan': `concordia agent-usl-plan --input <.concordia/publication-plans/X.input.json> --name <n> --namespace <approved> --model <concordia_l4_..._vN> [--snapshot-fingerprint <sha> --snapshot-observed-at <iso>] [--from-table --from-columns --to-table --to-columns]
  Plan-only: retargets a sealed publication envelope to an approved namespace and writes the USL lifecycle plan (default relation gtfs_trips.route_id -> gtfs_routes.route_id).
  Only a SOSTENIDA and CURRENT decision is planned; no SQL runs and no grant is created.`,
  'export-odcs': `concordia export-odcs --run-id <run> [--out <path>]
  Exports the relations of an existing agent run as an ODCS contract file (default <runDir>/contract.odcs.yaml). Output: one JSON line {path, relations, skipped}.
  --out is the contract FILE and must stay inside the repo (OUT_PATH_INVALID); a missing --run-id is AGENT_RUN_ID_REQUIRED, an unknown run is RUN_NOT_FOUND, a malformed id INVALID_RUN_ID, an unreadable universe config ODCS_UNIVERSE_CONFIG_UNREADABLE.`,
  'export-usl-odcs': `concordia export-usl-odcs --plan <plan.json> [--run <dir>] [--grant <file>] [--out <file>]
  Exporta un plan USL publicado y verificado como contrato ODCS 3.1.0 con su procedencia (fingerprint, sqlSha256, run verificado, autorización humana); sin grant coincidente o sin run verificado no exporta y dice por qué.
  Output: one JSON line {path, relations (0|1), skipped}. Without --out the file is written next to the plan; either way it must be inside the repo (OUT_PATH_INVALID). Missing plan: USL_PLAN_NOT_FOUND.`,
  'demo-tpcds': `concordia demo-tpcds
  Demo de un solo comando para el video: reproduce offline la secuencia descubrimiento ciego TPCDS, veredictos y reporte, el acto 3 de TPCDS (contrato semantico aprobado por el humano con su overlay de revision, SOSTENIDA, escritura sellada por origen, REUSED en la segunda pasada, control negativo y las 3 relaciones aplazadas) y exports (ODCS y dossier negativo), y escribe out/demo-tpcds/GUION_TOMAS.md (paso, comando, que mirar, evidencia, modo/origen) y summary.json.
  Solo fixtures sinteticas: sin red, sin .env, sin ledger; ninguna toma es LIVE. Output: one JSON line {script, summary, runs, facts}.`,
  'export-negative': `concordia export-negative --run-id <run> [--out <dir>]
  Exports the negative dossier (what the run ruled out) of an existing agent run. Output: one JSON line {path, entries, byKind}.
  --out is a DIRECTORY (default: the run directory): negative-dossier.json and negative-dossier.md are written inside it. It must stay inside the repo or the run directory (OUT_PATH_INVALID); a missing --run-id is AGENT_RUN_ID_REQUIRED, an unknown run is RUN_NOT_FOUND.`,
  'agent-report': `concordia agent-report --run-id <run>
  Writes the human report files for an existing agent run.`
};

/** Resolves the usage topic for argv ([node, cli, command, ...]); undefined when the command has none. */
export function usageFor(argv: readonly string[]): string | undefined {
  const command = argv[2];
  if (command === 'agent' && argv[3] === 'continue') return USAGE['agent continue'];
  return command ? USAGE[command] : undefined;
}

export function wantsHelp(argv: readonly string[]): boolean {
  return argv.slice(3).some(arg => arg === '--help' || arg === '-h');
}

/** Hint printed under a failure so the user knows which command line to fix. */
export function helpHint(argv: readonly string[]): string | undefined {
  const usage = usageFor(argv);
  return usage ? `USAGE\n${usage}` : undefined;
}

/** `--probe-limit` value: an integer 1..100, else PROBE_LIMIT_OUT_OF_RANGE (the CLI prints the usage under it). */
export function parseProbeLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1 || value > 100) throw new SafeError('PROBE_LIMIT_OUT_OF_RANGE');
  return value;
}

/** Per-run options of the agent command shared by the live and --offline routes; each key is present only when its flag was given. */
export function agentFlagOptions(argv: readonly string[], probeLimitRaw: string | undefined, reviewRaw?: string, negativeControlRaw?: string, runIdRaw?: string) {
  const resume = argv.includes('--resume');
  if (resume && !runIdRaw) throw new SafeError('AGENT_RESUME_REQUIRES_RUN_ID');
  const probeLimit = parseProbeLimit(probeLimitRaw);
  if (negativeControlRaw !== undefined && reviewRaw === undefined) throw new SafeError('NEGATIVE_CONTROL_REQUIRES_REVIEW');
  return { ...(resume ? { resume: true } : {}), ...(probeLimit === undefined ? {} : { probeLimit }), ...(reviewRaw === undefined ? {} : { review: reviewRaw }), ...(negativeControlRaw === undefined ? {} : { negativeControl: negativeControlRaw }), ...(argv.includes('--phase-budget') ? { phaseBudget: true } : {}),
    ...(argv.includes('--critic-assist') ? { criticAssist: true } : {}), ...(argv.includes('--secondary-judge') ? { secondaryJudge: true } : {}) };
}
