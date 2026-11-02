import type { IToken } from "chevrotain";
import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  Position,
} from "vscode-languageserver/node";

import type { LocalDefinition } from "../providers/types";
import { SqlLexer } from "../sqlParser";
import { matchesPrefix } from "./completionRanker";
import { applyPrefixRange, toLocalVariableItems } from "./completionRenderer";

/**
 * Completion inside a Netezza `CREATE PROCEDURE ... LANGUAGE NZPLSQL` header
 * and `BEGIN_PROC ... END_PROC` body.
 *
 * Every suggestion names the live-verified case in
 * `src/__tests__/sqlParser/procedure/procedureMatrixCases.ts` that proves
 * Netezza accepts it (`provenBy`); a test keeps the two in step. Constructs
 * Netezza rejects (explicit cursors, named exceptions, `RAISE ERROR`,
 * `PERFORM`, the CASE statement, ...) are never offered.
 */

export interface ProcedureSuggestion {
  label: string;
  /** Snippet text when it differs from the label. */
  insert?: string;
  detail: string;
  /** Matrix case id proving Netezza accepts the construct. */
  provenBy: string;
}

const s = (label: string, detail: string, provenBy: string, insert?: string): ProcedureSuggestion =>
  ({ label, detail, provenBy, insert });

const DECLARE_TYPES: readonly ProcedureSuggestion[] = [
  s("INTEGER", "integer", "decl_scalar_types"),
  s("BIGINT", "64-bit integer", "decl_scalar_types"),
  s("SMALLINT", "16-bit integer", "decl_scalar_types"),
  s("BYTEINT", "8-bit integer", "decl_scalar_types"),
  s("INT4", "integer", "decl_scalar_types"),
  s("INT8", "64-bit integer", "decl_scalar_types"),
  s("NUMERIC", "NUMERIC(precision, scale)", "decl_scalar_types", "NUMERIC(${1:18}, ${2:2})"),
  s("DOUBLE PRECISION", "floating point", "decl_scalar_types"),
  s("REAL", "floating point", "decl_scalar_types"),
  s("VARCHAR", "VARCHAR(length)", "decl_scalar_types", "VARCHAR(${1:100})"),
  s("CHAR", "CHAR(length)", "decl_scalar_types", "CHAR(${1:1})"),
  s("NVARCHAR", "NVARCHAR(length)", "decl_scalar_types", "NVARCHAR(${1:100})"),
  s("BOOLEAN", "boolean", "decl_scalar_types"),
  s("DATE", "date", "decl_scalar_types"),
  s("TIMESTAMP", "timestamp", "decl_scalar_types"),
  s("TIME", "time", "decl_scalar_types"),
  s("INTERVAL", "interval", "decl_scalar_types"),
  s("RECORD", "row of FOR ... IN SELECT or SELECT INTO", "decl_record_for_select"),
];

const DECLARE_MODIFIERS: readonly ProcedureSuggestion[] = [
  s("ALIAS FOR", "name a procedure argument", "decl_alias_for_dollar", "ALIAS FOR \\$${1:1};"),
  s("CONSTANT", "value that cannot change", "decl_constant_not_null_default"),
  s("VARRAY", "VARRAY(size) OF type", "decl_varray", "VARRAY(${1:10}) OF ${2:INTEGER}"),
];

const RETURN_TYPES: readonly ProcedureSuggestion[] = [
  s("INT4", "integer result", "hdr_minimal_int4"),
  s("INT8", "64-bit integer result", "hdr_int8"),
  s("BIGINT", "64-bit integer result", "hdr_returns_bigint"),
  s("BOOLEAN", "boolean result", "hdr_returns_boolean"),
  s("NUMERIC", "NUMERIC(precision, scale) result", "hdr_returns_numeric_ps", "NUMERIC(${1:18}, ${2:2})"),
  s("VARCHAR", "VARCHAR(length) result", "hdr_returns_varchar_n", "VARCHAR(${1:100})"),
  s("CHARACTER VARYING(ANY)", "string result of any length", "hdr_varchar_any"),
  s("DATE", "date result", "hdr_returns_date"),
  s("TIMESTAMP", "timestamp result", "hdr_returns_timestamp"),
  s("REFTABLE", "result set shaped like a table", "hdr_reftable", "REFTABLE(${1:TABLE_NAME})"),
];

