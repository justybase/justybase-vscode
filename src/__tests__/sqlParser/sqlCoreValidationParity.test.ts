jest.unmock("chevrotain");

import {
  createMockSchemaProvider,
  type SchemaProvider,
} from "../../sqlParser/schemaProvider";
import { DocumentParseSession } from "../../sqlParser/documentParseSession";
import { SqlCoreBackedValidator } from "../../sqlParser/sqlCoreBackedValidator";
import { buildStatementIndex } from "../../sqlParser/statementIndex";
import {
  NetezzaSqlSemanticValidator,
  parseNetezzaSqlStatements,
  type NetezzaSqlParseResult,
} from "@justybase/sql-core/validation";
import { SqlValidator } from "../../sqlParser/validator";
import {
  NETEZZA_SQL_PARSING_RUNTIME,
  parseSqlStatements,
} from "../../sqlParser";
import type {
  Scope,
  ScopeSeed,
  TableInfo,
  ValidationError,
  ValidationResult,
} from "../../sqlParser/types";
import {
  BASE_SQL_FORMATTER_PROFILE,
  mergeFunctionSignatures,
  mergeStringSets,
  mergeUniqueStrings,
  replaceFunctionSignatures,
  extendFormatterProfile,
} from "../../../packages/sql-core/src/validation/baseProfiles";
import {
  getNetezzaTypeSpec,
  normalizeTypeName,
  supportsProcedureAnySizeArgument,
} from "../../../packages/sql-core/src/validation/dataTypes";
import {
  formatQualifiedObjectName,
  isQuotedIdentifier,
  stripIdentifierQuoting,
  unquoteIdentifier,
} from "../../../packages/sql-core/src/validation/identifierUtils";
import {
  classifySqlDataType,
  classifyLiteralToken,
  getArithmeticMixedTypeWarning,
  getColumnTypeMismatchWarning,
  getTypeMismatchWarning,
} from "../../../packages/sql-core/src/validation/visitor/typeComparisonUtils";
import {
  decodeSqlStringLiteral,
  findCstRule,
  getStringBodyOffsetShift,
  parseWrappedProcedureStringBody,
  wrapProcedureStringBody,
} from "../../../packages/sql-core/src/validation/procedureStringBody";
import {
  getCstNodeTokenSpan,
  getTokenSpanPositionFromEndpoints,
} from "../../../packages/sql-core/src/validation/tokenSpanUtils";
import type { CstNode, IToken } from "chevrotain";

interface ParityCase {
  id: string;
  sql: string;
  schema?: SchemaProvider;
}

interface NormalizedIssue {
  code: string;
  message: string;
  severity: ValidationError["severity"];
  suggestedFix?: string;
  position: ValidationError["position"];
}

const typedSchema = createMockSchemaProvider([
  {
    database: "DB",
    schema: "PUBLIC",
    name: "ORDERS",
    columns: [
      { name: "ORDER_ID", dataType: "INTEGER" },
      { name: "DESCRIPTION", dataType: "VARCHAR(80)" },
      { name: "CREATED_AT", dataType: "DATE" },
    ],
  },
]);

const parityCases: ParityCase[] = [
  { id: "select-literal", sql: "SELECT 1;" },
  { id: "double-dot-table", sql: "SELECT ORDER_ID FROM DB..ORDERS", schema: typedSchema },
  { id: "qualified-column", sql: "SELECT O.ORDER_ID FROM DB.PUBLIC.ORDERS O", schema: typedSchema },
  { id: "numeric-string-comparison", sql: "SELECT * FROM DB.PUBLIC.ORDERS WHERE ORDER_ID = '1'", schema: typedSchema },
  { id: "text-ordered-comparison", sql: "SELECT * FROM DB.PUBLIC.ORDERS WHERE DESCRIPTION > 10", schema: typedSchema },
  { id: "date-comparison", sql: "SELECT * FROM DB.PUBLIC.ORDERS WHERE CREATED_AT = DATE '2024-01-01'", schema: typedSchema },
  { id: "malformed-expression", sql: "SELECT FROM DB.PUBLIC.ORDERS", schema: typedSchema },
  { id: "semicolon-only", sql: " ;;; " },
  { id: "multiline-offsets", sql: "SELECT\n  ORDER_ID\nFROM DB.PUBLIC.ORDERS", schema: typedSchema },
  { id: "procedure-body", sql: "CREATE PROCEDURE P() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;" },
];

