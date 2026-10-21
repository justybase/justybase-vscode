import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  Position,
} from "vscode-languageserver/node";
import type { DatabaseKind } from "../contracts/database";
import { formatIdentifierForSql } from "../utils/identifierUtils";
import { applyPrefixRange } from "./completionRenderer";

/**
 * Whole-phrase INSERT completions (Redgate SQL Prompt / DataGrip style):
 * `INSERT INTO T |` -> `(c1, c2) VALUES (c1, c2)` with tab stops,
 * `INSERT INTO T (|` -> all columns, and
 * `INSERT INTO T (a, b) VALUES (|` -> one tab stop per listed column.
 */

function escapeSnippetText(value: string): string {
  return value.replace(/[\\$}]/g, (character) => `\\${character}`);
}

function placeholders(columns: readonly string[]): string {
  return columns
    .map((column, index) => `\${${index + 1}:${escapeSnippetText(column)}}`)
    .join(", ");
}

/** `INSERT INTO T |`: column list plus a VALUES row with one tab stop per column. */
export function buildInsertColumnsAndValuesItem(
  columnNames: readonly string[],
  typedPrefix: string,
  position: Position,
  databaseKind?: DatabaseKind,
): CompletionItem | undefined {
  if (columnNames.length === 0) {
    return undefined;
  }
  const columns = columnNames.map((name) => formatIdentifierForSql(name, databaseKind));
  const columnList = columns.join(", ");
  const item: CompletionItem = {
    label: `(${columnList}) VALUES (…)`,
    kind: CompletionItemKind.Snippet,
    detail: "Insert all columns",
    // Typing `V`/`VAL` after the table name should still find the template.
    filterText: `VALUES ${columnList}`,
    insertText: `(${escapeSnippetText(columnList)}) VALUES (${placeholders(columns)})`,
    insertTextFormat: InsertTextFormat.Snippet,
    sortText: "0_insert_values_template",
    preselect: true,
  };
  applyPrefixRange(item, position, typedPrefix);
  return item;
}

/** `INSERT INTO T (|`: every column at once, shown before the single columns. */
export function buildInsertAllColumnsItem(
  columnNames: readonly string[],
  typedPrefix: string,
  position: Position,
  databaseKind?: DatabaseKind,
): CompletionItem | undefined {
  if (columnNames.length < 2) {
    return undefined;
  }
  const columnList = columnNames.map((name) => formatIdentifierForSql(name, databaseKind)).join(", ");
  const item: CompletionItem = {
    label: columnList,
    kind: CompletionItemKind.Snippet,
    detail: "All columns",
    insertText: columnList,
    sortText: "0_insert_all_columns",
  };
  applyPrefixRange(item, position, typedPrefix);
  return item;
}

const INSERT_VALUES_PATTERN = /\bINSERT\s+INTO\s+[^\s(]+\s*\(([^()]*)\)\s*VALUES\s*\(\s*$/i;

/** `INSERT INTO T (a, b) VALUES (|`: tab stops named after the listed columns. */
export function buildInsertValuesPlaceholderItem(
  statementPrefixBeforeTyped: string,
  typedPrefix: string,
  position: Position,
): CompletionItem | undefined {
  const match = INSERT_VALUES_PATTERN.exec(statementPrefixBeforeTyped);
  const columns = match?.[1]
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  if (!columns || columns.length === 0) {
    return undefined;
  }
  const item: CompletionItem = {
    label: `${columns.join(", ")} (values)`,
    kind: CompletionItemKind.Snippet,
    detail: "One value per listed column",
    filterText: columns.join(", "),
    insertText: placeholders(columns),
    insertTextFormat: InsertTextFormat.Snippet,
    sortText: "0_insert_value_placeholders",
  };
  applyPrefixRange(item, position, typedPrefix);
  return item;
}

/** Column names already listed between `(` and the cursor. */
export function getListedInsertColumns(statementPrefixBeforeTyped: string): Set<string> {
  const open = statementPrefixBeforeTyped.lastIndexOf("(");
  return new Set(
    statementPrefixBeforeTyped
      .slice(open + 1)
      .split(",")
      .map((column) => column.trim().replace(/^"|"$/g, "").toUpperCase())
      .filter(Boolean),
  );
}