const HEADER_CLAUSES: readonly ProcedureSuggestion[] = [
  s("LANGUAGE NZPLSQL", "procedure language", "hdr_minimal_int4"),
  s("EXECUTE AS OWNER", "run with the owner's permissions", "hdr_execute_as_owner_after_language"),
  s("EXECUTE AS CALLER", "run with the caller's permissions", "hdr_execute_as_caller"),
];

const STATEMENTS: readonly ProcedureSuggestion[] = [
  s("IF", "IF condition THEN ... END IF;", "ctrl_if_elsif_else"),
  s("FOR", "FOR i IN 1..n LOOP / FOR rec IN SELECT ... LOOP", "ctrl_for_range"),
  s("WHILE", "WHILE condition LOOP ... END LOOP;", "ctrl_while"),
  s("LOOP", "LOOP ... END LOOP;", "ctrl_loop_exit_when"),
  s("RAISE NOTICE", "message; arguments must be variables", "raise_notice_variable", "RAISE NOTICE '${1:message} %', ${2:variable};"),
  s("RAISE EXCEPTION", "abort with a message", "exc_sqlerrm_notice", "RAISE EXCEPTION '${1:message}';"),
  s("RAISE DEBUG", "debug message", "raise_debug", "RAISE DEBUG '${1:message} %', ${2:variable};"),
  s("RETURN", "end the procedure", "sys_return_no_expr"),
  s("EXECUTE IMMEDIATE", "run dynamic SQL", "sql_execute_immediate_ddl", "EXECUTE IMMEDIATE ${1:sql_text};"),
  s("BEGIN", "nested block", "ctrl_nested_begin"),
  s("DECLARE", "nested block with its own variables", "decl_nested_block_shadow"),
  s("SELECT", "SELECT ... INTO variable (a SELECT without INTO fails)", "sql_select_into"),
  s("INSERT INTO", "insert rows", "sql_insert_update_delete"),
  s("UPDATE", "update rows", "sql_insert_update_delete"),
  s("DELETE FROM", "delete rows", "sql_insert_update_delete"),
  s("TRUNCATE", "empty a table", "sql_truncate"),
  s("CALL", "call a procedure or function", "sql_call_in_proc"),
  s("COMMIT", "commit the transaction", "sql_commit_in_proc"),
  s("ROLLBACK", "roll back the transaction", "sql_rollback_in_proc"),
];

const IF_CLOSERS: readonly ProcedureSuggestion[] = [
  s("ELSIF", "another condition", "ctrl_if_elsif_else"),
  s("ELSE", "otherwise", "ctrl_if_elsif_else"),
  s("END IF;", "close the IF", "ctrl_if_elsif_else"),
];

const LOOP_CLOSERS: readonly ProcedureSuggestion[] = [
  s("END LOOP;", "close the loop", "ctrl_loop_exit_when"),
  s("EXIT WHEN", "leave the loop when a condition holds", "ctrl_loop_exit_when", "EXIT WHEN ${1:condition};"),
  s("EXIT", "leave the innermost loop (inside a nested BEGIN block use EXIT label)", "ctrl_labeled_loop"),
];

const HANDLERS: readonly ProcedureSuggestion[] = [
  s("WHEN OTHERS THEN", "any error; SQLERRM holds the message", "exc_when_others"),
  s("WHEN TRANSACTION_ABORTED THEN", "serialization conflict", "exc_when_transaction_aborted"),
];

const HANDLER_CONDITIONS: readonly ProcedureSuggestion[] = [
  s("OTHERS", "any error; SQLERRM holds the message", "exc_when_others", "OTHERS THEN"),
  s("TRANSACTION_ABORTED", "serialization conflict", "exc_when_transaction_aborted", "TRANSACTION_ABORTED THEN"),
];

