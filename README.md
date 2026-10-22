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