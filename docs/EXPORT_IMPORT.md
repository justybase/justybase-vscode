# Data Export & Import Reference

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
| `.xlsx` | Excel Workbook | First row treated as header |
| `.xlsb` | Excel Binary Workbook | First row treated as header |
| `.tsv` / `.tab` | Tab-Separated Values | Auto-detects tab delimiter |
| `.json` | JSON Array | Opens as text by default; use **Open with → Data File Preview** for grid view |
| `.nzpreview` | JustyBase Preview (CSV) | Created by **Open in Previewer** |

**Features:**
- **Multi-sheet support** — each sheet appears as a separate tab in the data grid (for `.xlsx` and `.xlsb` files)
- **Sorting** — click the sort icon on a column header to sort ascending/descending; **Shift+Click** adds another sort column (numbered badges show sort priority)
- **Filtering** — global text filter across all columns with debounced search
- **Grouping** — drag column headers to the grouping panel
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

### JSON

Export results as JSON array for use in applications and APIs.

### XML

Export results as XML document.

### SQL INSERT

Generate `INSERT INTO` statements for recreating data in another database.

### Markdown

Export results as Markdown table for documentation.

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
| `justybase.filePreview.maxRows` | `20000` | Maximum rows to display in the Data File Preview (range 100–1000000). Larger values impact performance. |

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
- UTF-8 BOM handling
- Progress reporting for large files
- Column-level include/exclude, reorder, rename, and type override controls
- Background validation with progressive issue reporting while the wizard remains open
- SQL preview for both the table-creation step and the load step when direct load SQL is available
- Plan / workflow preview for dialects that use a guided or staged import path instead of direct load SQL

### Advanced Import Wizard details

The Advanced Import Wizard is intended for higher-confidence imports than a one-shot upload flow.

It provides:

1. A source inspector with file format, delimiter, decimal style, validation sample size, and sheet details.
2. A column-mapping editor for target names, inclusion, ordering, and selected database types.
3. A preview grid with cell-level issue highlighting from validation.
4. SQL Preview cards for `CREATE TABLE`, direct load SQL, or a generated execution plan when the adapter runs in workflow mode.
5. Background validation progress so larger files can keep surfacing issues after the initial preview is already usable.

For some dialects, the wizard may generate a workflow or plan document instead of direct load SQL. In those cases, the UI still shows the create step together with the next actions required to complete the staged import.

### Import from Clipboard

Paste data directly from Excel or other sources.

**How to use:**

1. Copy data in Excel (or other source)
2. Right-click on table in Schema Browser → **Import Clipboard Data**
3. Or use toolbar button ![clippy]($(clippy))
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
