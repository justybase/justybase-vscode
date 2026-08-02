import { createToken, Lexer } from "chevrotain";
import * as netezzaLexer from "../../netezza/sql/lexer";

/** MySQL quoted identifiers use backticks and escape an embedded backtick by doubling it. */
export const BacktickIdentifier = createToken({
  name: "BacktickIdentifier",
  pattern: /`(?:``|[^`])*`/,
});

/** MySQL also accepts a hash-prefixed line comment. */
export const HashLineComment = createToken({
  name: "HashLineComment",
  pattern: /#[^\r\n]*/,
  group: Lexer.SKIPPED,
});

// Keep the shared token identities so the existing CST visitor and semantic
// rules can be reused. MySQL-only tokens must precede the shared Identifier.
export const allTokens = [
  HashLineComment,
  BacktickIdentifier,
  ...netezzaLexer.allTokens,
];

export const SqlLexer = new Lexer(allTokens);

export * from "../../netezza/sql/lexer";