// This corpus deliberately exercises the semantic visitor branches that are
// not reached by the small compatibility matrix above.  Every case still
// compares the package-owned implementation with the legacy implementation,
// so additional coverage also remains a regression check rather than a
// syntax-only smoke test.
const semanticParityCorpus: ParityCase[] = [
  { id: "create-table", sql: "CREATE TABLE DB.PUBLIC.T (ID INT4, NAME VARCHAR(20));" },
  { id: "create-temp-table", sql: "CREATE TEMP TABLE TMP_T (ID INT4, FLAG BOOLEAN);" },
  { id: "create-table-as-select", sql: "CREATE TABLE DB.PUBLIC.CTAS_T AS (SELECT 1 AS ID, 'x' AS NAME);" },
  { id: "create-view", sql: "CREATE VIEW DB.PUBLIC.V_T AS SELECT ID FROM DB.PUBLIC.T;" },
  { id: "create-sequence", sql: "CREATE SEQUENCE DB.PUBLIC.SEQ_T START WITH 1 INCREMENT BY 1;" },
  { id: "alter-table", sql: "ALTER TABLE DB.PUBLIC.T ADD COLUMN FLAG CHAR(1);" },
  { id: "drop-objects", sql: "DROP TABLE DB.PUBLIC.T; DROP VIEW DB.PUBLIC.V_T;" },
  { id: "comment-object", sql: "COMMENT ON TABLE DB.PUBLIC.T IS 'table';" },
  { id: "truncate-table", sql: "TRUNCATE TABLE DB.PUBLIC.T;" },
  { id: "groom-and-statistics", sql: "GROOM TABLE DB.PUBLIC.T RECORDS ALL; GENERATE STATISTICS ON DB.PUBLIC.T;" },
  { id: "insert-values", sql: "INSERT INTO DB.PUBLIC.T (ID, NAME) VALUES (1, 'one'), (2, 'two');" },
  { id: "insert-select", sql: "INSERT INTO DB.PUBLIC.T (ID, NAME) SELECT ID, NAME FROM DB.PUBLIC.SOURCE_T WHERE ID > 0;" },
  { id: "update-from", sql: "UPDATE DB.PUBLIC.T TARGET SET NAME = SOURCE.NAME FROM DB.PUBLIC.SOURCE_T SOURCE WHERE TARGET.ID = SOURCE.ID;" },
  { id: "delete-with-subquery", sql: "DELETE FROM DB.PUBLIC.T TARGET WHERE TARGET.ID IN (SELECT ID FROM DB.PUBLIC.SOURCE_T);" },
  { id: "merge", sql: "MERGE INTO DB.PUBLIC.T TARGET USING DB.PUBLIC.SOURCE_T SOURCE ON TARGET.ID = SOURCE.ID WHEN MATCHED THEN UPDATE SET NAME = SOURCE.NAME WHEN NOT MATCHED THEN INSERT (ID, NAME) VALUES (SOURCE.ID, SOURCE.NAME);" },
  { id: "join-group-order", sql: "SELECT T.ID, COUNT(*) AS CNT FROM DB.PUBLIC.T T JOIN DB.PUBLIC.SOURCE_T S ON S.ID = T.ID WHERE T.ID > 0 GROUP BY T.ID HAVING COUNT(*) > 1 ORDER BY T.ID DESC;" },
  { id: "case-window", sql: "SELECT CASE WHEN ID > 0 THEN 'Y' ELSE 'N' END AS FLAG, ROW_NUMBER() OVER (PARTITION BY NAME ORDER BY ID) AS RN FROM DB.PUBLIC.T;" },
  { id: "nested-subquery", sql: "SELECT OUTER_T.ID FROM (SELECT ID FROM DB.PUBLIC.T) OUTER_T WHERE OUTER_T.ID IN (SELECT ID FROM DB.PUBLIC.SOURCE_T);" },
  { id: "cte-union", sql: "WITH A AS (SELECT ID FROM DB.PUBLIC.T), B AS (SELECT ID FROM DB.PUBLIC.SOURCE_T) SELECT ID FROM A UNION ALL SELECT ID FROM B;" },
  { id: "set-commands", sql: "BEGIN; COMMIT; ROLLBACK;" },
  { id: "call", sql: "CALL DB.PUBLIC.P(1, 'x');" },
  { id: "grant-revoke", sql: "GRANT SELECT ON TABLE DB.PUBLIC.T TO USER TESTUSER; REVOKE SELECT ON TABLE DB.PUBLIC.T FROM USER TESTUSER;" },
  { id: "external-table", sql: "CREATE EXTERNAL TABLE EXT_T SAMEAS SOURCE_T USING (DATAOBJECT ('/tmp/data.csv'));" },
  { id: "external-table-columns", sql: "CREATE EXTERNAL TABLE EXT_DATA (ID INT4, NAME VARCHAR(20), CREATED_AT TIMESTAMP) USING (DATAOBJECT ('/tmp/data.csv') FORMAT TEXT DELIMITER '|');" },
  { id: "external-table-options", sql: `CREATE EXTERNAL TABLE EXT_OPTIONS
(
  ID INT4,
  NAME VARCHAR(20),
  CREATED_AT TIMESTAMP
)
USING (
  DATAOBJECT ('/tmp/data.csv')
  FORMAT TEXT
  DELIMITER '|'
  ENCODING 'INTERNAL'
  TIMESTYLE '24HOUR'
  REMOTESOURCE 'JDBC'
  MAXERRORS 1
  LOGDIR '/tmp'
);` },
  { id: "external-table-invalid-option", sql: `CREATE EXTERNAL TABLE EXT_BAD_OPTION
(
  ID INT4
)
USING (
  DATAOBJECT ('/tmp/data.csv')
  WRONG_OPTION_NAME 'abc'
  FORMAT TEXT
);` },
  { id: "external-table-invalid-values", sql: `CREATE EXTERNAL TABLE EXT_BAD_VALUES
(
  ID INT4
)
USING (
  DATAOBJECT ('/tmp/data.csv')
  FORMAT 'BAD_FORMAT'
  QUOTEDVALUE 'MAYBE'
  COMPRESS 'BAD'
  MAXERRORS 'not-a-number'
);` },
  { id: "procedure-control", sql: `CREATE OR REPLACE PROCEDURE CONTROL_PROC(p_id INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_count INT4 := 0;
BEGIN
  IF p_id > 0 THEN
    v_count := p_id;
  ELSE
    v_count := 0;
  END IF;
  WHILE v_count < 2 LOOP
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
END_PROC;` },
  { id: "procedure-dml-ddl", sql: `CREATE OR REPLACE PROCEDURE FLOW_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  INSERT INTO DB.PUBLIC.T (ID, NAME) VALUES (1, 'x');
  UPDATE DB.PUBLIC.T SET NAME = 'y' WHERE ID = 1;
  DELETE FROM DB.PUBLIC.T WHERE ID = 1;
  CREATE TEMP TABLE TMP_FLOW (ID INT4);
  DROP TABLE TMP_FLOW;
  RETURN 1;
END;
END_PROC;` },
  { id: "procedure-exception", sql: `CREATE OR REPLACE PROCEDURE EXCEPTION_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE NOTICE 'running';
  RETURN 1;
EXCEPTION
  WHEN OTHERS THEN
    RETURN 0;
END;
END_PROC;` },
  { id: "procedure-elsif", sql: `CREATE OR REPLACE PROCEDURE IF_PROC(p_val INT4)
RETURNS VARCHAR(20)
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  IF p_val > 100 THEN
    RETURN 'High';
  ELSIF p_val > 50 THEN
    RETURN 'Medium';
  ELSE
    RETURN 'Low';
  END IF;
END;
END_PROC;` },
  { id: "procedure-loop-exit", sql: `CREATE OR REPLACE PROCEDURE LOOP_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_i INT4 := 0;
BEGIN
  LOOP
    v_i := v_i + 1;
    EXIT WHEN v_i >= 5;
  END LOOP;
  RETURN v_i;
END;
END_PROC;` },
  { id: "procedure-for-range", sql: `CREATE OR REPLACE PROCEDURE FOR_RANGE_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_sum INT4 := 0;
BEGIN
  FOR i IN 1..10 LOOP
    v_sum := v_sum + i;
  END LOOP;
  RETURN v_sum;
END;
END_PROC;` },
  { id: "procedure-for-query", sql: `CREATE OR REPLACE PROCEDURE FOR_QUERY_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_cnt INT4 := 0;
BEGIN
  FOR rec IN SELECT ID FROM DB.PUBLIC.T LIMIT 5 LOOP
    v_cnt := v_cnt + 1;
  END LOOP;
  RETURN v_cnt;
END;
END_PROC;` },
  { id: "procedure-for-dynamic", sql: `CREATE OR REPLACE PROCEDURE FOR_DYN_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_cnt INT4 := 0;
BEGIN
  FOR rec IN EXECUTE 'SELECT 1 AS X' LOOP
    v_cnt := v_cnt + 1;
  END LOOP;
  RETURN v_cnt;
END;
END_PROC;` },
  { id: "procedure-dynamic-sql", sql: `CREATE OR REPLACE PROCEDURE DYNAMIC_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_sql TEXT;
BEGIN
  v_sql := 'SELECT 1';
  EXECUTE IMMEDIATE v_sql;
  EXECUTE IMMEDIATE 'SELECT 1' USING 1;
  RETURN 1;
END;
END_PROC;` },
  { id: "procedure-call-and-transaction", sql: `CREATE OR REPLACE PROCEDURE CALLER_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  CALL DB.PUBLIC.P();
  EXECUTE PROCEDURE DB.PUBLIC.P();
  ROLLBACK;
  COMMIT;
  RETURN 1;
END;
END_PROC;` },
  { id: "procedure-declaration-types", sql: `CREATE OR REPLACE PROCEDURE TYPES_PROC()
RETURNS NUMERIC(10,2)
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_int INT4 := 42;
  v_name VARCHAR(100) := 'test';
  v_amount NUMERIC(10,2) := 123.45;
  v_flag BOOL := TRUE;
  v_date DATE;
  v_ts TIMESTAMP;
BEGIN
  RETURN v_amount;
END;
END_PROC;` },
  { id: "procedure-array-and-record", sql: `CREATE OR REPLACE PROCEDURE COMPLEX_VAR_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  arr VARRAY(10) OF INT4;
  rec RECORD;
  v_value INT4;
BEGIN
  arr(1) := 100;
  v_value := arr(1);
  RETURN v_value;
END;
END_PROC;` },
  { id: "procedure-nested-block", sql: `CREATE OR REPLACE PROCEDURE NESTED_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_outer INT4 := 0;
BEGIN
  DECLARE
    v_inner INT4 := 10;
  BEGIN
    v_outer := v_inner;
  END;
  RETURN v_outer;
END;
END_PROC;` },
  { id: "procedure-raise-levels", sql: `CREATE OR REPLACE PROCEDURE RAISE_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE DEBUG 'debug';
  RAISE NOTICE 'notice %', 1;
  RAISE EXCEPTION 'critical';
  RETURN 1;
END;
END_PROC;` },
  { id: "procedure-grant-revoke", sql: `CREATE OR REPLACE PROCEDURE PRIVILEGE_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  GRANT SELECT ON DB.PUBLIC.T TO PUBLIC;
  REVOKE SELECT ON DB.PUBLIC.T FROM PUBLIC;
  RETURN 1;
END;
END_PROC;` },
  { id: "procedure-string-body", sql: `CREATE OR REPLACE PROCEDURE STRING_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
'BEGIN
  RETURN 1;
END;';` },
  { id: "procedure-string-body-select", sql: `CREATE OR REPLACE PROCEDURE STRING_SELECT_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
'BEGIN
  SELECT 1;
END;';` },
  { id: "procedure-string-body-missing-return", sql: `CREATE OR REPLACE PROCEDURE STRING_BAD_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
'BEGIN
  SELECT 1;
END;';` },
  { id: "procedure-select-without-into", sql: `CREATE OR REPLACE PROCEDURE SELECT_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_count INT4;
BEGIN
  SELECT COUNT(*) FROM DB.PUBLIC.T;
  RETURN v_count;
END;
END_PROC;` },
  { id: "procedure-select-with-into", sql: `CREATE OR REPLACE PROCEDURE SELECT_INTO_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_count INT4;
BEGIN
  SELECT COUNT(*) INTO v_count FROM DB.PUBLIC.T;
  RETURN v_count;
END;
END_PROC;` },
  { id: "create-table-distribution", sql: "CREATE TABLE DB.PUBLIC.DIST_T (ID INT4, EVENT_DATE DATE) DISTRIBUTE ON HASH (ID) ORGANIZE ON NONE;" },
  { id: "create-table-random-distribution", sql: "CREATE TABLE DB.PUBLIC.RANDOM_T (ID INT4) DISTRIBUTE ON RANDOM;" },
  { id: "drop-variants", sql: "DROP TABLE IF EXISTS DB.PUBLIC.T; DROP SEQUENCE DB.PUBLIC.SEQ_T; DROP SCHEMA DB.PUBLIC CASCADE;" },
  { id: "drop-session-and-users", sql: "DROP SESSION 12345; DROP USER TESTUSER; DROP GROUP TESTGROUP;" },
  { id: "create-or-replace-view", sql: "CREATE OR REPLACE VIEW DB.PUBLIC.V_REPLACED AS SELECT DISTINCT ID FROM DB.PUBLIC.T;" },
  { id: "query-pagination", sql: "SELECT ID FROM DB.PUBLIC.T ORDER BY ID ASC NULLS LAST LIMIT 10 OFFSET 2 FETCH FIRST 5 ROWS ONLY;" },
  { id: "query-set-operators", sql: "SELECT ID FROM DB.PUBLIC.T INTERSECT SELECT ID FROM DB.PUBLIC.SOURCE_T EXCEPT SELECT ID FROM DB.PUBLIC.OTHER_T;" },
  { id: "query-join-variants", sql: "SELECT T.ID FROM DB.PUBLIC.T T LEFT JOIN DB.PUBLIC.SOURCE_T S ON S.ID = T.ID RIGHT JOIN DB.PUBLIC.OTHER_T O ON O.ID = T.ID FULL JOIN DB.PUBLIC.EXTRA_T E ON E.ID = T.ID;" },
  { id: "procedure-reftable", sql: `CREATE OR REPLACE PROCEDURE REFTABLE_PROC()
RETURNS REFTABLE(DB.PUBLIC.T)
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN REFTABLE;
END;
END_PROC;` },
  { id: "procedure-execute-owner", sql: `CREATE OR REPLACE PROCEDURE OWNER_PROC()
EXECUTE AS OWNER
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 0;
END;
END_PROC;` },
  { id: "procedure-is-body", sql: `CREATE OR REPLACE PROCEDURE IS_PROC()
RETURNS INT4
LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;` },
  { id: "procedure-maintenance", sql: `CREATE OR REPLACE PROCEDURE MAINT_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  GROOM TABLE DB.PUBLIC.T RECORDS ALL;
  GENERATE STATISTICS ON DB.PUBLIC.T;
  TRUNCATE TABLE DB.PUBLIC.T;
  RETURN 1;
END;
END_PROC;` },
  { id: "procedure-invalid-type", sql: `CREATE OR REPLACE PROCEDURE BAD_TYPE_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_bad UNKNOWN_TYPE;
BEGIN
  RETURN 1;
END;
END_PROC;` },
  { id: "procedure-missing-begin", sql: `CREATE OR REPLACE PROCEDURE BAD_BEGIN_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN
  RETURN 1;
END_PROC;` },
  { id: "procedure-missing-end", sql: `CREATE OR REPLACE PROCEDURE BAD_END_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;` },
  { id: "procedure-string-case-error", sql: `CREATE OR REPLACE PROCEDURE BAD_CASE_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
'BEGIN
  CASE 1 WHEN 1 THEN RETURN 1;
END;';` },
  { id: "invalid-create-table", sql: "CREATE TABLE DB.PUBLIC.INVALID_T (ID);" },
  { id: "invalid-insert", sql: "INSERT INTO VALUES (1, 'missing-table');" },
  { id: "parser-recovery", sql: "SELECT FROM DB.PUBLIC.T;" },
  { id: "macro-unicode", sql: "%put 😀;\nSELECT ID FROM DB.PUBLIC.T;" },
];

