import type { IToken } from "chevrotain";
import { ProcedureScopeBuilder } from "../../../sqlParser/procedure/procedureScopeBuilder";

function mockToken(image: string, startOffset = 0): IToken {
  return {
    image,
    startOffset,
    endOffset: startOffset + image.length,
    tokenType: { name: "Identifier" },
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: image.length + 1,
  } as IToken;
}

describe("ProcedureScopeBuilder", () => {
  let builder: ProcedureScopeBuilder;

  beforeEach(() => {
    builder = new ProcedureScopeBuilder();
  });

  describe("SQL037", () => {
    it("reports SELECT without INTO in procedure body", () => {
      const selectToken = mockToken("SELECT", 10);
      builder.checkStandaloneSelect(selectToken, false);

      const diagnostics = builder.finalize();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "SQL037",
        severity: "information",
        message: expect.stringContaining("Possibly standalone SELECT"),
      });
      expect(diagnostics[0].token).toBe(selectToken);
    });

    it("does not report SELECT with INTO", () => {
      builder.checkStandaloneSelect(mockToken("SELECT"), true);
      expect(builder.finalize()).toHaveLength(0);
    });
  });

  describe("SQL038", () => {
    it("reports missing RETURN when RETURNS clause is present", () => {
      const returnsToken = mockToken("RETURNS", 5);
      builder.setHasReturns(returnsToken);

      const diagnostics = builder.finalize();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "SQL038",
        severity: "warning",
        message: expect.stringContaining("no RETURN statement"),
      });
      expect(diagnostics[0].token).toBe(returnsToken);
    });

    it("does not report when RETURN statement exists", () => {
      builder.setHasReturns(mockToken("RETURNS"));
      builder.setHasReturn();
      expect(builder.finalize()).toHaveLength(0);
    });
  });

  describe("SQL039", () => {
    it("reports unused declared variables", () => {
      const varToken = mockToken("V_COUNT", 20);
      builder.registerVariable("V_COUNT", varToken);

      const diagnostics = builder.finalize();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "SQL039",
        severity: "information",
        message: "Variable 'V_COUNT' is declared but never used",
      });
      expect(diagnostics[0].token).toBe(varToken);
    });

    it("does not report used variables", () => {
      builder.registerVariable("V_TOTAL", mockToken("V_TOTAL"));
      builder.markNameUsed("V_TOTAL");
      expect(builder.finalize()).toHaveLength(0);
    });
  });

  describe("SQL040", () => {
    it("reports unassigned OUT parameter", () => {
      const paramToken = mockToken("P_RESULT", 30);
      builder.registerParameter("P_RESULT", "OUT", paramToken);

      const diagnostics = builder.finalize();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "SQL040",
        severity: "warning",
        message: "OUT/INOUT parameter 'P_RESULT' is possibly not assigned a value",
      });
      expect(diagnostics[0].token).toBe(paramToken);
    });

    it("reports unassigned INOUT parameter", () => {
      builder.registerParameter("P_VALUE", "INOUT", mockToken("P_VALUE"));
      const diagnostics = builder.finalize();
      expect(diagnostics.some((d) => d.code === "SQL040")).toBe(true);
    });

    it("does not report assigned OUT/INOUT parameters", () => {
      builder.registerParameter("P_RESULT", "OUT", mockToken("P_RESULT"));
      builder.markNameUsed("P_RESULT");
      expect(builder.finalize()).toHaveLength(0);
    });

    it("does not report IN parameters", () => {
      builder.registerParameter("P_INPUT", "IN", mockToken("P_INPUT"));
      expect(builder.finalize()).toHaveLength(0);
    });
  });

  it("reset clears accumulated state", () => {
    builder.registerVariable("V_UNUSED", mockToken("V_UNUSED"));
    builder.setHasReturns(mockToken("RETURNS"));
    builder.reset();

    expect(builder.finalize()).toHaveLength(0);
  });
});
