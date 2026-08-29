---
title: Import and export
description: Move data through files, the clipboard, result sets, and database-specific staging paths with explicit previews and limits.
audience: user
category: Product guides
status: Supported
last_verified: 2026-08-19
product_version: 3.17.7
---

# Import and export

Always decide which data boundary you mean before choosing a command: the visible grid, the complete fetched/spilled dataset, or a fresh execution of the SQL. “Export all data” is intentionally not a sufficient description.

## Export sources

<figure>
  <img src="gifs/export_xlsb.gif" alt="Exporting a query result to an Excel workbook in JustyBase">
  <figcaption>Stream results to Excel, CSV, JSON, XML, SQL INSERT, Markdown, or Parquet.</figcaption>
</figure>

| Source | What is exported |
| --- | --- |
| Active result grid | The selected result-set view; raw or formatted values can be chosen. |
| Disk-backed result | The complete fetched dataset in the local SQLite spill, subject to filters/sorts selected by the export. |
| Editor / Command Palette | A new execution of the selected SQL, including CodeLens export actions. |
| Batch result | Multiple result sets; spreadsheet formats use separate sheets where supported. |
| Schema Search | Search rows as an XLSB workbook from the Schema Search view. |

## Export formats

| Format | Desktop result grid | Web result session | Notes |
| --- | --- | --- | --- |
| XLSB | Supported | Supported | Compact binary Excel; preferred for large workbooks and multi-result sheets. |
| XLSX | Supported | Supported | Modern Excel workbook; multiple result sets become sheets. |
| CSV | Supported | Supported | Plain text; use raw values when downstream parsing matters. |
| CSV.GZ | Supported | Supported | Gzip-compressed CSV stream. |
| CSV.ZST | Supported | Supported | Zstandard-compressed CSV stream. |
| JSON | Supported | Supported | Result rows as a JSON array. |
| XML | Supported | Supported | XML result document. |
| SQL INSERT | Supported | Supported | Generated `INSERT` statements; review quoting and target schema. |
| Markdown | Supported | Supported | Table for sharing or documentation; combined Markdown export can include batch sections. |
| Parquet | Supported | — | Columnar export from the desktop result/file preview workflows. |
| XPT | Partial | — | SAS-like macro/file workflow; not a general Web import/export option. Verify the target command and dialect first. |

The live contract inventory for result and file formats is generated below.

<!-- GENERATED:FORMATS -->

## File preview and Data Workspace

The desktop Data File Preview opens XLSB, XLSX, CSV/TSV, Parquet, Avro, and Access files as local data. Excel workbooks expose sheets as tabs. Sorting, filtering, grouping, profiles, Row View, Value Viewer, copying, and export use the same exploration patterns as query results. `justybase.filePreview.maxRows` defaults to 20,000 for a file preview.

Data Workspace uses a local DuckDB/SQLite-backed profile to query files as tables. Files can be joined and transformed locally without a warehouse connection. Editable sources are XLSX and CSV/TSV plus Access; Parquet, Avro, and XLSB are read-only source formats in the workspace editor. The [Data Workspace guide](guide/user/data-workspace/) has the exact source boundary.

## Import from a file

1. Select a target table in Schema Browser and choose **Import Data** or **Import Data (Advanced Wizard)**.
2. Choose CSV/TXT, XLSX, or XLSB, or use **Smart Paste** for a path or tabular clipboard data.
3. Confirm delimiter, decimal separator, header handling, encoding, and inferred types.
4. Map source columns to target columns; choose defaults, nullable behavior, and conversions explicitly.
5. Review the generated DDL and import plan. A preview is not an execution.
6. Run synchronous sample validation, then allow background validation for the larger sample when enabled.
7. Confirm the write and monitor progress. Cancelled or failed stages clean up temporary state where possible; retry from the preview if the source changed.

The simple importer is useful for a known, clean file. The advanced wizard is safer for mixed types, renamed columns, nullability, date formats, and large files because it separates inference, mapping, validation, and execution.

For ClickHouse, the companion uses the HTTP runtime and generates a `MergeTree` target with `ORDER BY tuple()` by default. Inferred numeric, date/time, boolean, UUID, decimal, and text columns are mapped to ClickHouse types; use the generated preview to change the target mapping or provide a qualified `database.table` target. Inserts are sent in batches and are intentionally not wrapped in a relational transaction because ClickHouse mutations and MergeTree ingestion have different consistency semantics.

For Netezza, CSV/TXT, XLSX, and XLSB imports use the driver's virtual external-table stream. The source rows are registered under a transient name and consumed with `FROM EXTERNAL`; they are not first copied to a local data file. This keeps the client-side stream and the driver's external-load protocol ordered and avoids failures caused by a prematurely closed or partially materialized temporary file. The Netezza driver must be version 2.4.4 or newer.

Excel header handling is defensive: a row containing numeric values is treated as data rather than a header, missing headers receive `COL_1`, `COL_2`, and repeated names receive suffixes such as `COL_1`. Consequently, a workbook with a first row `1, a` retains that row in the target table.

Parquet is supported by the DuckDB/File SQL connection, not by the direct Netezza file importer. To load Parquet into Netezza, open the file as a File SQL source and use Migration Studio; the live migration path reads the Parquet view and streams rows into Netezza.

## Import from the clipboard

**Import Clipboard Data to Table** reads tabular clipboard content. **Smart Paste** detects file paths and tabular text, then opens the matching path or import flow. Clipboard parsing is bounded by the host and OS clipboard limits; for large data, save a file so the wizard can validate and retry deterministically.

Netezza clipboard imports use the same transient virtual external-table stream as file imports. Duplicate or empty column names are normalized before the target DDL is generated, and the stream is unregistered and destroyed after success or failure.

## Reliability controls

- Preview and DDL generation happen before a write confirmation.
- Progress and cancellation are shown for long imports/exports.
- Background validation is controlled by `justybase.importWizard.backgroundValidationEnabled` and its sample-size setting.
- A failed import does not make a partially written table safe; use a staging table and transaction/database-specific cleanup policy where available.
- Access and local file operations use the embedded reader/runtime and have no warehouse transaction boundary.

## Access and database boundaries

Netezza, Db2, Oracle, PostgreSQL, MSSQL, MySQL, DuckDB/File SQL, SQLite, and Access do not share identical type mapping or staging behavior. Use [Database support](guide/reference/database-support/) for the current matrix and inspect generated SQL before execution.

## Troubleshooting

- If a delimiter is wrong, reopen the preview and set it explicitly instead of correcting rows after import.
- If numbers become text, check decimal separator, thousands grouping, and target type mapping.
- If an Excel sheet is missing, confirm the selected sheet and whether the workbook is XLSB or XLSX.
- If an export looks truncated, identify whether you exported loaded rows, the disk-backed fetched dataset, or a fresh query execution.
- If a large export is slow, prefer streaming CSV.GZ/CSV.ZST or XLSB and inspect Result Panel performance stats.

For a repeatable desktop measurement of preview, streaming import, export payload preparation, compression, and workbook finalization, see the [Data Grid performance benchmark playbook](guide/developer/performance-benchmarks/). Its reported export time ends at the webview-to-host message, so it is not a promise about file-writing time.
