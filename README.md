# Concordia

Concordia helps data teams discover candidate relationships across registered sources, check them with bounded queries, and record evidence-backed decisions with provenance. Deterministic checks decide whether a relationship is supported; language model output is auxiliary.

## Use: the agent loop

The product path is one command for any registered universe that declares the `AGENT_EXPLORATION` capability:

    npm run agent -- --universe <id-or-alias>

The agent discovers the configured tables, proposes candidates (deterministic rules plus COMA schema matching), reads a few bounded rows through fixed query templates chosen by id, probes the configured relations inside a query budget, challenges sustained results with an adversarial critic, and records deterministic decisions with provenance in `.concordia/agent-runs/<runId>/engine-run.json`. It is read-only, never lets a model write SQL, and stops at the universe's budget (defaults: 25 SQL queries, 50 rows per read, about 15k model tokens, 3 exploration steps).

| Universe | Alias | Agent loop |
|---|---|---|
| SEC companies + SIC reference | `U2` | enrolled (company brief: [docs/AGENT_U2.md](docs/AGENT_U2.md)) |
| Synthetic orders fixture | `AGENTFX` | enrolled, runs fully offline in tests |
| NY taxi, MaDI, GTFS, Chinook and other fixtures | `U1`, `U3`, ... | not enrolled yet; use the historical commands below |

Details, how to enroll a universe, and the offline regression evaluation (`npm run eval-agent`): [docs/AGENT.md](docs/AGENT.md).

## Repository

- src/: application and command-line implementation
- tests/: automated tests
- config/, universes/, eval/: public defaults, universe contracts, and evaluation cases
- [input_examples/U3/](input_examples/U3/): synthetic schema and 30-row filestore example; no raw benchmark data or gold
- [output_examples/sample-fixture/U1.json](output_examples/sample-fixture/U1.json): synthetic schema graph used by offline SAMPLE and compiler coverage; other generated examples remain local
- [docs/AGENT.md](docs/AGENT.md): the agent loop, universe enrollment, budget and evaluation
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

The code is licensed under Apache-2.0. Third-party datasets and benchmark materials retain their own terms and are not included here.