describe("sql-core validation compatibility boundary", () => {
  it.each(parityCases)("preserves legacy result for $id", ({ sql, schema }) => {
    const legacy = new SqlValidator(schema);
    const coreBacked = new SqlCoreBackedValidator(schema);

    expect(normalizeResult(coreBacked.validate(sql))).toEqual(
      normalizeResult(legacy.validate(sql)),
    );
  });

  it.each(semanticParityCorpus)("covers semantic parity for $id", ({ sql, schema }) => {
    const legacy = new SqlValidator(schema);
    const coreBacked = new SqlCoreBackedValidator(schema);

    expect(normalizeResult(coreBacked.validate(sql))).toEqual(
      normalizeResult(legacy.validate(sql)),
    );
  });

  it("preserves typed SQL025/SQL026 diagnostics exactly", () => {
    const legacy = new SqlValidator(typedSchema);
    const coreBacked = new SqlCoreBackedValidator(typedSchema);
    const sql =
      "SELECT * FROM DB.PUBLIC.ORDERS WHERE ORDER_ID = '1' AND DESCRIPTION > 10";

    const legacyDiagnostics = normalizeDiagnostics(legacy.validate(sql));
    const coreDiagnostics = normalizeDiagnostics(coreBacked.validate(sql));

    expect(coreDiagnostics).toEqual(legacyDiagnostics);
    expect(coreDiagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["SQL025", "SQL026"]),
    );
  });

  it("preserves the shared parse-session validation path", () => {
    const sql = "SELECT ORDER_ID FROM DB.PUBLIC.ORDERS WHERE ORDER_ID = '1'";
    const parseSession = new DocumentParseSession();
    const parseRequest = {
      documentUri: "file:///parity.sql",
      documentVersion: 1,
      sql,
      databaseKind: "netezza" as const,
    };
    const parseResult = parseSession.getParseResult(parseRequest);
    const legacy = new SqlValidator(typedSchema);
    const coreBacked = new SqlCoreBackedValidator(typedSchema);

    expect(normalizeResult(coreBacked.validateFromParseResult(sql, parseResult))).toEqual(
      normalizeResult(legacy.validateFromParseResult(sql, parseResult)),
    );
  });

  it("covers the adapter validateIncremental boundary directly", () => {
    const sql = "SELECT '😀';\nSELECT * FROM DB.PUBLIC.ORDERS WHERE ORDER_ID = '1';";
    const parseResult = parseSqlStatements({
      sql,
      databaseKind: "netezza",
    });
    const cachedIssue: ValidationError = {
      message: "cached first statement",
      severity: "warning",
      position: {
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
        offset: 0,
      },
      code: "SQL999",
    };
    const validator = new SqlCoreBackedValidator(typedSchema);

    const result = validator.validateIncremental(
      sql,
      parseResult,
      [1],
      new Map([[0, [cachedIssue]]]),
    );

    expect(result.warnings).toEqual(expect.arrayContaining([cachedIssue]));
    const mismatch = result.warnings.find((issue) => issue.code === "SQL025");
    expect(mismatch?.position.startLine).toBe(2);
    expect(mismatch?.position.offset).toBe(sql.lastIndexOf("'1'"));
  });

  it("uses supplied scope seeds and falls back for parser errors", () => {
    const sql = "SELECT ID FROM TMP_SCOPE;";
    const parseResult = parseSqlStatements({
      sql,
      databaseKind: "netezza",
    });
    const scopeSeed: ScopeSeed = {
      createdTables: [{
        name: "TMP_SCOPE",
        isCte: false,
        isTempTable: true,
        columns: [{ name: "ID", dataType: "INTEGER" }],
      }],
    };
    const validator = new SqlCoreBackedValidator();

    const seeded = validator.validateIncremental(
      sql,
      parseResult,
      [0],
      new Map(),
      new Map([[0, scopeSeed]]),
    );

    expect(seeded.errors).toEqual([]);

    const malformedSql = "SELECT FROM TMP_SCOPE;";
    const malformed = validator.validateIncremental(
      malformedSql,
      parseSqlStatements({
        sql: malformedSql,
        databaseKind: "netezza",
      }),
      [0],
      new Map(),
    );

    expect(malformed.errors.length).toBeGreaterThan(0);
  });

  it.each([0, 1, 2])("keeps first/middle/last dirty statement parity (%i)", (dirtyIndex) => {
    const sql = "SELECT FROM;\nSELECT 1;\nSELECT 2;";
    const validator = new SqlCoreBackedValidator();
    expectIncrementalDiagnosticsToMatchFull(validator, sql, [dirtyIndex]);
  });

  it("keeps script scope seeds across create, rename, SELECT INTO TEMP and drop", () => {
    const sql = `CREATE TEMP TABLE TMP_SCOPE (ID INT4);
ALTER TABLE TMP_SCOPE RENAME TO RENAMED_SCOPE;
SELECT ID FROM RENAMED_SCOPE;
SELECT 1 AS ID INTO #SELECTED_SCOPE;
SELECT ID FROM #SELECTED_SCOPE;
DROP TABLE RENAMED_SCOPE;
SELECT ID FROM RENAMED_SCOPE;`;
    const validator = new SqlCoreBackedValidator();

    expectIncrementalDiagnosticsToMatchFull(validator, sql, [2, 4, 6]);
  });

  it("keeps procedure scope seeds and supports an empty dirty list without a cache", () => {
    const sql = `CREATE OR REPLACE PROCEDURE DB.PUBLIC.PARITY_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;
COMMENT ON PROCEDURE DB.PUBLIC.PARITY_PROC() IS 'parity';
SELECT FROM DB.PUBLIC.PARITY_PROC;`;
    const validator = new SqlCoreBackedValidator();
    const index = buildStatementIndex(sql);
    const full = validator.validate(sql);
    const incremental = validator.validateIncrementalFromStatements(
      sql,
      index.statements,
      [1, 2],
      diagnosticsByStatement(full, index.statements),
    );

    expect(normalizeDiagnostics(incremental)).toEqual(normalizeDiagnostics(full));
    const empty = validator.validateIncrementalFromStatements(
      sql,
      index.statements,
      [],
      new Map(),
    );
    expect(empty.valid).toBe(true);
    expect(empty.errors).toEqual([]);
    expect(empty.warnings).toEqual([]);
  });

  it("keeps the package-owned quick syntax validation contract", () => {
    const validator = new NetezzaSqlSemanticValidator();

    expect(validator.quickValidate(";;;"))
      .toBe(true);
    expect(validator.quickValidate("SELECT 1"))
      .toBe(true);
    expect(validator.quickValidate("SELECT FROM"))
      .toBe(false);
    expect(validator.quickValidate("SELECT 'unterminated"))
      .toBe(false);
  });

  it("covers portable validation utility edge cases", () => {
    expect(mergeUniqueStrings(["A", "B"], ["B", "C"])).toEqual(["A", "B", "C"]);
    expect([...mergeStringSets(["A"], ["A", "B"])]).toEqual(["A", "B"]);

    const signatures = new Map([
      ["F", [{ name: "F", parameters: ["INT4"], description: "function" }]],
    ]);
    const additionalSignatures = new Map([
      ["G", [{ name: "G", parameters: [], description: "other" }]],
    ]);
    expect(mergeFunctionSignatures(signatures, additionalSignatures).get("F")).toHaveLength(1);
    expect(mergeFunctionSignatures(signatures, additionalSignatures).get("G")).toHaveLength(1);
    expect(replaceFunctionSignatures(signatures, additionalSignatures).get("G")).toHaveLength(1);
    expect(
      extendFormatterProfile(BASE_SQL_FORMATTER_PROFILE, {
        keywords: ["CUSTOM"],
        clauseKeywords: [],
      }).keywords.has("CUSTOM"),
    ).toBe(true);
    expect(extendFormatterProfile(BASE_SQL_FORMATTER_PROFILE, {}).keywords.has("SELECT")).toBe(true);

    expect(normalizeTypeName("  varchar  ")).toBe("VARCHAR");
    expect(getNetezzaTypeSpec("")).toBeUndefined();
    expect(getNetezzaTypeSpec("INTERVAL DAY TO SECOND")?.canonical).toBe("INTERVAL");
    expect(getNetezzaTypeSpec("UNKNOWN_TYPE")).toBeUndefined();
    expect(supportsProcedureAnySizeArgument("VARCHAR")).toBe(true);
    expect(supportsProcedureAnySizeArgument("INT4")).toBe(false);

    expect(isQuotedIdentifier('"A"')).toBe(true);
    expect(isQuotedIdentifier("A")).toBe(false);
    expect(unquoteIdentifier('"A""B"')).toBe('A"B');
    expect(stripIdentifierQuoting("[A]]B]")).toBe("A]B");
    expect(formatQualifiedObjectName("DB", "PUBLIC", "TABLE")).toBe("DB.PUBLIC.TABLE");
    expect(formatQualifiedObjectName("DB", undefined, "TABLE")).toBe("DB..TABLE");
    expect(formatQualifiedObjectName(undefined, "PUBLIC", "TABLE")).toBe("PUBLIC.TABLE");
    expect(formatQualifiedObjectName(undefined, undefined, "needs space")).toBe('"needs space"');

    expect(classifySqlDataType()).toBe("unknown");
    expect(classifySqlDataType("INTEGER")).toBe("numeric");
    expect(classifySqlDataType("VARCHAR(20)")).toBe("string");
    expect(classifySqlDataType("TIMESTAMP")).toBe("datetime");
    expect(classifySqlDataType("BOOLEAN")).toBe("boolean");
    expect(classifySqlDataType("CUSTOM_TYPE")).toBe("unknown");
    expect(classifyLiteralToken("StringLiteral")).toBe("string");
    expect(classifyLiteralToken("NumberLiteral")).toBe("number");
    expect(classifyLiteralToken("Null")).toBe("null");
    expect(classifyLiteralToken("Other")).toBe("unknown");

    expect(getTypeMismatchWarning("unknown", "number", "Equals")).toBeUndefined();
    expect(getTypeMismatchWarning("numeric", "null", "Equals")).toBeUndefined();
    expect(getTypeMismatchWarning("numeric", "string", "Equals")?.code).toBe("SQL025");
    expect(getTypeMismatchWarning("string", "number", "GreaterThan")?.code).toBe("SQL026");
    expect(getTypeMismatchWarning("string", "number", "Equals")?.code).toBe("SQL025");
    expect(getTypeMismatchWarning("string", "number", "NotEquals")?.code).toBe("SQL025");
    expect(getTypeMismatchWarning("datetime", "number", "Equals")).toBeUndefined();
    expect(getTypeMismatchWarning("numeric", "number", "Like")).toBeUndefined();
    expect(getColumnTypeMismatchWarning("numeric", "string", "Equals")?.code).toBe("SQL025");
    expect(getColumnTypeMismatchWarning("string", "numeric", "GreaterThan")?.code).toBe("SQL026");
    expect(getColumnTypeMismatchWarning("string", "numeric", "NotEquals")?.code).toBe("SQL025");
    expect(getColumnTypeMismatchWarning("unknown", "numeric", "Equals")).toBeUndefined();
    expect(getColumnTypeMismatchWarning("numeric", "string", "Like")).toBeUndefined();
    expect(getArithmeticMixedTypeWarning("numeric", "string")?.code).toBe("SQL025");
    expect(getArithmeticMixedTypeWarning("string", "numeric")?.code).toBe("SQL025");
    expect(getArithmeticMixedTypeWarning("unknown", "numeric")).toBeUndefined();
    expect(getArithmeticMixedTypeWarning("numeric", "numeric")).toBeUndefined();
    expect(getArithmeticMixedTypeWarning("boolean", "datetime")).toBeUndefined();

    expect(decodeSqlStringLiteral("'a''b'")).toBe("a'b");
    expect(decodeSqlStringLiteral("plain")).toBe("plain");
    expect(wrapProcedureStringBody("RETURN 1;")).toContain("BEGIN_PROC");
    expect(getStringBodyOffsetShift(100)).toBeLessThan(100);
    expect(parseWrappedProcedureStringBody("BEGIN\n  RETURN 1;\nEND;").parserErrors).toEqual([]);
    expect(findCstRule({ name: "not-the-target", children: {} } as CstNode, "target")).toBeUndefined();

    const firstToken = {
      image: "A",
      startOffset: 2,
      startLine: 2,
      startColumn: 3,
    } as IToken;
    const lastToken = {
      image: "BC",
      startOffset: 4,
      endLine: 3,
    } as IToken;
    expect(getTokenSpanPositionFromEndpoints(firstToken, lastToken)).toEqual({
      startLine: 2,
      startColumn: 3,
      endLine: 3,
      endColumn: 7,
      offset: 2,
    });
    expect(getTokenSpanPositionFromEndpoints({} as IToken, {} as IToken)).toEqual({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
      offset: 0,
    });
    expect(getCstNodeTokenSpan({ name: "empty", children: {} } as CstNode)).toBeUndefined();
    const parsed = parseNetezzaSqlStatements({ sql: "SELECT 1" });
    expect(parsed.cst && getCstNodeTokenSpan(parsed.cst)).toBeDefined();
  });

  it.each([
    "%let x=5;\n%put Value is &x;\nSELECT &x, ${ x }, $x;",
    "SELECT * FROM &table_name;\nSELECT * FROM $table_name;\nSELECT * FROM ${ table_name };",
    "%python script.py --value 1;\n%do;\nSELECT 1;\n%end;",
    "SELECT %sql(SELECT MAX(DATEKEY) FROM DB.PUBLIC.DIMDATE) AS max_key FROM DB.PUBLIC.DIMDATE WHERE REGION IN (%sqllist(SELECT REGION FROM DB.PUBLIC.REGIONS));",
    "SELECT * FROM DB.PUBLIC.DIMDATE WHERE DATEKEY >= %eval(20240731 - 30);",
    `%LET run_bad_sql = 0;
%IF &run_bad_sql = 1 %THEN %DO;
  THIS IS NOT VALID SQL FROM A SKIPPED BRANCH
%ELSE %DO;
  %PUT skipped invalid branch;
%END;
SELECT 1;`,
  ])("preserves lexer and parser output for macro authoring input", (sql) => {
    const legacy = parseSqlStatements({
      sql,
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });
    const core = parseNetezzaSqlStatements({ sql });

    expect(normalizeParseResult(core)).toEqual(normalizeParseResult(legacy));
  });
});

