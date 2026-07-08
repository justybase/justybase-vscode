jest.unmock("chevrotain");

import { SqlValidator } from "../../sqlParser/validator";
import { parseSqlStatements } from "../../sqlParser/parsingRuntime";
import { createMockSchemaProvider } from "../../sqlParser/schemaProvider";
import { buildStatementIndex } from "../../sqlParser/statementIndex";
import type { ValidationError } from "../../sqlParser/types";

describe("SqlValidator incremental validation", () => {
  it("validates dirty statement CST and remaps diagnostics to document positions", () => {
    const sql = "SELECT 1;\nSELECT * FROM FROM CUSTOMER;";
    const validator = new SqlValidator();
    const parseResult = parseSqlStatements({ sql });

    const result = validator.validateIncremental(
      sql,
      parseResult,
      [1],
      new Map([[0, []]]),
    );

    const duplicateFrom = result.errors.find((error) => error.code === "PAR003");
    expect(duplicateFrom).toBeDefined();
    expect(duplicateFrom?.position.startLine).toBe(2);
    expect(duplicateFrom?.position.offset).toBeGreaterThan(sql.indexOf("\n"));
  });

  it("remaps incremental diagnostics to match full-document validation positions", () => {
    const sql = "SELECT 1;\nSELECT *\nFROM FROM CUSTOMER;";
    const index = buildStatementIndex(sql);
    const validator = new SqlValidator();
    const fullErrors = validator.validate(sql).errors.filter(
      (error) => error.position.startLine > 1,
    );
    const incrementalErrors = validator.validateIncrementalFromStatements(
      sql,
      index.statements,
      [1],
      new Map([[0, []]]),
    ).errors;

    expect(incrementalErrors).toEqual(fullErrors);
  });

  it("merges cached diagnostics for clean statements", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const validator = new SqlValidator();
    const parseResult = parseSqlStatements({ sql });
    const cachedIssue: ValidationError = {
      message: "cached",
      severity: "warning",
      position: {
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 2,
        offset: 0,
      },
      code: "SQL999",
    };

    const result = validator.validateIncremental(
      sql,
      parseResult,
      [1],
      new Map([[0, [cachedIssue]]]),
    );

    expect(result.warnings).toEqual(expect.arrayContaining([cachedIssue]));
  });

  it("seeds script-created procedures for dirty statement validation", () => {
    const schemaProvider = createMockSchemaProvider([
      {
        database: "EXISTING_DATABASE",
        schema: "ADMIN",
        name: "EXISTING_PROCEDURE",
        columns: ["ID"],
      },
    ]);
    const commentSql =
      "COMMENT ON PROCEDURE EXISTING_DATABASE.ADMIN.NO_SUCH_PROCEDURE() IS 'test procedure';";
    const isolatedResult = new SqlValidator(schemaProvider).validate(commentSql);
    expect(isolatedResult.errors.some((error) => error.code === "SQL006")).toBe(
      true,
    );

    const sql = `CREATE OR REPLACE PROCEDURE EXISTING_DATABASE.ADMIN.NO_SUCH_PROCEDURE()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
END;
END_PROC;
${commentSql}`;
    const index = buildStatementIndex(sql);
    const validator = new SqlValidator(schemaProvider);

    const result = validator.validateIncrementalFromStatements(
      sql,
      index.statements,
      [1],
      new Map([[0, []]]),
    );

    expect(result.errors.some((error) => error.code === "SQL006")).toBe(false);
  });

  it("seeds script-created tables for dirty statement validation", () => {
    const schemaProvider = createMockSchemaProvider([
      {
        database: "TESTDB",
        schema: "PUBLIC",
        name: "EMPLOYEES",
        columns: ["EMPLOYEE_ID", "DEPARTMENT_ID"],
      },
    ]);
    const sql = `CREATE TABLE TESTDB.PUBLIC.CTAS_RESULT AS (SELECT 1 AS A, 2 AS B);
SELECT A, B FROM TESTDB.PUBLIC.CTAS_RESULT;`;
    const index = buildStatementIndex(sql);
    const validator = new SqlValidator(schemaProvider);

    const isolatedResult = validator.validate(index.statements[1].sql);
    expect(isolatedResult.errors.some((error) => error.code === "SQL006")).toBe(
      true,
    );

    const result = validator.validateIncrementalFromStatements(
      sql,
      index.statements,
      [1],
      new Map([[0, []]]),
    );

    expect(result.errors.some((error) => error.code === "SQL006")).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it("seeds script-created temp tables for dirty statement validation", () => {
    const sql = `CREATE TEMP TABLE MY_TEMP (ID INT4, NAME VARCHAR(50));
SELECT ID, NAME FROM MY_TEMP;`;
    const index = buildStatementIndex(sql);
    const validator = new SqlValidator(createMockSchemaProvider([]));

    const result = validator.validateIncrementalFromStatements(
      sql,
      index.statements,
      [1],
      new Map([[0, []]]),
    );

    expect(result.errors.some((error) => error.code === "SQL006")).toBe(false);
  });

  it("removes dropped script tables from scope seed for downstream validation", () => {
    const sql = `CREATE TABLE TESTDB.PUBLIC.T1 AS (SELECT 1 AS ID);
DROP TABLE TESTDB.PUBLIC.T1;
SELECT ID FROM TESTDB.PUBLIC.T1;`;
    const index = buildStatementIndex(sql);
    const validator = new SqlValidator(createMockSchemaProvider([]));

    const result = validator.validateIncrementalFromStatements(
      sql,
      index.statements,
      [2],
      new Map([
        [0, []],
        [1, []],
      ]),
    );

    expect(result.errors.some((error) => error.code === "SQL006")).toBe(true);
  });

  it("fast-path: zero dirty indices skips buildScopeSeeds and validateStatementText", () => {
    const sql = `SELECT 1 FROM DB1.ADMIN.USERS; SELECT 2 FROM DB1.ADMIN.ORDERS;`;
    const index = buildStatementIndex(sql);
    const validator = new SqlValidator(createMockSchemaProvider([]));
    const validateStatementTextSpy = jest.spyOn(
      validator as unknown as {
        validateStatementText: (
          fullSql: string,
          statementSql: string,
          statementOffset: number,
          scopeSeed?: unknown,
        ) => ValidationError[];
      },
      "validateStatementText",
    );
    const buildScopeSeedsSpy = jest.spyOn(
      validator as unknown as { buildScopeSeeds: (s: unknown) => unknown },
      "buildScopeSeeds",
    );

    const makeError = (code: string): ValidationError => ({
      code,
      message: `cached ${code}`,
      severity: "warning",
      position: {
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
        offset: 0,
      },
    });
    const cachedDiagnostics = new Map<number, ValidationError[]>([
      [0, [makeError("CACHED_1")]],
      [1, [makeError("CACHED_2")]],
    ]);

    const result = validator.validateIncrementalFromStatements(
      sql,
      index.statements,
      [],
      cachedDiagnostics,
    );

    expect(validateStatementTextSpy).not.toHaveBeenCalled();
    expect(buildScopeSeedsSpy).not.toHaveBeenCalled();
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.map((w) => w.code)).toEqual(["CACHED_1", "CACHED_2"]);

    validateStatementTextSpy.mockRestore();
    buildScopeSeedsSpy.mockRestore();
  });
});
