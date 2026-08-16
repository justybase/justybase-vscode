# Oracle Support

Oracle support is delivered as the optional sibling extension in [`extensions/oracle`](../extensions/oracle) plus Oracle SQL/PL/SQL assets in the **core** extension (parser, grammar, snippets, LSP integration).

## Preview extension status

The Oracle pack is published with `"preview": true` in `extensions/oracle/package.json`. Treat it as a **near-full companion runtime** for daily Oracle work, not as a thin connect-only adapter.

**Netezza (core)** remains the reference **full** experience: NZ/NZP rule depth, GROOM and ETL designer workflows, Netezza distribution/skew Copilot context, and Netezza-tuned language-model tools.

**Oracle (core + optional pack)** provides **advanced** editor and runtime parity on the shared stack — the strongest optional dialect for SQL/PL/SQL authoring. It does **not** replace Netezza-only product surfaces.

## What this pack provides

### Connection and metadata

- Shared connection UI with service name, optional connect string override, `currentSchema`, connect timeout, and Oracle Net config directory
- `node-oracledb` thin mode (no Oracle Client required for the default path)
- Schema explorer for tables, views, procedures, functions, packages, triggers, sequences, and synonyms

### SQL and PL/SQL editor (core)

- Oracle Chevrotain lexer and parser extending the shared Netezza parser base
- TextMate grammar (`dialects/oracle/syntaxes/oracle.tmLanguage.json`) and snippets (`dialects/oracle/snippets/oracle.code-snippets`)
- Strict Oracle validation, PL/SQL blocks, packages, triggers, and procedure-scope warnings **SQL037–SQL040** where applicable
- Metadata-aware completion, hover, rename, and semantic tokens when the active connection is Oracle
- Oracle quality rules **ORA001–ORA004** (for example `SELECT *`, DML without `WHERE`, `ROWNUM` vs `ORDER BY`)

### Data workflows

- Advanced import (CSV/TXT/XLSX/XLSB/clipboard) with Oracle type mapping, including BOOLEAN and RAW/BLOB hex input
- Advanced export (CSV, JSON, XML, Markdown, SQL INSERT, XLSX/XLSB, Parquet, XPT) with streaming cancellation
- DDL for tables, views, routines, packages, sequences, synonyms, triggers, and indexes; batch schema migration DDL with partitions and visible grants where metadata allows

### Analysis and operations

- `EXPLAIN PLAN` with explain graph view
- Tuning advisor heuristics on normalized plans
- Session monitor
- Table maintenance: gather statistics (`DBMS_STATS`), `ALTER TABLE MOVE`, `ANALYZE TABLE`
- Dialect-specific Copilot reference text for optimization and PL/SQL authoring

## Installation

1. Install the core extension: `krzysztof-d.justybaselite-netezza`
2. Install `JustyBase SQL Editor (Oracle)` from the Marketplace (or VSIX from releases)
3. For local packaging or development:

```bash
npm run install:oracle
npm run build:oracle
```

Optional extension package only (driver bundle):

```bash
cd extensions/oracle
npm install
npm run build
```

## Runtime notes

- The saved `database` field is the Oracle **service name** unless **Connect String Override** is set.
- Compatibility shims implement `CURRENT_CATALOG`, `CURRENT_SCHEMA`, `CURRENT_SID`, and `SET CATALOG` for shared core SQL; `SET CATALOG` does not switch Oracle services.
- Failed imports clean up tables created in the current run; existing tables are never dropped automatically.

## Parity versus Netezza (honest summary)

| Area | Oracle | Netezza |
| --- | --- | --- |
| Dedicated dialect parser + PL/SQL scope analysis | Advanced (Oracle grammar) | Full (NZ + NZPLSQL) |
| SQL/NZ/NZP / NZP linter depth | ORA rules + parser diagnostics | Full rule set |
| GROOM, ETL designer, skew/distribution Copilot | No | Yes |
| Explain / tuning / session monitor / maintenance | Yes (Oracle-specific) | Yes (Netezza-specific) |
| Optional VSIX | Driver + dialect registration | n/a (built-in) |

## Integration testing

Optional local integration from the repository root:

```bash
npm run install:oracle
npm run test:oracle:integration
# or: npm run test:live:matrix   # loads .env.local when present
```

### Minimal environment

Required (four variables):

| Variable | Meaning |
| --- | --- |
| `ORACLE_LIVE_TEST_HOST` | Host / listener |
| `ORACLE_LIVE_TEST_DATABASE` | Service name (not SID unless via connect-string override) |
| `ORACLE_LIVE_TEST_USER` | User |
| `ORACLE_LIVE_TEST_PASSWORD` | Password |

Optional:

- `ORACLE_LIVE_TEST_PORT` — defaults to **1521**
- `ORACLE_LIVE_TEST_CURRENT_SCHEMA`
- `ORACLE_LIVE_TEST_CONNECT_STRING`, `ORACLE_LIVE_TEST_CONFIG_DIR`, `ORACLE_LIVE_TEST_CONNECT_TIMEOUT`
- `ORACLE_LIVE_TEST_REQUIRED=true` — fail fast when required vars are missing (used by CI)

Without the four required variables the deep and smoke suites are skipped (`describe.skip`).

### Deep suite coverage (`oracle.integration.test.ts`)

Quality bar for editor paths matches Netezza live E2E style (real catalog + `LspCompletionEngine` / `SqlQualityEngine`). Oracle-only surfaces (indexes, partitions, packages) are tested without forcing a 1:1 Netezza mapping.

| Area | Live | Unit |
| --- | --- | --- |
| Connection / context | Connect, `CURRENT_CATALOG` / `CURRENT_SCHEMA` / `CURRENT_SID` shims | — |
| Metadata / search | Tables, views, procedures, object/column/source search; sequence/synonym/function/package/trigger/index/partition/LOB | — |
| DDL | Table/view/procedure + function/package/trigger/sequence/synonym; **advanced disposable fixtures** (composite index, partitioned table, batch migration) | — |
| Completion | Alias columns from live `ALL_TAB_COLUMNS`, schema-dot tables, Oracle keywords (`DUAL` / `CONNECT BY`, no `GROOM`) | Keyword / PL/SQL / alias unit suites |
| Linter / validator | ORA001–004, GROOM rejected, SQL037/039, SQL004 unknown column with schema from live `getColumns` | Authoring + `oracleValidator` |
| Explain / tuning | `EXPLAIN PLAN` → parse + `ORTA-001` | Explain parser unit |
| Import / export | Typed import, failed-import cleanup, SQL/CSV/JSON round-trip, cancel fetch | — |
| Maintenance / session | Stats, ANALYZE, MOVE; storage + `V$SESSION`/`V$SQL` shapes | — |
