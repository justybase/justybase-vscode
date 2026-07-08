/**
 * Live Database Linter Validation Tests
 *
 * Concept: Generate SQL queries based on the live database schema,
 * execute them against the real database, and cross-validate the linter output.
 *
 * - DB success + linter 0 errors => PASS (valid SQL)
 * - DB failure + linter >0 errors => PASS (linter catches the issue)
 * - Mismatches => FAIL (false positive or false negative)
 *
 * Prerequisites:
 * - Set NZ_DEV_PASSWORD environment variable with the database password
 * - Optionally override host/port/database/user via NZ_DEV_HOST/NZ_DEV_PORT/NZ_DEV_DATABASE/NZ_DEV_USER
 *
 * Run with: NZ_DEV_PASSWORD=password npx jest src/__tests__/sqlLinter/linterLiveValidation.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";

// Don't mock chevrotain - we need the real parser for SQL validation
jest.unmock("chevrotain");

const skipTests = !process.env.NZ_DEV_PASSWORD;
const describeIfDb = skipTests ? describe.skip : describe;
const itIfDb = skipTests ? it.skip : it;

import { NzConnection } from "@justybase/netezza-driver";
import { ensureBuiltInDialectsRegistered } from "../../dialects";
import { getDatabaseSqlAuthoring } from "../../core/connectionFactory";
import { SqlValidator } from "../../sqlParser/validator";
import { InMemorySchemaProvider } from "../../sqlParser/schemaProvider";
import { SqlQualityEngine } from "../../providers/sqlQualityEngine";
import { registerSqlParsingRuntime, NETEZZA_SQL_PARSING_RUNTIME } from "../../sqlParser/parsingRuntime";

interface DiscoveredTable {
  database: string;
  schema: string;
  name: string;
  columns: string[];
  numericColumn: string | undefined;
  stringColumn: string | undefined;
  dateColumn: string | undefined;
  distributionKeys: string[];
}

interface TestResult {
  name: string;
  sql: string;
  category: string;
  dbError: string | undefined;
  parserErrorCount: number;
  linterRuleErrorCount: number;
  matched: boolean;
  knownLinterGap: boolean;
}

const DB_CONFIG = {
  host: process.env.NZ_DEV_HOST || "192.168.0.144",
  port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
  database: process.env.NZ_DEV_DATABASE || "JUST_DATA",
  user: process.env.NZ_DEV_USER || "admin",
  password: process.env.NZ_DEV_PASSWORD || "password",
};

/** ANSI SQL functions always available regardless of _V_FUNCTION contents */
const ANSI_CORE_FUNCTIONS = new Set([
  "COUNT", "SUM", "AVG", "MIN", "MAX",
  "CAST", "COALESCE", "NULLIF", "CASE",
  "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "NOW",
  "ROW_NUMBER", "RANK", "DENSE_RANK", "NTILE",
  "LEAD", "LAG", "FIRST_VALUE", "LAST_VALUE",
  "UPPER", "LOWER", "TRIM", "LENGTH", "SUBSTR", "SUBSTRING",
  "ABS", "ROUND", "CEIL", "FLOOR", "MOD", "POWER",
  "EXTRACT", "DATE_PART", "DATE_TRUNC", "TO_CHAR", "TO_DATE", "TO_NUMBER", "TO_TIMESTAMP",
  "LEFT", "RIGHT", "REPLACE", "CONCAT",
  "INITCAP", "LTRIM", "RTRIM", "LPAD", "RPAD", "REPEAT", "STRPOS", "INSTR",
  "BTRIM", "TRANSLATE", "ASCII", "CHR",
]);

