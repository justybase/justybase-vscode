jest.unmock("chevrotain");

import * as fs from "fs";
import * as path from "path";
import { SqlVisitor as SharedSqlVisitor } from "@justybase/sql-core/validation/visitor/sqlVisitorCore";
import { SqlVisitor } from "../../sqlParser/visitor/sqlVisitor";
import {
  BASE_SQL_PARSING_RUNTIME,
  NETEZZA_SQL_PARSING_RUNTIME,
} from "../../sqlParser/parsingRuntime";

// The CST visitor lives once, in @justybase/sql-core. A grammar rule needs a visitor method there and
// nowhere else; these tests keep a second copy from growing back under src/sqlParser.
function grammarRuleNames(runtime: typeof NETEZZA_SQL_PARSING_RUNTIME): string[] {
  return Object.keys(runtime.getSqlParserInstance().getGAstProductions());
}

describe("shared SQL visitor", () => {
  it("validates the desktop and sql-core visitors against the shared grammar", () => {
    expect(() => new SharedSqlVisitor()).not.toThrow();
    const visitor = new SqlVisitor();
    expect(visitor).toBeInstanceOf(SharedSqlVisitor);
  });

  it.each([
    ["netezza", NETEZZA_SQL_PARSING_RUNTIME],
    ["base", BASE_SQL_PARSING_RUNTIME],
  ])("has a sql-core method for every %s grammar rule", (_name, runtime) => {
    const prototype = SharedSqlVisitor.prototype as unknown as Record<string, unknown>;
    const missing = grammarRuleNames(runtime).filter(
      (rule) => typeof prototype[rule] !== "function",
    );
    expect(missing).toEqual([]);
  });

  it("overrides only dialect hooks, not grammar rule methods, on the desktop subclass", () => {
    const rules = new Set(grammarRuleNames(NETEZZA_SQL_PARSING_RUNTIME));
    const overriddenRules = Object.getOwnPropertyNames(SqlVisitor.prototype).filter(
      (name) => rules.has(name),
    );
    // Oracle BEGIN blocks are scanned with the desktop Oracle runtime.
    expect(overriddenRules).toEqual(["beginStatement"]);
  });

  it("keeps src/sqlParser/visitor down to the subclass and sql-core re-exports", () => {
    const directory = path.resolve(__dirname, "../../sqlParser/visitor");
    const files = fs.readdirSync(directory).sort();
    expect(files).toEqual(["scopeBuilder.ts", "sqlVisitor.ts", "typeComparisonUtils.ts"]);
    for (const file of ["scopeBuilder.ts", "typeComparisonUtils.ts"]) {
      const code = fs
        .readFileSync(path.join(directory, file), "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.trim().startsWith("//"));
      expect(code).toEqual([
        `export * from "@justybase/sql-core/validation/visitor/${file.replace(/\.ts$/, "")}";`,
      ]);
    }
  });
});

describe("dialect grammar gates on the shared parser", () => {
  const { SqlValidator } = jest.requireActual<typeof import("../../sqlParser/validator")>(
    "../../sqlParser/validator",
  );
  const mysqlProfile = jest.requireActual<typeof import("../../../extensions/mysql/src/sql/authoring")>(
    "../../../extensions/mysql/src/sql/authoring",
  ).mysqlSqlAuthoring.validation;
  const mssqlProfile = jest.requireActual<typeof import("../../../extensions/mssql/src/sql/authoring")>(
    "../../../extensions/mssql/src/sql/authoring",
  ).mssqlSqlAuthoring.validation;
  const oracleProfile = jest.requireActual<typeof import("../../../extensions/oracle/src/sql/authoring")>(
    "../../../extensions/oracle/src/sql/authoring",
  ).oracleSqlAuthoring.validation;
  const parseErrors = (profile: unknown, sql: string): string[] =>
    new SqlValidator(undefined, profile as never)
      .validate(sql)
      .errors.filter((error: { code?: string }) => error.code === "PAR001")
      .map((error: { message: string }) => error.message);

  it.each([
    ["MySQL", mysqlProfile],
    ["MSSQL", mssqlProfile],
  ])("rejects COMMENT ON COLUMN in %s, which has no such statement", (_name, profile) => {
    expect(parseErrors(profile, "COMMENT ON COLUMN t.c IS 'x';").length).toBeGreaterThan(0);
  });

  it("accepts COMMENT ON COLUMN in Oracle and Netezza", () => {
    expect(parseErrors(oracleProfile, "COMMENT ON COLUMN t.c IS 'x';")).toEqual([]);
    expect(
      parseErrors(undefined, "COMMENT ON COLUMN s.t.c IS 'x';"),
    ).toEqual([]);
  });
});
