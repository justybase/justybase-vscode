import type { IToken } from "chevrotain";
import { SqlLexer } from "../sqlParser";

/** Statement text inspected before the cursor; longer statements get no ghost. */
export const MAX_GHOST_LOOKBEHIND_CHARS = 16_384;

/**
 * Tokens of the statement that contains the cursor and the text their offsets
 * refer to, or undefined on lexing errors.
 */
export function cursorStatementTokens(textBefore: string): { tokens: IToken[]; text: string } | undefined {
  const window = textBefore.slice(-MAX_GHOST_LOOKBEHIND_CHARS);
  const lexed = SqlLexer.tokenize(window);
  if (lexed.errors.length > 0) {
    return undefined;
  }
  let start = 0;
  lexed.tokens.forEach((token, index) => {
    if (token.tokenType.name === "Semicolon") {
      start = index + 1;
    }
  });
  const tokens = lexed.tokens.slice(start);
  // A statement cut by the window cannot be classified reliably.
  if (start === 0 && window.length < textBefore.length) {
    return undefined;
  }
  return { tokens, text: window };
}
