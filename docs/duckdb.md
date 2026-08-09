# DuckDB SQL Support

DuckDB support is delivered by the optional extension in [`extensions/duckdb`](../extensions/duckdb). The core extension supplies the editor runtime and static SQL assets.

## Editor Support

- Dedicated Chevrotain runtime: `DUCKDB_SQL_PARSING_RUNTIME`
- File SQL uses the same DuckDB parser runtime with a separate `file` authoring profile
- Strict syntax validation
- DuckDB syntax covered by the parser includes `QUALIFY`, `SAMPLE`/`USING SAMPLE`, `REPEATABLE`, `ASOF JOIN`, `POSITIONAL JOIN`, `SEMI`/`ANTI`/`LATERAL JOIN`, `PIVOT`/`UNPIVOT`, table functions with `WITH ORDINALITY`, `CREATE MACRO`/`CREATE FUNCTION`, `CREATE TYPE`, `INSTALL`, `LOAD`, `ATTACH`, `DETACH`, `USE`, `WINDOW`, `* EXCLUDE`, `* REPLACE`, `* RENAME`, and `COLUMNS(*)`
- DuckDB built-ins, signatures and types are exposed through completion and validation
- Quality rules: `DDK001`–`DDK003`
- TextMate grammar: `dialects/duckdb/syntaxes/duckdb.tmLanguage.json`
- Snippets: `dialects/duckdb/snippets/duckdb.code-snippets`

## Runtime Support

The extension provides DuckDB connectivity, metadata, DDL, import mapping, explain parsing, tuning, maintenance, session monitoring and Copilot references. DuckDB runs in-process through `@duckdb/node-api`; no server is required.

## File SQL Boundary

File SQL uses DuckDB SQL over read-only views for CSV, TSV, Parquet, Avro and XLSX sources. An editable single-file connection materializes a generated `<file>_edit` table. `FSL001` warns when DML targets a source other than an `_edit` table.

The read-only diagnostic is advisory because lint rules do not receive connection options. The execution layer remains the authority for whether a workspace is editable.

## Deliberate Boundaries

- DuckDB has no Netezza SPU/distribution metrics, GROOM, NZPLSQL or Netezza-specific MCP/notebook surfaces.
- Stored-procedure capabilities remain disabled; DuckDB `CREATE MACRO` is parsed as a DuckDB statement, not modeled as a stored procedure.
- Multi-file File SQL workspaces remain read-only.