function normalizeResult(result: ValidationResult): unknown {
  return {
    valid: result.valid,
    errors: normalizeIssues(result.errors),
    warnings: normalizeIssues(result.warnings),
    scope: normalizeScope(result.scope),
  };
}

function normalizeParseResult(result: NetezzaSqlParseResult | {
  lexResult: {
    errors: Array<{ message: string; offset?: number; line?: number; column?: number }>;
    tokens: Array<{ image: string; startOffset?: number; endOffset?: number; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number }>;
  };
  parserErrors: Array<{ message: string; token?: { image?: string; startOffset?: number; startLine?: number; startColumn?: number } }>;
  actionableParserErrors: Array<{ message: string; token?: { image?: string; startOffset?: number; startLine?: number; startColumn?: number } }>;
  cst?: { name?: string; children?: Record<string, unknown> };
}): unknown {
  return {
    lexErrors: result.lexResult.errors.map((error) => ({
      message: error.message,
      offset: error.offset,
      line: error.line,
      column: error.column,
    })),
    tokens: result.lexResult.tokens.map((token) => ({
      image: token.image,
      startOffset: token.startOffset,
      endOffset: token.endOffset,
      startLine: token.startLine,
      startColumn: token.startColumn,
      endLine: token.endLine,
      endColumn: token.endColumn,
    })),
    parserErrors: normalizeParserErrors(result.parserErrors),
    actionableParserErrors: normalizeParserErrors(result.actionableParserErrors),
    cstName: result.cst?.name,
    statementCount: result.cst?.children?.statement
      ? (result.cst.children.statement as unknown[]).length
      : 0,
  };
}

