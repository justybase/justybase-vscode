# SQL Results — Filtering and Aggregation Modes

The result panel supports **three complementary execution layers**. They are not interchangeable: each solves a different boundary (what data you see vs. what was fetched vs. what the database would return before `LIMIT`).

## Quick reference

| Mode | When it applies | What you filter | Re-queries database? |
|------|-----------------|-----------------|----------------------|
| **Loaded rows** (default) | In-memory result set | Rows currently in the grid | No |
| **All rows + LIMIT** | SQL ends with `LIMIT N` | Full logical result, then original `LIMIT` | Yes (each Apply) |
| **Disk-backed** (automatic) | Large fetch spilled to SQLite (default ≥25k rows) | Entire spilled dataset locally | No |

## Loaded rows (client / TanStack)

- Filters, sort, grouping, and footer aggregations (`scope: visible`) run on rows **already loaded** in the webview.
- Bounded by `justybase.query.rowLimit` (default 100,000).
- Best for small and medium results; supports **inline cell editing**.
- Global search scans loaded rows (or a background worker when ≥20,000 rows).

**UI:** Column filter → **Loaded rows** (when available).

## All rows + LIMIT (database filter)

- Wraps `refreshSql` / `sql` in a subquery, applies `WHERE` on the **unlimited** query, then re-applies the trailing `LIMIT`.
- Solves: `SELECT … LIMIT 1000` where you need to filter on rows that would match **before** the limit cut.
- Requires a **trailing `LIMIT`** on the original SQL.
- Requires stable, unique column names (not `?COLUMN?`).
- Each Apply runs a new query (timeouts: 5–10s default, 30s on Retry).
- Persists in `databaseFilterSpec`; refresh re-applies the filter.
- Footer aggregations with **`scope: database`** use the same unlimited subquery.

**UI:** Column filter → **All rows + LIMIT**.

**Not available** when the result is disk-backed only (use disk-backed filters instead).

## Disk-backed (SQLite spill)

- Automatic when `justybase.results.diskBackedResults.enabled` is true and row count reaches `min(memoryRowThreshold, rowThreshold)` (defaults **25,000** / **500,000**).
- Requires Node.js with `node:sqlite` (Node 22.5+).
- Stores the **fetched** dataset in a temp SQLite file; the grid shows a scroll window (~2,000 rows).
- Filters, sort, distinct values, grouping, and aggregations use `diskQuerySpec` (SQL on the spill table).
- Does **not** see rows beyond what was fetched from the database.
- **Inline editing is disabled** for disk-backed result sets.

**UI:** No scope toggle — column filter always applies to the full spilled dataset.

## Aggregations

| Scope | Data boundary |
|-------|----------------|
| **Visible** (default) | Filtered rows in grid (memory) or SQLite spill |
| **Database** | Unlimited subquery of `refreshSql` (respects `databaseFilterSpec`) |

Both scopes can be pinned on different columns in the same result set.

## Which mode should I use?

| Goal | Use |
|------|-----|
| Filter a `LIMIT 1000` query on DATEKEY before limit semantics | **All rows + LIMIT** |
| Explore 80k downloaded rows without extra Netezza load | **Disk-backed** (automatic) or **Loaded rows** if still in memory |
| Quick filter on a 500-row result | **Loaded rows** |
| SQL without trailing `LIMIT` | **Loaded rows** or **Disk-backed** — not All rows + LIMIT |
| SUM over entire logical query (not just downloaded rows) | Aggregation **scope: database** |

## Related settings

| Setting | Default | Role |
|---------|---------|------|
| `justybase.query.rowLimit` | 100000 | Max rows fetched from DB |
| `justybase.results.diskBackedResults.enabled` | true | Enable SQLite spill |
| `justybase.results.diskBackedResults.memoryRowThreshold` | 25000 | Spill trigger |
| `justybase.results.diskBackedResults.rowThreshold` | 500000 | Upper spill bound |

See also: [EXECUTION_CONTRACT.md](./EXECUTION_CONTRACT.md) (disk-backed spill contract).

## Implementation map

| Area | Path |
|------|------|
| Client filter UI | `media/resultPanel/filter.ts` |
| Database filter SQL | `src/results/databaseFilterSql.ts` |
| Disk filter SQL | `src/core/resultDataProvider/diskQueryBuilder.ts` |
| Shared filter helpers | `src/core/resultDataProvider/columnFilterShared.ts` |
| Webview DB filter RPC | `media/resultPanel/databaseFilters.ts` |
| Disk grid queries | `media/resultPanel/diskBackedGrid.ts` |
