# Live catalog replay and catalog-only ranking (2026-10-27)

Status: **implemented — measured on the development Netezza (11.2.2.1) and gated offline.**
Normative rules stay in `01-ranking-model.md`; this file records the method, the results and the
open questions.

## Why

The labelled-corpus replay (`08-stage-2-calibration.md`) measures workspace evidence only: its
metadata provider is empty, so the catalog tiers (`0_2_` FK, `2_` heuristic) were never measured.
A real install ranks with both. This phase replays real analyst SQL against a real catalog.

## Method

| Part | Location |
|---|---|
| Identifier-only catalog provider (tables, columns, PK flags, declared FKs; the same pure matcher as the extension host) | `src/knowledge/replayCatalog.ts` |
| Replay modes: `mode: "target"` (after `JOIN `) / `"predicate"` (after `JOIN t ON `); `evidence: "workspace"` / `"none"`; tie-averaged MRR; per-area table | `src/knowledge/joinRankingReplay.ts` |
| Corpus: 40 analyst-style files, 71 JOIN positions, AdventureWorksDW (no declared keys) + MIS snowflake (declared PK/FK) | `src/__tests__/knowledge/fixtures/liveStarCorpus.ts` |
| Offline catalog snapshot of the 55 star tables (incl. their test-copy noise tables) | `src/__tests__/knowledge/fixtures/liveStarCatalog.ts` |
| Live suite: executes every corpus statement on Netezza, loads the whole schema catalog (553 tables), replays all regimes | `src/__tests__/integration/liveStarReplay.live.integration.test.ts` (`npm run benchmark:join-ranking:live`) |

The live suite is read-only (no DDL) and opt-in (`NZ_DEV_PASSWORD`); it is listed in
`scripts/jestLiveDbIgnorePatterns.cjs`. Reports contain identifiers and counters only.

**Tie-averaged MRR.** Inside a tier, equal scores fall back to the label, so plain MRR rewards
alphabetical luck. The tie-averaged variant gives every item of a `tier+score` group the mean
reciprocal rank of the group; it is the headline metric below.

## Findings and changes

1. **FK-less schemas got no catalog targets.** The heuristic required a PK/FK flag or a `PK_`/`FK_`
   prefix; AdventureWorks keys (`DIMPRODUCT.PRODUCTKEY`) have none: 7/40 targets offered.
   → *Self-named keys*: a column named after its own table (`PRODUCTKEY` on `DIMPRODUCT`,
   `BRANCH_ID` on `MIS_DIM_BRANCH`, `CUSTOMER_ID` on `CUSTOMERS`) counts as a key
   (`isSelfNamedKeyColumn`). Fact-to-fact pairs stay excluded (neither side owns the key).
2. **Role-playing keys were invisible.** `FACTINTERNETSALES.ORDERDATEKEY → DIMDATE.DATEKEY`.
   → A column ending with the other table's self-named key (stem ≥ 3 characters) is a heuristic
   match; every role is a separate suggestion, never one composite condition. ON conditions get the
   same matches in the cached-key tier.
3. **Ties inside the FK tier were alphabetical.** → *Grain factor* (`01-ranking-model.md` §1):
   joining the referenced parent keeps the query grain, joining a child fans rows out. Catalog
   matches carry `targetRole`; evidence relations infer it from self-named keys.
4. **Relations already written in the statement stayed in their tier.** → They move to the
   `3_` bucket after every tier. Joining the same table through other columns (role-playing)
   keeps its tier.
5. Identity self-joins (`OD.DATEKEY = SD.DATEKEY` on two aliases of one table) no longer count as
   key matches through a self-named key.

## Results (71 positions; snapshot and live catalog agree within 0.003)

JOIN targets, tie-averaged MRR (Top-1 / Top-3):

| Regime | Before | After |
|---|---|---|
| Catalog only (cold start) | 0.291 (28.2% / 45.1%), covered 53.5% | **0.606** (46.5% / 73.2%), covered 100% |
| — AdventureWorks (no keys) | 0.127, covered 17.5% | **0.542**, covered 100% |
| — MIS (declared FKs) | 0.503 | **0.694** |
| Catalog + workspace evidence | 0.322 (23.9% / 54.9%) | **0.564** (42.3% / 73.2%) |
| Labelled corpus (workspace only, independent of this work) | 0.691 (47.1% Top-1) | **0.735** (55.9% Top-1) |

ON conditions, tie-averaged MRR: cold 0.901 → **0.950** (covered 90.1% → 100%), with evidence
0.958 → **0.970** (Top-1 94.4%).

Grain-weight sensitivity (tie-averaged MRR, cold / combined / labelled corpus): `0` →
0.427 / 0.418 / 0.691; `0.10` (chosen) → 0.606 / 0.564 / 0.735; `0.20` → 0.621 / 0.577 / 0.750.
`0.10` takes most of the gain with the smallest reweighting of the existing factors.

## Open questions (measured, not changed)

- **Thin evidence above heuristics.** With leave-one-out evidence from two files, `0_5_` items about
  an older source outrank a `2_` parent of the most recent source (snowflake walking):
  AdventureWorks cold 0.542 vs combined 0.466. `01-ranking-model.md` does not make
  "observed above heuristic" inviolable, but the corpus is small and self-authored; changing the
  tier order needs a larger, independent corpus first.
- Role-playing alternatives (`ORDER`/`DUE`/`SHIP`) are tied in a cold start; evidence resolves them.
- The corpus was written by the implementer. The labelled corpus (written before these changes)
  is the independent check, and it also improved.

## Next steps (autonomous, ordered)

1. A larger independent corpus (e.g. replay of real `_V_QRYHIST` text once history collection is
   enabled on the dev instance) before any tier-order change.
2. Column-ranking replay after `alias.` (usage bands vs. catalog order).
3. Gate 5 end-to-end in the Extension Host Netezza scenario: execute the corpus through the
   production runner, assert `0_4_` ranking and executed column bands.
4. Manager UI buttons for import/export (Playwright).
