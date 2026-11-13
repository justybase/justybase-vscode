jest.unmock("chevrotain");

import {
  NetezzaSqlSemanticValidator,
  parseNetezzaSqlStatements,
  sanitizeNetezzaSql,
} from "../src/validation";
import {
  collectSqlSymbolUsagesFromCst,
  mayContainUnusedSymbolDefinitions,
} from "../src/validation/symbols";

function parseSql(sql: string) {
  const result = parseNetezzaSqlStatements({ sql });
  expect(result.actionableParserErrors).toEqual([]);
  expect(result.cst).toBeDefined();
  return result;
}

describe("collectSqlSymbolUsagesFromCst", () => {
  it("groups occurrences by symbol without changing per-symbol order", () => {
    const sql = [
      "SELECT a.ID, a.NAME, b.ID",
      "FROM DB..T1 a",
      "JOIN DB..T2 b ON a.ID = b.ID;",
    ].join("\n");
    const result = parseSql(sql);

    const usages = collectSqlSymbolUsagesFromCst(result.cst!);
    const aliasA = usages.find((usage) => usage.name === "a");
    const aliasB = usages.find((usage) => usage.name === "b");

    expect(aliasA).toBeDefined();
    expect(aliasB).toBeDefined();
    expect(aliasA!.occurrences.map((occurrence) => occurrence.role).sort()).toEqual([
      "definition",
      "reference",
      "reference",
      "reference",
    ]);
    expect(aliasB!.occurrences.map((occurrence) => occurrence.role).sort()).toEqual([
      "definition",
      "reference",
      "reference",
    ]);
    for (const usage of usages) {
      const offsets = usage.occurrences.map((occurrence) => occurrence.startOffset);
      expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    }
  });

  it("keeps every definition when many aliases are unused", () => {
    const statements = Array.from(
      { length: 120 },
      (_, index) => `SELECT ID FROM DB..T${index} a${index};`,
    );
    const result = parseSql(statements.join("\n"));

    const usages = collectSqlSymbolUsagesFromCst(result.cst!);
    const aliases = usages.filter((usage) => usage.kind === "table_alias");

    expect(aliases).toHaveLength(120);
    expect(aliases.every((usage) => usage.occurrences.length === 1)).toBe(true);
    expect(aliases.map((usage) => usage.name)).toEqual(
      statements.map((_, index) => `a${index}`),
    );
  });
});

describe("mayContainUnusedSymbolDefinitions", () => {
  it.each([
    ["SELECT a.ID FROM DB..T a;", true],
    ["WITH c AS (SELECT 1 AS ID) SELECT * FROM c;", true],
    ["UPDATE DB..T t SET ID = 1;", true],
    ["DELETE FROM DB..T t WHERE t.ID = 1;", true],
    ["MERGE INTO DB..T t USING DB..S s ON t.ID = s.ID WHEN MATCHED THEN UPDATE SET ID = 1;", true],
    ["INSERT INTO DB..T VALUES (1);", false],
    ["CREATE TABLE DB..T (ID INT);", false],
  ])("classifies %s", (sql, expected) => {
    const result = parseNetezzaSqlStatements({ sql });
    expect(mayContainUnusedSymbolDefinitions(result.lexResult.tokens)).toBe(expected);
  });
});

describe("unused-symbol warnings after the fast path", () => {
  it("still reports SQL018 for an unused CTE", () => {
    const result = new NetezzaSqlSemanticValidator().validate(
      "WITH UNUSED_CTE AS (SELECT 1 AS ID) SELECT 1;",
    );
    expect(result.warnings.some((warning) => warning.code === "SQL018")).toBe(true);
  });

  it("still reports SQL019 for an unused table alias", () => {
    const result = new NetezzaSqlSemanticValidator().validate(
      "SELECT * FROM DB..T E;",
    );
    expect(result.warnings.some((warning) => warning.code === "SQL019")).toBe(true);
  });

  it("does not warn for statements without CTEs or table aliases", () => {
    const result = new NetezzaSqlSemanticValidator().validate(
      "INSERT INTO DB..T VALUES (1);",
    );
    expect(result.warnings.some((warning) => warning.code === "SQL018")).toBe(false);
    expect(result.warnings.some((warning) => warning.code === "SQL019")).toBe(false);
  });
});

