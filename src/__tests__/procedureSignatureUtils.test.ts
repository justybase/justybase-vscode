import {
  extractProcedureBaseName,
  parseProcedureArgumentNames,
  procedureMatchesCallName,
} from "../metadata/procedureSignatureUtils";

describe("procedureSignatureUtils", () => {
  it("extracts base procedure name from signature", () => {
    expect(extractProcedureBaseName("ADMIN.MY_PROC(INT, VARCHAR)")).toBe(
      "MY_PROC",
    );
  });

  it("parses argument names from procedure signature", () => {
    expect(parseProcedureArgumentNames("MY_PROC(P_ID INTEGER, P_NAME VARCHAR)")).toEqual(
      ["P_ID", "P_NAME"],
    );
  });

  it("parses argument names when types contain nested parentheses", () => {
    expect(
      parseProcedureArgumentNames(
        "MY_PROC(P_AMOUNT DECIMAL(10,2), P_NAME VARCHAR(100))",
      ),
    ).toEqual(["P_AMOUNT", "P_NAME"]);
  });

  it("matches call name against metadata signature", () => {
    expect(
      procedureMatchesCallName("MY_PROC", "ADMIN.MY_PROC(INT, VARCHAR)"),
    ).toBe(true);
    expect(procedureMatchesCallName("OTHER", "ADMIN.MY_PROC(INT)")).toBe(
      false,
    );
  });
});
