import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
    getSpreadsheetDataRange,
    inspectSpreadsheetTables,
    refreshXlsxTableRangesAfterSheetUpdate,
    refreshSpreadsheetTableRangesAfterSheetUpdate,
    removeXlsxCalcChain,
} from "../core/xlsxTableRangeUpdater";

interface ZipEntry {
    entryName: string;
}

interface ZipFile {
    getEntries(): ZipEntry[];
    getEntry(entryName: string): ZipEntry | undefined;
    readAsText(entryName: string): string;
    updateFile(entry: ZipEntry, content: Buffer): void;
    addFile(entryName: string, content: Buffer): void;
    writeZip(filePath: string): void;
}

interface XlsxUpdater {
    replaceSheetData(
        sheetName: string,
        rows: Array<Array<string | number | boolean>>,
        options: { headers: string[] },
    ): void;
    save(): void;
}

interface XlsbWriter {
    addSheet(sheetName: string): void;
    writeSheet(rows: Array<Array<string | number>>, headers: string[]): void;
    finalize(): Promise<void>;
}

const AdmZip = require("adm-zip") as new (filePath: string) => ZipFile;
const { XlsxUpdater, XlsbUpdater, XlsbWriter } = require("@justybase/spreadsheet-tasks") as {
    XlsxUpdater: new (filePath: string) => XlsxUpdater;
    XlsbUpdater: new (filePath: string) => XlsxUpdater;
    XlsbWriter: new (filePath: string) => XlsbWriter;
};

const FIXTURE_DIRECTORY = path.resolve(__dirname, "../../fixtures/bank-dashboards");

function copyFixture(relativePath: string): string {
    const destination = path.join(
        os.tmpdir(),
        `justybase-xlsx-table-range-${Date.now()}-${Math.random().toString(16).slice(2)}.xlsx`,
    );
    fs.copyFileSync(path.join(FIXTURE_DIRECTORY, relativePath), destination);
    return destination;
}

function entries(filePath: string): string[] {
    return new AdmZip(filePath).getEntries().map((entry) => entry.entryName);
}

function partText(filePath: string, entryName: string): string {
    return new AdmZip(filePath).readAsText(entryName);
}

function tableByName(filePath: string, tableName: string): string {
    const zip = new AdmZip(filePath);
    const tableEntry = zip.getEntries().find((entry) => {
        if (!entry.entryName.startsWith("xl/tables/") || !entry.entryName.endsWith(".xml")) {
            return false;
        }
        return zip.readAsText(entry.entryName).includes(`name="${tableName}"`);
    });
    if (!tableEntry) {
        throw new Error(`Table ${tableName} not found in ${filePath}`);
    }
    return zip.readAsText(tableEntry.entryName);
}

function countEntries(filePath: string, pattern: RegExp): number {
    return entries(filePath).filter((entryName) => pattern.test(entryName)).length;
}

function injectCalcChain(filePath: string): void {
    const zip = new AdmZip(filePath);
    const relationshipEntry = zip.getEntry("xl/_rels/workbook.xml.rels");
    const contentTypesEntry = zip.getEntry("[Content_Types].xml");
    if (!relationshipEntry || !contentTypesEntry) {
        throw new Error("The fixture is missing required XLSX package metadata");
    }

    const relationshipType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain";
    const relationships = zip.readAsText("xl/_rels/workbook.xml.rels");
    zip.updateFile(
        relationshipEntry,
        Buffer.from(
            relationships.replace(
                "</Relationships>",
                `<Relationship Id="rIdJustybaseCalcChain" Type="${relationshipType}" Target="calcChain.xml"/></Relationships>`,
            ),
            "utf8",
        ),
    );

    const contentTypes = zip.readAsText("[Content_Types].xml");
    zip.updateFile(
        contentTypesEntry,
        Buffer.from(
            contentTypes.replace(
                "</Types>",
                `<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`,
            ),
            "utf8",
        ),
    );
    zip.addFile(
        "xl/calcChain.xml",
        Buffer.from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><calcChain xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><c r=\"A1\"/></calcChain>",
            "utf8",
        ),
    );
    zip.writeZip(filePath);
}

function makeStrictRelationships(filePath: string): void {
    const zip = new AdmZip(filePath);
    const transitionalPrefix = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
    const strictPrefix = "http://purl.oclc.org/ooxml/officeDocument/relationships/";
    for (const entry of zip.getEntries().filter(({ entryName }) => entryName.endsWith(".rels"))) {
        const xml = zip.readAsText(entry.entryName);
        const strictXml = xml.split(transitionalPrefix).join(strictPrefix);
        if (strictXml !== xml) {
            zip.updateFile(entry, Buffer.from(strictXml, "utf8"));
        }
    }
    zip.writeZip(filePath);
}