describe("macro sanitizer fast path", () => {
  it("returns macro-free SQL unchanged", () => {
    const sql = "SELECT A, B FROM DB..T WHERE A = 1;";
    expect(sanitizeNetezzaSql(sql)).toBe(sql);
  });

  it("still preserves percent signs inside strings and comments", () => {
    const sql = "SELECT '100%' FROM DB..T -- 50% comment";
    expect(sanitizeNetezzaSql(sql)).toBe(sql);

    const result = parseNetezzaSqlStatements({ sql });
    expect(result.lexResult.errors).toEqual([]);
  });
});

describe("diagnostic position mapping", () => {
  it("maps unused-alias warnings on a large script to their own lines", () => {
    const lines = Array.from(
      { length: 3000 },
      (_, index) => `SELECT ID FROM BENCH..T${index % 5} a${index};`,
    );
    const result = new NetezzaSqlSemanticValidator().validate(lines.join("\n"));
    const warnings = result.warnings.filter((warning) => warning.code === "SQL019");

    expect(warnings).toHaveLength(lines.length);
    expect(warnings[0].position.startLine).toBe(1);
    expect(warnings[warnings.length - 1].position.startLine).toBe(lines.length);
    expect(warnings[warnings.length - 1].position.startColumn).toBe(
      lines[lines.length - 1].indexOf(" a") + 2,
    );
  });

  it("remaps incremental diagnostics to the same document positions as full validation", () => {
    const statementSql = [
      "SELECT a.ID FROM BENCH..T0 a;",
      "SELECT b.ID FROM BENCH..T1 b;",
      "SELECT c.ID FROM BENCH..T2 c;",
    ];
    const fullSql = statementSql.join("\n");
    let offset = 0;
    const statements = statementSql.map((sql, index) => {
      const statement = {
        index,
        startOffset: offset,
        endOffset: offset + sql.length,
        sql,
      };
      offset += sql.length + 1;
      return statement;
    });

    const validator = new NetezzaSqlSemanticValidator();
    const incremental = validator.validateIncrementalFromStatements(
      fullSql,
      statements,
      statements.map((statement) => statement.index),
      new Map(),
    );
    const warnings = incremental.warnings.filter((warning) => warning.code === "SQL005");

    expect(warnings.map((warning) => warning.position.startLine)).toEqual([1, 2, 3]);
    expect(warnings.map((warning) => warning.position.startColumn)).toEqual([10, 10, 10]);
    expect(incremental.warnings).toEqual(validator.validate(fullSql).warnings);
  });

  it("remaps a diagnostic from a statement that starts mid-line", () => {
    const first = "SELECT 1;";
    const second = "SELECT a.ID FROM BENCH..T0 a;";
    const fullSql = `${first} ${second}`;
    const statementSql = [first, second];
    let offset = 0;
    const statements = statementSql.map((sql, index) => {
      const statement = {
        index,
        startOffset: offset,
        endOffset: offset + sql.length,
        sql,
      };
      offset += sql.length + 1;
      return statement;
    });

    const validator = new NetezzaSqlSemanticValidator();
    const incremental = validator.validateIncrementalFromStatements(
      fullSql,
      statements,
      [0, 1],
      new Map(),
    );

    expect(incremental.warnings).toEqual(validator.validate(fullSql).warnings);
    expect(incremental.warnings[0]?.position.startLine).toBe(1);
    expect(incremental.warnings[0]?.position.startColumn).toBe(
      fullSql.indexOf("ID") + 1,
    );
  });
});
