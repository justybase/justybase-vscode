# JustyBase SQL Editor for DuckDB and Files

Read the [canonical documentation portal](https://justybase.github.io/justybase-vscode/guide/user/data-workspace/) for the Files/DuckDB workflow and capability boundaries.

![JustyBase SQL Editor for DuckDB and Files](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/marketplace-hero.png)

**Query local files and embedded DuckDB databases with SQL, directly inside VS Code.**

This companion extension adds DuckDB and File SQL workflows to [JustyBase SQL Editor](../../README.md). The core extension is installed automatically; Netezza is not required.

[![Marketplace](https://vsmarketplacebadges.dev/version/krzysztof-d.justybaselite-duckdb.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=krzysztof-d.justybaselite-duckdb)

## Query files as tables

![File SQL workspace with schema browser, editor, and results](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/workspace-overview.png)

Open a file from Explorer or create a File SQL connection. JustyBase exposes the source as tables or views so you can join files, inspect columns, and run SQL without setting up a server.

## Supported sources

- Excel `.xlsx` and `.xlsb` workbooks, including discovered sheets.
- CSV and TSV files.
- Parquet and Avro files.
- Microsoft Access `.mdb` and `.accdb` files in read-only File SQL mode.
- DuckDB database files and `:memory:` databases.

### File SQL highlights

- Single-file and multi-file read-only workspaces.
- One view per discovered workbook sheet or Access table.
- DuckDB readers for CSV, TSV, and Parquet; Excel and Avro extensions are downloaded once on first use.
- XLSB conversion through `@justybase/spreadsheet-tasks`, so it works without the DuckDB Excel extension.
- Optional **Editable copy** for supported single-file CSV/TSV/Parquet/XLSX workflows, saved with **JustyBase: Save File Edits**. XLSX write-back uses `XlsxUpdater` so headers and other workbook sheets are preserved.
- Shared completion, hover, diagnostics, result profiling, visualizations, and exports.

![Explore file results with profiles and summaries](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-explorer.png)

![Visual Query Builder for joining file sources](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/visual_query_builder.png)

## Query a local file

1. Install **JustyBase SQL Editor (DuckDB + Files)**.
2. Right-click an `.xlsx`, `.xlsb`, `.csv`, `.tsv`, `.parquet`, `.avro`, `.mdb`, or `.accdb` file.
3. Choose **Query File with SQL (DuckDB)**, or use the File SQL connection in the JustyBase view.
4. Open a SQL editor and run the statement with `Ctrl+Enter` / `F5`.

To combine sources, choose **Query Multiple Files with SQL (DuckDB)**. Workspaces can be saved and reopened from connection profiles.

## Runtime notes and boundaries

- DuckDB runs in-process; no database server is needed.
- Excel and Avro extensions require internet access on first use. XLSB conversion does not.
- Access sources in File SQL mode are read-only; use the dedicated Access companion for staged Access writes and DDL.
- Multi-file write-back is intentionally unsupported. Export a result to create a new combined file.
- Data Workspace source cards can open XLSX, CSV/TSV, and Access files in a separate editing session. Saving changes the original file; use **Refresh** in Data Workspace afterwards to rematerialize its local DuckDB table.

## Development

```bash
cd extensions/duckdb
npm install
npm run check-types
npm run build
```

The package externalizes `@duckdb/node-api`; keep that runtime dependency available for development and packaging.

## License

Apache-2.0. The Marketplace VSIX includes `THIRD_PARTY_NOTICES.md`.
