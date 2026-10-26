# Model review (`MODEL_ADVERSARIAL`)

Concordia can review candidate relations with a model instead of waiting for a human contract. The mode is declared per universe in the manifest (`reviewMode`):

| `reviewMode` | Effect |
|---|---|
| `HUMAN` | The model review does not apply; a relation needs a human-approved contract. |
| `MODEL_ADVERSARIAL` | Two judges plus an adversarial pass review each eligible candidate; an approval becomes a contract sealed `MODEL_REVIEWED`. |
| `BOTH` | The model review runs and is recorded, but SOSTENIDA still requires the human contract. |

A model approval is never presented as a human one: the record carries `origin: MODEL_REVIEWED`, `humanReviewed: false` and `boundedSampleOnly: true`.

## How a candidate is reviewed

1. **Eligibility.** Only post-COMA candidates that were probed, reached HIGH coverage and carry no suspicion flag (`TARGET_NOT_UNIQUE`, `RANGE_BIASED`, …) are sent to review. The others are recorded with the reason they were held back.
2. **Evidence packet.** Names, orientation, coverage counts, key multiplicity, siblings that share an endpoint, alternative endpoints probed for the same column, and, for sibling ties, global target-uniqueness evidence. The packet carries counts and names only: no sampled key values and no SQL.
3. **Evidence floor.** A deterministic ceiling computed from the packet (missing keys → reject; too few distinct keys, non-unique target, no measurement → defer). Models can only lower it. A relation the evidence already rejects costs zero generations.
4. **Judges.** Independent judges with different lenses answer through a forced tool call with a closed reason-code vocabulary. An accept needs unanimity.
5. **Adversarial pass.** The adversary argues `HOMONYM` and `SIBLING`; `INSUFFICIENT_KEYS` and `INVERTED_ORIENTATION` are computed deterministically from the packet. A blocking attack lowers the decision only if every evidence reference resolves to a path in the packet; otherwise it is discarded as `UNGROUNDED`. The pass can never raise a decision, and an accept without a completed pass is deferred.
6. **Contract probes.** An approved candidate becomes a `MODEL_REVIEWED` contract and goes through the contract probes before it can be SOSTENIDA.
7. **Labels.** "revisado por modelo con pase adversarial" appears only where the adversarial pass completed; otherwise the label says it did not.

Every generation is checked against the run budget before it is made and charged from its receipt afterwards. Each call leaves a trace event with the prompt hash, the requested model, the bounded response, the receipt and the tokens; the overlay has one row per role with the models actually used, as reported by the receipts.

**Transport per role.** The model review uses, for each role, the transport proven live. The two judges answer through a forced tool call with a strict schema: 0 invalid responses in 785 live calls. The adversary answers in text with JSON formatting (`response_format`): 0 invalid responses in 185 live calls. Over the tool call, the adversary's nested schema produced badly encoded responses (25 of 182). As an extra defence, parsing normalizes the three encodings observed, with a test over the 25 real responses. The prompt version did not change.

Steps 4–5 describe the current code. The NWCH checks and the first TPC-DS run (R10) predate the forced tool call and the deterministic attacks: their judges answered in JSON text, and the adversary covered all four families. The integrated TPC-DS run (R10b) used the current code.

## What has been measured

**Offline (scripted stand-in models, not model evidence).** On 33 TPC-DS candidates (the project-owner review's 25 YES and 3 DEFERRED, 3 decoys from the live negative control, and 2 candidates that review left out because their target is not unique), the default configuration accepted 25/25 YES, deferred 3/3 DEFERRED, rejected 3/3 decoys and deferred 2/2 non-unique targets: 0 false accepts. With evidence-only judges and no adversarial pass, one decoy (`store_sales.ss_store_sk → web_site`) was accepted; adding the adversarial pass rejected it. These figures validate the pipeline and its floors, not how well a real model judges.

**Live.** See [`NWCH_BLIND_CHECK.md`](NWCH_BLIND_CHECK.md) (6 never-touched tables, three successive checks) and [`TPCDS_FULL_RUN_R10.md`](TPCDS_FULL_RUN_R10.md) (full TPC-DS run: 182 candidates reviewed, 92 approved, precision 92/92 against the 103-edge gold set; the integrated run after the fixes, R10b, reached 92/92 in its final state with 0 invalid model responses in 353 calls).

## Limits

- Judges and adversary may run on the same model; correlated errors are possible, and the overlay records when roles shared a model.
- All approvals rest on bounded samples plus targeted global reads, not on full-table scans.
- The gold sets are read only by the evaluation module, after a run; the engine never reads them.
