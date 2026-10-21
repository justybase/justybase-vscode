import type { IToken } from "chevrotain";
import type { DatabaseKind } from "../contracts/database";
import { SqlLexer } from "../sqlParser";
import { formatIdentifierForSql } from "../utils/identifierUtils";
import { getTableAliasBase, getUniqueTableAlias } from "./tableAliasPolicy";

/**
 * Token-based `SELECT *` / `alias.*` expansion. Works on a single statement
 * and only reports offsets, so desktop quick fixes, refactorings and tests
 * can share it without a VS Code dependency.
 */

export type ExpandStarLayout = "leadingComma" | "trailingComma" | "singleLine";

export const EXPAND_STAR_LAYOUTS: readonly ExpandStarLayout[] = ["leadingComma", "trailingComma", "singleLine"];

/** A relation of the FROM clause that owns the expanded `*`. */
export interface SelectStarSource {
  /** Last path segment as written (unquoted), e.g. `DIMDATE` for `DB..DIMDATE`. */
  table: string;
  database?: string;
  schema?: string;
  alias?: string;
  /** Alias, or else table name, exactly as written in the SQL (used as the qualifier). */
  qualifierText: string;
  /** Derived table `(SELECT ...) X` — columns come only from the validator scope. */
  isSubquery: boolean;
  /** Offset right after the relation path (or subquery), where a new alias goes. */
  pathEndOffset: number;
}

export interface SelectStarContext {
  /** Start of the replaced text: the qualifier of `X.*`, else the `*`. */
  replaceStart: number;
  starStart: number;
  starEnd: number;
  /** `X` for `X.*`; undefined for a bare `*`. */
  qualifier?: string;
  sources: SelectStarSource[];
}

export interface TextReplacement {
  start: number;
  end: number;
  newText: string;
}

export interface SelectStarExpansionOptions {
  layout?: ExpandStarLayout;
  /** One indentation step, e.g. four spaces or a tab. */
  indentUnit?: string;
  databaseKind?: DatabaseKind;
  /** Column names of a source in catalog order, or undefined when unknown. */
  getColumns(source: SelectStarSource): readonly string[] | undefined;
  /** Workspace alias override for a source (`justybase.sql.joinAliases`). */
  getConfiguredAlias?(source: SelectStarSource): string | undefined;
}

const CLAUSE_END_TOKENS = new Set([
  "Where", "Group", "GroupBy", "Order", "OrderBy", "Having", "Limit", "Offset",
  "Union", "Intersect", "Except", "MinusSet", "Fetch", "Semicolon",
]);

const JOIN_MODIFIER_TOKENS = new Set(["Inner", "Left", "Right", "Full", "Outer", "Cross", "Natural"]);

/** Locates the `*` token at `starOffset` and the FROM sources of its SELECT. */
export function findSelectStarContext(sql: string, starOffset: number): SelectStarContext | undefined {
  const tokens = SqlLexer.tokenize(sql).tokens;
  const starIndex = tokens.findIndex(
    (token) => token.tokenType.name === "Multiply" && token.startOffset === starOffset,
  );
  if (starIndex < 0) {
    return undefined;
  }

  let qualifier: string | undefined;
  let replaceStart = tokens[starIndex].startOffset;
  let listIndex = starIndex - 1;
  if (tokens[listIndex]?.tokenType.name === "Dot") {
    const qualifierToken = tokens[listIndex - 1];
    if (!qualifierToken || !isNameToken(qualifierToken)) {
      return undefined;
    }
    qualifier = unquote(qualifierToken.image);
    replaceStart = qualifierToken.startOffset;
    listIndex -= 2;
  }
  const previous = tokens[listIndex]?.tokenType.name;
  if (previous !== "Select" && previous !== "Distinct" && previous !== "All" && previous !== "Comma") {
    return undefined;
  }

  const fromIndex = findFromAtSameDepth(tokens, starIndex);
  if (fromIndex === undefined) {
    return undefined;
  }
  const sources = parseFromSources(tokens, fromIndex);
  if (!sources || sources.length === 0) {
    return undefined;
  }

  const star = tokens[starIndex];
  return {
    replaceStart,
    starStart: star.startOffset,
    starEnd: tokenEnd(star),
    qualifier,
    sources,
  };
}

