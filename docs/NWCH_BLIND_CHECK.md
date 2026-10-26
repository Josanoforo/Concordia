# Blind check of the model review on Northwind + Chinook (NWCH)

A live, blind test of the full agent with the model review built in (`reviewMode: MODEL_ADVERSARIAL`), over **6 tables no earlier Concordia run had touched**: 3 from Northwind and 3 from Chinook. The data lived in Zetaris; the model was called live through Nightshift. Each check was approved by the project-owner before launch, with a fixed ceiling of 506 SQL statements and 400,000 tokens. 0 DDL in all three. The gold set (3 true foreign keys) was used only to score the runs afterwards.

The hard part of this universe is homonyms: small overlapping integer keys (`ArtistId`, `AlbumId`, `TrackId`, `PlaylistId`) pass membership tests with HIGH coverage even where no relation exists, so only semantics and global evidence can separate them.

## What discovery found

COMA proposed 30 pairs and all 30 were probed. The 3 true FKs came out with HIGH coverage and no suspicion: `chinook_album.ArtistId → chinook_artist` (15/15), `northwind_order_details.OrderID → orders` (7/7) and `northwind_order_details.ProductID → products` (18/18). Cross-schema pairs gave NONE or LOW coverage. Three intra-Chinook homonyms also reached HIGH coverage (15/15 to 20/20). 8 candidates were reviewed in each check: the 3 true FKs and 5 homonym/orphan candidates (3 homonyms, 2 orphan columns).

## Three checks

| Check | True FKs approved | Contracts on homonyms or orphans | Adversarial pass completed | SQL | Tokens |
|---|---|---|---|---|---|
| `agent-nwch-r9-blind-live-01` | 0/3 | 0/5 | 0/3 | 45 | 68,886 |
| `agent-nwch-r9-blind-live-02` | 1/3 | 0/5 | 2/3 | 52 | 84,572 |
| `agent-nwch-r9-blind-live-03` | **2/3** | **0/5** | **3/3** | 62 | 81,895 |

- **Check 1 (FAIL on approvals, PASS on safety).** The model's judgment was right in 12 of 12 valid evaluations: it accepted the 3 FKs and rejected the homonyms and orphans. The approvals were lost to two defects in Concordia: responses truncated at 400 output tokens (so the adversarial pass never completed and every accept was deferred), and an ambiguous reason code that turned an accept into a defer. Both were fixed with regression tests built from the sanitized live responses.
- **Check 2.** `OrderID → orders` was approved and sealed `MODEL_REVIEWED`. `ProductID` was deferred because the adversary was truncated again (at 2,000 tokens); `ArtistId` was deferred on a real sibling tie. Fixes: a concise adversary, a higher output cap, and global target-uniqueness evidence passed to the reviewer before it decides on sibling ties.
- **Check 3 (PASS, 2/3 threshold met).** Started from empty memory. `OrderID` and `ProductID` were approved and sealed `MODEL_REVIEWED`; the adversarial pass completed on 3/3. `ArtistId → artist` stayed deferred: in this dataset `playlist_track.TrackId` holds 20 rows with 20 distinct values, so it is globally unique too and only the names separate the two targets. That defer is honest given the data; it is a limit of the sample dataset, not of the reviewer.

## What the check shows

- Safety held in all three checks: 0 contracts on homonyms or orphans, 0 relations labelled human-reviewed, and the "adversarial pass" label only where the pass completed.
- The failures were Concordia's own defects, each diagnosed from the run's trace and fixed with a regression before the next check.
- 3 true FKs is a small denominator. The full TPC-DS run in [`TPCDS_FULL_RUN_R10.md`](TPCDS_FULL_RUN_R10.md) is the larger measurement.
