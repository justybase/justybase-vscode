# JOIN Knowledge — overview (main entry point)

Status: **Stages 1–2 passed (2026-10-25); Stages 3, 4 and 5 implemented with automated gates green
(maintainer round-trips pending); within-tier scoring, column ranking and FROM acceptance added
2026-10-26; Stages 6–7 sketch**
Scope: desktop extension + LSP server (`src/server/`), shared `packages/sql-core`, webview manager, Copilot tool surface

> This file is the **main entry point** to the JOIN Knowledge documentation.
> Normative rules live in exactly one place: `01-ranking-model.md`.
> Stage files link there and never duplicate tiers, bands, identity or fingerprint rules.

## Independent ranking domains

1. **JOIN relations** — which JOIN target / ON predicate to suggest.
2. **FROM objects** — which table/view/synonym to suggest after `FROM`.
3. **Columns** — which column of a known table to suggest first (`01-ranking-model.md` §3a).

A popular table is never evidence that a JOIN is correct. A confirmed JOIN never promotes a table in `FROM`.
Column usage never creates a relation and never reorders FROM objects.
Stores, snapshots, notifications and switches are separate; only the extractor, storage root and manager UI are shared.

## Authority order (normative — see `01-ranking-model.md`)

JOIN: manual `joinRelations` (`0_0_`) → user-confirmed (`0_1_`) → catalog FK (`0_2_`) →
favorite preference (`0_3_`) → executed (`0_4_`) → workspace files plus half-weight accepted
selections (`0_5_`) → heuristics (`2_` / `0_6_` / `0_7_`). Inside every tier a bounded `_NN_` score
orders candidates by column exactness, schema agreement, evidence breadth, query context and
freshness (`01-ranking-model.md` §1); it never crosses tiers.

Objects (FROM only): exclude (removed) → pin (`2_`, only crossing of match rank/scope/kind) →
boost (`00`–`09`, inside tie group) → learned (`10`–`49`, inside tie group) → neutral (`50`) → demote (`90`).

Observed evidence never outranks FK without an explicit per-relation confirmation. No global
`observed-beats-FK` switch exists.

## Document map

| File | Role |
|---|---|
| `01-ranking-model.md` | **Sole normative source** for tiers, bands, identity, canonicalization, fingerprints, thresholds. Other files link here, never copy rules. |
| `02-stage-1-foundation.md` | Minimal knowledge model + ranking + Netezza qualification + regressions. No scanning, no AI, no parsing. |
| `03-stage-2-index.md` | Workspace SQL index, Git selection, incremental + consistency gates. |
| `04-stage-3-manager.md` | Sidebar manager, decisions, explainability, undo. |
| `05-stage-4-portability.md` | Import/export of manual decisions as an atomic transaction with undo (implemented). |
| `06-stage-5-learning.md` | Executed learning remains gated; accepted completion evidence and within-tier scoring are implemented; A/B/C/D/E evidence split. |
| `07-stage-6-7-ai.md` | AI discovery + agent tool, proposal-only (sketch until Stage 5 gate passes). |
| `08-stage-2-calibration.md` | Calibration: Stage 2 metrics, the leave-one-file-out ranking replay (Top-1/Top-3/Top-5/MRR), unmeasured limits. |
| `09-live-catalog-replay.md` | Live-catalog replay (Netezza): catalog-only and combined regimes, ON conditions, self-named/role-playing keys, grain factor, results and open questions. |
| `10-ghost-text-and-history.md` | JOIN ghost text (positions, calibrated confidence gate) and learning executed JOINs from the extension's query history. |
| `11-column-object-ranking.md` | Column (`alias.`) and FROM-object replay, the object-breadth fix and open findings. |
| `99-tests-gates.md` | Test matrix subset per stage + blocking gates + doc-compliance check. |

## Stage order (blocking)

```
Stage 1 → Stage 2 → Stage 3 → Stage 4 → Stage 5 → Stage 6 → Stage 7
```

No stage starts until the previous gate is recorded as passed. No parallel implementation of stages
without an explicit, recorded reason. Stages 6–7 stay as sketches.

Recorded deviation (2026-10-26): Stage 5 (executed/accepted learning) was implemented before Stage 4
and before the Stage 3 maintainer round-trip, because ranking quality was the user-facing priority
and Stage 5 does not depend on portability. Stage 4 was implemented afterwards. Both remain marked
"pending" until their manual round-trips are recorded.

## Stage tracker

| Stage | State | Gate |
|---|---|---|
| 1 — foundation + regressions | `passed (2026-10-25, closing review included)` | `99-tests-gates.md` Gate 1 |
| 2 — workspace index | `passed (2026-10-25, six-point gate + real workspace)` | Gate 2 incl. 6-point consistency checklist |
| 3 — manager sidebar | `implemented (2026-10-25) — automated checks green; manual round-trip pending` | Gate 3 (round-trips from the view alone) |
| 4 — import/export | `implemented (2026-10-26) — export of active manual decisions, whole-file validation, diff, keep-local/keep-import/per-item, atomic write, one-step undo; two-install round-trip pending` | Gate 4 |
| 5 — executed/accepted | `implemented (2026-10-26) — Netezza execution capture, 0_4_ ranking, executed object/column bands, persisted event dedupe/caps, accepted JOIN and FROM selections, manager view; Gate 5 end-to-end/manual sign-off pending; Netezza Extension Host scenario green since 2026-10-27` | Gate 5 |
| Ranking quality | `implemented (2026-10-26) — within-tier score, query context, column ranking, unscoped evidence lookup; replay Top-1 17.6% → 55.9%, MRR 0.451 → 0.735 on the labelled corpus; catalog cold start tie-averaged MRR 0.291 → 0.606 on the live star corpus (09); ON ghost text precision 0.98–1.00 (10); FROM sources MRR 0.236 → 0.490, alias columns 0.312 → 0.499 and SUM/AVG arguments 0.362 → 0.454 (11)` | Ranking quality gate |
| 6–7 — AI | `sketch, opt-in last` | Gates 6–7 |

Rules: strict order 1→2→3→4→5→6→7. Every gate requires tests + consistency checklist +
doc-compliance diff against `01-ranking-model.md`.

## Approved deltas in this split (only functional changes vs pre-split v4)

1. **Relation canonicalization** (`01-ranking-model.md` §2): whole-pair orientation with bound columns,
   both-direction / composite / AND-order tests. Independent table/column sorting is forbidden.
2. **Index-consistency gate** (`03-stage-2-index.md`): modified / deleted / untracked / branch-switch /
   interrupted-restart / rebuild must leave zero ghost evidence; manual decisions survive all six.

No other logic or scope change. Boost/band boundaries, FROM-only exclude scope, transactional
`keep-local`-default import, fingerprint normalization and payload-level privacy assertions are
unchanged carry-overs from the v4 review, now housed under `01-ranking-model.md`.

## Privacy / performance invariants (all stages)

- No SQL text, literals, hosts, connection names, history, salts or fingerprints in snapshots, exports, AI packets or webview payloads. Identifiers (tables, columns) and counters are allowed. Local index/evidence files may store salted statement fingerprints and opaque execution-event keys solely for dedupe; they are never exported. Payload-level assertions, not type-level only.
- Completion path: no I/O, no parsing, no git, no network. Map lookups + memoized merge only.
- Budgets: `completionMedian ≤ 150 ms`, `completionP95 ≤ 300 ms`; index caps and truncation are explicit, never silent.
