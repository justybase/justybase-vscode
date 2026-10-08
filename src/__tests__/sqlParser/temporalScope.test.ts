jest.unmock("chevrotain");
import { resolveSemanticScopeAtCursor } from "../../providers/parsers/parserSqlContext";

describe("script scope at cursor", () => {
  it.each([
    ["SELECT * FROM existing e WHERE |1=1; CREATE TEMP TABLE future_table AS SELECT 1 AS id;", "future_table", false],
    ["CREATE TEMP TABLE t AS SELECT 1 AS id; SELECT * FROM t WHERE |1=1;", "t", true],
    ["CREATE TEMP TABLE t AS SELECT 1 AS id; SELECT * FROM t WHERE |1=1; DROP TABLE t;", "t", true],
    ["CREATE TEMP TABLE t AS SELECT 1 AS id; DROP TABLE t; SELECT * FROM t WHERE |1=1;", "t", false],
    ["CREATE TEMP TABLE t AS SELECT 1 AS id; DROP TABLE t; CREATE TEMP TABLE t AS SELECT 2 AS id; SELECT * FROM t WHERE |1=1;", "t", true],
    ["CREATE TEMP TABLE t AS SELECT 1 AS id; CREATE TEMP TABLE other AS SELECT 2 AS id; DROP TABLE other; SELECT * FROM t WHERE |1=1;", "t", true],
    ["CREATE TABLE t AS SELECT 1 AS id; SELECT * FROM t WHERE |1=1; DROP TABLE t;", "t", true],
  ] as const)("respects temporal visibility: %s", (marked, name, visible) => {
    const scope = resolveSemanticScopeAtCursor(marked.replace("|", ""), marked.indexOf("|"), "netezza");
    expect(scope.visibleRelations.some(relation => relation.kind === "script_local_table" && relation.name.toLowerCase() === name)).toBe(visible);
  });
});