const RAISE_LEVELS: readonly ProcedureSuggestion[] = [
  s("NOTICE", "message, execution continues", "raise_notice_variable"),
  s("EXCEPTION", "abort with a message", "exc_sqlerrm_notice"),
  s("DEBUG", "debug message", "raise_debug"),
];

const FOR_SOURCES: readonly ProcedureSuggestion[] = [
  s("SELECT", "loop over query rows (declare the variable RECORD)", "decl_record_for_select"),
  s("REVERSE", "count down", "ctrl_for_reverse"),
  s("EXECUTE", "loop over a dynamic query", "ctrl_for_in_execute_dynamic"),
];

/** All suggestion tables, for the provenance test. */
export const NZPLSQL_COMPLETION_TABLES: Readonly<Record<string, readonly ProcedureSuggestion[]>> = {
  DECLARE_TYPES, DECLARE_MODIFIERS, RETURN_TYPES, HEADER_CLAUSES, STATEMENTS,
  IF_CLOSERS, LOOP_CLOSERS, HANDLERS, HANDLER_CONDITIONS, RAISE_LEVELS, FOR_SOURCES,
};

interface Block {
  kind: "block" | "if" | "loop" | "case";
  /** A block whose EXCEPTION section has started. */
  exception?: boolean;
}

export interface ProcedureCompletionContext {
  /** Suggestions in rank order. */
  suggestions: ProcedureSuggestion[];
  /** Also offer procedure variables and parameters. */
  variables: boolean;
  /** Also offer SQL functions (expression positions). */
  functions?: boolean;
}

const EXPRESSION_STARTERS = new Set(["IF", "ELSIF", "ELSEIF", "WHILE", "RETURN"]);

function upper(token: IToken | undefined): string {
  return token ? token.image.toUpperCase() : "";
}

function isWord(token: IToken | undefined): boolean {
  return token !== undefined && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(token.image);
}

function tokensBefore(statementPrefix: string, typedPrefix: string): IToken[] {
  const text =
    typedPrefix && statementPrefix.toUpperCase().endsWith(typedPrefix.toUpperCase())
      ? statementPrefix.slice(0, statementPrefix.length - typedPrefix.length)
      : statementPrefix;
  return SqlLexer.tokenize(text).tokens;
}

/** Upper-case words of the statement the cursor is in (after the last `;` or block keyword). */
function currentStatementWords(tokens: readonly IToken[]): string[] {
  let start = tokens.length;
  while (start > 0) {
    const word = upper(tokens[start - 1]);
    if (word === ";" || word === "BEGIN" || word === "THEN" || word === "ELSE" || (word === "LOOP" && upper(tokens[start - 2]) !== "END")) {
      break;
    }
    start--;
  }
  return tokens.slice(start).map(upper);
}

/** Output column names of a SELECT list (`a`, `t.b`, `expr AS c`); unnamed expressions are skipped. */
function selectListNames(items: readonly IToken[]): string[] {
  const names: string[] = [];
  let current: IToken[] = [];
  let depth = 0;
  const flush = () => {
    const words = current.map(upper);
    const asAt = words.lastIndexOf("AS");
    if (asAt >= 0 && isWord(current[asAt + 1])) {
      names.push(current[asAt + 1].image);
    } else if (current.length > 0 && current.every((token, index) => (index % 2 === 0 ? isWord(token) : token.image === "."))) {
      names.push(current[current.length - 1].image);
    }
    current = [];
  };
  for (const token of items) {
    if (token.image === "(") depth++;
    else if (token.image === ")") depth--;
    if (token.image === "," && depth === 0) {
      flush();
    } else {
      current.push(token);
    }
  }
  flush();
  return names;
}

/** SELECT list tokens from `start` (just after SELECT) up to a top-level stop word. */
function selectListFrom(tokens: readonly IToken[], start: number, stops: ReadonlySet<string>): IToken[] {
  const list: IToken[] = [];
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.image === "(") depth++;
    else if (token.image === ")") depth--;
    if (depth === 0 && (stops.has(upper(token)) || token.image === ";")) {
      break;
    }
    list.push(token);
  }
  return list;
}

