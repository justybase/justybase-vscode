#!/usr/bin/env python3
"""Generate polished, refreshable banking dashboard workbooks.

The files in ``fixtures/bank-dashboards`` are deliberately generated from
plain rectangular raw tabs.  XlsxWriter creates the XLSX package natively,
including real Excel tables, filters, formulas, conditional formatting and
charts.  The workbooks do not contain customer data and are intended as
repeatable documentation fixtures for ``%EXPORT(update=true)``.

Install the generator-only dependency with::

    python3 -m pip install -r scripts/requirements-bank-dashboards.txt

Then run ``npm run fixtures:bank-dashboards`` from the repository root.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable, Sequence

import xlsxwriter


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIRECTORY = ROOT / "fixtures" / "bank-dashboards"

COLORS = {
    "navy": "163B65",
    "blue": "2F75B5",
    "sky": "D9EAF7",
    "teal": "147D92",
    "green": "1F7A54",
    "lime": "72B043",
    "orange": "E8892F",
    "red": "C94C4C",
    "ink": "1F2937",
    "muted": "60758A",
    "line": "D6E0EB",
    "canvas": "F5F8FB",
    "white": "FFFFFF",
}


SALES_MONTHLY = [
    ["Jan-25", 420, 318, 142, 4650000, 3, 0.447],
    ["Feb-25", 438, 332, 151, 4920000, 3, 0.455],
    ["Mar-25", 470, 351, 168, 5480000, 4, 0.479],
    ["Apr-25", 455, 344, 159, 5190000, 4, 0.462],
    ["May-25", 486, 369, 177, 5740000, 4, 0.480],
    ["Jun-25", 512, 391, 192, 6310000, 5, 0.491],
    ["Jul-25", 505, 378, 185, 6080000, 5, 0.489],
    ["Aug-25", 528, 401, 201, 6730000, 5, 0.501],
    ["Sep-25", 541, 415, 214, 7190000, 6, 0.516],
    ["Oct-25", 563, 429, 226, 7560000, 6, 0.527],
    ["Nov-25", 589, 448, 241, 8110000, 6, 0.538],
    ["Dec-25", 624, 476, 268, 9040000, 7, 0.563],
]

SALES_PRODUCTS = [
    ["ROR Account", "Current account", 1680, 1548, 1496, 0, 0.259],
    ["Cash Loan", "Consumer credit", 1044, 742, 664, 8820000, 0.276],
    ["Credit Card", "Cards", 812, 611, 548, 1644000, 0.228],
    ["Mortgage", "Housing", 326, 184, 142, 38400000, 0.059],
    ["Auto Loan", "Consumer credit", 452, 289, 243, 7280000, 0.101],
    ["SME Loan", "Business", 218, 126, 94, 11600000, 0.039],
]

SALES_BRANCHES = [
    ["B001", "Warsaw Central", "Central", 312, 148, 4860000, 4500000, 1.080, 18],
    ["B002", "Warsaw Mokotow", "Central", 286, 137, 4520000, 4200000, 1.076, 16],
    ["B003", "Krakow Main", "South", 274, 129, 4190000, 4000000, 1.048, 15],
    ["B004", "Wroclaw Market", "West", 263, 121, 3980000, 4100000, 0.971, 14],
    ["B005", "Poznan Center", "West", 251, 116, 3740000, 3900000, 0.959, 13],
    ["B006", "Gdansk Old Town", "North", 239, 110, 3610000, 3500000, 1.031, 12],
    ["B007", "Lodz Piotrkowska", "Central", 226, 104, 3320000, 3600000, 0.922, 12],
    ["B008", "Katowice Silesia", "South", 218, 101, 3190000, 3400000, 0.938, 11],
]

CAMPAIGNS = [
    ["C-2501", "Start w banku", "Digital", "ROR Account", 5200, 1840, 1250, 1010, 0, 185000, 0.194, 3.41],
    ["C-2502", "Gotowka na start", "Branch", "Cash Loan", 3120, 1280, 774, 612, 8160000, 142000, 0.196, 4.75],
    ["C-2503", "Karta bez oplat", "Digital", "Credit Card", 4680, 1620, 936, 748, 2244000, 98000, 0.160, 5.08],
    ["C-2504", "Dom na lata", "Partner", "Mortgage", 880, 402, 221, 168, 45360000, 265000, 0.191, 3.28],
    ["C-2505", "Auto blizej", "Digital", "Auto Loan", 1960, 748, 431, 326, 9780000, 111000, 0.166, 4.90],
    ["C-2506", "Firma rosnie", "RM", "SME Loan", 720, 286, 178, 119, 14756000, 92000, 0.165, 5.12],
    ["C-2507", "Wiosenna premia", "Branch", "ROR Account", 2840, 1120, 844, 702, 0, 88000, 0.247, 3.96],
    ["C-2508", "Cross-sell Q4", "CRM", "Credit Card", 3540, 1388, 1012, 906, 2718000, 76000, 0.256, 7.91],
]

CAMPAIGN_MONTHLY = [
    ["Jan-25", 6200, 3200, 1100, 148, 4820000],
    ["Feb-25", 6500, 3340, 1160, 156, 5110000],
    ["Mar-25", 7180, 3620, 1240, 174, 5740000],
    ["Apr-25", 6900, 3510, 1210, 165, 5410000],
    ["May-25", 7540, 3860, 1320, 183, 6020000],
    ["Jun-25", 8120, 4120, 1410, 201, 6680000],
    ["Jul-25", 7980, 4040, 1380, 194, 6410000],
    ["Aug-25", 8460, 4290, 1470, 211, 7040000],
    ["Sep-25", 9020, 4560, 1520, 226, 7580000],
    ["Oct-25", 9460, 4780, 1610, 241, 8040000],
    ["Nov-25", 10120, 5120, 1740, 258, 8660000],
    ["Dec-25", 10980, 5480, 1880, 287, 9680000],
]

CAMPAIGN_FUNNEL = [
    ["Leads", 36840, 1.0],
    ["Qualified", 14820, 0.4024],
    ["Applications", 6690, 0.4514],
    ["Approved", 3846, 0.5749],
    ["Sold", 2591, 0.6737],
]

CAMPAIGN_SEGMENTS = [
    ["Mass retail", 1860, 1154, 14280000, 12375, 0.182],
    ["Affluent", 642, 512, 19840000, 38750, 0.316],
    ["Young adults", 1134, 824, 4960000, 6020, 0.247],
    ["Families", 884, 624, 18460000, 29585, 0.204],
    ["Micro-business", 392, 286, 15220000, 53150, 0.228],
]

BRANCH_RANKING = [
    ["B001", "Warsaw Central", "Central", 1, 4860000, 1.080, 28.4, 1.62],
    ["B002", "Warsaw Mokotow", "Central", 2, 4520000, 1.076, 26.8, 1.55],
    ["B003", "Krakow Main", "South", 3, 4190000, 1.048, 25.9, 1.48],
    ["B006", "Gdansk Old Town", "North", 4, 3610000, 1.031, 24.7, 1.42],
    ["B004", "Wroclaw Market", "West", 5, 3980000, 0.971, 23.8, 1.36],
    ["B005", "Poznan Center", "West", 6, 3740000, 0.959, 22.9, 1.31],
    ["B008", "Katowice Silesia", "South", 7, 3190000, 0.938, 21.8, 1.26],
    ["B007", "Lodz Piotrkowska", "Central", 8, 3320000, 0.922, 20.7, 1.19],
]

ADVISOR_RANKING = [
    ["A-014", "Anna Kowalska", "B001", "Central", 92, 38, 1280000, 1.21],
    ["A-031", "Piotr Nowak", "B002", "Central", 86, 41, 1190000, 1.18],
    ["A-022", "Marta Wisniewska", "B003", "South", 79, 36, 1110000, 1.16],
    ["A-048", "Tomasz Zielinski", "B006", "North", 74, 34, 1040000, 1.13],
    ["A-017", "Katarzyna Wojcik", "B004", "West", 71, 32, 990000, 1.10],
    ["A-039", "Jakub Kaminski", "B005", "West", 68, 31, 947000, 1.08],
    ["A-027", "Natalia Lewandowska", "B008", "South", 65, 28, 884000, 1.04],
    ["A-054", "Michal Dabrowski", "B007", "Central", 61, 27, 842000, 1.01],
]

PRODUCT_MIX = [
    ["Jan-25", 420, 142, 34, 67, 28, 18],
    ["Feb-25", 438, 151, 36, 71, 30, 19],
    ["Mar-25", 470, 168, 41, 76, 32, 21],
    ["Apr-25", 455, 159, 39, 74, 31, 20],
    ["May-25", 486, 177, 43, 80, 35, 22],
    ["Jun-25", 512, 192, 47, 84, 37, 24],
    ["Jul-25", 505, 185, 46, 82, 36, 23],
    ["Aug-25", 528, 201, 50, 88, 39, 25],
    ["Sep-25", 541, 214, 53, 92, 41, 27],
    ["Oct-25", 563, 226, 56, 96, 44, 29],
    ["Nov-25", 589, 241, 61, 101, 47, 31],
    ["Dec-25", 624, 268, 68, 109, 52, 35],
]

CROSS_SELL = [
    ["B001", "Warsaw Central", 4820, 2940, 0.610, 1.62, 0.84, 0.43],
    ["B002", "Warsaw Mokotow", 4380, 2450, 0.559, 1.55, 0.79, 0.39],
    ["B003", "Krakow Main", 4120, 2240, 0.544, 1.48, 0.76, 0.36],
    ["B004", "Wroclaw Market", 3980, 2090, 0.525, 1.36, 0.71, 0.34],
    ["B005", "Poznan Center", 3760, 1930, 0.513, 1.31, 0.68, 0.31],
    ["B006", "Gdansk Old Town", 3420, 1890, 0.553, 1.42, 0.73, 0.35],
    ["B007", "Lodz Piotrkowska", 3610, 1760, 0.488, 1.19, 0.64, 0.29],
    ["B008", "Katowice Silesia", 3480, 1690, 0.486, 1.26, 0.66, 0.30],
]


def total(rows: Sequence[Sequence[Any]], index: int) -> float:
    return sum(float(row[index] or 0) for row in rows)


def mean(rows: Sequence[Sequence[Any]], index: int) -> float:
    return total(rows, index) / len(rows)


def fmt_for_header(header: str, formats: dict[str, Any]) -> Any:
    normalized = header.lower()
    if "rate" in normalized or "share" in normalized or "conversion" in normalized:
        return formats["percent"]
    if "roi" in normalized:
        return formats["multiple"]
    if "pln" in normalized or "volume" in normalized or "spend" in normalized or "ticket" in normalized:
        return formats["money"]
    if "sales" in normalized or "accounts" in normalized or "leads" in normalized or "approved" in normalized or "sold" in normalized or "count" in normalized or "customers" in normalized or "applications" in normalized or "advisors" in normalized:
        return formats["integer"]
    return formats["text"]


def write_raw_sheet(
    workbook: xlsxwriter.Workbook,
    name: str,
    table_name: str,
    headers: Sequence[str],
    rows: Sequence[Sequence[Any]],
    formats: dict[str, Any],
    tab_color: str = COLORS["blue"],
) -> xlsxwriter.worksheet.Worksheet:
    worksheet = workbook.add_worksheet(name)
    worksheet.set_tab_color(tab_color)
    worksheet.hide_gridlines(2)
    worksheet.freeze_panes(1, 0)
    worksheet.set_header("&L&\"Calibri,Bold\"Raw data: " + name + "&RPage &P of &N")
    worksheet.set_footer("&LJustyBase dashboard fixture&RConfidential synthetic data")
    worksheet.set_landscape()
    worksheet.fit_to_pages(1, 0)

    for column, header in enumerate(headers):
        worksheet.write(0, column, header, formats["table_header"])
    for row_index, row in enumerate(rows, start=1):
        for column, value in enumerate(row):
            worksheet.write(row_index, column, value, fmt_for_header(headers[column], formats))

    worksheet.add_table(
        0,
        0,
        len(rows),
        len(headers) - 1,
        {
            "name": table_name,
            "style": "Table Style Medium 2",
            "columns": [{"header": header} for header in headers],
        },
    )

    for column, header in enumerate(headers):
        max_length = max(
            len(str(header)),
            *(len(str(row[column])) for row in rows if row[column] is not None),
        )
        worksheet.set_column(column, column, min(max(max_length + 2, 12), 24))

    numeric_columns = [
        column for column, header in enumerate(headers)
        if any(token in header.lower() for token in ("rate", "share", "roi", "volume", "sales", "sold", "leads", "count", "customers", "applications", "approved"))
    ]
    for column in numeric_columns:
        worksheet.conditional_format(
            1,
            column,
            len(rows),
            column,
            {"type": "3_color_scale", "min_color": "FFF3F6F9", "mid_color": "FFB9D7EA", "max_color": "FF2F75B5"},
        )
    return worksheet


def define_dynamic_columns(
    workbook: xlsxwriter.Workbook,
    sheet_name: str,
    headers: Sequence[str],
    prefix: str,
) -> dict[str, str]:
    """Create names whose height follows a replaceable raw table.

    ``XlsxUpdater`` updates the table and worksheet range.  Charts use these
    names instead of fixed row endpoints, so a later export with a different
    row count remains connected to the presentation layer.
    """
    names: dict[str, str] = {}
    for column, header in enumerate(headers):
        letter = xlsxwriter.utility.xl_col_to_name(column)
        name = f"{prefix}_{header}"
        formula = f"='{sheet_name}'!${letter}$2:INDEX('{sheet_name}'!${letter}:${letter},COUNTA('{sheet_name}'!$A:$A))"
        workbook.define_name(name, formula)
        names[header] = name
    return names


def setup_formats(workbook: xlsxwriter.Workbook) -> dict[str, Any]:
    return {
        "title": workbook.add_format({"bold": True, "font_size": 20, "font_color": COLORS["white"], "bg_color": COLORS["navy"], "align": "left", "valign": "vcenter"}),
        "subtitle": workbook.add_format({"italic": True, "font_size": 10, "font_color": COLORS["white"], "bg_color": COLORS["navy"], "align": "left", "valign": "vcenter"}),
        "note": workbook.add_format({"font_size": 9, "font_color": COLORS["muted"], "bg_color": COLORS["canvas"], "text_wrap": True, "valign": "vcenter"}),
        "section": workbook.add_format({"bold": True, "font_size": 11, "font_color": COLORS["white"], "bg_color": COLORS["teal"], "align": "left", "valign": "vcenter"}),
        "table_header": workbook.add_format({"bold": True, "font_color": COLORS["white"], "bg_color": COLORS["navy"], "border": 1, "border_color": COLORS["line"], "text_wrap": True, "valign": "vcenter"}),
        "text": workbook.add_format({"font_color": COLORS["ink"], "border": 0}),
        "integer": workbook.add_format({"font_color": COLORS["ink"], "num_format": "#,##0"}),
        "money": workbook.add_format({"font_color": COLORS["ink"], "num_format": "#,##0 \"PLN\""}),
        "percent": workbook.add_format({"font_color": COLORS["ink"], "num_format": "0.0%"}),
        "multiple": workbook.add_format({"font_color": COLORS["ink"], "num_format": "0.00x"}),
        "kpi_label": workbook.add_format({"bold": True, "font_size": 9, "font_color": COLORS["muted"], "bg_color": COLORS["sky"], "align": "center", "valign": "vcenter", "border": 1, "border_color": COLORS["line"]}),
        "kpi_value": workbook.add_format({"bold": True, "font_size": 17, "font_color": COLORS["navy"], "bg_color": COLORS["white"], "align": "center", "valign": "vcenter", "border": 1, "border_color": COLORS["line"]}),
        "kpi_value_money": workbook.add_format({"bold": True, "font_size": 15, "font_color": COLORS["green"], "bg_color": COLORS["white"], "align": "center", "valign": "vcenter", "border": 1, "border_color": COLORS["line"], "num_format": "#,##0 \"PLN\""}),
        "kpi_value_percent": workbook.add_format({"bold": True, "font_size": 17, "font_color": COLORS["green"], "bg_color": COLORS["white"], "align": "center", "valign": "vcenter", "border": 1, "border_color": COLORS["line"], "num_format": "0.0%"}),
        "kpi_value_multiple": workbook.add_format({"bold": True, "font_size": 17, "font_color": COLORS["green"], "bg_color": COLORS["white"], "align": "center", "valign": "vcenter", "border": 1, "border_color": COLORS["line"], "num_format": "0.00x"}),
        "dashboard_text": workbook.add_format({"font_color": COLORS["ink"], "bg_color": COLORS["white"]}),
        "dashboard_integer": workbook.add_format({"font_color": COLORS["ink"], "bg_color": COLORS["white"], "num_format": "#,##0"}),
        "dashboard_money": workbook.add_format({"font_color": COLORS["ink"], "bg_color": COLORS["white"], "num_format": "#,##0 \"PLN\""}),
        "dashboard_percent": workbook.add_format({"font_color": COLORS["ink"], "bg_color": COLORS["white"], "num_format": "0.0%"}),
        "dashboard_multiple": workbook.add_format({"font_color": COLORS["ink"], "bg_color": COLORS["white"], "num_format": "0.00x"}),
        "guide_header": workbook.add_format({"bold": True, "font_color": COLORS["white"], "bg_color": COLORS["navy"]}),
        "guide_text": workbook.add_format({"font_color": COLORS["ink"], "text_wrap": True, "valign": "top"}),
        "guide_code": workbook.add_format({"font_name": "Consolas", "font_color": COLORS["navy"], "bg_color": COLORS["canvas"], "text_wrap": True, "valign": "top"}),
    }


def configure_dashboard(worksheet: xlsxwriter.worksheet.Worksheet, formats: dict[str, Any], title: str, subtitle: str) -> None:
    worksheet.hide_gridlines(2)
    worksheet.set_tab_color(COLORS["navy"])
    worksheet.set_landscape()
    worksheet.fit_to_pages(1, 1)
    worksheet.set_margins(left=0.25, right=0.25, top=0.35, bottom=0.35)
    worksheet.set_header("&LJustyBase banking reporting fixture&R&\"Calibri,Bold\"Dashboard")
    worksheet.set_footer("&LGenerated synthetic example&RPage &P of &N")
    worksheet.set_row(0, 31)
    worksheet.set_row(1, 21)
    worksheet.merge_range("A1:N1", title, formats["title"])
    worksheet.merge_range("A2:N2", subtitle, formats["subtitle"])
    worksheet.merge_range("A3:N3", "Refresh contract: replace only Raw_* tabs with %EXPORT(update=true); formulas and charts stay in the presentation layer.", formats["note"])
    worksheet.set_row(2, 28)
    worksheet.set_column("A:A", 23)
    worksheet.set_column("B:B", 17)
    worksheet.set_column("C:C", 17)
    worksheet.set_column("D:D", 17)
    worksheet.set_column("E:E", 3)
    worksheet.set_column("F:F", 18)
    worksheet.set_column("G:N", 14)


def write_kpi(
    worksheet: xlsxwriter.worksheet.Worksheet,
    formats: dict[str, Any],
    first_col: int,
    label: str,
    formula: str,
    cached_value: Any,
    value_format: Any,
    source: str,
) -> None:
    worksheet.merge_range(3, first_col, 3, first_col + 2, label, formats["kpi_label"])
    worksheet.merge_range(4, first_col, 5, first_col + 2, "", formats["kpi_value"])
    worksheet.write_formula(4, first_col, formula, value_format, cached_value)
    worksheet.merge_range(6, first_col, 6, first_col + 2, f"Source: {source}", formats["note"])


def write_section(worksheet: xlsxwriter.worksheet.Worksheet, row: int, title: str, formats: dict[str, Any], first_col: int = 0, last_col: int = 3) -> None:
    worksheet.merge_range(row, first_col, row, last_col, title, formats["section"])


def write_dashboard_table(
    worksheet: xlsxwriter.worksheet.Worksheet,
    formats: dict[str, Any],
    start_row: int,
    start_col: int,
    table_name: str,
    headers: Sequence[str],
    rows: Sequence[Sequence[Any]],
    column_formats: Sequence[Any],
) -> None:
    for column, header in enumerate(headers):
        worksheet.write(start_row, start_col + column, header, formats["table_header"])
    for row_offset, row in enumerate(rows, start=1):
        for column, value in enumerate(row):
            worksheet.write(start_row + row_offset, start_col + column, value, column_formats[column])
    worksheet.add_table(
        start_row,
        start_col,
        start_row + len(rows),
        start_col + len(headers) - 1,
        {"name": table_name, "style": "Table Style Light 9", "columns": [{"header": header} for header in headers]},
    )


def add_chart_style(chart: xlsxwriter.chart.Chart, title: str) -> None:
    chart.set_title({"name": title, "name_font": {"bold": True, "color": COLORS["navy"], "size": 12}})
    chart.set_chartarea({"border": {"none": True}, "fill": {"color": COLORS["white"]}})
    chart.set_plotarea({"border": {"color": COLORS["line"]}, "fill": {"color": COLORS["white"]}})
    chart.set_style(10)
    chart.set_size({"width": 570, "height": 270})


def add_dynamic_series(
    chart: xlsxwriter.chart.Chart,
    options: dict[str, Any],
    categories: Sequence[Any],
    values: Sequence[Any],
) -> None:
    """Add a named-range series with a useful cached preview.

    The names keep the chart dynamic after an update. The explicit cache keeps
    the dashboard visible before Excel performs its first recalculation.
    """
    series_options = dict(options)
    series_options["categories_data"] = categories
    series_options["values_data"] = values
    chart.add_series(series_options)


def add_guide_sheet(
    workbook: xlsxwriter.Workbook,
    formats: dict[str, Any],
    title: str,
    contracts: Sequence[Sequence[str]],
    example_file: str,
) -> None:
    worksheet = workbook.add_worksheet("Model_Guide")
    worksheet.set_tab_color(COLORS["orange"])
    worksheet.hide_gridlines(2)
    worksheet.set_column("A:A", 23)
    worksheet.set_column("B:B", 28)
    worksheet.set_column("C:C", 70)
    worksheet.set_row(0, 28)
    worksheet.merge_range("A1:C1", title, formats["title"])
    worksheet.write("A3", "Purpose", formats["guide_header"])
    worksheet.merge_range("B3:C3", "A documentation fixture for refreshable reporting with @justybase/spreadsheet-tasks.", formats["guide_text"])
    worksheet.write("A5", "Raw tab", formats["guide_header"])
    worksheet.write("B5", "Table", formats["guide_header"])
    worksheet.write("C5", "Replacement contract", formats["guide_header"])
    for row, contract in enumerate(contracts, start=5):
        worksheet.write(row, 0, contract[0], formats["guide_text"])
        worksheet.write(row, 1, contract[1], formats["guide_text"])
        worksheet.write(row, 2, contract[2], formats["guide_text"])
    example_row = 7 + len(contracts)
    worksheet.write(example_row, 0, "Update example", formats["guide_header"])
    worksheet.merge_range(example_row, 1, example_row, 2, f"%EXPORT(format='xlsx', file='/reports/{example_file}', sheet='Raw_Monthly', query=(SELECT ...), update=true);", formats["guide_code"])
    worksheet.write(example_row + 2, 0, "Design notes", formats["guide_header"])
    worksheet.merge_range(example_row + 2, 1, example_row + 4, 2, "Dashboard formulas use Excel table references and charts use dynamic workbook names. The updater replaces a raw sheet, updates its table range, and preserves the other sheets and dashboard drawing. Open in desktop Excel to recalculate formulas and refresh any external PivotTable caches.", formats["guide_text"])
    worksheet.freeze_panes(5, 0)


def build_sales_workbook(path: Path) -> None:
    workbook = xlsxwriter.Workbook(str(path))
    workbook.set_properties({"title": "Banking Sales Overview", "subject": "Refreshable synthetic banking dashboard", "author": "JustyBase", "comments": "Synthetic data for documentation and tests only."})
    workbook.set_calc_mode("auto")
    formats = setup_formats(workbook)
    dashboard = workbook.add_worksheet("Dashboard")
    configure_dashboard(dashboard, formats, "BANKING SALES DASHBOARD", "ROR acquisition • credit sales • product mix • branch target attainment | synthetic 2025 model")

    monthly_headers = ["Month", "New_ROR_Accounts", "Credit_Applications", "Credit_Sales", "Credit_Volume_PLN", "Active_Campaigns", "Conversion_Rate"]
    products_headers = ["Product", "Category", "Applications", "Approved", "Sold", "Volume_PLN", "Share_of_Sales"]
    branches_headers = ["Branch_ID", "Branch", "Region", "ROR_Sales", "Credit_Sales", "Total_Volume_PLN", "Target_PLN", "Attainment_Rate", "Active_Advisors"]
    write_raw_sheet(workbook, "Raw_Monthly", "tblSalesMonthly", monthly_headers, SALES_MONTHLY, formats)
    write_raw_sheet(workbook, "Raw_Products", "tblSalesProducts", products_headers, SALES_PRODUCTS, formats, COLORS["teal"])
    write_raw_sheet(workbook, "Raw_Branches", "tblSalesBranches", branches_headers, SALES_BRANCHES, formats, COLORS["green"])
    monthly_names = define_dynamic_columns(workbook, "Raw_Monthly", monthly_headers, "sales_monthly")
    product_names = define_dynamic_columns(workbook, "Raw_Products", products_headers, "sales_products")
    branch_names = define_dynamic_columns(workbook, "Raw_Branches", branches_headers, "sales_branches")

    write_kpi(dashboard, formats, 0, "New ROR accounts", "=SUM(tblSalesMonthly[New_ROR_Accounts])", total(SALES_MONTHLY, 1), formats["kpi_value"], "Raw_Monthly")
    write_kpi(dashboard, formats, 3, "Credit sales", "=SUM(tblSalesMonthly[Credit_Sales])", total(SALES_MONTHLY, 3), formats["kpi_value"], "Raw_Monthly")
    write_kpi(dashboard, formats, 6, "Credit volume", "=SUM(tblSalesMonthly[Credit_Volume_PLN])", total(SALES_MONTHLY, 4), formats["kpi_value_money"], "Raw_Monthly")
    write_kpi(dashboard, formats, 10, "Average conversion", "=AVERAGE(tblSalesMonthly[Conversion_Rate])", mean(SALES_MONTHLY, 6), formats["kpi_value_percent"], "Raw_Monthly")

    write_section(dashboard, 8, "MONTHLY SALES TREND", formats, 0, 3)
    trend_headers = ["Month", "ROR accounts", "Credit sales", "Volume PLN"]
    trend_rows = [[row[0], row[1], row[3], row[4]] for row in SALES_MONTHLY]
    write_dashboard_table(dashboard, formats, 9, 0, "tblSalesTrend", trend_headers, trend_rows, [formats["dashboard_text"], formats["dashboard_integer"], formats["dashboard_integer"], formats["dashboard_money"]])

    write_section(dashboard, 8, "PRODUCT RANKING", formats, 6, 13)
    product_rows = [[row[0], row[1], row[4], row[5], row[6]] for row in SALES_PRODUCTS]
    write_dashboard_table(dashboard, formats, 9, 6, "tblSalesProductView", ["Product", "Category", "Sold", "Volume PLN", "Share"], product_rows, [formats["dashboard_text"], formats["dashboard_text"], formats["dashboard_integer"], formats["dashboard_money"], formats["dashboard_percent"]])

    write_section(dashboard, 23, "BRANCH TARGET ATTAINMENT", formats, 0, 5)
    branch_rows = [[row[0], row[1], row[2], row[5], row[6], row[7]] for row in SALES_BRANCHES]
    write_dashboard_table(dashboard, formats, 24, 0, "tblSalesBranchView", ["ID", "Branch", "Region", "Volume PLN", "Target PLN", "Attainment"], branch_rows, [formats["dashboard_text"], formats["dashboard_text"], formats["dashboard_text"], formats["dashboard_money"], formats["dashboard_money"], formats["dashboard_percent"]])
    dashboard.conditional_format(25, 5, 25 + len(branch_rows) - 1, 5, {"type": "data_bar", "bar_color": COLORS["green"]})

    line_chart = workbook.add_chart({"type": "line"})
    add_dynamic_series(line_chart, {"name": "Credit sales", "categories": f"={monthly_names['Month']}", "values": f"={monthly_names['Credit_Sales']}", "line": {"color": COLORS["blue"], "width": 2.5}, "marker": {"type": "circle", "size": 5, "border": {"color": COLORS["blue"]}, "fill": {"color": COLORS["white"]}}}, [row[0] for row in SALES_MONTHLY], [row[3] for row in SALES_MONTHLY])
    add_chart_style(line_chart, "Monthly credit sales")
    line_chart.set_y_axis({"num_format": "#,##0", "major_gridlines": {"visible": False}})
    dashboard.insert_chart("F17", line_chart)

    product_chart = workbook.add_chart({"type": "column"})
    add_dynamic_series(product_chart, {"name": "Volume PLN", "categories": f"={product_names['Product']}", "values": f"={product_names['Volume_PLN']}", "fill": {"color": COLORS["green"]}, "border": {"none": True}, "data_labels": {"value": False}}, [row[0] for row in SALES_PRODUCTS], [row[5] for row in SALES_PRODUCTS])
    add_chart_style(product_chart, "Product volume")
    product_chart.set_y_axis({"num_format": "#,##0,,\"m PLN\"", "major_gridlines": {"visible": False}})
    product_chart.set_legend({"none": True})
    dashboard.insert_chart("F32", product_chart)

    branch_chart = workbook.add_chart({"type": "bar"})
    add_dynamic_series(branch_chart, {"name": "Attainment", "categories": f"={branch_names['Branch']}", "values": f"={branch_names['Attainment_Rate']}", "fill": {"color": COLORS["orange"]}, "border": {"none": True}, "data_labels": {"value": True, "num_format": "0%"}}, [row[1] for row in SALES_BRANCHES], [row[7] for row in SALES_BRANCHES])
    add_chart_style(branch_chart, "Branch target attainment")
    branch_chart.set_x_axis({"num_format": "0%", "major_gridlines": {"visible": False}})
    branch_chart.set_legend({"none": True})
    dashboard.insert_chart("F47", branch_chart)

    contracts = [
        ["Raw_Monthly", "tblSalesMonthly", "Month, New_ROR_Accounts, Credit_Applications, Credit_Sales, Credit_Volume_PLN, Active_Campaigns, Conversion_Rate"],
        ["Raw_Products", "tblSalesProducts", "Product, Category, Applications, Approved, Sold, Volume_PLN, Share_of_Sales"],
        ["Raw_Branches", "tblSalesBranches", "Branch_ID, Branch, Region, ROR_Sales, Credit_Sales, Total_Volume_PLN, Target_PLN, Attainment_Rate, Active_Advisors"],
    ]
    add_guide_sheet(workbook, formats, "SALES OVERVIEW | MODEL GUIDE", contracts, "bank-sales-overview.xlsx")
    workbook.close()


def build_campaign_workbook(path: Path) -> None:
    workbook = xlsxwriter.Workbook(str(path))
    workbook.set_properties({"title": "Campaign Performance", "subject": "Refreshable synthetic campaign dashboard", "author": "JustyBase", "comments": "Synthetic data for documentation and tests only."})
    workbook.set_calc_mode("auto")
    formats = setup_formats(workbook)
    dashboard = workbook.add_worksheet("Dashboard")
    configure_dashboard(dashboard, formats, "CAMPAIGN PERFORMANCE DASHBOARD", "Acquisition funnel • channel mix • campaign ROI • segment performance | synthetic 2025 model")

    campaigns_headers = ["Campaign_ID", "Campaign", "Channel", "Product", "Leads", "Applications", "Approved", "Sold", "Volume_PLN", "Spend_PLN", "Conversion_Rate", "ROI"]
    monthly_headers = ["Month", "Digital_Leads", "Branch_Leads", "Partner_Leads", "Total_Sales", "Volume_PLN"]
    funnel_headers = ["Stage", "Count", "Conversion_From_Previous"]
    segments_headers = ["Segment", "ROR_New", "Credit_Sales", "Volume_PLN", "Avg_Ticket_PLN", "Cross_Sell_Rate"]
    write_raw_sheet(workbook, "Raw_Campaigns", "tblCampaigns", campaigns_headers, CAMPAIGNS, formats)
    write_raw_sheet(workbook, "Raw_Monthly_Campaigns", "tblCampaignMonths", monthly_headers, CAMPAIGN_MONTHLY, formats, COLORS["teal"])
    write_raw_sheet(workbook, "Raw_Funnel", "tblCampaignFunnel", funnel_headers, CAMPAIGN_FUNNEL, formats, COLORS["orange"])
    write_raw_sheet(workbook, "Raw_Segments", "tblCampaignSegments", segments_headers, CAMPAIGN_SEGMENTS, formats, COLORS["green"])
    campaign_names = define_dynamic_columns(workbook, "Raw_Campaigns", campaigns_headers, "campaigns")
    monthly_names = define_dynamic_columns(workbook, "Raw_Monthly_Campaigns", monthly_headers, "campaign_months")
    funnel_names = define_dynamic_columns(workbook, "Raw_Funnel", funnel_headers, "campaign_funnel")

    write_kpi(dashboard, formats, 0, "Total leads", "=SUM(tblCampaignMonths[Digital_Leads])+SUM(tblCampaignMonths[Branch_Leads])+SUM(tblCampaignMonths[Partner_Leads])", total(CAMPAIGN_MONTHLY, 1) + total(CAMPAIGN_MONTHLY, 2) + total(CAMPAIGN_MONTHLY, 3), formats["kpi_value"], "Raw_Monthly_Campaigns")
    write_kpi(dashboard, formats, 3, "Sold products", "=SUM(tblCampaigns[Sold])", total(CAMPAIGNS, 7), formats["kpi_value"], "Raw_Campaigns")
    write_kpi(dashboard, formats, 6, "Sales volume", "=SUM(tblCampaigns[Volume_PLN])", total(CAMPAIGNS, 8), formats["kpi_value_money"], "Raw_Campaigns")
    write_kpi(dashboard, formats, 10, "Average ROI", "=AVERAGE(tblCampaigns[ROI])", mean(CAMPAIGNS, 11), formats["kpi_value_multiple"], "Raw_Campaigns")

    write_section(dashboard, 8, "CAMPAIGN RANKING", formats, 0, 5)
    campaign_view = [[row[1], row[2], row[3], row[7], row[8], row[11]] for row in CAMPAIGNS]
    write_dashboard_table(dashboard, formats, 9, 0, "tblCampaignView", ["Campaign", "Channel", "Product", "Sold", "Volume PLN", "ROI"], campaign_view, [formats["dashboard_text"], formats["dashboard_text"], formats["dashboard_text"], formats["dashboard_integer"], formats["dashboard_money"], formats["dashboard_multiple"]])
    write_section(dashboard, 8, "ACQUISITION FUNNEL", formats, 7, 10)
    write_dashboard_table(dashboard, formats, 9, 7, "tblCampaignFunnelView", ["Stage", "Count", "Conversion"], CAMPAIGN_FUNNEL, [formats["dashboard_text"], formats["dashboard_integer"], formats["dashboard_percent"]])
    dashboard.conditional_format(10, 8, 9 + len(CAMPAIGN_FUNNEL), 8, {"type": "data_bar", "bar_color": COLORS["orange"]})

    write_section(dashboard, 20, "MONTHLY CHANNEL TREND", formats, 0, 5)
    write_dashboard_table(dashboard, formats, 21, 0, "tblCampaignMonthView", ["Month", "Digital leads", "Branch leads", "Partner leads", "Sales", "Volume PLN"], CAMPAIGN_MONTHLY, [formats["dashboard_text"], formats["dashboard_integer"], formats["dashboard_integer"], formats["dashboard_integer"], formats["dashboard_integer"], formats["dashboard_money"]])
    write_section(dashboard, 20, "CUSTOMER SEGMENTS", formats, 7, 12)
    write_dashboard_table(dashboard, formats, 21, 7, "tblCampaignSegmentView", ["Segment", "ROR new", "Credit sales", "Volume PLN", "Avg ticket", "Cross-sell"], CAMPAIGN_SEGMENTS, [formats["dashboard_text"], formats["dashboard_integer"], formats["dashboard_integer"], formats["dashboard_money"], formats["dashboard_money"], formats["dashboard_percent"]])

    roi_chart = workbook.add_chart({"type": "bar"})
    add_dynamic_series(roi_chart, {"name": "ROI", "categories": f"={campaign_names['Campaign']}", "values": f"={campaign_names['ROI']}", "fill": {"color": COLORS["green"]}, "border": {"none": True}, "data_labels": {"value": True, "num_format": "0.00x"}}, [row[1] for row in CAMPAIGNS], [row[11] for row in CAMPAIGNS])
    add_chart_style(roi_chart, "Campaign ROI")
    roi_chart.set_x_axis({"num_format": "0.0x", "major_gridlines": {"visible": False}})
    roi_chart.set_legend({"none": True})
    dashboard.insert_chart("F35", roi_chart)

    volume_chart = workbook.add_chart({"type": "line"})
    add_dynamic_series(volume_chart, {"name": "Volume PLN", "categories": f"={monthly_names['Month']}", "values": f"={monthly_names['Volume_PLN']}", "line": {"color": COLORS["blue"], "width": 2.5}, "marker": {"type": "circle", "size": 4, "fill": {"color": COLORS["blue"]}}}, [row[0] for row in CAMPAIGN_MONTHLY], [row[5] for row in CAMPAIGN_MONTHLY])
    add_chart_style(volume_chart, "Monthly campaign sales volume")
    volume_chart.set_y_axis({"num_format": "#,##0,,\"m PLN\"", "major_gridlines": {"visible": False}})
    volume_chart.set_legend({"none": True})
    dashboard.insert_chart("F50", volume_chart)

    funnel_chart = workbook.add_chart({"type": "column"})
    add_dynamic_series(funnel_chart, {"name": "Count", "categories": f"={funnel_names['Stage']}", "values": f"={funnel_names['Count']}", "fill": {"color": COLORS["orange"]}, "border": {"none": True}, "data_labels": {"value": True}}, [row[0] for row in CAMPAIGN_FUNNEL], [row[1] for row in CAMPAIGN_FUNNEL])
    add_chart_style(funnel_chart, "Acquisition funnel")
    funnel_chart.set_y_axis({"num_format": "#,##0", "major_gridlines": {"visible": False}})
    funnel_chart.set_legend({"none": True})
    dashboard.insert_chart("F65", funnel_chart)

    contracts = [
        ["Raw_Campaigns", "tblCampaigns", "Campaign_ID, Campaign, Channel, Product, Leads, Applications, Approved, Sold, Volume_PLN, Spend_PLN, Conversion_Rate, ROI"],
        ["Raw_Monthly_Campaigns", "tblCampaignMonths", "Month, Digital_Leads, Branch_Leads, Partner_Leads, Total_Sales, Volume_PLN"],
        ["Raw_Funnel", "tblCampaignFunnel", "Stage, Count, Conversion_From_Previous"],
        ["Raw_Segments", "tblCampaignSegments", "Segment, ROR_New, Credit_Sales, Volume_PLN, Avg_Ticket_PLN, Cross_Sell_Rate"],
    ]
    add_guide_sheet(workbook, formats, "CAMPAIGN PERFORMANCE | MODEL GUIDE", contracts, "campaign-performance.xlsx")
    workbook.close()


def build_branch_workbook(path: Path) -> None:
    workbook = xlsxwriter.Workbook(str(path))
    workbook.set_properties({"title": "Branch and Productization Ranking", "subject": "Refreshable synthetic banking ranking dashboard", "author": "JustyBase", "comments": "Synthetic data for documentation and tests only."})
    workbook.set_calc_mode("auto")
    formats = setup_formats(workbook)
    dashboard = workbook.add_worksheet("Dashboard")
    configure_dashboard(dashboard, formats, "BRANCH & PRODUCTIZATION DASHBOARD", "Branch ranking • advisor productivity • product mix • multi-product customers | synthetic 2025 model")

    branch_headers = ["Branch_ID", "Branch", "Region", "Rank", "Credit_Volume_PLN", "Attainment_Rate", "ROR_per_Advisor", "Productization_Rate"]
    advisor_headers = ["Advisor_ID", "Advisor", "Branch_ID", "Region", "ROR_Sales", "Credit_Sales", "Credit_Volume_PLN", "Attainment_Rate"]
    mix_headers = ["Month", "ROR", "Cash_Loan", "Mortgage", "Credit_Card", "Insurance", "SME_Loan"]
    cross_headers = ["Branch_ID", "Branch", "Customers", "MultiProduct_Customers", "Productization_Rate", "Products_per_Customer", "Card_Rate", "Insurance_Rate"]
    write_raw_sheet(workbook, "Raw_Branches", "tblBranchRanking", branch_headers, BRANCH_RANKING, formats)
    write_raw_sheet(workbook, "Raw_Advisors", "tblAdvisorRanking", advisor_headers, ADVISOR_RANKING, formats, COLORS["teal"])
    write_raw_sheet(workbook, "Raw_Product_Mix", "tblProductMix", mix_headers, PRODUCT_MIX, formats, COLORS["orange"])
    write_raw_sheet(workbook, "Raw_CrossSell", "tblCrossSell", cross_headers, CROSS_SELL, formats, COLORS["green"])
    branch_names = define_dynamic_columns(workbook, "Raw_Branches", branch_headers, "branch_ranking")
    define_dynamic_columns(workbook, "Raw_Advisors", advisor_headers, "advisor_ranking")
    mix_names = define_dynamic_columns(workbook, "Raw_Product_Mix", mix_headers, "product_mix")
    cross_names = define_dynamic_columns(workbook, "Raw_CrossSell", cross_headers, "cross_sell")

    write_kpi(dashboard, formats, 0, "Avg productization", "=AVERAGE(tblCrossSell[Productization_Rate])", mean(CROSS_SELL, 4), formats["kpi_value_percent"], "Raw_CrossSell")
    write_kpi(dashboard, formats, 3, "Avg products / customer", "=AVERAGE(tblCrossSell[Products_per_Customer])", mean(CROSS_SELL, 5), formats["kpi_value_multiple"], "Raw_CrossSell")
    write_kpi(dashboard, formats, 6, "Top branch", "=INDEX(tblBranchRanking[Branch],1)", BRANCH_RANKING[0][1], formats["kpi_value"], "Raw_Branches")
    write_kpi(dashboard, formats, 10, "Top advisor", "=INDEX(tblAdvisorRanking[Advisor],1)", ADVISOR_RANKING[0][1], formats["kpi_value"], "Raw_Advisors")

    write_section(dashboard, 8, "BRANCH RANKING", formats, 0, 5)
    branch_view = [[row[0], row[1], row[2], row[3], row[4], row[5]] for row in BRANCH_RANKING]
    write_dashboard_table(dashboard, formats, 9, 0, "tblBranchView", ["ID", "Branch", "Region", "Rank", "Credit volume", "Attainment"], branch_view, [formats["dashboard_text"], formats["dashboard_text"], formats["dashboard_text"], formats["dashboard_integer"], formats["dashboard_money"], formats["dashboard_percent"]])
    dashboard.conditional_format(10, 5, 9 + len(branch_view), 5, {"type": "data_bar", "bar_color": COLORS["blue"]})
    write_section(dashboard, 8, "ADVISOR RANKING", formats, 7, 12)
    advisor_view = [[row[0], row[1], row[2], row[4], row[6], row[7]] for row in ADVISOR_RANKING]
    write_dashboard_table(dashboard, formats, 9, 7, "tblAdvisorView", ["ID", "Advisor", "Branch", "ROR sales", "Credit volume", "Attainment"], advisor_view, [formats["dashboard_text"], formats["dashboard_text"], formats["dashboard_text"], formats["dashboard_integer"], formats["dashboard_money"], formats["dashboard_percent"]])

    write_section(dashboard, 20, "PRODUCT MIX BY MONTH", formats, 0, 6)
    write_dashboard_table(dashboard, formats, 21, 0, "tblProductMixView", mix_headers, PRODUCT_MIX, [formats["dashboard_text"], formats["dashboard_integer"], formats["dashboard_integer"], formats["dashboard_integer"], formats["dashboard_integer"], formats["dashboard_integer"], formats["dashboard_integer"]])
    write_section(dashboard, 20, "CROSS-SELL BY BRANCH", formats, 8, 13)
    cross_view = [[row[0], row[1], row[2], row[3], row[4], row[5]] for row in CROSS_SELL]
    write_dashboard_table(dashboard, formats, 21, 8, "tblCrossSellView", ["ID", "Branch", "Customers", "Multi-product", "Productization", "Products/customer"], cross_view, [formats["dashboard_text"], formats["dashboard_text"], formats["dashboard_integer"], formats["dashboard_integer"], formats["dashboard_percent"], formats["dashboard_multiple"]])

    branch_chart = workbook.add_chart({"type": "bar"})
    add_dynamic_series(branch_chart, {"name": "Credit volume", "categories": f"={branch_names['Branch']}", "values": f"={branch_names['Credit_Volume_PLN']}", "fill": {"color": COLORS["blue"]}, "border": {"none": True}, "data_labels": {"value": True, "num_format": "#,##0,,\"m\""}}, [row[1] for row in BRANCH_RANKING], [row[4] for row in BRANCH_RANKING])
    add_chart_style(branch_chart, "Credit volume by branch")
    branch_chart.set_x_axis({"num_format": "#,##0,,\"m PLN\"", "major_gridlines": {"visible": False}})
    branch_chart.set_legend({"none": True})
    dashboard.insert_chart("F35", branch_chart)

    mix_chart = workbook.add_chart({"type": "line"})
    for header, color in (("ROR", COLORS["green"]), ("Cash_Loan", COLORS["orange"]), ("Credit_Card", COLORS["blue"]), ("Mortgage", COLORS["teal"])):
        header_index = mix_headers.index(header)
        add_dynamic_series(mix_chart, {"name": header, "categories": f"={mix_names['Month']}", "values": f"={mix_names[header]}", "line": {"color": color, "width": 2}}, [row[0] for row in PRODUCT_MIX], [row[header_index] for row in PRODUCT_MIX])
    add_chart_style(mix_chart, "Product mix trend")
    mix_chart.set_y_axis({"num_format": "#,##0", "major_gridlines": {"visible": False}})
    dashboard.insert_chart("F50", mix_chart)

    cross_chart = workbook.add_chart({"type": "column"})
    add_dynamic_series(cross_chart, {"name": "Productization rate", "categories": f"={cross_names['Branch']}", "values": f"={cross_names['Productization_Rate']}", "fill": {"color": COLORS["green"]}, "border": {"none": True}, "data_labels": {"value": True, "num_format": "0%"}}, [row[1] for row in CROSS_SELL], [row[4] for row in CROSS_SELL])
    add_chart_style(cross_chart, "Productization by branch")
    cross_chart.set_y_axis({"num_format": "0%", "major_gridlines": {"visible": False}})
    cross_chart.set_legend({"none": True})
    dashboard.insert_chart("F65", cross_chart)

    contracts = [
        ["Raw_Branches", "tblBranchRanking", "Branch_ID, Branch, Region, Rank, Credit_Volume_PLN, Attainment_Rate, ROR_per_Advisor, Productization_Rate"],
        ["Raw_Advisors", "tblAdvisorRanking", "Advisor_ID, Advisor, Branch_ID, Region, ROR_Sales, Credit_Sales, Credit_Volume_PLN, Attainment_Rate"],
        ["Raw_Product_Mix", "tblProductMix", "Month, ROR, Cash_Loan, Mortgage, Credit_Card, Insurance, SME_Loan"],
        ["Raw_CrossSell", "tblCrossSell", "Branch_ID, Branch, Customers, MultiProduct_Customers, Productization_Rate, Products_per_Customer, Card_Rate, Insurance_Rate"],
    ]
    add_guide_sheet(workbook, formats, "BRANCH RANKING | MODEL GUIDE", contracts, "branch-product-ranking.xlsx")
    workbook.close()


def main() -> None:
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    build_sales_workbook(OUTPUT_DIRECTORY / "bank-sales-overview.xlsx")
    build_branch_workbook(OUTPUT_DIRECTORY / "branch-product-ranking.xlsx")
    build_campaign_workbook(OUTPUT_DIRECTORY / "campaign-performance.xlsx")
    for file_path in sorted(OUTPUT_DIRECTORY.glob("*.xlsx")):
        print(f"Generated {file_path.relative_to(ROOT)} ({file_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
