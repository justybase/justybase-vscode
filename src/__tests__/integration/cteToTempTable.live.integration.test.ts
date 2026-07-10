/**
 * Live Netezza validation for CTE → temp table conversion.
 *
 * Prerequisites:
 * - NZ_DEV_PASSWORD
 * - Optional: NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER
 */

import { describe, expect, it, jest } from "@jest/globals";

jest.unmock("chevrotain");

import { NzConnection } from "@justybase/netezza-driver";
import { getDatabaseSqlAuthoring } from "../../core/connectionFactory";
import { ensureBuiltInDialectsRegistered } from "../../dialects";
import { LintSeverity } from "../../providers/linterRules";
import { SqlQualityEngine } from "../../providers/sqlQualityEngine";
import { SqlParser } from "../../sql/sqlParser";
import {
  analyzeSqlQueryStructures,
  buildCteToTempTableTransform,
  NETEZZA_SQL_PARSING_RUNTIME,
  parseSqlStatements,
  registerSqlParsingRuntime,
} from "../../sqlParser";
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

const DIMDATE = "JUST_DATA.ADMIN.DIMDATE";
const DIMEMPLOYEE = "JUST_DATA.ADMIN.DIMEMPLOYEE";

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

async function executeScript(
  connection: NzConnection,
  script: string,
): Promise<readonly (readonly unknown[])[]> {
  const statements = SqlParser.splitStatements(script).filter(
    (statement) => statement.trim().length > 0,
  );
  let lastRows: readonly (readonly unknown[])[] = [];

  for (const statement of statements) {
    lastRows = await queryRows(connection, statement);
  }

  return lastRows;
}

function normalizeRows(rows: readonly (readonly unknown[])[]): string[][] {
  return rows.map((row) => row.map((value) => String(value ?? "")));
}

function buildTransformPlan(inputSql: string) {
  const analysis = analyzeSqlQueryStructures(inputSql);
  const candidate = analysis.cteBulkMaterializationCandidates[0];
  if (!candidate || candidate.hasRecursive) {
    return undefined;
  }
  return buildCteToTempTableTransform(
    inputSql,
    candidate.withRootNode,
    candidate.statementRange,
    "TEMP",
  );
}

