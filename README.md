# Concordia

Concordia helps data teams discover candidate relationships across registered sources, check them with bounded queries, and record evidence-backed decisions with provenance. Deterministic checks decide whether a relationship is supported; language model output is auxiliary.

## Use: the agent loop

The product path is one command for enrolled universes that declare the `AGENT_EXPLORATION` capability:

    npm run agent -- --universe <id-or-alias>

The agent discovers the configured tables, proposes candidates (deterministic rules plus COMA schema matching), reads a few bounded rows through fixed query templates chosen by id, probes the configured relations inside a query budget, challenges sustained results with an adversarial critic, and records deterministic decisions with provenance in `.concordia/agent-runs/<runId>/engine-run.json`. It is read-only, never lets a model write SQL, and stops at the universe's budget (defaults: 25 SQL queries, 50 rows per read, about 15k model tokens, 3 exploration steps).

| Universe | Alias | Agent loop |
|---|---|---|
| NY taxi trips + zones | `U1` | enrolled |
| SEC companies + SIC reference | `U2` | enrolled (company brief: [docs/AGENT_U2.md](docs/AGENT_U2.md)) |
| MaDI company schemas | `U3` | enrolled |
| Synthetic orders fixture | `AGENTFX` | enrolled, runs fully offline in tests |
| Synthetic local-files orders | `AGENTLOCAL` | enrolled, runs over its own local rows, offline |
| GTFS trips + routes (synthetic subset, JSON2 binding) | `GTFSAGENT` | enrolled; live reads go through a binding guard |
| TPC-DS public schema (24 tables) | `TPCDS` | enrolled; model review (`MODEL_ADVERSARIAL`) on: [docs/TPCDS_FULL_RUN_R10.md](docs/TPCDS_FULL_RUN_R10.md) |
| Northwind + Chinook (6 tables) | `NWCH` | enrolled; blind check of the model review: [docs/NWCH_BLIND_CHECK.md](docs/NWCH_BLIND_CHECK.md) |
| Other fixtures | ... | not enrolled yet; use the historical commands below |

Useful options: `--offline` replays the universe's synthetic fixture (no model, no network), `--max-tokens <n>` caps the run's model tokens, and `--memory` reuses relations sustained in earlier runs. Every agent command prints its usage with `--help`.

Details, how to enroll a universe, and the offline regression evaluation (`npm run eval-agent`): [docs/AGENT.md](docs/AGENT.md).

## Three sample inputs and their outputs

Each input is a candidate relation over the public TPC-DS schema; each output is what the agent decided in the live full runs described in [docs/TPCDS_FULL_RUN_R10.md](docs/TPCDS_FULL_RUN_R10.md).

| Input: candidate relation | Output |
|---|---|
| `catalog_page.cp_end_date_sk → date_dim.d_date_sk` | **Approved** in the integrated run (R10b): the model review accepted it and it became a `MODEL_REVIEWED` contract. The earlier run (R10) had rejected it on sample evidence; the decision follows the evidence each run measures. |
| `inventory.inv_item_sk → item.i_item_sk` | **No contract.** Held back by the `RANGE_BIASED` guard after probing and never sent to review, in both runs. The project-owner had marked it YES; the agent still does not assert a relation its evidence does not support. |
| `store_returns.sr_store_sk → store.s_store_sk` | **Deferred** by the model review in R10b, so no contract (R10 had approved it). It is a true foreign key, so the deferral costs recall, not precision. |

Across the whole run: 92 approved contracts, all of them true foreign keys (92/92), recall 92/103, and 3/3 decoys left without a contract. Synthetic examples that run offline are in [input_examples/](input_examples/) and [output_examples/](output_examples/).

## Repository

- src/: application and command-line implementation
- tests/: automated tests
- config/, universes/, eval/: public defaults, universe contracts, and evaluation cases
- [input_examples/U3/](input_examples/U3/): synthetic schema and 30-row filestore example; no raw benchmark data or gold
- [output_examples/sample-fixture/U1.json](output_examples/sample-fixture/U1.json): synthetic schema graph used by offline SAMPLE and compiler coverage; other generated examples remain local
- [docs/AGENT.md](docs/AGENT.md): the agent loop, universe enrollment, budget and evaluation
- [docs/MODEL_REVIEW.md](docs/MODEL_REVIEW.md): the model review of candidate relations (`MODEL_ADVERSARIAL`), with its live results in [docs/NWCH_BLIND_CHECK.md](docs/NWCH_BLIND_CHECK.md) and [docs/TPCDS_FULL_RUN_R10.md](docs/TPCDS_FULL_RUN_R10.md)
- [docs/SPONSORS.md](docs/SPONSORS.md): integrations demonstrated (Zetaris, Meterless H-MEM Engine and Nightshift) with their limits
- [docs/PUBLIC_OVERVIEW.md](docs/PUBLIC_OVERVIEW.md): public project overview
- [data/README.md](data/README.md): notes about external data and licensing

Local run evidence and credentials are not part of the public repository. The application writes run artifacts under evidence/ and out/; Git ignores those files.

## Development

Requires Node.js and npm.

    npm ci
    npm run typecheck
    npm test

A live run also requires compatible Zetaris and Nightshift services. If .env does not already exist, copy .env.example to .env and fill in your local values. U2 registration also stays disabled until you replace the contact placeholder in config/onboarding.json and set registrationEnabled to true. Keep credentials local; never commit .env.

## H-MEM conformance

`src/hmem` vendors the Meterless H-MEM reference implementation (rev `1742dec`) with one added method; see [docs/PREEXISTING.md](docs/PREEXISTING.md). To run the upstream conformance suite against it:

    git clone https://github.com/Meterless/Meterless ../meterless-reference
    git -C ../meterless-reference checkout 1742dec56a66e58eef9dda2d2b865823758ca8cd
    npm run conformance

Expected: 13/13 PASS. To use a checkout elsewhere, set `HMEM_CONFORMANCE_RUNNER` to its `engines/hmem/conformance/runner.ts`.

## License

The code is licensed under Apache-2.0. Third-party datasets and benchmark materials retain their own terms and are not included here.