function normalizeParserErrors(
  errors: Array<{ message: string; token?: { image?: string; startOffset?: number; startLine?: number; startColumn?: number } }>,
): unknown[] {
  return errors.map((error) => ({
    message: error.message,
    token: error.token
      ? {
        image: error.token.image,
        startOffset: error.token.startOffset,
        startLine: error.token.startLine,
        startColumn: error.token.startColumn,
      }
      : undefined,
  }));
}

function normalizeDiagnostics(result: ValidationResult): NormalizedIssue[] {
  return normalizeIssues([...result.errors, ...result.warnings]);
}

function normalizeIssues(issues: ValidationError[]): NormalizedIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
    suggestedFix: issue.suggestedFix,
    position: { ...issue.position },
  }));
}

function normalizeScope(scope: Scope): unknown {
  return normalizeScopeNode(scope);
}

function normalizeScopeNode(scope: Scope | undefined): unknown {
  if (!scope) return undefined;
  return {
    level: scope.level,
    tables: [...scope.tables.entries()].map(([key, table]) => [
      key,
      normalizeTable(table),
    ]),
    ctes: [...scope.ctes.entries()].map(([key, table]) => [
      key,
      normalizeTable(table),
    ]),
    parent: normalizeScopeNode(scope.parent),
    position: scope.position ? { ...scope.position } : undefined,
  };
}

