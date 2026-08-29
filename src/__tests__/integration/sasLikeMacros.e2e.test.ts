/**
 * Live Netezza coverage for SAS-like macro execution.
 *
 * Set NZ_DEV_PASSWORD to enable these tests. The suite is skipped otherwise.
 * All database statements are read-only SELECTs against the development
 * fixture; the tests do not create or modify database objects.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, jest } from "@jest/globals";
import { NzConnection } from "@justybase/netezza-driver";

jest.unmock("chevrotain");
import {
  MacroPreprocessor,
  type MacroPreprocessorContext,
  type MacroQueryExecutionResult,
} from "../../core/macroPreprocessor";
import { createMacroPythonExecutor } from "../../core/macroPythonExecutor";
import {
  prepareQueryForExecution,
} from "../../core/queryBatchExecutor";
import {
  NETEZZA_SQL_PARSING_RUNTIME,
  parseSqlStatements,
} from "../../sqlParser/parsingRuntime";

const enabled = Boolean(process.env.NZ_DEV_PASSWORD);
const describeIfEnabled = enabled ? describe : describe.skip;
const pythonPath = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

const connectionConfig = {
  host: process.env.NZ_DEV_HOST || "localhost",
  port: Number(process.env.NZ_DEV_PORT || 5480),
  database: process.env.NZ_DEV_DATABASE || "JUST_DATA",
  user: process.env.NZ_DEV_USER || "admin",
  password: process.env.NZ_DEV_PASSWORD || "password",
};
const DATABASE = connectionConfig.database.toUpperCase();
const SCHEMA = (process.env.NZ_DEV_SCHEMA || "ADMIN").toUpperCase();
const DIMDATE = `${DATABASE}.${SCHEMA}.DIMDATE`;

let connection: NzConnection;

const DOCUMENTATION_PATH = path.resolve(
  __dirname,
  "../../..",
  "docs/macros/sas-like-macros.md",
);
const DOCUMENTATION_TABLE_REFERENCE = "JUST_DATA.ADMIN.DIMDATE";
const DOCUMENTATION_SAMPLE_IDS = [
  "let-and-set",
  "reference-forms",
  "sql-and-sqllist",
  "eval",
  "branching",
  "do-block",
  "put",
  "include-file",
  "include-main",
  "python-script",
  "python-main",
  "export-xlsx",
  "export-xlsb",
  "update-xlsx",
  "update-xlsb",
  "bank-sales-dashboard-update",
  "bank-campaign-dashboard-update",
  "bank-branch-dashboard-update",
  "combined-workflow",
] as const;

const BANK_DASHBOARD_LIVE_SAMPLES = [
  {
    id: "bank-sales-dashboard-update",
    fixture: "bank-sales-overview.xlsx",
    output: "justybase-bank-sales-overview.xlsx",
    sheet: "Raw_Monthly",
    columnCount: 7,
    headers: [
      "MONTH",
      "NEW_ROR_ACCOUNTS",
      "CREDIT_APPLICATIONS",
      "CREDIT_SALES",
      "CREDIT_VOLUME_PLN",
      "ACTIVE_CAMPAIGNS",
      "CONVERSION_RATE",
    ],
  },
  {
    id: "bank-campaign-dashboard-update",
    fixture: "campaign-performance.xlsx",
    output: "justybase-campaign-performance.xlsx",
    sheet: "Raw_Campaigns",
    columnCount: 12,
    headers: [
      "CAMPAIGN_ID",
      "CAMPAIGN",
      "CHANNEL",
      "PRODUCT",
      "LEADS",
      "APPLICATIONS",
      "APPROVED",
      "SOLD",
      "VOLUME_PLN",
      "SPEND_PLN",
      "CONVERSION_RATE",
      "ROI",
    ],
  },
  {
    id: "bank-branch-dashboard-update",
    fixture: "branch-product-ranking.xlsx",
    output: "justybase-branch-product-ranking.xlsx",
    sheet: "Raw_Branches",
    columnCount: 8,
    headers: [
      "BRANCH_ID",
      "BRANCH",
      "REGION",
      "RANK",
      "CREDIT_VOLUME_PLN",
      "ATTAINMENT_RATE",
      "ROR_PER_ADVISOR",
      "PRODUCTIZATION_RATE",
    ],
  },
] as const;

interface DocumentationSample {
  id: string;
  language: "sql" | "python";
  code: string;
}

function readDocumentationSamples(): Map<string, DocumentationSample> {
  const markdown = fs.readFileSync(DOCUMENTATION_PATH, "utf8");
  const samples = new Map<string, DocumentationSample>();
  const pattern = /<!--\s*live-sample:\s*([a-z0-9-]+)\s*-->\s*```(sql|python)\r?\n([\s\S]*?)```/gi;

  for (const match of markdown.matchAll(pattern)) {
    const id = match[1];
    const language = match[2]?.toLowerCase();
    const code = match[3];
    if (!id || (language !== "sql" && language !== "python") || code === undefined) {
      continue;
    }
    if (samples.has(id)) {
      throw new Error(`Duplicate live documentation sample: ${id}`);
    }
    samples.set(id, { id, language, code: code.trimEnd() });
  }

  return samples;
}

function documentationSample(id: string): DocumentationSample {
  const sample = readDocumentationSamples().get(id);
  if (!sample) {
    throw new Error(`Missing live documentation sample: ${id}`);
  }
  return sample;
}

function materializeDocumentationSample(
  code: string,
  replacements: readonly (readonly [string, string])[] = [],
): string {
  let materialized = replaceAllLiteral(
    code,
    DOCUMENTATION_TABLE_REFERENCE,
    DIMDATE,
  );
  for (const [from, to] of replacements) {
    materialized = replaceAllLiteral(materialized, from, to);
  }
  return materialized;
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return value.split(search).join(replacement);
}

async function queryRows(sql: string): Promise<unknown[][]> {
  const command = connection.createCommand(sql);
  const reader = await command.executeReader();
  const rows: unknown[][] = [];

  try {
    while (await reader.read()) {
      const row: unknown[] = [];
      for (let index = 0; index < reader.fieldCount; index++) {
        row.push(reader.getValue(index));
      }
      rows.push(row);
    }
  } finally {
    await reader.close();
  }

  return rows;
}

async function queryResult(sql: string): Promise<MacroQueryExecutionResult> {
  const command = connection.createCommand(sql);
  const reader = await command.executeReader();
  const columns: { name: string; type?: string }[] = [];
  const rows: unknown[][] = [];

  try {
    for (let index = 0; index < reader.fieldCount; index++) {
      columns.push({
        name: reader.getName(index),
        type: reader.getTypeName(index),
      });
    }

    while (await reader.read()) {
      const row: unknown[] = [];
      for (let index = 0; index < reader.fieldCount; index++) {
        row.push(reader.getValue(index));
      }
      rows.push(row);
    }
  } finally {
    await reader.close();
  }

  return { columns, rows };
}

type SpreadsheetFormat = "xlsx" | "xlsb";

interface LiveSpreadsheetWriter {
  addSheet(sheetName: string): void;
  writeSheet(rows: unknown[][], headers?: string[] | null): void;
  finalize(): Promise<void>;
}

interface LiveSpreadsheetReader {
  getSheetNames(): string[];
  open(filePath: string): Promise<void>;
  read(): Promise<boolean>;
  fieldCount: number;
  getValue(index: number): unknown;
  close(): Promise<void>;
  _initSheet(index: number): Promise<void>;
}

function spreadsheetTasksForLive(): {
  XlsxWriter: new (filePath: string) => LiveSpreadsheetWriter;
  XlsbWriter: new (filePath: string) => LiveSpreadsheetWriter;
  ReaderFactory: { create(filePath: string): LiveSpreadsheetReader };
} {
  return require("@justybase/spreadsheet-tasks") as {
    XlsxWriter: new (filePath: string) => LiveSpreadsheetWriter;
    XlsbWriter: new (filePath: string) => LiveSpreadsheetWriter;
    ReaderFactory: { create(filePath: string): LiveSpreadsheetReader };
  };
}

async function createExistingWorkbook(
  filePath: string,
  format: SpreadsheetFormat,
): Promise<void> {
  const { XlsxWriter, XlsbWriter } = spreadsheetTasksForLive();
  const Writer = format === "xlsx" ? XlsxWriter : XlsbWriter;
  const writer = new Writer(filePath);

  writer.addSheet("Summary");
  writer.writeSheet([["keep-me"]], ["VALUE"]);
  writer.addSheet("Data");
  writer.writeSheet([["old", 1]], ["NAME", "ID"]);
  writer.addSheet("Keep");
  writer.writeSheet([["untouched"]], ["VALUE"]);
  await writer.finalize();
}

async function readWorkbookSheets(
  filePath: string,
): Promise<Record<string, unknown[][]>> {
  const { ReaderFactory } = spreadsheetTasksForLive();
  const reader = ReaderFactory.create(filePath);
  await reader.open(filePath);

  try {
    const sheetNames = reader.getSheetNames();
    const sheets: Record<string, unknown[][]> = {};
    for (let sheetIndex = 0; sheetIndex < sheetNames.length; sheetIndex++) {
      if (sheetIndex > 0) {
        await reader._initSheet(sheetIndex);
      }

      const rows: unknown[][] = [];
      while (await reader.read()) {
        const row: unknown[] = [];
        for (let columnIndex = 0; columnIndex < reader.fieldCount; columnIndex++) {
          row.push(reader.getValue(columnIndex));
        }
        while (row.length > 0 && row[row.length - 1] === null) {
          row.pop();
        }
        rows.push(row);
      }
      sheets[sheetNames[sheetIndex] ?? `Sheet${sheetIndex + 1}`] = rows;
    }
    return sheets;
  } finally {
    await reader.close();
  }
}

function liveQueryContext(): MacroPreprocessorContext {
  return {
    query: async sql => ({ rows: await queryRows(sql) }),
    pythonExecutor: createMacroPythonExecutor(pythonPath),
  };
}

async function processAndExecute(
  script: string,
  context: MacroPreprocessorContext = liveQueryContext(),
): Promise<{ prepared: Awaited<ReturnType<MacroPreprocessor["processScript"]>>; rows: unknown[][] }> {
  const prepared = await new MacroPreprocessor().processScript(script, {}, context);
  const rows = prepared.sql.trim() ? await queryRows(prepared.sql) : [];
  return { prepared, rows };
}

function assertParserClean(sql: string): void {
  const parsed = parseSqlStatements({
    sql,
    runtime: NETEZZA_SQL_PARSING_RUNTIME,
  });
  expect(parsed.lexResult.errors).toHaveLength(0);
  expect(parsed.actionableParserErrors).toHaveLength(0);
}

describe("SAS-like macro documentation", () => {
  it("keeps every live-marked documentation sample registered", () => {
    const samples = readDocumentationSamples();
    expect(Array.from(samples.keys()).sort()).toEqual(
      [...DOCUMENTATION_SAMPLE_IDS].sort(),
    );
    expect(Array.from(samples.values()).every(sample => sample.code.length > 0)).toBe(true);
  });
});

describeIfEnabled("SAS-like macros live Netezza E2E", () => {
  beforeAll(async () => {
    connection = new NzConnection(connectionConfig);
    await connection.connect();
  });

  afterAll(() => {
    connection.close();
  });

  describe("documentation samples", () => {
    it("executes the %LET and @SET sample against Netezza", async () => {
      const sample = documentationSample("let-and-set");
      expect(sample.language).toBe("sql");

      const { prepared, rows } = await processAndExecute(
        materializeDocumentationSample(sample.code),
      );

      assertParserClean(prepared.sql);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.[0])).toBe(1);
      expect(Number(rows[0]?.[1])).toBeGreaterThan(0);
    }, 60_000);

    it("executes all variable reference forms from the documentation", async () => {
      const sample = documentationSample("reference-forms");
      expect(sample.language).toBe("sql");

      const { prepared, rows } = await processAndExecute(
        materializeDocumentationSample(sample.code),
      );

      assertParserClean(prepared.sql);
      expect(rows).toHaveLength(1);
      const values = rows[0] ?? [];
      expect(String(values[0])).toBe(String(values[1]));
      expect(String(values[1])).toBe(String(values[2]));
    }, 60_000);

    it("executes the %SQL and %SQLLIST sample against Netezza", async () => {
      const sample = documentationSample("sql-and-sqllist");
      expect(sample.language).toBe("sql");

      const { prepared, rows } = await processAndExecute(
        materializeDocumentationSample(sample.code),
      );

      assertParserClean(prepared.sql);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.[0])).toBeGreaterThan(0);
    }, 60_000);

    it("executes the %EVAL sample against Netezza", async () => {
      const sample = documentationSample("eval");
      expect(sample.language).toBe("sql");

      const { prepared, rows } = await processAndExecute(
        materializeDocumentationSample(sample.code),
      );

      assertParserClean(prepared.sql);
      expect(rows).toHaveLength(1);
      const values = rows[0] ?? [];
      expect(Number(values[1])).toBe(Number(values[0]) - 30);
      expect(Number(values[2])).toBe(108);
    }, 60_000);

    it("executes the conditional branch sample against Netezza", async () => {
      const sample = documentationSample("branching");
      expect(sample.language).toBe("sql");

      const { prepared, rows } = await processAndExecute(
        materializeDocumentationSample(sample.code),
      );

      assertParserClean(prepared.sql);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.[0])).toBeGreaterThan(0);
    }, 60_000);

    it("executes the unconditional %DO sample against Netezza", async () => {
      const sample = documentationSample("do-block");
      expect(sample.language).toBe("sql");

      const { prepared, rows } = await processAndExecute(
        materializeDocumentationSample(sample.code),
      );

      assertParserClean(prepared.sql);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.[0]).toBeDefined();
    }, 60_000);

    it("executes the %PUT sample and verifies its resolved message", async () => {
      const sample = documentationSample("put");
      expect(sample.language).toBe("sql");

      const { prepared, rows } = await processAndExecute(
        materializeDocumentationSample(sample.code),
      );

      assertParserClean(prepared.sql);
      expect(rows).toHaveLength(1);
      expect(prepared.putMessages).toHaveLength(1);
      expect(prepared.putMessages[0]).toMatch(
        new RegExp(`^Running report for ${DIMDATE} at DATEKEY=\\d+$`),
      );
    }, 60_000);

    it("executes the %INCLUDE samples with a shared macro environment", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "justybase-doc-include-"));
      const includePath = path.join(tempDir, "settings.sql");
      const sourcePath = path.join(tempDir, "main.sql");
      const includeSample = documentationSample("include-file");
      const mainSample = documentationSample("include-main");

      try {
        expect(includeSample.language).toBe("sql");
        expect(mainSample.language).toBe("sql");
        fs.writeFileSync(
          includePath,
          materializeDocumentationSample(includeSample.code),
          "utf8",
        );
        const context: MacroPreprocessorContext = {
          ...liveQueryContext(),
          sourceName: sourcePath,
          readFile: async (filePath: string) => ({
            path: includePath,
            content: fs.readFileSync(path.resolve(tempDir, filePath), "utf8"),
          }),
        };
        const { prepared, rows } = await processAndExecute(
          materializeDocumentationSample(mainSample.code),
          context,
        );

        assertParserClean(prepared.sql);
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]?.[0])).toBeGreaterThan(0);
        expect(prepared.scriptEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "include" }),
        ]));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }, 60_000);

    it("executes the %PYTHON samples and sends generated SQL to Netezza", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "justybase-doc-python-"));
      const scriptPath = path.join(tempDir, "build_sql.py");
      const pythonSample = documentationSample("python-script");
      const mainSample = documentationSample("python-main");

      try {
        expect(pythonSample.language).toBe("python");
        expect(mainSample.language).toBe("sql");
        fs.writeFileSync(scriptPath, pythonSample.code, "utf8");
        const mainSql = replaceAllLiteral(
          materializeDocumentationSample(mainSample.code),
          "build_sql.py",
          scriptPath,
        );
        const { prepared, rows } = await processAndExecute(mainSql);

        assertParserClean(prepared.sql);
        expect(prepared.sql.trim()).toBe("SELECT 107 AS generated_value;");
        expect(rows).toEqual([[107]]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }, 60_000);

    for (const format of ["xlsx", "xlsb"] as const) {
      it(`executes the documentation ${format.toUpperCase()} export sample`, async () => {
        const sample = documentationSample(`export-${format}`);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `justybase-doc-export-${format}-`));
        const outputPath = path.join(tempDir, `daily.${format}`);
        const documentedPath = `/tmp/sas-like-macro-${format}.${format}`;

        try {
          expect(sample.language).toBe("sql");
          const logs: string[] = [];
          const prepared = await prepareQueryForExecution(
            materializeDocumentationSample(sample.code, [[documentedPath, outputPath]]),
            {},
            message => logs.push(message),
            queryResult,
          );

          expect(prepared.trim()).toBe("");
          expect(fs.existsSync(outputPath)).toBe(true);
          expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
          const sheets = await readWorkbookSheets(outputPath);
          expect(sheets.Daily?.[0]).toEqual(["DATEKEY", "CALENDARQUARTER"]);
          expect(sheets.Daily?.length).toBeGreaterThan(1);
          expect(logs.some(log => log.includes(`%EXPORT: Exported`) && log.includes(outputPath))).toBe(true);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }, 60_000);
    }

    for (const format of ["xlsx", "xlsb"] as const) {
      it(`executes the existing ${format.toUpperCase()} update sample against Netezza`, async () => {
        const sample = documentationSample(`update-${format}`);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `justybase-doc-update-${format}-`));
        const outputPath = path.join(tempDir, `report.${format}`);
        const documentedPath = `/tmp/sas-like-macro-update-${format}.${format}`;

        try {
          expect(sample.language).toBe("sql");
          await createExistingWorkbook(outputPath, format);
          const logs: string[] = [];
          const prepared = await prepareQueryForExecution(
            materializeDocumentationSample(sample.code, [[documentedPath, outputPath]]),
            {},
            message => logs.push(message),
            queryResult,
          );

          expect(prepared.trim()).toBe("");
          const sheets = await readWorkbookSheets(outputPath);
          expect(Object.keys(sheets)).toEqual(["Summary", "Data", "Keep"]);
          expect(sheets.Summary).toEqual([["VALUE"], ["keep-me"]]);
          expect(sheets.Data?.[0]).toEqual(["DATEKEY", "CALENDARQUARTER"]);
          expect(sheets.Data?.length).toBeGreaterThan(1);
          expect(sheets.Keep).toEqual([["VALUE"], ["untouched"]]);
          expect(logs.some(log => log.includes(`%EXPORT: Updated`) && log.includes(outputPath))).toBe(true);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }, 60_000);
    }

    for (const sampleDefinition of BANK_DASHBOARD_LIVE_SAMPLES) {
      it(`updates the ${sampleDefinition.sheet} tab in ${sampleDefinition.fixture} against Netezza`, async () => {
        const sample = documentationSample(sampleDefinition.id);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "justybase-doc-dashboard-"));
        const outputPath = path.join(tempDir, sampleDefinition.output);
        const documentedPath = `/tmp/${sampleDefinition.output}`;
        const sourcePath = path.resolve(
          __dirname,
          "../../../fixtures/bank-dashboards",
          sampleDefinition.fixture,
        );

        try {
          expect(sample.language).toBe("sql");
          fs.copyFileSync(sourcePath, outputPath);
          const prepared = await prepareQueryForExecution(
            materializeDocumentationSample(sample.code, [[documentedPath, outputPath]]),
            {},
            undefined,
            queryResult,
          );

          expect(prepared.trim()).toBe("");
          const sheets = await readWorkbookSheets(outputPath);
          const updatedSheet = sheets[sampleDefinition.sheet];
          expect(updatedSheet).toBeDefined();
          expect(updatedSheet).toHaveLength(2);
          expect((updatedSheet?.[0] ?? []).map(value => String(value).toUpperCase())).toEqual(sampleDefinition.headers);
          expect(sheets.Dashboard?.length).toBeGreaterThan(1);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }, 60_000);
    }

    it("executes the combined workflow sample against Netezza", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "justybase-doc-workflow-"));
      const includePath = path.join(tempDir, "settings.sql");
      const sourcePath = path.join(tempDir, "main.sql");
      const outputPath = path.join(tempDir, "workflow.xlsx");
      const includeSample = documentationSample("include-file");
      const workflowSample = documentationSample("combined-workflow");

      try {
        expect(includeSample.language).toBe("sql");
        expect(workflowSample.language).toBe("sql");
        fs.writeFileSync(
          includePath,
          materializeDocumentationSample(includeSample.code),
          "utf8",
        );
        const logs: string[] = [];
        const context: MacroPreprocessorContext = {
          ...liveQueryContext(),
          sourceName: sourcePath,
          readFile: async (filePath: string) => ({
            path: includePath,
            content: fs.readFileSync(path.resolve(tempDir, filePath), "utf8"),
          }),
        };
        const prepared = await prepareQueryForExecution(
          materializeDocumentationSample(workflowSample.code, [
            ["/tmp/sas-like-macro-workflow.xlsx", outputPath],
          ]),
          {},
          message => logs.push(message),
          queryResult,
          context,
        );

        expect(prepared.trim()).toBe("");
        const sheets = await readWorkbookSheets(outputPath);
        expect(sheets.Workflow?.[0]).toEqual(["DATEKEY", "CALENDARQUARTER"]);
        expect(sheets.Workflow?.length).toBeGreaterThan(1);
        expect(logs.some(log => log.includes("%EXPORT: Exported"))).toBe(true);
        expect(logs.some(log => log.includes("%PUT: Exported DATEKEY="))).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }, 60_000);
  });

  it("executes %python stdout as SQL", async () => {
    const scriptPath = path.join(os.tmpdir(), `justybase-macro-stdout-${Date.now()}.py`);
    fs.writeFileSync(scriptPath, "print('SELECT 101 AS python_value;')", "utf8");

    try {
      const { prepared, rows } = await processAndExecute(`%python ${scriptPath};`);

      expect(prepared.sql.trim()).toBe("SELECT 101 AS python_value;");
      expect(rows).toEqual([[101]]);
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 60_000);

  it("passes %python arguments and resolves macro variables in arguments", async () => {
    const scriptPath = path.join(os.tmpdir(), `justybase-macro-args-${Date.now()}.py`);
    fs.writeFileSync(
      scriptPath,
      [
        "import sys",
        "print(\"SELECT '\" + sys.argv[1] + \":\" + sys.argv[2] + \"' AS python_args;\")",
      ].join("\n"),
      "utf8",
    );

    try {
      const { prepared, rows } = await processAndExecute(`%let left = alpha;
%let right = beta;
%python ${scriptPath} &left ${"${ right }"};`);

      expect(prepared.sql.trim()).toBe("SELECT 'alpha:beta' AS python_args;");
      expect(rows).toEqual([["alpha:beta"]]);
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 60_000);

  it("reports a non-zero %python exit code and stderr", async () => {
    const scriptPath = path.join(os.tmpdir(), `justybase-macro-error-${Date.now()}.py`);
    fs.writeFileSync(scriptPath, "import sys\nprint('python macro failed', file=sys.stderr)\nsys.exit(7)", "utf8");

    try {
      await expect(processAndExecute(`%python ${scriptPath};`)).rejects.toThrow(
        /%PYTHON script failed with exit code 7:.*python macro failed/,
      );
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 60_000);

  it("executes standalone %do/%end blocks", async () => {
    const { prepared, rows } = await processAndExecute(`%do;
SELECT 102 AS do_value;
%end;`);

    expect(prepared.sql.trim()).toBe("SELECT 102 AS do_value;");
    expect(rows).toEqual([[102]]);
  }, 60_000);

  it("executes the true %if branch and skips the false %else branch", async () => {
    const { prepared, rows } = await processAndExecute(`%let run = 1;
%if &run = 1 %then %do;
  SELECT 103 AS branch_value;
%else %do;
  SELECT 999 AS branch_value;
%end;`);

    expect(prepared.sql).not.toContain("999");
    expect(rows).toEqual([[103]]);
    expect(prepared.scriptEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "branch" }),
    ]));
  }, 60_000);

  it("supports nested %do and %if blocks", async () => {
    const { prepared, rows } = await processAndExecute(`%let outer = 1;
%do;
  %if &outer = 1 %then %do;
    SELECT 104 AS nested_value;
  %end;
%end;`);

    expect(prepared.sql.trim()).toBe("SELECT 104 AS nested_value;");
    expect(rows).toEqual([[104]]);
  }, 60_000);

  it("shares %let variables with %put and SQL substitution", async () => {
    const { prepared, rows } = await processAndExecute(`%let answer = 105;
%put answer=&answer;
SELECT &answer AS let_value;`);

    expect(prepared.putMessages).toEqual(["answer=105"]);
    expect(rows).toEqual([[105]]);
  }, 60_000);

  it("executes %include with the caller's macro environment", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "justybase-macro-include-"));
    const includePath = path.join(tempDir, "included.sql");
    fs.writeFileSync(includePath, "SELECT &included_value AS included_value;", "utf8");

    try {
      const context = {
        ...liveQueryContext(),
        readFile: async (filePath: string) => ({
          path: includePath,
          content: fs.readFileSync(filePath, "utf8"),
        }),
      };
      const { prepared, rows } = await processAndExecute(
        `%let included_value = 106;
%include '${includePath}';`,
        context,
      );

      expect(prepared.sql.trim()).toBe("SELECT 106 AS included_value;");
      expect(rows).toEqual([[106]]);
      expect(prepared.scriptEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "include" }),
      ]));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("executes %sql and %sqllist against Netezza", async () => {
    const { prepared, rows } = await processAndExecute(
      "SELECT %sql(SELECT 107) AS scalar_value WHERE 107 IN (%sqllist(SELECT 107));",
    );

    expect(prepared.sql.trim()).toBe("SELECT 107 AS scalar_value WHERE 107 IN (107);");
    expect(rows).toEqual([[107]]);
  }, 60_000);

  it("evaluates %eval before sending SQL to Netezza", async () => {
    const { prepared, rows } = await processAndExecute("SELECT %eval((50 + 58) - 1) AS eval_value;");

    expect(prepared.sql.trim()).toBe("SELECT 107 AS eval_value;");
    expect(rows).toEqual([[107]]);
  }, 60_000);

  it("executes %export and writes a real CSV result", async () => {
    const outputPath = path.join(os.tmpdir(), `justybase-macro-export-${Date.now()}.csv`);
    const variables: Record<string, string> = {};

    try {
      const prepared = await prepareQueryForExecution(
        `%export(format='csv', file='${outputPath}', query=(SELECT 108 AS exported_value), overwrite=true);`,
        variables,
        undefined,
        async sql => {
          const rows = await queryRows(sql);
          return {
            columns: [{ name: "EXPORTED_VALUE" }],
            rows,
          };
        },
      );

      expect(prepared.trim()).toBe("");
      expect(fs.readFileSync(outputPath, "utf8")).toContain("EXPORTED_VALUE");
      expect(fs.readFileSync(outputPath, "utf8")).toContain("108");
    } finally {
      fs.rmSync(outputPath, { force: true });
    }
  }, 60_000);

  it("produces parser-clean SQL after all directives are removed", async () => {
    const { prepared } = await processAndExecute(`%let value = 109;
%do;
  SELECT &value AS parser_value;
%end;`);

    assertParserClean(prepared.sql);
    expect(await queryRows(prepared.sql)).toEqual([[109]]);
  }, 60_000);
});
