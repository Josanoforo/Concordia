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
