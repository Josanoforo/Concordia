# U1 — USL summary (redacted)

This public summary omits row values, request identifiers, source paths, and per-run traces. The complete original dossier is preserved outside the public repository.

The U1 model declares 12 candidate foreign keys across 9 tables. A later bounded adversarial review evaluated the 12 sustained relationships: 5 remained confirmed and 7 were downgraded after duplicate referenced keys appeared in returned samples. This is a statement about those bounded responses only. It is not a global uniqueness or referential-integrity result.

The existing deployment was retained; the review did not recompile or replace it. Some source reads are expensive; bounded probes do not estimate the cost of a full-table scan. New USL versions should include only relationships whose current evidence supports them, with unresolved and downgraded relationships kept visible for review.

See `evidence/d3-validation-redacted.json` for historical test and conformance counts. The public offline fixture is synthetic and does not reproduce the observed source run.