# SAS-like macros

JustyBase supports a small, deliberately SQL-focused set of SAS-style
directives in Netezza SQL files. Directives are processed before SQL is sent
to the database. They can declare variables, choose a branch, run a small
query, generate a list, call Python, include another SQL file, print a log
message, or export a result.

## Before running the samples

The examples use `JUST_DATA.ADMIN.DIMDATE`, because it is a stable table in the
development fixture. Replace `JUST_DATA.ADMIN` with the database and schema
that contain your date dimension. The live examples in
`src/__tests__/integration/sasLikeMacros.e2e.test.ts` substitute the configured
`NZ_DEV_DATABASE` and `NZ_DEV_SCHEMA` values and execute the resulting SQL
against Netezza.

Variable names are case-insensitive and are available only for the current
script execution. Macro directives are removed from the SQL sent to Netezza;
only their resolved values and generated SQL remain.

## Declare and reference variables

`%LET` and `@SET` are equivalent declaration forms. The value can be a literal
or the result of another macro. The following sample combines both forms:

<!-- live-sample: let-and-set -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
@SET run_report = 1;

SELECT
  &run_report AS run_report,
  COUNT(*) AS row_count
FROM &dim_table;
```

The same variable can be written with an ampersand, a dollar sign, or a braced
dollar reference. Braces are useful when the reference touches adjacent
identifier characters:

<!-- live-sample: reference-forms -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);

SELECT
  &as_of_key AS ampersand_value,
  $as_of_key AS dollar_value,
  ${as_of_key} AS braced_value
FROM &dim_table
WHERE DATEKEY = ${as_of_key};
```

References are resolved in source order. A declaration must appear before its
use, and a value containing SQL text is resolved without changing quoted SQL
literals or comments.

## Inline SQL: `%SQL` and `%SQLLIST`

`%SQL(...)` substitutes the first column of the first row. `%SQLLIST(...)`
turns the first column of every returned row into a comma-separated SQL literal
list. An empty list is emitted as `NULL`, so it remains valid inside `IN`.

<!-- live-sample: sql-and-sqllist -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);

SELECT COUNT(*) AS matching_rows
FROM &dim_table
WHERE DATEKEY = &as_of_key
  AND CALENDARQUARTER IN (
    %SQLLIST(
      SELECT DISTINCT CALENDARQUARTER
      FROM &dim_table
      WHERE DATEKEY = &as_of_key
    )
  );
```

The inner query is executed during preprocessing. It must return a scalar for
`%SQL`; `%SQLLIST` uses only its first column. The generated SQL is then sent
to Netezza as an ordinary statement.

## Arithmetic and logical expressions: `%EVAL`

`%EVAL` evaluates a safe arithmetic or logical expression during preprocessing.
Use it for thresholds and flags that should not be calculated by the database:

<!-- live-sample: eval -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);
%LET lookback_days = 30;
%LET lower_key = %EVAL(&as_of_key - &lookback_days);

SELECT
  &as_of_key AS as_of_key,
  &lower_key AS lower_key,
  %EVAL(50 + 58) AS calculated_value
FROM &dim_table
WHERE DATEKEY = &as_of_key;
```

Expressions support numeric arithmetic and the boolean comparisons used by
`%IF`. Keep database-specific functions in `%SQL` or in the final SQL query.

## Conditional and repeated blocks

`%DO; ... %END;` runs a block unconditionally. `%IF` selects a branch, and an
optional `%ELSE %DO; ... %END;` supplies the alternative. Blocks can be
nested:

<!-- live-sample: branching -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET run_report = 1;

%IF &run_report = 1 %THEN %DO;
  SELECT COUNT(*) AS row_count
  FROM &dim_table;
%ELSE %DO;
  SELECT 0 AS row_count;
%END;
```

An unconditional block is useful when a script is assembled from several
optional fragments:

<!-- live-sample: do-block -->
```sql
%DO;
  SELECT MAX(DATEKEY) AS latest_date
  FROM JUST_DATA.ADMIN.DIMDATE;
