#!/usr/bin/env python3
"""Validate the generated and external XLSX dashboard fixtures."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIRECTORY = ROOT / "fixtures" / "bank-dashboards"
OWN_FILES = (
    "bank-sales-overview.xlsx",
    "branch-product-ranking.xlsx",
    "campaign-performance.xlsx",
)
EXTERNAL_FILES = (
    "external/superstore-sales-dashboard.xlsx",
    "external/personal-finance-dashboard-2026.xlsx",
)


def xml_text(archive: zipfile.ZipFile, name: str) -> str:
    return archive.read(name).decode("utf-8")


def validate_xml_parts(archive: zipfile.ZipFile) -> None:
    for name in archive.namelist():
        if name.endswith(".xml") or name.endswith(".rels"):
            ElementTree.fromstring(archive.read(name))


def validate_no_calculation_chain(archive: zipfile.ZipFile, file_path: Path) -> None:
    """Excel rebuilds this cache; stale copies make Excel show a repair warning."""
    entries = set(archive.namelist())
    if "xl/calcChain.xml" in entries:
        raise AssertionError(f"stale calculation chain remains in {file_path}")

    relationships = xml_text(archive, "xl/_rels/workbook.xml.rels")
    if "/relationships/calcChain" in relationships:
        raise AssertionError(f"dangling calculation-chain relationship remains in {file_path}")

    content_types = xml_text(archive, "[Content_Types].xml")
    if 'PartName="/xl/calcChain.xml"' in content_types:
        raise AssertionError(f"dangling calculation-chain content type remains in {file_path}")


def table_ranges(archive: zipfile.ZipFile) -> list[str]:
    ranges: list[str] = []
    for name in archive.namelist():
        if not name.startswith("xl/tables/") or not name.endswith(".xml"):
            continue
        table = ElementTree.fromstring(archive.read(name))
        table_range = table.attrib.get("ref")
        if not table_range or not re.fullmatch(r"[A-Z]+\d+:[A-Z]+\d+", table_range):
            raise AssertionError(f"invalid table ref in {name}: {table_range!r}")
        ranges.append(table_range)
    return ranges


def validate_own_fixture(relative_path: str) -> None:
    file_path = FIXTURE_DIRECTORY / relative_path
    with zipfile.ZipFile(file_path) as archive:
        if archive.testzip() is not None:
            raise AssertionError(f"corrupt ZIP package: {file_path}")
        validate_xml_parts(archive)
        validate_no_calculation_chain(archive, file_path)
        workbook = xml_text(archive, "xl/workbook.xml")
        first_sheet = re.search(r'<sheet\b[^>]*\bname="([^"]+)"', workbook)
        if not first_sheet or first_sheet.group(1) != "Dashboard":
            raise AssertionError(f"Dashboard is not the first sheet in {file_path}")
        chart_count = sum(name.startswith("xl/charts/chart") and name.endswith(".xml") for name in archive.namelist())
        if chart_count != 3:
            raise AssertionError(f"expected three charts in {file_path}, found {chart_count}")
        raw_sheet_count = len(re.findall(r'<sheet\b[^>]*\bname="Raw_[^"]+"', workbook))
        if raw_sheet_count < 3:
            raise AssertionError(f"expected at least three Raw sheets in {file_path}")
        if len(table_ranges(archive)) < raw_sheet_count:
            raise AssertionError(f"every raw sheet should have a native table in {file_path}")


def validate_external_fixture(relative_path: str) -> None:
    file_path = FIXTURE_DIRECTORY / relative_path
    with zipfile.ZipFile(file_path) as archive:
        if archive.testzip() is not None:
            raise AssertionError(f"corrupt ZIP package: {file_path}")
        validate_xml_parts(archive)
        validate_no_calculation_chain(archive, file_path)
        entries = set(archive.namelist())
        pivot_count = len([name for name in entries if name.startswith("xl/pivotTables/")])
        slicer_count = len([name for name in entries if name.startswith("xl/slicerCaches/") or name.startswith("xl/slicers/")])
        chart_count = len([name for name in entries if name.startswith("xl/charts/chart") and name.endswith(".xml")])
        if pivot_count == 0 or slicer_count == 0 or chart_count == 0:
            raise AssertionError(f"external reference lost its native interactivity: {file_path}")
        if not table_ranges(archive):
            raise AssertionError(f"external reference has no ListObject table: {file_path}")


def main() -> None:
    for relative_path in OWN_FILES:
        validate_own_fixture(relative_path)
    for relative_path in EXTERNAL_FILES:
        validate_external_fixture(relative_path)
    print(f"Validated {len(OWN_FILES) + len(EXTERNAL_FILES)} bank dashboard workbooks")


if __name__ == "__main__":
    main()