describeIfDb("SQL Linter - Live Database Validation", () => {
  let connection: NzConnection;
  let tables: DiscoveredTable[];
  let qualityEngine: SqlQualityEngine;
  let results: TestResult[];

  beforeAll(async () => {
    if (skipTests) return;

    jest.setTimeout(90000);

    ensureBuiltInDialectsRegistered();

    connection = new NzConnection({
      host: DB_CONFIG.host,
      port: DB_CONFIG.port,
      database: DB_CONFIG.database,
      user: DB_CONFIG.user,
      password: DB_CONFIG.password,
    });

    await connection.connect();

    const discovery = await discoverSchema(connection, DB_CONFIG.database);
    tables = discovery.tables;

    const schemaProvider = buildSchemaProvider(tables, discovery.functions);
    const baseProfile = getDatabaseSqlAuthoring().validation;
    
    // Create a new merged Set instead of mutating the global ReadonlySet
    const mergedFunctions = new Set(baseProfile.builtinFunctions);
    for (const fn of discovery.functions) {
      mergedFunctions.add(fn);
    }
    // Remove hardcoded functions not confirmed by _V_FUNCTION (e.g. GREATEST on some Netezza versions)
    if (discovery.functions.size > 0) {
      for (const fn of [...mergedFunctions]) {
        if (!discovery.functions.has(fn) && !ANSI_CORE_FUNCTIONS.has(fn)) {
          mergedFunctions.delete(fn);
        }
      }
    }
    
    // Create custom validation profile with merged functions
    const customProfile = {
      ...baseProfile,
      builtinFunctions: mergedFunctions,
    };
    
    // Register the custom profile with Netezza runtime so parser uses Netezza lexer/parser
    registerSqlParsingRuntime({
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
      validationProfile: customProfile,
    });
    
    const validator = new SqlValidator(schemaProvider, customProfile);
    qualityEngine = new SqlQualityEngine(validator);

    const testCases = buildTestCases(tables);
    jest.setTimeout(120000);
    results = await executeAllTestCases(connection, qualityEngine, testCases);
  }, 90000);

  afterAll(async () => {
    if (connection) {
      connection.close();
    }
  });

  itIfDb("should discover at least one table from the live database", () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  itIfDb("should pass DB-executable queries with zero parser errors", () => {
    const failures = results.filter(
      (r) => !r.dbError && r.parserErrorCount > 0 && !r.knownLinterGap,
    );
    expect(failures.length).toBe(0);
  });

  itIfDb("should fail DB-rejected queries with at least one parser error", () => {
    const failures = results.filter(
      (r) => r.dbError && r.parserErrorCount === 0 && !r.knownLinterGap,
    );
    expect(failures.length).toBe(0);
  });

  itIfDb("should report summary of all test cases", () => {
    const total = results.length;
    const passed = results.filter((r) => r.matched).length;
    const dbSuccess = results.filter((r) => !r.dbError).length;
    const dbFailed = results.filter((r) => r.dbError).length;
    const knownGaps = results.filter((r) => r.knownLinterGap).length;

    console.log(
      [
        `SQL Linter Live Validation: ${passed}/${total} passed (DB: ${dbSuccess} OK / ${dbFailed} FAIL, ${knownGaps} known gaps)`,
        ...results.map(
          (r) =>
            `  ${r.matched ? "✓" : r.knownLinterGap ? "○" : "✗"} [${r.category}] ${r.name}: DB=${
              r.dbError ? "FAIL" : "OK"
            }, ParserErr=${r.parserErrorCount}, LintErr=${r.linterRuleErrorCount}${r.knownLinterGap ? " (known gap)" : ""}`,
        ),
      ].join("\n"),
    );

    expect(total).toBeGreaterThan(0);
  });

  itIfDb("should have no false positives (parser errors for valid SQL)", () => {
    const falsePositives = results.filter(
      (r) => !r.dbError && r.parserErrorCount > 0 && !r.knownLinterGap,
    );

    if (falsePositives.length > 0) {
      const detail = falsePositives
        .map((r) => {
          const analysis = qualityEngine.analyze(r.sql);
          const errorMessages = analysis.issues
            .filter((i) => i.severity === 0 && (i.ruleId.startsWith("PAR") || i.ruleId.startsWith("SQL") || i.ruleId.startsWith("LEX")))
            .map((i) => `    [${i.ruleId}] ${i.message}`)
            .join("\n");
          return `\n  [${r.category}] ${r.name}\n  SQL: ${r.sql}\n  Parser/validation errors:\n${errorMessages}`;
        })
        .join("");
      throw new Error(`False positives detected:${detail}`);
    }
  });

  itIfDb("should have no false negatives (DB errors missed by parser)", () => {
    const unexpected = results.filter(
      (r) => r.dbError && r.parserErrorCount === 0 && !r.knownLinterGap,
    );

    if (unexpected.length > 0) {
      const detail = unexpected
        .map(
          (r) =>
            `\n  [${r.category}] ${r.name}\n  SQL: ${r.sql}\n  DB error: ${r.dbError}`,
        )
        .join("");
      throw new Error(`False negatives detected:${detail}`);
    }

    const knownGaps = results.filter(
      (r) => r.dbError && r.parserErrorCount === 0 && r.knownLinterGap,
    );
    if (knownGaps.length > 0) {
      console.log(
        `Known linter gaps (${knownGaps.length}):\n` +
          knownGaps
            .map(
              (r) =>
                `  ○ [${r.category}] ${r.name}\n    SQL: ${r.sql}\n    DB error: ${r.dbError}`,
            )
            .join("\n"),
      );
    }
  });
});

async function discoverSchema(
  connection: NzConnection,
  database: string,
): Promise<{ tables: DiscoveredTable[]; functions: Set<string> }> {
  const db = database.toUpperCase();

  // === Query 1: all objects (tables, views) and functions from _V_FUNCTION ===
  const objCmd = connection.createCommand(
    `SELECT OBJNAME, SCHEMA, OBJTYPE FROM ${db}.._V_OBJECT_DATA WHERE DBNAME = '${db}' AND OBJTYPE IN ('TABLE', 'VIEW') ORDER BY OBJTYPE, SCHEMA, OBJNAME LIMIT 200`,
  );
  const objReader = await objCmd.executeReader();

  const tableRows: Array<{ name: string; schema: string }> = [];
  const functions = new Set<string>();

  while (await objReader.read()) {
    const objName = String(objReader.getValue(0) ?? "");
    const objSchema = String(objReader.getValue(1) ?? "");
    tableRows.push({ name: objName, schema: objSchema });
  }
  await objReader.close();

  // === Query 1b: discover functions from _V_FUNCTION ===
  for (const colName of ["FUNCNAME", "FUNCTION", "FUNCTNAME"]) {
    try {
      const funcCmd = connection.createCommand(
        `SELECT ${colName} FROM ${db}.._V_FUNCTION ORDER BY ${colName}`,
      );
      const funcReader = await funcCmd.executeReader();
      while (await funcReader.read()) {
        functions.add(String(funcReader.getValue(0) ?? "").toUpperCase());
      }
      await funcReader.close();
      break;
    } catch {
      // try next column name
    }
  }

  if (tableRows.length === 0) {
    return { tables: [], functions };
  }

  // Select first 15 tables for performance
  const selectedTables = tableRows.slice(0, 15);
  
  // === Query 2: columns for selected tables only (optimized) ===
  const tableConditions = selectedTables
    .map(t => `(O.SCHEMA = '${t.schema.replace(/'/g, "''")}' AND O.OBJNAME = '${t.name.replace(/'/g, "''")}')`)
    .join(' OR ');
  
  const colCmd = connection.createCommand(
    `SELECT O.OBJNAME, O.SCHEMA, C.ATTNAME, C.FORMAT_TYPE 
     FROM ${db}.._V_RELATION_COLUMN C 
     INNER JOIN ${db}.._V_OBJECT_DATA O ON C.OBJID = O.OBJID 
     WHERE O.DBNAME = '${db}' 
       AND O.OBJTYPE IN ('TABLE', 'VIEW')
       AND (${tableConditions})
     ORDER BY O.OBJNAME, C.ATTNUM`,
  );
  const colReader = await colCmd.executeReader();

  const colsByTable = new Map<string, { cols: string[]; types: string[] }>();

  while (await colReader.read()) {
    const objName = String(colReader.getValue(0) ?? "").toUpperCase();
    const objSchema = String(colReader.getValue(1) ?? "").toUpperCase();
    const colName = String(colReader.getValue(2) ?? "");
    const formatType = String(colReader.getValue(3) ?? "").toUpperCase();
    const key = `${objSchema}.${objName}`;

    let entry = colsByTable.get(key);
    if (!entry) {
      entry = { cols: [], types: [] };
      colsByTable.set(key, entry);
    }
    entry.cols.push(colName);
    entry.types.push(formatType);
  }
  await colReader.close();

  // === Query 2b: distribution keys ===
  const distByTable = new Map<string, Set<string>>();
  try {
    const distCmd = connection.createCommand(
      `SELECT TABLENAME, SCHEMA, ATTNAME FROM ${db}.._V_TABLE_DIST_MAP WHERE DATABASE = '${db}'`,
    );
    const distReader = await distCmd.executeReader();
    while (await distReader.read()) {
      const tabName = String(distReader.getValue(0) ?? "").toUpperCase();
      const tabSchema = String(distReader.getValue(1) ?? "").toUpperCase();
      const attName = String(distReader.getValue(2) ?? "").toUpperCase();
      const key = `${tabSchema}.${tabName}`;
      let set = distByTable.get(key);
      if (!set) { set = new Set(); distByTable.set(key, set); }
      set.add(attName);
    }
    await distReader.close();
  } catch {
    // _V_TABLE_DIST_MAP may not be accessible - continue without dist key info
  }

  // Build DiscoveredTable list
  const tables: DiscoveredTable[] = [];

  for (const obj of selectedTables) {
    const key = `${obj.schema.toUpperCase()}.${obj.name.toUpperCase()}`;
    const entry = colsByTable.get(key);
    if (!entry || entry.cols.length === 0) continue;

    const columns = entry.cols;
    const typeNames = entry.types;

    let numericCol: string | undefined;
    let stringCol: string | undefined;
    let dateCol: string | undefined;

    typeNames.forEach((ft, i) => {
      const col = columns[i];
      if (
        !numericCol &&
        /^(INT|NUMERIC|DECIMAL|FLOAT|DOUBLE|BIGINT|SMALLINT|TINYINT)/.test(ft)
      ) {
        numericCol = col;
      }
      if (!stringCol && /^(VARCHAR|CHAR|TEXT|NCHAR|NVARCHAR)/.test(ft)) {
        stringCol = col;
      }
      if (!dateCol && /^(DATE|TIMESTAMP|TIME)/.test(ft)) {
        dateCol = col;
      }
    });

    tables.push({
      database,
      schema: obj.schema,
      name: obj.name,
      columns,
      numericColumn: numericCol,
      stringColumn: stringCol,
      dateColumn: dateCol,
      distributionKeys: [...(distByTable.get(key) ?? new Set())],
    });
  }

  return { tables, functions };
}

function buildSchemaProvider(tables: DiscoveredTable[], functions: Set<string>): InMemorySchemaProvider {
  const provider = new InMemorySchemaProvider(true);

  for (const t of tables) {
    provider.createTable(t.database, t.schema, t.name, t.columns);
    if (t.distributionKeys.length > 0) {
      provider.markDistributionKeys(t.database, t.schema, t.name, t.distributionKeys);
    }
  }

  provider.addKnownFunctions(functions);

  // Register system views with their known columns so the linter doesn't flag them
  provider.createTable("SYSTEM", undefined, "_V_DATABASE", ["DATABASE", "OWNER", "CREATEDATE", "DEFAULTSCHEMA", "TABLESPACE", "ENCRYPT"]);
  provider.createTable("SYSTEM", undefined, "_V_SCHEMA", ["SCHEMA", "OWNER", "DESCRIPTION"]);
  provider.createTable("SYSTEM", undefined, "_V_SESSION", ["ID", "USERNAME", "DBNAME", "STATUS", "CLIENT_ADDRESS", "QUERY", "STARTTIME"]);
  provider.createTable("SYSTEM", undefined, "_V_OBJECT_DATA", ["OBJNAME", "OBJID", "OBJTYPE", "SCHEMA", "DBNAME", "OWNER", "DESCRIPTION"]);
  provider.createTable("SYSTEM", undefined, "_V_RELATION_COLUMN", ["ATTNAME", "FORMAT_TYPE", "OBJID", "ATTNUM", "DESCRIPTION", "TYPE", "ATTNOTNULL", "COLDEFAULT"]);
  provider.createTable("SYSTEM", undefined, "_V_RELATION_KEYDATA", ["RELATION", "SCHEMA", "ATTNAME", "CONTYPE"]);
  provider.createTable("SYSTEM", undefined, "_V_VIEW", ["VIEWNAME", "SCHEMA", "DATABASE", "DEFINITION"]);
  provider.createTable("SYSTEM", undefined, "_V_PROCEDURE", ["PROCEDURE", "SCHEMA", "DATABASE", "PROCEDURESOURCE", "OBJID", "DESCRIPTION"]);
  provider.createTable("SYSTEM", undefined, "_V_TABLE", ["TABLENAME", "SCHEMA", "DATABASE", "OWNER"]);
  provider.createTable("SYSTEM", undefined, "_V_OBJECTS", ["OBJNAME", "OBJTYPE", "SCHEMA", "DBNAME", "OWNER"]);
  provider.createTable("SYSTEM", undefined, "_V_SYNONYM", ["OBJID", "SYNONYM_NAME", "SCHEMA", "DATABASE", "REFOBJNAME"]);
  provider.createTable("SYSTEM", undefined, "_V_EXTERNAL", ["TABLENAME", "SCHEMA", "DATABASE"]);
  provider.createTable("SYSTEM", undefined, "_V_EXTOBJECT", ["EXTOBJNAME", "SCHEMA", "DATABASE"]);

  return provider;
}

interface TestCase {
  name: string;
  sql: string;
  category: string;
  /** Known gap: the linter doesn't catch this yet, tracked separately */
  knownLinterGap?: boolean;
}

function buildTestCases(tables: DiscoveredTable[]): TestCase[] {
  const cases: TestCase[] = [];

  if (tables.length === 0) return cases;

  const t = tables[0];
  const col1 = t.columns[0] ?? "1";
  const col2 = t.columns.length > 1 ? t.columns[1] : col1;
  const ncol = t.numericColumn || col1;
  const scol = t.stringColumn || col2;
  const fullName = `${t.database}..${t.name}`;
  const fullQualified = `${t.database}.${t.schema}.${t.name}`;
  // Use expression-based column to avoid duplicate-column ambiguity in CTE contexts
  const exprCol = col2 !== col1 ? col2 : `CAST(${col1} AS VARCHAR(16)) AS col_expr`;

  // === Positive test cases ===
  cases.push({
    name: "basic select one column",
    sql: `SELECT ${col1} FROM ${fullName} LIMIT 1`,
    category: "basic",
  });

  cases.push({
    name: "select multiple columns",
    sql: `SELECT ${col1}, ${col2} FROM ${fullName} LIMIT 1`,
    category: "basic",
  });

  cases.push({
    name: "select star",
    sql: `SELECT * FROM ${fullName} LIMIT 1`,
    category: "basic",
  });

  cases.push({
    name: "where filter",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} IS NOT NULL LIMIT 1`,
    category: "filter",
  });

  cases.push({
    name: "order by limit",
    sql: `SELECT ${col1}, ${col2} FROM ${fullName} ORDER BY ${col1} LIMIT 5`,
    category: "ordering",
  });

  cases.push({
    name: "count aggregation",
    sql: `SELECT COUNT(*) AS cnt FROM ${fullName}`,
    category: "aggregate",
  });

  cases.push({
    name: "group by having",
    sql: `SELECT ${col1}, COUNT(*) AS cnt FROM ${fullName} GROUP BY ${col1} HAVING COUNT(*) > 0`,
    category: "aggregate",
  });

  cases.push({
    name: "expression in select",
    sql: `SELECT ${ncol} * 2 AS doubled FROM ${fullName} LIMIT 1`,
    category: "expression",
  });

  cases.push({
    name: "type cast",
    sql: `SELECT CAST(${ncol} AS BIGINT) AS casted_val FROM ${fullName} LIMIT 1`,
    category: "cast",
  });

  if (scol) {
    cases.push({
      name: "string function",
      sql: `SELECT UPPER(${scol}) AS upper_val FROM ${fullName} LIMIT 1`,
      category: "string",
    });
  }

  cases.push({
    name: "scalar subquery",
    sql: `SELECT ${col1}, (SELECT COUNT(*) FROM ${fullName}) AS cnt FROM ${fullName} LIMIT 1`,
    category: "subquery",
  });

  cases.push({
    name: "in subquery",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} IN (SELECT ${col1} FROM ${fullName} LIMIT 5)`,
    category: "subquery",
  });

  cases.push({
    name: "exists subquery",
    sql: `SELECT ${col1} FROM ${fullName} WHERE EXISTS (SELECT 1 FROM ${fullName} WHERE ${col1} IS NOT NULL) LIMIT 1`,
    category: "subquery",
  });

  cases.push({
    name: "with cte",
    sql: `WITH cte1 AS (SELECT ${col1} FROM ${fullName}) SELECT cte1.${col1} FROM cte1 LIMIT 1`,
    category: "cte",
  });

  cases.push({
    name: "window function row_number",
    sql: `SELECT ${col1}, ROW_NUMBER() OVER (ORDER BY ${col1}) AS rn FROM ${fullName} LIMIT 1`,
    category: "window",
  });

  cases.push({
    name: "window function partition by",
    sql: `SELECT ${col1}, ROW_NUMBER() OVER (PARTITION BY ${col1}) AS rn FROM ${fullName} LIMIT 1`,
    category: "window",
  });

  cases.push({
    name: "union all",
    sql: `SELECT ${col1} FROM ${fullName} UNION ALL SELECT ${col1} FROM ${fullName} LIMIT 1`,
    category: "set",
  });

  cases.push({
    name: "schema qualified",
    sql: `SELECT ${col1} FROM ${fullQualified} LIMIT 1`,
    category: "notation",
  });

  cases.push({
    name: "system view _V_DATABASE",
    sql: 'SELECT "DATABASE" FROM _V_DATABASE LIMIT 1',
    category: "system",
  });

  cases.push({
    name: "system view _V_SESSION",
    sql: "SELECT ID, USERNAME, DBNAME FROM _V_SESSION LIMIT 1",
    category: "system",
  });

  cases.push({
    name: "ctas create temp table",
    sql: `CREATE TEMP TABLE linter_test_ctas_${Date.now()} AS SELECT * FROM ${fullName} LIMIT 0`,
    category: "ddl",
  });

  // === Negative test cases ===
  cases.push({
    name: "non-existent table",
    sql: "SELECT * FROM NON_EXISTENT_TABLE_XYZ123",
    category: "negative",
  });

  cases.push({
    name: "non-existent column",
    sql: `SELECT nonexistent_column_xyz FROM ${fullName} LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "syntax error form instead of from",
    sql: `SELECT ${col1} FORM ${fullName} LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "missing select list",
    sql: `SELECT FROM ${fullName} LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "invalid keyword",
    sql: `SELECT ${col1} FROMM ${fullName}`,
    category: "negative",
  });

  cases.push({
    name: "unclosed parenthesis",
    sql: `SELECT ${col1} FROM ${fullName} WHERE (${col1} = 1 LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "trailing comma before from",
    sql: `SELECT ${col1}, FROM ${fullName} LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "extra comma in select list",
    sql: `SELECT ${col1},, ${col2} FROM ${fullName} LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "group by without aggregation",
    sql: `SELECT ${col1}, ${col2} FROM ${fullName} GROUP BY ${col1}`,
    category: "negative",
  });

  // === Complex CTE scenarios ===
  cases.push({
    name: "multiple CTEs",
    sql: `WITH cte_a AS (SELECT ${col1} FROM ${fullName} LIMIT 1), cte_b AS (SELECT ${col1} FROM ${fullName} LIMIT 1) SELECT a.${col1}, b.${col1} FROM cte_a a, cte_b b`,
    category: "cte",
  });

  cases.push({
    name: "CTE referencing another CTE",
    sql: `WITH base AS (SELECT ${col1}, ${exprCol} FROM ${fullName}), derived AS (SELECT ${col1} FROM base) SELECT * FROM derived LIMIT 1`,
    category: "cte",
  });

  cases.push({
    name: "CTE with aggregate and GROUP BY",
    sql: `WITH agg AS (SELECT ${col1}, COUNT(*) AS cnt FROM ${fullName} GROUP BY ${col1}) SELECT * FROM agg LIMIT 1`,
    category: "cte",
  });

  cases.push({
    name: "CTE with UNION ALL inside",
    sql: `WITH unioned AS (SELECT ${col1} FROM ${fullName} UNION ALL SELECT ${col1} FROM ${fullName}) SELECT * FROM unioned LIMIT 1`,
    category: "cte",
  });

  cases.push({
    name: "recursive CTE",
    sql: `WITH RECURSIVE recurse AS (SELECT ${col1} FROM ${fullName} LIMIT 1 UNION ALL SELECT ${col1} FROM recurse) SELECT * FROM recurse LIMIT 1`,
    category: "cte",
  });

  cases.push({
    name: "CTE used in two places",
    sql: `WITH once AS (SELECT ${col1}, ${exprCol} FROM ${fullName}) SELECT a.${col1} FROM once a JOIN once b ON a.${col1} = b.${col1} LIMIT 1`,
    category: "cte",
  });

  cases.push({
    name: "CTE inside EXISTS subquery",
    sql: `SELECT ${col1} FROM ${fullName} WHERE EXISTS (WITH sub AS (SELECT ${col1} FROM ${fullName}) SELECT 1 FROM sub) LIMIT 1`,
    category: "cte",
  });

  cases.push({
    name: "CTE inside IN subquery",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} IN (WITH sub AS (SELECT ${col1} FROM ${fullName}) SELECT ${col1} FROM sub) LIMIT 1`,
    category: "cte",
  });

  cases.push({
    name: "CTE with window function",
    sql: `WITH ranked AS (SELECT ${col1}, ROW_NUMBER() OVER (ORDER BY ${col1}) AS rn FROM ${fullName}) SELECT * FROM ranked LIMIT 1`,
    category: "cte",
  });

  cases.push({
    name: "CTE with ORDER BY and LIMIT inside",
    sql: `WITH limited AS (SELECT ${col1} FROM ${fullName} ORDER BY ${col1} LIMIT 5) SELECT * FROM limited`,
    category: "cte",
  });

  cases.push({
    name: "CTE shadowing real table name",
    sql: `WITH ${t.name} AS (SELECT ${col1} FROM ${fullName}) SELECT * FROM ${t.name} LIMIT 1`,
    category: "cte",
  });

  // === Deep subquery scenarios ===
  cases.push({
    name: "triple nested subquery",
    sql: `SELECT ${col1} FROM (SELECT ${col1} FROM (SELECT ${col1} FROM ${fullName}) AS s1) AS s2 LIMIT 1`,
    category: "subquery",
  });

  cases.push({
    name: "correlated subquery in WHERE",
    sql: `SELECT ${col1} FROM ${fullName} a WHERE EXISTS (SELECT 1 FROM ${fullName} b WHERE b.${col1} = a.${col1}) LIMIT 1`,
    category: "subquery",
  });

  cases.push({
    name: "subquery in SELECT with CTE and alias",
    sql: `SELECT ${col1}, (SELECT MAX(s.${col1}) FROM (SELECT ${col1} FROM ${fullName}) AS s) FROM ${fullName} LIMIT 1`,
    category: "subquery",
  });

  cases.push({
    name: "subquery in FROM with aggregate",
    sql: `SELECT COUNT(*) FROM (SELECT ${col1} FROM ${fullName} GROUP BY ${col1}) AS grouped`,
    category: "subquery",
  });

  cases.push({
    name: "NOT EXISTS subquery",
    sql: `SELECT ${col1} FROM ${fullName} a WHERE NOT EXISTS (SELECT 1 FROM ${fullName} b WHERE b.${col1} = a.${col1}) LIMIT 1`,
    category: "subquery",
  });

  cases.push({
    name: "subquery with UNION ALL as derived table",
    sql: `SELECT * FROM (SELECT ${col1} FROM ${fullName} UNION ALL SELECT ${col1} FROM ${fullName}) AS u LIMIT 1`,
    category: "subquery",
  });

  cases.push({
    name: "subquery in HAVING",
    sql: `SELECT ${col1}, COUNT(*) FROM ${fullName} GROUP BY ${col1} HAVING COUNT(*) > (SELECT AVG(${ncol}) FROM ${fullName})`,
    category: "subquery",
  });

  // === UNION / UNION ALL scenarios ===
  cases.push({
    name: "triple UNION ALL",
    sql: `SELECT ${col1} FROM ${fullName} UNION ALL SELECT ${col1} FROM ${fullName} UNION ALL SELECT ${col1} FROM ${fullName} LIMIT 1`,
    category: "set",
  });

  cases.push({
    name: "UNION ALL with ORDER BY outside",
    sql: `SELECT ${col1} FROM ${fullName} UNION ALL SELECT ${col1} FROM ${fullName} ORDER BY ${col1} LIMIT 5`,
    category: "set",
  });

  cases.push({
    name: "CTE on each side of UNION",
    sql: `WITH left_cte AS (SELECT ${col1} FROM ${fullName}), right_cte AS (SELECT ${col1} FROM ${fullName}) SELECT * FROM left_cte UNION ALL SELECT * FROM right_cte LIMIT 1`,
    category: "set",
  });

  cases.push({
    name: "UNION inside CTE",
    sql: `WITH combined AS (SELECT ${col1} FROM ${fullName} UNION ALL SELECT ${col1} FROM ${fullName}) SELECT * FROM combined LIMIT 1`,
    category: "set",
  });

  // === Combined complex scenarios ===
  cases.push({
    name: "CTE + window + UNION ALL",
    sql: `WITH numbered AS (SELECT ${col1}, ROW_NUMBER() OVER (ORDER BY ${col1}) AS rn FROM ${fullName}) SELECT ${col1} FROM numbered WHERE rn <= 5 UNION ALL SELECT ${col1} FROM numbered WHERE rn > 5 LIMIT 1`,
    category: "combined",
  });

  cases.push({
    name: "recursive CTE with window function",
    sql: `WITH RECURSIVE r AS (SELECT ${col1} FROM ${fullName} LIMIT 1 UNION ALL SELECT ${col1} FROM r) SELECT ROW_NUMBER() OVER (ORDER BY ${col1}) AS rn, ${col1} FROM r LIMIT 1`,
    category: "combined",
  });

  cases.push({
    name: "CTE + correlated subquery + UNION",
    sql: `WITH base AS (SELECT ${col1} FROM ${fullName}) SELECT ${col1} FROM base WHERE EXISTS (SELECT 1 FROM ${fullName} b WHERE b.${col1} = base.${col1}) UNION ALL SELECT ${col1} FROM base LIMIT 1`,
    category: "combined",
  });

  // === Negative: CTE errors ===
  cases.push({
    name: "CTE missing AS keyword",
    sql: `WITH missing_as (SELECT ${col1} FROM ${fullName}) SELECT * FROM missing_as LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "recursive CTE with UNION instead of UNION ALL",
    sql: `WITH RECURSIVE bad_rec AS (SELECT ${col1} FROM ${fullName} LIMIT 1 UNION SELECT ${col1} FROM bad_rec) SELECT * FROM bad_rec LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "CTE with invalid self-reference",
    sql: `WITH self_ref AS (SELECT ${col1} FROM self_ref) SELECT * FROM self_ref LIMIT 1`,
    category: "negative",
  });

  // === Negative: CTE duplicate columns ===
  cases.push({
    name: "CTE with duplicate column names",
    sql: `WITH dups AS (SELECT ${col1}, ${col1} FROM ${fullName}) SELECT ${col1} FROM dups LIMIT 1`,
    category: "negative",
  });

  // === DML positive (EXPLAIN prefix to avoid side effects) ===
  cases.push({
    name: "INSERT SELECT",
    sql: `EXPLAIN INSERT INTO ${fullName} SELECT * FROM ${fullName} LIMIT 1`,
    category: "dml",
  });

  cases.push({
    name: "UPDATE with WHERE",
    sql: `EXPLAIN UPDATE ${fullName} SET ${col1} = ${col1} WHERE ${col1} IS NOT NULL`,
    category: "dml",
    knownLinterGap: true,
  });

  cases.push({
    name: "DELETE with WHERE",
    sql: `EXPLAIN DELETE FROM ${fullName} WHERE ${col1} IS NOT NULL`,
    category: "dml",
  });

  // === Expression edge cases ===
  cases.push({
    name: "CASE expression in SELECT",
    sql: `SELECT CASE WHEN ${col1} IS NOT NULL THEN ${col1} ELSE 0 END AS val FROM ${fullName} LIMIT 1`,
    category: "expression",
  });

  cases.push({
    name: "COALESCE expression",
    sql: `SELECT COALESCE(${ncol}, 0) AS val FROM ${fullName} LIMIT 1`,
    category: "expression",
  });

  cases.push({
    name: "NULLIF expression",
    sql: `SELECT NULLIF(${col1}, ${col1}) AS val FROM ${fullName} LIMIT 1`,
    category: "expression",
  });

  cases.push({
    name: "CURRENT_DATE without FROM",
    sql: "SELECT CURRENT_DATE",
    category: "expression",
  });

  cases.push({
    name: "EXTRACT from column",
    sql: `SELECT ${col1}, EXTRACT(YEAR FROM ${ncol}) AS yr FROM ${fullName} LIMIT 1`,
    category: "expression",
  });

  cases.push({
    name: "EXTRACT from current_timestamp",
    sql: "SELECT EXTRACT(YEAR FROM CURRENT_TIMESTAMP)",
    category: "expression",
  });

  // === Window frame clauses ===
  cases.push({
    name: "window frame ROWS BETWEEN",
    sql: `SELECT ${col1}, ROW_NUMBER() OVER (ORDER BY ${col1} ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS rn FROM ${fullName} LIMIT 1`,
    category: "window",
  });

  cases.push({
    name: "aggregate with window frame",
    sql: `SELECT ${col1}, SUM(CAST(${ncol} AS BIGINT)) OVER (ORDER BY ${col1} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running FROM ${fullName} LIMIT 1`,
    category: "window",
  });

  cases.push({
    name: "window frame RANGE BETWEEN UNBOUNDED",
    sql: `SELECT ${col1}, SUM(CAST(${ncol} AS BIGINT)) OVER (ORDER BY ${col1} RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running FROM ${fullName} LIMIT 1`,
    category: "window",
  });

  // === DDL positive ===
  cases.push({
    name: "CREATE VIEW",
    sql: `CREATE VIEW linter_test_view_${Date.now()} AS SELECT ${col1} FROM ${fullName}`,
    category: "ddl",
  });

  cases.push({
    name: "SET CATALOG",
    sql: `SET CATALOG ${t.database}`,
    category: "ddl",
  });

  cases.push({
    name: "SET SCHEMA",
    sql: `SET SCHEMA ${t.schema}`,
    category: "ddl",
  });

  // === Lint rule edge cases ===
  cases.push({
    name: "ORDER BY without LIMIT",
    sql: `SELECT ${col1} FROM ${fullName} ORDER BY ${col1}`,
    category: "lint",
  });

  cases.push({
    name: "DELETE without WHERE",
    sql: `EXPLAIN DELETE FROM ${fullName}`,
    category: "lint",
  });

  cases.push({
    name: "UPDATE without WHERE",
    sql: `EXPLAIN UPDATE ${fullName} SET ${col1} = ${col1}`,
    category: "lint",
    knownLinterGap: true,
  });

  cases.push({
    name: "UNION without ALL",
    sql: `SELECT ${col1} FROM ${fullName} UNION SELECT ${col1} FROM ${fullName} LIMIT 1`,
    category: "lint",
  });

  // === Quoted identifier / reserved word edge cases ===
  cases.push({
    name: "quoted table alias",
    sql: `SELECT x.${col1} FROM ${fullName} AS x LIMIT 1`,
    category: "identifier",
  });

  cases.push({
    name: "column alias with reserved keyword",
    sql: `SELECT ${col1} AS "group" FROM ${fullName} LIMIT 1`,
    category: "identifier",
  });

  // === Aggregate function edge cases ===
  cases.push({
    name: "aggregate with DISTINCT",
    sql: `SELECT COUNT(DISTINCT ${col1}) AS cnt FROM ${fullName}`,
    category: "aggregate",
  });

  cases.push({
    name: "nested aggregate in expression",
    sql: `SELECT AVG(CAST(${ncol} AS BIGINT)) * 2 AS avg_double FROM ${fullName}`,
    category: "aggregate",
  });

  // === Multi-way JOIN ===
  cases.push({
    name: "join with USING",
    sql: `SELECT a.${col1} FROM ${fullName} a JOIN ${fullName} b USING (${col1}) LIMIT 1`,
    category: "join",
  });

  cases.push({
    name: "INNER JOIN with ON",
    sql: `SELECT a.${col1} FROM ${fullName} a INNER JOIN ${fullName} b ON a.${col1} = b.${col1} LIMIT 1`,
    category: "join",
  });

  // === Correlated / advanced subqueries ===
  cases.push({
    name: "NOT IN subquery",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} NOT IN (SELECT ${col1} FROM ${fullName} WHERE ${col1} IS NOT NULL LIMIT 5) LIMIT 1`,
    category: "subquery",
  });

  cases.push({
    name: "scalar subquery in WHERE comparison",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} = (SELECT MAX(${col1}) FROM ${fullName}) LIMIT 1`,
    category: "subquery",
  });

  // === Negative: more syntax/semantic errors ===
  cases.push({
    name: "subquery without alias in FROM",
    sql: `SELECT * FROM (SELECT ${col1} FROM ${fullName}) LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "missing WHERE keyword",
    sql: `SELECT ${col1} FROM ${fullName} ${col1} = 1 LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "aggregate function in WHERE",
    sql: `SELECT ${col1} FROM ${fullName} WHERE SUM(${ncol}) > 10`,
    category: "negative",
  });

  // === JOIN variants ===
  cases.push({
    name: "LEFT OUTER JOIN",
    sql: `SELECT a.${col1} FROM ${fullName} a LEFT JOIN ${fullName} b ON a.${col1} = b.${col1} LIMIT 1`,
    category: "join",
  });

  cases.push({
    name: "RIGHT OUTER JOIN",
    sql: `SELECT a.${col1} FROM ${fullName} a RIGHT JOIN ${fullName} b ON a.${col1} = b.${col1} LIMIT 1`,
    category: "join",
  });

  cases.push({
    name: "FULL OUTER JOIN",
    sql: `SELECT a.${col1} FROM ${fullName} a FULL JOIN ${fullName} b ON a.${col1} = b.${col1} LIMIT 1`,
    category: "join",
  });

  cases.push({
    name: "CROSS JOIN",
    sql: `SELECT a.${col1} FROM ${fullName} a CROSS JOIN ${fullName} b LIMIT 1`,
    category: "join",
  });

  // === Set operations ===
  cases.push({
    name: "INTERSECT",
    sql: `SELECT ${col1} FROM ${fullName} INTERSECT SELECT ${col1} FROM ${fullName} LIMIT 1`,
    category: "set",
  });

  cases.push({
    name: "EXCEPT",
    sql: `SELECT ${col1} FROM ${fullName} EXCEPT SELECT ${col1} FROM ${fullName} LIMIT 1`,
    category: "set",
  });

  // === ORDER BY edge cases ===
  cases.push({
    name: "ORDER BY ordinal",
    sql: `SELECT ${col1}, ${ncol} FROM ${fullName} ORDER BY 1 LIMIT 5`,
    category: "ordering",
  });

  cases.push({
    name: "ORDER BY DESC NULLS LAST",
    sql: `SELECT ${col1} FROM ${fullName} ORDER BY ${col1} DESC NULLS LAST LIMIT 5`,
    category: "ordering",
  });

  // === OFFSET / FETCH ===
  cases.push({
    name: "OFFSET and FETCH FIRST",
    sql: `SELECT ${col1} FROM ${fullName} ORDER BY ${col1} OFFSET 1 ROWS FETCH FIRST 3 ROWS ONLY`,
    category: "ordering",
  });

  // === LIKE / ILIKE ===
  if (t.stringColumn) {
    cases.push({
      name: "LIKE pattern in WHERE",
      sql: `SELECT ${t.stringColumn} FROM ${fullName} WHERE ${t.stringColumn} LIKE '%' LIMIT 1`,
      category: "filter",
    });

    cases.push({
      name: "ILIKE pattern in WHERE",
      sql: `SELECT ${t.stringColumn} FROM ${fullName} WHERE ${t.stringColumn} ILIKE '%' LIMIT 1`,
      category: "filter",
    });
  }

  // === Aggregate edge cases ===
  cases.push({
    name: "HAVING without GROUP BY",
    sql: `SELECT COUNT(*) AS cnt FROM ${fullName} HAVING COUNT(*) > 0`,
    category: "aggregate",
  });

  cases.push({
    name: "aggregate with FILTER",
    sql: `SELECT COUNT(*) FILTER (WHERE ${col1} IS NOT NULL) AS cnt FROM ${fullName}`,
    category: "aggregate",
  });

  // === Multiple window functions ===
  cases.push({
    name: "multiple windows same query",
    sql: `SELECT ${col1}, ROW_NUMBER() OVER (ORDER BY ${col1}) AS rn, RANK() OVER (ORDER BY ${col1}) AS rk FROM ${fullName} LIMIT 1`,
    category: "window",
  });

  // === Simple procedure definition ===
  cases.push({
    name: "simple stored procedure",
    sql: `CREATE OR REPLACE PROCEDURE linter_test_proc_${Date.now()}() RETURNS INTEGER LANGUAGE NZPLSQL AS BEGIN RETURN 1; END`,
    category: "procedure",
  });

  // === Negative: more edge cases ===
  cases.push({
    name: "unclosed string literal",
    sql: `SELECT 'hello FROM ${fullName} LIMIT 1`,
    category: "negative",
  });

  cases.push({
    name: "multiple OR in WHERE",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} = 1 OR ${col1} = 2 OR ${col1} = 3 OR ${col1} = 4 LIMIT 1`,
    category: "lint",
  });

  cases.push({
    name: "ORDER BY without LIMIT on subquery",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} IN (SELECT ${col1} FROM ${fullName} ORDER BY ${col1}) LIMIT 1`,
    category: "lint",
  });

  // === Creative edge cases ===
  cases.push({
    name: "GREATEST function",
    sql: `SELECT GREATEST(${col1}, ${col1}) AS g FROM ${fullName} LIMIT 1`,
    category: "expression",
  });

  cases.push({
    name: "POSITION function",
    sql: `SELECT POSITION('A' IN 'ABC') AS pos FROM ${fullName} LIMIT 1`,
    category: "expression",
    knownLinterGap: true,
  });

  cases.push({
    name: "ROW value IN subquery",
    sql: `SELECT a.${col1} FROM ${fullName} a WHERE (a.${col1}, a.${col1}) IN (SELECT b.${col1}, b.${col1} FROM ${fullName} b) LIMIT 1`,
    category: "subquery",
  });

  cases.push({
    name: "EXISTS in SELECT list",
    sql: `SELECT EXISTS(SELECT 1 FROM ${fullName}) AS has FROM ${fullName} LIMIT 1`,
    category: "subquery",
  });

  cases.push({
    name: "NATURAL JOIN",
    sql: `SELECT a.${col1} FROM ${fullName} a NATURAL JOIN ${fullName} b LIMIT 1`,
    category: "join",
  });

  cases.push({
    name: "WHERE ... IS DISTINCT FROM",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} IS DISTINCT FROM ${col1} LIMIT 1`,
    category: "filter",
  });

  cases.push({
    name: "OFFSET without LIMIT",
    sql: `SELECT ${col1} FROM ${fullName} ORDER BY ${col1} OFFSET 5 ROWS`,
    category: "ordering",
  });

  cases.push({
    name: "ORDER BY multiple columns different directions",
    sql: `SELECT ${col1}, ${ncol} FROM ${fullName} ORDER BY ${col1} ASC, ${ncol} DESC LIMIT 5`,
    category: "ordering",
  });

  cases.push({
    name: "LIKE with ESCAPE",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} LIKE '100%%' ESCAPE '%' LIMIT 1`,
    category: "filter",
    knownLinterGap: true,
  });

  cases.push({
    name: "IN with literal list",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} IN (1, 2, 3, 4, 5) LIMIT 1`,
    category: "filter",
  });

  cases.push({
    name: "scalar subquery returns multiple rows",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} = (SELECT ${col1} FROM ${fullName}) LIMIT 1`,
    category: "negative",
    knownLinterGap: true,
  });

  cases.push({
    name: "column alias reused in same SELECT",
    sql: `SELECT ${col1} AS x, ${ncol} * 2 AS y FROM ${fullName} WHERE x > 0 LIMIT 1`,
    category: "expression",
  });

  cases.push({
    name: "SELECT with ROLLUP",
    sql: `SELECT ${col1}, COUNT(*) FROM ${fullName} GROUP BY ROLLUP(${col1})`,
    category: "aggregate",
  });

  cases.push({
    name: "SELECT WITH CUBE",
    sql: `SELECT ${col1}, COUNT(*) FROM ${fullName} GROUP BY CUBE(${col1})`,
    category: "aggregate",
  });

  cases.push({
    name: "SELECT WITH GROUPING SETS",
    sql: `SELECT ${col1}, ${ncol}, COUNT(*) FROM ${fullName} GROUP BY GROUPING SETS ((${col1}), (${ncol}))`,
    category: "aggregate",
  });

  cases.push({
    name: "WINDOW clause reusable window",
    sql: `SELECT ${col1}, ROW_NUMBER() OVER w AS rn, RANK() OVER w AS rk FROM ${fullName} WINDOW w AS (ORDER BY ${col1}) LIMIT 1`,
    category: "window",
  });

  cases.push({
    name: "ARRAY constructor",
    sql: `SELECT ARRAY[${col1}, ${col1}] AS arr FROM ${fullName} LIMIT 1`,
    category: "expression",
  });

  cases.push({
    name: "BETWEEN symmetric",
    sql: `SELECT ${col1} FROM ${fullName} WHERE ${col1} BETWEEN 1 AND 10 LIMIT 1`,
    category: "filter",
  });

  cases.push({
    name: "CTE with INSERT",
    sql: `WITH cte_src AS (SELECT ${col1} FROM ${fullName} LIMIT 1) EXPLAIN INSERT INTO ${fullName} SELECT * FROM cte_src`,
    category: "cte",
  });

  cases.push({
    name: "qualified asterisk",
    sql: `SELECT a.${col1}, a.* FROM ${fullName} a LIMIT 1`,
    category: "basic",
  });

  return cases;
}

