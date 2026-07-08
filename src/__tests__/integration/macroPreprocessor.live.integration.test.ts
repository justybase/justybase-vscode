/**
 * Live Netezza validation for SQL-backed macro preprocessing.
 *
 * Prerequisites:
 * - NZ_DEV_PASSWORD
 * - Optional: NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER
 */

import { describe, expect, it, jest } from "@jest/globals";

jest.unmock("chevrotain");

import { NzConnection } from "@justybase/netezza-driver";
import { getDatabaseSqlAuthoring } from "../../core/connectionFactory";
import { MacroPreprocessor } from "../../core/macroPreprocessor";
import { prepareQueryForExecution } from "../../core/queryBatchExecutor";
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

      expect(sql).toBe("");
      expect(vars.DIM_TABLE).toBe("JUST_DATA.ADMIN.DIMDATE");
      expect(vars.AS_OF_KEY).toMatch(/^\d+$/);
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
});
