# File SQL

Data Workspace is the primary way to query local files. It stores a persistent DuckDB database in extension storage and materializes each local file as a real table. The older File SQL dialect remains available to existing integrations, but it is not shown in the Data Workspace Manager.

## Why use it?

Treat local files like database tables while staying inside VS Code: join several files, filter and aggregate them with SQL, inspect the result in the regular data grid, and export the outcome. This is especially useful for quick analysis before loading data into Netezza.

## Quick start

1. Install the [DuckDB + Files pack](../extensions/duckdb/README.md).
2. Open **Data Workspace Manager** and choose **New Data Workspace**.
3. Use **Add local file**. A workspace containing one file is enough for a single-file SQL query; add more files when you need joins or unions.
4. Use **Open SQL** and query the generated DuckDB table.

For quick inspection, right-click a CSV or Excel file and choose **Open in Data File Preview**. The preview's **Add to Data Workspace** button lets you choose a new or existing workspace without leaving the preview.

## Editor Support

- File SQL resolves to the DuckDB parser runtime.
- File SQL has its own authoring profile (`databaseKind: file`) so File-specific quality rules do not alter DuckDB behavior.
- Completion includes DuckDB table functions such as `read_csv`, `read_parquet` and `read_xlsx`.
- `FSL001` warns on DML targeting a source view; generated `<file>_edit` tables are exempt.

## XLSB (Excel Binary) Files

DuckDB has no `read_xlsb` function, so `.xlsb` workbooks are converted to CSV with `@justybase/spreadsheet-tasks` (XlsbReader) in a per-connection temporary directory at connect time and read back through `read_csv` (DuckDB's CSV sniffer infers the header and column types, mirroring `read_xlsx` semantics). No DuckDB extension is required, so XLSB works offline.

- XLSX connections expose one view per discovered sheet (`<file>__<sheet>`) plus `<file>` for the first sheet. XLSB single-file connections expose the first sheet only (it is the editable one); multi-file workspaces expose every discovered XLSX/XLSB sheet as `<path>#sheet=<sheet>`.
- **Editable copy** works for single XLSB files: `INSERT`/`UPDATE`/`DELETE` on `<file>_edit` are written back **in place** with `XlsbUpdater` (other sheets, styles and pivots are preserved). DuckDB cannot write XLSB itself, so the write-back is performed client-side by the companion extension.
- Because conversion happens at connect time, an XLSB file changed on disk is only visible after reconnecting (unlike XLSX, which DuckDB re-reads per query).

## Runtime Boundary

Materialized Data Workspace source tables are replaced on refresh; local tables and views created separately in DuckDB remain intact. Legacy File SQL source views are still read-only, and existing legacy profiles are not migrated or deleted by the new manager.

See also: [Export & Import Reference](EXPORT_IMPORT.md) and the [File SQL section in the README](../README.md#local-files-as-sql-connections).
