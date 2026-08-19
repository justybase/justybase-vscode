# JustyBase SQL Editor for Oracle

Read the [canonical documentation portal](https://justybase.github.io/justybase-vscode/guide/reference/database-support/) for the Oracle capability matrix and shared SQL workflows.

![JustyBase SQL Editor for Oracle](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/marketplace-hero.png)

**Oracle SQL and PL/SQL, metadata, DDL, explain plans, and data workflows inside VS Code.**

This companion extension connects [JustyBase SQL Editor](../../README.md) to Oracle Database. VS Code installs the core extension automatically; Netezza is not required.

[![Marketplace](https://vsmarketplacebadges.dev/version/krzysztof-d.justybaselite-oracle.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=krzysztof-d.justybaselite-oracle) · [Oracle documentation](../../docs/oracle.md)

## Oracle work, from connection to insight

![Oracle workspace with schema browser, SQL editor, and results](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/workspace-overview.png)

Browse schemas and Oracle objects, edit SQL or PL/SQL, execute statements, and review results in the same VS Code workspace.

## What this pack adds

- `node-oracledb` in thin mode, so the baseline connection does not need Oracle Instant Client.
- Easy Connect strings (`host:port/service`), optional TNS aliases, wallets, and Oracle Net configuration directories.
- Metadata for schemas, tables, views, procedures, functions, packages, triggers, sequences, synonyms, constraints, and columns.
- DDL and migration extraction through `DBMS_METADATA.GET_DDL`, with catalog fallbacks for supported objects.
- Oracle type-aware import/export, `DBMS_STATS` and table-maintenance helpers, session monitor, explain graph, and tuning advisor.
- Oracle parser, PL/SQL-aware validation, completion, hover, semantic tokens, snippets, and **ORA001–ORA004** quality rules.

### SQL and PL/SQL assistance

![Oracle SQL validation and assisted correction](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/sql-validation-and-copilot.png)

The core authoring layer recognizes Oracle SQL, anonymous PL/SQL blocks, packages, and triggers. Metadata-aware completion and diagnostics use the active Oracle connection.

### Explain plans and result analysis

![Query result explorer with profiles and summaries](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-explorer.png)

Use the shared result grid to profile columns, inspect distributions, export data, and create charts.

![Interactive result chart](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-chart.png)

Explain uses `EXPLAIN PLAN FOR` and `DBMS_XPLAN` to populate the shared plan viewer. The tuning advisor applies Oracle-oriented heuristics to the normalized plan.

## Connect in a minute

1. Install **JustyBase SQL Editor (Oracle)**.
2. Open the **JustyBase** view and choose **Connect**.
3. Select **Oracle**, enter the service name and credentials, and optionally provide a full connect-string override.
4. Set `currentSchema`, wallet/TNS options, or session settings when needed.
5. Open a `.sql` file and run the statement or selection with `Ctrl+Enter` / `F5`.

Passwords are stored through VS Code Secret Storage. Keep wallet paths and credentials in local configuration only.

## Runtime boundaries

- `SET CATALOG` is emulated for core compatibility and does not switch to another Oracle service.
- Netezza-only features such as GROOM, distribution metrics, and NZPLSQL tooling are not shown for Oracle connections.
- Advanced PL/SQL object-type, cursor, and record semantics remain outside the supported parser surface.

## Development and integration tests

```bash
npm run install:oracle
npm run test:oracle:integration
```

Live tests use `ORACLE_LIVE_TEST_HOST`, `ORACLE_LIVE_TEST_DATABASE`, `ORACLE_LIVE_TEST_USER`, and `ORACLE_LIVE_TEST_PASSWORD`; port defaults to `1521`. For a local build:

```bash
cd extensions/oracle
npm install
npm run check-types
npm run build
```

## License

Apache-2.0. The Marketplace VSIX includes `THIRD_PARTY_NOTICES.md`.
