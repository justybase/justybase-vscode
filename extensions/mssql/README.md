# JustyBase MS SQL Server Support

Optional Microsoft SQL Server support for JustyBase Core (NetezzaSQL).

This extension adds the `MSSQL` dialect to JustyBase Core (NetezzaSQL) and integrates with the shared connection UI, schema browser, SQL execution flow, and dialect registry.

## Requirements

- Install the core extension first: `JustyBase Core (NetezzaSQL)`
- VS Code Desktop
- Network access to your Microsoft SQL Server instance

## What This Extension Adds

- Microsoft SQL Server connection type in the shared login panel
- MSSQL runtime integration via the `mssql` package with **streaming** result readers and cancel
- Metadata queries for databases, schemas, tables, views, procedures, functions, and column lookup
- Dedicated Chevrotain T-SQL parsing runtime (`MSSQL_SQL_PARSING_RUNTIME`) and **MSS001–MSS008** quality rules
- TextMate injection + snippets for TOP / OFFSET FETCH / APPLY / TRY CATCH
- DDL generation for tables and supporting object types where available

## Live integration tests

From the repository root, with a reachable SQL Server:

```bash
export MSSQL_LIVE_TEST_HOST=...
export MSSQL_LIVE_TEST_PORT=1433
export MSSQL_LIVE_TEST_DATABASE=...
export MSSQL_LIVE_TEST_USER=...
export MSSQL_LIVE_TEST_PASSWORD=...
npm run install:mssql
npm run test:mssql:integration
```

## Current Runtime Notes

- SQL Server authentication and connection options are provided through the shared connection form.
- Schema browsing focuses on user databases and catalog objects that are safe to expose in the explorer.
- Large query results stream row-by-row (`request.stream`); `cancel()` aborts the active request without discarding the pool.

## Installation Order

Marketplace or manual VSIX installation should end with both extensions installed:

1. Install `JustyBase Core (NetezzaSQL)`
2. Install `JustyBase MS SQL Server Support`

`JustyBase MS SQL Server Support` declares `extensionDependencies` on the core extension, so VS Code can resolve the dependency automatically in Marketplace scenarios.

## Development Notes

From `extensions\mssql`:

```powershell
npm install
npm run check-types
npm run build
```

The extension bundle externalizes `mssql`, so the package must keep `node_modules\mssql` available at runtime.

## License and third-party software

This extension is licensed under Apache-2.0. Its Marketplace VSIX includes the full project license and a generated `THIRD_PARTY_NOTICES.md` covering locked runtime dependencies and their available license texts.
