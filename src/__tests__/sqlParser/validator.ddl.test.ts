// Don't mock chevrotain - we need the real parser for these tests
import { describe, expect, it, jest } from "@jest/globals";

jest.unmock("chevrotain");

import { SqlValidator } from "../../sqlParser/validator";
import { type SchemaProvider } from "../../sqlParser/schemaProvider";
import {
  expectErrorCode,
  expectSyntaxError,
  expectValid,
  expectWarningCode,
  setupSqlValidatorTests,
  validator,
} from "./validator.test.shared";

/**
 * DDL validation tests extracted from sqlValidator.test.ts.
 * Covers CREATE TABLE, CTAS, CREATE VIEW, ALTER, DROP, and related DDL.
 */
describe("SQL Validator - DDL tests", () => {
  setupSqlValidatorTests();

  // ========================================================================
  // CREATE TABLE DDL (column definitions)
  // ========================================================================
  describe("CREATE TABLE DDL — valid syntax", () => {
    it("should validate CREATE TABLE with multiple column types", () => {
      expectValid(`CREATE TABLE MY_TABLE (
    ID INT4,
    NAME VARCHAR(100),
    AMOUNT NUMERIC(12,2),
    FLAG BOOLEAN,
    CREATED DATE
) DISTRIBUTE ON (ID);`);
    });

    it("should validate CREATE TABLE with all Netezza integer types", () => {
      expectValid(`CREATE TABLE INT_TYPES (
    C1 INT1,
    C2 BYTEINT,
    C3 INT2,
    C4 SMALLINT,
    C5 INT4,
    C6 INTEGER,
    C7 INT8,
    C8 BIGINT
);`);
    });

    it("should validate CREATE TABLE with float types", () => {
      expectValid(`CREATE TABLE FLOAT_TYPES (
    C1 FLOAT4,
    C2 REAL,
    C3 FLOAT8,
    C4 DOUBLE PRECISION,
    C5 FLOAT
);`);
    });

    it("should validate CREATE TABLE with NCHAR/NVARCHAR types", () => {
      expectValid(`CREATE TABLE NCHAR_TYPES (
    C1 NCHAR(10),
    C2 NVARCHAR(200)
);`);
    });

    it("should validate SERIAL and BIGSERIAL types", () => {
      expectValid(`CREATE TABLE SERIAL_TYPES (
    ID SERIAL,
    BIG_ID BIGSERIAL
);`);
    });

    it("should validate CLOB/NCLOB/BLOB types", () => {
      expectValid(`CREATE TABLE LOB_TYPES (
    DATA CLOB(1000),
    NDATA NCLOB(500),
    RAW BLOB
);`);
    });

    it("should validate CREATE TABLE with DISTRIBUTE ON RANDOM", () => {
      expectValid("CREATE TABLE T1 (ID INT4) DISTRIBUTE ON RANDOM;");
    });

    it("should validate CREATE TABLE with DISTRIBUTE ON columns and ORGANIZE", () => {
      expectValid(
        "CREATE TABLE T1 (ID INT4, NAME VARCHAR(10)) DISTRIBUTE ON (ID) ORGANIZE ON (NAME);",
      );
    });

    it("should validate CREATE TEMP TABLE with DDL columns", () => {
      expectValid("CREATE TEMP TABLE TMP (ID INT4, VAL VARCHAR(50));");
    });

    it("should validate CREATE TEMPORARY TABLE", () => {
      expectValid("CREATE TEMPORARY TABLE TMP2 (ID INT8);");
    });

    it("should validate CREATE GLOBAL TEMP TABLE with DDL columns", () => {
      expectValid("CREATE GLOBAL TEMP TABLE GTT (ID INT4, DATA TEXT);");
    });
  });

  describe("CREATE TABLE DDL — errors", () => {
    it("should detect invalid data type", () => {
      expectErrorCode("CREATE TABLE T1 (ID FOOBARBAZ);", "SQL013");
    });

    it("should produce SQL045 for CTAS without explicit distribution", () => {
      expectWarningCode(
        "CREATE TABLE EMP_COPY AS SELECT * FROM TESTDB..EMPLOYEES;",
        "SQL045",
      );
    });

    it("should not produce SQL045 when CTAS has DISTRIBUTE ON", () => {
      const result = validator.validate(
        "CREATE TABLE EMP_COPY AS SELECT * FROM TESTDB..EMPLOYEES DISTRIBUTE ON RANDOM;",
      );
      expect(result.warnings.some((e) => e.code === "SQL045")).toBe(false);
    });

    it("should detect excess type parameters on fixed types", () => {
      expectErrorCode("CREATE TABLE T1 (ID INT4(10));", "SQL014");
    });

    it("should detect excess type parameters on VARCHAR", () => {
      expectErrorCode("CREATE TABLE T1 (C VARCHAR(10,2));", "SQL014");
    });

    it("should detect missing column name in DDL", () => {
      expectSyntaxError("CREATE TABLE T1 (INT4);");
    });

    it("should detect missing type in DDL", () => {
      expectSyntaxError("CREATE TABLE T1 (ID);");
    });

    it("should detect empty column definition list", () => {
      expectSyntaxError("CREATE TABLE T1 ();");
    });
  });

  // ========================================================================
  // CREATE TABLE AS (CTAS)
  // ========================================================================
  describe("CTAS — valid syntax", () => {
    it("should validate CTAS with parenthesized SELECT", () => {
      expectValid(
        "CREATE TABLE T_NEW AS (SELECT * FROM TESTDB..EMPLOYEES) DISTRIBUTE ON RANDOM;",
      );
    });

    it("should validate CTAS without parentheses", () => {
      expectValid(
        "CREATE TABLE T_NEW AS SELECT EMPLOYEE_ID, SALARY FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate CREATE TEMP TABLE AS", () => {
      expectValid("CREATE TEMP TABLE T_TMP AS (SELECT 1 AS COL);");
    });

    it("should validate CREATE TEMP TABLE AS WITH followed by SELECT from the new table", () => {
      expectValid(`CREATE TEMP TABLE TT1 AS
WITH BASE AS (
    SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES
)
SELECT * FROM BASE;
SELECT T.EMPLOYEE_ID, T.FIRST_NAME FROM TT1 T;`);
    });

    it("should validate CREATE TEMP TABLE AS WITH when unqualified relation existence checks are enabled", () => {
      const employeesTable = {
        name: "EMPLOYEES",
        database: "TESTDB",
        schema: "PUBLIC",
        isCte: false,
        isTempTable: false,
        columns: [{ name: "EMPLOYEE_ID" }, { name: "FIRST_NAME" }],
      };
      const strictSchemaProvider: SchemaProvider = {
        getTable: (database, _schema, tableName) => {
          if (
            database?.toUpperCase() === "TESTDB" &&
            tableName.toUpperCase() === "EMPLOYEES"
          ) {
            return employeesTable;
          }
          return undefined;
        },
        tableExists: (database, schema, tableName) =>
          !!strictSchemaProvider.getTable(database, schema, tableName),
        canValidateUnqualifiedTableReferences: () => true,
      };
      const strictValidator = new SqlValidator(strictSchemaProvider);

      const result = strictValidator.validate(`CREATE TEMP TABLE TT1 AS
WITH BASE AS (
    SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES
)
SELECT * FROM BASE;
SELECT T.EMPLOYEE_ID, T.FIRST_NAME FROM TT1 T;`);

      expect(result.errors).toHaveLength(0);
    });

    it("should not emit parser errors for parenthesized CTAS WITH followed by trailing alias dot", () => {
      const result = validator.validate(`CREATE TEMP TABLE TT1 AS
(
    WITH ABC1 AS (
        SELECT 1 AS JEDEN
    )
    SELECT JEDEN FROM ABC1
);

SELECT * FROM TT1 T
WHERE T.`);

      expect(result.errors.some((error) => error.code === "PAR001")).toBe(false);
    });

    it("should validate CTAS followed by SELECT from the new table", () => {
      expectValid(`CREATE TABLE SUMMARY AS (SELECT DEPARTMENT_ID, COUNT(*) AS CNT FROM TESTDB..EMPLOYEES GROUP BY DEPARTMENT_ID);
SELECT S.DEPARTMENT_ID FROM SUMMARY S;`);
    });

    it("should validate CTAS with LIMIT", () => {
      expectValid(
        "CREATE TABLE SAMPLE_EMP AS (SELECT * FROM TESTDB..EMPLOYEES LIMIT 100) DISTRIBUTE ON RANDOM;",
      );
    });
  });

  describe("CTAS — syntax errors", () => {
    it("should detect missing AS keyword in CTAS", () => {
      expectSyntaxError("CREATE TABLE T_NEW (SELECT 1 AS COL);");
    });

    it("should detect missing SELECT after AS in CTAS", () => {
      expectSyntaxError("CREATE TABLE T_NEW AS;");
    });
  });

  // ========================================================================
  // CREATE VIEW
  // ========================================================================
  describe("CREATE VIEW — valid syntax", () => {
    it("should validate CREATE VIEW AS SELECT", () => {
      expectValid(
        "CREATE VIEW V_EMP AS SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate CREATE OR REPLACE VIEW", () => {
      expectValid(
        "CREATE OR REPLACE VIEW V_EMP AS SELECT * FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate CREATE VIEW with qualified name", () => {
      expectValid("CREATE VIEW TESTDB.PUBLIC.V_EMP AS SELECT 1 AS X;");
    });

    it("should validate CREATE VIEW with explicit column aliases", () => {
      expectValid(
        "CREATE VIEW V_EMP (EMP_ID, EMP_NAME) AS SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate VIEW referenced in subsequent query", () => {
      expectValid(`CREATE VIEW V_ACTIVE_EMP AS SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES WHERE STATUS = 'A';
SELECT V.EMPLOYEE_ID FROM V_ACTIVE_EMP V;`);
    });

    it("should validate CREATE VIEW with parenthesized SELECT body", () => {
      expectValid(`CREATE VIEW TEST_VIEW AS
(
    SELECT * FROM TESTDB..EMPLOYEES
);`);
    });

    it("should validate CREATE MATERIALIZED VIEW with fully qualified name", () => {
      expectValid(`CREATE MATERIALIZED VIEW ADMIN.COLOR_CHECK_MV AS
SELECT d.EMPLOYEE_ID
FROM TESTDB..EMPLOYEES d;`);
    });

    it("should validate CREATE MATERIALIZED VIEW with parenthesized SELECT body", () => {
      expectValid(`CREATE MATERIALIZED VIEW ADMIN.COLOR_CHECK_MV AS
(
  SELECT d.EMPLOYEE_ID
  FROM TESTDB..EMPLOYEES d
);`);
    });
  });

  describe("CREATE VIEW — syntax errors", () => {
    it("should detect missing AS in CREATE VIEW", () => {
      expectSyntaxError("CREATE VIEW V_EMP SELECT 1;");
    });

    it("should detect missing SELECT after CREATE VIEW AS", () => {
      expectSyntaxError("CREATE VIEW V_EMP AS;");
    });

    it("should detect invalid CREATE VIEW alias list syntax", () => {
      expectSyntaxError("CREATE VIEW V_EMP (ID,) AS SELECT 1 AS ID;");
    });

    it("should detect malformed CREATE MATERIALIZED VIEW without query body", () => {
      expectSyntaxError("CREATE MATERIALIZED VIEW ADMIN.COLOR_CHECK_MV AS;");
    });
  });

  // ========================================================================
  // DROP / TRUNCATE / EXPLAIN
  // ========================================================================
  describe("DROP — valid syntax", () => {
    it("should validate DROP TABLE", () => {
      expectValid("DROP TABLE TESTDB.PUBLIC.EMPLOYEES;");
    });

    it("should validate DROP TABLE IF EXISTS", () => {
      expectValid("DROP TABLE TESTDB.PUBLIC.EMPLOYEES IF EXISTS;");
    });

    it("should validate DROP TABLE with multiple targets", () => {
      expectValid(
        "DROP TABLE TESTDB.PUBLIC.EMPLOYEES, TESTDB.PUBLIC.DEPARTMENTS IF EXISTS;",
      );
    });

    it("should validate DROP VIEW", () => {
      expectValid("DROP VIEW V_EMP;");
    });

    it("should validate DROP PROCEDURE", () => {
      expectValid("DROP PROCEDURE MY_PROC;");
    });

    it("should validate DROP DATABASE", () => {
      expectValid("DROP DATABASE OLD_DB;");
    });

    it("should validate DROP SEQUENCE", () => {
      expectValid("DROP SEQUENCE TESTDB.PUBLIC.SEQ_1;");
    });

    it("should validate DROP SYNONYM", () => {
      expectValid("DROP SYNONYM TESTDB.PUBLIC.SYN_1;");
    });
  });

  describe("CREATE SYNONYM — valid syntax", () => {
    it("should validate CREATE SYNONYM with fully qualified target", () => {
      expectValid("CREATE SYNONYM JUST_DATA.ADMIN.DIMDATE_AAA FOR JUST_DATA_2.ADMIN.DIMDATE;");
    });

    it("should validate CREATE SYNONYM with schema-qualified name", () => {
      expectValid("CREATE SYNONYM ADMIN.MY_SYN FOR OTHER_SCHEMA.MY_TABLE;");
    });

    it("should validate CREATE SYNONYM with unqualified target", () => {
      expectValid("CREATE SYNONYM MY_SYN FOR MY_TABLE;");
    });

    it("should validate CREATE SYNONYM with DB..TABLE target", () => {
      expectValid("CREATE SYNONYM DB1.SCH1.SYN1 FOR DB2..TAB2;");
    });
  });

  describe("DROP — syntax errors", () => {
    it("should detect incomplete DROP TABLE IF (missing EXISTS)", () => {
      expectSyntaxError("DROP TABLE T1 IF;");
    });

    it("should detect missing object name in DROP TABLE", () => {
      expectSyntaxError("DROP TABLE;");
    });
  });
  // ========================================================================
  // ALTER TABLE / ALTER objects
  // ========================================================================
  describe("ALTER — valid syntax", () => {
    it("should validate ALTER TABLE ADD CONSTRAINT PRIMARY KEY", () => {
      expectValid(
        "ALTER TABLE TESTDB.PUBLIC.EMPLOYEES ADD CONSTRAINT PK_EMP PRIMARY KEY (EMPLOYEE_ID);",
      );
    });

    it("should validate ALTER TABLE RENAME TO", () => {
      expectValid(
        "ALTER TABLE TESTDB.PUBLIC.EMPLOYEES RENAME TO EMPLOYEES_OLD;",
      );
    });

    it("should validate ALTER TABLE ADD COLUMN", () => {
      expectValid(
        "ALTER TABLE TESTDB.PUBLIC.EMPLOYEES ADD COLUMN EMAIL VARCHAR(200);",
      );
    });

    it("should validate ALTER TABLE DROP COLUMN CASCADE", () => {
      expectValid(
        "ALTER TABLE TESTDB.PUBLIC.EMPLOYEES DROP COLUMN STATUS CASCADE;",
      );
    });

    it("should validate ALTER TABLE with ORGANIZE ON", () => {
      expectValid(
        "ALTER TABLE TESTDB.PUBLIC.EMPLOYEES ADD COLUMN NOTE VARCHAR(100) ORGANIZE ON (EMPLOYEE_ID);",
      );
    });

    it("should validate ALTER TABLE MODIFY COLUMN", () => {
      expectValid(
        "ALTER TABLE TESTDB.PUBLIC.EMPLOYEES MODIFY COLUMN (EMAIL VARCHAR(500));",
      );
    });

    it("should validate ALTER TABLE SET PRIVILEGES TO", () => {
      expectValid(
        "ALTER TABLE TESTDB.PUBLIC.EMPLOYEES SET PRIVILEGES TO TESTDB.PUBLIC.EMPLOYEES;",
      );
    });

    it("should validate ALTER TABLE DROP multiple columns", () => {
      expectValid(
        "ALTER TABLE TESTDB.PUBLIC.EMPLOYEES DROP COLUMN STATUS, MIDDLE_NAME;",
      );
    });

    it("should validate ALTER TABLE DROP column without COLUMN keyword", () => {
      expectValid("ALTER TABLE TESTDB..EMPLOYEES DROP MIDDLE_NAME;");
    });

    it("should validate ALTER DATABASE OWNER TO", () => {
      expectValid("ALTER DATABASE TESTDB OWNER TO ADMIN;");
    });

    it("should validate ALTER SEQUENCE RESTART WITH", () => {
      expectValid("ALTER SEQUENCE TESTDB.PUBLIC.SEQ_1 RESTART WITH 1;");
    });

    it("should validate ALTER USER with PASSWORD", () => {
      expectValid("ALTER USER APP_USER WITH PASSWORD 'newpass';");
    });

    it("should validate ALTER VIEW RENAME TO", () => {
      expectValid("ALTER VIEW TESTDB.PUBLIC.V_EMP RENAME TO V_EMPLOYEES;");
    });
  });
  describe("DDL — additional valid patterns", () => {
    it("should validate CREATE TABLE with NOT NULL constraints", () => {
      expectValid(
        "CREATE TABLE TESTDB..NN_TABLE (ID INT4 NOT NULL, NAME VARCHAR(100) NOT NULL);",
      );
    });

    it("should validate CREATE TABLE with DEFAULT values", () => {
      expectValid(
        "CREATE TABLE TESTDB..DEF_TABLE (ID INT4 DEFAULT 0, STATUS VARCHAR(20) DEFAULT 'ACTIVE');",
      );
    });

    it("should validate CREATE TABLE with DEFAULT and NOT NULL together", () => {
      expectValid(
        "CREATE TABLE TESTDB..DEF_NN_TABLE (ID INT4 DEFAULT 1 NOT NULL, FLAG VARCHAR(5) NOT NULL DEFAULT 'Y');",
      );
    });

    it("should validate CREATE TABLE with named column constraint and INTERVAL qualifier", () => {
      expectValid(`CREATE TABLE NAME (
    CODE CHARACTER(5) CONSTRAINT FIRSTKEY PRIMARY KEY,
    TITLE CHARACTER VARYING(40) NOT NULL,
    DID DECIMAL(3) NOT NULL,
    DATE_PROD DATE,
    KIND CHAR(10),
    LEN INTERVAL HOUR TO MINUTE
);`);
    });

    it("should validate CREATE TABLE with named NOT NULL and DEFAULT constraints", () => {
      expectValid(
        "CREATE TABLE TESTDB..NAMED_CONSTRAINTS (ID INT4 CONSTRAINT NN_ID NOT NULL, FLAG CHAR(1) CONSTRAINT DF_FLAG DEFAULT 'Y');",
      );
    });

    it("should validate CREATE TABLE with functional DEFAULT expression", () => {
      expectValid(
        "CREATE TABLE TESTDB..DEF_FUNC_TABLE (CREATED_AT TIMESTAMP DEFAULT NOW(), CODE INT4 DEFAULT (1 + 2));",
      );
    });

    it("should validate CREATE TABLE with quoted functional DEFAULT expression", () => {
      expectValid(`CREATE TABLE JUST_DATA.ADMIN.TEST_TABLE
(
    TEST_COLUMN DATE DEFAULT "timestamp"('NOW(0)'::"VARCHAR")
) DISTRIBUTE ON (TEST_COLUMN);`);
    });

    it("should validate CREATE TEMP TABLE with columns", () => {
      expectValid("CREATE TEMP TABLE MY_TEMP (ID INT4, DATA VARCHAR(255));");
    });

    it("should validate CREATE TEMPORARY TABLE", () => {
      expectValid("CREATE TEMPORARY TABLE MY_TEMP2 (ID INT4);");
    });

    it("should validate CREATE TABLE with BIGINT type", () => {
      expectValid("CREATE TABLE TESTDB..BIG_TABLE (ID INT8, BIG_VAL BIGINT);");
    });

    it("should validate CREATE TABLE with BOOLEAN type", () => {
      expectValid(
        "CREATE TABLE TESTDB..BOOL_TABLE (ID INT4, IS_ACTIVE BOOLEAN, FLAG BOOL);",
      );
    });

    it("should validate CREATE TABLE with DATE and TIMESTAMP types", () => {
      expectValid(
        "CREATE TABLE TESTDB..DT_TABLE (ID INT4, CREATED_AT TIMESTAMP, BIRTH_DATE DATE, EVENT_TIME TIME);",
      );
    });

    it("should validate CREATE TABLE with NUMERIC precision and scale", () => {
      expectValid(
        "CREATE TABLE TESTDB..NUM_TABLE (ID INT4, AMOUNT NUMERIC(18, 4), RATE DECIMAL(5,2));",
      );
    });

    it("should validate CREATE TABLE with NCHAR and NVARCHAR", () => {
      expectValid(
        "CREATE TABLE TESTDB..UNICODE_TABLE (ID INT4, UNAME NCHAR(50), UDESC NVARCHAR(200));",
      );
    });

    it("should validate CREATE VIEW with simple SELECT", () => {
      expectValid(
        "CREATE VIEW TESTDB..EMP_VIEW AS SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate CREATE OR REPLACE VIEW", () => {
      expectValid(
        "CREATE OR REPLACE VIEW TESTDB..EMP_VIEW2 AS SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY > 0;",
      );
    });

    it("should validate DROP VIEW", () => {
      expectValid("DROP VIEW TESTDB..EMP_VIEW;");
    });

    it("should validate DROP TABLE IF EXISTS with schema", () => {
      expectValid("DROP TABLE TESTDB.PUBLIC.EMPLOYEES IF EXISTS;");
    });

    it("should validate CREATE SEQUENCE", () => {
      expectValid("CREATE SEQUENCE TESTDB..MY_SEQ;");
    });

    it("should validate DROP SEQUENCE", () => {
      expectValid("DROP SEQUENCE TESTDB..MY_SEQ;");
    });

    it("should validate ALTER TABLE ADD COLUMN", () => {
      expectValid(
        "ALTER TABLE TESTDB..EMPLOYEES ADD COLUMN MIDDLE_NAME VARCHAR(50);",
      );
    });

    it("should validate ALTER TABLE DROP COLUMN", () => {
      expectValid("ALTER TABLE TESTDB..EMPLOYEES DROP COLUMN MIDDLE_NAME;");
    });

    it("should validate ALTER TABLE RENAME COLUMN", () => {
      expectValid(
        "ALTER TABLE TESTDB..EMPLOYEES RENAME COLUMN FIRST_NAME TO GIVEN_NAME;",
      );
    });

    it("should validate ALTER TABLE RENAME TO", () => {
      expectValid("ALTER TABLE TESTDB..EMPLOYEES RENAME TO STAFF;");
    });

    it("should validate TRUNCATE TABLE", () => {
      expectValid("TRUNCATE TABLE TESTDB..EMPLOYEES;");
    });

    it("should validate TRUNCATE without TABLE keyword", () => {
      expectValid("TRUNCATE TESTDB..EMPLOYEES;");
    });
  });

  // ========================================================================
  // Additional DDL error cases
  // ========================================================================
  describe("DDL — additional syntax errors", () => {
    it("should detect CREATE TABLE without table name", () => {
      expectSyntaxError("CREATE TABLE (ID INT4);");
    });

    it("should detect CREATE TABLE without column definitions or AS", () => {
      expectSyntaxError("CREATE TABLE TESTDB..NEW_TABLE;");
    });

    it("should detect CREATE TABLE with missing column type", () => {
      expectSyntaxError(
        "CREATE TABLE TESTDB..NEW_TABLE (ID, NAME VARCHAR(100));",
      );
    });

    it("should detect CREATE VIEW without AS", () => {
      expectSyntaxError(
        "CREATE VIEW TESTDB..V SELECT * FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should detect DROP without object type", () => {
      expectSyntaxError("DROP TESTDB..EMPLOYEES;");
    });

    it("should detect ALTER TABLE without action", () => {
      expectSyntaxError("ALTER TABLE TESTDB..EMPLOYEES;");
    });
  });

  // ========================================================================
  // CTAS (CREATE TABLE AS SELECT) additional patterns
  // ========================================================================
  describe("CTAS — additional valid patterns", () => {
    it("should validate CTAS with complex SELECT", () => {
      expectValid(
        "CREATE TABLE TESTDB..SUMMARY AS SELECT DEPARTMENT_ID, COUNT(*) AS CNT, AVG(SALARY) AS AVG_SAL FROM TESTDB..EMPLOYEES GROUP BY DEPARTMENT_ID;",
      );
    });

    it("should validate CTAS with JOIN in SELECT", () => {
      expectValid(
        "CREATE TABLE TESTDB..EMP_DEPT AS SELECT E.FIRST_NAME, D.DEPARTMENT_NAME FROM TESTDB..EMPLOYEES E JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should validate CREATE TEMP TABLE AS SELECT", () => {
      expectValid(
        "CREATE TEMP TABLE TMP_DATA AS SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY > 1000;",
      );
    });

    it("should validate CTAS with DISTRIBUTE ON", () => {
      expectValid(
        "CREATE TABLE TESTDB..DIST_TABLE AS SELECT * FROM TESTDB..EMPLOYEES DISTRIBUTE ON (EMPLOYEE_ID);",
      );
    });
  });
  // ========================================================================
  // ALTER commands — additional patterns
  // ========================================================================
  // ====================================================================
  // ALTER TABLE RENAME TO — script scope awareness
  // ====================================================================
  describe("ALTER TABLE RENAME TO — script scope awareness", () => {
    it("should allow DROP of a table that was created via RENAME TO in the same script", () => {
      expectValid(`CREATE TABLE JUST_DATA.ADMIN.SOME_NEW_NAME
(
    ACCOUNTKEY INTEGER,
    PARENTACCOUNTKEY INTEGER
)
DISTRIBUTE ON RANDOM;

INSERT INTO JUST_DATA.ADMIN.SOME_NEW_NAME SELECT * FROM JUST_DATA.ADMIN.DIMACCOUNT;

ALTER TABLE JUST_DATA.ADMIN.SOME_NEW_NAME SET PRIVILEGES TO JUST_DATA.ADMIN.DIMACCOUNT;

ALTER TABLE JUST_DATA.ADMIN.DIMACCOUNT RENAME TO SOME_NEW_NAME_BACKUP_U4N8O;
ALTER TABLE JUST_DATA.ADMIN.SOME_NEW_NAME RENAME TO DIMACCOUNT;

ALTER TABLE JUST_DATA.ADMIN.DIMACCOUNT OWNER TO ADMIN;

DROP TABLE JUST_DATA.ADMIN.SOME_NEW_NAME_BACKUP_U4N8O;`);
    });

    it("should allow ALTER TABLE OWNER TO on a table renamed from a script-created table", () => {
      expectValid(`CREATE TABLE JUST_DATA.ADMIN.TEST1 (ID INT4) DISTRIBUTE ON RANDOM;
ALTER TABLE JUST_DATA.ADMIN.TEST1 RENAME TO TEST2;
ALTER TABLE JUST_DATA.ADMIN.TEST2 OWNER TO ADMIN;`);
    });

    it("should allow DROP of a table renamed from a script-created table", () => {
      expectValid(`CREATE TABLE JUST_DATA.ADMIN.MYT1 (ID INT4) DISTRIBUTE ON RANDOM;
ALTER TABLE JUST_DATA.ADMIN.MYT1 RENAME TO MYT2;
DROP TABLE JUST_DATA.ADMIN.MYT2;`);
    });

    it("should detect non-existing table after rename when original was a real DB table", () => {
      const result = validator.validate(`ALTER TABLE JUST_DATA.ADMIN.DIMACCOUNT RENAME TO DIMACCOUNT_BACKUP;
DROP TABLE JUST_DATA.ADMIN.DIMACCOUNT_BACKUP;`);
      expect(result.errors).toHaveLength(0);
    });

    it("should detect error when dropping a non-existent renamed table (not created via rename in script)", () => {
      const result = validator.validate(`DROP TABLE JUST_DATA.ADMIN.NON_EXISTENT_RENAMED;`);
      expect(result.errors.some((e) => e.code === "SQL006")).toBe(true);
    });
  });

  describe("ALTER commands — additional patterns", () => {
    it("should validate ALTER TABLE ADD COLUMN with NOT NULL", () => {
      expectValid(
        "ALTER TABLE TESTDB..EMPLOYEES ADD COLUMN EMAIL VARCHAR(255) NOT NULL;",
      );
    });

    it("should validate ALTER TABLE DROP COLUMN", () => {
      expectValid("ALTER TABLE TESTDB..EMPLOYEES DROP COLUMN STATUS;");
    });

    it("should validate ALTER TABLE OWNER TO", () => {
      expectValid("ALTER TABLE TESTDB..EMPLOYEES OWNER TO ADMIN;");
    });

    it("should validate ALTER VIEW OWNER TO", () => {
      expectValid("ALTER VIEW TESTDB..EMP_VIEW OWNER TO ADMIN;");
    });

    it("should validate ALTER DATABASE RENAME TO", () => {
      expectValid("ALTER DATABASE TESTDB RENAME TO NEWDB;");
    });
  });
  // ====================================================================
  // CREATE TABLE IF NOT EXISTS
  // ====================================================================
  describe("CREATE TABLE IF NOT EXISTS — valid syntax", () => {
    it("should validate CREATE TABLE IF NOT EXISTS with columns", () => {
      expectValid(
        "CREATE TABLE IF NOT EXISTS my_table (id INTEGER, name VARCHAR(100))",
      );
    });

    it("should validate CREATE TEMP TABLE IF NOT EXISTS", () => {
      expectValid(
        "CREATE TEMP TABLE IF NOT EXISTS tmp_data (id INT, val FLOAT)",
      );
    });

    it("should validate CREATE TABLE IF NOT EXISTS with CTAS", () => {
      expectValid(
        "CREATE TABLE IF NOT EXISTS new_table AS SELECT * FROM old_table",
      );
    });
  });
  // ====================================================================
  // CREATE EXTERNAL TABLE with SAMEAS
  // ====================================================================
  describe("CREATE EXTERNAL TABLE — valid syntax", () => {
    it("should validate CREATE EXTERNAL TABLE with SAMEAS", () => {
      expectValid(
        "CREATE EXTERNAL TABLE ext_emp SAMEAS emp USING (DATAOBJECT ('/tmp/emp.dat'))",
      );
    });

    it("should validate CREATE EXTERNAL TABLE with schema-qualified SAMEAS", () => {
      expectValid(
        "CREATE EXTERNAL TABLE ext_emp SAMEAS myschema.emp USING (DATAOBJECT ('/tmp/emp.dat'))",
      );
    });

    it("should validate CREATE EXTERNAL TABLE with column definitions", () => {
      expectValid(
        "CREATE EXTERNAL TABLE ext_data (id INT, name VARCHAR(100)) USING (DATAOBJECT ('/tmp/data.csv') FORMAT TEXT)",
      );
    });

    it("should validate simple CREATE EXTERNAL TABLE", () => {
      expectValid("CREATE EXTERNAL TABLE ext_table SAMEAS source_table");
    });
  });

  describe("CREATE EXTERNAL TABLE — option and type validation", () => {
    it("should reject invalid external column data types", () => {
      expectErrorCode(
        `CREATE EXTERNAL TABLE ext_bad_types
(
    col1 WRONG_TYPE_INTEGER,
    col2 WRONG_TYPE_VARCHAR(10)
)
USING (DATAOBJECT ('/tmp/data.csv') FORMAT TEXT);`,
        "SQL013",
      );
    });

    it("should reject unknown external table option names", () => {
      const result = validator.validate(
        `CREATE EXTERNAL TABLE ext_bad_opts
(
    id INT4
)
USING (
    DATAOBJECT ('/tmp/data.csv')
    WRONG_OPTION_NAME 'abc'
    FORMAT TEXT
);`,
      );
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should reject invalid external table option values", () => {
      const result = validator.validate(
        `CREATE EXTERNAL TABLE ext_bad_values
(
    id INT4
)
USING (
    DATAOBJECT ('/tmp/data.csv')
    FORMAT 'BAD_FORMAT'
    QUOTEDVALUE 'MAYBE'
);`,
      );
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should validate external table with valid options and valid column types", () => {
      expectValid(
        `CREATE EXTERNAL TABLE ext_ok
(
    id INT4,
    name VARCHAR(20),
    created_at TIMESTAMP
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
    QUOTEDVALUE 'NO'
    NULLVALUE 'NULL'
    COMPRESS FALSE
    DATESTYLE 'YMD'
    DATEDELIM '-'
    TIMEDELIM ':'
    BOOLSTYLE '1_0'
    SOCKETBUFSIZE 8388608
    RECORDDELIM '\\n'
    DATETIMEDELIM ' '
);`,
      );
    });
  });
  // ====================================================================
  // DISTRIBUTE ON HASH
  // ====================================================================
  describe("DISTRIBUTE ON HASH — valid syntax", () => {
    it("should validate DISTRIBUTE ON HASH(col)", () => {
      expectValid(
        "CREATE TABLE t1 (id INT, name VARCHAR(50)) DISTRIBUTE ON HASH (id)",
      );
    });

    it("should validate DISTRIBUTE ON HASH with multiple columns", () => {
      expectValid(
        "CREATE TABLE t1 (id INT, name VARCHAR(50), dept INT) DISTRIBUTE ON HASH (id, dept)",
      );
    });

    it("should validate DISTRIBUTE ON RANDOM", () => {
      expectValid("CREATE TABLE t1 (id INT) DISTRIBUTE ON RANDOM");
    });

    it("should validate DISTRIBUTE ON without HASH keyword", () => {
      expectValid(
        "CREATE TABLE t1 (id INT, name VARCHAR(50)) DISTRIBUTE ON (id)",
      );
    });

    it("should validate ORGANIZE ON NONE", () => {
      expectValid(
        "CREATE TABLE t1 (id INT, event_date DATE) DISTRIBUTE ON RANDOM ORGANIZE ON NONE",
      );
    });
  });
  // ====================================================================
  // DROP variants — valid syntax
  // ====================================================================
  describe("DROP variants — valid syntax", () => {
    it("should validate DROP TABLE IF EXISTS", () => {
      expectValid("DROP TABLE my_table IF EXISTS");
    });

    it("should validate DROP TABLE multiple", () => {
      expectValid("DROP TABLE t1, t2, t3");
    });

    it("should validate DROP VIEW", () => {
      expectValid("DROP VIEW v1, v2");
    });

    it("should validate DROP SEQUENCE", () => {
      expectValid("DROP SEQUENCE my_seq");
    });

    it("should validate DROP SCHEMA CASCADE", () => {
      expectValid("DROP SCHEMA mydb.myschema CASCADE");
    });

    it("should validate DROP SCHEMA RESTRICT", () => {
      expectValid("DROP SCHEMA myschema RESTRICT");
    });

    it("should validate DROP SYNONYM", () => {
      expectValid("DROP SYNONYM my_syn");
    });

    it("should validate DROP SESSION", () => {
      expectValid("DROP SESSION 12345");
    });

    it("should validate DROP USER", () => {
      expectValid("DROP USER testuser");
    });

    it("should validate DROP EXTERNAL TABLE", () => {
      expectValid("DROP EXTERNAL TABLE ext_data");
    });

    it("should validate DROP PROCEDURE", () => {
      expectValid("DROP PROCEDURE my_proc");
    });

    it("should validate DROP DATABASE", () => {
      expectValid("DROP DATABASE test_db");
    });

    it("should validate DROP GROUP", () => {
      expectValid("DROP GROUP dev_team");
    });
  });
  describe("DDL — syntax errors (extended)", () => {
    it("should reject CREATE TABLE with missing column type", () => {
      expectSyntaxError("CREATE TABLE t (col1)");
    });

    it("should reject CREATE TABLE with unclosed parenthesis", () => {
      expectSyntaxError("CREATE TABLE t (id INT, name VARCHAR(100)");
    });

    it("should reject CREATE TABLE with duplicate comma", () => {
      expectSyntaxError("CREATE TABLE t (id INT,, name VARCHAR(100))");
    });
  });

  // ====================================================================
  // Constraint syntax — valid
  // ====================================================================
  describe("Constraints — valid syntax", () => {
    it("should validate table-level PRIMARY KEY constraint", () => {
      expectValid(
        "CREATE TABLE t (id INT, name VARCHAR(50), PRIMARY KEY (id))",
      );
    });

    it("should validate table-level UNIQUE constraint", () => {
      expectValid(
        "CREATE TABLE t (id INT, email VARCHAR(200), UNIQUE (email))",
      );
    });

    it("should validate table-level FOREIGN KEY constraint", () => {
      expectValid(
        "CREATE TABLE t (id INT, dept_id INT, FOREIGN KEY (dept_id) REFERENCES departments (id))",
      );
    });

    it("should validate CHECK constraint", () => {
      expectValid("CREATE TABLE t (id INT, age INT, CHECK (age > 0))");
    });

    it("should validate named CONSTRAINT prefix on column", () => {
      expectValid(
        "CREATE TABLE t (id INT CONSTRAINT pk_t PRIMARY KEY, name VARCHAR(100) NOT NULL)",
      );
    });

    it("should validate named table constraint", () => {
      expectValid(
        "CREATE TABLE t (id INT, name VARCHAR(50), CONSTRAINT pk_t PRIMARY KEY (id))",
      );
    });

    it("should validate REFERENCES column constraint (without FOREIGN KEY prefix)", () => {
      expectValid(
        "CREATE TABLE t (id INT, dept_id INT REFERENCES departments)",
      );
    });

    it("should validate column-level DEFAULT with NOT NULL together", () => {
      expectValid(
        "CREATE TABLE t (id INT NOT NULL, name VARCHAR(50) DEFAULT 'N/A' NOT NULL)",
      );
    });
  });
});
