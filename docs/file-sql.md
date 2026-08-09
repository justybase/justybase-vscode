# File SQL

File SQL queries local Excel, CSV/TSV, Parquet and Avro files through an in-memory DuckDB connection.

## Why use it?

Treat local files like database tables while staying inside VS Code: join several files, filter and aggregate them with SQL, inspect the result in the regular data grid, and export the outcome. This is especially useful for quick analysis before loading data into Netezza.

## Quick start

1. Install the [DuckDB + Files pack](../extensions/duckdb/README.md).
2. Open **Connect to Database** and choose **Excel / CSV / Parquet / Avro (DuckDB)**.
3. Select one file, or use **Query Multiple Files with SQL (DuckDB)** for a read-only workspace containing several files.
4. Write SQL against the generated views and run it like any other query.

For an `.xlsx` workbook, sheets are exposed as separate views and suggested by completion. A saved multi-file workspace can be reopened with **Open Saved File SQL Workspace**.

## Editor Support

- File SQL resolves to the DuckDB parser runtime.
- File SQL has its own authoring profile (`databaseKind: file`) so File-specific quality rules do not alter DuckDB behavior.
- Completion includes DuckDB table functions such as `read_csv`, `read_parquet` and `read_xlsx`.
- `FSL001` warns on DML targeting a source view; generated `<file>_edit` tables are exempt.

## Runtime Boundary

Source views are read-only. Enable **Editable copy** for a single-file connection to create an `_edit` table and save changes back through the File SQL commands. Multi-file workspaces are read-only.

See also: [Export & Import Reference](EXPORT_IMPORT.md) and the [File SQL section in the README](../README.md#local-files-as-sql-connections).
