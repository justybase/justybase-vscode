# JustyBase PostgreSQL Support

Optional PostgreSQL Support for JustyBase Core.

This extension adds a `PostgreSQL` dialect to the JustyBase Core extension and integrates with the shared connection UI, schema browser, SQL execution flow, and dialect registry.

## Requirements

- Install the core extension first: `JustyBase Core`
- VS Code Desktop
- Network access to your PostgreSQL server
- Install runtime dependencies in this package before packaging:

```powershell
Set-Location extensions\postgresql
npm install
```

## What This Extension Adds

- PostgreSQL connection type in the shared login panel
- `pg`-based pure JavaScript runtime for query execution and cancellation
- PostgreSQL metadata queries for schemas, tables, views, sequences, functions, procedures, and column lookup
- First-class PostgreSQL SQL authoring profile for shared completion/diagnostics
- DDL generation for tables, views, routines, and sequences in the connected database
- PostgreSQL `COPY` import flow for CSV/XLSX/XLSB ingestion
- `EXPLAIN (FORMAT JSON)` parsing and shared tuning-advisor scaffolding

## Current Runtime Notes

- Each connection is scoped to a single PostgreSQL database. To browse another database, create a separate saved connection for that database.
- Schema browsing intentionally excludes PostgreSQL system schemas such as `pg_catalog` and `information_schema`.
- The explain command normalizes PostgreSQL JSON plans into the shared explain viewer.
- Tuning advice is heuristic and currently focuses on scans, join shape, planner cost, and row-estimate drift.
- Generic `DROP SESSION <pid>` compatibility is translated to `pg_terminate_backend(pid)` when permissions allow it.

## Development

```powershell
Set-Location extensions\postgresql
npm run check-types
npm run build
```

## Packaging

```powershell
Set-Location extensions\postgresql
npm install
npm run package
```