%END;
```

Only the selected branch is sent to Netezza. Variables declared in an executed
branch are available to later statements in the same script.

## Log messages with `%PUT`

`%PUT` writes a resolved message to the query log and does not add a database
statement:

<!-- live-sample: put -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(SELECT MAX(DATEKEY) FROM &dim_table);
%PUT Running report for &dim_table at DATEKEY=&as_of_key;

SELECT COUNT(*) AS row_count
FROM &dim_table
WHERE DATEKEY = &as_of_key;
```

The output log entry is prefixed with `>>> %PUT:`. `%PUT` supports all three
variable reference styles.

## Include a shared SQL file

`%INCLUDE` reads a local SQL file relative to the current script (or workspace
policy) and processes it with the caller's macro environment. For example,
`settings.sql` can contain shared declarations:

<!-- live-sample: include-file -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET run_report = 1;
```

The main script can then use those values:

<!-- live-sample: include-main -->
```sql
%INCLUDE 'settings.sql';

%IF &run_report = 1 %THEN %DO;
  SELECT COUNT(*) AS row_count
  FROM &dim_table;
%END;
```

Relative includes are resolved from the source file and are kept inside the
workspace or allowed source directory. Include cycles and excessive nesting
are rejected.

## Generate SQL with `%PYTHON`

`%PYTHON` runs the configured Python interpreter. Its standard output becomes
part of the SQL script, so the script must print valid Netezza SQL. Arguments
can contain macro references.

Example helper file `build_sql.py`:

<!-- live-sample: python-script -->
```python
print("SELECT 107 AS generated_value;")
```

Main SQL file:

<!-- live-sample: python-main -->
```sql
%LET python_script = build_sql.py;
%PYTHON &python_script;
```

Configure the interpreter with `justybase.pythonPath` when `python` is not on
`PATH`. Python directives run only in asynchronous query execution; parser-
only synchronous preprocessing reports that it needs an execution context.

## Export a new workbook

`%EXPORT` executes its `query` during preprocessing and writes the result with
`@justybase/spreadsheet-tasks`. The default sheet is `Query Results`; provide
`sheet` when a stable worksheet name is useful. `overwrite=true` permits
replacing an existing output file.

### XLSX

<!-- live-sample: export-xlsx -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET export_file = '/tmp/sas-like-macro-xlsx.xlsx';

%EXPORT(
  format='xlsx',
  file=&export_file,
  sheet='Daily',
  query=(
    SELECT DATEKEY, CALENDARQUARTER
    FROM &dim_table
    WHERE DATEKEY = (SELECT MAX(DATEKEY) FROM &dim_table)
  ),
  overwrite=true
);
```

### XLSB

The binary workbook form uses the same arguments and preserves the native XLSB
format:

<!-- live-sample: export-xlsb -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET export_file = '/tmp/sas-like-macro-xlsb.xlsb';

%EXPORT(
  format='xlsb',
  file=&export_file,
  sheet='Daily',
  query=(
    SELECT DATEKEY, CALENDARQUARTER
    FROM &dim_table
    WHERE DATEKEY = (SELECT MAX(DATEKEY) FROM &dim_table)
  ),
  overwrite=true
);
```

Supported output formats are `xlsx`, `xlsb`, `parquet`, `csv`, and `xpt`.
`sheet` applies to spreadsheet output; the other formats use their normal
single-file representation.

## Update an existing workbook sheet

Set `update=true` to replace the complete contents of an existing worksheet in
place. The target file and sheet must already exist. Headers are written from
the query column names, other worksheets and workbook structure are preserved,
and no key-based upsert is performed. `overwrite` is not required in update
mode.

### Update XLSX

Before running this sample, create `/tmp/sas-like-macro-update-xlsx.xlsx` with
a `Data` sheet. The live test creates that workbook with three sheets, runs the
sample against Netezza, and verifies that only `Data` changed:

<!-- live-sample: update-xlsx -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;

%EXPORT(
  format='xlsx',
  file='/tmp/sas-like-macro-update-xlsx.xlsx',
  sheet='Data',
  query=(
    SELECT DATEKEY, CALENDARQUARTER
    FROM &dim_table
    WHERE DATEKEY = (SELECT MAX(DATEKEY) FROM &dim_table)
  ),
  update=true
);
```

### Update XLSB

The XLSB update path has the same contract and uses `XlsbUpdater` internally:

