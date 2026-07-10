import { describe, expect, it } from "@jest/globals";
import { MarkupKind } from "vscode-languageserver/node";
import {
  buildFunctionCompletionDetail,
  buildFunctionInlineDescription,
  buildFunctionSignatureDocumentation,
} from "../../server/functionCompletionUtils";
import type { DatabaseSqlFunctionSignature } from "../../sql/authoring/types";

describe("functionCompletionUtils", () => {
  const dleDstSignature: DatabaseSqlFunctionSignature = {
    name: "DLE_DST",
    parameters: ["string1", "string2"],
    description:
      "Damerau-Levenshtein edit distance. Transpositions count as one edit.",
    example: "SELECT dle_dst('two', 'tow'); -- returns 1",
  };

  it("builds signature detail instead of generic SQL Function label", () => {
    expect(buildFunctionCompletionDetail([dleDstSignature])).toBe(
      "DLE_DST(string1, string2)",
    );
    expect(buildFunctionCompletionDetail(undefined)).toBe("SQL Function");
  });

  it("builds inline description from first signature", () => {
    expect(buildFunctionInlineDescription([dleDstSignature])).toBe(
      "Damerau-Levenshtein edit distance. Transpositions count as one edit.",
    );
  });

  it("builds markdown documentation with description and example", () => {
    const documentation = buildFunctionSignatureDocumentation([dleDstSignature]);
    expect(documentation?.kind).toBe(MarkupKind.Markdown);
    expect(documentation?.value).toContain("**DLE_DST(string1, string2)**");
    expect(documentation?.value).toContain(
      "Damerau-Levenshtein edit distance. Transpositions count as one edit.",
    );
    expect(documentation?.value).toContain(
      "SELECT dle_dst('two', 'tow'); -- returns 1",
    );
  });
});
