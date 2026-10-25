# U2 company brief agent

U2 is one enrolled case of the generic agent loop ([AGENT.md](AGENT.md)): it uses the same stages, catalog (`explorationCatalog` in `universes/U2_companies.json`) and budget, and adds the U2-specific join comparison and company-brief report below.

The normal U2 run builds a sourced, bounded company brief from the configured `SEC_DATA` and `COMPANY_DNS` tables. Give every new run an explicit unique ID:

```powershell
npm run agent-u2 -- --run-id agent-u2-<unique-id> --task "Prepare a sourced company brief from SEC_DATA and COMPANY_DNS"
```

The application loads `.env` internally. It performs configured schema discovery and relation probes, then runs schema-only proposals through the installed Valentine COMA bridge. The adaptive planner receives observed U2 metadata and bounded read results through the configured Nightshift route. It can select `READ_SEC_PROFILE`, `READ_DNS_REFERENCE`, or `STOP_EXPLORATION`; the executor builds the bounded `SELECT` statements from observed keys and configured, described columns. The model does not submit SQL or choose arbitrary fields.

The planner compares a deliberately limited family of joins: CIK text or normalized CIK for company identity, and SIC code, SIC description, SIC code plus description, or no DNS join. It records matches, unmatched rows, nulls, duplicate target values, and ambiguous source rows from the available samples, with query and request provenance. It may choose an operational join for the current brief from those observations. These counts describe the bounded samples only; they do not prove global uniqueness, coverage, or key validity. A description condition can be useful in a bounded task without being a globally unique key.

An operational choice is recorded as provisional with `UNKNOWN/PENDING` semantic status. It does not approve a relationship, change the allowlist or scope, become a global foreign key, or imply human review was completed. COMA scores remain diagnostics; out-of-scope proposals are preserved separately and do not trigger SQL or probes. Reports preserve the selected and unselected alternatives, model response, receipts, token use, and query evidence. U2's action and join families are intentionally bounded to this configured task; this is not universal autonomous database access.

## Failed adaptive decision continuation

If the final DNS-join model response is invalid JSON due to truncation, the run stores the failure and keeps the prior successful reads and decisions. Retry only that failed choice against the persisted alternatives, without discovery, SQL, COMA, or other model stages:

```powershell
npm run agent-u2 -- continue --run-id agent-u2-<existing-id> --resume-adaptive
```

This continuation requires the explicit run ID and an eligible saved U2 LIVE run whose DNS choice failed with `U2_ADAPTIVE_RESPONSE_NOT_JSON`. It asks Nightshift once for a compact choice among the already measured alternatives, records the response and receipt, and reports `freshReads: 0`. A failed retry remains a recorded failure; no choice is inferred or assigned automatically.

## Human review continuation

The ordinary `continue` command reuses memory and records the pending human review state without new source reads or adaptive model calls:

```powershell
npm run agent-u2 -- continue --run-id agent-u2-<existing-id>
```

The run may separately ask whether to keep the configured one-company scope or request a later multi-company scope. Only a person may record that choice, with their actor name:

```powershell
npm run agent-u2 -- continue --run-id agent-u2-<existing-id> --decide keep_company_scope --actor <human-name>
```

Allowed review decisions are `keep_company_scope` and `request_multi_company`. This review concerns scope; it is distinct from a bounded operational join choice. Continuation never implies approval, and a multi-company request does not expand the existing U2 run.

## Optional saved-run operations

To enrich a saved run from already discovered fields and persist values with query provenance:

```powershell
npm run agent-u2 -- --enrich --run-id agent-u2-<existing-id>
```

To replay COMA over a saved U2 discovery snapshot when historical raw matcher output was not retained:

```powershell
npm run recover-u2-coma -- --run-id agent-u2-<existing-id>
```

This offline replay requires an explicit U2 run ID and verifies the reconstructed COMA input hash against that run's report. It does not load `.env`, connect to Zetaris, or overwrite the original report, discovery, trace, memory, or budget. Its new sidecar labels the input `REPLAY`, matcher `LOCAL`, and source data `PUBLIC`; the replay is new evidence over the saved snapshot, not the missing historical raw output or a LIVE verification.

Normal-run integrity capture hashes the nine stable U1/U2/U3 memory files and `evidence/trace.jsonl` when present. It is independent of assessments and prior run directories; missing protected files are recorded as absent rather than preventing a new U2 run.
