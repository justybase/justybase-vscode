jest.unmock("chevrotain");

import {
  QualityEngineCore,
  getQualityRuleIdForParserCode,
  isParserDiagnosticRuleId,
  netezzaProcedureQualityRules,
  netezzaSqlQualityRules,
  parseQualitySeverity,
} from "../src/quality";
import { NetezzaSqlSemanticValidator } from "../src/validation";

describe("Netezza sql-core quality", () => {
  it("uses the native validator and preserves parser-owned diagnostics", () => {
    const validator = new NetezzaSqlSemanticValidator();
    const engine = new QualityEngineCore(validator, netezzaSqlQualityRules);
    const result = engine.analyze("SELECT 1,,2;");

    expect(result.parserResult.errors.some((error) => error.code === "PAR002")).toBe(true);
    expect(result.issues.some((issue) => issue.ruleId === "NZ021")).toBe(false);
  });

  it("keeps comments and strings out of quality diagnostics", () => {
    const validator = new NetezzaSqlSemanticValidator();
    const engine = new QualityEngineCore(validator, netezzaSqlQualityRules);

    expect(engine.analyzeQualityRulesOnly("SELECT * FROM t -- LIKE '%x'\n").issues.some((issue) => issue.ruleId === "NZ005")).toBe(false);
    expect(engine.analyzeQualityRulesOnly("SELECT * FROM t WHERE id = 1 ORDER BY id -- LIMIT 10").issues.some((issue) => issue.ruleId === "NZ006")).toBe(true);
    expect(engine.analyzeQualityRulesOnly("SELECT * FROM t WHERE id = 1 ORDER BY id LIMIT 10").issues.some((issue) => issue.ruleId === "NZ006")).toBe(false);
    expect(engine.analyzeQualityRulesOnly("SELECT 'say \\\"hello\\\"' FROM t").issues.some((issue) => issue.ruleId === "NZ017")).toBe(false);
    expect(engine.analyzeQualityRulesOnly('SELECT "MixedCase" FROM t').issues.some((issue) => issue.ruleId === "NZ017")).toBe(true);
  });

  it("does not scan DECLARE values as SQL quality rules", () => {
    const validator = new NetezzaSqlSemanticValidator();
    const engine = new QualityEngineCore(validator, netezzaSqlQualityRules);
    const result = engine.analyzeQualityRulesOnly(
      "DECLARE &QUERY_TEXT = 'SELECT * FROM t ORDER BY id'; SELECT * FROM t ORDER BY id;",
    );

    expect(result.issues.filter((issue) => issue.ruleId === "NZ006")).toHaveLength(1);
  });

  it("publishes the complete procedure rule inventory with on-demand flags", () => {
    const ids = netezzaProcedureQualityRules.map((rule) => rule.id);
    expect(ids).toEqual(expect.arrayContaining([
      "NZP001", "NZP002", "NZP003", "NZP004", "NZP005", "NZP006",
      "NZP007", "NZP008", "NZP009", "NZP010", "NZP011", "NZP012",
      "NZP013", "NZP014", "NZP015", "NZP016", "NZP017", "NZP018",
      "NZP019", "NZP020", "NZP022", "NZP023", "NZP024", "NZP025",
      "NZP026", "NZP027", "NZP028", "NZP029", "NZP030",
    ]));
    expect(netezzaProcedureQualityRules.find((rule) => rule.id === "NZP009")?.onDemandOnly).toBe(true);
    expect(netezzaProcedureQualityRules.find((rule) => rule.id === "NZP001")?.onDemandOnly).toBe(false);
  });

  it("maps parser settings and diagnostic severities", () => {
    expect(getQualityRuleIdForParserCode("SQL043")).toBe("NZ002");
    expect(getQualityRuleIdForParserCode("UNKNOWN")).toBeUndefined();
    expect(isParserDiagnosticRuleId("PAR005")).toBe(true);
    expect(isParserDiagnosticRuleId("NZ005")).toBe(false);
    expect(parseQualitySeverity("error")).toBe(0);
    expect(parseQualitySeverity("warning")).toBe(1);
    expect(parseQualitySeverity("information")).toBe(2);
    expect(parseQualitySeverity("hint")).toBe(3);
    expect(parseQualitySeverity("off")).toBeNull();
  });

  it("honors parser-result overrides and disabled rules", () => {
    const validator = new NetezzaSqlSemanticValidator();
    const engine = new QualityEngineCore(validator, netezzaSqlQualityRules);
    const parserResult = validator.validate("SELECT 1");
    expect(engine.analyzeWithOptions("SELECT 1", {
      parserResult,
      rulesConfig: { NZ005: "off" },
      includeParserDiagnostics: false,
    }).issues.some((issue) => issue.ruleId === "NZ005")).toBe(false);
  });
});
