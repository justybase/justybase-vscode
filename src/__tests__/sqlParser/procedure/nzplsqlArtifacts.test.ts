import { describe, expect, it, jest } from "@jest/globals";

jest.unmock("chevrotain");

import { NetezzaReferenceProvider } from "../../../dialects/netezza/copilot/NetezzaReferenceProvider";
import { procedureTemplates } from "../../../providers/procedureTemplates";
import {
  getSyntaxErrors,
  setupSqlValidatorTests,
  validator,
} from "../validator.test.shared";
import {
  buildNzplsqlArtifactCases,
  expandSnippet,
  isNzplsqlSnippet,
  loadNetezzaSnippets,
  NZPLSQL_ARTIFACT_FIXTURES,
  NZPLSQL_FORBIDDEN_CONSTRUCTS,
  renderNzplsqlArtifactSql,
} from "./nzplsqlArtifactCases";

/**
 * NZPLSQL the product inserts (snippets, wizard templates) and teaches
 * (Copilot reference) must match what a live Netezza accepts. The live
 * counterpart runs CREATE + CALL for every case.
 */
describe("NZPLSQL artifacts", () => {
  setupSqlValidatorTests();

  const names = {
    db: "JUST_DATA",
    schema: "ADMIN",
    procName: "ARTIFACT_PROC",
    tables: Object.fromEntries(Object.keys(NZPLSQL_ARTIFACT_FIXTURES).map((key) => [key, `ARTIFACT_${key}`])),
  };
  const cases = buildNzplsqlArtifactCases();

  it("covers every NZPLSQL snippet and every wizard template", () => {
    const snippetCount = Object.entries(loadNetezzaSnippets())
      .filter(([name, snippet]) => isNzplsqlSnippet(name, snippet)).length;
    expect(snippetCount).toBeGreaterThan(10);
    expect(cases).toHaveLength(snippetCount + procedureTemplates.length);
  });

  for (const testCase of cases) {
    it(`${testCase.source} parses`, () => {
      const result = validator.validate(renderNzplsqlArtifactSql(testCase.sql, names));
      expect(getSyntaxErrors(result)).toEqual([]);
    });
  }

  it("uses no construct Netezza rejects", () => {
    const offenders: string[] = [];
    const check = (source: string, text: string) => {
      for (const { pattern, reason } of NZPLSQL_FORBIDDEN_CONSTRUCTS) {
        if (pattern.test(text)) {
          offenders.push(`${source}: ${reason}`);
        }
      }
    };
    for (const [name, snippet] of Object.entries(loadNetezzaSnippets())) {
      if (isNzplsqlSnippet(name, snippet)) {
        check(`snippet "${name}"`, expandSnippet(snippet.body, {}));
      }
    }
    for (const template of procedureTemplates) {
      check(`template "${template.id}"`, template.template("P", "DB", "S"));
    }
    const reference = new NetezzaReferenceProvider().getNetezzaReference("nzplsql");
    for (const [index, block] of [...reference.matchAll(/```sql\n([\s\S]*?)```/g)].entries()) {
      check(`Copilot reference SQL block ${index + 1}`, block[1]);
    }
    expect(offenders).toEqual([]);
  });

  it("the forbidden list catches the constructs it names", () => {
    const samples = [
      "DECLARE c CURSOR FOR SELECT 1;",
      "EXCEPTION WHEN SQLSTATE '23505' THEN",
      "EXCEPTION WHEN NO_DATA_FOUND THEN",
      "RAISE ERROR 'x %', v;",
      "RAISE NOTICE '%', SQLSTATE;",
      "GET DIAGNOSTICS n = ROW_COUNT;",
      "END CASE;",
      "h := hash8(1);",
      "RETURN SELECT * FROM t;",
    ];
    for (const sample of samples) {
      expect(NZPLSQL_FORBIDDEN_CONSTRUCTS.some(({ pattern }) => pattern.test(sample))).toBe(true);
    }
    expect(NZPLSQL_FORBIDDEN_CONSTRUCTS.some(({ pattern }) => pattern.test(
      "EXCEPTION WHEN TRANSACTION_ABORTED THEN RAISE NOTICE '%', SQLERRM; WHEN OTHERS THEN RETURN 1;",
    ))).toBe(false);
  });
});
