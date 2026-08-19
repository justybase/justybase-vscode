# JustyBase SQL Editor for Microsoft SQL Server

Read the [canonical documentation portal](https://justybase.github.io/justybase-vscode/guide/reference/database-support/) for the MS SQL Server capability matrix and shared SQL workflows.

![JustyBase SQL Editor for Microsoft SQL Server](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/marketplace-hero.png)

**A focused T-SQL workspace for Microsoft SQL Server, built into VS Code.**

This companion extension adds SQL Server connectivity and the MSSQL authoring profile to [JustyBase SQL Editor](../../README.md). The core extension is installed automatically; Netezza is not required.

[![Marketplace](https://vsmarketplacebadges.dev/version/krzysztof-d.justybaselite-mssql.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=krzysztof-d.justybaselite-mssql)

## Explore, write, and review T-SQL

![SQL workspace with schema browser, editor, and results](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/workspace-overview.png)

Use one workspace for databases, schemas, tables, views, procedures, functions, queries, and result sets.

## SQL Server features

- SQL Server connection profile with the shared JustyBase login and secret-storage flow.
- `mssql` runtime with streaming result readers and cancellation of active requests.
- Metadata browsing for databases, schemas, tables, views, procedures, functions, and columns.
- Dedicated T-SQL parser runtime with completion, hover, semantic tokens, snippets, and **MSS001–MSS008** quality rules.
- Authoring support for `TOP`, `OFFSET … FETCH`, `APPLY`, `TRY … CATCH`, temporary tables, and SQL Server-specific syntax.
- DDL generation for tables and supported object types.

### Catch issues before execution

![T-SQL validation and Copilot-assisted correction](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/sql-validation-and-copilot.png)

Parser-backed diagnostics and metadata-aware completion help with object names, aliases, types, and common T-SQL patterns. GitHub Copilot can explain or revise a query while execution stays under your control.

### Inspect and communicate results

![Result explorer with profiles and summaries](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-explorer.png)

Filter and sort result grids, profile columns, export data, and visualize trends directly in VS Code.

![Interactive result chart](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-chart.png)

## Quick start

1. Install **JustyBase SQL Editor (MS SQL Server)**.
2. Open the **JustyBase** view and select **Connect**.
3. Choose **Microsoft SQL Server**, then enter server, port, database, authentication, and credentials.
4. Open a `.sql` file and run the current statement or selection with `Ctrl+Enter` / `F5`.

The extension uses the shared connection form and VS Code Secret Storage. Keep passwords and tokens out of project files.

## Runtime notes

- Large query results are read row by row through `request.stream`.
- Cancelling a query aborts the active request without discarding the connection pool.
- Schema browsing concentrates on user databases and catalog objects suitable for the explorer.
- The SQL Server parser and snippets are provided by the core extension and activate for an MSSQL connection.

## Development and live tests

From the repository root, with a reachable SQL Server:

```bash
npm run install:mssql
npm run test:mssql:integration
```

Set `MSSQL_LIVE_TEST_HOST`, `MSSQL_LIVE_TEST_PORT`, `MSSQL_LIVE_TEST_DATABASE`, `MSSQL_LIVE_TEST_USER`, and `MSSQL_LIVE_TEST_PASSWORD` locally. Never commit these values.

For a package build:

```bash
cd extensions/mssql
npm install
npm run check-types
npm run build
```

## License

Apache-2.0. The Marketplace VSIX includes `THIRD_PARTY_NOTICES.md`.
