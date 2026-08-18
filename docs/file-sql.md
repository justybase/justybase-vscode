# File SQL

Data Workspace is the primary way to query local files. It stores a persistent DuckDB database in extension storage and materializes each local file as a real table. The older File SQL dialect remains available to existing integrations, but it is not shown in the Data Workspace Manager.

## Why use it?

Treat local files like database tables while staying inside VS Code: join several files, filter and aggregate them with SQL, inspect the result in the regular data grid, and export the outcome. This is especially useful for quick analysis before loading data into Netezza.

## Quick start

1. Install the [DuckDB + Files pack](../extensions/duckdb/README.md).
2. Open **Data Workspace Manager** and choose **New Data Workspace**.
3. Use **Add local file**. Excel, CSV, TSV, Parquet, and Access (`.mdb`/`.accdb`) files are supported. A workspace containing one file is enough for a single-file SQL query; add more files when you need joins or unions.
4. Use **Open SQL** and query the generated DuckDB table.

For quick inspection, right-click a CSV or Excel file and choose **Open in Data File Preview**. The preview's **Add to Data Workspace** button lets you choose a new or existing workspace without leaving the preview.

Data Workspace file sources also have **Edit source** for XLSX, CSV/TSV, and Access files. This opens a separate single-file editing session and asks for confirmation before changes can be written to the original file. After saving, use the source's **Refresh** action to replace its materialized DuckDB table; there is no automatic synchronization.

## Editor Support

- File SQL resolves to the DuckDB parser runtime.
- File SQL has its own authoring profile (`databaseKind: file`) so File-specific quality rules do not alter DuckDB behavior.
- Completion includes DuckDB table functions such as `read_csv`, `read_parquet` and `read_xlsx`.
- `FSL001` warns on DML targeting a source view; generated `<file>_edit` tables are exempt.

## XLSB (Excel Binary) Files

DuckDB has no `read_xlsb` function, so `.xlsb` workbooks are converted to CSV with `@justybase/spreadsheet-tasks` (XlsbReader) in a per-connection temporary directory at connect time and read back through `read_csv` (DuckDB's CSV sniffer infers the header and column types, mirroring `read_xlsx` semantics). No DuckDB extension is required, so XLSB works offline.

- XLSX connections expose one view per discovered sheet (`<file>__<sheet>`) plus `<file>` for the first sheet. XLSB single-file connections expose the first sheet only (it is the editable one); multi-file workspaces expose every discovered XLSX/XLSB sheet as `<path>#sheet=<sheet>`.
- **Editable copy** works for single XLSX/XLSB files: `INSERT`/`UPDATE`/`DELETE` on `<file>_edit` are written back **in place** with `XlsxUpdater` or `XlsbUpdater` (other sheets, styles and pivots are preserved). DuckDB cannot safely preserve an existing workbook with `COPY ... FORMAT XLSX`, so Excel write-back is performed client-side by the companion extension.
- Because conversion happens at connect time, an XLSB file changed on disk is only visible after reconnecting (unlike XLSX, which DuckDB re-reads per query).

## Microsoft Access Files (`.mdb` / `.accdb`)

DuckDB has no Access reader, so every table of an Access database is converted to CSV with `@justybase/access-file` in the connection's temporary directory at connect time and read back through `read_csv`. The column types are inferred by DuckDB's CSV sniffer from the table's rows; the header comes from the Access column definitions.

- Access is **read-only** in the DuckDB File SQL dialect: there is no editable copy and no Save File Edits there. **Edit source** from Data Workspace opens a separate Microsoft Access session with write access when the optional Access extension is installed.
- Single-file connections expose one view per table (`<file>__<table>`), without a base `<file>` view; multi-file workspaces expose `<path>#table=<table>`.
- Hidden complex flat tables (Jackcess `f_<GUID>_<field>` backing tables for attachment/multivalue columns) are skipped; their values are already serialized into the parent table's complex columns.
- Password-protected Access databases are not supported.
- Because conversion happens at connect time, an Access file changed on disk is only visible after reconnecting.

## Runtime Boundary

Materialized Data Workspace source tables are replaced on refresh; local tables and views created separately in DuckDB remain intact. Legacy File SQL source views are still read-only, and existing legacy profiles are not migrated or deleted by the new manager.

See also: [Export & Import Reference](EXPORT_IMPORT.md) and the [File SQL section in the README](../README.md#local-files-as-sql-connections).
