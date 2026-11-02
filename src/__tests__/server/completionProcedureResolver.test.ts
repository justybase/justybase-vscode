import { describe, expect, it } from "@jest/globals";

import {
  NZPLSQL_COMPLETION_TABLES,
  resolveProcedureCompletionContext,
  type ProcedureSuggestion,
} from "../../server/completionProcedureResolver";
import { PROCEDURE_MATRIX_CASES } from "../sqlParser/procedure/procedureMatrixCases";
import { NZPLSQL_FORBIDDEN_CONSTRUCTS } from "../sqlParser/procedure/nzplsqlArtifactCases";

const HEADER = "CREATE OR REPLACE PROCEDURE ADMIN.P(INT) RETURNS INT4 LANGUAGE NZPLSQL AS BEGIN_PROC\n";
const REFTABLE_HEADER = "CREATE OR REPLACE PROCEDURE ADMIN.P() RETURNS REFTABLE(ADMIN.T) LANGUAGE NZPLSQL AS BEGIN_PROC\n";

/** Cursor positions covering every branch of the resolver. */
const POSITIONS: readonly string[] = [
  "CREATE OR REPLACE PROCEDURE ADMIN.P(INT) RETURNS ",
  "CREATE OR REPLACE PROCEDURE ADMIN.P(INT) RETURNS INT4 ",
  "CREATE OR REPLACE PROCEDURE ADMIN.P(INT) RETURNS INT4 EXECUTE ",
  "CREATE OR REPLACE PROCEDURE ADMIN.P(INT) RETURNS INT4 EXECUTE AS ",
  "CREATE OR REPLACE PROCEDURE ADMIN.P(INT) RETURNS INT4 LANGUAGE ",
  "CREATE OR REPLACE PROCEDURE ADMIN.P(INT) RETURNS INT4 LANGUAGE NZPLSQL ",
  HEADER,
  `${HEADER}DECLARE\n  `,
  `${HEADER}DECLARE\n  V `,
  `${HEADER}DECLARE\n  V CONSTANT `,
  `${HEADER}BEGIN\n  `,
  `${HEADER}BEGIN\n  RAISE `,
  `${HEADER}BEGIN\n  IF `,
  `${HEADER}BEGIN\n  IF V THEN\n    `,
  `${HEADER}BEGIN\n  <<outer>> LOOP\n    `,
  `${HEADER}BEGIN\n  <<outer>> LOOP\n    EXIT `,
  `${HEADER}BEGIN\n  FOR R IN `,
  `${HEADER}BEGIN\n  EXECUTE `,
  `${HEADER}BEGIN\n  V := 1;\nEXCEPTION\n  `,
  `${HEADER}BEGIN\n  V := 1;\nEXCEPTION\n  WHEN `,
  `${HEADER}BEGIN\n  V := 1;\nEXCEPTION\n  WHEN OTHERS THEN\n    V := 2;\n  `,
  `${HEADER}BEGIN\n  V := 1;\nEXCEPTION\n  WHEN OTHERS THEN\n    RETURN `,
  `${REFTABLE_HEADER}BEGIN\n  RETURN `,
];

function suggestionsAt(prefix: string): ProcedureSuggestion[] {
  return resolveProcedureCompletionContext(prefix, "")?.suggestions ?? [];
}

function labelsAt(prefix: string, typed = ""): string[] {
  return (resolveProcedureCompletionContext(prefix + typed, typed)?.suggestions ?? []).map((item) => item.label);
}

