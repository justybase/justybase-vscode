---
title: Performance and reliability
description: Understand streaming, cancellation, retries, result limits, cache persistence, and the measurements behind JustyBase behavior.
audience: user
category: Product guides
status: Supported
last_verified: 2026-08-19
product_version: 3.17.10
---

# Performance and reliability

JustyBase optimizes the path from the first row to a useful decision. It does not promise a universal latency SLA: database, network, driver, SQL shape, and local machine remain decisive. The numbers below are implementation defaults and guardrails for the current version.

## Query execution

- **Streaming:** with `justybase.enableStreaming` enabled, rows arrive in chunks (`justybase.streamingChunkSize`, default 5,000) and progressive rendering can begin before the complete result is available.
- **Cancellation:** **Cancel Query** stops new work and asks the driver/server to cancel. A partial result may remain visible and is marked partial/cancelled; it must not be mistaken for a complete dataset.
- **Retry:** retry after a transient connection error reuses the selected tab connection. It does not duplicate a completed statement silently.
- **Batch:** batch statements can stop at the first error or continue when **Run Query (Continue on Error)** is selected. Each statement keeps its own result/error state.
- **Limits:** `justybase.query.rowLimit` defaults to `200000` fetched rows per execution. `justybase.query.executionTimeout` defaults to `3600` seconds in the desktop extension. The Web Editor has its own server defaults and session TTL; see [Web Editor](guide/admin/web-editor/).
- **Long-query alert:** `justybase.longQueryAlertThreshold` defaults to 10 minutes; set it to `0` to disable the notification.

## Result storage layers

The Result Panel keeps small results in memory. Large results can spill to a temporary SQLite database when disk-backed results are enabled. The thresholds are `memoryRowThreshold` (default 25,000), `memoryByteThreshold` (about 128 MiB), and `rowThreshold` (500,000 hard upper activation threshold). The spill dataset contains only rows fetched from the database.

Disk-backed storage makes filtering, sorting, grouping, profiles, and aggregations stable without keeping the full row array in the webview. It disables inline editing for that result because the local spill is not the source-of-truth database. Temporary result files are cleaned according to the result lifecycle; do not treat them as an archive.

## Metadata cache

Metadata is lazy and cache-first. `justybase.cacheTTL` defaults to 12 hours. With disk persistence enabled, the cache is available after a VS Code restart and can avoid a cold catalog prefetch. Cross-window synchronization uses file watching and polling so another window can reload a completed disk snapshot instead of repeating the same refresh. Cache statistics and the Result Panel performance stats commands expose operational evidence.

Refresh only the affected selection when possible. A full multi-database refresh is more expensive and can be serialized for safety. Metadata session sweeping applies only to sessions created by metadata/prefetch queries and requires the configured Netezza privilege.

For Netezza refresh investigations, open [Schema Refresh Details](guide/user/schema-browser/#schema-refresh-details). It shows generated catalog SQL by state, queue wait, execution time, row counts, snapshot completeness, and the longest statement for the current connection-scoped refresh. Use the final snapshot and frozen elapsed time when comparing runs; the panel is diagnostic and read-only, not a SQL execution console.

## Failure and recovery table

| Situation | What remains usable | Next action |
| --- | --- | --- |
| Query cancelled after rows arrived | Partial result and diagnostics | Add a narrower predicate or rerun; do not export as complete without review. |
| Batch statement failed | Earlier result sets and later statements if Continue on Error | Fix the failed statement and rerun that selection. |
| Connection dropped | Editor text, cached metadata, completed results | Retry after checking network/credentials. |
| Result session spilled | Full fetched dataset in local SQLite | Use disk-backed filtering; inline edits are unavailable. |
| VS Code restarted | Persisted metadata and saved SQL; result behavior depends on result persistence | Re-run the query when the result is not retained. |
| Cache appears stale | Existing suggestions and last snapshot | Refresh selected metadata, then inspect cache stats. |

## Measuring instead of guessing

The repository contains local benchmark suites for completion/suggestion, LSP features, quality rules, result hydration, and migration flows. Parser construction has a hard cold-start guardrail below 2,000 ms for the MSSQL and Oracle parser performance tests. These are regression budgets for a version and machine, not customer-facing SLA values. Results are written to ignored `Benchmark/*.results.md` files.

Use **Start UX Perf Session**, **Show Result Panel Performance Stats**, and **Show Metadata Cache Stats** for a local investigation. Include the version, database kind, row count, whether the result was disk-backed, and the relevant stats when reporting a performance issue.

### Reading grid and import timings

The first search can include debounce, worker startup, and loading rows into the worker. A warm search reuses that worker data and is the better comparison for repeated filtering. **Loaded rows** searches only the rows already in the memory-backed grid; **worker search** scans those rows off the UI thread for large results; **disk-backed search** runs `queryRows()` and `countRows()` against the local SQLite spill; **database-scope search** reruns a bounded SQL shape and measures database/network time as well. These are different data boundaries, so their timings should not be compared as if they were one operation.

For imports, the preview is type inference plus a small sample and validation. A local stream is file parsing and stream consumption; a full import also includes database connection, staging/external-table work, server execution, and row-count verification. For exports, **payload preparation** is the webview’s request construction. Writing, compression, workbook finalization, dialogs, clipboard, and host-side file I/O happen after that boundary.

When reporting a performance problem, include the application version/commit, profile or approximate rows × columns, grid mode (`inline`, `worker`, or `sqlite`), operation and format, whether the search was cold or warm, and median/P95 if available. Also state whether the result was loaded, spilled to disk, or searched in the database. The developer-only [Data Grid benchmark playbook](guide/developer/performance-benchmarks/) explains the reproducible suite.

## Practical recipe for a large query

1. Start with a narrow predicate and a trailing `LIMIT`.
2. Keep streaming enabled and watch first-row behavior.
3. Cancel if the query shape is wrong; a partial result is useful feedback, not a final answer.
4. Use the Result Panel’s disk-backed layer for the fetched dataset.
5. Use **All rows + LIMIT** only when the logical query has a stable trailing limit and re-querying the database is acceptable; see [Data Grid](guide/user/data-grid/).