async function executeAllTestCases(
  connection: NzConnection,
  qualityEngine: SqlQualityEngine,
  testCases: TestCase[],
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const tc of testCases) {
    const dbError = await tryExecuteOnDb(connection, tc.sql);
    const analysis = qualityEngine.analyze(tc.sql);

    const parserErrorCount = analysis.issues.filter(
      (i) => i.severity === 0 && (i.ruleId.startsWith("PAR") || i.ruleId.startsWith("SQL") || i.ruleId.startsWith("LEX")),
    ).length;
    const linterRuleErrorCount = analysis.issues.filter(
      (i) => i.severity === 0 && i.ruleId.startsWith("NZ"),
    ).length;

    const matched =
      dbError === undefined
        ? parserErrorCount === 0
        : parserErrorCount > 0;

    results.push({
      name: tc.name,
      sql: tc.sql,
      category: tc.category,
      dbError,
      parserErrorCount,
      linterRuleErrorCount,
      matched,
      knownLinterGap: tc.knownLinterGap ?? false,
    });
  }

  return results;
}

async function tryExecuteOnDb(
  connection: NzConnection,
  sql: string,
): Promise<string | undefined> {
  try {
    const command = connection.createCommand(sql);
    command.commandTimeout = 15;

    if (/^\s*(SELECT|WITH|EXPLAIN|SHOW|SET)\b/i.test(sql)) {
      const reader = await command.executeReader();
      await reader.close();
    } else {
      await command.executeNonQuery();
    }

    return undefined;
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    return msg.split("\n")[0].substring(0, 300);
  }
}