<!-- live-sample: update-xlsb -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;

%EXPORT(
  format='xlsb',
  file='/tmp/sas-like-macro-update-xlsb.xlsb',
  sheet='Data',
  query=(
    SELECT DATEKEY, CALENDARQUARTER
    FROM &dim_table
    WHERE DATEKEY = (SELECT MAX(DATEKEY) FROM &dim_table)
  ),
  update=true
);
```

Update mode fails before running the query when the file or worksheet is
missing, and it is intentionally restricted to `xlsx` and `xlsb`.

## Refresh a banking dashboard model

The repository contains three generated, professional-looking banking
workbooks in [`fixtures/bank-dashboards`](../../fixtures/bank-dashboards/). Each
has a visual `Dashboard`, several rectangular `Raw_*` tabs, native Excel tables,
filter dropdowns, formula-driven KPI cards and charts. The raw tabs are the
automation boundary: a scheduled query can replace one tab while the
presentation layer remains intact.

The following examples use the real `NZ_DEV` date dimension and are executed
by the live macro suite. They write to temporary copies of the checked-in
fixtures, so they do not change the repository files or database objects.

### Sales overview: refresh the monthly raw tab

<!-- live-sample: bank-sales-dashboard-update -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;

%EXPORT(
  format='xlsx',
  file='/tmp/justybase-bank-sales-overview.xlsx',
  sheet='Raw_Monthly',
  query=(
    SELECT
      CAST(MAX(DATEKEY) AS VARCHAR(20)) AS Month,
      COUNT(*) AS New_ROR_Accounts,
      COUNT(*) AS Credit_Applications,
      COUNT(*) AS Credit_Sales,
      COUNT(*) * 100000 AS Credit_Volume_PLN,
      1 AS Active_Campaigns,
      0.50 AS Conversion_Rate
    FROM &dim_table
    WHERE DATEKEY = (SELECT MAX(DATEKEY) FROM &dim_table)
  ),
  update=true
);
```

The workbook's formula cards use `tblSalesMonthly` and its charts use dynamic
workbook names. This means a later export with a different number of months
does not require rebuilding the dashboard.

### Campaign performance: refresh campaign facts

<!-- live-sample: bank-campaign-dashboard-update -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;

%EXPORT(
  format='xlsx',
  file='/tmp/justybase-campaign-performance.xlsx',
  sheet='Raw_Campaigns',
  query=(
    SELECT
      'NZ-LIVE' AS Campaign_ID,
      'NZ_DEV sample' AS Campaign,
      'Digital' AS Channel,
      'ROR Account' AS Product,
      COUNT(*) AS Leads,
      COUNT(*) AS Applications,
      COUNT(*) AS Approved,
      COUNT(*) AS Sold,
      COUNT(*) * 100000 AS Volume_PLN,
      1000 AS Spend_PLN,
      0.50 AS Conversion_Rate,
      2.00 AS ROI
    FROM &dim_table
    WHERE DATEKEY = (SELECT MAX(DATEKEY) FROM &dim_table)
  ),
  update=true
);
```

The same contract can be used for `Raw_Monthly_Campaigns`, `Raw_Funnel` and
`Raw_Segments`; the workbook keeps those views separate so each query can be
scheduled independently.

### Branch and productization ranking: refresh branch facts

<!-- live-sample: bank-branch-dashboard-update -->
```sql
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;