/**
 * Builds the edits that replace `*` with qualified columns and add a
 * generated alias to every unaliased source that the expansion uses.
 * Returns undefined when any needed source has unknown columns.
 */
export function buildSelectStarExpansion(
  sql: string,
  context: SelectStarContext,
  options: SelectStarExpansionOptions,
): TextReplacement[] | undefined {
  const targets = context.qualifier
    ? context.sources.filter((source) => sameName(source.alias ?? source.table, context.qualifier))
    : context.sources;
  if (targets.length === 0) {
    return undefined;
  }

  const usedAliases = new Set<string>();
  for (const source of context.sources) {
    usedAliases.add((source.alias ?? source.table).toUpperCase());
  }

  const edits: TextReplacement[] = [];
  const columns: string[] = [];
  for (const source of targets) {
    const names = options.getColumns(source);
    if (!names || names.length === 0) {
      return undefined;
    }
    let qualifier = source.alias ? source.qualifierText : undefined;
    if (!qualifier) {
      if (source.isSubquery || isReferencedByTableName(sql, source)) {
        // Netezza rejects `T.COL` once `T` is aliased, so keep the table name.
        qualifier = source.qualifierText;
      } else {
        const preferred = options.getConfiguredAlias?.(source) ?? getTableAliasBase(source.table);
        qualifier = getUniqueTableAlias(preferred, usedAliases);
        usedAliases.add(qualifier);
        edits.push({ start: source.pathEndOffset, end: source.pathEndOffset, newText: ` ${qualifier}` });
      }
    }
    for (const name of names) {
      columns.push(`${qualifier}.${formatIdentifierForSql(name, options.databaseKind)}`);
    }
  }

  edits.push({
    start: context.replaceStart,
    end: context.starEnd,
    newText: layoutColumns(sql, context, columns, options.layout ?? "leadingComma", options.indentUnit ?? "    "),
  });
  return edits.sort((left, right) => right.start - left.start);
}

