/** Usage text for the agent-facing commands; `--help` prints it and errors point to it. */
const USAGE: Record<string, string> = {
  agent: `concordia agent --universe <id> [--run-id <agent-...>] [--no-model] [--no-coma] [--probe-model] [--offline] [--max-tokens <n>] [--memory]
  Runs the generic exploration loop on a registered AGENT_EXPLORATION universe.
  --offline      replay the universe's synthetic fixture (no model, no network, no .env, no budget ledger)
  --memory       opt-in run memory (Reconciler/H-MEM): relations already sustained in earlier runs are reused instead of re-probed, and this run's claims are written with its run id
  --no-model     no adaptive reads; --no-coma skips the COMA phase; --probe-model lets the model rank probes (costs one generation each)
  --max-tokens   token cap for this run, 1000..200000 (guardrail, not a gate); recommended for live runs: 50000. The cap and its source (flag|manifest) are recorded in the run budget.
  Output: one JSON line; the run is saved in .concordia/agent-runs/<run-id>/.`,
  'agent continue': `concordia agent continue --universe <id> --run-id <run> [--attempt <n>] [--max-tokens <n>]
  The single compact retry of an exploration that stopped on an invalid model response (one generation).`,
  'eval-agent': `concordia eval-agent
  Offline regression evaluation of the agent loop over the synthetic fixtures; writes out/agent-eval/report.json.`,
  'agent-compare': `concordia agent-compare --run-a <run> --run-b <run>
  Writes a side-by-side comparison of two existing agent runs.`,
  'agent-usl-plan': `concordia agent-usl-plan --input <.concordia/publication-plans/X.input.json> --name <n> --namespace <approved> --model <concordia_l4_..._vN> [--snapshot-fingerprint <sha> --snapshot-observed-at <iso>] [--from-table --from-columns --to-table --to-columns]
  Plan-only: retargets a sealed publication envelope to an approved namespace and writes the USL lifecycle plan (default relation gtfs_trips.route_id -> gtfs_routes.route_id).
  Only a SOSTENIDA and CURRENT decision is planned; no SQL runs and no grant is created.`,
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
