# JustyBase SQL Editor (DuckDB + Files)

Optional DuckDB support for JustyBase SQL Editor (Netezza) — including **File SQL**: query Excel (`.xlsx`), CSV/TSV (`.csv`/`.tsv`), Parquet (`.parquet`) and Avro (`.avro`) files with SQL through an in-memory DuckDB.

This extension adds the `DuckDB` and `File` dialects to JustyBase SQL Editor (Netezza) and integrates with the shared connection UI, schema browser, SQL execution flow, and dialect registry.

## Requirements

- Install the core extension first: `JustyBase SQL Editor (Netezza)`
- VS Code Desktop
- DuckDB is an embedded database, so no separate server is required. The extension uses the `@duckdb/node-api` package to interact with DuckDB.

## Runtime Model

`JustyBase SQL Editor (DuckDB + Files)` uses `@duckdb/node-api` to interact with DuckDB:

- DuckDB is an in-process SQL OLAP database management system.
- The extension allows you to query DuckDB databases (files) or in-memory databases.
- Connection strings can be a file path to a DuckDB database file or special strings like `:memory:` for an in-memory database.

## What This Extension Adds

- DuckDB connection type in the shared JustyBase connection UI
- **File SQL connection type** — query Excel/CSV/Parquet/Avro files with SQL:
  - Open the connection from the login panel (`Excel / CSV / Parquet / Avro (DuckDB)`), or
  - Right-click any `.xlsx`/`.csv`/`.tsv`/`.parquet`/`.avro` file in the Explorer → **Query File with SQL (DuckDB)**
  - The file appears as a table in the schema browser (columns, completion, hover all work)
  - Excel files expose one view per discovered sheet (`<file>__<sheet>`) plus `<file>` for the first sheet
  - CSV/TSV/Parquet are read by DuckDB's built-in readers; XLSX and Avro use DuckDB extensions (`excel`, `avro`) that are downloaded once from the internet on first use
- **Multi-file SQL workspace** — run **Query Multiple Files with SQL (DuckDB)**, select several local data files, and join them in one read-only in-memory DuckDB session. Each source is exposed as a view named by its full path, for example `FROM "/data/orders.csv"`; XLSX sheets are exposed as `"/data/book.xlsx#sheet=Orders"`. Workspaces are saved as connection profiles and can be reopened with **Open Saved File SQL Workspace**. To add another file later, run **Add Files to Active File SQL Workspace (DuckDB)** from the Command Palette, Explorer, or the context menu of a File SQL `VIEW` node in Schema Explorer.
- **Editing data files**: enable *Editable copy* on the connection to materialize an editable table (`<file>_edit`) that supports `INSERT`/`UPDATE`/`DELETE` (DuckDB views are read-only). After editing, run **JustyBase: Save File Edits** to write the changes back with `COPY TO` — CSV/TSV/Parquet/XLSX are overwritten in place; Avro is exported to a new Parquet file next to the original.
- DuckDB runtime integration via `@duckdb/node-api`
- Metadata queries for schemas, tables, views, and sequences
- DuckDB column lookup based on DuckDB's system tables
- Strict DuckDB SQL authoring profile with a dedicated Chevrotain parser, completion, signatures, types, quality rules, grammar and snippets
- Optional DDL extraction (if applicable)

## Current Runtime Notes

- The `database` field in the connection settings represents the path to the DuckDB database file (or `:memory:` for an in-memory database), or the data file path for File SQL connections.
- The File SQL connection opens an in-memory DuckDB and registers a read-only view over the data file. XLSX and AVRO extensions are downloaded once (requires internet); afterwards they work offline.
- A multi-file workspace registers one read-only view per selected file plus one view per discovered XLSX sheet. Source files are not copied or modified.
- The connection panel shows this workflow as **Excel / CSV / Parquet / Avro (DuckDB)** with a spreadsheet/file icon. It is distinct from a regular DuckDB database-file connection.
- Since DuckDB is embedded, there is no separate server to manage.
- Schema browsing focuses on object discovery and metadata lookup.
- Procedure discovery: DuckDB supports procedural SQL via extensions, but the core extension may not include advanced procedural features.

## Unsupported or Intentionally Deferred

- DuckDB-specific parser assets, grammar files, and snippets are bundled by the core extension and activated by the DuckDB authoring profile
- Advanced features include explain graph, tuning advisor, table maintenance and session monitoring
- Writing back to multiple source files is intentionally not supported. Export the query result to CSV/XLSX/Parquet instead; the existing single-file **Editable copy** workflow is unchanged.

## Installation Order

Marketplace or manual VSIX installation should end with both extensions installed:

1. Install `JustyBase SQL Editor (Netezza)`
2. Install `JustyBase SQL Editor (DuckDB)`

`JustyBase SQL Editor (DuckDB)` declares `extensionDependencies` on the core extension, so VS Code can resolve the dependency automatically in Marketplace scenarios.

## Development Notes

From `extensions\duckdb`:

```powershell
npm install
npm run check-types
npm run build
```

The extension bundle externalizes `@duckdb/node-api`, so the package must keep `node_modules\@duckdb\node-api` available at runtime.

## License and third-party software

This extension is licensed under Apache-2.0. Its Marketplace VSIX includes the full project license and a generated `THIRD_PARTY_NOTICES.md` covering locked runtime dependencies and their available license texts.