/**
 * Fields of a record variable at `rec.`: names from `FOR rec IN SELECT ...`
 * or `SELECT ... INTO rec`. `undefined` when `name` is not a record of the
 * procedure; an empty list when its fields are unknown (`SELECT *`).
 */
function recordFields(tokens: readonly IToken[], name: string): string[] | undefined {
  const target = name.toUpperCase();
  let isRecord = false;
  const fields = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const word = upper(tokens[index]);
    if (word === target && [";", "DECLARE"].includes(upper(tokens[index - 1]))) {
      for (let next = index + 1; next < tokens.length && tokens[next].image !== ";"; next++) {
        if (["RECORD", "ROWTYPE"].includes(upper(tokens[next]))) isRecord = true;
      }
    }
    if (word === "FOR" && upper(tokens[index + 1]) === target && upper(tokens[index + 2]) === "IN") {
      isRecord = true;
      if (upper(tokens[index + 3]) === "SELECT") {
        selectListNames(selectListFrom(tokens, index + 4, new Set(["FROM", "LOOP"]))).forEach((field) => fields.add(field));
      }
    }
    if (word === "SELECT") {
      const list = selectListFrom(tokens, index + 1, new Set(["INTO", "FROM"]));
      const after = index + 1 + list.length;
      if (upper(tokens[after]) === "INTO" && upper(tokens[after + 1]) === target) {
        selectListNames(list).forEach((field) => fields.add(field));
      }
    }
  }
  return isRecord ? [...fields] : undefined;
}

function headerContext(tokens: readonly IToken[]): ProcedureCompletionContext | undefined {
  const words = tokens.map(upper);
  const last = words[words.length - 1];
  const returnsAt = words.lastIndexOf("RETURNS");
  if (last === "RETURNS") {
    return { suggestions: [...RETURN_TYPES], variables: false };
  }
  if (last === "LANGUAGE") {
    return { suggestions: [s("NZPLSQL", "procedure language", "hdr_minimal_int4")], variables: false };
  }
  if (last === "NZPLSQL") {
    return { suggestions: [s("AS BEGIN_PROC", "start the body", "hdr_minimal_int4", "AS\nBEGIN_PROC\n$0\nEND_PROC;")], variables: false };
  }
  if (returnsAt < 0 || returnsAt === words.length - 1) {
    return undefined;
  }
  // After a complete RETURNS type (balanced parentheses, not mid-clause).
  let depth = 0;
  for (const word of words.slice(returnsAt + 1)) {
    if (word === "(") depth++;
    else if (word === ")") depth--;
  }
  if (depth !== 0) {
    return undefined;
  }
  if (last === "EXECUTE" || (last === "AS" && words[words.length - 2] === "EXECUTE")) {
    const prefix = last === "EXECUTE" ? "AS " : "";
    return {
      suggestions: [
        s(`${prefix}OWNER`, "run with the owner's permissions", "hdr_execute_as_owner_after_language"),
        s(`${prefix}CALLER`, "run with the caller's permissions", "hdr_execute_as_caller"),
      ],
      variables: false,
    };
  }
  if (last === "AS") {
    return undefined;
  }
  const remaining = HEADER_CLAUSES.filter((clause) =>
    clause.label.startsWith("LANGUAGE") ? !words.includes("LANGUAGE") : !words.includes("EXECUTE"));
  return remaining.length > 0 ? { suggestions: remaining, variables: false } : undefined;
}

const STATEMENT_START_AFTER = new Set([";", "BEGIN", "THEN", "ELSE", "LOOP", ">"]);