function normalizeTable(table: TableInfo): unknown {
  return {
    name: table.name,
    alias: table.alias,
    schema: table.schema,
    database: table.database,
    isCte: table.isCte,
    isTempTable: table.isTempTable,
    columns: table.columns.map((column) => ({ ...column })),
    position: table.position ? { ...table.position } : undefined,
  };
}

function expectIncrementalDiagnosticsToMatchFull(
  validator: SqlCoreBackedValidator,
  sql: string,
  dirtyIndices: readonly number[],
): void {
  const index = buildStatementIndex(sql);
  const full = validator.validate(sql);
  const incremental = validator.validateIncrementalFromStatements(
    sql,
    index.statements,
    dirtyIndices,
    diagnosticsByStatement(full, index.statements),
  );

  expect(incremental.valid).toBe(full.valid);
  expect(normalizeDiagnostics(incremental)).toEqual(normalizeDiagnostics(full));
}

function diagnosticsByStatement(
  result: ValidationResult,
  statements: readonly { index: number; startOffset: number; endOffset: number }[],
): Map<number, ValidationError[]> {
  const diagnostics = [...result.errors, ...result.warnings];
  return new Map(statements.map((statement) => [
    statement.index,
    diagnostics.filter((diagnostic) =>
      diagnostic.position.offset >= statement.startOffset
      && diagnostic.position.offset <= statement.endOffset,
    ),
  ]));
}
