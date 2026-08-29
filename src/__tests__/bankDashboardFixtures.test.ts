import * as fs from "fs";
import * as path from "path";

const AdmZip = require("adm-zip") as new (filePath: string) => {
  getEntries(): Array<{ entryName: string }>;
  readAsText(entryName: string): string;
};

interface SpreadsheetReader {
  open(filePath: string): Promise<void>;
  close(): Promise<void>;
  getSheetNames(): string[];
}

const { ReaderFactory } = require("@justybase/spreadsheet-tasks") as {
  ReaderFactory: { create(filePath: string): SpreadsheetReader };
};

const FIXTURE_DIRECTORY = path.resolve(__dirname, "../../fixtures/bank-dashboards");
const FIXTURES = [
  "bank-sales-overview.xlsx",
  "campaign-performance.xlsx",
  "branch-product-ranking.xlsx",
];
const EXTERNAL_FIXTURES = [
  "external/superstore-sales-dashboard.xlsx",
  "external/personal-finance-dashboard-2026.xlsx",
];

describe("bank dashboard fixtures", () => {
  it.each(FIXTURES)("is a readable XLSX dashboard with charts: %s", async (fileName) => {
    const filePath = path.join(FIXTURE_DIRECTORY, fileName);
    expect(fs.existsSync(filePath)).toBe(true);

    const reader = ReaderFactory.create(filePath);
    await reader.open(filePath);
    try {
      const sheetNames = reader.getSheetNames();
      expect(sheetNames[0]).toBe("Dashboard");
      expect(sheetNames.filter(name => name.startsWith("Raw_")).length).toBeGreaterThanOrEqual(3);
    } finally {
      await reader.close();
    }

    const zip = new AdmZip(filePath);
    const entries = zip.getEntries().map(entry => entry.entryName);
    const chartEntries = entries.filter(entry => /^xl\/charts\/chart\d+\.xml$/.test(entry));
    expect(chartEntries).toHaveLength(3);
    expect(entries).toContain("xl/drawings/drawing1.xml");
    expect(zip.readAsText("xl/drawings/drawing1.xml")).toContain("http://schemas.openxmlformats.org/drawingml/2006/chart");
    expect(zip.readAsText(chartEntries[0] ?? "")).toContain("<c:strCache>");
    expect(zip.readAsText(chartEntries[0] ?? "")).toContain("<c:numCache>");
  });

  it.each(EXTERNAL_FIXTURES)("keeps the external interactive reference readable: %s", async (fileName) => {
    const filePath = path.join(FIXTURE_DIRECTORY, fileName);
    expect(fs.existsSync(filePath)).toBe(true);

    const reader = ReaderFactory.create(filePath);
    await reader.open(filePath);
    try {
      expect(reader.getSheetNames().length).toBeGreaterThanOrEqual(3);
    } finally {
      await reader.close();
    }

    const zip = new AdmZip(filePath);
    const entries = zip.getEntries().map(entry => entry.entryName);
    expect(entries.some(entry => entry.startsWith("xl/pivotTables/pivotTable"))).toBe(true);
    expect(entries.some(entry => entry.startsWith("xl/slicerCaches/") || entry.startsWith("xl/slicers/"))).toBe(true);
    expect(entries.some(entry => /^xl\/charts\/chart\d+\.xml$/.test(entry))).toBe(true);
  });
});
