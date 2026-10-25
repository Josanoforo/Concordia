# Agent loop (enrolled universes)

`npm run agent -- --universe <id-or-alias> [--run-id agent-<id>-<unique>] [--no-model] [--no-coma]`

One path for every universe whose manifest declares `AGENT_EXPLORATION`:

1. **Discovery** of the configured, allowlisted tables (`discoverUniverse`).
2. **COMA** as a normal candidate provider over the configured relations (schema names and types only). Proposals outside the configured scope are retained as `NO VERIFICADO/UNKNOWN` and never evaluated.
3. **Bounded exploration**: the model (or `--no-model`: none) chooses *ids* from the universe's exploration catalog; the executor compiles fixed `SELECT ... WHERE key IN (observed values) LIMIT n` templates. The model never writes SQL.
4. **Budgeted probes**: configured relation probes run inside the remaining query budget (all affordable by default; a chooser can rank fixed `PROBE:<id>` options).
5. **Adversarial critic** over sustained relations.
6. **Decisions** come from the deterministic relation policy only.

Everything is read-only. Output: `.concordia/agent-runs/<runId>/engine-run.json` (+ `discovery.json`, `adaptive-read-*.json`, trace). `agent-u2` is the U2 company-brief product built on the same stages (see [AGENT_U2.md](AGENT_U2.md)).

## Declaring a universe
- Manifest (`universes/registry.json`): capability `AGENT_EXPLORATION` with bounds `maxQueriesPerRun`, `readLimit`, `maxTokensPerRun`, `maxSteps` (defaults 25 / 50 / 15000 / 3; the registry rejects values above the ceilings). The universe must also declare `DISCOVERY` and `BOUNDED_RELATION_PROBE`.
- Config (`universes/<id>.json`): `explorationCatalog` with `productLabel`, `plannerTask`, `safeOptionalColumns`, `observations` (value sets taken from observed rows) and `actions` (`KEYED_READ` templates). The registry validates the catalog against the table allowlist and rejects sensitive columns.
- Worked non-U2 example: `universes/AGENT_fixture.json` (synthetic, exercised offline in `tests/agent-engine.test.ts`).

## Limits
Read-only; no DDL; no gold; no push. U2's join-alternative comparison (`compareU2Alternatives`) is still a U2-specific comparator that runs after the generic exploration stage.

## Offline regression evaluation
`npm run eval-agent` runs the loop on every enrolled universe against a synthetic fixture in `eval/agent/<ALIAS>.json` (LOCAL + SYNTHETIC, no model, no network, no gold) and scores it with the shared L3-E protocol (`evaluateRelation`). It writes `out/agent-eval/report.json` with the exact denominators per universe and method (`allCases`, `consulted`, `evaluated`, `notConsulted`, `accepts`, `nonapprovable`, `positives`), the counts (correct and false accepts, abstentions, reviews, errors) and the registry enrollment (agent-capable, evaluated, not enrolled). Two methods share inputs and budget: `agent-loop` (with exploration) and `probes-only`; equal verdicts show that exploration never alters the deterministic decision. `tests/agent-eval.test.ts` pins the numbers. Synthetic metrics are regression signals, not product accuracy; a universe with no fixture is reported as `NO_OFFLINE_FIXTURE`.

## Historical routes (kept, not the product path)
`discover`, `probe`, `critic`, `eval`, `verdict`, `usl`, `demo` (per-stage commands, `--universe U1|U2|U3`), `discover-coma` (frozen E05D COMA run, exit 1 on PARTIAL by design), `agent-u2` (U2 company brief with continuation, enrichment and recovery) and `recover-u2-coma`. They remain supported for reproducing recorded evidence; new work should use `npm run agent`.

## Evidence status
- **SYNTHETIC / LOCAL:** the generic loop, the exploration catalog, the budget and the COMA provider are exercised offline by `tests/agent-engine.test.ts` and `tests/agent-eval.test.ts` on synthetic fixtures. These runs prove the mechanics, not product accuracy.
- **LIVE:** the earlier U2 company-brief runs (`agent-u2`) were executed against Zetaris and Nightshift with receipts. The U2 command now runs on the shared stages. The generic `npm run agent` command has since been run live on U1 and U2; all relation verdicts in those runs were `INDETERMINADA`. Their run artifacts are not published.
- **Not claimed:** accuracy on real sources, table-wide coverage or key validity. U2 relations remain `INDETERMINADA` under the common policy unless an identifier space is declared.
