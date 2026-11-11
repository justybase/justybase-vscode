/**
 * Formatting protection.
 *
 * Some statements must keep their exact bytes: NZPLSQL procedure bodies,
 * PostgreSQL dollar-quoted strings/bodies and Netezza external-table DDL
 * (whose option block is order- and spelling-sensitive). The formatter masks
 * those statement contents with an inert identifier token, formats the rest of
 * the script normally, and then restores the original text.
 *
 * Masking is statement-scoped: the trailing semicolon stays outside the mask so
 * the formatter still sees statement boundaries and keeps `linesBetweenQueries`
 * spacing intact.
 */

export type ProtectedFormatReason =
  | "nzplsql"
  | "externalTable"
  | "dollarQuoted";

export interface ProtectedFormatRange {
  /** Inclusive offset of the first protected character. */
  start: number;
  /** Exclusive offset of the last protected character. */
  end: number;
  reason: ProtectedFormatReason;
}

interface StatementSlice {
  /** Offset of the first character of the statement (may be whitespace). */
  start: number;
  /** Offset just past the statement terminator, or end of input. */
  end: number;
  /** Offset of the terminator, or undefined for the final unterminated statement. */
  terminator?: number;
}

interface SourceScan {
  /** 1 where the offset is SQL code, 0 inside comments, strings or dollar quotes. */
  code: Uint8Array;
  dollarQuoteRanges: Array<{ start: number; end: number }>;
  statements: StatementSlice[];
}

const DOLLAR_QUOTE_OPENING = /^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/;

