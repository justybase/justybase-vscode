# JustyBase SQL Editor for Snowflake

Read the [JustyBase documentation portal](https://justybase.github.io/justybase-vscode/guide/) for the shared SQL workflows and current capability boundaries.

![JustyBase SQL Editor for Snowflake](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/marketplace-hero.png)

**Explore cloud data, author Snowflake SQL, review query plans, and prepare staged data workflows in VS Code.**

This companion extension adds Snowflake connectivity to [JustyBase SQL Editor](../../README.md). The core extension is installed automatically; Netezza is not required.

[![Marketplace](https://vsmarketplacebadges.dev/version/krzysztof-d.justybaselite-snowflake.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=krzysztof-d.justybaselite-snowflake)

## Snowflake in a familiar SQL workspace

![Snowflake workspace with schema browser, editor, and results](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/workspace-overview.png)

Use the shared connection panel, schema explorer, SQL editor, result grid, and query-analysis tools while keeping Snowflake account settings in the connection profile.

## Features

- Dedicated Snowflake SQL authoring profile.
- Explorer coverage for databases, schemas, tables, views, procedures, functions, stages, streams, tasks, file formats, sequences, and warehouses.
- `GET_DDL(...)`-based DDL generation.
- `EXPLAIN USING JSON` parsing, query profile tooling, and shared plan visualization.
- Staged import/export guidance for CSV, TXT, and Excel workflows.
- Streaming result and shared result-analysis workflows.

### Author and review SQL

![Snowflake SQL validation and assisted correction](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/sql-validation-and-copilot.png)

Use metadata-aware SQL assistance, then inspect results with filtering, profiling, exports, and charts.

![Snowflake result explorer](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-explorer.png)

![Snowflake result chart](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-chart.png)

## Connect to Snowflake

1. Install **JustyBase SQL Editor (Snowflake)**.
2. Open **Connect** from the JustyBase view.
3. Enter account/host, database, user, authentication, warehouse, role, and optional schema.
4. Open a SQL file and run statements with `Ctrl+Enter` / `F5`.

The form supports password, OAuth, external browser/SSO, key-pair authentication, private-key passphrases, access URLs, and session parameters. Values can reference local environment variables with `env:VAR`, `$VAR`, or `${VAR}`. Never commit credentials or keys.

## Import and export boundaries

- CSV and TXT imports produce inferred DDL plus `COPY INTO <table>` guidance.
- Excel imports produce schema and staging guidance; Snowflake does not load workbooks directly.
- Exports generate reviewable `COPY INTO @stage FROM <table>` scripts.
- Snowflake stages, warehouses, roles, and cloud credentials remain under your account's permissions and policies.

## Development and integration testing

```bash
cd extensions/snowflake
npm install snowflake-sdk
npm run lint
npm run check-types
npm run build
```

Opt into live tests with `RUN_SNOWFLAKE_INTEGRATION=1 npm run test:snowflake:integration`.

## License

Apache-2.0. The Marketplace VSIX includes `THIRD_PARTY_NOTICES.md`.