async function createXlsbTableFixture(): Promise<string> {
    const filePath = path.join(
        os.tmpdir(),
        `justybase-xlsb-table-${Date.now()}-${Math.random().toString(16).slice(2)}.xlsb`,
    );
    const writer = new XlsbWriter(filePath);
    writer.addSheet("Summary");
    writer.writeSheet([["keep"]], ["VALUE"]);
    writer.addSheet("Data");
    writer.writeSheet([["old", 1], ["old2", 2]], ["Name", "Amount"]);
    await writer.finalize();

    const zip = new AdmZip(filePath);
    const worksheetRelationshipsPath = "xl/worksheets/_rels/sheet2.bin.rels";
    const worksheetRelationshipsEntry = zip.getEntry(worksheetRelationshipsPath);
    const contentTypesEntry = zip.getEntry("[Content_Types].xml");
    if (!worksheetRelationshipsEntry || !contentTypesEntry) {
        throw new Error("The generated XLSB fixture is missing package metadata");
    }
    const tableRelationshipType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";
    zip.updateFile(
        worksheetRelationshipsEntry,
        Buffer.from(
            zip.readAsText(worksheetRelationshipsPath).replace(
                "</Relationships>",
                `<Relationship Id="rIdTable" Type="${tableRelationshipType}" Target="../tables/table1.xml"/></Relationships>`,
            ),
            "utf8",
        ),
    );
    zip.updateFile(
        contentTypesEntry,
        Buffer.from(
            zip.readAsText("[Content_Types].xml").replace(
                "</Types>",
                '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>',
            ),
            "utf8",
        ),
    );
    zip.addFile(
        "xl/tables/table1.xml",
        Buffer.from(
            '<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="tblData" ref="A1:B3"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="Name"/><tableColumn id="2" name="Amount"/></tableColumns></table>',
            "utf8",
        ),
    );
    zip.writeZip(filePath);
    return filePath;
}

