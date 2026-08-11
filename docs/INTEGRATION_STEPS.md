# Optional Dialect Integration Steps

This repository uses two integration models:

- built-in runtimes inside `src/dialects`
- optional sibling runtimes inside `extensions/<dialect>`

## PostgreSQL Checklist

Use PostgreSQL as the reference implementation for a first-class optional runtime:

1. Add traits and SQL authoring in `extensions/postgresql/src/dialect/` and `extensions/postgresql/src/sql/`
2. Register the runtime dialect from `extensions/postgresql/src/extension.ts`
3. Implement a `pg`-backed connection runtime without native dependencies
4. Map PostgreSQL metadata queries into the shared `MetadataCache` contract
5. Provide DDL, import type mapping, explain/tuning helpers, and reference guidance
6. Add unit tests plus optional integration coverage
7. Document packaging and docker-compose based validation

## Validation Commands

```bash
npm run check-types
npm run test -- --testPathPatterns="postgresql"
npm run verify:postgresql
```

## Oracle Checklist

The Oracle extension has a dedicated live suite at
`src/__tests__/integration/oracle.integration.test.ts`. Install the optional
runtime first, then provide the four required variables
`ORACLE_LIVE_TEST_HOST`, `ORACLE_LIVE_TEST_DATABASE`, `ORACLE_LIVE_TEST_USER`,
and `ORACLE_LIVE_TEST_PASSWORD` (optional `ORACLE_LIVE_TEST_PORT`, default
1521; optional `ORACLE_LIVE_TEST_CURRENT_SCHEMA` and connect-string overrides)
and run:

```bash
npm run install:oracle
npm run test:oracle:integration
npm run verify:oracle
```

The deep suite exercises:

- connection and compatibility shims (`CURRENT_CATALOG` / `CURRENT_SCHEMA` / `CURRENT_SID`)
- catalog/search metadata across table, view, procedure, function, package, trigger, sequence, synonym, index, and partition objects
- DDL extraction/generation for those object families plus schema-migration batch DDL, including disposable composite-index and partitioned-table fixtures
- live completion E2E (`LspCompletionEngine` + live Oracle metadata), same quality style as Netezza live completion suites
- live SQL quality (`SqlQualityEngine` / ORA001–004, strict GROOM rejection, PL/SQL SQL037/039, SQL004 unknown column against live column metadata)
- `EXPLAIN PLAN` / plan-tree parsing and the Oracle tuning advisor (`SELECT *` rule)
- Oracle optimizer statistics, `ANALYZE TABLE`, disposable-table `ALTER TABLE … MOVE`
- session-monitor storage via provider; `V$SESSION` / `V$SQL` query shapes via live connection (avoids `$` variable-resolution collisions in `runQueryRaw`)
- import/export (typed columns, cancel during fetch, Oracle SQL dialect for binary round-trip) and the guarded non-applicable distribution/skew path

Oracle-native surfaces (indexes, partitions, packages) are validated on purpose; they are not required to mirror Netezza 1:1. The shared optional smoke suite additionally covers a small Oracle import path.
Both live suites are excluded from the default unit-test configuration and are
intentionally opt-in because they create temporary live database objects. See
[docs/oracle.md](oracle.md) for the env and coverage matrix.

## MS SQL Server Checklist

The MSSQL extension has a dedicated live suite at
`src/__tests__/integration/mssql.integration.test.ts`. Provide
`MSSQL_LIVE_TEST_HOST`, `MSSQL_LIVE_TEST_DATABASE`, `MSSQL_LIVE_TEST_USER`, and
`MSSQL_LIVE_TEST_PASSWORD` (optional `MSSQL_LIVE_TEST_PORT`, default **1433**)
and run:

```bash
npm run install:mssql
npm run test:mssql:integration
npm run verify:mssql
```

The deep suite exercises:

- connection and compatibility shims (`CURRENT_CATALOG` / `CURRENT_SCHEMA` / `CURRENT_SID`)
- catalog/search metadata across tables, views, and procedures
- DDL extraction/generation and table maintenance (`UPDATE STATISTICS`, index rebuild)
- streaming cancel during large fetch (session remains usable)
- typed import/export round-trip (BIT, DECIMAL, NVARCHAR, DATETIME2, UNIQUEIDENTIFIER)
- live completion E2E (`LspCompletionEngine` + live MSSQL metadata)
- live SQL quality (`MSS001–MSS008`, strict Netezza-only reject, SQL004 / SQL025 against catalog types)

Editor parity uses `MSSQL_SQL_PARSING_RUNTIME` (Chevrotain T-SQL layer) with TextMate
injection at `dialects/mssql/syntaxes/mssql.tmLanguage.json`.

## Db2 Checklist

The Db2 extension has a dedicated live suite at
`src/__tests__/integration/db2.integration.test.ts`. Native `ibm_db` must be
aligned to the Node/Jest ABI before the suite runs (the npm script does this
via `switch-runtime.js auto-for-live-tests`). Provide `DB2_LIVE_TEST_HOST`,
`DB2_LIVE_TEST_DATABASE`, `DB2_LIVE_TEST_USER`, and `DB2_LIVE_TEST_PASSWORD`
(optional port default **50000**, optional `DB2_LIVE_TEST_CURRENT_SCHEMA` /
fixture schema) and run:

```bash
npm run install:db2
npm run test:db2:integration
npm run verify:db2
npm run db2:connect-probe
```

Optional persistent catalog for richer assertions:

```bash
npm run db2:seed-live-fixture -- --force
npm run db2:verify-live-fixture
```

The deep suite exercises:

- connection context (`CURRENT SERVER` / `CURRENT SCHEMA` / `SYSIBM.SYSDUMMY1`)
- metadata/search for tables, views, aliases, procedures; scoped `buildListTablesQuery(database, schema)` regression
- DDL generation, disposable composite index / partition fixtures, `JBL_LIVE` fixture when seeded
- live completion E2E (`LspCompletionEngine` + live Db2 metadata; keywords `FETCH FIRST` / `WITH UR`, no `GROOM`)
- live SQL quality (`SqlQualityEngine` / DB2001–DB2008, strict GROOM/`LIMIT`/`DB..TABLE` rejection, SQL004 unknown column + SQL025 type mismatch against live column metadata)

Local `npm run test:db2:integration` **requires** `DB2_LIVE_TEST_*` (fails if missing). Live runs are not wired into GitHub Actions — run locally against a Db2 host.
- explain JSON parse + tuning advisor (soft-skip if explain tables missing)
- RUNSTATS maintenance (soft-skip on privilege errors)
- session-monitor storage provider

Db2 does not mirror Netezza distribution/skew UI. See [docs/db2.md](db2.md).

## Snowflake Checklist

Use Snowflake when you need a cloud-only optional runtime with stricter auth and cost controls:

1. Keep SQL authoring in `extensions/snowflake/src/sql/` and traits in `src/shared/dialect-traits/snowflake.ts`
2. Keep the runtime package in `extensions/snowflake`
3. Use `snowflake-sdk` only in the optional extension and keep it external to esbuild output
4. Map `INFORMATION_SCHEMA` and `SHOW ... ->> SELECT ... FROM $1` results into the shared metadata contracts
5. Expose warehouse/role/session controls through shared commands, not custom hidden state
6. Generate stage-based `COPY INTO` workflows rather than bundling local upload tooling
7. Gate all live-account tests behind explicit opt-in environment variables

## Snowflake Validation Commands

```bash
npm run check-types
npm run check-types:snowflake
npm run test -- --testPathPatterns="snowflake|optionalDialects.unit.test.ts|wizardCommands.test.ts|importCommands.test.ts"
RUN_SNOWFLAKE_INTEGRATION=1 npm run test:snowflake:integration
```
