jest.unmock("chevrotain");

import { SqlValidator } from "../sqlParser";
import {
  ruleNZ002,
  ruleNZ003,
  ruleNZ011,
  ruleNZ012,
  ruleNZ019,
  ruleNZ021,
  ruleNZ022,
} from "../providers/linterRules";
import { ruleNZP001, ruleNZP009 } from "../providers/procedureRules";
import {
  isParserDiagnosticRuleId,
  SqlQualityEngine,
} from "../providers/sqlQualityEngine";

describe("SqlQualityEngine unified diagnostics", () => {
  const validator = new SqlValidator();
  const engine = new SqlQualityEngine(validator, []);

  it("identifies parser diagnostic rule ids", () => {
    expect(isParserDiagnosticRuleId("SQL003")).toBe(true);
    expect(isParserDiagnosticRuleId("PAR002")).toBe(true);
    expect(isParserDiagnosticRuleId("NZ001")).toBe(false);
  });

  it("analyzeQualityRulesOnly skips parser diagnostics", () => {
    const sql = "SELECT * FORM broken_table;";
    const full = engine.analyze(sql);
    const qualityOnly = engine.analyzeQualityRulesOnly(sql);

    expect(
      full.issues.some((issue) => isParserDiagnosticRuleId(issue.ruleId)),
    ).toBe(true);
    expect(
      qualityOnly.issues.some((issue) => issue.ruleId.startsWith("SQL")),
    ).toBe(false);
    expect(qualityOnly.parserResult.errors).toHaveLength(0);
  });

  it("skips NZP quality rules for plain SQL without CREATE PROCEDURE", () => {
    const nzpCheck = jest.spyOn(ruleNZP001, "check");
    const sqlEngine = new SqlQualityEngine(validator, [ruleNZP001]);

    sqlEngine.analyzeQualityRulesOnly("SELECT * FROM users;");

    expect(nzpCheck).not.toHaveBeenCalled();
    nzpCheck.mockRestore();
  });

  it("skips on-demand procedure heuristics during automatic quality analysis", () => {
    const sql = `CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_STYLE()
RETURNS INTEGER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`;
    const sqlEngine = new SqlQualityEngine(validator, [ruleNZP009]);

    const automatic = sqlEngine.analyzeQualityRulesOnly(sql);
    const onDemand = sqlEngine.analyzeQualityRulesOnly(sql, {}, true);

    expect(automatic.issues.some((issue) => issue.ruleId === "NZP009")).toBe(false);
    expect(onDemand.issues.some((issue) => issue.ruleId === "NZP009")).toBe(true);
  });

  it("does not emit NZ021 when parser-owned PAR002 covers double commas", () => {
    const sql = "SELECT 1,,2;";
    const parserOwnedEngine = new SqlQualityEngine(validator, [ruleNZ021]);
    const full = parserOwnedEngine.analyze(sql);
    const qualityOnly = parserOwnedEngine.analyzeQualityRulesOnly(sql);

    expect(full.issues.some((issue) => issue.ruleId === "PAR002")).toBe(true);
    expect(full.issues.some((issue) => issue.ruleId === "NZ021")).toBe(false);
    expect(qualityOnly.issues.some((issue) => issue.ruleId === "NZ021")).toBe(
      false,
    );
  });

  it("does not emit migrated NZ rules when parser diagnostics own them", () => {
    const migratedRules = [
      ruleNZ002,
      ruleNZ003,
      ruleNZ011,
      ruleNZ012,
      ruleNZ019,
      ruleNZ022,
    ];
    const parserOwnedEngine = new SqlQualityEngine(validator, migratedRules);
    const cases = [
      { sql: "DELETE FROM TESTDB..EMPLOYEES;", parserCode: "SQL043", nzCode: "NZ002" },
      { sql: "UPDATE TESTDB..EMPLOYEES SET SALARY = SALARY + 1;", parserCode: "SQL044", nzCode: "NZ003" },
      { sql: "CREATE TABLE EMP_COPY AS SELECT * FROM TESTDB..EMPLOYEES;", parserCode: "SQL045", nzCode: "NZ011" },
      { sql: "UPDATE TESTDB..EMPLOYEES AS E SET SALARY = SALARY + 1 WHERE EMPLOYEE_ID = 1;", parserCode: "SQL046", nzCode: "NZ012" },
      { sql: "SELECT CASE WHEN 1 = 1 THEN 1 FROM TESTDB..EMPLOYEES;", parserCode: "PAR005", nzCode: "NZ019" },
      { sql: "SELECT 1 WHERE 1 = 1;", parserCode: "SQL042", nzCode: "NZ022" },
    ];

    for (const { sql, parserCode, nzCode } of cases) {
      const full = parserOwnedEngine.analyze(sql);
      const qualityOnly = parserOwnedEngine.analyzeQualityRulesOnly(sql);

      expect(full.issues.some((issue) => issue.ruleId === parserCode)).toBe(true);
      expect(full.issues.some((issue) => issue.ruleId === nzCode)).toBe(false);
      expect(qualityOnly.issues.some((issue) => issue.ruleId === nzCode)).toBe(false);
    }
  });

  it("honors NZ023 off for parser-owned SQL048 diagnostics", () => {
    const qualificationValidator = new SqlValidator({
      getTable: jest.fn(() => undefined),
      tableExists: jest.fn(() => true),
      canValidateUnqualifiedTableReferences: jest.fn(() => true),
      proposeTableQualification: jest.fn(() => [
        {
          database: "DB1",
          schema: "PUBLIC",
          name: "EMPLOYEES",
          qualifiedText: "DB1.PUBLIC.EMPLOYEES",
          isPreferred: true,
        },
      ]),
    });
    const sqlEngine = new SqlQualityEngine(qualificationValidator, []);
    const sql = "SELECT * FROM EMPLOYEES;";
    const enabled = sqlEngine.analyze(sql);
    const disabled = sqlEngine.analyze(sql, { NZ023: "off" });

    expect(enabled.issues.some((issue) => issue.ruleId === "SQL048")).toBe(true);
    expect(disabled.issues.some((issue) => issue.ruleId === "SQL048")).toBe(false);
  });
});
