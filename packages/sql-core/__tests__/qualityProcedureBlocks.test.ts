jest.unmock("chevrotain");

import { netezzaProcedureQualityRules } from "../src/quality";
import { measureProceduralBlocks } from "../src/quality/rules";

type ProcedureRule = (typeof netezzaProcedureQualityRules)[number];

function rule(id: string): ProcedureRule {
  const found = netezzaProcedureQualityRules.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`missing rule ${id}`);
  }
  return found;
}

/**
 * `PERFORM` is rejected by the NZPLSQL grammar, so the parser gate keeps the
 * structural regex fallback active for every body below.
 */
function procedure(body: string): string {
  return `CREATE OR REPLACE PROCEDURE ADMIN.P()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE v INT;
BEGIN
  PERFORM 1;
  ${body}
END;
END_PROC;`;
}

describe("procedural BEGIN/END and CASE balance", () => {
  it("counts a plain BEGIN block", () => {
    expect(measureProceduralBlocks("BEGIN\n  v := 1;\nEND;")).toEqual({
      begins: 1,
      ends: 1,
      unmatchedCases: 0,
    });
  });

  it("treats END IF, END LOOP, END CASE and END_PROC as non-block terminators", () => {
    const body = "BEGIN_PROC BEGIN IF v = 1 THEN v := 1; END IF; END; END_PROC;";
    expect(measureProceduralBlocks(body)).toEqual({
      begins: 1,
      ends: 1,
      unmatchedCases: 0,
    });
  });

  it("matches CASE expressions before block END tokens", () => {
    const body = [
      "BEGIN",
      "  v := CASE WHEN 1 = 1 THEN 1 ELSE 0 END + 1;",
      "  v := (CASE WHEN 1 = 1 THEN 1 ELSE 0 END)::INT;",
      "  SELECT CASE v WHEN 1 THEN 1 ELSE 0 END INTO v FROM (SELECT 1 AS X) T;",
      "  UPDATE T SET C = CASE WHEN 1 = 1 THEN 1 ELSE 0 END WHERE ID = 1;",
      "END;",
    ].join("\n");
    expect(measureProceduralBlocks(body)).toEqual({
      begins: 1,
      ends: 1,
      unmatchedCases: 0,
    });
  });

  it("reports an unmatched CASE before it can consume the block END", () => {
    const body = "BEGIN\n  v := CASE WHEN 1 = 1 THEN 1 ELSE 0;\n  v := 2;\nEND;";
    expect(measureProceduralBlocks(body)).toEqual({
      begins: 1,
      ends: 1,
      unmatchedCases: 1,
    });
  });

  it("reports an unmatched BEGIN", () => {
    const body = "BEGIN\n  BEGIN\n  v := 1;\nEND;";
    expect(measureProceduralBlocks(body)).toMatchObject({
      begins: 2,
      ends: 1,
      unmatchedCases: 0,
    });
  });
});

describe("NZP004 fallback counting", () => {
  const nzp004 = rule("NZP004");

  it.each([
    [
      "CASE expressions with arithmetic, casts and WHERE",
      "v := CASE WHEN 1 = 1 THEN 1 ELSE 0 END + 1;\n  UPDATE T SET C = CASE WHEN 1 = 1 THEN 1 ELSE 0 END WHERE ID = 1;",
    ],
    [
      "CASE expressions in nested BEGIN blocks",
      "BEGIN\n    v := CASE WHEN 1 = 1 THEN 1 ELSE 0 END;\n  END;",
    ],
    [
      "IF/ELSIF/ELSEIF with multiple spaces before END IF",
      "IF v = 1 THEN\n    v := 1;\n  ELSIF v = 2 THEN\n    v := 2;\n  ELSEIF v = 3 THEN\n    v := 3;\n  END   IF;",
    ],
    [
      "BEGIN/END keywords inside strings and comments",
      "RAISE NOTICE 'BEGIN CASE END IF END';\n  -- BEGIN END CASE END\n  /* CASE WHEN 1=1 THEN 1 END */",
    ],
  ])("does not flag %s", (_label, body) => {
    expect(nzp004.check(procedure(body))).toHaveLength(0);
  });

  it.each([
    ["a missing block END", "BEGIN\n    v := 1;"],
    ["an extra block END", "END;\n  v := 1;"],
  ])("flags %s", (_label, body) => {
    expect(nzp004.check(procedure(body)).map((issue) => issue.ruleId)).toContain("NZP004");
  });
});

describe("NZP005/NZP006 fallback counting", () => {
  const nzp005 = rule("NZP005");
  const nzp006 = rule("NZP006");

  it("accepts an IF/ELSIF/ELSEIF chain", () => {
    const body =
      "IF v = 1 THEN\n    v := 1;\n  ELSIF v = 2 THEN\n    v := 2;\n  ELSEIF v = 3 THEN\n    v := 3;\n  ELSE\n    v := 0;\n  END   IF;";
    expect(nzp005.check(procedure(body))).toHaveLength(0);
  });

  it("accepts WHILE/FOR loops with END LOOP", () => {
    const body =
      "WHILE v < 3 LOOP\n    v := v + 1;\n  END   LOOP;\n  FOR i IN 1..3 LOOP\n    v := v + i;\n  END LOOP;";
    expect(nzp006.check(procedure(body))).toHaveLength(0);
  });

  it("flags a missing END IF and a missing END LOOP", () => {
    expect(
      nzp005.check(procedure("IF v = 1 THEN\n    v := 1;")).map((issue) => issue.ruleId),
    ).toContain("NZP005");
    expect(
      nzp006.check(procedure("WHILE v < 3 LOOP\n    v := v + 1;")).map((issue) => issue.ruleId),
    ).toContain("NZP006");
  });
});

describe("NZP017 fallback counting", () => {
  const nzp017 = rule("NZP017");

  it.each([
    [
      "nested CASE expressions and simple CASE selectors",
      "v := CASE WHEN 1 = 1 THEN CASE WHEN 2 = 2 THEN 2 ELSE 0 END + 1 ELSE 0 END;\n  v := CASE (v) WHEN 1 THEN 1 ELSE 0 END;\n  v := CASE WHEN v IS NULL THEN 0 ELSE v END::INT;",
    ],
    ["CASE in a WHERE predicate", "SELECT COUNT(*) INTO v FROM (SELECT 1 AS X) T WHERE CASE WHEN 1 = 1 THEN 1 ELSE 0 END = 1;"],
    ["CASE in DECLARE defaults", "v := CASE WHEN 1 = 1 THEN 1 ELSE 0 END;"],
  ])("does not flag %s", (_label, body) => {
    expect(nzp017.check(procedure(body))).toHaveLength(0);
  });

  it("flags an unmatched CASE expression", () => {
    const body = "v := CASE WHEN 1 = 1 THEN 1 ELSE 0;\n  v := 2;";
    expect(nzp017.check(procedure(body)).map((issue) => issue.ruleId)).toContain("NZP017");
  });
});
