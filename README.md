<tr>
  <td>
    <h1>JustyBase</h1>
    <p><b>Netezza / PureData System for Analytics</b></p>
    <p><i>Zero Config • Pure JavaScript Driver • AI Copilot Assistant</i></p>
  </td>
</tr>

---

[![Release](https://github.com/justybase/justybase-vscode/actions/workflows/release.yml/badge.svg?branch=master)](https://github.com/justybase/justybase-vscode/actions/workflows/release.yml)

A powerful, **Zero Config** VS Code extension for working with IBM Netezza / PureData System for Analytics databases.
Distinct from other extensions, JustyBase includes a **custom Node.js-based Netezza driver** provided by `@justybase/netezza-driver`, eliminating the need to install or configure IBM ODBC drivers. Just install and connect!

### Three powerful workflows to discover

| | What you can do | Start here |
|---|---|---|
| **Explore results visually** | Turn a query result into column profiles, distributions, pivots, and time-based summaries without writing another query. | [Explore data](#explore-data) |
| **Query local files** | Join and aggregate Excel, CSV/TSV, Parquet, or Avro files with SQL through DuckDB — or open and edit a local Access database. | [File SQL & Access](#local-files-as-sql-connections) |
| **Give AI your schema safely** | Connect Copilot Chat, Cursor, Claude Desktop, or another MCP client to read-only Netezza schema tools. | [Netezza MCP Server](docs/MCP_SERVER.md) |

These workflows share the same connection panel, SQL editor, results grid, export tools, and VS Code-native experience.

> **Marketplace identity:** The active core extension is `krzysztof-d.justybaselite-netezza`. This established identity is retained so existing users receive updates automatically.

## Quick start

1. Install **JustyBase SQL Editor (Netezza)** from the VS Code Extensions view.
2. Open the **Netezza** view in the Activity Bar and select **Connect**.
3. Enter the server host, user, password, and database, then open or create a `.sql` file.
4. Run the current statement or selection with `Ctrl+Enter` / `F5`.

### Packaging transparency

Published VSIX packages use readable JavaScript bundles with source maps that include the original TypeScript source. The release workflow checks every VSIX for those maps, established Marketplace identity, unexpected executable files, and dynamic code construction before publication. Db2 setup never changes the Windows registry automatically; any ODBC registration must be performed manually by an administrator.

### Database support model

| Target | Install | SQL tooling |
| ------ | ------- | ----------- |
| **IBM Netezza / PureData** | Core extension (this package) | **First-class** — full dialect stack: Chevrotain parser, NZPLSQL procedure diagnostics, semantic tokens, LSP completion/navigation/rename, SQL/NZ/NZP linter rules, Netezza-specific Copilot tools, GROOM/monitor/ETL workflows, and more |
| **File SQL (Excel / CSV / Parquet / Avro)** | Core extension **+** [DuckDB + Files pack](extensions/duckdb) | **First-class file workflow** — query local files through in-memory DuckDB with dedicated parser/authoring, completion, snippets and read-only/editable-copy boundaries |
| **Microsoft Access** | Core extension **+** [Access pack](extensions/access) | **Preview companion** — query and edit local `.mdb` / `.accdb` files through the bundled UCanAccess bridge; requires Java 11+ |
| **Oracle** | Core extension **+** [Oracle support pack](extensions/oracle) | **Near-full companion** — dedicated Oracle Chevrotain parser and PL/SQL validation in core, grammar/snippets, advanced DDL/import/export, explain graph, tuning advisor, session monitor, and ORA quality rules; requires optional VSIX for `oracledb` connectivity. Not Netezza parity (no NZ/NZP depth, GROOM/ETL, or skew Copilot). See [docs/oracle.md](docs/oracle.md) |
| **Db2 LUW** | Core extension **+** [Db2 support pack](extensions/db2) | **Near-full companion runtime** — advanced connect/metadata/DDL/import/explain/maintenance with dedicated Db2 parser runtime, quality rules, and live suite. Native `ibm_db` VSIX. See [docs/db2.md](docs/db2.md) |
| **PostgreSQL / MySQL / MS SQL Server / Vertica / Snowflake / DuckDB** | Core extension **+** separate optional extension per database | **Companion runtimes with varying editor depth** — see the detailed status table below. PostgreSQL, MySQL, MS SQL Server and DuckDB ship dedicated Chevrotain lexers/parsers; the remaining packs reuse the shared base grammar |

JustyBase is built **first and foremost for Netezza**. Editor depth varies by dialect — **Oracle is the strongest optional SQL/PL/SQL editor**, while **PostgreSQL, MySQL, Db2, and MS SQL Server** also ship dedicated parser runtimes and quality rules on the shared LSP stack. DuckDB, Vertica, Snowflake, SQLite, Access, and File SQL provide companion runtimes with reduced editor intelligence.

Netezza SQL files support SAS-like preprocessing macros, including `%let`, `%if/%do/%end`, `%export`, `%include`, and `%python` (which substitutes a Python script's standard output).

## Features

<img src="https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/general_01.png" alt="General Overview" width="700">

### 🤖 AI Copilot Assistant

<img src="https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/ai_fix_errors_chat.png" alt="AI Copilot Chat" width="680">

📖 Read the full Copilot documentation: [Copilot SQL Assistant](docs/COPILOT_SQL_ASSISTANT.md)

- **Chat Participant `@sql-copilot`**: Interactive conversations with full database context directly in Copilot Chat. Use commands like `/schema`, `/optimize`, `/fix`, `/explain`, `/best-practices`.
- **Language Model Tools**: metadata, DDL, local validation, file inspection, and planner-only tools. AI never executes SQL, imports, exports, or procedures:
    - `#schema` - Get table DDL for tables in current SQL
    - `#getColumns` - Get column definitions for specific tables
    - `#getTables` - List all tables in a database
    - `#explainPlan` - Get query execution plan
    - `#searchSchema` - Find tables/columns by pattern
    - `#tableStats` - Get row count, skew, distribution info
    - `#dependencies` - Find what uses this object
    - `#workspaceProfiles` - Show workspace-curated Copilot table profiles and notes
    - `#validateSqlParser` - Validate SQL with parser/linter (offline)
    - `#validateSqlOnDatabase` - Validate SQL on database runtime (EXPLAIN)
    - `#getSqlDiagnostics` - Read SQL diagnostics with SQL/NZ/NZP codes
    - `#inspectImportFile` - Inspect source file and infer import schema/preview
    - `#proposeImportMapping` - Propose source-to-target import mapping and CREATE SQL
- **Procedure workflow**: Copilot can analyze and validate procedure source locally; compile and run it manually using the regular extension commands. 📖 [Procedure workflow](docs/PROCEDURE_COMPILATION.md)
- **Copilot Table Profiles View**: Curate important tables in a dedicated explorer view (`Copilot Table Profiles`), add usage notes, and mark profiles for auto-include or one-time include in the next Copilot request.
- **Auto Mode**: Apply suggested fixes or optimizations using the built-in diff editor (modal review dialog). Options: Apply Changes, Apply & Close Diff, Discard.
- **Interactive Mode**: Open Copilot Chat for a back-and-forth discussion; suggestions stay in Chat unless you explicitly apply them with `/edit`.
- **Generate SQL from Description**: Describe what you need in natural language, and Copilot generates the SQL using your database schema context.
- **Enhanced Agent Capabilities**: Includes multi-round tool orchestration with execution budgets, standardized tool outputs (`summary/data/errors/next-actions`), and follow-up prompt suggestions for `@sql-copilot`.
- **Describe Data**: From the Results panel you can request Copilot to describe a result set (first 50 rows). A privacy confirmation modal appears before any data is sent.
- **Commands**: Fix/Optimize/Explain/Ask/Generate/Rewrite to Best Practices (each available in Auto and Interactive variants).

### 🔒 Privacy & AI Data Transmission

This extension integrates with GitHub Copilot for AI-powered SQL assistance.
**All AI features transmit data to external Microsoft/GitHub servers.**

Key data transmitted:

- SQL code and queries
- Database schema information (DDL)
- Catalog table statistics and DDL metadata (when requested)
- Query history (for context - limited to 5 most recent queries, truncated to 180 characters each)

**Privacy confirmation dialogs** appear before sending data to AI. You can configure this behavior in settings: `justybase.copilot.skipPrivacyConfirmation`

#### Disabling AI Features

You can completely disable all AI features to prevent any data transmission:

```json
// In settings.json:
"justybase.copilot.enabled": false
```

When disabled:
- All AI commands (Fix SQL, Optimize SQL, Explain SQL, Generate SQL) will show a message that AI features are disabled
- No data will be sent to GitHub Copilot
- The `@sql-copilot` chat participant will still be registered but will not function

**For corporate environments:** Please review your organization's data policy before using AI features. See [Privacy & Data Security](docs/COPILOT_SQL_ASSISTANT.md#-privacy--data-security) for full details.

### Query Execution

- **Zero Configuration**: Connect immediately using host, user, and password. No ODBC setup required.
- **Per-Tab Database**: Switch active database for specific tabs using the status bar selector.
- **Per-Tab Connection**: Assign different connections to different SQL tabs for multi-database workflows.
- **Auto-Recovery**: Automatically detects broken connections and retries queries.
- **Keep Connection**: Toggle persistent connections globally or per-tab to avoid reconnection overhead.
- **Progressive Results**: Results appear immediately as queries finish, even when running multiple statements.
- **Sequential Execution**: Run complex scripts with multiple statements safely.
- **Run Selection**: Execute selected text or the current statement (`Ctrl+Enter` / `F5`).
- **Cancel Query**: Stop long-running queries instantly.
- **Explain Plan**: Visualize query execution plan (`Ctrl+L`).
- **SQL Formatter**: Auto-format SQL code (`Shift+Alt+F`).
- 📖 **[Query Execution & Analysis Guide](docs/QUERY_EXECUTION.md)**

### Local files as SQL connections

The connection panel also includes two local-file workflows. They are separate from the regular server database connections:

- **File SQL (DuckDB)** — install the [DuckDB + Files pack](extensions/duckdb), select **Excel / CSV / Parquet / Avro (DuckDB)** in **Connect to Database**, and choose a `.xlsx`, `.csv`, `.tsv`, `.parquet`, or `.avro` file. The file is exposed as a table or view for SQL queries; an `.xlsx` workbook also exposes its sheets. The Explorer context action **Query File with SQL (DuckDB)** opens the same workflow directly. Use **Query Multiple Files with SQL (DuckDB)** to select several local files and run joins, unions, CTEs, and aggregations in one read-only workspace. Sources are available as views named by their full path, sheet views are suggested by SQL completion, and **Add Files to Active File SQL Workspace (DuckDB)** extends the current workspace. **Open Saved File SQL Workspace** reopens a saved workspace.
- **Microsoft Access** — install the [Access pack](extensions/access), select **Microsoft Access** in **Connect to Database**, and choose an `.mdb` or `.accdb` file. SQL can read and modify the Access file through the UCanAccess bridge. Java 11+ must be available on the machine; no ODBC driver is required.

For File SQL, views are read-only by default. Enable **Editable copy** when creating the connection to edit a materialized table, then run **JustyBase: Save File Edits**. CSV/TSV, Parquet, and XLSX are written back to the selected file; Avro edits are saved as a new `_edited.parquet` file. XLSX and Avro support may download the corresponding DuckDB extension the first time they are used.

📖 **[File SQL guide](docs/file-sql.md)** · **[Microsoft Access guide](extensions/access/README.md)**

### Explore data

The **Explore** view turns a result set into a quick data-profiling workspace. Open it from the Results panel to inspect column types and cardinality, distinct values, null counts, numeric summaries, distributions, and the most common values. Use **Pivot** for grouped summaries and **Composer** for time-based exploration; generated SQL can be previewed or opened in the editor when you want to keep the analysis.

<img src="https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/explore_data.png" alt="Explore query results with column profiles, distributions, and summaries" width="100%">

The analysis uses the result set locally where possible, while actions that need the complete dataset can run a focused database query. See [SQL results filtering and aggregation](docs/SQL_RESULTS_FILTERING.md) for the exact data boundaries.

### 📓 SQL Notebooks

Use the VS Code Notebook API to create interactive SQL notebooks with inline results.

- **New Notebook**: Command Palette → **New Netezza SQL Notebook** creates a `.sqlnb` file.
- **Per-cell execution**: Execute SQL cells individually — results render as HTML tables directly inline below each cell.
- **Full Grid view**: Click the **Full Grid** button in the cell status bar to open a standalone interactive panel with:
  - **Sorting** — click column headers to sort ascending/descending
  - **Global filter** — type to search across all columns in real time
  - **XLSB export** — one-click export to Excel Binary Workbook format
- **IntelliSense**: Full code completion (tables, columns, functions), hover tooltips, and parser diagnostics work inside SQL cells.
- **File format**: Notebooks are saved as `.sqlnb` or `.nzsql-nb` plain JSON files.
- **All connections supported**: Notebooks use the same active connection as regular SQL editors, including per-tab database and connection switching.
- 📖 **[Notebooks Guide](docs/NOTEBOOKS.md)**

### 📜 Query History

- **Persistent History**: All executed queries are automatically saved with timestamps.
- **Search & Filter**: Quickly find previously run queries by content, tags, favorites, and saved filter views.
- **Quick Re-run with Parameters**: Reopen history queries with variable placeholders (e.g., `:id`, `${date_from}`, `{schema}`) and fill values before execution.
- **Extended View & Export**: Open an extended history panel, search active + archive history, and export history to CSV/JSON.
- **Access**: View → Query History in the Netezza panel.

### 🔍 File Search

Search across `.sql` and `.py` files in your workspace by content and filename with VS Code‑style options.

- **Search modes**:
  - **Raw** — search everything including comments and string literals
  - **Exclude Comments** — skip `--` and `/* */` comments
  - **Exclude Comments & Strings** — skip comments and `'...'` literals
- **Toggle options**: **`Aa`** (match case), **`ab`** (whole word), **`.*`** (regex) — matching VS Code's native search widget.
- **Replace All**: Replace all occurrences across matching files with preview confirmation and dirty-file skipping.
- **File‑name search**: Files whose name matches the term always appear in a separate **Filename Matches** section.
- **Result grouping**: Results can be grouped by modification time (`Today`, `This Week`, `This Month`, `Older`) with collapsible group headers.
- **Auto‑search**: Changing any toggle or option automatically re‑triggers the search.
- **Access**: View → File Search in the Netezza panel.

### 🔌 Netezza MCP Server

JustyBase can expose a **read-only Netezza MCP server** so AI tools can understand your databases without receiving write capabilities or arbitrary SQL execution. Use it in VS Code Copilot Chat, or enable the local HTTP transport for Cursor, Claude Desktop, OpenCode, and other MCP clients.

- Select a saved Netezza connection in **JustyBase Settings → MCP Server**.
- Choose **Copilot Chat (VS Code)** or **Local HTTP Server** (or both).
- Let the agent list databases, search schemas, inspect columns, read DDL, validate SQL, and explain a `SELECT` query.
- Credentials stay in VS Code Secret Storage and are passed only to the local child process; the server never reads table data and never accepts arbitrary SQL.

📖 **[MCP setup, tools, security model, and client configuration](docs/MCP_SERVER.md)**

### ⭐ Favorites & SQL Snippets

- **Favorites Tree**: Save tables/views/procedures and SQL snippets in a structured Favorites node (folders, notes, drag & drop).
- **Parameterized Favorites**: Opening a SQL favorite resolves variables with an input prompt (`${var}`, `$var`, `{var}`), so one snippet can be reused with different values.
- **Inline SQL Variables**: Declare execution-scoped values directly in SQL with SAS-style `%let` directives, for example `%let points_cutoff = 20;`, then reuse them as `$points_cutoff`, `${points_cutoff}`, or `&points_cutoff`. Text values can be declared as SQL literals, for example `%let region = 'EAST';`, so substitution keeps the quotes. `%EVAL(...)` supports simple arithmetic, `%SQL(...)` substitutes the first value from an inner query, `%SQLLIST(...)` substitutes a SQL literal list from an inner query, empty `%SQLLIST(...)` results become `NULL` so `IN (...)` stays valid SQL, `%EXPORT(...)` writes an inner query result to XLSX/XLSB, `%PUT ...;` writes resolved messages to the execution log with a `>>> %PUT:` prefix, `%IF ... %THEN %DO; ... %ELSE %DO; ... %END;` runs only the active branch, and `%INCLUDE 'path.sql';` composes local script files with one shared macro environment.
- **Examples**: Inline SQL variable declarations support `%let`, `%EVAL(...)`, `%SQL(...)`, `%SQLLIST(...)`, `%EXPORT(...)`, `%PUT ...;`, `%IF/%ELSE/%END`, and `%INCLUDE` for reusable query workflows, spreadsheet exports, and log-friendly debugging.
- **Repository Sync**: Favorites are synced to `.vscode/netezza-favorites.json` in the workspace, making favorites shareable via Git.
- **Copilot Integration**: Mark favorite profiles/snippets for auto-include, disable/include-once, and use curated context in `@sql-copilot`.

### 🔎 Schema Browser

<img src="https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/schema_panel.png" alt="Schema Browser Context Menu" width="520">

- **Object Explorer**: Browse Databases, Schemas, Tables, Views, Procedures, Sequences, and Synonyms.
- **Search**: Quickly find objects across the entire system.
- **Rich Metadata**: View column types, primary keys, and specialized object properties.

### 📊 Results & Export

- **Data Grid**: Full-featured grid with filtering, sorting, and cell selection. Click a column sort icon to sort ascending/descending; **Shift+Click** adds another sort column (priority badges 1, 2, 3… appear on the sort icons).
- **Multi-Grid Export**:
    - **Excel (XLSB)**: Export all result sets to a single Excel file with multiple sheets. (Support for XLSX/XLSB is provided by `@justybase/spreadsheet-tasks`.)
    - **Parquet**: Export to Apache Parquet columnar format, ideal for analytical workloads and large datasets.
    - **CSV, JSON, XML, SQL INSERT, Markdown**: Multiple export format options.
    - **Combined MD Export**: Bundle all result sets from batch queries into a single Markdown file with SQL + results per query. Auto-opens after save.
    - **Open Immediately**: Option to open Excel files automatically after export.
- **Data File Preview**: Open Parquet (`.parquet`), Excel (`.xlsx`, `.xlsb`), and custom preview (`.nzpreview`) files in a full-featured data grid viewer with sorting, filtering, grouping, cell selection, and export — directly from the VS Code explorer or by sending results from the Results panel via **Open in Previewer**.
- 📖 **[Full Export/Import Reference](docs/EXPORT_IMPORT.md)**

### 📥 Data Import & Smart Paste

- **Advanced Import Wizard**: Import CSV/TSV/Excel files into new or existing tables with live preview, target-column rename, include/exclude toggles, reordering, and type overrides.
- **Background Validation**: Large files continue validating while the wizard stays open, surfacing row/column issues progressively.
- **SQL / Workflow Preview**: Review generated `CREATE TABLE`, direct load SQL, or a generated plan/workflow when the dialect needs a guided import path.
- **Sheet & Preview Controls**: Change preview row count and, for spreadsheet sources, switch the active sheet directly in the wizard.
- **Locale-Aware**: Correctly handles numbers with comma decimals based on content.
- **Smart Paste**: Paste data directly from Excel or other sources; the extension auto-detects structure (Excel XML, CSV, etc.) and generates an `INSERT` statement. Access via Command Palette or context menu.
- 📖 **[Full Export/Import Reference](docs/EXPORT_IMPORT.md)**

### 🛠️ Table & Object Management

<img src="https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/view_edit_data_01.png" alt="View and Edit Data" width="700">

Right-click on objects in the Schema Browser for powerful context actions:

- **Maintenance**:
    - **Groom Table**: Reclaim space and organize records.
    - **Generate Statistics**: Update optimizer statistics.
    - **Truncate Table**: Quickly empty tables.
    - **Recreate Table**: Generate a maintenance script to recreate a table (useful for skew fixing).
- **Modification**:
    - **Rename Table**: Safely rename tables.
    - **Change Owner**: Transfer object ownership.
    - **Add Primary Key**: GUI for adding PK constraints.
    - **Add Foreign Key**: GUI for adding FK constraints.
    - **Add Unique Constraint**: GUI for adding unique constraints.
    - **Add/Edit Comments**: Manage object comments.
- **Analysis**:
    - **Compare With...**: Compare table structures or procedure definitions with another object.
    - **Check Data Skew**: Analyze distribution of data across slices.
    - **View/Edit Data**: Edit table rows directly (with limit safeguards).
- 📖 **[Schema Comparison Guide](docs/SCHEMA_COMPARE.md)**

### ⚡ Professional Development

- **DDL Generation**: Generate production-ready DDL for Tables, Views, and Procedures (including arguments and returns).
- **Batch DDL Export**: Export DDL for an entire database or all objects of a type (Tables, Views, Procedures) at once.
- **Procedure Support**:
    - **Create Procedure**: Template for new NZPLSQL procedures.
    - **Create View**: Wizard for drafting `CREATE OR REPLACE VIEW` statements (with optional column aliases).
    - **Create External Table**: GUI wizard for creating Netezza external tables with file format options.
    - **Notice Handling**: Captures and prints `RAISE NOTICE` output to the "Netezza Logs" channel.
    - **Signature Support**: Correctly parses and displays full procedure signatures.

### 📈 Query Monitoring Dashboard

- **Session Monitor**: Real-time view of active sessions, running queries, and system resources.
- **Running Queries**: View currently executing queries with estimated cost, elapsed time, and ability to kill sessions.
- **Resources**: Monitor CPU, Memory, Disk, and Fabric utilization across SPUs with system utilization summary.
- **Storage Statistics**: Analyze table storage, used bytes, and data skew (weighted average) per schema and database.

<img src="https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/session_monitor_01.png" alt="Session Monitor Dashboard" width="700">
<img src="https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/session_monitor_02.png" alt="Running Queries" width="700">

- **Access**: Right-click on a database in the Schema Browser → **Open Monitor Dashboard**.

### 🗺️ Entity Relationship Diagram (ERD)

- **Visual Schema Exploration**: Generate interactive diagrams showing tables and their relationships.
- **Foreign Key Visualization**: Display Primary Key (PK) and Foreign Key (FK) relationships between tables.
- **Column Details**: View column names, data types, and key indicators directly in the diagram.

<img src="https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/ERD_01.png" alt="Entity Relationship Diagram" width="700">

- **Access**: Right-click on a schema in the Schema Browser → **Generate ERD**.

### 🔄 ETL Designer

<img src="https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/etl_01.png" alt="ETL Designer Workflow" width="700">

- **Visual Workflow Designer**: Create data workflows with drag-and-drop nodes on a canvas.
- **Task Types**:
    - **SQL Task**: Execute SQL queries against the connected Netezza database.
    - **Python Script**: Run Python scripts (inline or from file).
    - **Export Task**: Export query results to CSV or XLSB files.
    - **Import Task**: Import data from CSV/XLSB files into tables.
    - **Container Task**: Group multiple tasks for organized workflows.
- **Connections**: Draw arrows between tasks to define execution order.
- **Parallel Execution**: Unconnected tasks run in parallel; connected tasks run sequentially.
- **Project Management**: Save and load ETL projects as `.etl.json` files.
- **Access**: Command Palette → **Netezza: Open ETL Designer** or Schema Browser toolbar.
- 📖 **[ETL Designer Guide](docs/ETL_DESIGNER.md)**

### 🔍 SQL Linter & Validator

- **Real-time Feedback**: Get instant warnings and errors as you type SQL.
- **13 Built-in Rules**: Detect common anti-patterns like `SELECT *`, `DELETE` without `WHERE`, `CROSS JOIN`, `UPDATE ... AS`, and more.
- **Configurable Severity**: Set each rule to `error`, `warning`, `hint`, or disable with `off`.
- **Smart Detection**: Ignores patterns inside strings and comments.
- **Chevrotain Parser Validation**: Advanced AST-based semantic validation that checks:
    - Unknown columns and tables (SQL003, SQL004)
    - Ambiguous column references (SQL008)
    - Invalid data types (SQL013, SQL014)
    - Unknown functions (SQL011)
    - CTE and subquery scope analysis
    - NZPLSQL procedure variable validation
- 📖 **[SQL Linter Reference](docs/SQL_LINTER.md)**

### ✂️ SQL Snippets

- **58 Code Snippets**: Type `nz` followed by a keyword to quickly insert SQL templates.
- **Categories**: Basic SQL, DDL, Netezza-specific (GROOM, GENERATE STATISTICS), NZPLSQL procedures, query patterns.
- **Usage**: Type prefix (e.g., `nzselect`, `nzprocedure`, `nzgroom`) → Press `Tab`.
- 📖 **[Full Snippets Reference](docs/SNIPPETS.md)**

## Requirements

- **VS Code**: v1.103.2 or higher.
- **No external drivers required** for Netezza: the core extension bundles its own pure JavaScript/TypeScript driver.

## Optional Database Support

Optional database packs plug into the **shared core UX** (login UI, schema explorer, query execution, results/export). They do **not** replace the Netezza-first product surface (NZ/NZP linter depth, GROOM/ETL, Netezza-tuned Copilot tools).

**What most optional extensions provide**

- Connect and run queries against the target database
- Schema browser refresh (scope varies by dialect)
- Metadata-aware completion and diagnostics **where implemented** for that dialect
- Import/export and DDL helpers **where implemented**

**Dialects with dedicated SQL editors** — these packs ship their own Chevrotain lexer/parser runtimes and strict (or best-effort) syntax validation on the shared LSP stack:

- **Oracle** — dedicated Oracle parser/PL/SQL validation, grammar/snippets, advanced data and schema workflows, explain/tuning/session monitor, and ORA quality rules. Documented in [docs/oracle.md](docs/oracle.md); internal parity labels in [plans/DIALECT_PARITY_MATRIX.md](plans/DIALECT_PARITY_MATRIX.md).
- **PostgreSQL** — dedicated PostgreSQL parser runtime with strict validation, grammar/snippets, metadata-aware tooling, DDL, COPY, explain/tuning, maintenance, and session monitor.
- **MS SQL Server** — dedicated T-SQL parser runtime (TOP/OUTPUT/APPLY/bracketed identifiers), streaming readers with cancellation, MSS001–MSS008 quality rules, grammar, and snippets.
- **MySQL** — MySQL 8 parser with strict validation for common MySQL syntax, backtick identifiers, `DATABASE.TABLE` qualification, CTEs, MySQL `LIMIT` forms, `INSERT IGNORE`, `ON DUPLICATE KEY UPDATE`, and MySQL-specific types/functions; native `mysql2` streaming with typed columns and cancellation.
- **Db2 LUW** — dedicated Db2 parser runtime (isolation, `OPTIMIZE FOR`, `FETCH FIRST`, DGTT, thin SQL PL), DB2001–DB2008 quality rules, grammar/snippets; documented in [docs/db2.md](docs/db2.md).

Access, Vertica, Snowflake and SQLite remain companion runtimes with reduced editor intelligence. File SQL and DuckDB now use dedicated DuckDB parser/authoring runtimes.

**File SQL** — with core + [DuckDB + Files pack](extensions/duckdb): local Excel, CSV/TSV, Parquet, and Avro files are queried through an in-memory DuckDB connection. Multiple files can be opened together as a saved, read-only workspace for SQL joins and transformations. This is a file-backed SQL workflow, not a general-purpose spreadsheet editor; editing a single source still requires the opt-in **Editable copy** flow described above.

**Microsoft Access** — with core + [Access pack](extensions/access): local `.mdb` and `.accdb` databases can be queried and edited through the UCanAccess Java bridge. Access uses a flat catalog, so it does not expose the server-style database/schema hierarchy used by Netezza and most server databases. Java 11+ is required.

**What remains Netezza-only (or Netezza-first)**

- NZ/NZP rule depth and NZPLSQL regex fallback paths beyond shared procedure-scope codes
- Netezza-specific maintenance workflows (GROOM, skew analysis, ETL designer)
- Netezza-tuned Copilot tools (`#compileProcedure`, `#tableStats` skew/distribution, and similar)

| Database          | Status        | Distribution                | Marketplace `preview` | Notes                                                                                  |
| ----------------- | ------------- | --------------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| **SQLite**        | Experimental  | Built into core extension   | n/a (core)            | File-based, no separate installation; minimal SQL validation                           |
| **File SQL**      | Near-full preview | Separate DuckDB + Files extension | yes              | Dedicated DuckDB parser/authoring; read-only source views and `_edit` tables for opt-in writes |
| **Microsoft Access** | Preview    | Separate optional extension | yes                 | `.mdb`/`.accdb` query/edit through UCanAccess; requires Java 11+                      |
| **IBM Db2**       | Near-full preview | Separate optional extension | yes                   | Dedicated Db2 parser runtime (isol level, `OPTIMIZE FOR`, `FETCH FIRST`, DGTT, SQL P) + DB2001–DB2008 rules — [docs/db2.md](docs/db2.md) |
| **DuckDB**        | Near-full preview | Separate optional extension | yes                   | Dedicated parser, strict authoring, DDK001–DDK003 rules, grammar and snippets; uses `@duckdb/node-api` |
| **PostgreSQL**    | Near-full preview | Separate optional extension | yes                   | Pure JS `pg` runtime; dedicated PostgreSQL parser runtime, DDL/Copy/explain, maintenance, session monitor |
| **Snowflake**     | Preview       | Separate optional extension | yes                   | Pure JS `snowflake-sdk`; connect, schema browser, stage helpers; limited SQL validation |
| **Oracle**        | Near-full preview | Separate optional extension | yes               | Advanced SQL/PL/SQL editor in core + thin `oracledb` VSIX; dedicated live suite — [docs/oracle.md](docs/oracle.md) |
| **Microsoft SQL** | Preview       | Separate optional extension | yes                   | Dedicated MS SQL runtime; requires `mssql` npm package                                 |
| **MySQL**         | Preview       | Separate optional extension | yes                   | MySQL 8 parser (strict) + native `mysql2` streaming; requires `mysql2` |
| **Vertica**       | Preview       | Separate optional extension | yes                   | Requires `vertica` npm package                                                         |

All optional database extensions are published with `"preview": true` in their `package.json` (PostgreSQL included). Treat them as **preview companion runtimes** — not peers of the full Netezza-first stack. SQL editor depth varies by dialect; **Oracle** is closest to Netezza on the shared parser/LSP path, with **PostgreSQL, MySQL, Db2, and MS SQL Server** also shipping dedicated parser runtimes.

Install the core extension first, then install the Oracle support package to enable:

- Oracle connections (`node-oracledb` thin mode) in the shared login UI
- schema explorer for tables, views, procedures, functions, packages, triggers, sequences, and synonyms
- dedicated Oracle Chevrotain parser, TextMate grammar, snippets, and strict PL/SQL validation (SQL037–SQL040 where applicable)
- metadata-aware completion, hover, rename, semantic tokens, and ORA001–ORA004 quality rules
- advanced DDL and schema-migration extraction (`DBMS_METADATA`), import/export, explain graph, tuning advisor, session monitor, and table maintenance

See [docs/oracle.md](docs/oracle.md) for setup, parity versus Netezza, and live validation.

Install the PostgreSQL support package to enable:

- PostgreSQL connections in the shared login UI
- schema explorer refresh for databases, schemas, tables, views, procedures, functions, and sequences
- metadata-aware completions and diagnostics
- CSV import through PostgreSQL `COPY`
- DDL generation for tables, views, procedures/functions, and sequences
- `EXPLAIN (FORMAT JSON)` parsing plus tuning-advisor scaffolding

See [docs/postgresql.md](docs/postgresql.md) for setup, development, and validation details.

Install the Snowflake support package to enable:

- Snowflake connections in the shared login UI with warehouse/role/auth-mode fields
- schema explorer refresh for databases, schemas, tables, views, procedures, functions, sequences, stages, streams, tasks, file formats, and warehouses
- metadata-aware completions and diagnostics for Snowflake SQL, including semi-structured helpers
- stage-based import/export helpers that generate `COPY INTO` SQL and usage guidance
- `EXPLAIN USING JSON` parsing and recent query profile viewing
- stream/task draft wizards plus Snowflake session commands for switching warehouse and role

See [docs/snowflake.md](docs/snowflake.md) for setup, development, security guidance, and opt-in live testing.

## Keyboard Shortcuts

| Shortcut            | Action                            |
| ------------------- | --------------------------------- |
| `Ctrl+Enter` / `F5` | Run Current Statement / Selection |
| `Ctrl+Shift+Enter`  | Run Query Batch                   |
| `Ctrl+Shift+L`      | Lint SQL (On-Demand)              |

### Marketplace troubleshooting

If the Visual Studio Marketplace is temporarily unavailable (for example, it returns an HTTP 429 rate-limit error), install the extension manually from a `.vsix` package. Open the project's [GitHub Releases](https://github.com/justybase/justybase-vscode/releases), download `justybaselite-netezza-<version>.vsix` from **Assets**, then in VS Code run **Extensions: Install from VSIX...** from the Command Palette (`Ctrl+Shift+P`). Do not download `Source code (zip)` or `Source code (tar.gz)` — they are not installable extensions. Manual installation does not receive automatic Marketplace updates.

<details>
<summary>For contributors and maintainers</summary>

This section is for building, testing, packaging, and releasing the extension. Database users can skip it.

Optional database support now lives in sibling packages under `extensions\`. Today that includes `extensions\access`, `extensions\db2`, `extensions\duckdb`, `extensions\oracle`, `extensions\postgresql`, `extensions\mssql`, `extensions\mysql`, `extensions\snowflake`, and `extensions\vertica` when those optional packages are present in the checkout. Db2, DuckDB, and Access are distributed separately because their runtimes should not be bundled into the core Netezza/SQLite VSIX.

```bash
# Install dependencies
npm install

# Install optional package dependencies (when present in your checkout)
npm run install:db2
npm run install:duckdb
npm run install:access
npm run install:oracle
npm run install:postgresql
npm run install:snowflake
npm run install:mssql
npm run install:mysql

# Press F5 from the repository root and choose one of:
# Run Core + Db2 Support
# Run Core + DuckDB Support
# Run Core + Access Extension
# Run Core + Oracle Support
# Run Core + PostgreSQL Support
# Run Core + Snowflake Support
# Run Core + MySQL Support
# Run Core + All Optional Support Packs

# Build the extension
npm run build
npm run build:db2
npm run build:duckdb
npm run build:access
npm run build:access-jar
npm run build:oracle
npm run build:postgresql
npm run build:snowflake
npm run build:mssql
npm run build:mysql

# Run tests
npm run test -- --testPathPatterns="sqlParser.test.ts"
npm run test -- --testNamePattern="ConnectionManager"
npm run test:duckdb:integration
npm run test:access:integration
npm run test:oracle:integration
npm run test:live:local

# Switch Db2 runtime between Jest/Node and F5/Electron
npm run db2:runtime:node
npm run db2:runtime:electron

# Type checking and linting
npm run check-types
npm run check-types:db2
npm run check-types:duckdb
npm run check-types:access
npm run check-types:oracle
npm run check-types:postgresql
npm run check-types:snowflake
npm run check-types:mssql
npm run check-types:mysql
npm run lint
npm run lint:duckdb
npm run lint:access
npm run lint:snowflake
npm run lint:mysql
npm run verify:duckdb
npm run verify:snowflake
npm run verify:mysql

# Package for distribution
npm run package:pre
npm run package:db2
npm run package:duckdb
npm run package:access
npm run package:oracle
npm run package:postgresql
npm run package:snowflake
npm run package:mssql
npm run package:mysql
npm run package:duckdb:full
npm run package:snowflake:full
npm run package:mysql:full

# Keep core + optional extension versions synchronized
npm run version:check
npm run version:patch
npm run version:set -- 1.2.0
```

The Db2-bearing F5 launch targets now call `npm run db2:runtime:electron` automatically before the Extension Development Host starts, so a previous Jest/live-test rebuild for plain Node does not leave `ibm_db` on the wrong ABI for VS Code debugging. Those Db2 debug profiles also inject `DB2CODEPAGE=1208` into the Extension Development Host on Windows so the bundled CLI driver is biased toward UTF-8/Unicode conversion during F5 sessions. The manual runtime commands remain useful when you want to switch explicitly outside the normal F5 flow.

`npm run package:db2` expects `extensions\db2\node_modules\ibm_db` to be installed first, and `npm run package:duckdb` expects `extensions\duckdb\node_modules\@duckdb\node-api` to be installed first. The root helpers above run those installs in the optional package directories for you.

`npm run install:duckdb`, `npm run install:oracle`, `npm run install:postgresql`, and `npm run install:mysql` are not required just to make those dialects appear in the `Connect to Database` panel during F5 debugging. For that, you only need to launch the matching combined debug profile so the optional extension is loaded into the same Extension Development Host. Those install steps are still required before a real DuckDB, Oracle, PostgreSQL, or MySQL connection can succeed.

`npm run test:live:local` is a local-only smoke harness for live databases. It runs:

- the existing Netezza live integration test (`src\__tests__\integration\realDatabase.integration.test.ts`)
- optional live metadata/connectivity smoke tests for Db2, Oracle, and PostgreSQL (`src\__tests__\integration\optionalDialects.live.integration.test.ts`)

The default `npm run test` and `npm run test:watch` flows skip both live suites on purpose, so normal regression runs stay local-environment-independent. Use `npm run test:live:local` when you explicitly want real database smoke coverage.

For the full Oracle live suite (connection, metadata search, DDL extraction/generation, maintenance, and session monitor), run `npm run test:oracle:integration`. It requires `ORACLE_LIVE_TEST_HOST`, `ORACLE_LIVE_TEST_PORT`, `ORACLE_LIVE_TEST_DATABASE`, `ORACLE_LIVE_TEST_USER`, and `ORACLE_LIVE_TEST_PASSWORD` (with optional `ORACLE_LIVE_TEST_CURRENT_SCHEMA`).

For MS SQL Server, run `npm run test:mssql:integration` with the `MSSQL_LIVE_TEST_*` variables below. That suite covers streaming cancel, typed import/export round-trip, live completion, and MSS*/SQL004/SQL025 quality checks against catalog metadata.

For MySQL, run `RUN_MYSQL_INTEGRATION=1 npx jest --config jest.live.config.js src/__tests__/integration/mysql.integration.test.ts --runInBand` with `MYSQL_LIVE_TEST_HOST`, `MYSQL_LIVE_TEST_PORT`, `MYSQL_LIVE_TEST_DATABASE`, `MYSQL_LIVE_TEST_USER`, and `MYSQL_LIVE_TEST_PASSWORD`. The suite covers MySQL 8 qualification, metadata, typed streaming reads, cancellation, explain parsing, and an isolated DDL fixture that is cleaned up after the run.

For Db2, run `npm run test:db2:integration` with the `DB2_LIVE_TEST_*` variables below. That command rebuilds `ibm_db` for Node/Jest when live env is present, injects the **bundled** clidriver into the test process only (no system ODBC registration), and restores the Electron/F5 build afterward—same pattern as `npm run test:live:local`. Quick connectivity check: `npm run db2:connect-probe`. Persistent catalog fixture: see [docs/db2.md](docs/db2.md) (`npm run db2:seed-live-fixture`).

The live tests are env-gated and stay skipped unless you provide credentials. Supported variables are:

- Netezza: `NZ_DEV_PASSWORD` plus optional `NZ_DEV_HOST`, `NZ_DEV_PORT`, `NZ_DEV_DATABASE`, `NZ_DEV_USER`
- Db2: `DB2_LIVE_TEST_HOST`, `DB2_LIVE_TEST_PORT`, `DB2_LIVE_TEST_DATABASE`, `DB2_LIVE_TEST_USER`, `DB2_LIVE_TEST_PASSWORD`, optional `DB2_LIVE_TEST_CURRENT_SCHEMA`
- Oracle: `ORACLE_LIVE_TEST_HOST`, `ORACLE_LIVE_TEST_PORT`, `ORACLE_LIVE_TEST_DATABASE` (service name), `ORACLE_LIVE_TEST_USER`, `ORACLE_LIVE_TEST_PASSWORD`, optional `ORACLE_LIVE_TEST_CURRENT_SCHEMA`
- MS SQL Server: `MSSQL_LIVE_TEST_HOST`, `MSSQL_LIVE_TEST_PORT` (default 1433), `MSSQL_LIVE_TEST_DATABASE`, `MSSQL_LIVE_TEST_USER`, `MSSQL_LIVE_TEST_PASSWORD` (optional encrypt / trustServerCertificate via connection options)
- PostgreSQL: `POSTGRES_LIVE_TEST_HOST`, `POSTGRES_LIVE_TEST_PORT`, `POSTGRES_LIVE_TEST_DATABASE`, `POSTGRES_LIVE_TEST_USER`, `POSTGRES_LIVE_TEST_PASSWORD`
- MySQL: `MYSQL_LIVE_TEST_HOST`, `MYSQL_LIVE_TEST_PORT` (default 3306), `MYSQL_LIVE_TEST_DATABASE`, `MYSQL_LIVE_TEST_USER`, `MYSQL_LIVE_TEST_PASSWORD`; enable with `RUN_MYSQL_INTEGRATION=1` or `MYSQL_LIVE_TEST_ENABLED=1`

When the full `DB2_LIVE_TEST_*` configuration is present, `npm run test:live:local` now automatically:

1. rebuilds `ibm_db` for the current Node/Jest ABI
2. runs the live smoke tests
3. restores the VS Code Electron/F5 build afterward

If VS Code is installed in a non-default location or Electron auto-detection fails, set one of these environment variables before running the command:

- `DB2_RUNTIME_VSCODE_DIR`
- `DB2_RUNTIME_ELECTRON_VERSION`

You can also switch DB2 manually when needed:

- `npm run db2:runtime:node` - prepare DB2 for Jest/live tests
- `npm run db2:runtime:electron` - restore DB2 for F5 / Extension Development Host

The `Run Core + Db2 Extensions` and `Run Core + All Optional Extensions` F5 profiles trigger that Electron restore automatically as part of their prelaunch tasks, and they also set `DB2CODEPAGE=1208` for the debug host to reduce Windows codepage mismatches when Db2 data contains non-ASCII characters such as Polish diacritics.

`npm run rebuild:db2` remains as a compatibility alias for `npm run db2:runtime:electron`.

Versioning for releases is centralized through the `npm run version:*` commands. Use `npm run version:patch`, `npm run version:minor`, `npm run version:major`, or `npm run version:set -- 1.2.3` from the repository root instead of editing manifests manually. This flow synchronizes the root package files plus any present optional extension manifests / lockfiles, such as:

- `package.json`
- `package-lock.json`
- `extensions\db2\package.json`
- `extensions\db2\package-lock.json`
- `extensions\duckdb\package.json`
- `extensions\duckdb\package-lock.json`
- `extensions\oracle\package.json`
- `extensions\oracle\package-lock.json`
- `extensions\postgresql\package.json`
- `extensions\postgresql\package-lock.json`
- `extensions\snowflake\package.json`
- `extensions\snowflake\package-lock.json`
- `extensions\mysql\package.json`
- `extensions\mysql\package-lock.json`

`npm run version:check` validates that every present managed package is aligned, and the release pipeline uses the same check before publishing.

Marketplace publication and manual VSIX release steps are documented in [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md). Configure the `VSCE_PAT` repository secret only when publishing automatically from GitHub Actions.

The repository includes combined debug targets for Db2, DuckDB, Oracle, PostgreSQL, MySQL, Snowflake, and an all-optional profile that load the selected extension development paths into the same Extension Development Host. The drivers are loaded lazily, so the F5 session can start before the database package is installed; a real connection still requires the matching `npm run install:*` step for that optional extension.

</details>

## License

Apache-2.0

Marketplace packages include the full Apache 2.0 license and a generated `THIRD_PARTY_NOTICES.md` with locked component versions, upstream sources, SPDX identifiers, and available license texts. Release VSIX files are secret-scanned by the pinned stable VSCE and pass the repository's final-artifact audit before publication.
