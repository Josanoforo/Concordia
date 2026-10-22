# Redacted evidence extracts

These files are redacted derivatives of historical artifacts. Their original sources remain in private storage. They are not new runs and do not replace the source evidence.

- `d3-validation-redacted.json` retains only the historical typecheck, test, and H-MEM conformance totals from `d3-checks.json`. It omits timestamps and transcript paths.
- `madi-license-review-redacted.json` retains license and source-provenance findings from `madi-license.json`; it contains no benchmark data or gold values.
- `receipt-shape-redacted.json` extracts the observed receipt field shape from `receipt-schema.json` and removes receipt metadata, request IDs, signatures, tokens, and response values.

No raw rows, SQL traces, request IDs, credentials, source samples, or benchmark gold are published. Synthetic fixtures are identified separately under `input_examples/` and `output_examples/`.