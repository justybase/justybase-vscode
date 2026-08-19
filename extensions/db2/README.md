# JustyBase SQL Editor for Db2 LUW

Read the [canonical documentation portal](https://justybase.github.io/justybase-vscode/guide/reference/database-support/) for the Db2 capability matrix and [Getting started guide](https://justybase.github.io/justybase-vscode/guide/user/getting-started/).

![JustyBase SQL Editor for Db2 LUW](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/marketplace-hero.png)

**Db2 LUW connections, SQL authoring, metadata, explain plans, and maintenance tools inside VS Code.**

This companion extension adds Db2 LUW runtime support to [JustyBase SQL Editor](../../README.md). VS Code installs the core extension automatically; Netezza is not required.

[![Marketplace](https://vsmarketplacebadges.dev/version/krzysztof-d.justybaselite-db2.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=krzysztof-d.justybaselite-db2) · [Db2 documentation](../../docs/db2.md)

## Db2 workflow in one workspace

![Db2 workspace with schema browser, SQL editor, and results](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/workspace-overview.png)

Connect to a Db2 LUW database, browse `SYSCAT` metadata, write SQL, execute it, and inspect results without switching applications.

## What you get

- Db2 LUW connection profile with `currentSchema`, SSL, connect timeout, and UTF-8 `ClientCodepage=1208` by default.
- Native `ibm_db` runtime with streaming results and cancellation.
- Metadata for tables, views, nicknames, aliases, procedures, functions, indexes, constraints, partitions, and comments.
- Db2-aware completion, hover information, semantic highlighting, snippets, and parser-backed diagnostics.
- Quality rules **DB2001–DB2008** for common Db2 SQL problems.
- DDL extraction, explain-plan graph, tuning advisor, session monitor, `RUNSTATS`, `REORG`, and index/partition helpers.

### Write safer Db2 SQL

![SQL validation and assisted correction in JustyBase](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/sql-validation-and-copilot.png)

The Db2 authoring profile understands LUW syntax and keeps completion and diagnostics close to the active connection. Use the shared result grid, formatter, query history, and Copilot workflows alongside Db2-specific validation.

### Investigate results visually

![Query result explorer with profiles and summaries](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-explorer.png)

Profile columns, inspect distributions and nulls, filter and sort rows, export data, and turn result sets into charts.

![Interactive query result chart](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-chart.png)

## Getting started

1. Install **JustyBase SQL Editor (Db2)** from the VS Code Marketplace.
2. Open the **JustyBase** view and choose **Connect**.
3. Select **Db2 LUW**, enter the host, port, database, user, and password.
4. Optionally set the current schema, SSL options, and connection timeout.
5. Open a `.sql` file and run the statement or selection with `Ctrl+Enter` / `F5`.

The saved password is handled by VS Code Secret Storage. Do not put Db2 credentials in SQL files or settings committed to source control.

## Platform support

The published VSIX contains the platform-specific `ibm_db` / clidriver runtime:

- Windows x64
- Linux x64
- macOS Apple Silicon

Install the VSIX matching the operating system and architecture running VS Code. No separate Netezza extension or ODBC registration is needed.

## Development and verification

From the repository root:

```bash
npm run install:db2
npm run db2:runtime:napi
npm run test:db2:integration
npm run verify:db2
```

Live database tests use `DB2_LIVE_TEST_*` variables. Optional VS Code Extension Host coverage is available with `DB2_VSCODE_TEST_VERSION=stable npm run test:db2:vscode-runtime`.

## Capability snapshot

| Area | Db2 LUW support |
| --- | --- |
| Connections and cancellation | Native `ibm_db`, streaming |
| Schema browser | Tables, views, nicknames, aliases, routines, keys, partitions |
| SQL intelligence | Db2 parser, completion, snippets, semantic tokens, DB2001–DB2008 |
| Explain and tuning | Explain graph and tuning advisor |
| Maintenance | `RUNSTATS`, `REORG`, indexes, partitions |
| Netezza-only features | Hidden when a Db2 connection is active |

## License

Apache-2.0. The Marketplace VSIX includes `THIRD_PARTY_NOTICES.md`.
