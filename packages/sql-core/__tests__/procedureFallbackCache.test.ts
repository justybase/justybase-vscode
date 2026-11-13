jest.unmock("chevrotain");

import {
  QualityEngineCore,
  netezzaProcedureQualityRules,
} from "../src/quality";

const parseMock = jest.fn((_options: unknown) => ({
  cst: {},
  lexResult: { errors: [] },
  actionableParserErrors: [],
}));

jest.mock("../src/parser/runtime", () => ({
  ...jest.requireActual("../src/parser/runtime"),
  parseNetezzaSqlStatements: (options: unknown) => parseMock(options),
}));

function procedure(name: string): string {
  return [
    `CREATE OR REPLACE PROCEDURE BENCH.PUBLIC.${name}()`,
    "RETURNS INT",
    "LANGUAGE NZPLSQL AS",
    "BEGIN_PROC",
    "BEGIN",
    "    RETURN 1;",
    "END;",
    "END_PROC;",
  ].join("\n");
}

describe("procedure fallback parse cache", () => {
  const validator = {
    validate: jest.fn(() => ({
      valid: true,
      errors: [],
      warnings: [],
    })),
  };

  beforeEach(() => {
    parseMock.mockClear();
  });

  it("parses a procedure once for all migrated NZP fallback rules", () => {
    const engine = new QualityEngineCore(validator, netezzaProcedureQualityRules);

    engine.analyzeWithOptions(procedure("P_CACHE_ONE"), {
      includeParserDiagnostics: false,
    });

    expect(parseMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a cached parse across evaluations", () => {
    const engine = new QualityEngineCore(validator, netezzaProcedureQualityRules);

    engine.analyzeWithOptions(procedure("P_CACHE_TWO"), {
      includeParserDiagnostics: false,
    });
    engine.analyzeWithOptions(procedure("P_CACHE_THREE"), {
      includeParserDiagnostics: false,
    });

    expect(parseMock).toHaveBeenCalledTimes(2);
  });
});
