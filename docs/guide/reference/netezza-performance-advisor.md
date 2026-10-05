---
title: Netezza Performance Advisor
description: Review deterministic Netezza performance findings backed by SQL structure, metadata and EXPLAIN evidence.
audience: reference
category: Reference
status: Supported
last_verified: 2026-10-04
product_version: 3.18.5
---

# Netezza Performance Advisor

Use **JustyBase: Analyze Query Performance** on a selected statement or the
statement at the cursor. **Analyze Last Execution** analyzes the most recent
history entry for the editor's connection, with its recorded database/schema.
History is the SQL source; this is not a replay or runtime/workload analysis.

The advisor uses the shared parser, cached column metadata and existing Netezza
catalog builders. It issues an additional **EXPLAIN VERBOSE** on an isolated
session through the existing execution runtime. It never runs the analyzed SQL.
EXPLAIN uses the existing planner-only safety gate: one SELECT or WITH SELECT,
without materializing SELECT INTO, locking clauses or executable macros.
Other SQL can retain available static findings when EXPLAIN is rejected.
Temporary/session objects in the editor's session may therefore be unavailable.

Each finding shows a stable rule ID, severity, confidence and its evidence.
Critical identifies a large confirmed-plan operation or measured skew on a
large relation; warning identifies a concern to investigate; info is contextual
advice. Confidence describes the available evidence, not a promised improvement.
EXPLAIN costs and rows are **estimates**, not measured execution times.

## Rules

| ID | Evidence and purpose |
| --- | --- |
| NZPERF001 | CST equality joins + distribution metadata: keys do not fully align, or a RANDOM side cannot co-locate; review redistribution risk against the wider workload. |
| NZPERF002 | Explicit skew measurement: maximum/average rows per slice is at least 2. |
| NZPERF003A | Catalog-reported missing statistics on a large relation; verify statistics. |
| NZPERF003B | Zero-confidence large scan in EXPLAIN; statistics may be missing or insufficient. |
| NZPERF004 | EXPLAIN scan estimates at least one million rows; review selective and zone-map-friendly filters. |
| NZPERF005 | CST function/cast inside a join or filter; review processing and native type compatibility. |
| NZPERF006 | Join columns have different cached types; verify conversions and compatibility. |
| NZPERF007 | JOIN without ON/USING/NATURAL; verify Cartesian multiplication is intended. |
| NZPERF008 | Wildcard projection of a relation with at least 40 columns and a row estimate of at least one million; review required columns. |
| NZPERF009 | EXPLAIN sort/aggregation estimates at least one million rows. |
| NZPERF010 | UNION performs duplicate elimination; consider UNION ALL only when semantics permit. |
| NZPERF011 | EXPLAIN redistribution/broadcast/movement estimates at least one million rows. |
| NZPERF012 | Estimated join output is at least one million rows and at least 10× combined immediate input estimates. |

Distribution advice is deliberately phrased as a review. A change that helps
one query can hurt others; a single query is insufficient to select a new key.
Distribution is modelled as HASH (with keys), RANDOM or UNKNOWN. Aligned HASH
equality keys do not generate a mismatch warning. A HASH/RANDOM or RANDOM/RANDOM
join is reported as possible data movement. Unknown distribution metadata does
not produce an invented recommendation; the report notes that the alignment
check was skipped.

NZPERF003 is split by evidence source. **NZPERF003A** requires a catalog
statistics signal that the current catalog queries do not expose, so it only
fires when a statistics state is explicitly supplied; **NZPERF003B** is the
live EXPLAIN confidence signal. This avoids conflating catalog state with
optimizer confidence. No statistics date is fabricated.

## Optional skew measurement

**Measure skew (scans referenced tables)** explicitly runs the existing
DATASLICEID/COUNT query, sequentially, for up to ten referenced tables. This may
be expensive. Normal analysis performs no COUNT scan. The populated-slice ratio
is a lower bound because empty slices are absent from that query. Slice-count
truncation or measurement errors leave skew unknown and preserve other findings.

## Partial reports and navigation

EXPLAIN/catalog failures preserve static and available metadata findings.
The panel lists missing sources and limitations. Raw EXPLAIN remains available
if its format cannot be structured. **Show explain steps** highlights relevant
structured nodes; **Show in SQL** navigates only while the captured editor text
is unchanged. Object links use existing DDL commands. Closing a panel cancels
its refresh work and releases the analysis session.

There is no fabricated statistics age, guaranteed runtime prediction or arbitrary
performance score. Statistics dates, actual runtimes, persisted skew measurements,
workload-aware distribution selection and full visual-plan integration remain
future extensions. Core analysis is local and deterministic; AI is not required.
