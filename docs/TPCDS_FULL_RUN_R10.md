# Full TPC-DS run with the model review (round 10)

A live run of the full agent over the public TPC-DS schema in Zetaris, with the model review built in (`reviewMode: MODEL_ADVERSARIAL`) and every candidate probed (`coverAll`). It ran in two passes: a fresh discovery pass, then a second pass that reuses what the first one sealed in memory. The launch was approved by the project-owner with a ceiling of 4,224 SQL statements and 4M tokens per pass. Both passes ran from a clean copy of the same code. Results were scored offline afterwards against a gold set of 103 single-column foreign keys and the project-owner's earlier review of 28 candidates plus 3 decoys.

## Results

| Measure | Pass 1 (fresh) | Pass 2 (reuse) |
|---|---|---|
| Precision: approved contracts that are true gold FKs | **92/92** | **92/92** |
| Approved outside the gold set / inverted | 0 / 0 | 0 / 0 |
| Recall | **92/103 (89.3%)** | **92/103 (89.3%)** |
| Project-owner YES relations approved | 24/25 | 24/25 |
| Decoys without a contract | **3/3** | **3/3** |
| Gold edges proposed inverted by COMA and recovered | 57/58 | 57/58 |
| Reused from memory | — | **92/92, 0 new contracts** |
| SQL used (budget + discovery) | 2,165 of 4,224 | 1,635 of 4,224 |
| Tokens | 1,592,366 of 4M | 356,846 of 4M |

- **Pass 1 review:** 182 candidates reviewed by the model: 92 approved, 86 rejected, 4 deferred. 1,284 more were held back by the review gate.
- **Pass 2:** the 92 relations reused from memory are exactly the 92 approved in pass 1. The 90 not approved were reviewed again: 86 rejected → rejected, 1 deferred → deferred, 3 deferred → rejected, 0 newly approved. One of those 3, `store_returns.sr_returned_date_sk → date_dim.d_date_sk` (rejected as `SIBLING_BETTER_MATCH`), is a true gold FK: pass 2 was stricter than pass 1 on it. Reuse is not new independent evidence: pass 2 measures the stability of the 90 non-approved decisions, not a reconfirmation of the 92.
- **Memory:** 117 claims after pass 1 (25 earlier human-reviewed + 92 `MODEL_REVIEWED`); pass 2 added none and created no conflicts.
- **0 DDL. 0 gold at runtime:** the run's artifacts and the engine code contain no reference to the gold or label files; only the evaluation module reads them.

## Where the 11 missed gold edges were lost (pass 1; pass 2 differs only by one deferred edge becoming rejected)

| First stage that stopped the edge | Edges |
|---|---|
| No COMA proposal in either direction | 2 |
| Proposed only inverted | 1 |
| Coverage probe could not run (`NO_SAFE_SAMPLED_VALUES`) | 1 |
| Held back by a post-COMA guard (`RANGE_BIASED`, `TARGET_NOT_UNIQUE`) | 3 |
| Reviewed and rejected (`KEY_MEMBERSHIP_CONTRADICTED`) | 2 |
| Reviewed and deferred | 2 |

The one project-owner YES not approved, `inventory.inv_item_sk → item.i_item_sk`, was held back by the `RANGE_BIASED` guard and never reached review. Of the 3 relations the project-owner had deferred, 2 received a contract; both are true gold FKs.

## Integrated run after the fixes (R10b)

A second full two-pass run on the integrated code: the fixes above, plus the review-decision memory (an earlier reject or defer is reused when the evidence fingerprint and prompt version are unchanged) and the per-role transport described in [`MODEL_REVIEW.md`](MODEL_REVIEW.md). Same public schema, same gold set and labels, same ceiling of 4,224 SQL statements and 4M tokens per pass, approved by the project-owner. Scored offline with the same method.

