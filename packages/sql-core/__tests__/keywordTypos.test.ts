jest.unmock("chevrotain");

import type { IToken } from "chevrotain";
import {
  CLAUSE_KEYWORDS,
  COMMON_KEYWORD_TYPOS,
  SQL_TYPO_KEYWORDS,
  collectKeywordTypos,
  isSingleEditAway,
} from "../src/validation/keywordTypos";
import { parseNetezzaSqlStatements } from "../src/validation";
import type { ValidationError } from "../src/validation/types";

/**
 * Reference implementation of the pre-optimization algorithm. Kept verbatim
 * (apart from types) so the optimized helper can be compared against it.
 */
function referenceLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  const dp: number[][] = Array.from({ length: al + 1 }, () => Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[al][bl];
}

const REFERENCE_SQL_KEYWORDS = new Set(SQL_TYPO_KEYWORDS);

function referenceDetectKeywordTypos(tokens: readonly IToken[]): ValidationError[] {
  const results: ValidationError[] = [];
  const commonTypos = COMMON_KEYWORD_TYPOS;
  const clauseKeywords = CLAUSE_KEYWORDS;

  for (const token of tokens) {
    if (token.tokenType.name !== "Identifier" && token.tokenType.name !== "Word") {
      continue;
    }

    const image = token.image;
    if (!image || image.length < 3) continue;

    const upper = image.toUpperCase();
    if (REFERENCE_SQL_KEYWORDS.has(upper)) continue;

    const dictFix = commonTypos[upper];
    if (dictFix) {
      const startOffset = token.startOffset ?? 0;
      const imageLen = token.image?.length ?? 1;
      const startCol = token.startColumn ?? 1;
      const startLn = token.startLine ?? 1;
      results.push({
        message: `Possible typo: '${image}' looks like keyword '${dictFix}'. Did you mean '${dictFix}'?`,
        severity: "error",
        position: {
          startLine: startLn,
          startColumn: startCol,
          endLine: startLn,
          endColumn: startCol + imageLen,
          offset: startOffset,
        },
        code: "PAR004",
        suggestedFix: dictFix,
      });
      continue;
    }

    if (image.length < 4) continue;

    for (const kw of clauseKeywords) {
      if (referenceLevenshtein(upper, kw) === 1 && image.length <= kw.length) {
        const startOffset = token.startOffset ?? 0;
        const imageLen = token.image?.length ?? 1;
        const startCol = token.startColumn ?? 1;
        const startLn = token.startLine ?? 1;
        results.push({
          message: `Possible typo: '${image}' looks like keyword '${kw}'. Did you mean '${kw}'?`,
          severity: "error",
          position: {
            startLine: startLn,
            startColumn: startCol,
            endLine: startLn,
            endColumn: startCol + imageLen,
            offset: startOffset,
          },
          code: "PAR004",
          suggestedFix: kw,
        });
        break;
      }
    }
  }

  return results;
}

