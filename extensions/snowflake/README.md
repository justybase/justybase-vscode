# Snowflake Tools (justybase)

Optional Snowflake support for Netezza SQL Tools (justybase).

## Purpose and status

This package is the first-class Snowflake optional runtime for JustyBase. It keeps the cloud SDK and account-specific runtime behavior out of the core extension while still plugging into the shared connection UI, schema explorer, metadata cache, LSP, DDL, import/export, and query-analysis workflows.

Current highlights:

- dedicated Snowflake SQL authoring profile
- schema explorer coverage for databases, schemas, tables, views, procedures, functions, stages, streams, tasks, file formats, sequences, and warehouses
- `GET_DDL(...)`-based DDL generation
- `EXPLAIN USING JSON` parsing and recent query profile tooling
- staged Snowflake import and export workflow generation

## Requirements

- install the core extension first: `Netezza SQL Tools (justybase)`
- VS Code Desktop
- network access to your Snowflake account
- for real runtime connectivity or packaging, install the pure-JavaScript Snowflake driver inside this package:

```bash
cd extensions/snowflake
npm install snowflake-sdk
```

## Build and install

Development build:

```bash
cd extensions/snowflake
npm run lint
npm run check-types
npm run build
```

From the repository root you can also run:

```bash
npm run build:snowflake
```

To package the extension after installing the runtime dependency:

```bash
cd extensions/snowflake
npm run package
```

## Runtime and dependency notes

- this optional extension does not bundle native binaries
- the intended runtime dependency is `snowflake-sdk`, which stays outside the core bundle
- do not commit Snowflake credentials into the repository
- the core extension stores saved credentials in VS Code secret storage; use that flow instead of hard-coding passwords, tokens, private keys, or account identifiers

## Credential guidance

Use the shared JustyBase connection form to supply connection details at runtime. The Snowflake dialect exposes fields for:

- host or account locator
- port
- database
- user
- password
- optional schema
- authentication mode
- optional warehouse
- optional role
- optional OAuth token
- optional private key path and passphrase
- optional authenticator
- optional explicit account override
- optional access URL
- optional session parameters

Environment-backed options are supported with `env:VAR_NAME`, `$VAR_NAME`, or `${VAR_NAME}`.

If you use external browser, SSO, key pair authentication, or organization-level settings, keep those values in local environment-specific configuration only.

## Import and export behavior

Snowflake imports are staged-load workflows, not direct local uploads.

- CSV and TXT imports generate inferred DDL plus `COPY INTO <table>` guidance with inline file format options
- Excel imports generate schema and staging guidance, but not executable `COPY INTO` SQL, because Snowflake does not load Excel workbooks directly
- shared import entry points in the core extension now surface Snowflake-specific workflow guidance instead of generic unsupported messages
- export helpers generate `COPY INTO @stage FROM <table>` scripts for review and execution

## Live integration testing

Opt in explicitly with:

```bash
RUN_SNOWFLAKE_INTEGRATION=1 npm run test:snowflake:integration
```

`SNOWFLAKE_LIVE_TEST_ENABLED=1` is still accepted for backward compatibility, but `RUN_SNOWFLAKE_INTEGRATION` is the preferred flag.

See [../../docs/snowflake.md](../../docs/snowflake.md) for the fuller implementation notes, test strategy, and cost guidance.

## Enabling or disabling the optional extension

To enable Snowflake support:

1. install `Netezza SQL Tools (justybase)`
2. install or launch this Snowflake support extension
3. reload VS Code if needed so the optional dialect registers on startup

To disable Snowflake support:

- disable or uninstall `Snowflake Tools (justybase)` in VS Code, or
- remove the `extensions/snowflake` package from your development workspace when testing the core extension without Snowflake
