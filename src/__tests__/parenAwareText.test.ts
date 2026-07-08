import {
  endsInsideUnclosedParen,
  splitCommaSeparatedTopLevel,
} from "../core/parenAwareText";

describe("parenAwareText", () => {
  it("splits top-level commas while preserving nested parentheses", () => {
    expect(
      splitCommaSeparatedTopLevel("DECIMAL(10,2), VARCHAR(100)"),
    ).toEqual(["DECIMAL(10,2)", "VARCHAR(100)"]);
  });

  it("detects unclosed parenthesis at end of prefix", () => {
    expect(endsInsideUnclosedParen("(A, (SELECT 1), ", 0)).toBe(true);
    expect(endsInsideUnclosedParen("(A, B)", 0)).toBe(false);
  });
});
