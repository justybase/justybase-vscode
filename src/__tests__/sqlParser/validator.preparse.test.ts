jest.unmock("chevrotain");

import { SqlValidator } from "../../sqlParser/validator";
import { parseSqlStatements } from "../../sqlParser/parsingRuntime";

describe("SqlValidator pre-parse checks", () => {
  it("matches full validation for duplicate keyword checks", () => {
    const sql = "SELECT * FROM FROM CUSTOMER;";
    const validator = new SqlValidator();
    const parseResult = parseSqlStatements({ sql });

    const preParse = validator.runPreParseChecks(parseResult.lexResult);
    const full = validator.validateFromParseResult(sql, parseResult);

    expect(preParse.errors.map((error) => error.code)).toContain("PAR003");
    expect(full.errors.map((error) => error.code)).toContain("PAR003");
  });

  it("matches full validation for keyword typo checks", () => {
    const sql = "SELEC * FROM CUSTOMER;";
    const validator = new SqlValidator();
    const parseResult = parseSqlStatements({ sql });

    const preParse = validator.runPreParseChecks(parseResult.lexResult);
    const full = validator.validateFromParseResult(sql, parseResult);

    expect(preParse.errors.map((error) => error.code)).toContain("PAR004");
    expect(full.errors.map((error) => error.code)).toContain("PAR004");
  });
});
