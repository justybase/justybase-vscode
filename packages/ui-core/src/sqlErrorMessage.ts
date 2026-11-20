/**
 * Netezza echoes the failing statement before its parser diagnostic:
 *
 *   ERROR:  'SELECT 1,,2 FROM JUST_DATA..DIMACCOUNT'
 *   error             ^ found "," (at char 10) expecting an identifier
 *
 * For a long statement that echo dominates the result panel, the Logs tab and
 * the notification text, so truncating the message cuts the only actionable
 * part. These helpers keep the diagnostic first and replace the echo with a
 * short excerpt around the failing character.
 */

export interface SqlErrorExcerptOptions {
  /** Maximum number of SQL characters kept in the excerpt. */
  readonly maxExcerptLength?: number;
  /** Characters of SQL kept before the failing character. */
  readonly contextBefore?: number;
}

interface QuotedSqlError {
  /** Message text before the opening quote, for example `Error: … ERROR:  `. */
  readonly prefix: string;
  /** The echoed SQL without its surrounding quotes. */
  readonly sql: string;
  /** Diagnostic text after the caret. */
  readonly detail: string;
  /** Zero-based column of the caret on its own line. */
  readonly caretColumn: number;
  /** Zero-based column of the opening quote on the first line. */
  readonly quoteColumn: number;
  /** Lines the driver emitted after the caret line. */
  readonly trailing: readonly string[];
}

const DEFAULT_EXCERPT_LENGTH = 96;
const DEFAULT_CONTEXT_BEFORE = 32;
const SQL_ECHO_RE = /error\s*:\s*'/iu;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Accepts both driver layouts: the caret on its own line (multi-line echo) and
 * the caret appended to the closing quote of a single-line echo.
 */
function parseQuotedSqlError(message: string): QuotedSqlError | undefined {
  const echo = SQL_ECHO_RE.exec(message);
  if (!echo) return undefined;
  const openQuote = echo.index + echo[0].length - 1;
  // The diagnostic is the last thing the driver appends, so its caret is the
  // last one in the message; the closing quote is the closest one before it.
  const caret = message.lastIndexOf('^');
  if (caret <= openQuote) return undefined;
  const closeQuote = message.lastIndexOf("'", caret);
  if (closeQuote <= openQuote) return undefined;
  const detail = message.slice(caret + 1).split(/\r?\n/u, 1)[0]?.trim() ?? '';
  if (!detail) return undefined;

  const sql = message.slice(openQuote + 1, closeQuote);
  if (!sql.trim()) return undefined;

  const caretLineStart = message.lastIndexOf('\n', caret) + 1;
  const lineBreak = message.indexOf('\n');
  const firstLine = lineBreak < 0 ? message : message.slice(0, lineBreak);
  return {
    prefix: message.slice(0, openQuote),
    sql,
    detail,
    caretColumn: caret - caretLineStart,
    quoteColumn: firstLine.indexOf("'"),
    trailing: message.slice(caret + 1).split(/\r?\n/u).slice(1),
  };
}

/**
 * Replace every line break with one or two spaces. Netezza counts the
 * characters it received, so a CRLF document keeps two characters per break
 * while a CRLF-normalized echo only has one.
 */
function flattenStatement(sql: string, lineBreakWidth: number): string {
  return sql
    .replace(/\r\n/gu, ' '.repeat(lineBreakWidth))
    .replace(/[\r\n]/gu, ' '.repeat(lineBreakWidth));
}

function tokenMatchScore(text: string, offset: number, token: string): number {
  if (!token) return 0;
  if (text.startsWith(token, offset)) return 3;
  const from = Math.max(0, offset - 3);
  const index = text.indexOf(token, from);
  if (index >= 0 && index <= offset + 3) return 2;
  return 0;
}

/**
 * Map the reported character position onto the echoed statement. When the echo
 * is LF-only we cannot tell whether the executed SQL used CRLF, so both
 * interpretations are scored against the token the parser reported and the
 * better match wins.
 */
