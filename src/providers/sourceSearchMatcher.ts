/**
 * Source-definition search used by Object Search → source modes.
 *
 * Matching runs on a masked copy of the definition (`stripComments` /
 * `stripCommentsAndLiterals`) so comments and literals are ignored, while the
 * returned snippet is taken from the original text. Both copies keep the same
 * length, so an offset found in the masked text is valid in the original.
 */

import {
  stripComments,
  stripCommentsAndLiterals,
  type SourceSearchMode,
} from '../sql/sqlTextUtils';

export interface SourceSearchOptions {
  mode: SourceSearchMode;
  /** Match case exactly instead of case-insensitively. */
  caseSensitive?: boolean;
  /** Require non-word characters around the match. */
  wholeWord?: boolean;
  /** Treat the search text as a regular expression. */
  regex?: boolean;
  /** Characters shown before the match (default 40). */
  snippetLead?: number;
  /** Total snippet length in characters (default 160). */
  snippetLength?: number;
}

export interface SourceSearchMatch {
  matched: boolean;
  /** Zero-based offset of the match in the original definition, or -1. */
  offset: number;
  /** Display window around the match with whitespace collapsed. */
  snippet?: string;
  /** Offset of the match inside `snippet`. */
  snippetMatchOffset?: number;
  /** Length of the matched text inside `snippet`. */
  snippetMatchLength?: number;
  /** The regular expression could not be compiled. */
  invalidPattern?: boolean;
}

const DEFAULT_SNIPPET_LEAD = 40;
const DEFAULT_SNIPPET_LENGTH = 160;
const WORD_CHARACTER = /[A-Za-z0-9_$]/;

function isWordCharacterAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return false;
  }
  return WORD_CHARACTER.test(text[index]);
}

function isWholeWordMatch(text: string, offset: number, length: number): boolean {
  return !isWordCharacterAt(text, offset - 1) && !isWordCharacterAt(text, offset + length);
}

function findPlainMatch(
  haystack: string,
  needle: string,
  wholeWord: boolean,
): { offset: number; length: number } | undefined {
  if (!needle) {
    return undefined;
  }
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const offset = haystack.indexOf(needle, fromIndex);
    if (offset < 0) {
      return undefined;
    }
    if (!wholeWord || isWholeWordMatch(haystack, offset, needle.length)) {
      return { offset, length: needle.length };
    }
    fromIndex = offset + 1;
  }
  return undefined;
}

function buildRegex(term: string, options: SourceSearchOptions): RegExp | undefined {
  const flags = options.caseSensitive ? 'u' : 'iu';
  const pattern = options.wholeWord
    ? `(?<![A-Za-z0-9_$])(?:${term})(?![A-Za-z0-9_$])`
    : term;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
}

function applyMode(text: string, mode: SourceSearchMode): string {
  switch (mode) {
    case 'raw':
      return text;
    case 'noComments':
      return stripComments(text);
    case 'noCommentsNoLiterals':
    default:
      return stripCommentsAndLiterals(text);
  }
}

function buildSnippet(
  source: string,
  offset: number,
  length: number,
  lead: number,
  snippetLength: number,
): Pick<SourceSearchMatch, 'snippet' | 'snippetMatchOffset' | 'snippetMatchLength'> {
  const start = Math.max(0, offset - lead);
  const end = Math.min(source.length, start + snippetLength);
  const prefix = source.slice(start, offset).replace(/\s+/g, ' ');
  const matchText = source.slice(offset, offset + length).replace(/\s+/g, ' ');
  const suffix = source.slice(offset + length, end).replace(/\s+/g, ' ');

  let snippet = `${prefix}${matchText}${suffix}`;
  let snippetMatchOffset = prefix.length;
  const leadingTrim = snippet.length - snippet.trimStart().length;
  if (leadingTrim > 0) {
    snippet = snippet.slice(leadingTrim);
    snippetMatchOffset = Math.max(0, snippetMatchOffset - leadingTrim);
  }
  snippet = snippet.trimEnd();

  return {
    snippet: snippet.length > 0 ? snippet : undefined,
    snippetMatchOffset,
    snippetMatchLength: matchText.length,
  };
}

export function searchSourceText(
  source: string,
  term: string,
  options: SourceSearchOptions,
): SourceSearchMatch {
  const trimmedTerm = options.regex ? term : term.trim();
  if (!trimmedTerm) {
    return { matched: false, offset: -1 };
  }

  const masked = applyMode(source, options.mode);
  let found: { offset: number; length: number } | undefined;

  if (options.regex) {
    const expression = buildRegex(trimmedTerm, options);
    if (!expression) {
      return { matched: false, offset: -1, invalidPattern: true };
    }
    const match = expression.exec(masked);
    if (match && match[0].length > 0) {
      found = { offset: match.index, length: match[0].length };
    }
  } else {
    const haystack = options.caseSensitive ? masked : masked.toLowerCase();
    const needle = options.caseSensitive ? trimmedTerm : trimmedTerm.toLowerCase();
    found = findPlainMatch(haystack, needle, options.wholeWord === true);
  }

  if (!found) {
    return { matched: false, offset: -1 };
  }

  return {
    matched: true,
    offset: found.offset,
    ...buildSnippet(
      source,
      found.offset,
      found.length,
      options.snippetLead ?? DEFAULT_SNIPPET_LEAD,
      options.snippetLength ?? DEFAULT_SNIPPET_LENGTH,
    ),
  };
}
