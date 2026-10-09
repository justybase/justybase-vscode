jest.unmock("chevrotain");
import type { CstNode, IToken } from "chevrotain";
import {
  AUTHORING_RECOVERY_MAX_REPAIRS,
  isAuthoringRecoveryPlaceholder,
  parseNetezzaSqlForAuthoringRecovery,
  parseNetezzaSqlStatements,
  sanitizeNetezzaSql,
} from "../src/parser/runtime";
import { SqlLexer } from "../src/netezza/lexer";
import { SqlColumnIdentityAnalysis, type SqlColumnCatalogLookup } from "../src/validation/columnIdentity";
import { resolveSqlColumnCatalogTarget } from "../src/validation/columnAuthoring";

/*
 * Property-style regression tests for authoring recovery on incomplete SQL.
 * Variants are generated deterministically from seed queries; every variant
 * must satisfy the recovery invariants, whether or not it recovers.
 */

const TABLES: Record<string, string[]> = {
  CUSTOMERS: ["CUSTOMER_ID", "CUSTOMER_NAME", "EMAIL"],
  ORDERS: ["ORDER_ID", "CUSTOMER_ID", "ORDER_DATE"],
};
const lookup: SqlColumnCatalogLookup = (_database, _schema, table) => {
  const columns = TABLES[table.toUpperCase()];
  return columns ? { database: "JUST_DATA", schema: "SALES", name: table.toUpperCase(), columns } : undefined;
};

const SEEDS = [
  // UTF-16 astral and Polish text before the columns.
  "SELECT 'zażółć 😀' AS TXT, C.CUSTOMER_ID FROM JUST_DATA.SALES.CUSTOMERS C WHERE C.CUSTOMER_ID > 0",
  // CRLF line breaks.
  "SELECT C.CUSTOMER_ID,\r\n       C.EMAIL\r\nFROM JUST_DATA.SALES.CUSTOMERS C\r\nWHERE C.EMAIL IS NOT NULL",
  // CTE with an output alias, used by the outer query.
  "WITH X AS (SELECT CUSTOMER_ID AS CID FROM JUST_DATA.SALES.CUSTOMERS) SELECT X.CID FROM X WHERE X.CID > 0",
  // Derived table and join.
  "SELECT D.CID, O.ORDER_DATE FROM (SELECT CUSTOMER_ID AS CID FROM JUST_DATA.SALES.CUSTOMERS) D JOIN JUST_DATA.SALES.ORDERS O ON O.CUSTOMER_ID = D.CID",
  // Two statements: scope must not leak between them.
  "SELECT C.CUSTOMER_NAME FROM JUST_DATA.SALES.CUSTOMERS C; SELECT O.ORDER_ID FROM JUST_DATA.SALES.ORDERS O WHERE O.ORDER_ID > 1",
];

/** Explicit incomplete forms named by the hardening task. */
const NAMED_INCOMPLETE = [
  "SELECT C.CUSTOMER_ID, FROM JUST_DATA.SALES.CUSTOMERS C WHERE C.CUSTOMER_ID > 0", // extra comma
  "SELECT C.CUSTOMER_ID FROM JUST_DATA.SALES.CUSTOMERS C WHERE C.", // alias.
  "SELECT C.CUSTOMER_ID FROM JUST_DATA.SALES.CUSTOMERS C WHERE ", // unfinished WHERE
  "SELECT C.CUSTOMER_ID FROM JUST_DATA.SALES.CUSTOMERS C WHERE C.CUSTOMER_ID =", // unfinished WHERE operand
  "SELECT D.CID FROM (SELECT CUSTOMER_ID AS CID FROM JUST_DATA.SALES.CUSTOMERS D WHERE D.CID > 0", // missing )
  "WITH X AS (SELECT CUSTOMER_ID AS FROM JUST_DATA.SALES.CUSTOMERS) SELECT * FROM X", // CTE missing alias
  "WITH X AS (SELECT CUSTOMER_ID AS CID FROM JUST_DATA.SALES.CUSTOMERS SELECT X.CID FROM X", // CTE missing )
  "SELECT 'zażółć 😀' AS TXT, C.CUSTOMER_ID,\r\nFROM JUST_DATA.SALES.CUSTOMERS C\r\nWHERE C.", // emoji + CRLF + comma + alias.
];

function realTokens(sql: string): IToken[] {
  return SqlLexer.tokenize(sanitizeNetezzaSql(sql)).tokens;
}

function cstTokens(node: CstNode, out: IToken[] = []): IToken[] {
  for (const value of Object.values(node.children ?? {})) {
    for (const child of value as Array<CstNode | IToken>) {
      if ("image" in child) out.push(child);
      else cstTokens(child, out);
    }
  }
  return out;
}

/** Deterministic variants: prefix truncation at every token boundary, single-token deletion, comma insertion. */
function variants(seed: string): string[] {
  const tokens = realTokens(seed);
  const result = new Set<string>();
  for (const token of tokens) {
    result.add(seed.slice(0, token.startOffset));
    result.add(seed.slice(0, token.endOffset! + 1));
    result.add(seed.slice(0, token.startOffset) + seed.slice(token.endOffset! + 1));
    result.add(seed.slice(0, token.endOffset! + 1) + "," + seed.slice(token.endOffset! + 1));
  }
  return [...result];
}

