# JustyBase SQL Editor for Netezza

![JustyBase SQL Editor for Netezza in VS Code](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/marketplace-hero.png)

**A professional, zero-configuration SQL workspace for IBM Netezza and PureData System for Analytics — directly inside VS Code.**

Connect without installing an ODBC driver, write and validate Netezza SQL, explore query results, browse schemas, and manage warehouse workflows from one familiar editor.

[![Release](https://github.com/justybase/justybase-vscode/actions/workflows/release.yml/badge.svg?branch=master)](https://github.com/justybase/justybase-vscode/actions/workflows/release.yml)
[![Marketplace](https://vsmarketplacebadges.dev/version/krzysztof-d.justybaselite-netezza.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=krzysztof-d.justybaselite-netezza)

[Marketplace](https://marketplace.visualstudio.com/items?itemName=krzysztof-d.justybaselite-netezza) · [Publisher](https://marketplace.visualstudio.com/publishers/krzysztof-d)

## Why JustyBase?

- **Connect in minutes** — the core extension includes a pure JavaScript/TypeScript Netezza driver, so no IBM ODBC installation is required.
- **Work with database context** — browse databases, schemas, tables, views, procedures, sequences, columns, keys, and object definitions from the Schema Browser.
- **Write safer SQL** — use Netezza-aware completion, hover information, formatting, snippets, semantic highlighting, and parser-backed diagnostics while you work.
- **Go from query to insight** — inspect results, profile columns, build pivots, explore time-based data, export to Excel or Parquet, and keep useful queries in history.

## Get started in 60 seconds

1. Install **JustyBase SQL Editor (Netezza)** from the VS Code Extensions view.
2. Open the **JustyBase** view in the Activity Bar and select **Connect**.
3. Enter the Netezza host, user, password, and database.
4. Open or create a `.sql` file and run the current statement or selection with `Ctrl+Enter` / `F5`.

No external Netezza driver is required for the core extension.

## See it in action

### One workspace for SQL, schemas, and results

![JustyBase workspace with Schema Browser, SQL editor, and query results](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/workspace-overview.png)

Browse database objects, write SQL, and inspect results without leaving VS Code.

### Netezza-aware SQL authoring

![Netezza SQL validation with Copilot-assisted correction](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/sql-validation-and-copilot.png)

Completion, semantic context, snippets, formatting, and parser-backed diagnostics help catch mistakes before execution.

### Explore results instead of writing another query

![Query result exploration with profiles, distributions, and summaries](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-explorer.png)

Inspect types, cardinality, distinct values, null counts, summaries, distributions, pivots, and time-based views.

### Visualize results inside VS Code

![Interactive query result chart in JustyBase](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-chart.png)

Turn result sets into interactive charts and compare patterns without leaving the SQL workspace.

### Build queries visually

![Visual Query Builder with joined sources, selected columns, filter and sort controls, and SQL preview](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/visual_query_builder.png)

Compose multi-table `SELECT` queries by dragging tables or views onto a canvas, connecting columns to create joins, selecting fields, and adding filters, sorting, aggregates, `GROUP BY`, `HAVING`, and `LIMIT` clauses. Open the generated SQL in the editor, copy it, or run it immediately.

Read the [Visual Query Builder guide](docs/VISUAL_QUERY_BUILDER.md) for the complete workflow.

### Use AI with explicit control

![AI-assisted SQL correction in JustyBase](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/copilot-chat.png)

Use GitHub Copilot to explain, fix, optimize, or generate SQL while keeping the final decision and execution in your hands.

### Move data between databases

![Migration Studio for streaming Netezza results into another database](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/migration-studio.png)

Stream a table or SQL result into another database with an explicit source, target, column mapping, and execution plan.

### Monitor database activity

![Session Monitor dashboard with active sessions, resource usage, and running queries](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/session_monitor.png)

Inspect active sessions, running queries, host and SPU utilization, memory, and query details from a single dashboard, with controls for refreshing the view and stopping a session.

## Core workflows

### Query and validate

- Run a statement, selection, or multi-statement batch with progressive results.
- Cancel long-running queries and recover from broken connections.
- Switch database and connection per SQL tab.
- Format SQL with `Shift+Alt+F` and inspect explain plans with `Ctrl+L`.
- Get real-time SQL and Netezza diagnostics for unknown objects, ambiguous references, invalid types, unsafe patterns, and NZPLSQL issues.

Read the [Query Execution & Analysis Guide](docs/QUERY_EXECUTION.md) and [SQL Linter Reference](docs/SQL_LINTER.md).

### Explore, filter, and export data

- Filter and sort result grids, select cells, view rows, and compare multiple result sets.
- Explore column profiles, distributions, distinct values, summaries, pivots, and time-based compositions.
- Export to XLSB/XLSX, CSV, JSON, XML, SQL `INSERT`, Markdown, and Apache Parquet.
- Open Parquet, Excel, and `.nzpreview` files in the built-in data previewer.

See the [SQL Results Filtering guide](docs/SQL_RESULTS_FILTERING.md) and [Export & Import Reference](docs/EXPORT_IMPORT.md).

### Develop and maintain Netezza objects

- Generate DDL for tables, views, and procedures.
- Create and validate NZPLSQL procedures with procedure-aware diagnostics.
- Compare table structures and procedure definitions.
- View and edit table data with safeguards.
- Run GROOM, generate statistics, inspect data skew, manage constraints, and maintain object comments.
- Generate ERDs for schemas and build repeatable visual ETL workflows.

### Work with files through SQL

Install the optional [DuckDB + Files pack](extensions/duckdb), open **Data Workspace Manager**, and create a persistent DuckDB workspace. Add one local Excel/CSV/TSV/Parquet/Access (`.mdb` or `.accdb`) file or several files as sources, then query the materialized tables with SQL. For XLSX, CSV/TSV, and Access sources, **Edit source** opens a separate editor for the original file; save it first, then use **Refresh** to rematerialize the local table. Parquet, Avro, and Netezza sources remain read-only. Access sources are read-only in the DuckDB File SQL dialect; the same workspace can also materialize saved Netezza tables, views, and read-only `SELECT`/`WITH` queries.

For quick inspection, the existing **Open in Data File Preview** action remains available from the Explorer for CSV and Excel files. The preview includes **Add to Data Workspace**, which lets you choose a new or existing workspace.

Install the optional [Microsoft Access pack](extensions/access) to query and edit `.mdb` and `.accdb` files through the native TypeScript reader and embedded DuckDB mirror. No Java runtime or JAR is required.

Read the [File SQL guide](docs/file-sql.md) and [Access guide](extensions/access/README.md).

### Use AI and read-only schema tools

The optional AI workflows integrate with GitHub Copilot Chat and can:

- explain, fix, optimize, rewrite, and generate SQL;
- inspect schema, columns, tables, DDL, plans, diagnostics, and table statistics;
- analyze procedures locally before you compile or run them manually;
- expose a read-only Netezza MCP server for Copilot Chat, Cursor, Claude Desktop, OpenCode, and other MCP clients.

AI features transmit SQL, schema information, selected metadata, and limited query history to external Microsoft/GitHub services. Privacy confirmations are shown before transmission and AI features can be disabled with `justybase.copilot.enabled`.

Read the [Copilot SQL Assistant guide](docs/COPILOT_SQL_ASSISTANT.md), [MCP Server guide](docs/MCP_SERVER.md), and [Procedure Compilation guide](docs/PROCEDURE_COMPILATION.md).

## SQL notebooks, history, and reusable workflows

- **SQL Notebooks** — execute SQL cells with inline results in `.sqlnb` or `.nzsql-nb` files. See [Notebooks](docs/NOTEBOOKS.md).
- **Query History** — search, filter, tag, favorite, parameterize, and export previously executed queries.
- **Favorites and snippets** — save tables, views, procedures, and parameterized SQL snippets; sync favorites through `.vscode/netezza-favorites.json`.
- **SAS-like macros** — use `%let`, `%if/%do/%end`, `%export`, `%include`, `%python`, `%SQL`, `%SQLLIST`, and related workflow helpers. See [SAS-like macros](docs/macros/sas-like-macros.md).
- **File Search** — search and replace across SQL and Python files with comment/string-aware modes.

## Optional database support

The core extension is Netezza-first. Optional packs plug into the shared connection panel, Schema Browser, query runner, result grid, and export workflows. SQL editor depth varies by dialect.

| Database | Package | Notes |
| --- | --- | --- |
| Oracle | [Oracle support pack](extensions/oracle) | Dedicated SQL/PL/SQL parser and advanced workflows |
| PostgreSQL | [PostgreSQL support pack](extensions/postgresql) | Dedicated parser, metadata, DDL, COPY, and explain tooling |
| Db2 LUW | [Db2 support pack](extensions/db2) | Dedicated parser, maintenance, and quality rules |
| DuckDB / File SQL | [DuckDB + Files pack](extensions/duckdb) | Local Excel, CSV, Parquet, and Avro workflows |
| MySQL, MS SQL, Snowflake, Vertica | Separate optional packs | Companion runtimes with varying editor depth |

See the [Editor Capability Matrix](docs/EDITOR_CAPABILITY_MATRIX.md) for current parity details.

## Requirements

- VS Code `1.103.2` or newer.
- No external Netezza driver for the core extension.
- The Microsoft Access pack uses the Node.js runtime supplied by VS Code; no Java runtime is required.
- Optional database packs may require their own native or JavaScript driver package.

## Support

- [Report an issue](https://github.com/justybase/justybase-vscode/issues)
- [Browse the documentation](docs/)
- [Read the release process](docs/RELEASE_PROCESS.md)

## License

Apache-2.0

<details>
<summary>For contributors and maintainers</summary>

The repository uses esbuild for bundling and Jest for tests. The standard validation flow is:

```bash
npm install
npm run check-types
npm run lint
npm run build
npm run test:validate
```

Optional support packs live under `extensions/`. Their build, test, and packaging commands are documented in the relevant pack README files. Version synchronization is managed by the repository workflow; do not use `npm version` locally.

See [Release Process](docs/RELEASE_PROCESS.md), [Dialect Development](docs/DIALECT_DEVELOPMENT.md), and [Metadata Cache Contract](docs/METADATA_CACHE_CONTRACT.md).

</details>