/** Deterministic PRNG so the property test is reproducible. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(random: () => number, maxLength: number): string {
  const alphabet = "ABCDEFG";
  const length = Math.floor(random() * (maxLength + 1));
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += alphabet[Math.floor(random() * alphabet.length)];
  }
  return result;
}

describe("isSingleEditAway", () => {
  it("matches levenshtein(a, b) === 1 on random strings", () => {
    const random = createRandom(0x5eed);
    for (let iteration = 0; iteration < 5000; iteration += 1) {
      const a = randomString(random, 8);
      const b = randomString(random, 8);
      expect([a, b, isSingleEditAway(a, b)]).toEqual([
        a,
        b,
        referenceLevenshtein(a, b) === 1,
      ]);
    }
  });

  it("handles empty and one-character strings", () => {
    expect(isSingleEditAway("", "A")).toBe(true);
    expect(isSingleEditAway("A", "")).toBe(true);
    expect(isSingleEditAway("", "")).toBe(false);
    expect(isSingleEditAway("A", "A")).toBe(false);
    expect(isSingleEditAway("A", "AB")).toBe(true);
    expect(isSingleEditAway("AB", "A")).toBe(true);
    expect(isSingleEditAway("AB", "BA")).toBe(false);
    expect(isSingleEditAway("AB", "ABC")).toBe(true);
  });
});

describe("collectKeywordTypos", () => {
  it("keeps the exact known typo table behavior", () => {
    const sql = [
      "SELEC * FRM t",
      "WHERE a = 1",
      "AND FOM b = 2",
      "AND FRO c = 3",
      "AND FORM d = 4",
      "AND OFRM e = 5",
      "AND FRXM f = 6",
      "AND SELCT g = 7",
      "AND SELET h = 8",
      "AND SELKT i = 9",
      "AND SELCET j = 10",
      "AND SLEECT k = 11",
      "AND SELELCT l = 12",
      "AND SELEECT m = 13",
    ].join("\n");
    const { lexResult } = parseNetezzaSqlStatements({ sql });

    const diagnostics = collectKeywordTypos(lexResult.tokens);
    expect(diagnostics).toEqual(referenceDetectKeywordTypos(lexResult.tokens));
    expect(diagnostics.map((diagnostic) => diagnostic.suggestedFix)).toEqual([
      "SELECT",
      "FROM",
      "FROM",
      "FROM",
      "FROM",
      "FROM",
      "FROM",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
    ]);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toBe("PAR004");
      expect(diagnostic.severity).toBe("error");
    }
  });

  it("does not report identifiers that are not exactly one edit away", () => {
    const sql = [
      "SELECT SELECTO, SELECTED, FROMX, SELCXT, FROMX, ABCD",
      "FROM some_table",
      "WHERE value = 1",
    ].join("\n");
    const { lexResult } = parseNetezzaSqlStatements({ sql });

    expect(collectKeywordTypos(lexResult.tokens)).toEqual([]);
    expect(referenceDetectKeywordTypos(lexResult.tokens)).toEqual([]);
  });

  it("matches the reference implementation on real procedure tokens", () => {
    const lines = [
      "CREATE OR REPLACE PROCEDURE BENCH.PUBLIC.P(A INT)",
      "RETURNS INT",
      "LANGUAGE NZPLSQL AS",
      "BEGIN_PROC",
      "DECLARE",
      "    v_total INT;",
      "BEGIN",
      "    v_total := 0;",
    ];
    for (let block = 0; block < 40; block += 1) {
      lines.push(`    v_total := v_total + ${block % 7};`);
      lines.push(`    SELEC * FRM BENCH..T${block % 5} WHERE ID = ${block};`);
      lines.push("    INSERT INTO BENCH..T1 VALUES (1);");
    }
    lines.push("    RETURN v_total;", "END;", "END_PROC;");
    const sql = lines.join("\n");
    const { lexResult } = parseNetezzaSqlStatements({ sql });

    const optimized = collectKeywordTypos(lexResult.tokens);
    const reference = referenceDetectKeywordTypos(lexResult.tokens);
    expect(optimized).toEqual(reference);
    expect(optimized).toHaveLength(80);
    expect(optimized[0]?.message).toContain("'SELEC'");
    expect(optimized[1]?.message).toContain("'FRM'");
  });

  it("reports every repeated occurrence with its own offset", () => {
    const sql = "SELEC a, a, a FRM t;";
    const { lexResult } = parseNetezzaSqlStatements({ sql });

    const diagnostics = collectKeywordTypos(lexResult.tokens);
    expect(diagnostics).toEqual(referenceDetectKeywordTypos(lexResult.tokens));
    expect(diagnostics.map((diagnostic) => diagnostic.position.offset)).toEqual([
      sql.indexOf("SELEC"),
      sql.indexOf("FRM"),
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.suggestedFix)).toEqual([
      "SELECT",
      "FROM",
    ]);
  });

  it("returns the same result when called repeatedly", () => {
    const { lexResult } = parseNetezzaSqlStatements({ sql: "SELEC * FRM t;" });
    const first = collectKeywordTypos(lexResult.tokens);
    const second = collectKeywordTypos(lexResult.tokens);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("does not report exact keywords regardless of case", () => {
    const { lexResult } = parseNetezzaSqlStatements({
      sql: "select * from t where id in (1) order by id;",
    });
    expect(collectKeywordTypos(lexResult.tokens)).toEqual([]);
  });
});
