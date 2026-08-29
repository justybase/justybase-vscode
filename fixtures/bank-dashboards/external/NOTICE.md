# External dashboard references

These two workbooks are redistributed as small, static, open-source reference
fixtures. They are not part of the JustyBase implementation and contain no
customer or production data.

| File | Upstream project | License | Refresh contract |
| --- | --- | --- | --- |
| `superstore-sales-dashboard.xlsx` | [RohanTalekar01/superstore-sales-dashboard-excel](https://github.com/RohanTalekar01/superstore-sales-dashboard-excel) | MIT; see `LICENSE-superstore.txt` | Replace the `superstore` sheet, preserving the 11-column header contract. Refresh All in Excel to recalculate PivotTables, charts and slicers. |
| `personal-finance-dashboard-2026.xlsx` | [sharmilamaryselvam/Personal-Finance-Dashboard](https://github.com/sharmilamaryselvam/Personal-Finance-Dashboard) | MIT; see `LICENSE-personal-finance.txt` | Replace the `Dataset` sheet, preserving its existing transaction header contract. Refresh the PivotTables in Excel Desktop. |

The source workbooks were downloaded from their `main` branches on 2026-08-29.
The copies in this checkout are normalized by removing the optional Excel
calculation-chain cache. Excel rebuilds that cache from the formulas, while a
stale chain can trigger a repair warning after a raw sheet is replaced.
SHA-256 fingerprints of the normalized copies in this checkout are:

```text
2ca3cf6b8300a49125d899a5ecbf134129bd2aa0968599bf367cb0ce285d2772  superstore-sales-dashboard.xlsx
31a100c6fb59cb1355d57299ff25ae77a15bdff3f11bde5335ccedd1400a3289  personal-finance-dashboard-2026.xlsx
```

The files are included because they demonstrate native PivotTables, PivotCharts
and slicers that the generator-only `XlsxWriter` dependency cannot create. The
local updater preserves those OOXML parts, marks PivotTables for refresh and
removes stale calculation-chain metadata; the fixture tests also verify that
the pivot/slicer/chart parts survive a raw sheet update. The raw ListObject
range is synchronized by the JustyBase XLSX table-range adapter before Excel
opens the result.
