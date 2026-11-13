import { createSqlLineIndex } from "../src/validation/lineIndex";

/** Reference implementation used by the validators before the line index. */
function referencePosition(sql: string, offset: number): { line: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, sql.length));
  let line = 1;
  let column = 1;
  for (let index = 0; index < safeOffset; index += 1) {
    if (sql[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

const SAMPLES = [
  "",
  "SELECT 1;",
  "SELECT 1;\nSELECT 2;",
  "SELECT a\r\nFROM t\r\nWHERE a = 1;",
  "\n\n\n",
  "a\nb\n",
  "SELECT '\n' AS embedded;\n-- trailing",
];

describe("createSqlLineIndex", () => {
  it.each(SAMPLES)("matches the reference implementation for every offset (%#)", (sql) => {
    const index = createSqlLineIndex(sql);
    for (let offset = 0; offset <= sql.length; offset += 1) {
      const expected = referencePosition(sql, offset);
      expect(index.lineAt(offset)).toBe(expected.line);
      expect(index.columnAt(offset)).toBe(expected.column);
    }
  });

  it("clamps offsets outside the document", () => {
    const sql = "a\nbc";
    const index = createSqlLineIndex(sql);

    expect(index.lineAt(-5)).toBe(1);
    expect(index.columnAt(-5)).toBe(1);
    expect(index.lineAt(sql.length + 10)).toBe(2);
    expect(index.columnAt(sql.length + 10)).toBe(3);
    expect(index.lineAt(Number.NaN)).toBe(1);
    expect(index.lineAt(Number.POSITIVE_INFINITY)).toBe(2);
  });

  it("resolves line starts in both directions", () => {
    const sql = "one\ntwo\nthree";
    const index = createSqlLineIndex(sql);

    expect(index.lineCount).toBe(3);
    expect(index.lineStart(1)).toBe(0);
    expect(index.lineStart(2)).toBe(4);
    expect(index.lineStart(3)).toBe(8);
    expect(index.lineStart(0)).toBe(0);
    expect(index.lineStart(99)).toBe(8);
  });

  it("treats CRLF as one line break with the newline on the previous line", () => {
    const sql = "a\r\nb";
    const index = createSqlLineIndex(sql);

    // The `\r` and `\n` belong to line 1; `b` starts line 2 column 1.
    expect(index.lineAt(2)).toBe(1);
    expect(index.columnAt(2)).toBe(3);
    expect(index.lineAt(3)).toBe(2);
    expect(index.columnAt(3)).toBe(1);
  });
});
