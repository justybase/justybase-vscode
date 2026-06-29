# Snowflake Support

Snowflake support ships as a first-class optional extension in `extensions/snowflake`.

## What is included

- shared connection UI with Snowflake-specific fields for warehouse, role, auth mode, OAuth token, key-pair path, access URL, and session parameters
- optional `snowflake-sdk` runtime kept outside the core bundle
- dedicated Snowflake SQL authoring assets in `extensions/snowflake/src/sql` and traits in `src/shared/dialect-traits/snowflake.ts`
- schema explorer integration for databases, schemas, tables, views, procedures, functions, sequences, stages, streams, tasks, file formats, and warehouses
- metadata-aware completions through the shared `MetadataCache` and LSP metadata bridge
- DDL generation using `GET_DDL(...)` for core Snowflake object types
- `EXPLAIN USING JSON` parsing plus a recent-query profile viewer using `QUERY_HISTORY_BY_SESSION` and `GET_QUERY_OPERATOR_STATS`
- Snowflake stream/task draft wizards
- stage-based import/export helpers that generate `COPY INTO` workflows

## Packaging model

Keep Snowflake in the optional sibling package:

- the core extension stays database-agnostic and does not require cloud credentials
- `snowflake-sdk` remains a separate runtime dependency in `extensions/snowflake`
- no native binaries are introduced

## Local development

Install and verify from the repository root:

```bash
npm ci
npm run check-types
npm run check-types:snowflake
npm run test -- --testPathPatterns="snowflake|optionalDialects.unit.test.ts|wizardCommands.test.ts|importCommands.test.ts"
```

For the optional extension package itself:

```bash
cd extensions/snowflake
npm ci
npm run verify
```

## Connection and auth guidance

Recommended priority:

1. key pair (`SNOWFLAKE_JWT`) for automation
2. OAuth for delegated or centralized auth
3. username and password for local development

Supported helper behavior:

- option values may reference environment variables with `env:VAR_NAME`, `$VAR_NAME`, or `${VAR_NAME}`
- warehouse and role can be switched later from the command palette or schema explorer database node
- session parameters can be provided as `KEY=VALUE;QUERY_TAG=justybase`

Never commit passwords, OAuth tokens, or private keys.

## Import and export workflow

The extension does not attempt local `PUT` uploads because that would require SnowSQL or other external upload tooling outside the extension runtime.

### Shared Snowflake import behavior

Snowflake file and clipboard imports now return Snowflake-specific staged-load guidance across shared entry points instead of a generic unsupported-dialect error. This includes:

- the main import command flow
- schema drag/drop import surfaces
- Copilot import dry-run and execute flows

### File import behavior

For CSV and TXT inputs the generated workflow includes:

1. inferred table DDL with Snowflake type mapping
2. `CREATE TABLE IF NOT EXISTS`
3. `COPY INTO <table>` SQL with explicit column lists and inline `FILE_FORMAT = (TYPE = CSV ...)` options
4. step-by-step markdown guidance for staging and loading the file

For Excel inputs (`.xlsx`, `.xlsb`) the extension analyzes the workbook and generates table and staging guidance, but it does not emit executable `COPY INTO` SQL because Snowflake does not load Excel workbooks directly. Convert sheets to CSV, Parquet, or another Snowflake-supported staged format first.

### Export workflow

For export:

1. run `Snowflake: Prepare Stage Export`
2. review the generated `COPY INTO @stage FROM <table>` SQL
3. fetch staged files with your cloud tooling

IAM and ACL guidance:

- prefer storage integrations, IAM roles, service principals, or short-lived credentials
- avoid embedding long-lived secrets in stage URLs or repo files

## Query profile and tuning

Available commands:

- `Snowflake: Show Recent Query Profile`
- shared explain and tuning commands from the core extension

Behavior:

- explain uses `EXPLAIN USING JSON`
- recent profile inspection uses `INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION(...)`
- operator detail retrieval uses `GET_QUERY_OPERATOR_STATS('<query_id>')`

Cost note:

- Snowflake profiling and any statement execution can consume warehouse credits
- prefer a small dedicated validation warehouse for manual acceptance

## Opt-in integration testing

Live integration tests are intentionally gated and skipped unless you explicitly opt in with:

- `RUN_SNOWFLAKE_INTEGRATION=1`

Legacy compatibility is still supported with `SNOWFLAKE_LIVE_TEST_ENABLED=1`, but `RUN_SNOWFLAKE_INTEGRATION` is the preferred flag.

Required environment variables:

- `SNOWFLAKE_LIVE_TEST_ACCOUNT` or `SNOWFLAKE_LIVE_TEST_HOST`
- `SNOWFLAKE_LIVE_TEST_DATABASE`
- `SNOWFLAKE_LIVE_TEST_USER`
- `SNOWFLAKE_LIVE_TEST_PASSWORD`

Optional environment variables:

- `SNOWFLAKE_LIVE_TEST_PORT`
- `SNOWFLAKE_LIVE_TEST_WAREHOUSE`
- `SNOWFLAKE_LIVE_TEST_ROLE`
- `SNOWFLAKE_LIVE_TEST_SCHEMA`

Run manually:

```bash
RUN_SNOWFLAKE_INTEGRATION=1 npm run test:snowflake:integration
```

The live test currently validates:

- metadata discovery against the Snowflake account
- session context (`CURRENT_DATABASE`, `CURRENT_SCHEMA`, optional warehouse/role)
- schema discovery for the configured database without hard failures on restricted accounts
- parseable `EXPLAIN USING JSON` output
