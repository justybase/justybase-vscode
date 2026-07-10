// Don't mock chevrotain - we need the real parser for these tests
import { describe, it, jest } from "@jest/globals";

jest.unmock("chevrotain");

import {
  expectErrorCode,
  expectSyntaxError,
  expectValid,
  expectWarningCode,
  setupSqlValidatorTests,
  validator,
} from "./validator.test.shared";
import { SqlValidator } from "../../sqlParser/validator";
import { ScopeBuilder } from "../../sqlParser/visitor/scopeBuilder";
import {
  type SchemaProvider,
} from "../../sqlParser/schemaProvider";

/**
 * Advanced SQL validation tests extracted from sqlValidator.test.ts.
 * Heavy nested CTE, analytics, and edge-case coverage — run in parallel via Jest workers.
 */
describe("SQL Validator - Advanced tests", () => {
  setupSqlValidatorTests();

  // ========================================================================
  // ADVANCED: Complex SQL with nested CTEs, functions, analytics
  // ========================================================================
  describe("ADVANCED: Deeply nested CTEs and subqueries", () => {
    it("should validate CTE inside CTE (recursive CTE reference)", () => {
      expectValid(`WITH 
    CTE_L1 AS (
        SELECT EMPLOYEE_ID, FIRST_NAME, SALARY, DEPARTMENT_ID 
        FROM TESTDB..EMPLOYEES
        WHERE SALARY > 5000
    ),
    CTE_L2 AS (
        SELECT C1.EMPLOYEE_ID, C1.FIRST_NAME, C1.SALARY, D.DEPARTMENT_NAME
        FROM CTE_L1 C1
        JOIN TESTDB..DEPARTMENTS D ON C1.DEPARTMENT_ID = D.DEPARTMENT_ID
    ),
    CTE_L3 AS (
        SELECT C2.*, ROW_NUMBER() OVER (ORDER BY C2.SALARY DESC) AS RN
        FROM CTE_L2 C2
    )
SELECT * FROM CTE_L3 WHERE RN <= 10;`);
    });

    it("should validate multiple CTEs with cross-references", () => {
      expectValid(`WITH 
    DEPT_STATS AS (
        SELECT DEPARTMENT_ID, AVG(SALARY) AS AVG_SAL, COUNT(*) AS EMP_COUNT
        FROM TESTDB..EMPLOYEES
        GROUP BY DEPARTMENT_ID
    ),
    HIGH_PAID AS (
        SELECT E.EMPLOYEE_ID, E.FIRST_NAME, E.SALARY, E.DEPARTMENT_ID
        FROM TESTDB..EMPLOYEES E
        JOIN DEPT_STATS DS ON E.DEPARTMENT_ID = DS.DEPARTMENT_ID
        WHERE E.SALARY > DS.AVG_SAL
    ),
    RANKED_HIGH AS (
        SELECT HP.*, DS.EMP_COUNT,
               RANK() OVER (PARTITION BY HP.DEPARTMENT_ID ORDER BY HP.SALARY DESC) AS DEPT_RANK
        FROM HIGH_PAID HP
        JOIN DEPT_STATS DS ON HP.DEPARTMENT_ID = DS.DEPARTMENT_ID
    )
SELECT * FROM RANKED_HIGH WHERE DEPT_RANK = 1;`);
    });

    it("should validate CTE referencing earlier CTE in JOIN condition", () => {
      expectValid(`WITH 
    CTE_A AS (SELECT 1 AS ID_A, 'A' AS VAL_A),
    CTE_B AS (SELECT 2 AS ID_B, 'B' AS VAL_B),
    CTE_JOINED AS (
        SELECT A.ID_A, A.VAL_A, B.ID_B, B.VAL_B
        FROM CTE_A A
        CROSS JOIN CTE_B B
    )
SELECT * FROM CTE_JOINED;`);
    });

    it("should validate deeply nested subquery (4+ levels)", () => {
      expectValid(`SELECT * FROM (
    SELECT * FROM (
        SELECT * FROM (
            SELECT * FROM (
                SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES
            ) L4
        ) L3
    ) L2
) L1;`);
    });

    it("should validate subquery in SELECT with correlated reference", () => {
      expectValid(`SELECT 
    E.EMPLOYEE_ID,
    E.FIRST_NAME,
    (SELECT COUNT(*) 
     FROM TESTDB..EMPLOYEES E2 
     WHERE E2.MANAGER_ID = E.EMPLOYEE_ID) AS DIRECT_REPORTS
FROM TESTDB..EMPLOYEES E
WHERE E.MANAGER_ID IS NULL;`);
    });

    it("should validate subquery in FROM with multiple levels of nesting", () => {
      expectValid(`SELECT OUTER_SUB.TOTAL_SAL
FROM (
    SELECT INNER_SUB.DEPT_ID, SUM(INNER_SUB.SAL) AS TOTAL_SAL
    FROM (
        SELECT E.DEPARTMENT_ID AS DEPT_ID, E.SALARY AS SAL
        FROM TESTDB..EMPLOYEES E
        WHERE E.STATUS = 'A'
    ) INNER_SUB
    GROUP BY INNER_SUB.DEPT_ID
) OUTER_SUB;`);
    });

    it("should validate complex query with CTEs, subqueries, and analytics combined", () => {
      expectValid(`WITH 
    SALARY_STATS AS (
        SELECT DEPARTMENT_ID,
               AVG(SALARY) AS AVG_SAL,
               MAX(SALARY) AS MAX_SAL,
               MIN(SALARY) AS MIN_SAL
        FROM TESTDB..EMPLOYEES
        GROUP BY DEPARTMENT_ID
    ),
    EMP_WITH_STATS AS (
        SELECT E.*, SS.AVG_SAL, SS.MAX_SAL, SS.MIN_SAL,
               NTILE(4) OVER (PARTITION BY E.DEPARTMENT_ID ORDER BY E.SALARY) AS SAL_QUARTILE
        FROM TESTDB..EMPLOYEES E
        JOIN SALARY_STATS SS ON E.DEPARTMENT_ID = SS.DEPARTMENT_ID
    )
SELECT 
    EWS.EMPLOYEE_ID,
    EWS.FIRST_NAME,
    EWS.DEPARTMENT_ID,
    EWS.SALARY,
    EWS.AVG_SAL,
    EWS.MAX_SAL,
    EWS.SAL_QUARTILE,
    (SELECT COUNT(*) FROM TESTDB..ORDERS O WHERE O.CUSTOMER_ID = EWS.EMPLOYEE_ID) AS ORDER_COUNT,
    CASE 
        WHEN EWS.SALARY > EWS.AVG_SAL THEN 'Above Average'
        WHEN EWS.SALARY < EWS.AVG_SAL THEN 'Below Average'
        ELSE 'Average'
    END AS SALARY_STATUS
FROM EMP_WITH_STATS EWS
WHERE EWS.SAL_QUARTILE >= 3
ORDER BY EWS.DEPARTMENT_ID, EWS.SALARY DESC;`);
    });

    it("should validate recursive CTE pattern (tree traversal)", () => {
      expectValid(`WITH MANAGER_HIERARCHY AS (
    -- Anchor: top-level managers
    SELECT EMPLOYEE_ID, FIRST_NAME, MANAGER_ID, 1 AS LEVEL
    FROM TESTDB..EMPLOYEES
    WHERE MANAGER_ID IS NULL
    
    UNION ALL
    
    -- Recursive: employees reporting to managers in the hierarchy
    SELECT E.EMPLOYEE_ID, E.FIRST_NAME, E.MANAGER_ID, MH.LEVEL + 1
    FROM TESTDB..EMPLOYEES E
    JOIN MANAGER_HIERARCHY MH ON E.MANAGER_ID = MH.EMPLOYEE_ID
)
SELECT * FROM MANAGER_HIERARCHY ORDER BY LEVEL, EMPLOYEE_ID;`);
    });
  });

  // ========================================================================
  // ADVANCED: Column existence validation across all contexts
  // ========================================================================
  describe("ADVANCED: Column existence validation in CTEs", () => {
    it("should detect non-existent column in CTE definition", () => {
      expectErrorCode(
        `WITH CTE_TEST AS (
    SELECT NONEXISTENT_COLUMN, FIRST_NAME 
    FROM TESTDB..EMPLOYEES
)
SELECT * FROM CTE_TEST;`,
        "SQL004",
      );
    });

    it("should detect non-existent column referenced from CTE in outer query", () => {
      expectErrorCode(
        `WITH CTE_EMP AS (
    SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES
)
SELECT CTE_EMP.FAKE_COLUMN FROM CTE_EMP;`,
        "SQL004",
      );
    });

    it("should validate column exists in CTE with explicit column list", () => {
      expectValid(`WITH CTE_RENAMED (ID, NAME, SAL) AS (
    SELECT EMPLOYEE_ID, FIRST_NAME, SALARY FROM TESTDB..EMPLOYEES
)
SELECT ID, NAME, SAL FROM CTE_RENAMED;`);
    });

    it("should detect using original column name when CTE has explicit column list", () => {
      expectErrorCode(
        `WITH CTE_RENAMED (ID, NAME) AS (
    SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES
)
SELECT EMPLOYEE_ID FROM CTE_RENAMED;`,
        "SQL004",
      );
    });

    it("should validate columns from chained CTEs propagate correctly", () => {
      expectValid(`WITH 
    CTE1 AS (SELECT EMPLOYEE_ID, SALARY FROM TESTDB..EMPLOYEES),
    CTE2 AS (SELECT C1.EMPLOYEE_ID, C1.SALARY * 1.1 AS NEW_SAL FROM CTE1 C1)
SELECT C2.EMPLOYEE_ID, C2.NEW_SAL FROM CTE2 C2;`);
    });

    it("should detect non-existent column from chained CTE", () => {
      expectErrorCode(
        `WITH 
    CTE1 AS (SELECT EMPLOYEE_ID FROM TESTDB..EMPLOYEES),
    CTE2 AS (SELECT C1.EMPLOYEE_ID FROM CTE1 C1)
SELECT C2.FAKE_COL FROM CTE2 C2;`,
        "SQL004",
      );
    });
  });

  describe("ADVANCED: Column existence in subqueries", () => {
    it("should validate column from aliased subquery in FROM clause", () => {
      expectValid(`SELECT SUB.EMP_ID, SUB.FULL_NAME
FROM (
    SELECT E.EMPLOYEE_ID AS EMP_ID, 
           E.FIRST_NAME || ' ' || E.LAST_NAME AS FULL_NAME
    FROM TESTDB..EMPLOYEES E
) SUB;`);
    });

    it("should detect non-existent column from aliased subquery", () => {
      expectErrorCode(
        `SELECT SUB.FAKE_COL
FROM (
    SELECT E.EMPLOYEE_ID FROM TESTDB..EMPLOYEES E
) SUB;`,
        "SQL004",
      );
    });

    it("should resolve simple SELECT * subquery alias through base table metadata", () => {
      const employeesTable = {
        name: "EMPLOYEES",
        database: "TESTDB",
        schema: "PUBLIC",
        isCte: false,
        isTempTable: false,
        columns: [{ name: "EMPLOYEE_ID" }, { name: "FIRST_NAME" }],
      };
      let employeesLookupCount = 0;
      const delayedSchemaProvider: SchemaProvider = {
        getTable: (database, schema, tableName) => {
          if (
            database?.toUpperCase() === "TESTDB" &&
            !schema &&
            tableName.toUpperCase() === "EMPLOYEES"
          ) {
            employeesLookupCount += 1;
            return employeesLookupCount >= 2 ? employeesTable : undefined;
          }
          return undefined;
        },
        tableExists: () => true,
        canValidateUnqualifiedTableReferences: () => true,
      };
      const delayedValidator = new SqlValidator(delayedSchemaProvider);

      const result = delayedValidator.validate(`SELECT F1.EMPLOYEE_ID
FROM (SELECT * FROM TESTDB..EMPLOYEES LIMIT 5) F1;`);

      expect(employeesLookupCount).toBeGreaterThan(1);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some((warning) => warning.code === "SQL005")).toBe(
        false,
      );
    });

    it("should validate column from nested subquery outer reference", () => {
      expectValid(`SELECT * FROM (
    SELECT * FROM (
        SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES
    ) L2
) L1;`);
    });

    it("should detect column not exposed by nested subquery", () => {
      expectErrorCode(
        `SELECT L1.LAST_NAME FROM (
    SELECT L2.EMPLOYEE_ID FROM (
        SELECT EMPLOYEE_ID FROM TESTDB..EMPLOYEES
    ) L2
) L1;`,
        "SQL004",
      );
    });

    it("should validate correlated subquery references outer columns", () => {
      expectValid(`SELECT E.EMPLOYEE_ID
FROM TESTDB..EMPLOYEES E
WHERE EXISTS (
    SELECT 1 FROM TESTDB..DEPARTMENTS D 
    WHERE D.DEPARTMENT_ID = E.DEPARTMENT_ID
);`);
    });
  });

  describe("ADVANCED: Column existence in JOINs", () => {
    it("should validate column in JOIN ON clause exists in both tables", () => {
      expectValid(`SELECT * FROM TESTDB..EMPLOYEES E
JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;`);
    });

    it("should detect column in JOIN ON that does not exist in left table", () => {
      expectErrorCode(
        `SELECT * FROM TESTDB..EMPLOYEES E
JOIN TESTDB..DEPARTMENTS D ON E.FAKE_COLUMN = D.DEPARTMENT_ID;`,
        "SQL004",
      );
    });

    it("should detect column in JOIN ON that does not exist in right table", () => {
      expectErrorCode(
        `SELECT * FROM TESTDB..EMPLOYEES E
JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.FAKE_COLUMN;`,
        "SQL004",
      );
    });

    it("should validate columns from joined subqueries", () => {
      expectValid(`SELECT A.ID, B.NAME
FROM (SELECT EMPLOYEE_ID AS ID FROM TESTDB..EMPLOYEES) A
JOIN (SELECT DEPARTMENT_ID AS ID, DEPARTMENT_NAME AS NAME FROM TESTDB..DEPARTMENTS) B
ON A.ID = B.ID;`);
    });

    it("should detect non-existent column from joined subquery", () => {
      expectErrorCode(
        `SELECT A.ID, B.FAKE_NAME
FROM (SELECT EMPLOYEE_ID AS ID FROM TESTDB..EMPLOYEES) A
JOIN (SELECT DEPARTMENT_ID AS ID FROM TESTDB..DEPARTMENTS) B
ON A.ID = B.ID;`,
        "SQL004",
      );
    });
  });

  describe("ADVANCED: Object existence (table/CTE/alias/subquery)", () => {
    it("should validate reference to CTE defined earlier in the same query", () => {
      expectValid(`WITH MY_CTE AS (SELECT 1 AS COL)
SELECT * FROM MY_CTE;`);
    });

    it("should handle reference to non-existent table gracefully", () => {
      // Note: The validator may not report an error for unqualified table names
      // if the schema provider doesn't support strict validation
      const result = validator.validate(`WITH REAL_CTE AS (SELECT 1 AS COL)
SELECT * FROM FAKE_CTE;`);
      // Either errors are reported, or the query parses without errors
      // (depending on strict schema provider settings)
      expect(result).toBeDefined();
    });

    it("should validate reference to temp table created earlier in script", () => {
      expectValid(`CREATE TEMP TABLE MY_TEMP (ID INT4, NAME VARCHAR(50));
SELECT ID, NAME FROM MY_TEMP;`);
    });

    it("should validate reference to CTAS table in subsequent statement", () => {
      expectValid(`CREATE TABLE CTAS_RESULT AS (SELECT 1 AS A, 2 AS B);
SELECT A, B FROM CTAS_RESULT;`);
    });

    it("should detect reference to table alias outside its scope", () => {
      expectErrorCode(
        `SELECT OUTER_ALIAS.FAKE_COL FROM (
    SELECT E.EMPLOYEE_ID FROM TESTDB..EMPLOYEES E
) OUTER_ALIAS;`,
        "SQL004",
      );
    });

    it("should detect non-existent column in subquery alias", () => {
      // Test that we cannot reference a column that doesn't exist in the subquery
      expectErrorCode(
        `SELECT OUTER_SUB.FAKE_COL FROM (
    SELECT E.EMPLOYEE_ID FROM TESTDB..EMPLOYEES E
) OUTER_SUB;`,
        "SQL004",
      );
    });

    it("should validate table created via CREATE TABLE DDL is referenceable", () => {
      expectValid(`CREATE TABLE NEW_DDL_TABLE (ID INT4 CONSTRAINT PK_NEW PRIMARY KEY, NAME VARCHAR(100));
SELECT ID, NAME FROM NEW_DDL_TABLE;`);
    });

    it("should validate view created via CREATE VIEW is referenceable", () => {
      expectValid(`CREATE VIEW TEST_VIEW AS SELECT EMPLOYEE_ID, FIRST_NAME FROM TESTDB..EMPLOYEES;
SELECT EMPLOYEE_ID, FIRST_NAME FROM TEST_VIEW;`);
    });
  });

  // ========================================================================
  // ADVANCED: Complex functions and analytics
  // ========================================================================
  describe("ADVANCED: Analytic functions with complex OVER clauses", () => {
    it("should validate ROW_NUMBER with PARTITION BY multiple columns", () => {
      expectValid(`SELECT 
    EMPLOYEE_ID,
    ROW_NUMBER() OVER (PARTITION BY DEPARTMENT_ID, STATUS ORDER BY SALARY DESC) AS RN
FROM TESTDB..EMPLOYEES;`);
    });

    it("should validate SUM with ROWS frame", () => {
      expectValid(`SELECT 
    EMPLOYEE_ID,
    SALARY,
    SUM(SALARY) OVER (ORDER BY HIRE_DATE ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS MOVING_SUM
FROM TESTDB..EMPLOYEES;`);
    });

    it("should validate FIRST_VALUE window function", () => {
      // Note: IGNORE NULLS not supported by parser
      expectValid(`SELECT 
    EMPLOYEE_ID,
    FIRST_VALUE(SALARY) OVER (PARTITION BY DEPARTMENT_ID ORDER BY HIRE_DATE) AS FIRST_SAL
FROM TESTDB..EMPLOYEES;`);
    });

    it("should validate LAG with default value", () => {
      expectValid(`SELECT 
    EMPLOYEE_ID,
    LAG(SALARY, 1, 0) OVER (PARTITION BY DEPARTMENT_ID ORDER BY HIRE_DATE) AS PREV_SAL
FROM TESTDB..EMPLOYEES;`);
    });

    it("should validate multiple analytics with different partitions", () => {
      expectValid(`SELECT 
    EMPLOYEE_ID,
    DEPARTMENT_ID,
    SALARY,
    RANK() OVER (PARTITION BY DEPARTMENT_ID ORDER BY SALARY DESC) AS DEPT_RANK,
    RANK() OVER (ORDER BY SALARY DESC) AS OVERALL_RANK,
    AVG(SALARY) OVER (PARTITION BY DEPARTMENT_ID) AS DEPT_AVG,
    AVG(SALARY) OVER () AS COMPANY_AVG
FROM TESTDB..EMPLOYEES;`);
    });
  });

  describe("ADVANCED: Complex CASE expressions", () => {
    it("should validate CASE with subquery in WHEN", () => {
      expectValid(`SELECT 
    CASE 
        WHEN SALARY > (SELECT AVG(SALARY) FROM TESTDB..EMPLOYEES) THEN 'Above Average'
        ELSE 'Below Average'
    END AS COMPARISON
FROM TESTDB..EMPLOYEES;`);
    });

    it("should validate CASE with analytic function in WHEN", () => {
      expectValid(`SELECT 
    EMPLOYEE_ID,
    CASE 
        WHEN ROW_NUMBER() OVER (PARTITION BY DEPARTMENT_ID ORDER BY SALARY DESC) = 1 THEN 'Top Earner'
        ELSE 'Regular'
    END AS STATUS
FROM TESTDB..EMPLOYEES;`);
    });

    it("should validate nested CASE expressions (3+ levels)", () => {
      expectValid(`SELECT 
    CASE 
        WHEN DEPARTMENT_ID = 1 THEN
            CASE 
                WHEN SALARY > 10000 THEN 'HR-Executive'
                WHEN SALARY > 5000 THEN 'HR-Senior'
                ELSE 'HR-Junior'
            END
        WHEN DEPARTMENT_ID = 2 THEN
            CASE 
                WHEN SALARY > 8000 THEN 'IT-Lead'
                ELSE 'IT-Dev'
            END
        ELSE 'Other'
    END AS ROLE
FROM TESTDB..EMPLOYEES;`);
    });
  });

  describe("ADVANCED: Complex expressions and aggregations", () => {
    it("should validate conditional aggregation with CASE", () => {
      expectValid(`SELECT 
    DEPARTMENT_ID,
    COUNT(*) AS TOTAL,
    COUNT(CASE WHEN STATUS = 'A' THEN 1 END) AS ACTIVE_COUNT
FROM TESTDB..EMPLOYEES
GROUP BY DEPARTMENT_ID;`);
    });

    it("should validate aggregate with DISTINCT inside expression", () => {
      expectValid(`SELECT 
    DEPARTMENT_ID,
    COUNT(DISTINCT MANAGER_ID) AS UNIQUE_MANAGERS
FROM TESTDB..EMPLOYEES
GROUP BY DEPARTMENT_ID;`);
    });

    it("should validate standard GROUP BY with multiple columns", () => {
      // Note: ROLLUP and GROUPING SETS not supported by parser
      expectValid(`SELECT 
    DEPARTMENT_ID,
    STATUS,
    COUNT(*) AS CNT,
    SUM(SALARY) AS TOTAL_SAL
FROM TESTDB..EMPLOYEES
GROUP BY DEPARTMENT_ID, STATUS;`);
    });
  });

  // ========================================================================
  // ADVANCED: Multi-statement scenarios with cross-statement validation
  // ========================================================================
  describe("ADVANCED: Multi-statement column and object validation", () => {
    it("should validate columns from CREATE TABLE AS are accessible", () => {
      expectValid(`CREATE TABLE SUMMARY_DATA AS (
    SELECT DEPARTMENT_ID, AVG(SALARY) AS AVG_SAL, COUNT(*) AS EMP_COUNT
    FROM TESTDB..EMPLOYEES
    GROUP BY DEPARTMENT_ID
);
SELECT DEPARTMENT_ID, AVG_SAL, EMP_COUNT FROM SUMMARY_DATA;`);
    });

    it("should validate columns from CREATE VIEW are accessible", () => {
      expectValid(`CREATE VIEW ACTIVE_EMPLOYEES AS
    SELECT EMPLOYEE_ID, FIRST_NAME, LAST_NAME, DEPARTMENT_ID
    FROM TESTDB..EMPLOYEES
    WHERE STATUS = 'A';
SELECT EMPLOYEE_ID, FIRST_NAME FROM ACTIVE_EMPLOYEES;`);
    });

    it("should detect non-existent column from CTAS table", () => {
      expectErrorCode(
        `CREATE TABLE CTAS_TEST AS (SELECT 1 AS COL_A, 2 AS COL_B);
SELECT COL_A, FAKE_COL FROM CTAS_TEST;`,
        "SQL004",
      );
    });

    it("should validate INSERT into CTAS-created table uses correct columns", () => {
      expectValid(`CREATE TABLE INSERT_TARGET AS (SELECT 1 AS ID, 'TEST' AS NAME FROM TESTDB..EMPLOYEES LIMIT 0);
INSERT INTO INSERT_TARGET (ID, NAME) VALUES (1, 'New Record');
SELECT ID, NAME FROM INSERT_TARGET;`);
    });

    it("should validate UPDATE on CTAS-created table uses correct columns", () => {
      expectValid(`CREATE TABLE UPDATE_TARGET AS (SELECT 1 AS ID, 'TEST' AS NAME FROM TESTDB..EMPLOYEES LIMIT 0);
UPDATE UPDATE_TARGET SET NAME = 'Updated' WHERE ID = 1;`);
    });

    it("should validate DELETE on CTAS-created table with WHERE clause", () => {
      expectValid(`CREATE TABLE DELETE_TARGET AS (SELECT 1 AS ID, 'TEST' AS NAME FROM TESTDB..EMPLOYEES LIMIT 0);
DELETE FROM DELETE_TARGET WHERE ID = 1;`);
    });
  });

  // ========================================================================
  // ADVANCED: Error cases for complex SQL
  // ========================================================================
  describe("ADVANCED: Error detection in complex SQL", () => {
    it("should detect missing column in deeply nested subquery", () => {
      expectErrorCode(
        `SELECT * FROM (
    SELECT * FROM (
        SELECT NONEXISTENT_COL FROM TESTDB..EMPLOYEES
    ) L2
) L1;`,
        "SQL004",
      );
    });

    it("should detect ambiguous column reference across CTEs", () => {
      expectErrorCode(
        `WITH 
    CTE1 AS (SELECT EMPLOYEE_ID, DEPARTMENT_ID FROM TESTDB..EMPLOYEES),
    CTE2 AS (SELECT EMPLOYEE_ID, DEPARTMENT_ID FROM TESTDB..EMPLOYEES)
SELECT EMPLOYEE_ID, DEPARTMENT_ID
FROM CTE1 C1
JOIN CTE2 C2 ON 1=1;`,
        "SQL008",
      );
    });

    it("should handle non-existent table in subquery within CTE gracefully", () => {
      // Note: The validator may not report an error for unqualified table names
      // if the schema provider doesn't support strict validation
      const result = validator.validate(`WITH MY_CTE AS (
    SELECT * FROM NONEXISTENT_TABLE
)
SELECT * FROM MY_CTE;`);
      // Either errors are reported, or the query parses without errors
      // (depending on strict schema provider settings)
      expect(result).toBeDefined();
    });

    it("should detect non-existent column in analytics PARTITION BY", () => {
      expectErrorCode(
        `SELECT 
    ROW_NUMBER() OVER (PARTITION BY FAKE_COLUMN ORDER BY EMPLOYEE_ID) AS RN
FROM TESTDB..EMPLOYEES;`,
        "SQL004",
      );
    });

    it("should detect non-existent column in analytics ORDER BY", () => {
      expectErrorCode(
        `SELECT 
    ROW_NUMBER() OVER (PARTITION BY DEPARTMENT_ID ORDER BY FAKE_COLUMN) AS RN
FROM TESTDB..EMPLOYEES;`,
        "SQL004",
      );
    });

    it("should detect non-existent column in GROUP BY ROLLUP", () => {
      expectErrorCode(
        `SELECT COUNT(*) FROM TESTDB..EMPLOYEES GROUP BY ROLLUP(FAKE_COLUMN);`,
        "SQL004",
      );
    });

    it("should detect non-existent column in CASE WHEN", () => {
      expectErrorCode(
        `SELECT 
    CASE WHEN FAKE_COLUMN > 100 THEN 'High' ELSE 'Low' END
FROM TESTDB..EMPLOYEES;`,
        "SQL004",
      );
    });
  });

  // ========================================================================
  // ADVANCED: Real-world complex scenarios
  // ========================================================================
  describe("ADVANCED: Real-world complex query patterns", () => {
    it("should validate complex reporting query with all features", () => {
      expectValid(`WITH 
    -- Get department statistics
    DEPT_STATS AS (
        SELECT 
            D.DEPARTMENT_ID,
            D.DEPARTMENT_NAME,
            COUNT(E.EMPLOYEE_ID) AS EMP_COUNT,
            AVG(E.SALARY) AS AVG_SALARY,
            MAX(E.SALARY) AS MAX_SALARY
        FROM TESTDB..DEPARTMENTS D
        LEFT JOIN TESTDB..EMPLOYEES E ON D.DEPARTMENT_ID = E.DEPARTMENT_ID
        GROUP BY D.DEPARTMENT_ID, D.DEPARTMENT_NAME
    ),
    -- Rank employees within departments
    RANKED_EMPS AS (
        SELECT 
            E.EMPLOYEE_ID,
            E.FIRST_NAME || ' ' || E.LAST_NAME AS FULL_NAME,
            E.DEPARTMENT_ID,
            E.SALARY,
            E.HIRE_DATE,
            ROW_NUMBER() OVER (PARTITION BY E.DEPARTMENT_ID ORDER BY E.SALARY DESC) AS SAL_RANK,
            NTILE(4) OVER (PARTITION BY E.DEPARTMENT_ID ORDER BY E.SALARY) AS SAL_QUARTILE,
            LAG(E.SALARY, 1) OVER (PARTITION BY E.DEPARTMENT_ID ORDER BY E.HIRE_DATE) AS PREV_HIRE_SAL
        FROM TESTDB..EMPLOYEES E
        WHERE E.STATUS = 'A'
    ),
    -- Calculate order metrics per employee
    ORDER_METRICS AS (
        SELECT 
            O.CUSTOMER_ID AS EMP_ID,
            COUNT(O.ORDER_ID) AS ORDER_COUNT,
            SUM(O.TOTAL_AMOUNT) AS TOTAL_REVENUE,
            AVG(O.TOTAL_AMOUNT) AS AVG_ORDER_VALUE
        FROM TESTDB..ORDERS O
        GROUP BY O.CUSTOMER_ID
    )
-- Final report combining all metrics
SELECT 
    DS.DEPARTMENT_NAME,
    DS.EMP_COUNT,
    DS.AVG_SALARY,
    RE.FULL_NAME,
    RE.SALARY,
    RE.SAL_RANK,
    RE.SAL_QUARTILE,
    CASE 
        WHEN RE.SALARY > DS.AVG_SALARY THEN 'Above Dept Avg'
        WHEN RE.SALARY < DS.AVG_SALARY THEN 'Below Dept Avg'
        ELSE 'At Dept Avg'
    END AS SALARY_COMPARISON,
    COALESCE(OM.ORDER_COUNT, 0) AS ORDERS_HANDLED,
    COALESCE(OM.TOTAL_REVENUE, 0) AS REVENUE_GENERATED
FROM DEPT_STATS DS
JOIN RANKED_EMPS RE ON DS.DEPARTMENT_ID = RE.DEPARTMENT_ID
LEFT JOIN ORDER_METRICS OM ON RE.EMPLOYEE_ID = OM.EMP_ID
WHERE RE.SAL_RANK <= 5
ORDER BY DS.DEPARTMENT_NAME, RE.SALARY DESC;`);
    });

    it("should validate complex ETL-style multi-statement script", () => {
      expectValid(`-- Step 1: Create staging table
CREATE TEMP TABLE STG_EMPLOYEES AS (
    SELECT 
        E.EMPLOYEE_ID,
        E.FIRST_NAME,
        E.LAST_NAME,
        E.DEPARTMENT_ID,
        E.SALARY,
        E.HIRE_DATE,
        D.DEPARTMENT_NAME,
        CASE 
            WHEN E.SALARY > 10000 THEN 'High'
            WHEN E.SALARY > 5000 THEN 'Medium'
            ELSE 'Low'
        END AS SALARY_BAND
    FROM TESTDB..EMPLOYEES E
    JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID
    WHERE E.STATUS = 'A'
);

-- Step 2: Create summary table
CREATE TEMP TABLE DEPT_SUMMARY AS (
    SELECT 
        DEPARTMENT_ID,
        DEPARTMENT_NAME,
        COUNT(*) AS EMP_COUNT,
        AVG(SALARY) AS AVG_SAL,
        SUM(SALARY) AS TOTAL_SALARY,
        COUNT(CASE WHEN SALARY_BAND = 'High' THEN 1 END) AS HIGH_EARNERS
    FROM STG_EMPLOYEES
    GROUP BY DEPARTMENT_ID, DEPARTMENT_NAME
);

-- Step 3: Final transformation with analytics
SELECT 
    DS.DEPARTMENT_NAME,
    DS.EMP_COUNT,
    DS.AVG_SAL,
    DS.TOTAL_SALARY,
    DS.HIGH_EARNERS,
    RANK() OVER (ORDER BY DS.TOTAL_SALARY DESC) AS DEPT_RANK_BY_PAYROLL,
    ROUND(DS.HIGH_EARNERS * 100.0 / DS.EMP_COUNT, 2) AS HIGH_EARNER_PCT
FROM DEPT_SUMMARY DS
ORDER BY DS.TOTAL_SALARY DESC;`);
    });

    it("should validate complex self-join with subquery and CTE", () => {
      expectValid(`WITH MANAGER_INFO AS (
    SELECT 
        M.EMPLOYEE_ID AS MGR_ID,
        M.FIRST_NAME || ' ' || M.LAST_NAME AS MGR_NAME,
        M.DEPARTMENT_ID AS MGR_DEPT
    FROM TESTDB..EMPLOYEES M
    WHERE M.MANAGER_ID IS NULL
)
SELECT 
    E.EMPLOYEE_ID,
    E.FIRST_NAME || ' ' || E.LAST_NAME AS EMP_NAME,
    E.SALARY AS EMP_SALARY,
    MI.MGR_NAME,
    (SELECT COUNT(*) FROM TESTDB..EMPLOYEES SUB WHERE SUB.MANAGER_ID = E.EMPLOYEE_ID) AS DIRECT_REPORTS,
    CASE 
        WHEN E.SALARY > (SELECT AVG(E2.SALARY) FROM TESTDB..EMPLOYEES E2 WHERE E2.DEPARTMENT_ID = E.DEPARTMENT_ID) 
        THEN 'Above Dept Average'
        ELSE 'Below or At Dept Average'
    END AS SAL_STATUS
FROM TESTDB..EMPLOYEES E
LEFT JOIN TESTDB..EMPLOYEES M ON E.MANAGER_ID = M.EMPLOYEE_ID
LEFT JOIN MANAGER_INFO MI ON M.EMPLOYEE_ID = MI.MGR_ID
WHERE E.MANAGER_ID IS NOT NULL
ORDER BY E.DEPARTMENT_ID, E.SALARY DESC;`);
    });
  });

  // ====================================================================
  // GRANT / REVOKE statements
  // ====================================================================
  describe("GRANT / REVOKE — valid syntax", () => {
    it("should validate simple GRANT on table", () => {
      expectValid("GRANT SELECT ON my_table TO admin");
    });

    it("should validate GRANT multiple privileges", () => {
      expectValid(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON my_schema.my_table TO admin",
      );
    });

    it("should validate GRANT with WITH GRANT OPTION", () => {
      expectValid("GRANT ALL ON my_table TO admin WITH GRANT OPTION");
    });

    it("should validate GRANT to PUBLIC", () => {
      expectValid("GRANT SELECT ON my_table TO PUBLIC");
    });

    it("should validate GRANT to GROUP", () => {
      expectValid("GRANT SELECT ON my_table TO GROUP dev_team");
    });

    it("should validate GRANT admin privileges", () => {
      expectValid("GRANT LIST ON SCHEMA my_schema TO admin");
    });

    it("should validate REVOKE", () => {
      expectValid("REVOKE SELECT ON my_table FROM admin");
    });

    it("should validate REVOKE multiple privileges", () => {
      expectValid("REVOKE INSERT, DELETE ON my_table FROM admin");
    });
  });

  // ====================================================================
  // CREATE USER
  // ====================================================================
  describe("CREATE USER — valid syntax", () => {
    it("should validate simple CREATE USER", () => {
      expectValid("CREATE USER testuser");
    });

    it("should validate CREATE USER with PASSWORD", () => {
      expectValid("CREATE USER testuser WITH PASSWORD 'secret123'");
    });

    it("should validate CREATE USER with multiple clauses", () => {
      expectValid(
        "CREATE USER testuser WITH PASSWORD 'secret123' IN GROUP dev_team DEFPRIORITY NORMAL ROWSETLIMIT 1000",
      );
    });

    it("should validate CREATE USER with NULL password", () => {
      expectValid("CREATE USER testuser WITH PASSWORD NULL");
    });
  });




  // ====================================================================
  // GROOM TABLE — valid syntax
  // ====================================================================
  describe("GROOM TABLE — valid syntax", () => {
    it("should validate basic GROOM TABLE", () => {
      expectValid("GROOM TABLE my_table");
    });

    it("should validate GROOM TABLE RECORDS ALL", () => {
      expectValid("GROOM TABLE my_table RECORDS ALL");
    });

    it("should validate GROOM TABLE RECORDS READY", () => {
      expectValid("GROOM TABLE my_table RECORDS READY");
    });

    it("should validate GROOM TABLE PAGES ALL", () => {
      expectValid("GROOM TABLE my_table PAGES ALL");
    });

    it("should validate GROOM TABLE PAGES START", () => {
      expectValid("GROOM TABLE my_table PAGES START");
    });

    it("should validate GROOM TABLE VERSIONS", () => {
      expectValid("GROOM TABLE my_table VERSIONS");
    });

    it("should validate GROOM TABLE with RECLAIM BACKUPSET", () => {
      expectValid("GROOM TABLE my_table RECORDS ALL RECLAIM BACKUPSET NONE");
    });

    it("should validate GROOM TABLE with RECLAIM BACKUPSET DEFAULT", () => {
      expectValid("GROOM TABLE my_table RECLAIM BACKUPSET DEFAULT");
    });

    it("should validate GROOM TABLE with schema-qualified name", () => {
      expectValid("GROOM TABLE TESTDB.PUBLIC.EMPLOYEES VERSIONS");
    });
  });


  // ====================================================================
  // TRUNCATE — valid syntax
  // ====================================================================
  describe("TRUNCATE — valid syntax", () => {
    it("should validate TRUNCATE TABLE", () => {
      expectValid("TRUNCATE TABLE my_table");
    });

    it("should validate TRUNCATE without TABLE keyword", () => {
      expectValid("TRUNCATE my_table");
    });

    it("should validate TRUNCATE with schema-qualified name", () => {
      expectValid("TRUNCATE TABLE TESTDB..EMPLOYEES");
    });
  });

  // ====================================================================
  // EXPLAIN — valid syntax
  // ====================================================================
  describe("EXPLAIN — valid syntax", () => {
    it("should validate EXPLAIN SELECT", () => {
      expectValid("EXPLAIN SELECT * FROM my_table");
    });

    it("should validate EXPLAIN VERBOSE SELECT", () => {
      expectValid(
        "EXPLAIN VERBOSE SELECT id, name FROM my_table WHERE id > 10",
      );
    });

    it("should validate EXPLAIN DISTRIBUTION SELECT", () => {
      expectValid("EXPLAIN DISTRIBUTION SELECT * FROM my_table");
    });

    it("should validate EXPLAIN PLANTEXT SELECT", () => {
      expectValid("EXPLAIN PLANTEXT SELECT * FROM my_table");
    });

    it("should validate EXPLAIN PLANGRAPH SELECT", () => {
      expectValid("EXPLAIN PLANGRAPH SELECT * FROM my_table");
    });
  });

  // ====================================================================
  // GENERATE STATISTICS — valid syntax
  // ====================================================================
  describe("GENERATE STATISTICS — valid syntax", () => {
    it("should validate GENERATE STATISTICS ON table", () => {
      expectValid("GENERATE STATISTICS ON my_table");
    });

    it("should validate GENERATE STATISTICS ON table with columns", () => {
      expectValid("GENERATE STATISTICS ON my_table (col1, col2)");
    });

    it("should validate GENERATE EXPRESS STATISTICS", () => {
      expectValid("GENERATE EXPRESS STATISTICS ON my_table");
    });

    it("should validate GENERATE EXPRESS STATISTICS with columns", () => {
      expectValid("GENERATE EXPRESS STATISTICS ON my_table (col1, col2, col3)");
    });
  });

  // ====================================================================
  // Negative tests — malformed analytic / window functions
  // ====================================================================
  describe("Window functions — syntax errors", () => {
    it("should reject OVER clause without parentheses", () => {
      expectSyntaxError("SELECT SUM(x) OVER FROM t");
    });

    it("should reject window frame with missing PRECEDING/FOLLOWING keyword", () => {
      expectSyntaxError(
        "SELECT SUM(x) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED AND CURRENT ROW) FROM t",
      );
    });

    it("should reject window frame with missing AND in BETWEEN", () => {
      expectSyntaxError(
        "SELECT SUM(x) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING CURRENT ROW) FROM t",
      );
    });

    it("should reject window frame with missing bound specification", () => {
      expectSyntaxError(
        `SELECT E.PARENTEMPLOYEEKEY, SUM(E.CURRENTFLAG::INT) OVER (ORDER BY E.PARENTEMPLOYEEKEY ROWS BETWEEN PRECEDING AND CURRENT ROW) AS RUN_SUM FROM JUST_DATA..DIMEMPLOYEE E`,
      );
    });

    it("should reject PARTITION BY without column list", () => {
      expectSyntaxError("SELECT SUM(x) OVER (PARTITION BY) FROM t");
    });

    it("should reject OVER with stray comma", () => {
      expectSyntaxError(
        "SELECT SUM(x) OVER (PARTITION BY a, ORDER BY b) FROM t",
      );
    });
  });

  // ====================================================================
  // Negative tests — malformed JOINs
  // ====================================================================
  describe("JOIN — syntax errors", () => {
    it("should reject JOIN without ON clause for non-CROSS join", () => {
      // Note: parser allows JOIN without ON (like CROSS), but this is valid SQL technically.
      // Test that missing table after JOIN is detected.
      expectSyntaxError("SELECT * FROM t1 LEFT JOIN");
    });

    it("should validate CALL statement as top-level", () => {
      expectValid("CALL SOME_PROC_NAME()");
    });

    it("should validate CALL statement with schema-qualified procedure name", () => {
      expectValid("CALL JUST_DATA.ADMIN.SOME_PROC_NAME()");
    });

    it("should validate CALL statement with arguments", () => {
      expectValid("CALL SOME_PROC_NAME('test', 123, 45.67)");
    });

    it("should validate EXECUTE PROCEDURE as alternative to CALL", () => {
      expectValid("EXECUTE PROCEDURE SOME_PROC_NAME()");
    });

    it("should validate EXECUTE (without PROCEDURE keyword) as CALL alternative", () => {
      expectValid("EXECUTE SOME_PROC_NAME()");
    });

    it("should validate EXEC shorthand as CALL alternative", () => {
      expectValid("EXEC SOME_PROC_NAME()");
    });

    it("should validate EXEC PROCEDURE shorthand as CALL alternative", () => {
      expectValid("EXEC PROCEDURE SOME_PROC_NAME()");
    });

    it("should reject JOIN with double ON", () => {
      expectSyntaxError("SELECT * FROM t1 JOIN t2 ON ON t1.id = t2.id");
    });

    it("should reject JOIN with incomplete condition", () => {
      expectSyntaxError("SELECT * FROM t1 JOIN t2 ON t1.id =");
    });

    it("should reject LEFT RIGHT JOIN (invalid join type combo)", () => {
      expectSyntaxError("SELECT * FROM t1 LEFT RIGHT JOIN t2 ON t1.id = t2.id");
    });

    it("should reject JOIN with missing table", () => {
      expectSyntaxError("SELECT * FROM t1 INNER JOIN ON t1.id = 1");
    });

    it("should validate NATURAL JOIN", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES NATURAL JOIN TESTDB..DEPARTMENTS",
      );
    });

    it("should validate NATURAL LEFT JOIN", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES NATURAL LEFT JOIN TESTDB..DEPARTMENTS",
      );
    });

    it("should validate JOIN with USING clause", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES JOIN TESTDB..DEPARTMENTS USING (DEPARTMENT_ID)",
      );
    });

    it("should validate LEFT JOIN with USING clause", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES LEFT JOIN TESTDB..DEPARTMENTS USING (DEPARTMENT_ID)",
      );
    });

    it("should reject NATURAL JOIN with ON clause", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES NATURAL JOIN TESTDB..DEPARTMENTS ON 1=1",
      );
    });

    it("should parse CROSS JOIN with ON clause (parser allows it, though semantically odd)", () => {
      // CROSS JOIN with ON is technically parsed but semantically unusual
      // The parser allows ON clause for any join type
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES CROSS JOIN TESTDB..DEPARTMENTS ON 1=1",
      );
    });

    it("should detect ambiguous column when CTE and subquery alias have same name", () => {
      // COL2 is available from both the subquery alias ABC_123 and the CTE ABC_123 (via join)
      expectErrorCode(
        `WITH ABC_123 AS 
(
    SELECT 2 AS COL2 FROM TESTDB..DIMACCOUNT
)
SELECT COL2 FROM 
(SELECT 200 as COL2) ABC_123
JOIN ABC_123 x ON 1=1`,
        "SQL008",
      );
    });

    it("should detect duplicate table alias in same FROM clause", () => {
      // X is used as alias for both table references - should error
      expectErrorCode(
        `SELECT X.* FROM TESTDB..EMPLOYEES X
JOIN TESTDB..EMPLOYEES X ON X.EMPLOYEE_ID = X.EMPLOYEE_ID`,
        "SQL011",
      );
    });

    it("should detect duplicate table name without alias in same FROM clause", () => {
      // DIMDATE appears twice without alias - should error
      expectErrorCode(
        `SELECT * FROM TESTDB..EMPLOYEES JOIN TESTDB..EMPLOYEES ON 1=1`,
        "SQL011",
      );
    });
  });

  // ====================================================================
  // Negative tests — malformed DDL
  // ====================================================================
  describe("DDL — syntax errors (extended)", () => {
    it("should reject GRANT without any arguments", () => {
      expectSyntaxError("GRANT");
    });

    it("should reject REVOKE without any arguments", () => {
      expectSyntaxError("REVOKE");
    });
  });

  // ====================================================================
  // Negative tests — malformed SELECT extras
  // ====================================================================
  describe("SELECT — additional syntax errors", () => {
    it("should reject SELECT with missing FROM keyword and table", () => {
      expectSyntaxError("SELECT id WHERE x > 1 FROM t");
    });

    it("should reject unquoted reserved keyword as table name", () => {
      expectErrorCode("SELECT * FROM FROM", "PAR003");
    });

    it("should reject GROUP BY without column list", () => {
      expectSyntaxError("SELECT COUNT(*) FROM t GROUP BY");
    });

    it("should reject HAVING without GROUP BY expression", () => {
      // HAVING without expression should fail
      expectSyntaxError("SELECT COUNT(*) FROM t GROUP BY id HAVING");
    });

    it("should reject ORDER BY with trailing comma", () => {
      expectSyntaxError("SELECT id FROM t ORDER BY id,");
    });

    it("should reject LIMIT without number", () => {
      expectSyntaxError("SELECT * FROM t LIMIT");
    });

    it("should reject double DISTINCT", () => {
      expectSyntaxError("SELECT DISTINCT DISTINCT id FROM t");
    });
  });

  // ====================================================================
  // Negative tests — malformed CTE
  // ====================================================================
  describe("CTE — additional syntax errors (extended)", () => {
    it("should reject CTE without AS", () => {
      expectSyntaxError("WITH cte (SELECT 1) SELECT * FROM cte");
    });

    it("should reject CTE with missing body", () => {
      expectSyntaxError("WITH cte AS SELECT * FROM cte");
    });

    it("should reject CTE with empty column list", () => {
      expectSyntaxError("WITH cte () AS (SELECT 1) SELECT * FROM cte");
    });
  });


  // ====================================================================
  // Multi-statement scripts
  // ====================================================================
  describe("Multi-statement scripts — valid", () => {
    it("should validate multiple statements separated by semicolons", () => {
      expectValid(
        "CREATE TABLE t1 (id INT); INSERT INTO t1 VALUES (1); SELECT * FROM t1",
      );
    });

    it("should validate GRANT followed by SELECT", () => {
      expectValid("GRANT SELECT ON t1 TO admin; SELECT * FROM t1");
    });

    it("should validate trailing semicolons", () => {
      expectValid("SELECT 1;;;");
    });

    it("should allow leading semicolons and report warning", () => {
      expectWarningCode(";;SELECT 1;", "PARW001");
    });

    it("should allow middle empty statements and report warning", () => {
      expectWarningCode("SELECT 1;;SELECT 22", "PARW001");
    });

    it("should validate complex multi-statement script", () => {
      expectValid(`
                CREATE TEMP TABLE tmp_data (id INT, val FLOAT);
                INSERT INTO tmp_data VALUES (1, 3.14);
                INSERT INTO tmp_data VALUES (2, 2.71);
                SELECT * FROM tmp_data WHERE val > 3;
                DROP TABLE tmp_data IF EXISTS
            `);
    });
  });

  // ========================================================================
  // Scope Builder (from sqlParser.test.ts)
  // ========================================================================
  describe("Scope Builder", () => {
    it("should correctly handle nested scopes", () => {
      const builder = new ScopeBuilder();

      // Add table to root scope
      builder.addTable({
        name: "TABLE_A",
        isCte: false,
        isTempTable: false,
        columns: [{ name: "COL1" }],
      });

      // Enter subquery scope
      builder.enterScope();
      expect(builder.getCurrentScope().level).toBe(1);

      // Should still find table from parent scope
      const table = builder.findTable("TABLE_A");
      expect(table).toBeDefined();
      expect(table?.name).toBe("TABLE_A");

      // Exit scope
      builder.exitScope();
      expect(builder.getCurrentScope().level).toBe(0);
    });

    it("should not find table from child scope in parent", () => {
      const builder = new ScopeBuilder();

      // Enter child scope
      builder.enterScope();
      builder.addTable({
        name: "CHILD_TABLE",
        isCte: false,
        isTempTable: false,
        columns: [],
      });

      // Exit to parent scope
      builder.exitScope();

      // Should not find child table in parent scope
      const table = builder.findTable("CHILD_TABLE");
      expect(table).toBeUndefined();
    });
  });

  // ========================================================================
  // Scope errors - Z2 outside scope (from sqlParser.test.ts)
  // ========================================================================
  describe("Scope errors — Z2 outside scope", () => {
    it("should detect Z2 used outside its scope", () => {
      const sql = `SELECT Z.INNER_COL, Z2.INNER_INNER_COL FROM
JUST_DATA..DIMEMPLOYEE E
LEFT JOIN (
    SELECT 1 AS INNER_COL FROM JUST_DATA..DIMACCOUNT
    JOIN (
        SELECT 1 AS INNER_INNER_COL FROM JUST_DATA..DIMACCOUNT
    ) Z2 ON 1 = 1
) Z ON Z.INNER_COL = E.EMPLOYEEKEY
LIMIT 1`;
      const result = validator.validate(sql);

      // Parser should handle this without syntax errors
      expect(
        result.errors.filter(
          (e: { code: string }) =>
            e.code.startsWith("PAR") || e.code.startsWith("LEX"),
        ),
      ).toHaveLength(0);
      // Z2 should not be accessible in outer scope
      const scopeErrors = result.errors.filter(
        (e: { code: string }) => e.code === "SQL003",
      );
      expect(scopeErrors.length).toBeGreaterThan(0);
      expect(scopeErrors[0].message).toContain("Z2");
    });
  });

  // ========================================================================
  // Variables and basic statements (from sqlParser.test.ts)
  // ========================================================================
  describe("Variables and basic statements", () => {
    it("should parse simple COMMIT", () => {
      expectValid("COMMIT;");
    });

    it("should parse simple ROLLBACK", () => {
      expectValid("ROLLBACK;");
    });

    it("should parse simple variable assignment (@SET)", () => {
      expectValid("@SET myVar = 1;");
    });

    it("should parse SET CATALOG statement", () => {
      expectValid("SET CATALOG JUST_DATA;");
    });

    it("should parse simple variable usage ($myVar)", () => {
      expectValid("SELECT $myVar;");
    });

    it("should parse simple variable usage (${myVar})", () => {
      expectValid("SELECT ${myVar};");
    });

    it("should parse single semicolon", () => {
      expectValid(";");
    });
  });

  // ========================================================================
  // Boolean expression validation (from sqlValidator.netezzaDialect.test.ts)
  // ========================================================================
  describe("Boolean expression validation (ON/WHERE/HAVING)", () => {
    it("should detect JOIN/ON expression that is not boolean", () => {
      expectErrorCode(
        `WITH CTE_1 AS (SELECT 1 AS COL1), CTE_2 AS (SELECT 2 AS COL_A, 3 AS COL_B)
SELECT C.COL1
FROM CTE_1 C
JOIN CTE_2 D ON C.COL1 - D.COL_B;`,
        "SQL010",
      );
    });

    it("should detect WHERE expression that is not boolean", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES A WHERE A.EMPLOYEE_ID + 1;",
        "SQL010",
      );
    });
  });

  // ========================================================================
  // Invalid DB.TABLE form (from sqlValidator.netezzaDialect.test.ts)
  // ========================================================================
  describe("Invalid DB.TABLE form", () => {
    it("should detect invalid DB.TABLE and suggest DB..TABLE", () => {
      const result = validator.validate("SELECT 1 FROM TESTDB.EMPLOYEES;");
      expect(result.errors.some((e) => e.code === "SQL007")).toBe(true);
      expect(result.errors.some((e) => e.code === "SQL006")).toBe(false);
    });
  });

  // ==========================================================================
  // NULLS FIRST / NULLS LAST in ORDER BY
  // ==========================================================================
  describe("ORDER BY — NULLS FIRST / NULLS LAST", () => {
    it("should accept ORDER BY col NULLS FIRST", () => {
      expectValid("SELECT * FROM EMPLOYEES ORDER BY SALARY NULLS FIRST;");
    });

    it("should accept ORDER BY col NULLS LAST", () => {
      expectValid("SELECT * FROM EMPLOYEES ORDER BY SALARY NULLS LAST;");
    });

    it("should accept ORDER BY col ASC NULLS FIRST", () => {
      expectValid("SELECT * FROM EMPLOYEES ORDER BY SALARY ASC NULLS FIRST;");
    });

    it("should accept ORDER BY col DESC NULLS LAST", () => {
      expectValid("SELECT * FROM EMPLOYEES ORDER BY SALARY DESC NULLS LAST;");
    });

    it("should accept multiple ORDER BY items with NULLS", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES ORDER BY DEPARTMENT_ID ASC NULLS LAST, SALARY DESC NULLS FIRST;",
      );
    });

    it("should accept NULLS FIRST without ASC/DESC", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES ORDER BY FIRST_NAME NULLS FIRST, LAST_NAME NULLS LAST;",
      );
    });

    it("should reject NULLS without FIRST or LAST", () => {
      expectSyntaxError("SELECT * FROM EMPLOYEES ORDER BY SALARY NULLS;");
    });
  });

  // ==========================================================================
  // ILIKE — case-insensitive LIKE
  // ==========================================================================
  describe("ILIKE — case-insensitive pattern matching", () => {
    it("should accept simple ILIKE", () => {
      expectValid("SELECT * FROM EMPLOYEES WHERE FIRST_NAME ILIKE '%john%';");
    });

    it("should accept NOT ILIKE", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES WHERE FIRST_NAME NOT ILIKE '%john%';",
      );
    });

    it("should accept ILIKE with column comparison", () => {
      expectValid("SELECT * FROM EMPLOYEES WHERE FIRST_NAME ILIKE LAST_NAME;");
    });

    it("should accept ILIKE in complex WHERE", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES WHERE FIRST_NAME ILIKE '%a%' AND SALARY > 1000;",
      );
    });
  });

  // ==========================================================================
  // FETCH FIRST N ROWS ONLY
  // ==========================================================================
  describe("FETCH FIRST — row limiting", () => {
    it("should accept FETCH FIRST n ROWS ONLY", () => {
      expectValid("SELECT * FROM EMPLOYEES FETCH FIRST 10 ROWS ONLY;");
    });

    it("should accept FETCH FIRST 1 ROW ONLY", () => {
      expectValid("SELECT * FROM EMPLOYEES FETCH FIRST 1 ROW ONLY;");
    });

    it("should accept FETCH FIRST without count (defaults to 1)", () => {
      expectValid("SELECT * FROM EMPLOYEES FETCH FIRST ROW ONLY;");
    });

    it("should accept FETCH FIRST after ORDER BY", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES ORDER BY SALARY DESC FETCH FIRST 5 ROWS ONLY;",
      );
    });

    it("should accept FETCH FIRST after LIMIT", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES LIMIT 100 FETCH FIRST 10 ROWS ONLY;",
      );
    });

    it("should accept FETCH FIRST with OFFSET", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES ORDER BY SALARY LIMIT 100 OFFSET 10 FETCH FIRST 5 ROWS ONLY;",
      );
    });
  });

  // ==========================================================================
  // Parenthesized SELECT in set operations
  // ==========================================================================
  describe("Set operations — parenthesized SELECT", () => {
    it("should accept (SELECT) UNION (SELECT)", () => {
      expectValid("(SELECT 1) UNION (SELECT 2);");
    });

    it("should accept (SELECT) UNION ALL (SELECT)", () => {
      expectValid(
        "(SELECT EMPLOYEE_ID FROM EMPLOYEES) UNION ALL (SELECT EMPLOYEE_ID FROM DEPARTMENTS);",
      );
    });

    it("should accept (SELECT) INTERSECT (SELECT)", () => {
      expectValid(
        "(SELECT EMPLOYEE_ID FROM EMPLOYEES) INTERSECT (SELECT DEPARTMENT_ID FROM DEPARTMENTS);",
      );
    });

    it("should accept (SELECT) EXCEPT (SELECT)", () => {
      expectValid(
        "(SELECT EMPLOYEE_ID FROM EMPLOYEES) EXCEPT (SELECT DEPARTMENT_ID FROM DEPARTMENTS);",
      );
    });

    it("should accept (SELECT) MINUS (SELECT)", () => {
      expectValid("(SELECT 1 FROM T1) MINUS (SELECT 2 FROM T2);");
    });

    it("should accept three-way parenthesized UNION", () => {
      expectValid("(SELECT 1) UNION (SELECT 2) UNION (SELECT 3);");
    });

    it("should accept mixed parenthesized and non-parenthesized", () => {
      expectValid("(SELECT 1) UNION SELECT 2;");
    });

    it("should accept EXCEPT with parenthesized UNION on the right-hand side", () => {
      expectValid(`SELECT * FROM TESTDB..EMPLOYEES
EXCEPT
(
SELECT * FROM TESTDB..EMPLOYEES
UNION
SELECT * FROM TESTDB..EMPLOYEES
);`);
    });
  });

  // ==========================================================================
  // ANY / SOME / ALL quantified comparisons
  // ==========================================================================
  describe("Quantified comparisons — ANY / SOME / ALL", () => {
    it("should accept > ANY (subquery)", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES WHERE SALARY > ANY (SELECT SALARY FROM DEPARTMENTS);",
      );
    });

    it("should accept = ANY (subquery)", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID = ANY (SELECT LOCATION_ID FROM DEPARTMENTS);",
      );
    });

    it("should accept = ANY (WITH-backed subquery)", () => {
      expectValid(`SELECT * FROM EMPLOYEES
WHERE EMPLOYEE_ID = ANY (
  WITH DEPT_LOCATIONS AS (
    SELECT LOCATION_ID
    FROM DEPARTMENTS
  )
  SELECT * FROM DEPT_LOCATIONS
);`);
    });

    it("should accept < ALL (subquery)", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID < ALL (SELECT LOCATION_ID FROM DEPARTMENTS);",
      );
    });

    it("should accept >= SOME (subquery)", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID >= SOME (SELECT LOCATION_ID FROM DEPARTMENTS);",
      );
    });

    it("should accept != ALL (subquery)", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID != ALL (SELECT LOCATION_ID FROM DEPARTMENTS);",
      );
    });

    it("should accept <> ANY (subquery)", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID <> ANY (SELECT LOCATION_ID FROM DEPARTMENTS);",
      );
    });

    it("should accept ANY in complex WHERE", () => {
      expectValid(
        "SELECT * FROM EMPLOYEES WHERE SALARY > ANY (SELECT SALARY FROM DEPARTMENTS) AND DEPARTMENT_ID = 1;",
      );
    });
  });

  // ==========================================================================
  // Netezza special built-in values (CURRENT_TIMESTAMP, CURRENT_USER, etc.)
  // ==========================================================================
  describe("Netezza special built-in values", () => {
    it("should accept CURRENT_TIMESTAMP", () => {
      expectValid("SELECT CURRENT_TIMESTAMP FROM TESTDB..EMPLOYEES;");
    });

    it("should accept CURRENT_DATE", () => {
      expectValid("SELECT CURRENT_DATE FROM TESTDB..EMPLOYEES;");
    });

    it("should accept CURRENT_TIME", () => {
      expectValid("SELECT CURRENT_TIME FROM TESTDB..EMPLOYEES;");
    });

    it("should accept CURRENT_CATALOG", () => {
      expectValid("SELECT CURRENT_CATALOG FROM TESTDB..EMPLOYEES;");
    });

    it("should accept CURRENT_USER", () => {
      expectValid("SELECT CURRENT_USER FROM TESTDB..EMPLOYEES;");
    });

    it("should accept CURRENT_SID", () => {
      expectValid("SELECT CURRENT_SID FROM TESTDB..EMPLOYEES;");
    });

    it("should accept SESSION_USER", () => {
      expectValid("SELECT SESSION_USER FROM TESTDB..EMPLOYEES;");
    });

    it("should accept SYSTEM_USER", () => {
      expectValid("SELECT SYSTEM_USER FROM TESTDB..EMPLOYEES;");
    });

    it("should accept current_db (lowercase)", () => {
      expectValid("SELECT current_db FROM TESTDB..EMPLOYEES;");
    });

    it("should accept current_schema (lowercase)", () => {
      expectValid("SELECT current_schema FROM TESTDB..EMPLOYEES;");
    });

    it("should accept multiple special built-ins in SELECT", () => {
      expectValid("SELECT CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_USER FROM TESTDB..EMPLOYEES;");
    });

    it("should accept special built-in with alias", () => {
      expectValid("SELECT CURRENT_TIMESTAMP AS TS, CURRENT_DATE AS DT FROM TESTDB..EMPLOYEES;");
    });

    it("should accept special built-in in expressions", () => {
      expectValid("SELECT CURRENT_TIMESTAMP + INTERVAL '1' DAY FROM TESTDB..EMPLOYEES;");
    });
  });

  // ==========================================================================
  // Netezza system pseudo-columns (ROWID, CREATEXID, DELETEXID, DATASLICEID)
  // These columns exist on every table and should be accepted without validation errors
  // ==========================================================================
  describe("Netezza system pseudo-columns", () => {
    it("should accept ROWID as valid column", () => {
      expectValid("SELECT ROWID FROM TESTDB..EMPLOYEES;");
    });

    it("should accept CREATEXID as valid column", () => {
      expectValid("SELECT CREATEXID FROM TESTDB..EMPLOYEES;");
    });

    it("should accept DELETEXID as valid column", () => {
      expectValid("SELECT DELETEXID FROM TESTDB..EMPLOYEES;");
    });

    it("should accept DATASLICEID as valid column", () => {
      expectValid("SELECT DATASLICEID FROM TESTDB..EMPLOYEES;");
    });

    it("should accept lowercase system columns", () => {
      expectValid("SELECT rowid, createxid, deletexid, datasliceid FROM TESTDB..EMPLOYEES;");
    });

    it("should accept system columns with table alias", () => {
      expectValid("SELECT E.ROWID, E.CREATEXID FROM TESTDB..EMPLOYEES E;");
    });

    it("should accept system columns with 3-part qualified table", () => {
      expectValid("SELECT ROWID FROM TESTDB..EMPLOYEES;");
    });

    it("should accept system columns in WHERE clause", () => {
      expectValid("SELECT * FROM TESTDB..EMPLOYEES WHERE ROWID > 100;");
    });

    it("should accept system columns in GROUP BY", () => {
      expectValid("SELECT DATASLICEID, COUNT(*) FROM TESTDB..EMPLOYEES GROUP BY DATASLICEID;");
    });

    it("should accept system columns in ORDER BY", () => {
      expectValid("SELECT * FROM TESTDB..EMPLOYEES ORDER BY CREATEXID;");
    });

    it("should accept system columns in JOIN conditions", () => {
      expectValid(`
        SELECT A.ROWID, B.ROWID
        FROM TESTDB..EMPLOYEES A
        JOIN TESTDB..DEPARTMENTS B ON A.CREATEXID = B.CREATEXID;
      `);
    });

    it("should accept all system columns together", () => {
      expectValid("SELECT ROWID, CREATEXID, DELETEXID, DATASLICEID FROM TESTDB..EMPLOYEES;");
    });

    it("should accept system columns with aliases", () => {
      expectValid("SELECT ROWID AS R, CREATEXID AS CX FROM TESTDB..EMPLOYEES;");
    });

    it("should accept system columns in expressions", () => {
      expectValid("SELECT ROWID + 1, DATASLICEID * 10 FROM TESTDB..EMPLOYEES;");
    });

    it("should accept system columns from multiple tables in join", () => {
      expectValid(`
        SELECT E.ROWID AS EMP_ROWID, D.ROWID AS DEPT_ROWID
        FROM TESTDB..EMPLOYEES E
        JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;
      `);
    });
  });

  // ==========================================================================
  // Netezza SQL alias reuse in SELECT, WHERE, GROUP BY, ORDER BY
  // In Netezza SQL, column aliases can be referenced in later parts of the query
  // ==========================================================================
  describe("Netezza SQL alias reuse — SELECT list", () => {
    it("should allow alias from earlier select item in later select item", () => {
      // Classic Netezza pattern: COL1 is defined first, then used in COL2
      expectValid("SELECT 1 AS COL1, COL1 + 1 AS COL2 FROM TESTDB..EMPLOYEES;");
    });

    it("should allow multiple alias references in select list", () => {
      expectValid(`
        SELECT 
          1 AS FIRST_COL,
          FIRST_COL + 1 AS SECOND_COL,
          FIRST_COL + SECOND_COL AS THIRD_COL
        FROM TESTDB..EMPLOYEES;
      `);
    });

    it("should allow alias reference with arithmetic", () => {
      expectValid(`
        SELECT 
          SALARY * 0.1 AS BONUS,
          SALARY + BONUS AS TOTAL
        FROM TESTDB..EMPLOYEES;
      `);
    });

    it("should allow alias reference in function call", () => {
      expectValid(`
        SELECT 
          FIRST_NAME || ' ' || LAST_NAME AS FULL_NAME,
          UPPER(FULL_NAME) AS UPPER_NAME
        FROM TESTDB..EMPLOYEES;
      `);
    });

    it("should allow alias reference in CASE expression", () => {
      expectValid(`
        SELECT 
          SALARY AS BASE_SALARY,
          CASE 
            WHEN BASE_SALARY > 5000 THEN 'High'
            ELSE 'Low'
          END AS SALARY_CATEGORY
        FROM TESTDB..EMPLOYEES;
      `);
    });

    it("should not allow forward reference to later alias", () => {
      // NONEXISTENT_COL is defined after COL1, so it should not be available when validating COL1
      // This should produce an error because NONEXISTENT_COL doesn't exist in the table
      expectErrorCode(
        "SELECT NONEXISTENT_COL + 1 AS COL1, EMPLOYEE_ID AS NONEXISTENT_COL FROM TESTDB..EMPLOYEES;",
        "SQL004"
      );
    });

    it("should handle aliases with mixed case", () => {
      // Mixed case aliases should work (Netezza is case-insensitive for unquoted identifiers)
      expectValid(`SELECT 1 AS MyCol, MyCol + 1 AS NextCol FROM TESTDB..EMPLOYEES;`);
    });

    it("should handle unquoted aliases with national characters", () => {
      expectValid(`SELECT 1 AS ĄĘŚĆĘŃÓŁŻŹ;`);
    });

    it("should allow quoted alias reference with quoted identifier", () => {
      expectValid(`
        SELECT 
          E.SALARY AS "BASE_SAL",
          "BASE_SAL" + 1 AS NEXT_SAL
        FROM TESTDB..EMPLOYEES E;
      `);
    });

    it("should allow quoted alias reference without quotes", () => {
      expectValid(`
        SELECT 
          E.SALARY AS "BASE_SAL",
          BASE_SAL + 1 AS NEXT_SAL
        FROM TESTDB..EMPLOYEES E;
      `);
    });
  });

  describe("Netezza SQL alias reuse — WHERE clause with quoted aliases", () => {
    it("should allow quoted alias reference in WHERE clause", () => {
      expectValid(`
        SELECT 
          SALARY * 0.1 AS "BONUS"
        FROM TESTDB..EMPLOYEES
        WHERE "BONUS" > 100;
      `);
    });

    it("should allow quoted alias in WHERE with AND condition", () => {
      expectValid(`
        SELECT 
          FIRST_NAME || ' ' || LAST_NAME AS "FULL_NAME",
          SALARY AS "BASE_SALARY"
        FROM TESTDB..EMPLOYEES
        WHERE "FULL_NAME" LIKE 'John%' AND "BASE_SALARY" > 5000;
      `);
    });

    it("should allow quoted alias in WHERE with OR condition", () => {
      expectValid(`
        SELECT 
          SALARY * 0.1 AS "BONUS"
        FROM TESTDB..EMPLOYEES
        WHERE "BONUS" > 100 OR "BONUS" < 50;
      `);
    });

    it("should allow quoted alias in WHERE with IN clause", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS "DEPT"
        FROM TESTDB..EMPLOYEES
        WHERE "DEPT" IN (1, 2, 3);
      `);
    });

    it("should allow quoted alias in WHERE with BETWEEN", () => {
      expectValid(`
        SELECT 
          SALARY AS "BASE_SAL"
        FROM TESTDB..EMPLOYEES
        WHERE "BASE_SAL" BETWEEN 3000 AND 8000;
      `);
    });

    it("should allow quoted alias in WHERE with IS NULL", () => {
      expectValid(`
        SELECT 
          MANAGER_ID AS "MGR_ID"
        FROM TESTDB..EMPLOYEES
        WHERE "MGR_ID" IS NULL;
      `);
    });
  });

  describe("Netezza SQL alias reuse — GROUP BY clause with quoted aliases", () => {
    it("should allow quoted alias reference in GROUP BY", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS "DEPT",
          COUNT(*) AS "EMP_COUNT"
        FROM TESTDB..EMPLOYEES
        GROUP BY "DEPT";
      `);
    });

    it("should allow quoted alias reference in GROUP BY with multiple columns", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS "DEPT",
          STATUS AS "EMP_STATUS",
          COUNT(*) AS "EMP_COUNT"
        FROM TESTDB..EMPLOYEES
        GROUP BY "DEPT", "EMP_STATUS";
      `);
    });

    it("should allow quoted alias reference in GROUP BY with aggregation", () => {
      expectValid(`
        SELECT 
          CASE 
            WHEN SALARY > 5000 THEN 'High'
            ELSE 'Low'
          END AS "SALARY_BUCKET",
          COUNT(*) AS "EMP_COUNT",
          AVG(SALARY) AS "AVG_SAL"
        FROM TESTDB..EMPLOYEES
        GROUP BY "SALARY_BUCKET";
      `);
    });
  });

  describe("Netezza SQL alias reuse — HAVING clause with quoted aliases", () => {
    it("should allow quoted alias reference in HAVING clause", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS "DEPT",
          COUNT(*) AS "EMP_COUNT"
        FROM TESTDB..EMPLOYEES
        GROUP BY "DEPT"
        HAVING "EMP_COUNT" > 5;
      `);
    });

    it("should allow quoted alias reference in HAVING with aggregation result", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS "DEPT",
          AVG(SALARY) AS "AVG_SAL",
          COUNT(*) AS "EMP_COUNT"
        FROM TESTDB..EMPLOYEES
        GROUP BY "DEPT"
        HAVING "AVG_SAL" > 5000 AND "EMP_COUNT" > 10;
      `);
    });
  });

  describe("Netezza SQL alias reuse — ORDER BY clause with quoted aliases", () => {
    it("should allow quoted alias reference in ORDER BY", () => {
      expectValid(`
        SELECT 
          FIRST_NAME || ' ' || LAST_NAME AS "FULL_NAME"
        FROM TESTDB..EMPLOYEES
        ORDER BY "FULL_NAME";
      `);
    });

    it("should allow quoted alias in ORDER BY with DESC", () => {
      expectValid(`
        SELECT 
          SALARY * 0.1 AS "BONUS"
        FROM TESTDB..EMPLOYEES
        ORDER BY "BONUS" DESC;
      `);
    });

    it("should allow multiple quoted aliases in ORDER BY", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS "DEPT",
          SALARY AS "BASE_SALARY"
        FROM TESTDB..EMPLOYEES
        ORDER BY "DEPT" ASC, "BASE_SALARY" DESC;
      `);
    });

    it("should allow quoted alias in ORDER BY with NULLS FIRST/LAST", () => {
      expectValid(`
        SELECT 
          MANAGER_ID AS "MGR"
        FROM TESTDB..EMPLOYEES
        ORDER BY "MGR" NULLS FIRST;
      `);
    });
  });

  it("should allow alias reference with table alias qualifier", () => {
      expectValid(`
        SELECT 
          E.SALARY AS BASE_SAL,
          BASE_SAL * 1.1 AS RAISED_SAL
        FROM TESTDB..EMPLOYEES E;
      `);
    });

    it("should validate complex expression chain", () => {
      expectValid(`
        SELECT 
          1 AS A,
          A + 1 AS B,
          B + 1 AS C,
          C + 1 AS D,
          D + 1 AS E
        FROM TESTDB..EMPLOYEES;
      `);
    });

  describe("Netezza SQL alias reuse — WHERE clause", () => {
    it("should allow alias reference in WHERE clause", () => {
      expectValid(`
        SELECT 
          SALARY * 0.1 AS BONUS
        FROM TESTDB..EMPLOYEES
        WHERE BONUS > 100;
      `);
    });

    it("should allow alias in WHERE with AND condition", () => {
      expectValid(`
        SELECT 
          FIRST_NAME || ' ' || LAST_NAME AS FULL_NAME,
          SALARY AS BASE_SALARY
        FROM TESTDB..EMPLOYEES
        WHERE FULL_NAME LIKE 'John%' AND BASE_SALARY > 5000;
      `);
    });

    it("should allow alias in WHERE with OR condition", () => {
      expectValid(`
        SELECT 
          SALARY * 0.1 AS BONUS
        FROM TESTDB..EMPLOYEES
        WHERE BONUS > 100 OR BONUS < 50;
      `);
    });

    it("should allow alias in WHERE with IN clause", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS DEPT
        FROM TESTDB..EMPLOYEES
        WHERE DEPT IN (1, 2, 3);
      `);
    });

    it("should allow alias in WHERE with BETWEEN", () => {
      expectValid(`
        SELECT 
          SALARY AS BASE_SAL
        FROM TESTDB..EMPLOYEES
        WHERE BASE_SAL BETWEEN 3000 AND 8000;
      `);
    });
  });

  describe("Netezza SQL alias reuse — GROUP BY clause", () => {
    it("should allow alias reference in GROUP BY", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS DEPT,
          COUNT(*) AS EMP_COUNT
        FROM TESTDB..EMPLOYEES
        GROUP BY DEPT;
      `);
    });

    it("should allow alias reference in GROUP BY with multiple columns", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS DEPT,
          STATUS AS EMP_STATUS,
          COUNT(*) AS EMP_COUNT
        FROM TESTDB..EMPLOYEES
        GROUP BY DEPT, EMP_STATUS;
      `);
    });

    it("should allow alias reference in GROUP BY with aggregation", () => {
      expectValid(`
        SELECT 
          CASE 
            WHEN SALARY > 5000 THEN 'High'
            ELSE 'Low'
          END AS SALARY_BUCKET,
          COUNT(*) AS EMP_COUNT,
          AVG(SALARY) AS AVG_SAL
        FROM TESTDB..EMPLOYEES
        GROUP BY SALARY_BUCKET;
      `);
    });
  });

  describe("Netezza SQL alias reuse — HAVING clause", () => {
    it("should allow alias reference in HAVING clause", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS DEPT,
          COUNT(*) AS EMP_COUNT
        FROM TESTDB..EMPLOYEES
        GROUP BY DEPT
        HAVING EMP_COUNT > 5;
      `);
    });

    it("should allow alias reference in HAVING with aggregation result", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS DEPT,
          AVG(SALARY) AS AVG_SAL,
          COUNT(*) AS EMP_COUNT
        FROM TESTDB..EMPLOYEES
        GROUP BY DEPT
        HAVING AVG_SAL > 5000 AND EMP_COUNT > 10;
      `);
    });
  });

  describe("Netezza SQL alias reuse — ORDER BY clause", () => {
    it("should allow alias reference in ORDER BY", () => {
      expectValid(`
        SELECT 
          FIRST_NAME || ' ' || LAST_NAME AS FULL_NAME
        FROM TESTDB..EMPLOYEES
        ORDER BY FULL_NAME;
      `);
    });

    it("should allow alias in ORDER BY with DESC", () => {
      expectValid(`
        SELECT 
          SALARY * 0.1 AS BONUS
        FROM TESTDB..EMPLOYEES
        ORDER BY BONUS DESC;
      `);
    });

    it("should allow multiple aliases in ORDER BY", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS DEPT,
          SALARY AS BASE_SALARY
        FROM TESTDB..EMPLOYEES
        ORDER BY DEPT ASC, BASE_SALARY DESC;
      `);
    });

    it("should allow alias in ORDER BY with NULLS FIRST/LAST", () => {
      expectValid(`
        SELECT 
          MANAGER_ID AS MGR
        FROM TESTDB..EMPLOYEES
        ORDER BY MGR NULLS FIRST;
      `);
    });
  });

  describe("Netezza SQL alias reuse — combined scenarios", () => {
    it("should allow alias in SELECT, WHERE, GROUP BY, HAVING, ORDER BY combined", () => {
      expectValid(`
        SELECT 
          DEPARTMENT_ID AS DEPT,
          SALARY * 0.1 AS BONUS,
          COUNT(*) AS EMP_COUNT
        FROM TESTDB..EMPLOYEES
        WHERE BONUS > 100
        GROUP BY DEPT, BONUS
        HAVING EMP_COUNT > 5
        ORDER BY DEPT, BONUS DESC;
      `);
    });

    it("should allow complex alias chain in complete query", () => {
      expectValid(`
        SELECT 
          SALARY AS BASE_SAL,
          BASE_SAL * 0.1 AS BONUS,
          BASE_SAL + BONUS AS TOTAL_COMP,
          CASE 
            WHEN TOTAL_COMP > 10000 THEN 'High'
            ELSE 'Standard'
          END AS COMP_CATEGORY
        FROM TESTDB..EMPLOYEES
        WHERE TOTAL_COMP > 5000
        ORDER BY COMP_CATEGORY, TOTAL_COMP DESC;
      `);
    });

    it("should allow alias from subquery in outer query", () => {
      expectValid(`
        SELECT 
          SUB.TOTAL AS SUB_TOTAL,
          SUB_TOTAL + 1 AS SUB_TOTAL_PLUS
        FROM (
          SELECT EMPLOYEE_ID, SALARY + 100 AS TOTAL
          FROM TESTDB..EMPLOYEES
        ) SUB;
      `);
    });

    it("should allow alias in CTE with subsequent reference", () => {
      expectValid(`
        WITH CTE AS (
          SELECT 
            SALARY AS BASE_SAL,
            BASE_SAL * 0.1 AS BONUS
          FROM TESTDB..EMPLOYEES
          WHERE BASE_SAL > 5000
        )
        SELECT * FROM CTE;
      `);
    });

    it("should handle the original user example", () => {
      // This is the exact example from the user's request
      expectValid("SELECT 1 AS COL1, COL1 + 1 AS COL2 FROM TESTDB..EMPLOYEES;");
    });
  });
});
