# Concordia

Concordia turns source metadata and bounded observations into reviewable schema relationships and a Universal Schema Language (USL). It preserves evidence, exposes uncertainty, and keeps sample-based findings distinct from guarantees about an entire dataset.

## Quick start

Requires Node.js 20.12 or newer.

```sh
npm ci
npm run typecheck
npm test
SAMPLE_MODE=true npm run demo -- --universe=U1
```

The sample demo uses a clearly labelled synthetic fixture. It runs offline without credentials, SQL queries, or model generations. On PowerShell, set the mode with `$env:SAMPLE_MODE = 'true'` before running the demo.

## Live U1 technical walkthrough

This walkthrough uses an already-authorized, running Zetaris service, the existing U1 sources and deployed USL, and the local Nightshift runtime. It does not register databases, create a Zetaris platform, recompile or activate a USL, or touch Docker. Keep credentials in the existing private env file; point the loader at it instead of copying it into this checkout. If you already have a Nightshift budget ledger, point the client at that file so dispatch history stays append-only.

PowerShell from the repository root:

```powershell
$env:CONCORDIA_LOCAL_ENV_FILE = 'C:\path\to\private\.env'
# Optional: keep appending to an existing ledger. Omit for a new local ledger.
$env:CONCORDIA_BUDGET_FILE = 'C:\path\to\private\budget.json'

# First run: live Zetaris discovery and bounded probes, deterministic verdicts,
# adversarial counterprobes, reconciliation, existing-USL readback, and report.
npm run demo -- --universe=U1

# Optional model assistance for the saved live evidence: at most one proposal
# request and one explanation request, both through meterless/cheap.
npm run complete-llm

npm run reconcile -- --universe=U1
npm run usl-dossier -- --universe=U1
npm run review -- --universe=U1 --list

Remove-Item Env:\CONCORDIA_LOCAL_ENV_FILE -ErrorAction SilentlyContinue
Remove-Item Env:\CONCORDIA_BUDGET_FILE -ErrorAction SilentlyContinue
```

`demo` prints whether its data are `LIVE` or `CACHED`; its 24-hour warm path reuses saved evidence and skips new source probes. `complete-llm` uses saved discovery and probe evidence, records each dispatch before sending it, requires a receipt, and does not automatically retry a failed request. The model may propose candidates and explain fixed verdicts; it cannot change verdicts or SQL. Review output can contain source claims, so keep it local. To check connectivity separately, `npm run test-connection` reads Zetaris databases and the Nightshift catalog, then sends one useful cheap-route generation; it is not the full U1 workflow. Every live flow is distinct from the synthetic offline sample above.

## Repository map

| Path | Purpose |
|---|---|
| `src/` | CLI, discovery, bounded probes, verdicts, reconciliation, USL generation, and reports |
| `tests/` | Unit and contract coverage, including offline and failure-path behavior |
| `eval/` | Evaluation cases and edge-case contracts |
| `universes/` | Source and target schema descriptions |
| `config/` | Runtime, evaluation, and model policies with placeholder-safe defaults |
| `scripts/` | Checks and reproducible developer utilities |
| `.github/` | Continuous integration workflow and pinned action metadata |
| `input_examples/`, `output_examples/` | Explicitly synthetic examples; they are not live-run evidence |
| `evidence/` | A small set of redacted historical validation extracts and schema-only evidence |
| `docs/` | Public attribution, USL summaries, reflection, and architecture |
| `PUBLIC_MANIFEST.md` | Positive allowlist for the published source tree |

No source rows, raw benchmark datasets, gold files, API credentials, or live request identifiers are included. See [the public manifest](PUBLIC_MANIFEST.md) and [the evidence notes](evidence/README.md) for scope and redaction details.

## MaDI schema-matching evaluation

The five MaDI schema-matching domains were evaluated against the pinned [`MaDI-Bench` revision](https://github.com/wbsg-uni-mannheim/MaDI-Bench/tree/062058d09c8abd97026e6d4e9908b433753f58d3) gold files. The heuristic uses source metadata and target-schema descriptions only. The author baseline uses the benchmark's published LLM-pipeline mapping files. Target dataset labels were normalized to the common benchmark target `target_schema` before scoring. These are column-correspondence P/R metrics; they do not measure entity matching or fusion. Raw data, gold, author mappings, and per-field predictions remain local under ignored paths. Regenerate the private aggregate and domain reports with `node scripts/evaluate-madi-domains.mjs`.

| MaDI domain | Sources | Metadata heuristic P/R | Author LLM baseline P/R |
|---|---:|---:|---:|
| Games | 3 | 0.833 / 0.769 | 0.885 / 0.885 |
| Companies | 3 | 1.000 / 0.095 | 0.800 / 0.762 |
| Music | 3 | 0.842 / 0.762 | 0.857 / 0.857 |
| Products | 4 | 0.887 / 0.550 | 1.000 / 1.000 |
| Papers | 3 | 0.857 / 0.706 | 1.000 / 1.000 |

The per-domain static reports are generated under ignored `out/madi/<domain>/report.html`. Attribution and license review remain in `evidence/madi-license-review-redacted.json`; the article license does not establish a license for the MaDI datasets or gold.
