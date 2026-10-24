# Data Export & Import Reference

This technical reference is preserved for compatibility. The maintained workflow is [Import and export](https://justybase.github.io/justybase-vscode/guide/user/import-export/), including data-boundary rules for loaded rows, disk-backed results, and fresh query execution.

JustyBase provides comprehensive data export and import capabilities for seamless data transfer.

---

## Export Formats

### Parquet

**Apache Parquet** — columnar storage format, ideal for analytical workloads and large datasets.

| Method | Description |
|--------|-------------|
| **Export to Parquet** | Save query results to `.parquet` file |
| **Export from Results panel** | Select Parquet in the format picker during export |

**Features:**
- Columnar storage for efficient compression and encoding
- Schema-aware type mapping (BOOLEAN, INT64, FLOAT, DOUBLE, UTF8, BYTE_ARRAY)
- Supports cancellation with partial data preservation
- Configurable row group size for performance tuning
- Licensed under Apache 2.0

**Limitations:**
- Not suitable for streaming row-by-row (Parquet is columnar by design)
- Large datasets require sufficient memory for encoding

### Data File Preview

The **Data File Preview** opens tabular data files directly in VS Code as a full-featured interactive data grid.

**Supported file types:**

| Extension | Format | Notes |
|-----------|--------|-------|
| `.parquet` | Apache Parquet | Column names from Parquet schema |
| `.xlsx` | Excel Workbook | Excel-like view: column letters, first row shown as data row 1 |
| `.xlsb` | Excel Binary Workbook | Excel-like view: column letters, first row shown as data row 1 |
| `.csv` | Delimited text | Excel-like view (see below); delimiter auto-detected |
| `.tsv` / `.tab` | Tab-Separated Values | Excel-like view; auto-detects tab delimiter |
| `.json` | JSON Array | Opens as text by default; use **Open with → Data File Preview** for grid view |
| `.nzpreview` | JustyBase Preview (CSV) | Created by **Open in Previewer** |

**Spreadsheet view (`.csv`, `.tsv`, `.tab`, `.xlsx`, `.xlsb`):** these files open in a separate Excel-like viewer, not in the SQL result grid.
- Columns are labelled `A`, `B`, `C`… and rows are numbered by their position in the file; the file's first row is shown as row 1
- The name box shows the active cell or the whole selection (`A1:B2`, `B:B`, `3:5`) and is editable: type a cell or range and press Enter to jump to it; Escape restores the previous reference. A value bar shows the active cell's full text
- Click, Shift+click, drag, arrow keys and Ctrl+A select cells; clicking a row or column number selects that row or column
- Drag across row or column headers to select several whole rows or columns; Ctrl+click or Ctrl+drag adds another row/column block to the selection
- Right-click opens a menu with **Copy**, **Copy cell value**, **Select all** and **Find**. Copy writes the cell selection (all Ctrl+selected areas, as in Excel), unlike the webview's native context menu which only copies DOM text
- **Import to Database…** opens the advanced import wizard for the current sheet: choose the connection, target database/schema and table name, review columns and types, then import. The wizard is available for CSV, TSV, XLSX and XLSB sources
- Excel-style navigation: Ctrl+arrow jumps to the edge of the current block of data (or to the next data cell, or to the sheet edge), Ctrl+Shift+arrow extends the selection to the same cell; Enter/Tab move down/right (Shift reverses), and Ctrl+Home returns to `A1`
- Text that is wider than its column spills into empty cells on the right, as in Excel; numbers stay clipped and right-aligned
- The status bar shows the sheet size and, for the current selection, `Count`, `Sum` and `Average` of numeric cells (up to 200,000 cells per selection)
- **Copy** (Ctrl+C or the toolbar button) writes the selection as tab-separated text, so it pastes into Excel or another spreadsheet with the same grid shape
- Sheets appear as tabs at the bottom of the window
- **Search sheet** (toolbar, Ctrl+F) searches every row of the current sheet, not only the rows on screen; Enter and Shift+Enter (or the arrow buttons) step through matches, and Escape clears the search
- Drag the right edge of a column letter to resize that column; double-click the edge to autofit the column to its content, and Alt+double-click to restore the default width
- Very large sheets are streamed, not capped: the first page renders immediately, the rest arrives in the background, and the DOM only contains the visible rows. The status bar shows the loaded row count while the stream is running. Only columns are capped (`justybase.filePreview.maxColumns`), and the status bar says when the sheet has more columns than that limit
- Sorting, filtering, grouping and Row View are not part of this viewer; open the file in the Data File Preview grid for those, or use **Add to Data Workspace** to query it

**Features of the Data File Preview grid (Parquet and query results):**
- **Multi-sheet support** — each sheet appears as a separate tab in the data grid
- **Sorting** — click the sort icon on a column header to sort ascending/descending; **Shift+Click** adds another sort column (numbered badges show sort priority)
- **Filtering** — global text filter across all columns with debounced search
- **Grouping** — use **Group by column** or drag headers to the grouping panel; nested groups render as collapsible tree rows
- **Cell Selection** — click, Shift+click, Ctrl+click, arrow keys, Ctrl+A
- **Copy** — copy selected cells with or without headers (Markdown or tabbed format)
- **Row View** — compare up to 10 selected rows side by side
- **Value Viewer** — click a cell to see its full content in a modal overlay
- **Export** — full export support (CSV, JSON, XML, SQL INSERT, Markdown, Parquet, XLSB, XLSX) with all sheets exported
- **Configurable row limit** — controlled by `justybase.filePreview.maxRows` (default 20000)

**How to open:**
1. **From Explorer** — double-click any `.parquet`, `.xlsx`, or `.xlsb` file
2. **From Results panel** — click **Open in Previewer** to send query results to a preview tab (no row limit applies)

### Excel (XLSB) - Recommended

**Binary Excel format** - compact, fast, supports large datasets.

| Method | Description |
|--------|-------------|
| **Export to Excel** | Save query results to `.xlsb` file |
| **Export & Open** | Export and immediately open in Excel |
| **Copy as Excel** | Copy results to clipboard (paste directly into Excel) |

**Features:**
- Multiple result sets → multiple sheets
- Preserves numeric types
- Includes SQL queries in separate "_SQL" sheet
- File size ~60% smaller than `.xlsx`

### CSV

Standard comma-separated format, compatible with any application.

CSV can also be streamed as `CSV.GZ` (gzip) or `CSV.ZST` (Zstandard) from the result panel.

### JSON

Export results as JSON array for use in applications and APIs.

### XML

Export results as XML document.

### SQL INSERT

Generate `INSERT INTO` statements for recreating data in another database.

### Markdown

Export results as Markdown table for documentation.

### XPT

XPT is a **Partial** SAS-like macro/file workflow, not a general result-grid import format; verify the selected macro/runtime path before relying on it.

### Markdown File (Combined) — New

**Combined MD export** that bundles all result sets from batch queries into a single `.md` document.

| Method | Description |
|--------|-------------|
| **Export Query to MD File** | Execute SQL, combine all result sets, save as `.md` |
| **Export to MD file** (toolbar) | Combine existing result sets from the Results panel |

**Key features:**
- **Batch query support**: Multiple queries (`SELECT ...; SELECT ...;`) → one `.md` document
- **Each query gets its own section**: SQL code block + results as Markdown table
- **Header with metadata**: Connection name, generation date/time, and source SQL
- **Auto-open after save**: File immediately opens in VS Code editor
- **Save destination choice**: Quick pick offers temp file (auto-save, auto-open) or manual save location
- **Special "MD Export" tab**: Results panel shows the combined document in a read-only text view (non-grid)
- **Row limit**: Tables truncated to 1000 rows in the MD output (total count noted)

**Access:**
- Context menu (right-click SQL selection → **JustyBase** → **Export Query to MD File**)
- Command Palette → `Netezza: Export Query to MD File`
- Toolbar button in Results panel

**Example output:**
```markdown
# SQL Export

**Connection:** MyServer (user@host/database)
**Generated:** 12.06.2026

**Source SQL:**
```sql
SELECT * FROM DIMACCOUNT LIMIT 5;
SELECT * FROM DIMDATE LIMIT 5;
```

---

## Query 1
```sql
SELECT * FROM DIMACCOUNT LIMIT 5
```

### Results
| PARENTACCOUNTKEY | ACCOUNTCODEALTERNATEKEY |
| --- | --- |
| 9 | 1 162 |
| ... | ... |

---

## Query 2
```sql
SELECT * FROM DIMDATE LIMIT 5
```

### Results
| DATEKEY | FULLDATEALTERNATEKEY |
| --- | --- |
| ... | ... |
```

---

## How to Export

### From Results Panel

1. Run your query (`Ctrl+Enter` or `F5`)
2. In the Results panel, use the **Export** split button:
   - Click main button → Export to Excel (default)
   - Click arrow → Select format (CSV, JSON, XML, SQL INSERT, Markdown, Parquet)
   - **Export to MD file** button → Combine all result sets into a Markdown document
   - **Open in Previewer** button → Send results to Data File Preview for full exploration without row limits

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `justybase.filePreview.maxRows` | `20000` | Maximum rows for Parquet and result-grid previews (range 100–1000000). The Excel/CSV spreadsheet view streams all rows and ignores this limit. |
| `justybase.filePreview.maxColumns` | `512` | Maximum columns to read for the spreadsheet preview (range 16–16384). Wider sheets keep the remaining columns in exports and Data Workspaces. |

### From Editor Toolbar

Icons available when editing `.sql` files:

| Icon | Command |
|------|---------|
| 📋 Copy | **Excel Copy** - Copy results as Excel to clipboard |
| 📂 File | **Export to Excel and Open** |
| ⬇️ Export | **Export to Excel** (save file) |
| 📄 Text | **Export to CSV** |


### From Context Menu

Right-click on selected SQL → Select export option

### Keyboard Shortcuts

No default shortcuts, but you can assign them via **Keyboard Shortcuts** settings.

---

## Data Import

### Import from Files

JustyBase can import data from:
- **CSV / TSV** files (auto-detects delimiter)
- **Excel files** (`.xlsx`, `.xlsb`)

The primary file-based import surface is the **Advanced Import Wizard**.

### Data Workspace SQL

With the optional DuckDB + Files extension, open **Data Workspace Manager** and create a persistent DuckDB workspace. Add one or more local `.csv`, `.tsv`, `.xlsx`, or `.parquet` sources; a workspace with one source is the single-file SQL workflow. Sources are materialized as real local tables, so they can be joined directly:

```sql
SELECT c.id, c.name, o.total
FROM "/data/customers.csv" AS c
JOIN "/data/orders.csv" AS o ON o.customer_id = c.id;
```

Use **Open SQL** in the manager to query the local tables. Right-clicking a CSV or Excel file and choosing **Open in Data File Preview** still provides a preview; its **Add to Data Workspace** button can add the file to a new or existing workspace. Refresh replaces only that source table; other local tables and views remain intact.

**How to use:**

1. Right-click on a table in Schema Browser → **Import Data**
2. Or use Command Palette → `Netezza: Import Data`
3. Select source file
4. Review the initial preview, detected delimiter / decimal style, and warnings
5. Adjust preview row count or active sheet when needed
6. Rename target columns, exclude columns, reorder them, or override inferred types
7. Review generated `CREATE TABLE`, direct load SQL, or the generated plan/workflow preview
8. Execute the import

**Features:**
- Automatic data type detection (INTEGER, BIGINT, NUMERIC, VARCHAR, DATE, TIMESTAMP)
- Locale-aware number parsing (handles both `.` and `,` decimals)
- UTF-8 and UTF-16LE BOM handling; an explicit `encoding` option is available to programmatic callers
- CSV/TXT/TSV quotes and embedded newlines are parsed as logical records
- Conservative CSV header detection: a first record without data-like cells followed by data rows is treated as a header; ambiguous all-text files keep the header-first default
- Progress reporting for large files with cooperative cancellation, including the advanced wizard
- Column-level include/exclude, reorder, rename, and type override controls
- Background validation with progressive issue reporting while the wizard remains open (controlled by the `justybase.importWizard.backgroundValidation*` settings)
- Warnings for rows whose column count differs from the header; extra fields are ignored
- Failed batch imports roll back their transaction (where the dialect supports one) and drop a newly created target table instead of leaving a partial load
- SQL preview for both the table-creation step and the load step when direct load SQL is available
- Plan / workflow preview for dialects that use a guided or staged import path instead of direct load SQL

Programmatic callers can pass `delimiter`, `skipRows`, `maxErrors`, and `encoding` through `ImportColumnOptions`. Netezza targets accept `TABLE`, `SCHEMA.TABLE`, `DATABASE.SCHEMA.TABLE`, and the database-only `DATABASE..TABLE` notation.

### Advanced Import Wizard details

The Advanced Import Wizard is intended for higher-confidence imports than a one-shot upload flow.

It provides:

1. A prominent import-target banner with the fully qualified destination table and an on-demand editor for connection, database, schema, table name, and create/append mode.
2. A source card with the file format, worksheet, and preview-row controls; technical metadata is kept in a collapsed section.
3. A column-mapping editor for target names, inclusion, ordering, and selected database types.
4. A collapsible preview grid with cell-level issue highlighting from validation.
5. Collapsed SQL Preview cards for `CREATE TABLE`, direct load SQL, or a generated execution plan when the adapter runs in workflow mode.
6. Background validation progress so larger files can keep surfacing issues after the initial preview is already usable. The default sample is 20,000 rows; the parsed sample is cached per sheet/header selection, so column edits do not re-read the file, and only a bounded number of issue details is sent to the webview while the full count is reported.
7. Type inference scans every row of the imported sheet, so a column that turns textual late in the file is still detected. The inference engine uses fast paths for plain integers, ISO dates/timestamps and already-textual columns, so a 700,000-row workbook is analyzed in seconds rather than minutes.
8. Netezza imports show two phases: the external data transfer with a percentage and the number of bytes read from the source stream, then database processing. When the user can read `_V_LOAD_STATUS`, the wizard also shows rows inserted/rejected and bytes processed/downloaded in both phases; monitoring uses a separate connection, is polled every few seconds, and never fails the import if the view is unavailable. If the database is quiet, the panel keeps the known total and rows/bytes read into the stream visible and adds a waiting hint after a few seconds.

For some dialects, the wizard may generate a workflow or plan document instead of direct load SQL. In those cases, the UI still shows the create step together with the next actions required to complete the staged import.

### Import from Clipboard

Paste data directly from Excel or other sources.

**How to use:**

1. Copy data in Excel (or other source)
2. Right-click on table in Schema Browser → **Import Clipboard Data**
3. Or use the clipboard toolbar button.
4. Data is automatically parsed and inserted

**Supported clipboard formats:**
- Excel XML Spreadsheet (when copying from Excel)
- Tab-separated text
- Comma-separated text

### Smart Paste

Automatically detect and format pasted data as SQL.

**How to use:**

1. Copy data from Excel or other source
2. Position cursor in SQL editor
3. Use Command Palette → "Netezza: Smart Paste (Auto-detect Tabular Data)" or right-click context menu
4. Extension auto-detects format and generates `INSERT` statement

**Detects:**
- Excel XML format
- CSV format
- Tab-separated format

---

## Tips

### Large Exports

- XLSB format handles millions of rows efficiently
- Progress indicator shows export status
- Consider using `LIMIT` for initial testing

### Import Performance

- For very large files, import may take several minutes
- Extension creates temporary files during import
- Import uses batch operations for speed

### Clipboard Limitations

- Clipboard imports are best for smaller datasets
- For large data, use file import instead

---

## Commands Reference

| Command | Description |
|---------|-------------|
| `Netezza: Export Query to Excel` | Export to XLSB file |
| `Netezza: Export Query to CSV` | Export to CSV file |
| `Netezza: Export Query to Parquet` | Export to Parquet file |
| `Netezza: Export Query to MD File` | Export all result sets as combined Markdown file |
| `Netezza: Export Query to Excel and Open` | Export and open immediately |
| `Netezza: Copy Query Results as Excel to Clipboard` | Copy for pasting into Excel |
| `Netezza: Open Results in Data File Preview` | Send active grid results to the Data File Preview viewer |
| `Netezza: Import Data to Table` | Import from file |
| `Netezza: Import Clipboard Data to Table` | Import from clipboard |
| `Netezza: Smart Paste` | Auto-detect and paste data |
