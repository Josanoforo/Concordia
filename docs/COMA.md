# COMA schema discovery

**Status: COMA integrated and ready for the next normal product run. Functional validation is pending that run.**

`discover-coma` runs the installed Valentine 1.1.0 `Coma` matcher against the frozen E05D U1 schema. It reads only the fixed, project-local `input.json`, `case-universe.json`, `input-freeze.json`, and `code-policy-freeze.json` files and verifies the frozen input hashes before matching. It does not load `.env` or access a database.

COMA receives allowlisted table and column names and declared types as empty pandas DataFrames. Sample rows, values, labels, embeddings, and other data do not enter the matcher. Effective schema-only settings are `max_n=0`, `use_instances=false`, `use_schema=true`, `delta=0.15`, `threshold=0.0`, and `instance_weight=1.0`. The frozen source remains `REPLAY` with origin `UNKNOWN`; matcher execution is separately recorded as `LOCAL`. Raw numeric scores and provider/version/config/input provenance are retained under contribution diagnostics. The report includes the complete candidate production envelope, including provider states, errors and abstentions, plus SHA-256 values for the bridge, provider adapter and runner. A COMA result is only a candidate: the relation kind remains `UNKNOWN`, review remains unresolved, and the common `evaluateRelation` engine receives no semantic evidence, so a match does not become an accepted or rejected relation.

## Local install

Python 3.12 and Valentine 1.1.0 are isolated under `.concordia/python/coma-valentine-1.1.0`. Exact dependency pins are in `scripts/coma/requirements.lock.txt`; Valentine 1.1.0 declares Apache-2.0 in the installed metadata. The recorded wheel SHA-256 is `4c60549517c57b3d3deb669981e8c16a0b5e8509c40ce8aec7d7b01323ee2806`. To reproduce the local setup from the repository root on Windows, run:

```powershell
./scripts/coma/install.ps1
```

The installer keeps pip cache and temporary files under `.concordia/`. The current local environment record is in `.concordia/coma-install/install-report.json`, `requirements.freeze.txt`, and `valentine-LICENSE.txt`.

## Next normal product run

The normal product command is prepared below. Use a fresh run ID; each run gets a new directory under `.concordia/coma-runs/<runId>`, and existing run IDs are rejected. The integration has not yet had a functional runtime validation.

```powershell
npm run discover-coma -- --run-id coma-e05d-20261023-01
```

The JSON report and its cases are written to `.concordia/coma-runs/<runId>/report.json`. `supported` and `misleading` remain zero for this input because COMA scores are diagnostic only and the report evaluates proposals with the shared frozen policy but without semantic evidence. Errors or empty matches are reported as failures or abstentions, never as contradictions. The CLI exits with code 1 for `ERROR` or `PARTIAL`, and 0 for completed `COMPLETE` or `ABSTAINED` runs.

The bridge is local at `scripts/coma/bridge.py`, uses the Valentine API `valentine.valentine_match` with `valentine.algorithms.Coma`, disables shell invocation, bounds input/output and execution time, and does not accept user-selected file paths.
