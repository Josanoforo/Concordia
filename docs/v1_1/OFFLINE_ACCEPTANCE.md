# Concordia v1.1 — Offline Acceptance Note

**Status:** `PARTIAL_OFFLINE` (2026-10-23). This records locally verifiable work only. It does not claim global v1.1 acceptance.

## Verified offline scope

- L1 registry and route integration: stable GTFS, Chinook, and Northwind snapshot IDs; legacy U1/U2/U3 aliases remain available. Registry validation is structural and offline. SVP1 evaluation and the existing U1/U2/U3 paths use the shared relation evaluator and typed probe/evidence path.
- Snapshot source package: 10 tables, 145 bounded rows, pinned source commits and file hashes in `data/snapshots/svp1-v1/provenance.json`. The package records no live binding. The candidate suite accounts for 17 candidates; unsupported unique-key checks remain unqueried and metadata controls are not scored as truth.
- L2-B memory scope, versioned conflict review, append-only corrections, freshness, and dependency invalidation are present in the product tree. L2-D publication planning remains non-executable and does not run DDL.
- L3 B-to-D integration: publication plans can consume a typed dependency graph. A changed evidence ref invalidates its dependent decision and publication output; the resulting plan is stale/blocked and retains a dependency fingerprint. The route is plan-only.
- L3-E evaluation uses `evaluateRelation`, keeps development separate from reserved holdout, reports task/universe/mode/origin buckets and exact denominators, and leaves unknown adjudications out of adjudicated-accept precision while reporting their count. The reserved holdout remains `NOT_READ`.

## Checks

- Isolated L1 integration set under `.concordia/l1-validation-97cc7f168c824787b207849687880ace`: 55 tests, 54 passed, 1 skipped because the OS denied junction creation (`EPERM`). No failures.
- Focused publication/invalidation tests: 24 passed; Reconciler tests: 9 passed; evaluation protocol tests: 6 passed.
- `npm run typecheck`: passed after the L3 integration change.
- `node scripts/run-tsx.mjs src/cli.ts universe validate`: `VALID`, nine manifests.
- `npm run check-secrets`: passed on the 168 committed files it scans. A separate pattern scan of changed source/config files found no matches.
- `git diff --check`: passed.

The isolated integration copy included node_modules and selected source/test/config inputs plus the authorized snapshot package; it excluded `.env`, repository evidence, release data, and the ledger. For the later read-only preflight only, `out/U1/discovery.json` was copied into that validation tree; no product output or evidence file was written. The run did not read gold or reserved holdout data. The junction test skip is an OS capability limitation, not a product pass.

## Pending external acceptance

The authorized read-only C3 preflight stopped before making a request because the isolated process environment did not provide `ZETARIS_REST_URL`. It made zero network calls. No `.env` file or credential value was read. The authenticated live C3 check therefore remains pending.

No live publication, DDL, activation, service change, generation, push, or release action was performed. Live C validation and any separately authorized backend publication checks are required before claiming global completion.