%EXPORT(
  format='xlsx',
  file='/tmp/justybase-branch-product-ranking.xlsx',
  sheet='Raw_Branches',
  query=(
    SELECT
      'B-NZ' AS Branch_ID,
      'NZ_DEV sample branch' AS Branch,
      'Development' AS Region,
      1 AS Rank,
      COUNT(*) * 100000 AS Credit_Volume_PLN,
      1.00 AS Attainment_Rate,
      COUNT(*) AS ROR_per_Advisor,
      0.50 AS Productization_Rate
    FROM &dim_table
    WHERE DATEKEY = (SELECT MAX(DATEKEY) FROM &dim_table)
  ),
  update=true
);
```

For a production model, schedule a second update for `Raw_CrossSell` and
`Raw_Advisors`. The raw column order and names are listed in each workbook's
`Model_Guide` tab and in [`docs/bank-dashboard-fixtures.md`](../bank-dashboard-fixtures.md).

### Native PivotTable and slicer references

The `external/` subdirectory contains two MIT-licensed reference workbooks:

- `superstore-sales-dashboard.xlsx` demonstrates one raw ListObject feeding
  multiple PivotTables, PivotCharts and Year/Category slicers.
- `personal-finance-dashboard-2026.xlsx` demonstrates a transaction `Dataset`,
  a KPI layer and a slicer-driven dashboard.

Their source URLs and license notices are in
[`fixtures/bank-dashboards/external/NOTICE.md`](../../fixtures/bank-dashboards/external/NOTICE.md).
The XLSX updater preserves the native pivot/slicer parts and marks PivotTables
for refresh. A ListObject update must keep the source column count and order;
use the complete source-column contracts in the external snippets
(`nzexternalsalesdashboard` and `nzexternalfinancedashboard`), then choose
**Data → Refresh All** in desktop Excel. Slicers and PivotCharts are Excel
features and are not recalculated by the lightweight spreadsheet reader.

## Combined workflow

The directives are designed to compose. This example loads settings, computes
a scalar, chooses a branch, logs the decision, and exports a workbook:

<!-- live-sample: combined-workflow -->
```sql
%INCLUDE 'settings.sql';
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);

%IF &run_report = 1 %THEN %DO;
  %EXPORT(
    format='xlsx',
    file='/tmp/sas-like-macro-workflow.xlsx',
    sheet='Workflow',
    query=(
      SELECT DATEKEY, CALENDARQUARTER
      FROM &dim_table
      WHERE DATEKEY = &as_of_key
    ),
    overwrite=true
  );
  %PUT Exported DATEKEY=&as_of_key from &dim_table;
%ELSE %DO;
  %PUT Report disabled;
%END;
```

The live suite creates the included `settings.sql`, substitutes the configured
Netezza table and temporary output path, then verifies the generated workbook,
query result, branch, and log event.

## Completion, highlighting, and linting

In a Netezza SQL file, typing `%` offers snippets for `%LET`, `%IF`, `%ELSE`,
`%END`, `%DO`, `%INCLUDE`, `%SQL`, `%SQLLIST`, `%EVAL`, `%PYTHON`, `%EXPORT`,
and `%PUT`. Typing `@` offers the `@SET` declaration. Inside `%EXPORT`, completion
offers `format`, `file`, `sheet`, `query`, `overwrite`, and `update`, including
format and boolean values. Typing `%E` narrows the directive list to `%ELSE`,
`%END`, `%EVAL`, and `%EXPORT`; the completion range replaces only the letters
after `%`. Existing variables are suggested after `&`, `$`, or
`${` even when the reference is inside an export argument.

The snippet catalog includes complete examples for scalar/list SQL, arithmetic,
conditionals, include/Python workflows, new XLSX/XLSB exports, XLSX/XLSB raw
sheet updates, all three generated banking dashboards, and both external
PivotTable source contracts. Useful prefixes include:
`nzmacroexportupdatexlsx`, `nzmacroexportupdatexlsb`,
`nzbankdashboardupdate`, `nzcampaigndashboardupdate`,
`nzbranchproductizationupdate`, `nzexternalsalesdashboard`,
`nzexternalfinancedashboard`, and `nzfullreportingpipeline`.

The TextMate grammar highlights the directives, the parser and linter exclude
macro bodies from ordinary SQL diagnostics, and directive-looking text inside
SQL strings or comments is not treated as a macro boundary.

## Live verification

The documentation samples are extracted by the live E2E suite, so a changed
sample cannot silently drift away from its test. Run them against the configured
development Netezza instance with:

```bash
NZ_DEV_PASSWORD='...' npm run test:netezza:macros:integration
```

The command uses `NZ_DEV_HOST`, `NZ_DEV_PORT`, `NZ_DEV_DATABASE`,
`NZ_DEV_USER`, and `NZ_DEV_SCHEMA` when present. Without `NZ_DEV_PASSWORD` the
live tests are skipped. They issue read-only queries to Netezza and remove all
temporary Python, include, XLSX, and XLSB files in cleanup handlers.
