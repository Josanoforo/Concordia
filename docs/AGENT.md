# Agent loop (enrolled universes)

`npm run agent -- --universe <id-or-alias> [--run-id agent-<id>-<unique>] [--no-model] [--no-coma] [--probe-model] [--offline] [--max-tokens <n>] [--memory]`

One path for every universe whose manifest declares `AGENT_EXPLORATION`:

1. **Discovery** of the configured, allowlisted tables (`discoverUniverse`).
2. **COMA** as a normal candidate provider over the configured relations (schema names and types only). Proposals outside the configured scope are retained as `NO VERIFICADO/UNKNOWN` and never evaluated.
3. **Bounded exploration**: the model (or `--no-model`: none) chooses *ids* from the universe's exploration catalog; the executor compiles fixed `SELECT ... WHERE key IN (observed values) LIMIT n` templates. The model never writes SQL.
4. **Budgeted probes**: configured relation probes run inside the remaining query budget (all affordable by default; a chooser can rank fixed `PROBE:<id>` options).
5. **Adversarial critic** over sustained relations.
6. **Decisions** come from the deterministic relation policy only.

Everything is read-only. Output: `.concordia/agent-runs/<runId>/engine-run.json` (+ `discovery.json`, `adaptive-read-*.json`, trace). `agent-u2` is the U2 company-brief product built on the same stages (see [AGENT_U2.md](AGENT_U2.md)).

## Options
- `--offline`: replays the universe's synthetic fixture (no model, no network, no credentials, no budget ledger). Results are labeled LOCAL + SYNTHETIC.
- `--max-tokens <n>`: token cap for this run (1000..200000). It is a guardrail, not a gate: each model call is estimated before it is made, and a call that would exceed the cap is not made (`TOKEN_BUDGET_WOULD_EXCEED` in the run). The cap and its source (flag or manifest) are recorded in the run budget. Recommended for live runs: 50000.
- `--memory`: opt-in run memory on Reconciler/H-MEM. Relations already sustained in earlier runs are reused (`REUSED`, versioned) instead of re-probed, and this run's claims are written with its run id. Reused relations can be revalidated by freshness as a budgeted action. A changed fingerprint degrades the reuse to a new probe.
- `--probe-model`: lets the model rank the probes (one generation each). Off by default.
- `npm run agent -- continue --universe <id> --run-id <run>`: the single compact retry of an exploration that stopped on an invalid model response or a failed model call. One generation, never automatic.
Every agent command prints its usage with `--help`, and the same usage appears under its errors.

## Reports and comparison
- `node scripts/run-tsx.mjs src/cli.ts agent-report --run-id <run>` writes `report.md` and `report.html` for a run: verdicts with a per-verdict "why" view (rule, strategy, evidence), probe selection, post-COMA coverage diagnostics, artifacts, per-stage metrics with denominators, efficiency (tokens per decision, caps, SQL per relation, receipts), and, when memory is on, claims, conflicts and the human review queue. Invalid model responses link to their line in `adaptive-decisions.jsonl`.
- `node scripts/run-tsx.mjs src/cli.ts agent-compare --run-a <run> --run-b <run>` writes a side-by-side comparison of two runs, with the same stage and efficiency metrics aligned.

## USL plan from the agent
`node scripts/run-tsx.mjs src/cli.ts agent-usl-plan --input <sealed .input.json> --name <n> --namespace <approved> --model <concordia_l4_..._vN>` retargets a sealed publication envelope to an approved namespace and writes the USL lifecycle plan. It is plan-only: only a `SOSTENIDA` and `CURRENT` decision is planned, no SQL runs and no grant is created. Applying a plan is a separate, human-authorized step.

## Declaring a universe
- Manifest (`universes/registry.json`): capability `AGENT_EXPLORATION` with bounds `maxQueriesPerRun`, `readLimit`, `maxTokensPerRun`, `maxSteps` (defaults 25 / 50 / 15000 / 3; the registry rejects values above the ceilings). The universe must also declare `DISCOVERY` and `BOUNDED_RELATION_PROBE`.
- Config (`universes/<id>.json`): `explorationCatalog` with `productLabel`, `plannerTask`, `safeOptionalColumns`, `observations` (value sets taken from observed rows) and `actions` (`KEYED_READ`, `COMPARE_KEYS` and `AGGREGATE_COUNT` templates: fixed, bounded, key columns only). The registry validates the catalog against the table allowlist and rejects sensitive columns.
- Worked non-U2 example: `universes/AGENT_fixture.json` (synthetic, exercised offline in `tests/agent-engine.test.ts`).

## Limits
The agent loop is read-only: no DDL, no gold, no push. `agent-usl-plan` only writes a plan. Join alternatives are compared by a generic bounded comparator (`compareDeclaredAlternatives`); U2 declares its five alternatives and its company brief is reproduced identically through it, and any universe that declares `joinAlternatives` gets the comparison in its run. Post-COMA coverage compares sampled values under the relation's declared normalization; it is a diagnostic and never changes a verdict. When evidence is incomplete, an `INDETERMINADA` verdict records why: the expected sample cap was reached, a read failed, or an endpoint is missing. The verdict itself does not change.

## Offline regression evaluation
`npm run eval-agent` runs the loop on every enrolled universe against a synthetic fixture in `eval/agent/<ALIAS>.json` (LOCAL + SYNTHETIC, no model, no network, no gold) and scores it with the shared L3-E protocol (`evaluateRelation`). It writes `out/agent-eval/report.json` with the exact denominators per universe and method (`allCases`, `consulted`, `evaluated`, `notConsulted`, `accepts`, `nonapprovable`, `positives`), the counts (correct and false accepts, abstentions, reviews, errors) and the registry enrollment (agent-capable, evaluated, not enrolled). Two methods share inputs and budget: `agent-loop` (with exploration) and `probes-only`; equal verdicts show that exploration never alters the deterministic decision. `tests/agent-eval.test.ts` pins the numbers. Synthetic metrics are regression signals, not product accuracy; a universe with no fixture is reported as `NO_OFFLINE_FIXTURE`.

## Historical routes (kept, not the product path)
`discover`, `probe`, `critic`, `eval`, `verdict`, `usl`, `demo` (per-stage commands, `--universe U1|U2|U3`), `discover-coma` (frozen E05D COMA run, exit 1 on PARTIAL by design), `agent-u2` (U2 company brief with continuation, enrichment and recovery) and `recover-u2-coma`. They remain supported for reproducing recorded evidence; new work should use `npm run agent`.

## Evidence status
- **SYNTHETIC / LOCAL:** the generic loop, the exploration catalog, the budget and the COMA provider are exercised offline by `tests/agent-engine.test.ts` and `tests/agent-eval.test.ts` on synthetic fixtures. These runs prove the mechanics, not product accuracy.
- **LIVE:** the earlier U2 company-brief runs (`agent-u2`) were executed against Zetaris and Nightshift with receipts. The U2 command now runs on the shared stages. The generic `npm run agent` command has two live runs. `agent-u1-live-01` (U1) completed with 25 SQL but exceeded its token cap (22,765 / 15,000), which led to the pre-call token estimate described under Options. `agent-u2-live-02` (U2) ran after that fix inside its cap (3,591 / 7,000 tokens, 10 SQL) and executed one of its two planned reads. All relation verdicts in both runs were `INDETERMINADA`. Sanitized copies of both runs are in `tests/fixtures/agent-runs/`. Memory (`--memory`) and run comparison have only been exercised offline.
- **Not claimed:** accuracy on real sources, table-wide coverage or key validity. U2 relations remain `INDETERMINADA` under the common policy unless an identifier space is declared.
