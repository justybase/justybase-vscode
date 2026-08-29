# Banking dashboard fixtures

These workbooks contain synthetic, non-customer banking data. They are meant
to demonstrate a refreshable reporting model rather than a production banking
data dictionary.

Each workbook has a `Dashboard` sheet plus several `Raw_*` sheets. Charts on
the dashboard point at the raw sheets, so a scheduled `%EXPORT(update=true)`
can replace a raw sheet while preserving the dashboard layout and charts.

Files:

- `bank-sales-overview.xlsx` — ROR acquisition, consumer-credit sales,
  product ranking, branch target attainment, and monthly trends.
- `campaign-performance.xlsx` — campaign/channel performance, lead funnel,
  ROI, segment mix, and monthly campaign sales.
- `branch-product-ranking.xlsx` — branch and advisor rankings, product mix by
  month, and multi-product customer/productization rates.

Regenerate the generated files from the repository root with:

```bash
python3 -m pip install -r scripts/requirements-bank-dashboards.txt
npm run fixtures:bank-dashboards
npm run fixtures:bank-dashboards:check
```

The generator uses native XlsxWriter APIs, so the files open in Excel as valid
XLSX packages with real tables, filters, formulas, conditional formatting and
charts. The runtime update path uses `@justybase/spreadsheet-tasks` and also
synchronizes ListObject table ranges after a raw-sheet replacement.

The `external/` directory contains two MIT-licensed reference workbooks with
native PivotTables, PivotCharts and slicers. See
[`external/NOTICE.md`](external/NOTICE.md) for attribution, source links and
the raw source-column contracts. They are intentionally kept separate from the
generated banking examples.