const ALL = [...SEEDS.flatMap(variants), ...NAMED_INCOMPLETE];

function relationNames(sql: string): Set<string> {
  return new Set(realTokens(sql).map(token => token.image.replace(/^"|"$/g, "").toUpperCase()));
}

describe("authoring recovery invariants", () => {
  it("generates a substantial deterministic variant set", () => {
    expect(ALL.length).toBeGreaterThan(300);
  });

  it("never moves, drops or rewrites a real token and inserts only bounded placeholders", () => {
    for (const sql of ALL) {
      const cst = parseNetezzaSqlForAuthoringRecovery(sql);
      if (!cst) continue;
      const real = new Map(realTokens(sql).map(token => [token.startOffset, token]));
      const seen = cstTokens(cst);
      const placeholders = seen.filter(isAuthoringRecoveryPlaceholder);
      expect(placeholders.length).toBeLessThanOrEqual(AUTHORING_RECOVERY_MAX_REPAIRS);
      for (const token of seen) {
        if (isAuthoringRecoveryPlaceholder(token)) {
          expect(token.endOffset).toBe(token.startOffset - 1);
          continue;
        }
        const original = real.get(token.startOffset);
        expect(original?.image).toBe(token.image);
        expect(original?.endOffset).toBe(token.endOffset);
      }
    }
  });

  it("never turns a placeholder into a column occurrence, symbol or target", () => {
    for (const sql of ALL) {
      const analysis = SqlColumnIdentityAnalysis.analyze(sql, lookup);
      if (!analysis) continue;
      const names = relationNames(sql);
      for (let offset = 0; offset <= sql.length; offset++) {
        const identity = analysis.identityAt(offset);
        if (!identity) continue;
        expect(identity.name).not.toBe("");
        for (const occurrence of identity.occurrences) {
          expect(occurrence.endOffset).toBeGreaterThan(occurrence.startOffset);
          expect(sql.slice(occurrence.startOffset, occurrence.endOffset).trim()).not.toBe("");
        }
        for (const column of [identity.catalog, identity.origin, resolveSqlColumnCatalogTarget(identity)]) {
          if (!column) continue;
          expect(column.relation).not.toBe("");
          expect(column.column).not.toBe("");
          // A catalog/origin target names a relation and column written in the text.
          expect(names.has(column.relation.toUpperCase())).toBe(true);
          expect(names.has(column.column.toUpperCase())).toBe(true);
        }
      }
    }
  });

  it("keeps diagnostics on the normal parse", () => {
    for (const sql of NAMED_INCOMPLETE) {
      expect(parseNetezzaSqlStatements({ sql }).parserErrors.length).toBeGreaterThan(0);
    }
    for (const sql of ALL) {
      const normal = parseNetezzaSqlStatements({ sql });
      if (normal.parserErrors.length === 0 && normal.cst) {
        // Valid SQL needs no repair: recovery returns a placeholder-free tree.
        const recovered = parseNetezzaSqlForAuthoringRecovery(sql);
        expect(recovered && cstTokens(recovered).some(isAuthoringRecoveryPlaceholder)).toBe(false);
      }
    }
  });

  it("does not let scope leak across a statement boundary", () => {
    const sql = "SELECT C.CUSTOMER_NAME, FROM JUST_DATA.SALES.CUSTOMERS C; SELECT C.ORDER_ID FROM JUST_DATA.SALES.ORDERS O";
    const analysis = SqlColumnIdentityAnalysis.analyze(sql, lookup);
    const boundary = sql.indexOf(";");
    const second = analysis?.identityAt(sql.lastIndexOf("ORDER_ID"));
    // C is not visible in the second statement, so C.ORDER_ID cannot resolve.
    expect(second?.status ?? "unresolved").toBe("unresolved");
    const first = analysis?.identityAt(sql.indexOf("CUSTOMER_NAME"));
    expect(first?.occurrences.every(occurrence => occurrence.endOffset <= boundary)).toBe(true);
    for (const variant of variants(SEEDS[4])) {
      const split = variant.indexOf(";");
      if (split < 0) continue;
      const result = SqlColumnIdentityAnalysis.analyze(variant, lookup);
      for (let offset = 0; offset < split; offset++) {
        const identity = result?.identityAt(offset);
        if (identity?.status !== "resolved" || identity.catalog?.relation === undefined) continue;
        expect(identity.occurrences.every(occurrence => occurrence.endOffset <= split)).toBe(true);
      }
    }
  });

  it("respects the repair limit and gives up instead of looping", () => {
    const missing = (count: number) => `SELECT ${Array.from({ length: count }, () => ",").join(" ")} 1 FROM JUST_DATA.SALES.CUSTOMERS`;
    // `SELECT , 1` needs one placeholder per missing select item.
    expect(parseNetezzaSqlForAuthoringRecovery(missing(AUTHORING_RECOVERY_MAX_REPAIRS))).toBeDefined();
    expect(parseNetezzaSqlForAuthoringRecovery(missing(AUTHORING_RECOVERY_MAX_REPAIRS + 1))).toBeUndefined();
    expect(parseNetezzaSqlForAuthoringRecovery("SELECT = = = = = = = = 1")).toBeUndefined();
  });
});
