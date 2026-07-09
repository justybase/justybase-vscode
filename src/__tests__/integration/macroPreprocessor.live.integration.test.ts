/**
 * Live Netezza validation for SQL-backed macro preprocessing.
 *
 * Prerequisites:
 * - NZ_DEV_PASSWORD
 * - Optional: NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it, jest } from "@jest/globals";

jest.unmock("chevrotain");

import { NzConnection } from "@justybase/netezza-driver";
import { getDatabaseSqlAuthoring } from "../../core/connectionFactory";
import {
  MacroPreprocessor,
  type MacroQueryExecutionResult,
} from "../../core/macroPreprocessor";
import {
  createMacroFileReadContext,
  prepareQueryForExecution,
} from "../../core/queryBatchExecutor";
import { collectQueryVariableValues } from "../../core/variableResolver";
import { ensureBuiltInDialectsRegistered } from "../../dialects";
import { LintSeverity } from "../../providers/linterRules";
import { SqlQualityEngine } from "../../providers/sqlQualityEngine";
import {
  NETEZZA_SQL_PARSING_RUNTIME,
  parseSqlStatements,
  registerSqlParsingRuntime,
} from "../../sqlParser/parsingRuntime";
import { InMemorySchemaProvider } from "../../sqlParser/schemaProvider";
import { SqlValidator } from "../../sqlParser/validator";

const skipTests = !process.env.NZ_DEV_PASSWORD;
const describeIfDb = skipTests ? describe.skip : describe;
const itIfDb = skipTests ? it.skip : it;

const DB_CONFIG = {
  host: process.env.NZ_DEV_HOST || "192.168.0.144",
  port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
  database: process.env.NZ_DEV_DATABASE || "JUST_DATA",
  user: process.env.NZ_DEV_USER || "admin",
  password: process.env.NZ_DEV_PASSWORD || "password",
};

async function queryRows(
  connection: NzConnection,
  sql: string,
): Promise<readonly (readonly unknown[])[]> {
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

async function queryResult(
  connection: NzConnection,
  sql: string,
): Promise<MacroQueryExecutionResult> {
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

function createMacroQualityEngine(): SqlQualityEngine {
  ensureBuiltInDialectsRegistered();

  const validationProfile = getDatabaseSqlAuthoring("netezza").validation;
  registerSqlParsingRuntime({
    runtime: NETEZZA_SQL_PARSING_RUNTIME,
    validationProfile,
  });

  const schemaProvider = new InMemorySchemaProvider(true);
  schemaProvider.createTable(
    undefined,
    undefined,
    "dim_table",
    ["DATEKEY", "CALENDARQUARTER"],
  );
  schemaProvider.createTable(
    "JUST_DATA",
    "ADMIN",
    "DIMDATE",
    ["DATEKEY", "CALENDARQUARTER"],
  );

  return new SqlQualityEngine(new SqlValidator(schemaProvider, validationProfile));
}

function assertParserAndLinterClean(
  sql: string,
  qualityEngine: SqlQualityEngine,
): void {
  const parseResult = parseSqlStatements({
    sql,
    runtime: NETEZZA_SQL_PARSING_RUNTIME,
  });

  expect(parseResult.lexResult.errors).toHaveLength(0);
  expect(parseResult.actionableParserErrors).toHaveLength(0);

  const analysis = qualityEngine.analyze(sql);
  const parserOrValidationErrors = analysis.issues.filter(
    (issue) =>
      issue.severity === LintSeverity.Error &&
      /^(?:LEX|PAR|SQL)\d+/i.test(issue.ruleId),
  );

  if (parserOrValidationErrors.length > 0) {
    throw new Error(
      parserOrValidationErrors
        .map((issue) => `[${issue.ruleId}] ${issue.message}`)
        .join("\n"),
    );
  }
}

describeIfDb("MacroPreprocessor live Netezza integration", () => {
  itIfDb("executes directive-only %LET with multiline %SQL without prompt-scan context", async () => {
    jest.setTimeout(60000);
    const connection = new NzConnection(DB_CONFIG);
    await connection.connect();

    try {
      const script = `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);`;

      await expect(collectQueryVariableValues(script, false)).resolves.toEqual({});

      const vars: Record<string, string> = {};
      const sql = await prepareQueryForExecution(
        script,
        vars,
        undefined,
        macroSql => queryRows(connection, macroSql).then(rows => ({ rows })),
      );

      expect(sql.trim()).toBe("");
      expect(vars.DIM_TABLE).toBe("JUST_DATA.ADMIN.DIMDATE");
      expect(vars.AS_OF_KEY).toMatch(/^\d+$/);
    } finally {
      connection.close();
    }
  });

  itIfDb("keeps empty live %SQLLIST output executable as IN (NULL)", async () => {
    jest.setTimeout(60000);
    const qualityEngine = createMacroQualityEngine();
    const connection = new NzConnection(DB_CONFIG);
    await connection.connect();

    try {
      const script = `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
SELECT COUNT(*) AS matched_rows
FROM &dim_table
WHERE CALENDARQUARTER IN (
  %SQLLIST(
    SELECT CALENDARQUARTER
    FROM &dim_table
    WHERE 1 = 0
  )
);`;

      assertParserAndLinterClean(script, qualityEngine);

      const result = await new MacroPreprocessor().processScript(script, {}, {
        query: macroSql => queryRows(connection, macroSql).then(rows => ({ rows })),
      });

      expect(result.sql).toContain("IN (\n  NULL\n)");
      assertParserAndLinterClean(result.sql, qualityEngine);

      const rows = await queryRows(connection, result.sql);
      expect(String(rows[0]?.[0])).toBe("0");
    } finally {
      connection.close();
    }
  });

  itIfDb("wraps live database failures from SQL-backed macros", async () => {
    jest.setTimeout(60000);
    const connection = new NzConnection(DB_CONFIG);
    await connection.connect();

    try {
      await expect(
        new MacroPreprocessor().processScript(
          "SELECT %SQL(SELECT missing_column FROM JUST_DATA.ADMIN.DIMDATE);",
          {},
          {
            query: macroSql => queryRows(connection, macroSql).then(rows => ({ rows })),
          },
        ),
      ).rejects.toThrow("Failed to execute %SQL macro query:");
    } finally {
      connection.close();
    }
  });

  itIfDb("validates SAS-like macros with parser, linter, and live execution", async () => {
    jest.setTimeout(60000);
    const qualityEngine = createMacroQualityEngine();
    const connection = new NzConnection(DB_CONFIG);
    await connection.connect();

    try {
      const script = `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET lookback_days = 30;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);
%LET lower_key = %EVAL(${ "${ as_of_key }" } - &lookback_days);

%PUT As-of DATEKEY resolved from database: &as_of_key, lower=$lower_key, table=${ "${ dim_table }" };

SELECT
  d.DATEKEY,
  d.CALENDARQUARTER,
  &as_of_key AS amp_as_of_key,
  $as_of_key AS dollar_as_of_key,
  ${ "${ as_of_key }" } AS brace_as_of_key
FROM &dim_table d
WHERE d.DATEKEY = ${ "${ as_of_key }" }
  AND d.CALENDARQUARTER IN (
    %SQLLIST(
      SELECT DISTINCT CALENDARQUARTER
      FROM &dim_table
      WHERE DATEKEY >= %EVAL($as_of_key - &lookback_days)
    )
  )
ORDER BY d.DATEKEY`;

      assertParserAndLinterClean(script, qualityEngine);

      const executedMacroSql: string[] = [];
      const result = await new MacroPreprocessor().processScript(script, {}, {
        query: (sql) => {
          executedMacroSql.push(sql);
          return queryRows(connection, sql).then(rows => ({ rows }));
        },
      });

      expect(executedMacroSql).toHaveLength(2);
      expect(executedMacroSql.every(sql => !/[&$]|%(?:EVAL|SQL|SQLLIST)\b/i.test(sql))).toBe(true);
      expect(result.variables.DIM_TABLE).toBe("JUST_DATA.ADMIN.DIMDATE");
      expect(result.variables.LOOKBACK_DAYS).toBe("30");
      expect(result.variables.AS_OF_KEY).toMatch(/^\d+$/);
      expect(result.variables.LOWER_KEY).toBe(
        String(Number(result.variables.AS_OF_KEY) - 30),
      );
      expect(result.sql).not.toContain("%EVAL");
      expect(result.sql).not.toContain("EVAL(");
      expect(result.sql).not.toContain("%SQL");
      expect(result.sql).not.toContain("%SQLLIST");
      expect(result.sql).not.toMatch(/[&$]\{?\s*[A-Za-z_]/);
      expect(result.putMessages[0]).toMatch(
        /^As-of DATEKEY resolved from database: \d+, lower=\d+, table=JUST_DATA\.ADMIN\.DIMDATE$/,
      );

      assertParserAndLinterClean(result.sql, qualityEngine);

      const rows = await queryRows(connection, result.sql);
      expect(rows.length).toBeGreaterThan(0);
      expect(String(rows[0]?.[0])).toBe(result.variables.AS_OF_KEY);
      expect(String(rows[0]?.[2])).toBe(result.variables.AS_OF_KEY);
      expect(String(rows[0]?.[3])).toBe(result.variables.AS_OF_KEY);
      expect(String(rows[0]?.[4])).toBe(result.variables.AS_OF_KEY);
    } finally {
      connection.close();
    }
  });

  itIfDb("exports live query results through %EXPORT", async () => {
    jest.setTimeout(60000);
    const qualityEngine = createMacroQualityEngine();
    const connection = new NzConnection(DB_CONFIG);
    const outputPath = path.join(
      os.tmpdir(),
      `justybase_macro_export_live_${Date.now()}.xlsx`,
    );
    await connection.connect();

    try {
      const script = `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET export_file = '${outputPath}';

%EXPORT(
  file=&export_file,
  sheet='Dim Date',
  query=(
    SELECT DATEKEY, CALENDARQUARTER
    FROM &dim_table
    WHERE DATEKEY = %SQL(
      SELECT MAX(DATEKEY)
      FROM &dim_table
    )
  ),
  overwrite=true
);

%PUT Exported current DIMDATE row to &export_file;`;

      assertParserAndLinterClean(script, qualityEngine);

      const vars: Record<string, string> = {};
      const logs: string[] = [];
      const sql = await prepareQueryForExecution(
        script,
        vars,
        message => logs.push(message),
        macroSql => queryResult(connection, macroSql),
      );

      expect(sql.trim()).toBe("");
      expect(vars.DIM_TABLE).toBe("JUST_DATA.ADMIN.DIMDATE");
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
      expect(logs).toEqual([
        `>>> %EXPORT: Exported 1 rows to ${outputPath}`,
        `>>> %PUT: Exported current DIMDATE row to '${outputPath}'`,
      ]);
    } finally {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      connection.close();
    }
  });

  itIfDb("runs full Phase 4 script workflow with include, branching, SQL macros, export, and put logs", async () => {
    jest.setTimeout(90000);
    const qualityEngine = createMacroQualityEngine();
    const connection = new NzConnection(DB_CONFIG);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "justybase-phase4-live-"));
    const includePath = path.join(tempDir, "phase4-settings.sql");
    const sourcePath = path.join(tempDir, "phase4-main.sql");
    const outputPath = path.join(tempDir, "phase4-export.xlsx");
    await connection.connect();

    try {
      fs.writeFileSync(
        includePath,
        `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET export_file = '${outputPath}';
%LET run_export = 1;
%LET run_bad_branch = 0;
`,
      );

      const script = `%INCLUDE 'phase4-settings.sql';
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);

%IF &run_bad_branch = 1 %THEN %DO;
  %LET should_not_run = %SQL(SELECT missing_column FROM missing_live_table);
  %EXPORT(file='/tmp/should-not-exist.xlsx', query=(SELECT missing_column FROM missing_live_table));
  SELECT missing_column FROM missing_live_table;
%ELSE %DO;
  %PUT Skipped invalid branch for &as_of_key;
%END;

%IF &run_export = 1 %THEN %DO;
  %EXPORT(
    file=&export_file,
    sheet='Phase 4',
    query=(
      SELECT DATEKEY, CALENDARQUARTER
      FROM &dim_table
      WHERE DATEKEY = &as_of_key
        AND CALENDARQUARTER IN (
          %SQLLIST(
            SELECT DISTINCT CALENDARQUARTER
            FROM &dim_table
            WHERE DATEKEY = &as_of_key
          )
        )
    ),
    overwrite=true
  );
%END;

%PUT Phase 4 workflow complete for &as_of_key;`;

      assertParserAndLinterClean(script, qualityEngine);

      const vars: Record<string, string> = {};
      const logs: string[] = [];
      const executedMacroSql: string[] = [];
      const sql = await prepareQueryForExecution(
        script,
        vars,
        message => logs.push(message),
        macroSql => {
          executedMacroSql.push(macroSql);
          return queryResult(connection, macroSql);
        },
        createMacroFileReadContext(`file://${sourcePath}`),
      );

      expect(sql.trim()).toBe("");
      expect(vars.DIM_TABLE).toBe("JUST_DATA.ADMIN.DIMDATE");
      expect(vars.RUN_EXPORT).toBe("1");
      expect(vars.RUN_BAD_BRANCH).toBe("0");
      expect(vars.AS_OF_KEY).toMatch(/^\d+$/);
      expect(vars.SHOULD_NOT_RUN).toBeUndefined();
      expect(executedMacroSql).toHaveLength(3);
      expect(executedMacroSql.some(macroSql => /missing_live_table/i.test(macroSql))).toBe(false);
      expect(executedMacroSql.some(macroSql => /SELECT DISTINCT CALENDARQUARTER/i.test(macroSql))).toBe(true);
      expect(executedMacroSql.some(macroSql => /DATEKEY, CALENDARQUARTER/i.test(macroSql))).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
      expect(logs).toContain(`>>> %EXPORT: Exported 1 rows to ${outputPath}`);
      expect(logs).toContain(`>>> %PUT: Skipped invalid branch for ${vars.AS_OF_KEY}`);
      expect(logs).toContain(`>>> %PUT: Phase 4 workflow complete for ${vars.AS_OF_KEY}`);
    } finally {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      if (fs.existsSync(includePath)) {
        fs.unlinkSync(includePath);
      }
      connection.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
