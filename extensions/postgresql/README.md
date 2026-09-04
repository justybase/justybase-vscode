# JustyBase SQL Editor for PostgreSQL

Read the [JustyBase documentation portal](https://justybase.github.io/justybase-vscode/guide/), including the [PostgreSQL capability matrix](https://justybase.github.io/justybase-vscode/guide/reference/database-support/) and shared SQL workflows.

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
- Authenticated raw TCP tunnelling through an HTTPS/WSS server, using the
  core tunnel runtime for PostgreSQL and other TCP database dialects.

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

## HTTPS/WSS tunnel

TCP tunnelling is configured in the common **Add Connection** form. Enable
**Use HTTPS/WSS TCP tunnel** on a PostgreSQL profile and enter the relay base
URL, named target id, free local port, and bearer token. The core extension
starts the loopback listener lazily for **Test Connection** or the first query;
the token is kept in VS Code SecretStorage. The database password and
PostgreSQL SSL settings remain in the normal profile.

Use the shared FastAPI reference relay in
[`samples/database-tunnel`](../../samples/database-tunnel/). It supports
PostgreSQL, Netezza, Oracle, and other raw TCP targets through a server-side
allowlist. The full deployment, reverse-proxy, troubleshooting, and live-test
instructions are in [`docs/database-tunnel.md`](../../docs/database-tunnel.md).

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
