# Pre-existing components and sources

## H-MEM

The project includes the H-MEM reference implementation from `Meterless/Meterless`, revision `1742dec56a66e58eef9dda2d2b865823758ca8cd`, under its Apache-2.0 license. Concordia's adapter adds typed claims, conflict handling, review, and reinjection; those additions are project code, not upstream functionality. The ten files in `src/hmem` are vendored with one added method (`restoreAll` in `trustLedger.ts`, which restores an in-memory ledger snapshot and refuses to run on a file-backed ledger); all other files are identical to upstream revision `1742dec`. Provenance and the modification notice are in `src/hmem/NOTICE`.

To reproduce the conformance result, clone `Meterless/Meterless` at that revision next to this repository and run `npm run conformance` (see the README). Expected result: 13/13 PASS.

## Zetaris references

USL and SQL syntax were checked against the Zetaris getting-started materials at revision `841344cc704986dadf961854eecf2dd1f4098c0a`. The application communicates through its own REST client; the reference checkout and runtime binaries are not included here.

## Evaluation data

The MaDI benchmark and its gold data are not redistributed. Source datasets have separate licensing terms, and the benchmark paper's license does not grant rights to those datasets or gold files. Public example rows are explicitly synthetic and are not MaDI records. Dataset licensing must be checked independently before any local evaluation or redistribution.

The project code is licensed under Apache-2.0. That license does not extend to third-party data or trademarks.