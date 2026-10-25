# Architecture

Concordia separates candidate discovery, evidence collection, decisions, and deployment:

1. **Describe sources.** Universe files define the source and target schemas and the permitted columns.
2. **Collect bounded evidence.** Discovery reads metadata; probes use explicit projections and limits. No unbounded source scan or remote join is inferred from a matching column name.
3. **Score and review relationships.** Deterministic checks combine overlap, type compatibility, labels, and bounded counterprobes. Ambiguous or contradictory evidence remains uncertain or is downgraded.
4. **Preserve decisions.** H-MEM-backed reconciliation stores claims, alternatives, corrections, provenance, and an append-only ledger.
5. **Compile the USL.** The compiler turns eligible relationships into a USL plan. Existing deployments are handled conservatively; a failed or ambiguous request is not treated as proof that a model is absent.
6. **Report limits.** HTML and JSON reports distinguish observed samples, cached results, synthetic fixtures, and global guarantees. A schema correspondence alone never becomes a foreign key.

The Zetaris client uses bounded SQL over its REST interface. Model-assisted text generation goes through the Meterless Nightshift runtime (required integration) and is isolated from deterministic decisions. Offline `SAMPLE_MODE` replays an explicitly synthetic fixture and performs no network or credential reads.