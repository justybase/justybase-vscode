jest.unmock("chevrotain");

import { db2SqlAuthoring } from "../../../extensions/db2/src/sql/authoring";
import { SqlValidator, sqlValidator } from "../../sqlParser/validator";
import { InMemorySchemaProvider, createMockSchemaProvider } from "../../sqlParser/schemaProvider";

describe("SqlValidator", () => {
  describe("setSchemaProvider", () => {
    it("should update schema provider dynamically", () => {
      const validator = new SqlValidator();

      const schema1 = createMockSchemaProvider([
        {
          database: "DB1",
          schema: "SCHEMA1",
          name: "TABLE1",
          columns: ["COL1"],
        },
      ]);

      const schema2 = createMockSchemaProvider([
        {
          database: "DB2",
          schema: "SCHEMA2",
          name: "TABLE2",
          columns: ["COL2"],
        },
      ]);

      validator.setSchemaProvider(schema1);
      const result1 = validator.validate("SELECT * FROM DB1..TABLE1");
      expect(result1.errors).toHaveLength(0);

      validator.setSchemaProvider(schema2);
      const result2 = validator.validate("SELECT * FROM DB2..TABLE2");
      expect(result2.errors).toHaveLength(0);

      const result3 = validator.validate("SELECT * FROM DB1..TABLE1");
      expect(result3.errors.length).toBeGreaterThan(0);
    });
  });

  describe("quickValidate", () => {
    it("should return true for semicolon-only SQL", () => {
      const validator = new SqlValidator();
      expect(validator.quickValidate(";")).toBe(true);
      expect(validator.quickValidate("  ;;;;  ")).toBe(true);
    });

    it("should return true for valid SQL", () => {
      const validator = new SqlValidator();
      expect(validator.quickValidate("SELECT 1;")).toBe(true);
      expect(validator.quickValidate("SELECT * FROM TABLE1;")).toBe(true);
    });

    it("should return false for invalid SQL with lexer errors", () => {
      const validator = new SqlValidator();
      expect(validator.quickValidate("SELECT 'unclosed")).toBe(false);
    });

    it("should return false for invalid SQL with parser errors", () => {
      const validator = new SqlValidator();
      expect(validator.quickValidate("SELECT FROM table")).toBe(false);
      expect(validator.quickValidate("SELECT 1,,2")).toBe(false);
    });
  });

  describe("validate with scope", () => {
    it("should return scope after successful validation", () => {
      const schema = createMockSchemaProvider([
        {
          database: "TESTDB",
          schema: "PUBLIC",
          name: "EMPLOYEES",
          columns: ["ID", "NAME"],
        },
      ]);
      const validator = new SqlValidator(schema);

      const result = validator.validate(
        "SELECT ID, NAME FROM TESTDB..EMPLOYEES",
      );
      expect(result.scope).toBeDefined();
    });

    it("should reset scope on validation errors", () => {
      const schema = createMockSchemaProvider([
        {
          database: "TESTDB",
          schema: "PUBLIC",
          name: "EMPLOYEES",
          columns: ["ID"],
        },
      ]);
      const validator = new SqlValidator(schema);

      const result1 = validator.validate(
        "SELECT ID, NAME FROM TESTDB..EMPLOYEES",
      );
      const scope1 = result1.scope;

      const result2 = validator.validate(
        "SELECT INVALID FROM TESTDB..EMPLOYEES",
      );
      const scope2 = result2.scope;

      expect(scope1).toBeDefined();
      expect(scope2).toBeDefined();
    });
  });

  describe("validate with lexer errors", () => {
    it("should report lexer errors with correct position", () => {
      const validator = new SqlValidator();
      const result = validator.validate("SELECT 'unclosed string");

      expect(result.errors.length).toBeGreaterThan(0);
      const lexError = result.errors.find((e) => e.code === "LEX001");
      expect(lexError).toBeDefined();
      expect(lexError?.position).toBeDefined();
      expect(lexError?.position.startLine).toBe(1);
    });

    it("should not report lexer or parser errors for %let macro variables", () => {
      const validator = new SqlValidator();
      const result = validator.validate("%let x=5;\n\nSELECT &x;");

      expect(result.errors.find((e) => e.code === "LEX001")).toBeUndefined();
      expect(result.errors.find((e) => e.code === "PAR001")).toBeUndefined();
    });

    it("should not report parser errors for macro references in table positions", () => {
      const validator = new SqlValidator();
      const result = validator.validate("SELECT * FROM &table_name;\nSELECT * FROM $table_name;\nSELECT * FROM ${ table_name };");

      expect(result.errors.find((e) => e.code === "LEX001")).toBeUndefined();
      expect(result.errors.find((e) => e.code === "PAR001")).toBeUndefined();
    });

    it("should strip chained macro directives before validation", () => {
      const validator = new SqlValidator();
      const result = validator.validate("%let x=1; %put &x; SELECT 1;");

      expect(result.errors.find((e) => e.code === "LEX001")).toBeUndefined();
      expect(result.errors.find((e) => e.code === "PAR001")).toBeUndefined();
    });

    it("should not validate macro references as missing table columns", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          schema: "ADMIN",
          name: "DIMDATE",
          columns: ["ACCOUNTKEY", "DATEKEY", "CALENDARQUARTER"],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(`%LET points_cutoff = 20;
%LET base_score = 5;
%LET bonus = %EVAL((&base_score * 2) + 1);
%LET report_title = 'Monthly score report';

%PUT Report: &report_title;
%PUT Cutoff: &points_cutoff;
%PUT Bonus: &bonus;

SELECT
  d.ACCOUNTKEY,
  d.DATEKEY,
  &points_cutoff AS cutoff_value,
  \${bonus} AS bonus_value,
  $report_title AS report_title
FROM JUST_DATA.ADMIN.DIMDATE d
WHERE d.CALENDARQUARTER >= &base_score
  AND d.DATEKEY >= &points_cutoff
ORDER BY d.DATEKEY;`);

      expect(result.errors.find((e) => e.code === "LEX001")).toBeUndefined();
      expect(result.errors.find((e) => e.code === "PAR001")).toBeUndefined();
      expect(result.errors.find((e) => e.code === "SQL004")).toBeUndefined();
    });
  });

  describe("validate with parser errors", () => {
    it("should report parser errors with correct position", () => {
      const validator = new SqlValidator();
      const result = validator.validate("SELECT FROM table");

      expect(result.errors.length).toBeGreaterThan(0);
      const parseError = result.errors.find((e) => e.code === "PAR001");
      expect(parseError).toBeDefined();
      expect(parseError?.position).toBeDefined();
    });

    it("should report PAR101 for missing AS in CTE definition", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "WITH ABC1 (SELECT X.ACCOUNTCODEALTERNATEKEY FROM JUST_DATA..DIMACCOUNT X) SELECT * FROM ABC1;",
      );

      const parseError = result.errors.find((e) => e.code === "PAR101");
      expect(parseError).toBeDefined();
      expect(parseError?.message).toContain("missing AS");
      expect(parseError?.message).toContain("ABC1");
    });

    it("should provide friendly message for missing source after FROM", () => {
      const validator = new SqlValidator();
      const result = validator.validate("SELECT * FROM;");

      const parseError = result.errors.find((e) => e.code === "PAR001");
      expect(parseError).toBeDefined();
      expect(parseError?.message).toContain(
        "Missing table or subquery after FROM",
      );
    });

    it("should point PAR001 after FROM when table source is missing", () => {
      const validator = new SqlValidator();
      const result = validator.validate("SELECT * FROM ");

      const parseError = result.errors.find((e) => e.code === "PAR001");
      expect(parseError).toBeDefined();
      expect(parseError?.message).toContain(
        "Missing table or subquery after FROM",
      );
      expect(parseError?.position.startLine).toBe(1);
      expect(parseError?.position.startColumn).toBeGreaterThan(8);
    });

    it("should point PAR001 after outer FROM when CTE query is incomplete", () => {
      const validator = new SqlValidator();
      const result = validator.validate(`WITH CTE1 AS (
SELECT * FROM JUST_DATA.ADMIN.DIMACCOUNT DA
WHERE DA.ACCOUNTKEY > 5
)


SELECT * FROM `);

      const parseError = result.errors.find((e) => e.code === "PAR001");
      expect(parseError).toBeDefined();
      expect(parseError?.message).toContain(
        "Missing table or subquery after FROM",
      );
      expect(parseError?.position.startLine).toBe(7);
      expect(parseError?.position.startColumn).toBeGreaterThan(10);
    });

    it("should allow FOR range loops with variable bounds inside procedures", () => {
      const validator = new SqlValidator();
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE test_proc()
RETURNS INTEGER
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
X INTEGER;
Y INTEGER;
BEGIN
X := 10;
Y := 20;
FOR i IN X..Y LOOP
    RETURN i;
END LOOP;
END;
END_PROC;`);

      expect(result.errors.find((e) => e.code === "PAR001")).toBeUndefined();
    });

    it("should allow OF as table alias inside procedure SQL", () => {
      const validator = new SqlValidator();
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE SOME_NAME()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
INSERT INTO JUST_DATA..DIMDATE(DATEKEY)
SELECT 1
FROM
    ( SELECT DISTINCT 10 AS COL1 FROM DIMDATE
    ) AS S
    JOIN JUST_DATA..DIMEMPLOYEE E ON E.EMPLOYEEKEY = S.COL1
    LEFT JOIN JUST_DATA..DIMACCOUNT OF ON OF.ACCOUNTKEY = E.EMPLOYEEKEY;

RETURN 1;
END;
END_PROC;`);

      expect(result.errors.find((e) => e.code === "PAR001")).toBeUndefined();
    });

    it("should keep Netezza parser errors for DB2-only DDL under strict validation", () => {
      const validator = new SqlValidator();
      const result = validator.validate(`CREATE TABLE DB2INST1.PRODUCTS (
    PRODUCT_ID INTEGER NOT NULL,
    PRODUCT_NAME VARCHAR(100) NOT NULL,
    CATEGORY VARCHAR(50),
    PRICE DECIMAL(10,2)
)
ORGANIZE BY ROW IN USERSPACE1
COMPRESS NO;`);

      expect(result.errors.some((e) => e.code === "PAR001")).toBe(true);
    });

    it("should suppress parser errors for DB2-only DDL under best-effort DB2 validation", () => {
      const validator = new SqlValidator(undefined, db2SqlAuthoring.validation);
      const result = validator.validate(`CREATE TABLE DB2INST1.PRODUCTS (
PRODUCT_ID INTEGER NOT NULL,
PRODUCT_NAME VARCHAR(100) NOT NULL,
CATEGORY VARCHAR(50),
PRICE DECIMAL(10,2)
)
ORGANIZE BY ROW IN USERSPACE1
COMPRESS NO;`);

      expect(result.errors.some((e) => e.code === "PAR001")).toBe(false);
    });

    it("should not report lexer errors for Netezza DB..TABLE aliases", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM JUST_DATA..DIMACCOUNT a",
      );

      expect(result.errors.find((e) => e.code === "LEX001")).toBeUndefined();
    });

    it("should not report PAR001 for CTE-backed IN subqueries inside DELETE predicates", () => {
      const validator = new SqlValidator();
      const result = validator.validate(`DELETE FROM JUST_DATA..DIMACCOUNT A
WHERE A.ACCOUNTCODEALTERNATEKEY IN
(
    WITH TTT AS
    (SELECT 1 AS ACCOUNTCODEALTERNATEKEY)
    SELECT ACCOUNTCODEALTERNATEKEY FROM TTT
)`);

      expect(result.errors.find((e) => e.code === "PAR001")).toBeUndefined();
    });

    it("should not report PAR001 for UPDATE...SET...FROM syntax (Netezza/T-SQL)", () => {
      const validator = new SqlValidator();
      const result = validator.validate(`UPDATE JUST_DATA..DIMACCOUNT DA
SET DA.ACCOUNTKEY = F.ACCOUNTKEY
FROM
(
    SELECT 1 AS ACCOUNTKEY FROM JUST_DATA..DIMACCOUNT
) F
WHERE F.ACCOUNTKEY = 1;`);

      expect(result.errors.find((e) => e.code === "PAR001")).toBeUndefined();
      expect(result.errors.find((e) => e.code === "SQL003")).toBeUndefined();
    });
  });

  describe("validate with semantic errors", () => {
    it("should report semantic errors separately from syntax errors", () => {
      const schema = createMockSchemaProvider([
        {
          database: "TESTDB",
          schema: "PUBLIC",
          name: "EMPLOYEES",
          columns: ["ID", "NAME"],
        },
      ]);
      const validator = new SqlValidator(schema);

      const result = validator.validate(
        "SELECT ID, NONEXISTENT FROM TESTDB..EMPLOYEES",
      );

      const syntaxErrors = result.errors.filter(
        (e) => e.code.startsWith("PAR") || e.code.startsWith("LEX"),
      );
      const semanticErrors = result.errors.filter((e) =>
        e.code.startsWith("SQL"),
      );

      expect(syntaxErrors.length).toBe(0);
      expect(semanticErrors.length).toBeGreaterThan(0);
    });

    it("should report SQL020 when subquery in FROM has no alias", () => {
      const validator = new SqlValidator();
      const result = validator.validate("SELECT * FROM (SELECT 1);");

      expect(result.errors.some((e) => e.code === "SQL020")).toBe(true);
    });

    it("should allow subquery in FROM with alias", () => {
      const validator = new SqlValidator();
      const result = validator.validate("SELECT * FROM (SELECT 1) S;");

      expect(result.errors.some((e) => e.code === "SQL020")).toBe(false);
    });
  });

  describe("validate warnings", () => {
    it("should separate warnings from errors", () => {
      const schema = createMockSchemaProvider([
        {
          database: "TESTDB",
          schema: "PUBLIC",
          name: "EMPLOYEES",
          columns: ["ID", "NAME"],
        },
      ]);
      const validator = new SqlValidator(schema);

      const result = validator.validate(
        "SELECT ID, NAME FROM TESTDB..EMPLOYEES",
      );

      expect(result.errors).toBeDefined();
      expect(result.warnings).toBeDefined();
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it("should report SQL018 warning for unused CTE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "WITH UNUSED_CTE AS (SELECT 1 AS ID) SELECT 1;",
      );

      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some((w) => w.code === "SQL018")).toBe(true);
    });

    it("should report SQL019 warning for unused table alias", () => {
      const validator = new SqlValidator();
      const result = validator.validate("SELECT * FROM TESTDB..EMPLOYEES E;");

      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some((w) => w.code === "SQL019")).toBe(true);
    });

    it("should report SQL027 for JOIN without ON or USING", () => {
      const validator = new SqlValidator();
      const sql = `SELECT A.ACCOUNTCODEALTERNATEKEY, B.ID FROM JUST_DATA..DIMACCOUNT A
JOIN JUST_DATA.ADMIN.DEPARTMENT B`;
      const result = validator.validate(sql);

      expect(result.errors.some((e) => e.code === "SQL027")).toBe(true);
    });

    it("should not report SQL019 when alias is used with keyword-token column names", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          schema: "PUBLIC",
          name: "TST",
          columns: ["HASH", "SUM", "MATERIALIZED"],
        },
      ]);
      const validator = new SqlValidator(schema);

      const result = validator.validate(
        "SELECT MATERIALIZED, D.HASH, D.SUM, D.MATERIALIZED FROM JUST_DATA..TST D;",
      );

      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some((w) => w.code === "SQL019")).toBe(false);
    });
  });

  describe("SQL021: aggregate in WHERE clause", () => {
    it("should report error for SUM in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM DIMACCOUNT A WHERE SUM(A.ACCOUNTCODEALTERNATEKEY) > 0",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should report error for COUNT in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE COUNT(*) > 0",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should report error for AVG in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE AVG(X) > 5",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should report error for MIN in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE MIN(X) < 10",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should report error for MAX in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE MAX(X) > 100",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should not report error for aggregate in HAVING", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT A, SUM(B) FROM T GROUP BY A HAVING SUM(B) > 0",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(false);
    });

    it("should not report error for aggregate in subquery within WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE X > (SELECT SUM(Y) FROM T2)",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(false);
    });

    it("should not report SQL021 for window function in IN subquery WITH clause", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        `SELECT * FROM JUST_DATA..DIMDATE D
WHERE D.DATEKEY IN
(
    WITH ABC AS (
        SELECT DATEKEY, ROW_NUMBER() OVER (PARTITION BY DATEKEY ORDER BY DATEKEY DESC) AS NR
        FROM JUST_DATA..DIMDATE
    )
    SELECT * FROM ABC WHERE NR = 1
)`,
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(false);
    });

    it("should still report SQL021 for aggregate in WHERE inside IN subquery", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE X IN (SELECT Y FROM T2 WHERE SUM(Z) > 0)",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should not report error for aggregate in SELECT", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT SUM(B) FROM T",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(false);
    });

    it("should warn when numeric column is compared to string literal", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          schema: "ADMIN",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTCODEALTERNATEKEY", dataType: "INTEGER" },
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT * FROM JUST_DATA..DIMACCOUNT X WHERE X.ACCOUNTCODEALTERNATEKEY = 'A'",
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn for DIMACCOUNT integer key compared to string literal AAA", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTCODEALTERNATEKEY", dataType: "INTEGER" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT * FROM JUST_DATA..DIMACCOUNT A WHERE A.ACCOUNTCODEALTERNATEKEY =  'AAA'",
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn when text column is compared to numeric literal with ordered operator", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          schema: "ADMIN",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT * FROM JUST_DATA..DIMACCOUNT X WHERE X.ACCOUNTDESCRIPTION > 5",
      );

      expect(result.warnings.some((w) => w.code === "SQL026")).toBe(true);
    });

    it("should warn when numeric column is compared to text column in JOIN ON", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTCODEALTERNATEKEY", dataType: "INTEGER" },
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        `SELECT A.ACCOUNTCODEALTERNATEKEY, A2.ACCOUNTDESCRIPTION
FROM DIMACCOUNT A
JOIN DIMACCOUNT A2 ON A.ACCOUNTCODEALTERNATEKEY = A2.ACCOUNTDESCRIPTION`,
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn when numeric column compared to text column via CTE", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTCODEALTERNATEKEY", dataType: "INTEGER" },
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        `WITH CTE1 AS (
    SELECT A.ACCOUNTDESCRIPTION FROM DIMACCOUNT A
)
SELECT * FROM CTE1 C
JOIN DIMACCOUNT X ON X.ACCOUNTCODEALTERNATEKEY = C.ACCOUNTDESCRIPTION`,
      );
      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn when text column is compared to numeric column with ordered operator", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTCODEALTERNATEKEY", dataType: "INTEGER" },
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT * FROM JUST_DATA..DIMACCOUNT A WHERE A.ACCOUNTDESCRIPTION > A.ACCOUNTCODEALTERNATEKEY",
      );

      expect(result.warnings.some((w) => w.code === "SQL026")).toBe(true);
    });

    it("should not warn when text column is compared to explicitly cast numeric literal", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT 5 FROM JUST_DATA..DIMACCOUNT A WHERE A.ACCOUNTDESCRIPTION = 1::NVARCHAR(32)",
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(false);
    });

    it("should not warn when text column is compared to CAST numeric literal", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT 5 FROM JUST_DATA..DIMACCOUNT A WHERE A.ACCOUNTDESCRIPTION = CAST(1 AS NVARCHAR(32))",
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(false);
    });

    it("should still warn when subquery contains cast but outer literal is uncast", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT 5 FROM JUST_DATA..DIMACCOUNT A WHERE A.ACCOUNTDESCRIPTION = 1 + (SELECT 2::NVARCHAR(32) FROM JUST_DATA..DIMACCOUNT)",
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn when text column is used in arithmetic expression with numeric literal", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT DA.ACCOUNTDESCRIPTION + 5 FROM JUST_DATA..DIMACCOUNT DA",
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn when text column is used in multiplicative expression with numeric literal", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT DA.ACCOUNTDESCRIPTION * 5 FROM JUST_DATA..DIMACCOUNT DA",
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn when numeric column and text column used together in arithmetic", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTCODEALTERNATEKEY", dataType: "INTEGER" },
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT A.ACCOUNTCODEALTERNATEKEY + A.ACCOUNTDESCRIPTION FROM JUST_DATA..DIMACCOUNT A",
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn when numeric literal and string literal used together in arithmetic", () => {
      const result = new SqlValidator().validate("SELECT 1 + 'x'");
      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn when numeric literal is compared to string literal", () => {
      const result = new SqlValidator().validate("SELECT 1 = 'x'");
      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn when numeric literal is compared to text column", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT 1 = A.ACCOUNTDESCRIPTION FROM JUST_DATA..DIMACCOUNT A",
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(true);
    });

    it("should warn when string literal is compared to numeric column with ordered operator", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTCODEALTERNATEKEY", dataType: "INTEGER" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT 'x' > A.ACCOUNTCODEALTERNATEKEY FROM JUST_DATA..DIMACCOUNT A",
      );

      expect(result.warnings.some((w) => w.code === "SQL026")).toBe(true);
    });

    it("should not warn when numeric column is used in arithmetic expression with numeric literal", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTCODEALTERNATEKEY", dataType: "INTEGER" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT DA.ACCOUNTCODEALTERNATEKEY + 5 FROM JUST_DATA..DIMACCOUNT DA",
      );

      expect(result.warnings.some((w) => w.code === "SQL025")).toBe(false);
    });

    it("should report multiple errors for multiple aggregates in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE SUM(X) > 0 AND COUNT(Y) > 1",
      );

      const aggErrors = result.errors.filter((e) => e.code === "SQL021");
      expect(aggErrors.length).toBeGreaterThanOrEqual(2);
    });

    it("should not report error for multi-arg MIN in WHERE (scalar function)", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE MIN(A, B, C) > 0",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(false);
    });

    it("should report error for single-arg MIN in WHERE (aggregate)", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE MIN(A) > 0",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should not report error for multi-arg MAX in WHERE (scalar function)", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE MAX(A, B, C) > 0",
      );

      expect(result.errors.some((e) => e.code === "SQL021")).toBe(false);
    });

    it("should report error for STDDEV in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE STDDEV(X) > 5",
      );
      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should report error for VARIANCE in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE VARIANCE(X) > 5",
      );
      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should report error for ROW_NUMBER in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE ROW_NUMBER() OVER (ORDER BY X) > 0",
      );
      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should report error for RANK in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE RANK() OVER (ORDER BY X) > 0",
      );
      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should report error for DENSE_RANK in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE DENSE_RANK() OVER (ORDER BY X) > 0",
      );
      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should report error for LAG in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE LAG(X) OVER (ORDER BY Y) > 0",
      );
      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });

    it("should report error for LEAD in WHERE", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM T WHERE LEAD(X) OVER (ORDER BY Y) > 0",
      );
      expect(result.errors.some((e) => e.code === "SQL021")).toBe(true);
    });
  });

  describe("SQL028-SQL030 grouped query validation", () => {
    const sql028Diagnostics = (result: ReturnType<SqlValidator["validate"]>) =>
      [...result.errors, ...result.warnings].filter((e) => e.code === "SQL028");

    it("should report SQL028 when non-aggregated column missing from GROUP BY", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT REGION, SUM(AMOUNT) FROM SALES GROUP BY REGION_ID",
      );
      const diagnostic = sql028Diagnostics(result)[0];
      expect(diagnostic?.severity).toBe("information");
      expect(diagnostic?.message).toContain("Possibly");
    });

    it("should report SQL028 for aliased non-aggregated column missing from GROUP BY", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT REGION AS R, SUM(AMOUNT) FROM SALES GROUP BY REGION_ID",
      );
      const diagnostic = sql028Diagnostics(result)[0];
      expect(diagnostic?.severity).toBe("information");
      expect(diagnostic?.message).toContain("Possibly");
    });

    it("should not report SQL028 when GROUP BY uses select-list ordinal", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        `SELECT
    A.ACCOUNTCODEALTERNATEKEY
    , COUNT(1)
 FROM DIMACCOUNT A
GROUP BY 1`,
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should not report SQL028 for literals in SELECT with ordinal GROUP BY", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        `SELECT
    DA.ACCOUNTTYPE
    , 'LITERAL'
    , COUNT(DA.ACCOUNTCODEALTERNATEKEY)
    , 2 AMOTHER_LITERAL
 FROM JUST_DATA..DIMACCOUNT DA
GROUP BY 1`,
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should not report SQL028 for literals in SELECT with column GROUP BY", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        `SELECT
    DA.ACCOUNTTYPE
    , 'LITERAL'
    , COUNT(DA.ACCOUNTCODEALTERNATEKEY)
    , 2 AMOTHER_LITERAL
 FROM JUST_DATA..DIMACCOUNT DA
GROUP BY DA.ACCOUNTTYPE`,
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should not report SQL028 for expressions derived from grouped column", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        `SELECT
    TO_CHAR(D.DATEKEY,'YYYYMMDD') AS COL1
    , D.DATEKEY || 'X' AS COL2
    , D.DATEKEY * 5 AS COL3
    , MAX(D.ENGLISHDAYNAMEOFWEEK)
 FROM JUST_DATA..DIMDATE D
GROUP BY D.DATEKEY`,
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should not report SQL028 for expressions derived from multiple grouped columns", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        `SELECT
    D.DATEKEY
    , D.DAYNUMBEROFMONTH
    , D.DATEKEY || D.DAYNUMBEROFMONTH
 FROM JUST_DATA..DIMDATE D
GROUP BY D.DATEKEY, D.DAYNUMBEROFMONTH`,
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should not report SQL028 for select-list aliases derived from grouped columns", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        `SELECT
    D.DATEKEY AS COL1
    , D.DAYNUMBEROFWEEK AS COL2
    , D.ENGLISHDAYNAMEOFWEEK AS COL3
    , COL3 AS KOLUMNA_WTORNA1
    , NVL(COL2 - COL1, 0) AS KOLUMNA_WTORNA2
    , COUNT(1)
 FROM JUST_DATA..DIMDATE D
GROUP BY D.DATEKEY, D.DAYNUMBEROFWEEK, D.ENGLISHDAYNAMEOFWEEK`,
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should not report SQL028 for window functions in SELECT with GROUP BY", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        `SELECT
     A.ACCOUNTCODEALTERNATEKEY
     , A.ACCOUNTTYPE
     , ROW_NUMBER() OVER (PARTITION BY A.ACCOUNTTYPE ORDER BY A.ACCOUNTCODEALTERNATEKEY) AS NR
  FROM JUST_DATA..DIMACCOUNT A
 GROUP BY A.ACCOUNTCODEALTERNATEKEY
 , A.ACCOUNTTYPE`,
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should not report SQL028 for CURRENT_DATE with aggregate (no GROUP BY)", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT MIN(A.ACCOUNTCODEALTERNATEKEY), CURRENT_DATE FROM DIMACCOUNT A",
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should not report SQL028 for CURRENT_TIMESTAMP with aggregate (no GROUP BY)", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT MIN(A.ACCOUNTCODEALTERNATEKEY), CURRENT_TIMESTAMP FROM DIMACCOUNT A",
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should not report SQL028 for TO_CHAR(CURRENT_DATE,...) with aggregate (no GROUP BY)", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT MIN(A.ACCOUNTCODEALTERNATEKEY), TO_CHAR(CURRENT_DATE,'YYYYMMDD') FROM DIMACCOUNT A",
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should not report SQL028 for CURRENT_DATE with aggregate and GROUP BY", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        `SELECT A.ACCOUNTTYPE, CURRENT_DATE, COUNT(A.ACCOUNTCODEALTERNATEKEY)
  FROM JUST_DATA..DIMACCOUNT A
 GROUP BY A.ACCOUNTTYPE`,
      );
      expect(sql028Diagnostics(result)).toHaveLength(0);
    });

    it("should still report SQL028 for non-deterministic column with aggregate", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT MIN(A.ACCOUNTCODEALTERNATEKEY), A.ACCOUNTTYPE FROM DIMACCOUNT A",
      );
      expect(sql028Diagnostics(result)[0]?.severity).toBe("information");
    });

    it("should report SQL028 for TO_CHAR(COLUMN,...) with aggregate (column is not session constant)", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT MIN(A.ACCOUNTCODEALTERNATEKEY), TO_CHAR(A.ACCOUNTTYPE,'YYYYMMDD') FROM DIMACCOUNT A",
      );
      expect(sql028Diagnostics(result)[0]?.severity).toBe("information");
    });

    it("should report SQL029 for INSERT column/value count mismatch", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "INSERT INTO T (A, B) VALUES (1)",
      );
      expect(result.errors.some((e) => e.code === "SQL029")).toBe(true);
    });

    it("should report SQL030 when ORDER BY is not grouped", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT REGION, SUM(AMOUNT) FROM SALES GROUP BY REGION ORDER BY REGION_ID",
      );
      expect(result.warnings.some((e) => e.code === "SQL030")).toBe(true);
    });
  });

  describe("SQL006 table existence validation", () => {
    it("should report SQL006 for qualified non-existent table (DB..TABLE)", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTCODEALTERNATEKEY", dataType: "INTEGER" },
            { name: "ACCOUNTDESCRIPTION", dataType: "VARCHAR(100)" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT * FROM JUST_DATA..NO_SUCH_TABLE",
      );
      expect(result.errors.some((e) => e.code === "SQL006")).toBe(true);
    });

    it("should report SQL006 for qualified non-existent table (DB.SCHEMA.TABLE)", () => {
      const schema = createMockSchemaProvider([
        {
          database: "JUST_DATA",
          schema: "ADMIN",
          name: "DIMACCOUNT",
          columns: [
            { name: "ACCOUNTCODEALTERNATEKEY", dataType: "INTEGER" },
          ],
        },
      ]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT * FROM JUST_DATA.ADMIN.NO_SUCH_TABLE",
      );
      expect(result.errors.some((e) => e.code === "SQL006")).toBe(true);
    });

    it("should report SQL006 for unqualified non-existent table with strict schema provider", () => {
      const schema = new InMemorySchemaProvider(true);
      schema.createTable(undefined, undefined, "EXISTING_TABLE", ["ID"]);
      const validator = new SqlValidator(schema);
      const result = validator.validate(
        "SELECT * FROM NO_SUCH_TABLE",
      );
      expect(result.errors.some((e) => e.code === "SQL006")).toBe(true);
    });

    it("should not report SQL006 for unqualified non-existent table with default schema provider", () => {
      const validator = new SqlValidator();
      const result = validator.validate(
        "SELECT * FROM NO_SUCH_TABLE",
      );
      expect(result.errors.some((e) => e.code === "SQL006")).toBe(false);
    });
  });

  describe("singleton instance", () => {
    it("should export a singleton validator instance", () => {
      expect(sqlValidator).toBeDefined();
      expect(sqlValidator).toBeInstanceOf(SqlValidator);
    });
  });
});
