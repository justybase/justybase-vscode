---
title: Data Grid and Result Exploration
description: Explore streamed, multi-result, memory-backed, and disk-backed results with explicit data boundaries.
audience: user
category: Product guides
status: Supported
last_verified: 2026-09-23
product_version: 3.18.7
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

## Column filters and grouped tree rows

The result grid uses shared UI components. Click the funnel icon in a column
header to open the Excel-like filter menu. It can search the visible
values, select or invert distinct values, use text/numeric comparison
operators, and match blank or non-blank values. Click **Apply** to keep the
filter; **Clear filter** removes it. The older inline text fields are retained
only for hosts that do not provide the rich filter menu.

Use **Group** to open the grouping surface and start with the first result
column, or use **Group by column** in a header/context menu. Drag additional
columns into the grouping surface to create nested groups; the chip order is
the grouping priority. Each group is rendered as a tree row with an expand/
collapse chevron, indentation, row count, and preserved row selection/copy
coordinates. Removing the last grouping returns the flat result grid.

Click **Pivot** to choose a row column, a pivot column, and a numeric value
column. The operation opens in a dedicated panel and produces a separate,
closable grid that respects the active filters.

Drag a cell or row selection beyond the top or bottom edge of the result
viewport to keep extending it while the grid scrolls. Header widths include
the type badge and the drag, pin, filter, and grouping controls. A manually
saved width is still respected, but it cannot be reduced below the readable
header minimum; use horizontal scrolling for a wide result.

In the desktop Result Panel, open **More → Responsive collapsed columns** to
move columns that do not fit into expandable row details. Use the chevron in a
row number cell to inspect those values. The option is off by default and is
remembered for that result set. Grouping temporarily suspends the layout; the
setting resumes when the grid returns to flat rows.

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

## Analytical

The **Analytical** view groups the rows by up to three columns and flags groups whose values, nulls, dates or category mix differ from the rest of the result. See [Analytical View](guide/user/analytical-view/) for the detection modes, the rules and their limits.

## Explore

Open **Explore** to inspect column profiles, distributions, quality alerts,
pivots, and charts. Profiles examine the **first 50,000 loaded rows**, or all
loaded rows when fewer are available. This is a first-row sample, not a random
sample. The scope banner shows examined, loaded, and matching sample row counts;
these counts do not describe rows that have not been fetched.

**Add filter** supports category inclusion/exclusion, multiple values, NULL,
empty strings, dates, and numeric ranges. Changes are drafts until **Apply**;
**Cancel** discards them. **Undo**, **Redo**, and individual filter chips let you
revise the analysis. Explore filters are independent of the main grid's filters.
Value search is local until you explicitly select **Search database**, which can
find values outside the sample and returns up to 100 values per search.

Under **Charts**, choose **Category ranking** for Top/Bottom N without a date
column, or **Time series** for a date-based chart. Rankings support Count rows,
Sum, Average, Minimum, Maximum, and Count distinct. **Show share** uses the full
filtered population, including categories outside Top N. It is available for
Count rows and non-negative Sum category totals with a positive total.
**Include Other** combines remaining categories for Count rows and Sum only.
A real category named `Other` remains separate from this synthetic group.

Database computations require **Run**. Changing filters or chart settings marks
the previous computation **Out of date**; it does not automatically query the
database. Original user-authored LIMIT, TOP, and FETCH clauses are preserved.
Database computations read current database data, which may have changed since
the original result was fetched. Pivots and time series display up to 5,000 rows.

Select a category, histogram range, or current time-series point to access
**Filter to selection**, **Show rows**, and **Open SQL**. The selection uses the
filters of the displayed computation, including when it is out of date. Chart
data and distribution ranges provide equivalent keyboard actions. The time
series selection tool can select an interval without changing normal zoom.

**Show rows** opens a separate preview inside Explore. Sample previews are
local; database previews require **Load rows**. Previews show up to 1,000 rows,
100 per page, and page changes do not execute more queries. **Open SQL** opens a
bounded details query without executing it. For results without reusable SQL,
local sample exploration remains available. Access database exploration and
SQL Server sources beginning with a CTE are currently unavailable.

Filters and chart settings belong to a stable result identity and survive
navigation through Logs and other results. New executions do not inherit an
unrelated result's filters. Unsupported database operations report their
limitation rather than silently substituting sample statistics.

## Multiple result sets and partial results

Batch statements appear as separate tabs. Pinning protects a result from normal pruning; the current defaults are 50 data result sets per SQL file and 10 manually pinned sets. Empty, cancelled, partial, and error result sets keep their state and message so the user can distinguish “zero rows” from “query did not complete.”

## Copy and export

Copy selected cells or rows as TSV, Markdown, CSV, or CSV-semicolon. Export can use raw values or display-formatted values, controlled by `justybase.results.useFormattedValuesForExport`. Formatting controls include integer/decimal grouping, group and decimal separators, scale, trailing zeros, and rounding mode. A display value such as `1 234,50` is not the same as the raw numeric value `1234.5`; choose deliberately before handing data to another system.

The grid can export query results to XLSB, XLSX, CSV, CSV.GZ, CSV.ZST, JSON, XML, SQL INSERT, Markdown, and Parquet.

## Large-data limits

Virtualization reduces DOM cost, streaming reduces time-to-first-row, and SQLite spill reduces webview memory pressure. Neither changes the database workload. Use a predicate, a stable order, and a bounded limit before enabling database-scope exploration. Inspect [Performance and Reliability](guide/user/performance-reliability/) for thresholds and recovery behavior.

For reproducible desktop comparisons, see the [Data Grid performance benchmark playbook](guide/developer/performance-benchmarks/). It distinguishes inline, worker, disk-backed, and database-scope work instead of presenting them as one search time.