function scanSource(sql: string): SourceScan {
  const code = new Uint8Array(sql.length).fill(1);
  const dollarQuoteRanges: Array<{ start: number; end: number }> = [];
  const statements: StatementSlice[] = [];

  let statementStart = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let blockCommentDepth = 0;
  let dollarQuoteTag: string | undefined;

  const markNonCode = (index: number): void => {
    if (index >= 0 && index < code.length) {
      code[index] = 0;
    }
  };

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = index + 1 < sql.length ? sql[index + 1] : "";

    if (inLineComment) {
      markNonCode(index);
      if (character === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (blockCommentDepth > 0) {
      markNonCode(index);
      if (character === "/" && next === "*") {
        markNonCode(index + 1);
        blockCommentDepth += 1;
        index += 1;
      } else if (character === "*" && next === "/") {
        markNonCode(index + 1);
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }

    if (dollarQuoteTag) {
      markNonCode(index);
      if (sql.startsWith(dollarQuoteTag, index)) {
        const closingEnd = index + dollarQuoteTag.length;
        for (let offset = index + 1; offset < closingEnd; offset += 1) {
          markNonCode(offset);
        }
        dollarQuoteRanges.push({ start: index, end: closingEnd });
        index = closingEnd - 1;
        dollarQuoteTag = undefined;
      }
      continue;
    }

    if (inSingleQuote) {
      markNonCode(index);
      if (character === "'" && next === "'") {
        markNonCode(index + 1);
        index += 1;
        continue;
      }
      if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      markNonCode(index);
      if (character === '"' && next === '"') {
        markNonCode(index + 1);
        index += 1;
        continue;
      }
      if (character === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inBacktick) {
      markNonCode(index);
      if (character === "`" && next === "`") {
        markNonCode(index + 1);
        index += 1;
        continue;
      }
      if (character === "`") {
        inBacktick = false;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      markNonCode(index);
      markNonCode(index + 1);
      inLineComment = true;
      index += 1;
      continue;
    }

    if (character === "/" && next === "*") {
      markNonCode(index);
      markNonCode(index + 1);
      blockCommentDepth = 1;
      index += 1;
      continue;
    }

    if (character === "'") {
      markNonCode(index);
      inSingleQuote = true;
      continue;
    }

    if (character === '"') {
      markNonCode(index);
      inDoubleQuote = true;
      continue;
    }

    if (character === "`") {
      markNonCode(index);
      inBacktick = true;
      continue;
    }

    if (character === "$") {
      const opening = DOLLAR_QUOTE_OPENING.exec(sql.slice(index));
      if (opening) {
        const tag = opening[0];
        const closing = sql.indexOf(tag, index + tag.length);
        // An unterminated `$tag$` is treated as a protected region to the end.
        const end = closing < 0 ? sql.length : closing + tag.length;
        for (let offset = index; offset < end; offset += 1) {
          markNonCode(offset);
        }
        dollarQuoteRanges.push({ start: index, end });
        index = end - 1;
        continue;
      }
    }

    if (character === ";") {
      statements.push({ start: statementStart, end: index + 1, terminator: index });
      statementStart = index + 1;
    }
  }

  statements.push({ start: statementStart, end: sql.length });
  return { code, dollarQuoteRanges, statements };
}

function buildCodeOnlyText(sql: string, code: Uint8Array, slice: StatementSlice): string {
  const characters: string[] = [];
  for (let index = slice.start; index < slice.end; index += 1) {
    const character = sql[index];
    characters.push(code[index] === 1 ? character : character === "\n" || character === "\r" ? character : " ");
  }
  return characters.join("");
}

function classifyStatement(
  sql: string,
  code: Uint8Array,
  slice: StatementSlice,
  dollarQuoteRanges: ReadonlyArray<{ start: number; end: number }>,
): ProtectedFormatReason | undefined {
  const codeOnly = buildCodeOnlyText(sql, code, slice);
  if (/\bLANGUAGE\s+NZPLSQL\b/i.test(codeOnly) || /\bBEGIN_PROC\b/i.test(codeOnly)) {
    return "nzplsql";
  }
  if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?EXTERNAL\s+TABLE\b/i.test(codeOnly)) {
    return "externalTable";
  }
  const hasDollarQuote = dollarQuoteRanges.some(
    (range) => range.start >= slice.start && range.start < slice.end,
  );
  if (hasDollarQuote) {
    return "dollarQuoted";
  }
  return undefined;
}

function trimLeadingWhitespace(sql: string, start: number, end: number): number {
  let offset = start;
  while (offset < end && /\s/.test(sql[offset] ?? "")) {
    offset += 1;
  }
  return offset;
}

function trimTrailingWhitespace(sql: string, start: number, end: number): number {
  let offset = end;
  while (offset > start && /\s/.test(sql[offset - 1] ?? "")) {
    offset -= 1;
  }
  return offset;
}

/**
 * Statement-level ranges the formatter must return verbatim.
 *
 * The trailing semicolon is deliberately excluded so statement separation is
 * still formatted, and surrounding whitespace is left outside the range so the
 * formatter can indent the statement normally.
 *
 * Unquoted `BEGIN_PROC … END_PROC` bodies contain real semicolons, so the
 * statement splitter cannot bound them. They are handled separately and merged
 * with the statement-level ranges.
 */
export function findProtectedFormatRanges(sql: string): ProtectedFormatRange[] {
  if (!sql || !/[;]|\bBEGIN_PROC\b|\bNZPLSQL\b|\bEXTERNAL\b|\$/i.test(sql)) {
    return [];
  }

  const scan = scanSource(sql);
  const ranges: ProtectedFormatRange[] = [];

  for (const slice of scan.statements) {
    const reason = classifyStatement(sql, scan.code, slice, scan.dollarQuoteRanges);
    if (!reason) {
      continue;
    }
    const contentEnd = slice.terminator ?? slice.end;
    const start = trimLeadingWhitespace(sql, slice.start, contentEnd);
    const end = trimTrailingWhitespace(sql, start, contentEnd);
    if (end > start) {
      ranges.push({ start, end, reason });
    }
  }

  for (const block of findBeginProcBlocks(sql, scan)) {
    ranges.push(block);
  }

  return mergeRanges(ranges);
}

/**
 * Locate unquoted `BEGIN_PROC … END_PROC` blocks and expand them to the whole
 * enclosing routine statement. The trailing semicolon is kept inside the range
 * because an unquoted body may be followed by `END_PROC;` with no other
 * statement content in between.
 */
function findBeginProcBlocks(sql: string, scan: SourceScan): ProtectedFormatRange[] {
  const blocks: ProtectedFormatRange[] = [];
  const codeOnly = buildCodeOnlyText(sql, scan.code, { start: 0, end: sql.length });

  const beginPattern = /\bBEGIN_PROC\b/gi;
  let match: RegExpExecArray | null;
  while ((match = beginPattern.exec(codeOnly)) !== null) {
    const beginOffset = match.index;
    const endMatch = /\bEND_PROC\b/gi;
    endMatch.lastIndex = beginOffset + match[0].length;
    const endResult = endMatch.exec(codeOnly);
    if (!endResult) {
      break;
    }
    const bodyEnd = endResult.index + endResult[0].length;

    const slice = scan.statements.find(
      (candidate) => beginOffset >= candidate.start && beginOffset < candidate.end,
    );
    const start = trimLeadingWhitespace(sql, slice?.start ?? beginOffset, beginOffset);

    let end = bodyEnd;
    while (end < sql.length && /\s/.test(sql[end] ?? "")) {
      end += 1;
    }
    if (sql[end] === ";") {
      end += 1;
    }
    if (end > start) {
      blocks.push({ start, end, reason: "nzplsql" });
    }
    beginPattern.lastIndex = end;
  }

  return blocks;
}

function mergeRanges(ranges: ProtectedFormatRange[]): ProtectedFormatRange[] {
  if (ranges.length < 2) {
    return ranges;
  }
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: ProtectedFormatRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export interface MaskedFormatInput {
  masked: string;
  /** Restores the original protected text in a formatted result. */
  restore(formatted: string): string;
}

/**
 * Replaces protected ranges with inert identifier tokens.
 *
 * The placeholder is a plain `word` token for the formatter's scanner: it is
 * not a keyword, so it is emitted unchanged and never reflowed. A random suffix
 * keeps a collision with real user text practically impossible, and the
 * generator retries while the token appears in the input.
 */
export function maskProtectedRanges(
  sql: string,
  ranges: readonly ProtectedFormatRange[],
): MaskedFormatInput {
  if (ranges.length === 0) {
    return { masked: sql, restore: (formatted) => formatted };
  }

  const suffix = Math.random().toString(36).slice(2, 10) || "0";
  const entries = ranges.map((range, index) => ({
    range,
    placeholder: `JB_PROTECTED_BLOB_${index}_${suffix}`,
  }));

  for (const entry of entries) {
    // Deterministic fallback if a caller supplies text containing our own token.
    while (sql.includes(entry.placeholder)) {
      entry.placeholder = `${entry.placeholder}X`;
    }
  }

  let masked = "";
  let cursor = 0;
  for (const entry of entries) {
    masked += sql.slice(cursor, entry.range.start);
    masked += entry.placeholder;
    cursor = entry.range.end;
  }
  masked += sql.slice(cursor);

  return {
    masked,
    restore(formatted: string): string {
      let restored = formatted;
      for (const entry of entries) {
        if (!restored.includes(entry.placeholder)) {
          continue;
        }
        restored = restored.split(entry.placeholder).join(sql.slice(entry.range.start, entry.range.end));
      }
      return restored;
    },
  };
}
