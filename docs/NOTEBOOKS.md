# SQL Notebooks

JustyBase integrates with the VS Code Notebook API to provide interactive SQL notebooks. Notebooks let you combine executable SQL cells, inline results, and rich visualizations in a single document — ideal for ad-hoc analysis, reproducible reports, and collaborative data exploration.

---

## Creating a Notebook

| Method | Steps |
|--------|-------|
| **Command Palette** | `Ctrl+Shift+P` → **New Netezza SQL Notebook** |
| **File Explorer** | Create a new file with `.sqlnb` or `.nzsql-nb` extension |

A new notebook opens with a starter SQL cell pre-populated.

---

## Cell Types

| Cell Type | Description |
|-----------|-------------|
| **Code** (`sql`) | SQL statement or batch. Executed against the active Netezza (or other supported database) connection. |
| **Markdown** | Rich-text documentation using Markdown. Rendered inline by VS Code — no execution needed. |

---

## Executing Cells

### Cell Toolbar Button
Each SQL cell has a toolbar with **Execute** (▶) and **Stop** (⬛) buttons.

- Click **Execute** on a cell to run its SQL
- Results appear inline as an HTML table directly below the cell
- Click **Stop** to cancel a running query

### Execution Order
Cells execute sequentially in the order you click them. Each cell's execution is independent — results are not shared between cells.

### Cancellation
Click the **Stop** button in the cell toolbar during execution. The query is cancelled at the database level and the cell shows an inline error message.

---

## Inline Results

After execution, each cell displays:

1. **Row count** — shown in the cell output header
2. **HTML table** — the result data rendered as a formatted table with:
   - Alternating row colors
   - Sticky column headers
   - `NULL` values displayed in italic gray
   - Row numbers
   - Row-limit indicator when the configured limit is reached
   - Records-affected count for DML statements

### Multiple Result Sets
If your SQL produces multiple result sets (e.g., multiple `SELECT` statements), each result set appears as a separate table with its own heading.

---

## Full Grid Panel

Click the **Full Grid** button in the cell's **status bar** (the bar below the cell showing cell language and execution time) to open the full interactive grid in a separate webview panel.

| Feature | Description |
|---------|-------------|
| **Sorting** | Click any column header to sort ascending. Click again for descending. An arrow indicator (▲/▼) shows the current sort direction. |
| **Global Filter** | Type in the filter input to search across all columns in real time. The row count updates to show filtered vs. total rows. |
| **Clear Filter** | Click ✕ **Clear** to reset the filter. |
| **XLSB Export** | Click 📥 **Export to XLSB** to export all rows (not just filtered) to an Excel Binary Workbook. A native save dialog opens — after saving, you can open the file directly from the notification. |
| **SQL Preview** | The executed SQL is shown at the bottom of the panel. |
| **Reopen past results** | `Ctrl+Shift+P` → **JustyBase: Open Notebook Result in Full Grid...** shows a quick-pick list of all previously executed cells in the session. |

---

## IntelliSense in Notebooks

SQL cells in notebooks have the same language support as regular `.sql` files:

- **Code completions** (`Ctrl+Space`) — tables, columns, views, functions, keywords
- **Hover tooltips** — column types, table descriptions
- **Diagnostics** — real-time linting and parser validation with error codes (NZ001, SQL003, etc.)
- **Signature help** — function parameter hints
- **Code formatting** — format all SQL in a cell via `Shift+Alt+F`
- **Go to Definition** — for CTEs, subquery aliases, and temp tables

The language server (LSP) activates for notebook cells automatically.

---

## Connection Handling

Notebooks use the same connection infrastructure as regular SQL files:

- **Active connection** — cells execute against the currently selected connection in the JustyBase sidebar
- **Per-cell connections** — not yet supported; all cells use the active connection
- **Cancellation** — each cell execution is independent; cancelling one cell does not affect others

> **Important:** Each notebook cell execution opens a new database connection and closes it after completion. Persistent connections (per-tab keep-connection) do not apply to notebook cells.

---

## File Format

Notebooks are stored as plain JSON (`.sqlnb` / `.nzsql-nb`):

```json
{
  "cells": [
    {
      "language": "sql",
      "value": "SELECT * FROM SYSTEM..TABLES LIMIT 10;",
      "kind": 2
    }
  ]
}
```

- `kind: 2` = Code cell
- `kind: 1` = Markdown cell
- The JSON format is human-readable and version-control friendly

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `justybase.query.rowLimit` | 200000 | Maximum rows fetched per notebook cell execution |
| `justybase.query.executionTimeout` | 3600 | Query timeout in seconds |

---

## Limitations

- **Per-cell connection assignment** is not currently available
- **Cell variable sharing** (piping results between cells) is not supported
- **Notebook export** (e.g., exporting all cells and results as a report) is not yet implemented — use the Full Grid panel for individual result export
