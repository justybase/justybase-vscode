import { CompletionTriggerKind, type CompletionItem, type Position } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { IToken } from "chevrotain";
import { isConfidentJoinSuggestion, type JoinGhostKind } from "@justybase/sql-core/joinKnowledge";
import type { JoinGhostMode, JoinGhostSuggestion } from "../lsp/protocol";
import { SqlLexer } from "../sqlParser";
import { detectGroupByGhost } from "./groupByGhost";
import { cursorStatementTokens } from "./ghostStatementTokens";

/**
 * Inline ghost text for a JOIN that is certain enough to be typed for the user.
 *
 * Ranking is never re-implemented here: the completion engine produces the
 * same list as the suggest widget, and the ghost is its top item when
 * `isConfidentJoinSuggestion` accepts it. This module only decides where a
 * ghost may appear and what text precedes the item:
 *
 * - after `JOIN ` → the target (`DIMDATE D ON F.DATEKEY = D.DATEKEY`);
 * - after `JOIN T [alias] ` → `ON` + the condition;
 * - after `JOIN T [alias] ON ` → the condition;
 * - (`newLine` mode) on an empty line that ends the FROM clause of a top-level
 *   SELECT → `JOIN` + the target.
 */

const JOIN_MODIFIERS = new Set(["Left", "Right", "Inner", "Full", "Outer", "Cross", "Natural"]);
const CLAUSE_BOUNDARIES = new Set([
  "Where", "GroupBy", "Group", "Having", "OrderBy", "Order", "Limit", "Union", "Intersect",
  "Except", "Minus", "Qualify", "Window",
]);
/** Tokens that may follow an inserted JOIN clause. */
const NEW_LINE_FOLLOWERS = new Set([
  "Semicolon", "Join", ...JOIN_MODIFIERS, ...CLAUSE_BOUNDARIES,
]);
/** Tokens that can end a complete FROM item or ON condition. */
const COMPLETE_ENDINGS = new Set([
  "Identifier", "QuotedIdentifier", "RParen", "NumberLiteral", "StringLiteral",
]);
const NAME_PATTERN = /^(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$#]*)$/u;
const RESERVED_AFTER_TARGET = new Set([
  "On", "Using", "Join", "Where", "Comma", ...JOIN_MODIFIERS, ...CLAUSE_BOUNDARIES,
]);

interface GhostSlot {
  kind: JoinGhostKind;
  /** Text the engine is asked to complete after (also shown before the item). */
  lead: string;
}

export interface JoinGhostEngine {
  provideCompletionItems(
    document: TextDocument,
    position: Position,
    triggerKind?: CompletionTriggerKind,
  ): Promise<CompletionItem[]>;
}

function isName(token: IToken | undefined): boolean {
  return token !== undefined
    && NAME_PATTERN.test(token.image)
    && !RESERVED_AFTER_TARGET.has(token.tokenType.name);
}

function statementTokens(textBefore: string): IToken[] | undefined {
  return cursorStatementTokens(textBefore)?.tokens;
}

function lastJoinIndex(tokens: readonly IToken[]): number {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const name = tokens[index].tokenType.name;
    if (name === "Join") {
      return index;
    }
    if (CLAUSE_BOUNDARIES.has(name) || name === "From" || name === "Select") {
      return -1;
    }
  }
  return -1;
}

/** `T`, `S.T`, `DB.S.T`, `DB..T`, then optional `[AS] alias`; returns the end index or -1. */
function readJoinTarget(tokens: readonly IToken[], start: number): number {
  let index = start;
  if (!isName(tokens[index])) {
    return -1;
  }
  index += 1;
  while (tokens[index]?.tokenType.name === "Dot") {
    while (tokens[index]?.tokenType.name === "Dot") {
      index += 1;
    }
    if (!isName(tokens[index])) {
      return -1;
    }
    index += 1;
  }
  if (tokens[index]?.tokenType.name === "As") {
    index += 1;
    if (!isName(tokens[index])) {
      return -1;
    }
    return index + 1;
  }
  return isName(tokens[index]) ? index + 1 : index;
}