function bodyContext(tokens: readonly IToken[], returnsReftable: boolean): ProcedureCompletionContext | undefined {
  const stack: Block[] = [];
  let declaring = false;
  const labels: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const word = upper(tokens[index]);
    const previous = upper(tokens[index - 1]);
    const next = upper(tokens[index + 1]);
    if (word === "<" && previous === "<" && isWord(tokens[index + 1])) {
      labels.push(tokens[index + 1].image);
    }
    if (tokens[index].tokenType.name === "StringLiteral") {
      continue;
    }
    if (word === "DECLARE") {
      declaring = true;
    } else if (word === "BEGIN") {
      declaring = false;
      stack.push({ kind: "block" });
    } else if (word === "IF" && previous !== "END") {
      stack.push({ kind: "if" });
    } else if (word === "LOOP" && previous !== "END") {
      stack.push({ kind: "loop" });
    } else if (word === "CASE") {
      stack.push({ kind: "case" });
    } else if (word === "EXCEPTION" && stack[stack.length - 1]?.kind === "block" && previous !== "RAISE") {
      stack[stack.length - 1].exception = true;
    } else if (word === "END") {
      const closes = next === "IF" ? "if" : next === "LOOP" ? "loop" : undefined;
      const top = stack[stack.length - 1];
      if (closes ? top?.kind === closes : top !== undefined) {
        stack.pop();
      }
    }
  }

  const last = tokens[tokens.length - 1];
  const lastWord = upper(last);
  const previousWord = upper(tokens[tokens.length - 2]);
  const top = stack[stack.length - 1];

  if (lastWord === "." && isWord(tokens[tokens.length - 2]) && upper(tokens[tokens.length - 3]) !== ".") {
    const fields = recordFields(tokens, tokens[tokens.length - 2].image);
    if (fields) {
      return {
        suggestions: fields.map((field) => s(field, "record field", "raise_record_field")),
        variables: false,
      };
    }
  }

  if (declaring) {
    if (lastWord === "DECLARE" || lastWord === ";") {
      return { suggestions: [s("BEGIN", "start the block", "hdr_minimal_int4")], variables: false };
    }
    if (isWord(last) && (previousWord === "DECLARE" || previousWord === ";")) {
      return { suggestions: [...DECLARE_TYPES, ...DECLARE_MODIFIERS], variables: false };
    }
    if (lastWord === "CONSTANT") {
      return { suggestions: DECLARE_TYPES.filter((type) => type.label !== "RECORD"), variables: false };
    }
    return undefined;
  }
  if (!top || top.kind === "case") {
    return undefined;
  }
  if (lastWord === "RAISE") {
    return { suggestions: [...RAISE_LEVELS], variables: false };
  }
  if (lastWord === "WHEN" && top.exception && (previousWord === "EXCEPTION" || previousWord === ";")) {
    return { suggestions: [...HANDLER_CONDITIONS], variables: false };
  }
  if (lastWord === "EXIT") {
    return {
      suggestions: [
        s("WHEN", "leave when a condition holds", "ctrl_loop_exit_when", "WHEN ${1:condition};"),
        ...labels.map((label) => s(label, "loop label", "ctrl_labeled_loop")),
      ],
      variables: false,
    };
  }
  if (lastWord === "IN" && isWord(tokens[tokens.length - 2]) && upper(tokens[tokens.length - 3]) === "FOR") {
    return { suggestions: [...FOR_SOURCES], variables: false };
  }
  if (lastWord === "EXECUTE") {
    return { suggestions: [s("IMMEDIATE", "run dynamic SQL", "sql_execute_immediate_ddl")], variables: false };
  }
  if (lastWord === "RETURN" && returnsReftable) {
    return { suggestions: [s("REFTABLE", "return the filled REFTABLENAME table", "sys_reftable_resultset", "REFTABLE;")], variables: false };
  }

  const statementWords = currentStatementWords(tokens);
  if (statementWords[0] === "RAISE" && lastWord === ",") {
    // RAISE arguments must be variables or record fields (live-verified).
    return { suggestions: [], variables: true };
  }
  const assignment = lastWord === "=" && statementWords.length === 2;
  if (EXPRESSION_STARTERS.has(lastWord) || (lastWord === "WHEN" && previousWord === "EXIT") || assignment) {
    const values = [
      s("NOT FOUND", "the last statement affected no row", "sql_found_rowcount"),
      s("FOUND", "the last statement affected a row", "sql_found_rowcount"),
      s("ROW_COUNT", "rows affected by the last statement", "sql_found_rowcount"),
      ...(top.exception ? [s("SQLERRM", "message of the error being handled", "exc_sqlerrm_notice")] : []),
    ];
    return { suggestions: values, variables: true, functions: true };
  }

  const atStatementStart = STATEMENT_START_AFTER.has(lastWord) &&
    (lastWord !== "LOOP" || previousWord !== "END") &&
    (lastWord !== ">" || previousWord === ">");
  if (lastWord === "EXCEPTION" && top.exception) {
    return { suggestions: [...HANDLERS], variables: false };
  }
  if (!atStatementStart) {
    return undefined;
  }
  const closers: ProcedureSuggestion[] = [];
  if (top.kind === "if") {
    closers.push(...IF_CLOSERS);
  } else if (top.kind === "loop") {
    closers.push(...LOOP_CLOSERS);
  } else {
    if (top.exception && lastWord === ";") {
      closers.push(...HANDLERS);
    }
    closers.push(s("END;", "close the block", "ctrl_nested_begin"));
    if (!top.exception) {
      closers.push(s("EXCEPTION", "error handlers: WHEN OTHERS / WHEN TRANSACTION_ABORTED", "exc_when_others"));
    }
  }
  const insideLoop = stack.some((block) => block.kind === "loop");
  const exits = insideLoop && top.kind !== "loop" ? LOOP_CLOSERS.filter((item) => item.label.startsWith("EXIT")) : [];
  return { suggestions: [...closers, ...exits, ...STATEMENTS], variables: true };
}

