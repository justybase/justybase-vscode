import { jest } from "@jest/globals";
import { afterEach, describe, expect, it } from "@jest/globals";

jest.unmock("chevrotain");

describe("sqlParser performance logging", () => {
  afterEach(() => {
    delete process.env.JUSTYBASE_PARSER_PERF;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it("does not emit self-analysis timing by default", () => {
    const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    jest.isolateModules(() => {
      const { createSqlParserInstance } = require("../../sqlParser/parser");
      createSqlParserInstance();
    });

    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining("performSelfAnalysis"));
  });

  it("emits self-analysis timing only when explicitly enabled", () => {
    process.env.JUSTYBASE_PARSER_PERF = "1";
    const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    jest.isolateModules(() => {
      const { createSqlParserInstance } = require("../../sqlParser/parser");
      createSqlParserInstance();
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("performSelfAnalysis"));
  });
});
