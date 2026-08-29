# Banking dashboard fixtures

The repository includes three small, synthetic XLSX workbooks that show how a
reporting process can combine several raw tabs into a reusable dashboard. They
contain no customer or production data.

The files are in [`fixtures/bank-dashboards`](../fixtures/bank-dashboards/):

| Workbook | Demonstrates | Raw tabs |
| --- | --- | --- |
| [`bank-sales-overview.xlsx`](../fixtures/bank-dashboards/bank-sales-overview.xlsx) | ROR acquisition, credit sales, product ranking, branch target attainment, monthly volume | `Raw_Monthly`, `Raw_Products`, `Raw_Branches` |
| [`campaign-performance.xlsx`](../fixtures/bank-dashboards/campaign-performance.xlsx) | Campaign ROI, digital/branch/partner channels, acquisition funnel, segment performance | `Raw_Campaigns`, `Raw_Monthly_Campaigns`, `Raw_Funnel`, `Raw_Segments` |
| [`branch-product-ranking.xlsx`](../fixtures/bank-dashboards/branch-product-ranking.xlsx) | Branch and advisor rankings, product mix by month, multi-product customer rate | `Raw_Branches`, `Raw_Advisors`, `Raw_Product_Mix`, `Raw_CrossSell` |

## How the model is organized

Each workbook keeps the dashboard presentation separate from the source-like
tabs:

- `Dashboard` contains KPIs, ranking tables, monthly summaries, and charts.
- `Raw_*` tabs contain rectangular, header-based data that can be replaced by
  an automated query export.
- Charts read from the `Raw_*` tabs rather than from hard-coded dashboard
  values. Updating a raw tab therefore gives the dashboard a new reporting
  period without rebuilding its presentation.

The fixtures use deliberately small row counts so they are easy to inspect in
VS Code, Excel, or the File SQL workflow. Values are illustrative PLN amounts,
counts, rates, and rankings only. The generated workbooks are native XLSX
packages created with [XlsxWriter](https://xlsxwriter.readthedocs.io/); they
contain real Excel tables with filter dropdowns, frozen raw headers, formula
cards, conditional formatting, print settings and chart drawings. They do not
claim to create native PivotTables or slicers.

## Refresh pattern with `%EXPORT`

The existing-workbook mode can refresh one raw tab at a time. A scheduler or a
batch SQL file can run a sequence like this after adapting the source tables
and columns to the bank's warehouse:

```sql
%LET dashboard_file = '/reports/bank-sales-overview.xlsx';

%EXPORT(
  format='xlsx',
  file=&dashboard_file,
  sheet='Raw_Monthly',
  query=(
    SELECT month,
           new_ror_accounts,
           credit_applications,
           credit_sales,
           credit_volume_pln,
           active_campaigns,
           conversion_rate
    FROM reporting.bank_sales_monthly
    WHERE report_year = 2025
    ORDER BY month_number
  ),
  update=true
);

%EXPORT(
  format='xlsx',
  file=&dashboard_file,
  sheet='Raw_Products',
  query=(
    SELECT product,
           category,
           applications,
           approved,
           sold,
           volume_pln,
           share_of_sales
    FROM reporting.bank_product_sales
    WHERE report_year = 2025
    ORDER BY volume_pln DESC
  ),
  update=true
);
```

The target workbook and sheet must already exist. `update=true` replaces the
selected raw tab, keeps the other tabs and workbook structure, updates the
native table/autofilter range, removes a stale Excel calculation-chain cache,
and leaves the dashboard charts connected to their source ranges. Formula
cells are retained; Excel rebuilds its optional calculation chain when needed.
For a sheet backed by a ListObject, the query must return the same columns in
the same order (comparison is case-insensitive); the workbook's exact header
spelling is retained so structured references and PivotTable fields stay
valid. A target sheet with more than one ListObject is rejected as ambiguous.
This contract applies to both XLSX and XLSB.
The same pattern works for the `Raw_Campaigns`,
`Raw_Branches`, `Raw_Advisors`, and other tabs in the fixtures.

For a full reporting run, use the same process for each raw tab, then publish
or attach the unchanged workbook. If the query produces a different number of
rows, the updater recalculates the target sheet range; the dashboard remains a
stable presentation layer.

## Rebuilding the fixtures

The source data and workbook layout are reproducible. From the repository root:

```bash
python3 -m pip install -r scripts/requirements-bank-dashboards.txt
npm run fixtures:bank-dashboards
npm run fixtures:bank-dashboards:check
```

The generator uses native XlsxWriter APIs for the workbook, tables and charts;
the runtime updater remains `@justybase/spreadsheet-tasks`. Run the normal File
SQL or spreadsheet reader tests after changing the generator.

## External PivotTable references

[`fixtures/bank-dashboards/external`](../fixtures/bank-dashboards/external/)
contains two MIT-licensed workbooks selected as interactivity references after
reviewing open-source Excel dashboard examples. They retain their native
PivotTables, PivotCharts, slicers and cached pivot data:

- `superstore-sales-dashboard.xlsx` uses the `superstore` ListObject as the
  single source for six PivotTables and Year/Category slicers.
- `personal-finance-dashboard-2026.xlsx` uses the `Dataset` ListObject to power
  a KPI sheet and slicer-driven `Dashboard`.

Their upstream URLs, copyright notices and SHA-256 fingerprints are recorded in
[`external/NOTICE.md`](../fixtures/bank-dashboards/external/NOTICE.md). The
JustyBase update path preserves these parts and sets PivotTables to refresh on
open, but the final **Refresh All** belongs to Excel Desktop. The local
structure test updates both files and verifies that pivot, slicer, chart and
table parts survive.