/**
 * NZPLSQL suggestions for the cursor, or `undefined` when the cursor is not at
 * a procedural position (expressions and SQL clauses keep the SQL completion).
 */
export function resolveProcedureCompletionContext(
  statementPrefix: string,
  typedPrefix: string,
): ProcedureCompletionContext | undefined {
  const tokens = tokensBefore(statementPrefix, typedPrefix);
  const head = tokens.slice(0, 4).map(upper);
  if (head[0] !== "CREATE" || !head.includes("PROCEDURE")) {
    return undefined;
  }
  const bodyStart = tokens.findIndex((token) => upper(token) === "BEGIN_PROC");
  if (bodyStart < 0) {
    return headerContext(tokens);
  }
  const body = tokens.slice(bodyStart + 1);
  if (body.some((token) => upper(token) === "END_PROC")) {
    return undefined;
  }
  if (body.length === 0) {
    return {
      suggestions: [
        s("DECLARE", "variables of the procedure", "decl_alias_for_dollar"),
        s("BEGIN", "start the body", "hdr_minimal_int4"),
      ],
      variables: false,
    };
  }
  const header = tokens.slice(0, bodyStart).map(upper);
  const returnsReftable = header[header.indexOf("RETURNS") + 1] === "REFTABLE";
  return bodyContext(body, returnsReftable);
}

/** Completion items for a procedural position, ranked before SQL suggestions. */
export function buildProcedureCompletionItems(
  context: ProcedureCompletionContext,
  typedPrefix: string,
  position: Position,
  localDefs: LocalDefinition[],
): CompletionItem[] {
  const items: CompletionItem[] = [];
  context.suggestions.forEach((suggestion, rank) => {
    if (!matchesPrefix(suggestion.label, typedPrefix)) {
      return;
    }
    const item: CompletionItem = {
      label: suggestion.label,
      kind: CompletionItemKind.Keyword,
      detail: `NZPLSQL: ${suggestion.detail}`,
      sortText: `0_${String(rank).padStart(2, "0")}_${suggestion.label}`,
    };
    if (suggestion.insert) {
      item.insertText = suggestion.insert;
      item.insertTextFormat = InsertTextFormat.Snippet;
    }
    applyPrefixRange(item, position, typedPrefix);
    items.push(item);
  });
  if (context.variables) {
    items.push(...toLocalVariableItems(localDefs, typedPrefix, position));
  }
  return items;
}