function createQualityEngine(): SqlQualityEngine {
  ensureBuiltInDialectsRegistered();

  const validationProfile = getDatabaseSqlAuthoring("netezza").validation;
  registerSqlParsingRuntime({
    runtime: NETEZZA_SQL_PARSING_RUNTIME,
    validationProfile,
  });

  const schemaProvider = new InMemorySchemaProvider(true);
  schemaProvider.createTable("JUST_DATA", "ADMIN", "DIMDATE", [
    "DATEKEY",
    "CALENDARQUARTER",
  ]);
  schemaProvider.createTable("JUST_DATA", "ADMIN", "DIMEMPLOYEE", [
    "EMPLOYEEKEY",
    "CURRENTFLAG",
  ]);

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

async function expectEquivalentCteTransform(
  connection: NzConnection,
  qualityEngine: SqlQualityEngine,
  inputSql: string,
): Promise<void> {
  assertParserAndLinterClean(inputSql, qualityEngine);

  const plan = buildTransformPlan(inputSql);
  expect(plan).toBeDefined();

  assertParserAndLinterClean(plan!.outputSql, qualityEngine);

  const inputRows = await queryRows(connection, inputSql);
  const outputRows = await executeScript(connection, plan!.outputSql);

  expect(normalizeRows(outputRows)).toEqual(normalizeRows(inputRows));
}

describeIfDb("CTE to temp table live Netezza integration", () => {
  let connection: NzConnection;
  let qualityEngine: SqlQualityEngine;
  let testCounter = 0;

  beforeAll(async () => {
    jest.setTimeout(120000);
    qualityEngine = createQualityEngine();
    connection = new NzConnection(DB_CONFIG);
    await connection.connect();
  });

  afterAll(() => {
    connection?.close();
  });

  function suffix(): string {
    testCounter += 1;
    return `${Date.now()}_${testCounter}`;
  }

  itIfDb("simple single CTE count query", async () => {
    const id = suffix();
    const inputSql = `WITH CTT_${id} AS (
  SELECT COUNT(*) AS ROW_COUNT FROM ${DIMDATE}
)
SELECT ROW_COUNT FROM CTT_${id};`;

    await expectEquivalentCteTransform(connection, qualityEngine, inputSql);
  });

  itIfDb("two-level CTE chain", async () => {
    const id = suffix();
    const inputSql = `WITH CTT_A_${id} AS (
  SELECT DATEKEY FROM ${DIMDATE} LIMIT 5
),
CTT_B_${id} AS (
  SELECT COUNT(*) AS ROW_COUNT FROM CTT_A_${id}
)
SELECT ROW_COUNT FROM CTT_B_${id};`;

    await expectEquivalentCteTransform(connection, qualityEngine, inputSql);
  });

  itIfDb("nested WITH inside CTE body", async () => {
    const id = suffix();
    const inputSql = `WITH CTT_1_${id} AS (
  SELECT DATEKEY FROM ${DIMDATE} LIMIT 3
),
CTT_2_${id} AS (
  WITH CTT_IN_${id} AS (
    SELECT DATEKEY FROM CTT_1_${id}
  )
  SELECT COUNT(*) AS ROW_COUNT FROM CTT_IN_${id}
)
SELECT ROW_COUNT FROM CTT_2_${id};`;

    await expectEquivalentCteTransform(connection, qualityEngine, inputSql);
  });

  itIfDb("CTE with GROUP BY aggregation", async () => {
    const id = suffix();
    const inputSql = `WITH CTT_GRP_${id} AS (
  SELECT CALENDARQUARTER, COUNT(*) AS QTR_COUNT
  FROM ${DIMDATE}
  GROUP BY CALENDARQUARTER
)
SELECT SUM(QTR_COUNT) AS TOTAL_ROWS FROM CTT_GRP_${id};`;

    await expectEquivalentCteTransform(connection, qualityEngine, inputSql);
  });

  itIfDb("CTE join between two CTEs", async () => {
    const id = suffix();
    const inputSql = `WITH CTT_D_${id} AS (
  SELECT DATEKEY FROM ${DIMDATE} LIMIT 10
),
CTT_E_${id} AS (
  SELECT DATEKEY FROM ${DIMDATE} LIMIT 10
)
SELECT COUNT(*) AS JOIN_COUNT
FROM CTT_D_${id} D
JOIN CTT_E_${id} E ON D.DATEKEY = E.DATEKEY;`;

    await expectEquivalentCteTransform(connection, qualityEngine, inputSql);
  });

  itIfDb("CTE with WHERE filter", async () => {
    const id = suffix();
    const inputSql = `WITH CTT_F_${id} AS (
  SELECT DATEKEY, CALENDARQUARTER
  FROM ${DIMDATE}
  WHERE CALENDARQUARTER = 1
)
SELECT COUNT(*) AS FILTERED_COUNT FROM CTT_F_${id};`;

    await expectEquivalentCteTransform(connection, qualityEngine, inputSql);
  });

  itIfDb("two-level nested WITH with comment", async () => {
    const id = suffix();
    const inputSql = `WITH CTT_OUT_${id} AS (
    WITH CTT_IN_${id} AS (
        SELECT DATEKEY FROM ${DIMDATE} LIMIT 4
    )
    -- inner result
    SELECT COUNT(*) AS ROW_COUNT FROM CTT_IN_${id}
)
SELECT ROW_COUNT FROM CTT_OUT_${id};`;

    await expectEquivalentCteTransform(connection, qualityEngine, inputSql);
  });

  itIfDb("final SELECT with LIMIT", async () => {
    const id = suffix();
    const inputSql = `WITH CTT_L_${id} AS (
  SELECT DATEKEY FROM ${DIMDATE}
)
SELECT DATEKEY FROM CTT_L_${id} LIMIT 7;`;

    const plan = buildTransformPlan(inputSql);
    expect(plan).toBeDefined();

    const inputRows = await queryRows(connection, inputSql);
    const outputRows = await executeScript(connection, plan!.outputSql);

    expect(inputRows).toHaveLength(7);
    expect(outputRows).toHaveLength(7);
    expect(normalizeRows(outputRows)).toEqual(normalizeRows(inputRows));
  });

  itIfDb("user-style nested example with DIMDATE and DIMEMPLOYEE", async () => {
    const id = suffix();
    const inputSql = `WITH CTT1_${id} AS (
  SELECT DATEKEY FROM ${DIMDATE} LIMIT 2
),
CTT2_${id} AS (
  SELECT COUNT(*) AS CNT FROM CTT1_${id}
),
-- staged join
CTT3_${id} AS (
    WITH CTT4_${id} AS (
      SELECT EMPLOYEEKEY FROM ${DIMEMPLOYEE} LIMIT 2
    ),
    CTT5_${id} AS (
      SELECT COUNT(*) AS CNT FROM CTT4_${id}
    )
    SELECT CTT2_${id}.CNT + CTT5_${id}.CNT AS TOTAL_CNT
    FROM CTT2_${id}, CTT5_${id}
)
SELECT TOTAL_CNT FROM CTT3_${id};`;

    await expectEquivalentCteTransform(connection, qualityEngine, inputSql);
  });
});