/** Paren depth 0 and the statement is a SELECT still inside its FROM clause. */
function endsTopLevelFromClause(tokens: readonly IToken[]): boolean {
  let depth = 0;
  let clause: string | undefined;
  for (const token of tokens) {
    const name = token.tokenType.name;
    if (name === "LParen") depth += 1;
    else if (name === "RParen") depth -= 1;
    else if (depth === 0) {
      if (name === "Select" || name === "From" || name === "Join" || name === "On") clause = name;
      else if (CLAUSE_BOUNDARIES.has(name)) clause = name;
    }
  }
  const first = tokens[0]?.tokenType.name;
  const last = tokens[tokens.length - 1]?.tokenType.name;
  return depth === 0
    && (first === "Select" || first === "With")
    && (clause === "From" || clause === "Join" || clause === "On")
    && last !== undefined
    && COMPLETE_ENDINGS.has(last);
}

function firstTokenAfter(textAfter: string): string | undefined {
  const lexed = SqlLexer.tokenize(textAfter.slice(0, 256));
  return lexed.tokens[0]?.tokenType.name;
}

/** Where a ghost may be shown at the cursor, if anywhere. */
export function detectJoinGhostSlot(
  textBefore: string,
  textAfter: string,
  mode: JoinGhostMode,
): GhostSlot | undefined {
  if (mode === "off" || !/\s$/u.test(textBefore)) {
    return undefined;
  }
  const restOfLine = textAfter.split(/\r?\n/u, 1)[0];
  if (restOfLine.trim().length > 0) {
    return undefined;
  }
  const tokens = statementTokens(textBefore);
  if (!tokens || tokens.length === 0) {
    return undefined;
  }
  const last = tokens[tokens.length - 1].tokenType.name;
  if (last === "Join") {
    return { kind: "target", lead: "" };
  }
  const join = lastJoinIndex(tokens);
  if (join >= 0) {
    if (last === "On" && readJoinTarget(tokens, join + 1) === tokens.length - 1) {
      return { kind: "predicate", lead: "" };
    }
    if (readJoinTarget(tokens, join + 1) === tokens.length && tokens.length > join + 1) {
      return { kind: "predicate", lead: "ON " };
    }
  }
  if (mode !== "afterJoinAndNewLine") {
    return undefined;
  }
  const lineStart = textBefore.lastIndexOf("\n");
  const currentLine = textBefore.slice(lineStart + 1);
  if (lineStart < 0 || currentLine.trim().length > 0) {
    return undefined;
  }
  const follower = firstTokenAfter(textAfter);
  if (follower !== undefined && !NEW_LINE_FOLLOWERS.has(follower)) {
    return undefined;
  }
  return endsTopLevelFromClause(tokens) ? { kind: "target", lead: "JOIN " } : undefined;
}

function relationOf(item: CompletionItem): JoinGhostSuggestion["relation"] | undefined {
  return (item.data as { joinKnowledgeRelation?: JoinGhostSuggestion["relation"] } | undefined)
    ?.joinKnowledgeRelation;
}

/**
 * The ghost for the cursor, or `null` when no position applies or the top
 * suggestion is not confident.
 */
export async function computeJoinGhostSuggestion(
  engine: JoinGhostEngine,
  document: TextDocument,
  position: Position,
  mode: JoinGhostMode,
  options: { groupBy?: boolean } = {},
): Promise<JoinGhostSuggestion | null> {
  const text = document.getText();
  const offset = document.offsetAt(position);
  if (options.groupBy) {
    const groupBy = detectGroupByGhost(text.slice(0, offset), text.slice(offset));
    if (groupBy) {
      return { kind: "groupBy", insertText: groupBy };
    }
  }
  const slot = detectJoinGhostSlot(text.slice(0, offset), text.slice(offset), mode);
  if (!slot) {
    return null;
  }
  const virtualText = `${text.slice(0, offset)}${slot.lead}${text.slice(offset)}`;
  const virtual = TextDocument.create(document.uri, document.languageId, document.version, virtualText);
  const items = await engine.provideCompletionItems(
    virtual,
    virtual.positionAt(offset + slot.lead.length),
    CompletionTriggerKind.Invoked,
  );
  const ranked = items
    .filter((item) => relationOf(item) !== undefined)
    .sort((left, right) =>
      (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label)
      || left.label.localeCompare(right.label));
  const top = ranked[0];
  const relation = top ? relationOf(top) : undefined;
  if (!top || !relation || !isConfidentJoinSuggestion(slot.kind, top.sortText, ranked[1]?.sortText)) {
    return null;
  }
  const insert = typeof top.insertText === "string" ? top.insertText : top.label;
  return {
    kind: slot.kind,
    insertText: `${slot.lead}${insert}`,
    relation,
  };
}
