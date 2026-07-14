# DuckDB Tools (justybase)

Optional DuckDB support for Netezza SQL Tools (justybase).

This extension adds the `DuckDB` dialect to Netezza SQL Tools (justybase) and integrates with the shared connection UI, schema browser, SQL execution flow, and dialect registry.

## Requirements

- Install the core extension first: `Netezza SQL Tools (justybase)`
- VS Code Desktop
- DuckDB is an embedded database, so no separate server is required. The extension uses the `@duckdb/node-api` package to interact with DuckDB.

## Runtime Model

`DuckDB Tools (justybase)` uses `@duckdb/node-api` to interact with DuckDB:

- DuckDB is an in-process SQL OLAP database management system.
- The extension allows you to query DuckDB databases (files) or in-memory databases.
- Connection strings can be a file path to a DuckDB database file or special strings like `:memory:` for an in-memory database.

## What This Extension Adds

- DuckDB connection type in the shared JustyBase connection UI
- DuckDB runtime integration via `@duckdb/node-api`
- Metadata queries for schemas, tables, views, and sequences
- DuckDB column lookup based on DuckDB's system tables
- Best-effort DuckDB SQL authoring profile
- Optional DDL extraction (if applicable)

## Current Runtime Notes

- The `database` field in the connection settings represents the path to the DuckDB database file (or `:memory:` for an in-memory database).
- Since DuckDB is embedded, there is no separate server to manage.
- Schema browsing focuses on object discovery and metadata lookup.
- Procedure discovery: DuckDB supports procedural SQL via extensions, but the core extension may not include advanced procedural features.

## Unsupported or Intentionally Deferred

- DuckDB-specific static parser assets, grammar files, and snippets are not bundled in this package
- Advanced features like explain graph, tuning advisor, and session monitor are not exposed in this extension

## Installation Order

Marketplace or manual VSIX installation should end with both extensions installed:

1. Install `Netezza SQL Tools (justybase)`
2. Install `DuckDB Tools (justybase)`

`DuckDB Tools (justybase)` declares `extensionDependencies` on the core extension, so VS Code can resolve the dependency automatically in Marketplace scenarios.

## Development Notes

From `extensions\duckdb`:

```powershell
npm install
npm run check-types
npm run build
```

The extension bundle externalizes `@duckdb/node-api`, so the package must keep `node_modules\@duckdb\node-api` available at runtime.