/** Applies non-overlapping replacements (any order) to `text`. */
export function applyTextReplacements(text: string, edits: readonly TextReplacement[]): string {
  return [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce((current, edit) => current.slice(0, edit.start) + edit.newText + current.slice(edit.end), text);
}

function layoutColumns(
  sql: string,
  context: SelectStarContext,
  columns: readonly string[],
  layout: ExpandStarLayout,
  indentUnit: string,
): string {
  if (layout === "singleLine") {
    return columns.join(", ");
  }
  const lineStart = sql.lastIndexOf("\n", Math.max(0, context.replaceStart - 1)) + 1;
  const linePrefix = sql.slice(lineStart, context.replaceStart);
  const lineIndent = /^[ \t]*/.exec(linePrefix)?.[0] ?? "";
  const separator = layout === "leadingComma" ? ", " : ",";

  // `*` already alone on its line: keep its indentation, no extra blank lines.
  const startsLine = linePrefix.trim() === "";
  const indent = startsLine ? lineIndent : lineIndent + indentUnit;
  const joined = layout === "leadingComma"
    ? columns.join(`\n${indent}${separator}`)
    : columns.join(`${separator}\n${indent}`);
  const head = startsLine ? "" : `\n${indent}`;
  const followedByLineBreak = /^[ \t]*(\r?\n|$)/.test(sql.slice(context.starEnd));
  const tail = followedByLineBreak ? "" : `\n${lineIndent}`;
  return `${head}${joined}${tail}`;
}

function findFromAtSameDepth(tokens: readonly IToken[], starIndex: number): number | undefined {
  let depth = 0;
  for (let index = starIndex + 1; index < tokens.length; index++) {
    const name = tokens[index].tokenType.name;
    if (name === "LParen") depth++;
    else if (name === "RParen") {
      if (depth === 0) return undefined;
      depth--;
    } else if (depth === 0 && name === "From") return index;
    else if (depth === 0 && (name === "Semicolon" || name === "Select")) return undefined;
  }
  return undefined;
}

function parseFromSources(tokens: readonly IToken[], fromIndex: number): SelectStarSource[] | undefined {
  const sources: SelectStarSource[] = [];
  let index = fromIndex + 1;
  while (index < tokens.length) {
    const parsed = parseSource(tokens, index);
    if (!parsed) {
      return undefined;
    }
    sources.push(parsed.source);
    index = parsed.nextIndex;

    // Skip the join condition up to the next relation, or stop at the clause end.
    let depth = 0;
    let nextSource: number | undefined;
    for (; index < tokens.length; index++) {
      const name = tokens[index].tokenType.name;
      if (name === "LParen") depth++;
      else if (name === "RParen") {
        if (depth === 0) return sources;
        depth--;
      } else if (depth === 0 && CLAUSE_END_TOKENS.has(name)) {
        return sources;
      } else if (depth === 0 && (name === "Comma" || name === "Join")) {
        nextSource = index + 1;
        break;
      } else if (depth === 0 && JOIN_MODIFIER_TOKENS.has(name)) {
        continue;
      }
    }
    if (nextSource === undefined) {
      return sources;
    }
    index = nextSource;
  }
  return sources;
}

function parseSource(
  tokens: readonly IToken[],
  start: number,
): { source: SelectStarSource; nextIndex: number } | undefined {
  let index = start;
  let isSubquery = false;
  const segments: string[] = [];
  let tableText = "";
  let pathEnd: number;

  if (tokens[index]?.tokenType.name === "LParen") {
    let depth = 0;
    for (; index < tokens.length; index++) {
      const name = tokens[index].tokenType.name;
      if (name === "LParen") depth++;
      else if (name === "RParen" && --depth === 0) break;
    }
    if (index >= tokens.length) {
      return undefined;
    }
    isSubquery = true;
    pathEnd = tokenEnd(tokens[index]);
    index++;
  } else {
    // DB.SCHEMA.TABLE, DB..TABLE, SCHEMA.TABLE or TABLE.
    let expectName = true;
    for (; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.tokenType.name === "Dot") {
        if (expectName) segments.push("");
        expectName = true;
        continue;
      }
      if (!expectName || !isPathSegmentToken(token)) break;
      segments.push(unquote(token.image));
      tableText = token.image;
      expectName = false;
    }
    if (segments.length === 0 || expectName) {
      return undefined;
    }
    if (tokens[index]?.tokenType.name === "LParen") {
      // Table functions have no catalog column list.
      return undefined;
    }
    const last = tokens[index - 1];
    pathEnd = tokenEnd(last);
  }

  let alias: string | undefined;
  let aliasText: string | undefined;
  if (tokens[index]?.tokenType.name === "As") {
    index++;
  }
  if (tokens[index] && isNameToken(tokens[index])) {
    aliasText = tokens[index].image;
    alias = unquote(aliasText);
    index++;
  }
  if (isSubquery && !alias) {
    return undefined;
  }

  const table = isSubquery ? (alias ?? "") : segments[segments.length - 1];
  const qualifiers = segments.slice(0, -1);
  const source: SelectStarSource = {
    table,
    database: qualifiers.length >= 2 ? qualifiers[0] || undefined : undefined,
    schema: qualifiers.length >= 2 ? qualifiers[1] || undefined : qualifiers[0] || undefined,
    alias,
    qualifierText: aliasText ?? tableText,
    isSubquery,
    pathEndOffset: pathEnd,
  };
  return { source, nextIndex: index };
}

/**
 * True when the statement already uses `TABLE.column` (or `TABLE.*`) for this
 * unaliased source. The relation's own last path segment is never followed by
 * a dot, so FROM paths such as `DB..TABLE` do not count.
 */
function isReferencedByTableName(sql: string, source: SelectStarSource): boolean {
  const tokens = SqlLexer.tokenize(sql).tokens;
  return tokens.some((token, index) =>
    tokens[index + 1]?.tokenType.name === "Dot" &&
    isNameToken(token) &&
    sameName(unquote(token.image), source.table) &&
    !sameName(source.schema, source.table) &&
    !sameName(source.database, source.table),
  );
}

/** Exclusive end offset; `endOffset` is not reliable across lexer position-tracking modes. */
function tokenEnd(token: IToken): number {
  return token.startOffset + token.image.length;
}

function isNameToken(token: IToken): boolean {
  const name = token.tokenType.name;
  return name === "Identifier" || name === "QuotedIdentifier";
}

/** Path segments may also be non-reserved keywords lexed as their own token. */
function isPathSegmentToken(token: IToken): boolean {
  return isNameToken(token) || /^[A-Za-z_][A-Za-z0-9_$]*$/.test(token.image);
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/""/g, '"')
    : value;
}

function sameName(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "").toUpperCase() === (right ?? "").toUpperCase();
}
