import {
  QualityEngineCore,
  netezzaProcedureQualityRules,
  netezzaSqlQualityRules,
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
});
