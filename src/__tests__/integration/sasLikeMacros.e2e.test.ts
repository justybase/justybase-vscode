/**
 * Live Netezza coverage for SAS-like macro execution.
 *
 * Set NZ_DEV_PASSWORD to enable these tests. The suite is skipped otherwise.
 * All database statements are SELECTs against constants; the tests do not
 * create or modify database objects.
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
  host: process.env.NZ_DEV_HOST || "192.168.0.144",
  port: Number(process.env.NZ_DEV_PORT || 5480),
  database: process.env.NZ_DEV_DATABASE || "JUST_DATA",
  user: process.env.NZ_DEV_USER || "admin",
  password: process.env.NZ_DEV_PASSWORD || "password",
};

let connection: NzConnection;

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

describeIfEnabled("SAS-like macros live Netezza E2E", () => {
  beforeAll(async () => {
    connection = new NzConnection(connectionConfig);
    await connection.connect();
  });

  afterAll(() => {
    connection.close();
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
