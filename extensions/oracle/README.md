# Oracle Tools (justybase)

Optional Oracle support for Netezza SQL Tools (justybase).

This extension registers the `Oracle` dialect with the core extension: shared connection UI, schema browser, query execution, DDL/import/export workflows, and the `node-oracledb` runtime. **SQL editor intelligence** (Chevrotain lexer/parser, TextMate grammar, snippets, PL/SQL validation, completion, hover, semantic tokens) ships in the **core** extension and activates when an Oracle connection is active — install **both** extensions for the full experience.

## Requirements

- Install the core extension first: `Netezza SQL Tools (justybase)`
- VS Code Desktop
- Oracle Database 12.1 or later
- Network access to your Oracle service

## Runtime model

`Oracle Tools (justybase)` uses `node-oracledb` in **thin mode** by default:

- No Oracle Client installation is required for the baseline runtime path
- Standard Easy Connect strings (`host:port/service`) work out of the box
- Optional Oracle Net configuration directories can be supplied from the connection form when TNS aliases or wallet files are needed

## What this extension adds

- Oracle connection type in the shared JustyBase connection UI (service name, connect string override, optional `currentSchema`, Net config directory)
- Oracle runtime integration via `node-oracledb` (thin mode)
- Metadata for schemas, tables, views, procedures, functions, packages, triggers, sequences, and synonyms
- Column metadata from `ALL_TAB_COLUMNS`, `ALL_COL_COMMENTS`, `ALL_CONSTRAINTS`, and `ALL_CONS_COLUMNS`
- Advanced DDL extraction and batch schema migration DDL via `DBMS_METADATA.GET_DDL` (with `ALL_SOURCE` and catalog fallbacks), including indexes, partitions, and visible object grants where supported
- Import type mapping, table maintenance (`DBMS_STATS`, `ALTER TABLE MOVE`, `ANALYZE TABLE`), session monitor, explain plan graph, tuning advisor, and dialect-specific Copilot reference hints
- Pattern-based quality rules **ORA001–ORA004** (wired through the shared Oracle authoring profile)

## SQL and PL/SQL editor (core + this pack)

With the core extension installed, Oracle authoring includes:

- Dedicated Oracle lexer and parser (`src/dialects/oracle/sql/`) extending the shared Chevrotain stack
- TextMate grammar and snippets under `dialects/oracle/`
- Strict Oracle validation mode, anonymous PL/SQL blocks, packages, triggers, and shared procedure-scope diagnostics (**SQL037–SQL040** where applicable)
- Metadata-aware completion, hover, rename, and semantic tokens on Oracle SQL files when connected to Oracle

See [docs/oracle.md](../../docs/oracle.md) for parity boundaries versus Netezza and live-test setup.

## Runtime notes

- The `database` field represents the Oracle service name by default.
- An optional **Connect String Override** can be used for full Easy Connect Plus strings or TNS aliases.
- `SELECT CURRENT_CATALOG`, `SELECT CURRENT_SCHEMA`, `SELECT CURRENT_SID`, and `SET CATALOG ...` are emulated for shared core compatibility. `SET CATALOG` does not open a new Oracle service connection; it only updates compatibility state in the JustyBase runtime.
- Netezza distribution/skew metrics have no Oracle equivalent and are not shown.
- Import/export supports advanced Oracle types (including LOB/time-zone columns) with streaming cancellation on large exports; see the core export/import documentation.

## Explain, tuning, and session monitor

- Explain uses `EXPLAIN PLAN FOR` plus retrieval through `DBMS_XPLAN` / plan table display, with a shared explain graph view.
- The Oracle tuning advisor consumes normalized plan text and applies Oracle-oriented heuristics.
- Session monitor surfaces active sessions and related statistics from Oracle dynamic views.

## Unsupported or intentionally deferred

- Netezza-only SQL (for example `GROOM`) is rejected in strict Oracle validation mode
- Netezza-specific Copilot tools, GROOM/ETL designer workflows, and SQL/NZ/NZP rule depth remain on the Netezza-first path
- Cross-service catalog switching is not supported through `SET CATALOG`
- External-table workflows and advanced PL/SQL object-type / cursor / record semantics are outside the supported core (see [plans/DIALECT_PARITY_MATRIX.md](../../plans/DIALECT_PARITY_MATRIX.md))

## Installation order

Marketplace or manual VSIX installation should end with both extensions installed:

1. Install `Netezza SQL Tools (justybase)`
2. Install `Oracle Tools (justybase)`

`Oracle Tools (justybase)` declares `extensionDependencies` on the core extension, so VS Code can resolve the dependency automatically in Marketplace scenarios.

## Integration testing

From the repository root (optional, requires a live database):

```bash
npm run install:oracle
npm run test:oracle:integration
```

Required: `ORACLE_LIVE_TEST_HOST`, `ORACLE_LIVE_TEST_DATABASE` (service name), `ORACLE_LIVE_TEST_USER`, `ORACLE_LIVE_TEST_PASSWORD`. Optional: `ORACLE_LIVE_TEST_PORT` (default 1521), `ORACLE_LIVE_TEST_CURRENT_SCHEMA`.

See [docs/oracle.md](../../docs/oracle.md) for the full live coverage matrix (explain/tuning, DDL object families, maintenance, session monitor).

## Development notes

From `extensions\oracle`:

```powershell
npm install
npm run check-types
npm run build
```

The extension bundle externalizes `oracledb`, so the package must keep `node_modules\oracledb` available at runtime.

## License and third-party software

This extension is licensed under Apache-2.0. Its Marketplace VSIX includes the full project license and a generated `THIRD_PARTY_NOTICES.md` covering locked runtime dependencies and their available license texts.