describe("refreshXlsxTableRangesAfterSheetUpdate", () => {
    it("removes a stale calculation chain without removing workbook features", () => {
        const filePath = copyFixture("bank-sales-overview.xlsx");
        try {
            injectCalcChain(filePath);
            expect(entries(filePath)).toContain("xl/calcChain.xml");

            removeXlsxCalcChain(filePath);

            expect(entries(filePath)).not.toContain("xl/calcChain.xml");
            expect(partText(filePath, "xl/_rels/workbook.xml.rels")).not.toContain("/calcChain");
            expect(partText(filePath, "[Content_Types].xml")).not.toContain("/xl/calcChain.xml");
            expect(countEntries(filePath, /^xl\/charts\/chart\d+\.xml$/)).toBe(3);
            expect(tableByName(filePath, "tblSalesMonthly")).toContain('ref="A1:G13"');
        } finally {
            fs.rmSync(filePath, { force: true });
        }
    });

    it("finds and updates a table in a Strict OOXML workbook", () => {
        const filePath = copyFixture("bank-sales-overview.xlsx");
        try {
            makeStrictRelationships(filePath);

            expect(inspectSpreadsheetTables(filePath, "Raw_Monthly")[0]?.headers).toEqual([
                "Month",
                "New_ROR_Accounts",
                "Credit_Applications",
                "Credit_Sales",
                "Credit_Volume_PLN",
                "Active_Campaigns",
                "Conversion_Rate",
            ]);
            refreshSpreadsheetTableRangesAfterSheetUpdate(
                filePath,
                "Raw_Monthly",
                "A1:G3",
            );
            expect(tableByName(filePath, "tblSalesMonthly")).toContain('ref="A1:G3"');
            expect(tableByName(filePath, "tblSalesMonthly")).toContain('<autoFilter ref="A1:G3"');
        } finally {
            fs.rmSync(filePath, { force: true });
        }
    });

    it("rejects a worksheet with multiple ListObjects instead of overlapping them", () => {
        const filePath = copyFixture("bank-sales-overview.xlsx");
        try {
            expect(inspectSpreadsheetTables(filePath, "Dashboard")).toHaveLength(3);
            expect(() => refreshSpreadsheetTableRangesAfterSheetUpdate(
                filePath,
                "Dashboard",
                "A1:K2",
            )).toThrow(/contains 3 ListObjects/);
            expect(tableByName(filePath, "tblSalesMonthly")).toContain('ref="A1:G13"');
            expect(tableByName(filePath, "tblSalesProductView")).toContain('ref="G10:K16"');
        } finally {
            fs.rmSync(filePath, { force: true });
        }
    });

    it("synchronizes ListObject metadata for an XLSB worksheet", async () => {
        const filePath = await createXlsbTableFixture();
        try {
            expect(inspectSpreadsheetTables(filePath, "Data")[0]).toMatchObject({
                name: "tblData",
                range: "A1:B3",
                headers: ["Name", "Amount"],
            });

            const updater = new XlsbUpdater(filePath);
            const rows = [["new", 10]];
            const headers = ["Name", "Amount"];
            updater.replaceSheetData("Data", rows, { headers });
            updater.save();
            refreshSpreadsheetTableRangesAfterSheetUpdate(
                filePath,
                "Data",
                getSpreadsheetDataRange(rows, headers),
            );

            expect(inspectSpreadsheetTables(filePath, "Data")[0]).toMatchObject({
                range: "A1:B2",
                headers,
            });
        } finally {
            fs.rmSync(filePath, { force: true });
        }
    });

    it("keeps generated dashboard tables connected after a raw tab shrinks", () => {
        const filePath = copyFixture("bank-sales-overview.xlsx");
        try {
            const updater = new XlsxUpdater(filePath);
            updater.replaceSheetData(
                "Raw_Monthly",
                [
                    ["Jan-26", 501, 402, 221, 7100000, 5, 0.55],
                    ["Feb-26", 512, 414, 232, 7420000, 5, 0.56],
                ],
                { headers: ["Month", "New_ROR_Accounts", "Credit_Applications", "Credit_Sales", "Credit_Volume_PLN", "Active_Campaigns", "Conversion_Rate"] },
            );
            updater.save();
            refreshXlsxTableRangesAfterSheetUpdate(filePath, "Raw_Monthly");

            const tableXml = tableByName(filePath, "tblSalesMonthly");
            expect(tableXml).toContain('ref="A1:G3"');
            expect(tableXml).toContain('<autoFilter ref="A1:G3"');
            expect(partText(filePath, "xl/sharedStrings.xml")).toContain("BANKING SALES DASHBOARD");
            expect(countEntries(filePath, /^xl\/charts\/chart\d+\.xml$/)).toBe(3);
            expect(tableByName(filePath, "tblSalesProducts")).toContain('ref="A1:G7"');
        } finally {
            fs.rmSync(filePath, { force: true });
        }
    });

    it.each([
        ["external/superstore-sales-dashboard.xlsx", "superstore", "Table1", ["Order Date", "Year", "Month", "Customer Name", "State", "Category", "Sub-Category", "Product Name", "Sales", "Quantity", "Profit"]],
        ["external/personal-finance-dashboard-2026.xlsx", "Dataset", "tblTransactions", ["Transaction ID", "Date", "Year", "Account", "Bank", "Transaction Type", "Category", "Sub Category", "Payment Method", "Merchant", "Description", "Amount (₹)", "Budget (₹)", "Savings Goal", "Location", "Status", "Recurring", "Tax Deductible", "Balance After Transaction (₹)", "Month", "Quarter", "Month No"]],
    ])("preserves native PivotTables and slicers in %s", (relativePath, sheetName, tableName, headers) => {
        const filePath = copyFixture(relativePath);
        try {
            const beforeEntries = entries(filePath).filter(
                (entryName) => entryName !== "xl/calcChain.xml",
            );
            const beforePivotCount = countEntries(filePath, /^xl\/pivotTables\/pivotTable\d+\.xml$/);
            const beforeSlicerCount = countEntries(filePath, /^xl\/(?:slicers|slicerCaches)\//);
            const beforeChartCount = countEntries(filePath, /^xl\/charts\/chart\d+\.xml$/);
            expect(beforePivotCount).toBeGreaterThan(0);
            expect(beforeSlicerCount).toBeGreaterThan(0);
            expect(beforeChartCount).toBeGreaterThan(0);

            const row = headers.map((header, index) => {
                if (header === "Year" || header === "Month No" || header === "Quantity") {
                    return 2026;
                }
                if (header.includes("Amount") || header.includes("Budget") || header.includes("Balance") || header === "Sales" || header === "Profit") {
                    return 1234.5;
                }
                return `Updated ${index + 1}`;
            });
            const updater = new XlsxUpdater(filePath);
            updater.replaceSheetData(sheetName, [row], { headers });
            updater.save();
            removeXlsxCalcChain(filePath);
            refreshXlsxTableRangesAfterSheetUpdate(filePath, sheetName);

            expect(entries(filePath)).toEqual(expect.arrayContaining(beforeEntries));
            expect(countEntries(filePath, /^xl\/pivotTables\/pivotTable\d+\.xml$/)).toBe(beforePivotCount);
            expect(countEntries(filePath, /^xl\/(?:slicers|slicerCaches)\//)).toBe(beforeSlicerCount);
            expect(countEntries(filePath, /^xl\/charts\/chart\d+\.xml$/)).toBe(beforeChartCount);
            expect(tableByName(filePath, tableName)).toMatch(/ref="A1:[A-Z]+2"/);
            expect(tableByName(filePath, tableName)).toMatch(/<autoFilter ref="A1:[A-Z]+2"/);
            expect(entries(filePath)).not.toContain("xl/calcChain.xml");
            expect(partText(filePath, "xl/_rels/workbook.xml.rels")).not.toContain("/calcChain");
            expect(partText(filePath, "[Content_Types].xml")).not.toContain("/xl/calcChain.xml");

            const pivotEntries = entries(filePath).filter((entryName) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(entryName));
            expect(pivotEntries.every((entryName) => partText(filePath, entryName).includes('refreshOnLoad="1"'))).toBe(true);
        } finally {
            fs.rmSync(filePath, { force: true });
        }
    });
});
