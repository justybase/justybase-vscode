/**
 * Deterministic statement normalization used before fingerprint hashing.
 *
 * Implements `docs/join-knowledge/01-ranking-model.md` §4:
 * comments → literal placeholders → whitespace collapse → case-fold.
 *
 * The salted SHA-256 step lives in the host process (Node crypto), not in this
 * platform-neutral package. This function never stores or returns SQL text to
 * callers beyond the normalized string itself.
 */

const TYPED_LITERAL_PREFIXES = new Set([
  "DATE",
  "TIME",
  "TIMESTAMP",
  "INTERVAL",
  "N",
  "E",
  "X",
  "B",
]);

function isAsciiDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function consumeQuoted(
  sql: string,
  start: number,
  quote: string,
  escape: string,
): { end: number; closed: boolean } {
  // Standard SQL doubled-delimiter escaping only. Dialect-specific backslash
  // escaping is intentionally not guessed here; a dialect-aware caller can be
  // added when a fingerprint source needs it.
  let index = start + 1;
  while (index < sql.length) {
    const character = sql[index];
    if (character === quote) {
      if (sql[index + 1] === escape) {
        index += 2;
        continue;
      }
      return { end: index + 1, closed: true };
    }
    index += 1;
  }
  return { end: sql.length, closed: false };
}

function quotedIdentifierText(
  sql: string,
  start: number,
  consumed: { end: number; closed: boolean },
): string {
  // Preserve the raw inner bytes, including doubled delimiters, so a quoted
  // identifier cannot be changed by the later case-fold step.
  return consumed.closed
    ? sql.slice(start + 1, consumed.end - 1)
    : sql.slice(start + 1);
}

function isHexDigit(character: string | undefined): boolean {
  return character !== undefined && /[0-9A-Fa-f]/.test(character);
}

function consumeRadixNumber(sql: string, start: number): number | undefined {
  if (sql[start] !== "0") {
    return undefined;
  }
  const marker = sql[start + 1]?.toLocaleLowerCase("en");
  if (marker === "x") {
    let index = start + 2;
    if (!isHexDigit(sql[index])) {
      return undefined;
    }
    while (isHexDigit(sql[index])) {
      index += 1;
    }
    return index;
  }
  if (marker === "b") {
    let index = start + 2;
    if (sql[index] !== "0" && sql[index] !== "1") {
      return undefined;
    }
    while (sql[index] === "0" || sql[index] === "1") {
      index += 1;
    }
    return index;
  }
  return undefined;
}

function readDollarQuoteTag(sql: string, start: number): string | undefined {
  if (sql[start] !== "$") {
    return undefined;
  }
  const match = /^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.exec(sql.slice(start));
  return match?.[0];
}

function consumeNumber(sql: string, start: number): number {
  let index = start;
  while (isAsciiDigit(sql[index])) {
    index += 1;
  }
  if (sql[index] === "." && isAsciiDigit(sql[index + 1])) {
    index += 1;
    while (isAsciiDigit(sql[index])) {
      index += 1;
    }
  }
  if (sql[index] === "e" || sql[index] === "E") {
    let exponent = index + 1;
    if (sql[exponent] === "+" || sql[exponent] === "-") {
      exponent += 1;
    }
    if (isAsciiDigit(sql[exponent])) {
      index = exponent;
      while (isAsciiDigit(sql[index])) {
        index += 1;
      }
    }
  }
  return index;
}

/**
 * Normalize a statement for fingerprinting.
 *
 * - comments (`--`, `/* ... *\/`) are removed;
 * - string, numeric and typed date/time literals become `?`;
 * - quoted identifiers keep their exact bytes and remain distinct;
 * - whitespace collapses to one ASCII space and the result is trimmed;
 * - unquoted identifiers and keywords are folded to UPPER.
 *
 * Quoted content is copied in one pass. Re-parsing the normalized text would
 * corrupt doubled delimiters such as `"a""b"` and `[a]]b]`.
 */
export function normalizeSqlForFingerprint(sql: string): string {
  let normalized = "";
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === "-" && next === "-") {
      const lineEnd = sql.indexOf("\n", index + 2);
      normalized += " ";
      index = lineEnd < 0 ? sql.length : lineEnd + 1;
      continue;
    }

    if (character === "/" && next === "*") {
      const commentEnd = sql.indexOf("*/", index + 2);
      normalized += " ";
      index = commentEnd < 0 ? sql.length : commentEnd + 2;
      continue;
    }

    if (character === "'") {
      const literal = consumeQuoted(sql, index, "'", "'");
      normalized += "?";
      index = literal.end;
      continue;
    }

    if (character === '"') {
      const identifier = consumeQuoted(sql, index, '"', '"');
      const inner = quotedIdentifierText(sql, index, identifier);
      normalized += identifier.closed ? `"${inner}"` : `"${inner}`;
      index = identifier.end;
      continue;
    }

    if (character === "`") {
      const identifier = consumeQuoted(sql, index, "`", "`");
      const inner = quotedIdentifierText(sql, index, identifier);
      normalized += identifier.closed ? `\`${inner}\`` : `\`${inner}`;
      index = identifier.end;
      continue;
    }

    if (character === "[") {
      const identifier = consumeQuoted(sql, index, "]", "]");
      const inner = quotedIdentifierText(sql, index, identifier);
      normalized += identifier.closed ? `[${inner}]` : `[${inner}`;
      index = identifier.end;
      continue;
    }

    if (character === "$") {
      const tag = readDollarQuoteTag(sql, index);
      if (tag) {
        const closing = sql.indexOf(tag, index + tag.length);
        if (closing >= 0) {
          normalized += "?";
          index = closing + tag.length;
          continue;
        }
      }
    }

    if (isIdentifierStart(character)) {
      let wordEnd = index + 1;
      while (isIdentifierPart(sql[wordEnd])) {
        wordEnd += 1;
      }
      const word = sql.slice(index, wordEnd);
      let lookahead = wordEnd;
      while (/\s/.test(sql[lookahead] ?? "")) {
        lookahead += 1;
      }
      if (
        sql[lookahead] === "'"
        && TYPED_LITERAL_PREFIXES.has(word.toLocaleUpperCase("en"))
      ) {
        const literal = consumeQuoted(sql, lookahead, "'", "'");
        normalized += "?";
        index = literal.end;
        continue;
      }
      normalized += word.toLocaleUpperCase("en");
      index = wordEnd;
      continue;
    }

    const radixEnd = consumeRadixNumber(sql, index);
    if (radixEnd !== undefined) {
      normalized += "?";
      index = radixEnd;
      continue;
    }

    if (
      isAsciiDigit(character)
      || (character === "." && isAsciiDigit(next))
    ) {
      normalized += "?";
      index = consumeNumber(sql, index);
      continue;
    }

    normalized += character.toLocaleUpperCase("en");
    index += 1;
  }

  return normalized.replace(/\s+/g, " ").trim();
}