| Measure | Pass 1 (fresh) | Pass 2 (reuse, final state) |
|---|---|---|
| Precision: approved contracts that are true gold FKs | **91/91** | **92/92** |
| Approved outside the gold set / inverted | 0 / 0 | 0 / 0 |
| Recall | 91/103 | **92/103 (89.3%)** |
| Project-owner YES relations approved | 23/25 | **23/25** |
| Project-owner DEFERRED relations that received a contract (all 3 are true gold FKs) | 2/3 | 3/3 |
| Decoys without a contract | **3/3** | **3/3** |
| Gold edges proposed inverted by COMA and recovered | 57/58 | 57/58 |
| Run status | `COMPLETED` | `COMPLETED` |
| Invalid model responses | **0/353** | 0/3 |
| SQL used (budget + discovery) | 2,162 of 4,224 | 1,642 of 4,224 |
| Tokens | 1,714,724 of 4M | 29,352 of 4M |

- **Pass 2:** the 91 relations approved in pass 1 came back from memory with no new contract and no re-probe (182 contract SQL saved). The review-decision memory answered 78 of 79 lookups with the earlier negative decision, so 78 model calls were avoided; the review in pass 2 cost 3 model calls and 14,068 tokens (R10 pass 2: 77 calls, 328,865 tokens). The 92nd approval, `inventory.inv_date_sk → date_dim.d_date_sk`, had been rejected in pass 1 by sample evidence (`KEY_MEMBERSHIP_CONTRADICTED`), not by the model; with pass 2's new sample it was no longer contradicted, went to review and was approved. No decision moved from reject to approve by the model.
- **Against R10:** 91 approved relations in common. R10b approved `catalog_page.cp_end_date_sk → date_dim.d_date_sk`, which R10 had rejected on sample evidence. R10 approved `store_returns.sr_store_sk → store.s_store_sk`, which the model deferred in R10b; it is one of the 2 project-owner YES not approved. The other, `inventory.inv_item_sk → item.i_item_sk`, was again held back by the `RANGE_BIASED` guard. Both differing relations are gold FKs, so recall is the same.
- **Critic:** after the critic fix, the contract critic confirmed 69 of 91 approved relations in pass 1 with new supporting evidence (R10: 0 of 92), and refuted none.
- **Model route:** 2 of the 353 review calls in pass 1 were answered by a different model version within the same route; the run's model table declares that the model per role is not pinned.
- **Timeouts:** one per pass, the same intermittent stall as before. One left a full-table coverage measurement `NOT_MEASURED` on a relation that was still approved; the other hit a probe on a candidate outside the gold set.
- **Aborted attempts:** two earlier attempts on the same day stopped during the contract probes, before emitting a status, because of adversary encoding defects over the tool call (see [`MODEL_REVIEW.md`](MODEL_REVIEW.md)). They are not counted as results.
- 0 DDL; 0 gold at runtime.

## Honest caveats

- Run status. Under the status rules of the code that ran, neither pass ended `COMPLETED`. The current status rules separate core phases (discovery, probing, review, memory) from auxiliary ones (exploration, critic); applied offline to the saved artifacts, they classify both passes as `COMPLETED_WITH_WARNINGS`: core complete, warnings in exploration, and the critic recorded as skipped in both (the legacy probe-phase critic; the contract critic ran on every approved relation). The recorded statuses were: pass 1 `DEGRADED_NO_MODEL`, because the model gateway was unreachable during exploration (the review itself made 355 model calls), with the critic skipped; pass 2 is `DEGRADED` (a non-JSON exploration reply, the critic skipped, and the step budget exhausted). Neither degradation touches the review figures above. Two of the causes were fixed afterwards: a gateway preflight before the first live SQL, and a forced tool call for the exploration chooser.
- An intermediate reuse attempt reused 0 relations because a prior run setting skipped the probes it needed; memory was unchanged (same claim count, size and timestamp). The cause was fixed in code and the reuse pass was relaunched with project-owner approval.
- After the run, two approved single read-only queries confirmed two diagnoses: a 60 s timeout on a 60-row table was an intermittent stall (the same query passed in 6.3 s), and a critic counter-probe reported as truncated actually matched 46/46 keys, so the defect was in the critic, not the data. The critic defect is fixed and checked offline by replaying the run's counter-probe shapes; the intermittent stall is an upstream behaviour and an opt-in time policy exists but is off.
- The gold set covers single-column FKs only.
