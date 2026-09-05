---
title: Data Grid and Result Exploration
description: Explore streamed, multi-result, memory-backed, and disk-backed results with explicit data boundaries.
audience: user
category: Product guides
status: Supported
last_verified: 2026-08-19
product_version: 3.17.13
---

# Data Grid and Result Exploration

The Result Panel is a data exploration workspace, not only a table widget. It virtualizes visible rows, preserves multiple result sets, and makes the scope of a filter or aggregate visible before it runs.

## Core workflow

1. Run a query or batch and select a result-set tab.
2. Use column sorting, a column filter, or global search. The grid virtualizes the rendered window; it does not imply that the whole database has been fetched.
3. Open the column profile to inspect distinct values, null counts, distributions, and summary statistics.
4. Group or pivot when the result shape supports it, then use charts or time views to inspect patterns.
5. Open **Row View** for side-by-side rows or **Value Viewer** for a long cell.
6. Pin important result sets and let grid state (column order, filters, sorting, visibility, and pinning) persist for the file.

<figure>
  <img src="screenshots/row-view.png" alt="Row View showing a result row side by side with values">
  <figcaption>Row View and Value Viewer open long cells without leaving the result workspace.</figcaption>
</figure>

## Three filtering modes

| Mode | Data boundary | Executes a new query? |
| --- | --- | --- |
| **Loaded rows** | Rows already loaded into the in-memory grid | No |
| **Disk-backed** | The entire dataset fetched into the local SQLite spill | No |
| **All rows + LIMIT** | The logical result before its final `LIMIT`, then the original limit is reapplied | Yes |

### All rows + LIMIT: the important distinction

<figure>
  <img src="screenshots/all-rows-limit.png" alt="All rows + LIMIT filter mode in the result panel">
  <figcaption>Database-scope filtering applies the predicate to the logical result before the display limit.</figcaption>
</figure>

For a query such as:

```sql
SELECT customer_id, order_date, total_amount
FROM SALES.ORDERS
ORDER BY order_date DESC
LIMIT 1000;
```

the database-scope filter can use this execution shape:

```text
SELECT ... ORDER BY ... LIMIT 1000
        │
        ├─ remove the final LIMIT
        ├─ use the unlimited query as a subquery
        ├─ apply the filter or aggregate to the logical result
        └─ apply LIMIT 1000 again
```

Use **All rows + LIMIT** when you need to filter the logical result before the display limit. It requires a final `LIMIT`, stable and unique column names, and a query that can safely be wrapped as a subquery. Every Apply can run the database query again; a normal timeout applies, with Retry allowing the longer retry window. It operates on the logical result, not on the whole database without a boundary.

It is unavailable for a result that is already disk-backed only. Use disk-backed filtering for the complete fetched dataset instead.

### Loaded rows

Loaded-row filtering is immediate and local. It is the right choice for a 500-row result or a quick inspection of what has arrived. It cannot find rows that were never fetched because of `rowLimit`, cancellation, or the original database `LIMIT`.

### Disk-backed

Disk-backed filtering sees every row fetched into the SQLite spill, without a second database query. It can sort, group, calculate distinct values, and aggregate over that fetched dataset. It still cannot see rows the server did not send. Inline editing is disabled for disk-backed results.

## Aggregations and profiles

<figure>
  <img src="screenshots/results-explorer.png" alt="Result exploration with profiles, distributions, and summaries in JustyBase">
  <figcaption>The result explorer turns a grid into profiles, distributions, summaries, and pivot views.</figcaption>
</figure>

<figure>
  <img src="screenshots/results-chart.png" alt="Interactive chart built from a JustyBase query result">
  <figcaption>Chart views compare patterns without writing another exploratory query.</figcaption>
</figure>

Visible-scope aggregation uses the currently filtered grid/spill. Database-scope aggregation uses the unlimited subquery used by **All rows + LIMIT**. Available operations include `SUM`, `AVG`, `MIN`, `MAX`, `COUNT`, `COUNT DISTINCT`, `STDDEV`, and `MEDIAN` where the selected database supports the operation and the column type is suitable. Pin aggregations to compare columns while changing filters.

## Multiple result sets and partial results

Batch statements appear as separate tabs. Pinning protects a result from normal pruning; the current defaults are 50 data result sets per SQL file and 10 manually pinned sets. Empty, cancelled, partial, and error result sets keep their state and message so the user can distinguish “zero rows” from “query did not complete.”

## Copy and export

Copy selected cells or rows as TSV, Markdown, CSV, or CSV-semicolon. Export can use raw values or display-formatted values, controlled by `justybase.results.useFormattedValuesForExport`. Formatting controls include integer/decimal grouping, group and decimal separators, scale, trailing zeros, and rounding mode. A display value such as `1 234,50` is not the same as the raw numeric value `1234.5`; choose deliberately before handing data to another system.

The desktop grid can export query results to XLSB, XLSX, CSV, CSV.GZ, CSV.ZST, JSON, XML, SQL INSERT, Markdown, and Parquet. The Web Editor’s session export surface is listed in the [Web API reference](guide/reference/web-api/).

## Large-data limits

Virtualization reduces DOM cost, streaming reduces time-to-first-row, and SQLite spill reduces webview memory pressure. Neither changes the database workload. Use a predicate, a stable order, and a bounded limit before enabling database-scope exploration. Inspect [Performance and Reliability](guide/user/performance-reliability/) for thresholds and recovery behavior.

For reproducible desktop comparisons, see the [Data Grid performance benchmark playbook](guide/developer/performance-benchmarks/). It distinguishes inline, worker, disk-backed, and database-scope work instead of presenting them as one search time.