describe("NZPLSQL procedure completion resolver", () => {
  it("offers only constructs proven by a live-verified matrix case", () => {
    const offered = [
      ...Object.values(NZPLSQL_COMPLETION_TABLES).flat(),
      ...POSITIONS.flatMap(suggestionsAt),
    ];
    expect(offered.length).toBeGreaterThan(50);
    const unproven = offered.filter((suggestion) => {
      const proof = PROCEDURE_MATRIX_CASES.find((entry) => entry.id === suggestion.provenBy);
      return !proof || proof.parse !== "accept" || proof.create !== "ok" ||
        (proof.call === "error" && proof.callPhase !== "runtime");
    });
    expect(unproven.map((item) => `${item.label} -> ${item.provenBy}`)).toEqual([]);
  });

  it("never offers a construct Netezza rejects", () => {
    const offered = POSITIONS.flatMap(suggestionsAt).map((item) => `${item.label} ${item.insert ?? ""}`);
    for (const text of offered) {
      for (const { pattern } of NZPLSQL_FORBIDDEN_CONSTRUCTS) {
        expect(`${text} -> ${pattern.test(text)}`).toBe(`${text} -> false`);
      }
    }
    expect(offered.join(" ")).not.toMatch(/\bCURSOR\b|\bPERFORM\b|\bNO_DATA_FOUND\b|RAISE ERROR/);
  });

  it("covers every position", () => {
    for (const prefix of POSITIONS) {
      expect(`${JSON.stringify(prefix)}: ${suggestionsAt(prefix).length > 0}`).toBe(`${JSON.stringify(prefix)}: true`);
    }
  });

  it("closes the innermost open block first", () => {
    expect(labelsAt(`${HEADER}BEGIN\n  IF V THEN\n    V := 1;\n    `).slice(0, 3)).toEqual(["ELSIF", "ELSE", "END IF;"]);
    expect(labelsAt(`${HEADER}BEGIN\n  WHILE V LOOP\n    V := 1;\n    `)[0]).toBe("END LOOP;");
    expect(labelsAt(`${HEADER}BEGIN\n  IF V THEN\n    V := 1;\n  END IF;\n  `).slice(0, 2)).toEqual(["END;", "EXCEPTION"]);
    // A CASE expression's END does not close the block.
    expect(labelsAt(`${HEADER}BEGIN\n  V := CASE WHEN V THEN 1 END;\n  `)[0]).toBe("END;");
  });

  it("offers EXIT inside a loop, also from a nested block", () => {
    const labels = labelsAt(`${HEADER}BEGIN\n  <<retry>> LOOP\n    BEGIN\n      V := 1;\n      `);
    expect(labels.slice(0, 2)).toEqual(["END;", "EXCEPTION"]);
    expect(labels).toEqual(expect.arrayContaining(["EXIT WHEN", "EXIT"]));
    expect(labelsAt(`${HEADER}BEGIN\n  <<retry>> LOOP\n    EXIT `)).toEqual(["WHEN", "retry"]);
  });

  it("keeps SQL completion for SQL clauses and plain statements", () => {
    expect(resolveProcedureCompletionContext(`${HEADER}BEGIN\n  SELECT A INTO V FROM T WHERE `, "")).toBeUndefined();
    expect(resolveProcedureCompletionContext(`${HEADER}BEGIN\n  V := CASE WHEN `, "")).toBeUndefined();
    expect(resolveProcedureCompletionContext("SELECT * FROM T WHERE ", "")).toBeUndefined();
    expect(resolveProcedureCompletionContext(`${HEADER}BEGIN\nEND;\nEND_PROC;\n`, "")).toBeUndefined();
  });

  it("completes record fields from the query that fills the record", () => {
    const declare = "CREATE OR REPLACE PROCEDURE ADMIN.P() RETURNS INT4 LANGUAGE NZPLSQL AS BEGIN_PROC\nDECLARE\n  REC RECORD;\n  R2 RECORD;\n  ROWV ADMIN.T%ROWTYPE;\n";
    expect(labelsAt(`${declare}BEGIN\n  FOR REC IN SELECT t.ID, NAME, COUNT(*) AS CNT, ID + 1 FROM ADMIN.T t GROUP BY 1, 2 LOOP\n    RAISE NOTICE '%', REC.`))
      .toEqual(["ID", "NAME", "CNT"]);
    expect(labelsAt(`${declare}BEGIN\n  SELECT ID, NAME AS LABEL INTO R2 FROM ADMIN.T;\n  RAISE NOTICE '%', R2.`, "LA"))
      .toEqual(["ID", "LABEL"]);
    // Fields unknown (SELECT *, %ROWTYPE): offer nothing rather than SQL keywords.
    expect(labelsAt(`${declare}BEGIN\n  FOR REC IN SELECT * FROM ADMIN.T LOOP\n    RAISE NOTICE '%', REC.`)).toEqual([]);
    expect(resolveProcedureCompletionContext(`${declare}BEGIN\n  V := ROWV.`, "")).toEqual({ suggestions: [], variables: false });
    // A table alias in a SQL statement is not a record.
    expect(resolveProcedureCompletionContext(`${declare}BEGIN\n  SELECT t.`, "")).toBeUndefined();
  });

  it("restricts RAISE arguments to variables", () => {
    const context = resolveProcedureCompletionContext(`${HEADER}BEGIN\n  RAISE NOTICE 'v=%', `, "");
    expect(context).toEqual({ suggestions: [], variables: true });
  });

  it("filters by the typed prefix", () => {
    expect(labelsAt(`${HEADER}BEGIN\n  `, "RA").filter((label) => label.startsWith("RA"))).toEqual(
      ["RAISE NOTICE", "RAISE EXCEPTION", "RAISE DEBUG"],
    );
  });
});
