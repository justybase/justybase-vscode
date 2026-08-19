# JustyBase SQL Editor for PostgreSQL

Read the [canonical documentation portal](https://justybase.github.io/justybase-vscode/guide/reference/database-support/) for the PostgreSQL capability matrix and shared SQL workflows.

![JustyBase SQL Editor for PostgreSQL](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/marketplace-hero.png)

**A PostgreSQL-aware SQL workspace for schema exploration, queries, plans, and data workflows in VS Code.**

This companion extension adds PostgreSQL connectivity to [JustyBase SQL Editor](../../README.md). The core extension is installed automatically; Netezza is not required.

[![Marketplace](https://vsmarketplacebadges.dev/version/krzysztof-d.justybaselite-postgresql.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=krzysztof-d.justybaselite-postgresql)

## PostgreSQL work in one place

![PostgreSQL workspace with schema browser, editor, and results](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/workspace-overview.png)

Browse schemas and routines, write SQL, run it, and investigate the output in the shared JustyBase workspace.

## Features

- Pure JavaScript `pg` runtime for query execution and cancellation.
- Metadata for schemas, tables, views, sequences, functions, procedures, and columns.
- PostgreSQL authoring profile with completion, diagnostics, snippets, semantic context, and types.
- DDL generation for tables, views, routines, and sequences.
- PostgreSQL `COPY` import for CSV, XLSX, and XLSB data.
- `EXPLAIN (FORMAT JSON)` parsing and shared tuning-advisor scaffolding.

### Write with database context

![PostgreSQL validation and assisted SQL correction](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/sql-validation-and-copilot.png)

Completion and diagnostics use the active database metadata. Copilot can help explain or improve SQL while you keep control of the final query.

### Understand the output

![PostgreSQL result explorer](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-explorer.png)

Profile columns, inspect distributions, filter rows, export results, and create charts.

![PostgreSQL result chart](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-chart.png)

## Get started

1. Install **JustyBase SQL Editor (PostgreSQL)**.
2. Open the **JustyBase** view and choose **Connect**.
3. Select **PostgreSQL**, enter host, port, database, user, and password.
4. Run SQL with `Ctrl+Enter` / `F5`.

Each connection targets one PostgreSQL database. Create another saved profile to work with a different database. System schemas such as `pg_catalog` and `information_schema` are intentionally omitted from the explorer.

## Runtime notes

The explain viewer normalizes PostgreSQL JSON plans. Tuning advice is heuristic and focuses on scans, join shape, planner cost, and row-estimate drift. Generic `DROP SESSION <pid>` compatibility maps to `pg_terminate_backend(pid)` when permissions allow it.

## Development and packaging

```bash
cd extensions/postgresql
npm install
npm run check-types
npm run build
npm run package
```

## License

Apache-2.0. The Marketplace VSIX includes `THIRD_PARTY_NOTICES.md`.