function resolveStatement(error: QuotedSqlError): { readonly text: string; readonly offset: number } {
  const reported = /\(at char (\d+)\)/iu.exec(error.detail);
  const token = /found\s+"([^"]*)"/iu.exec(error.detail)?.[1] ?? '';
  const widths = /\r/u.test(error.sql) ? [2] : [1, 2];
  let best: { text: string; offset: number; score: number } | undefined;

  for (const width of widths) {
    const text = flattenStatement(error.sql, width);
    const caretEstimate = error.caretColumn - error.quoteColumn - 1;
    const rawOffset = reported ? Number(reported[1]) - 1 : caretEstimate;
    const offset = clamp(
      Number.isFinite(rawOffset) ? rawOffset : 0,
      0,
      Math.max(0, text.length - 1),
    );
    const score = tokenMatchScore(text, offset, token);
    if (!best || score > best.score) best = { text, offset, score };
  }

  return { text: best?.text ?? error.sql, offset: best?.offset ?? 0 };
}

/** Collapse indentation runs left by the flattened statement without moving the caret off its token. */
function collapseWhitespaceRuns(text: string, caret: number): { readonly text: string; readonly caret: number } {
  let result = '';
  let mappedCaret = 0;
  let inWhitespace = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (/\s/u.test(char)) {
      if (inWhitespace) continue;
      if (index <= caret) mappedCaret = result.length;
      result += ' ';
      inWhitespace = true;
      continue;
    }
    if (index <= caret) mappedCaret = result.length;
    result += char;
    inWhitespace = false;
  }
  return { text: result, caret: mappedCaret };
}

function buildExcerpt(
  flattened: string,
  offset: number,
  options: SqlErrorExcerptOptions | undefined,
): { readonly text: string; readonly caret: number } {
  const maxLength = Math.max(24, options?.maxExcerptLength ?? DEFAULT_EXCERPT_LENGTH);
  const contextBefore = clamp(
    options?.contextBefore ?? DEFAULT_CONTEXT_BEFORE,
    4,
    Math.floor(maxLength / 2),
  );
  let start = Math.max(0, offset - contextBefore);
  const end = Math.min(flattened.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);
  const leading = start > 0 ? '…' : '';
  const trailing = end < flattened.length ? '…' : '';
  return {
    text: `${leading}${flattened.slice(start, end)}${trailing}`,
    caret: leading.length + (offset - start),
  };
}

/** Prefer the reported token so the caret stays correct even if the echo drifts. */
function alignCaret(excerpt: string, caret: number, detail: string): number {
  const fallback = clamp(caret, 0, Math.max(0, excerpt.length - 1));
  const token = /found\s+"([^"]*)"/iu.exec(detail)?.[1] ?? '';
  if (!token) return fallback;
  let best = -1;
  for (let index = excerpt.indexOf(token); index >= 0; index = excerpt.indexOf(token, index + 1)) {
    if (best < 0 || Math.abs(index - caret) < Math.abs(best - caret)) best = index;
  }
  return best >= 0 ? best : fallback;
}

/**
 * Rewrite a driver error that echoes the whole statement so the diagnostic
 * comes first and the echo becomes a short excerpt around the failing
 * character. Messages without that shape are returned unchanged, which makes
 * the function safe to apply more than once.
 */
export function compactSqlErrorMessage(message: string, options?: SqlErrorExcerptOptions): string {
  const parsed = parseQuotedSqlError(message);
  if (!parsed) return message;

  const statement = resolveStatement(parsed);
  const maxLength = Math.max(24, options?.maxExcerptLength ?? DEFAULT_EXCERPT_LENGTH);
  if (statement.text.length <= maxLength) return message;

  const excerpt = buildExcerpt(statement.text, statement.offset, options);
  const collapsed = collapseWhitespaceRuns(excerpt.text, excerpt.caret);
  const caret = alignCaret(collapsed.text, collapsed.caret, parsed.detail);
  const label = /error\s*:/iu.test(parsed.prefix) ? 'ERROR: ' : '';
  return [
    `${label}${parsed.detail}`,
    collapsed.text,
    `${' '.repeat(caret)}^`,
    ...parsed.trailing,
  ].join('\n');
}

/**
 * One-line form of a driver error for inline hints: the parser diagnostic
 * without the echoed SQL. Other messages are collapsed and truncated.
 */
export function summarizeSqlErrorMessage(message: string, maxLength = 200): string {
  const parsed = parseQuotedSqlError(message);
  const text = (parsed ? parsed.detail : message).replace(/\s+/gu, ' ').trim();
  const limit = Math.max(8, maxLength);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}
