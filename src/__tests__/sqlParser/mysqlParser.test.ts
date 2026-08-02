jest.unmock("chevrotain");

import {
  MYSQL_SQL_PARSING_RUNTIME,
  parseSqlStatements,
} from "../../sqlParser/parsingRuntime";
import { mysqlSqlAuthoring } from "../../../extensions/mysql/src/sql/authoring";
import { SqlValidator } from "../../sqlParser/validator";

function parse(sql: string) {
  return parseSqlStatements({ sql, runtime: MYSQL_SQL_PARSING_RUNTIME });
}

describe("MySQL SQL parser", () => {
  it.each([
    "SELECT * FROM TESTDB.departments D WHERE D.manager_id > 0",
    "SELECT * FROM `departments` LIMIT 5, 10",
    "SELECT * FROM departments LIMIT 10 OFFSET 5",
    "SELECT IF(manager_id > 0, 'Y', 'N') FROM departments # MySQL comment",
    "WITH `d` AS (SELECT 1 AS id) SELECT * FROM `d`",
    "INSERT IGNORE INTO TESTDB.departments (id) VALUES (1) ON DUPLICATE KEY UPDATE id = 2",
    "CREATE TABLE IF NOT EXISTS `departments_tmp` (id INT PRIMARY KEY AUTO_INCREMENT, budget DECIMAL(10,2), flags SET('a','b'), CHECK (budget > 0), department_name VARCHAR(100)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  ])("accepts supported MySQL syntax: %s", (sql) => {
    const result = parse(sql);
    expect(result.lexResult.errors).toEqual([]);
    expect(result.actionableParserErrors).toEqual([]);
  });

  it.each([
    "SELECT * FROM TESTDB.TESTDB.departments",
    "SELECT * FROM TESTDB..departments",
  ])("rejects non-MySQL qualification: %s", (sql) => {
    expect(parse(sql).actionableParserErrors.length).toBeGreaterThan(0);
  });

  it("uses strict syntax validation while preserving type-aware diagnostics", () => {
    expect(mysqlSqlAuthoring.validation.syntaxValidationMode).toBe("strict");
    expect(mysqlSqlAuthoring.validation.getTypeSpec("SET")).toBeDefined();
    expect(mysqlSqlAuthoring.validation.getTypeSpec("JSON")).toBeDefined();
    const validator = new SqlValidator(
      {
        getTable: () => ({
          name: "departments",
          database: "TESTDB",
          isCte: false,
          isTempTable: false,
          columns: [{ name: "budget", dataType: "DECIMAL(10,2)" }],
        }),
        tableExists: () => true,
      },
      mysqlSqlAuthoring.validation,
    );
    const result = validator.validate(
      "SELECT * FROM TESTDB.departments WHERE budget = 'not numeric'",
    );
    expect(result.warnings.some((warning) => warning.code === "SQL025")).toBe(true);
  });

  it("recognizes common MySQL functions during strict validation", () => {
    const validator = new SqlValidator(
      {
        getTable: () => ({
          name: "departments",
          database: "TESTDB",
          isCte: false,
          isTempTable: false,
          columns: [],
        }),
        tableExists: () => true,
      },
      mysqlSqlAuthoring.validation,
    );
    const result = validator.validate(
      "SELECT IF(1 = 1, JSON_EXTRACT('{}', '$.id'), NULL) FROM departments",
    );

    expect(result.warnings.some((warning) => warning.code === "SQL011")).toBe(false);
  });

  it("does not emit SQL048 for a complete MySQL database.table reference", () => {
    const proposeTableQualification = jest.fn(() => [{
      database: "TESTDB",
      schema: "TESTDB",
      name: "departments",
      qualifiedText: "TESTDB.departments",
    }]);
    const validator = new SqlValidator(
      {
        getTable: () => ({
          name: "departments",
          database: "TESTDB",
          isCte: false,
          isTempTable: false,
          columns: [],
        }),
        tableExists: () => true,
        proposeTableQualification,
      },
      mysqlSqlAuthoring.validation,
    );

    const result = validator.validate("SELECT * FROM TESTDB.departments");
    expect(result.warnings.some((warning) => warning.code === "SQL048")).toBe(false);
    expect(proposeTableQualification).not.toHaveBeenCalled();
  });
});
