# USL reflection

A USL turns repeated join assumptions into an inspectable contract. In Concordia, a declared relationship carries its source, target, normalization rule, evidence status, and review history. That makes the result easier to discuss and revise than a collection of implicit joins.

The observed work also shows where a USL can mislead. Matching identifiers can be duplicated in a bounded sample; similar names do not prove entity identity; and textual identifiers may need a documented, lossless normalization. A relationship that passes a sample check is not proof of uniqueness or integrity across the full source.

The compiler must preserve deployment state carefully. Replacing a model definition can clear table activation, and an ambiguous load failure must not authorize a new deployment. Cost matters too: even a small result limit may follow an expensive source scan. The product therefore records limits, avoids unbounded queries, and keeps uncertain relationships out of new models.

Useful next improvements are preflight cost estimates, clearer warnings for casts and nullability, and measured refresh behavior when source versions change. Those should remain separate from the evidence that justified the current model.