import type { CstNode, IToken } from "chevrotain";
import {
  NETEZZA_ALTER_TABLE_DATA_TYPES,
  type AlterTablePhase,
} from "../dialects/netezza/sql/alterTableCompletion";
import type { DatabaseKind } from "../contracts/database";
import { SqlLexer } from "../sqlParser";
import { isIgnorableTrailingDotParserError } from "../sqlParser/parserErrorUtils";
import { parseSqlStatements } from "../sqlParser/parsingRuntime";
import {
  getChildNodes,
  getNodeTextRange,
  isCstNode,
} from "./completionCstUtils";
import {
  normalizeDialectQuotedIdentifiers,
  parseQualifiedTableNameFromTokens,
  parseTablePathFragment,
  stripQuotes,
} from "./completionDialectAdapter";
import type {
  FromJoinContext,
  QualifiedTableName,
} from "./completionTypes";

export type AlterTableCompletionContext =
  | { kind: "table_target"; path: FromJoinContext }
  | {
      kind: "action";
      table: QualifiedTableName;
      phase: AlterTablePhase;
      typedPrefix: string;
    };

const ALTER_TABLE_ACTION_STARTERS = new Set([
  "Add",
  "Drop",
  "Alter",
  "Rename",
  "Modify",
  "Set",
  "Owner",
  "Organize",
]);

export function parseAlterTableContext(
  statementPrefix: string,
  cursorOffset: number,
  databaseKind?: DatabaseKind,
): AlterTableCompletionContext | undefined {
  if (databaseKind && databaseKind !== "netezza") {
    return undefined;
  }

  const normalized = normalizeDialectQuotedIdentifiers(
    statementPrefix,
    databaseKind,
  );
  const alterMatch = normalized.match(/\bALTER\s+TABLE\s+/i);
  if (!alterMatch || alterMatch.index === undefined) {
    return undefined;
  }

  if (isCursorInsideAlterTableExpression(normalized, cursorOffset)) {
    return undefined;
  }

  const tableFragmentStart = alterMatch.index + alterMatch[0].length;
  const tableFragment = normalized.slice(tableFragmentStart);
  const pathParsed = parseTablePathFragment(tableFragment, databaseKind);

  const lexResult = SqlLexer.tokenize(normalized);
  const tokens = lexResult.tokens;
  const alterIndex = findAlterTableTokenIndex(tokens);
  if (alterIndex < 0) {
    return undefined;
  }

  const tableRef = parseQualifiedTableNameFromTokens(tokens, alterIndex + 2);
  if (!tableRef) {
    if (pathParsed) {
      return { kind: "table_target", path: pathParsed };
    }
    return undefined;
  }

  const cursorInTableTarget = isCursorInAlterTableTarget(
    tableFragment,
    pathParsed,
    tableRef,
    cursorOffset,
    tableFragmentStart,
  );
  if (cursorInTableTarget && pathParsed) {
    return { kind: "table_target", path: pathParsed };
  }

  const table = tableRef.tableRef;
  const cstPhase = resolveAlterTablePhaseFromCst(
    normalized,
    cursorOffset,
    databaseKind,
    table,
  );
  if (cstPhase) {
    return {
      kind: "action",
      table,
      phase: cstPhase.phase,
      typedPrefix: cstPhase.typedPrefix,
    };
  }

  const tokenPhase = resolveAlterTablePhaseFromTokens(
    tokens,
    tableRef.nextIndex,
    normalized,
    cursorOffset,
  );
  if (tokenPhase) {
    return {
      kind: "action",
      table,
      phase: tokenPhase.phase,
      typedPrefix: tokenPhase.typedPrefix,
    };
  }

  if (!pathParsed || pathParsed.kind === "from_join_name") {
    return {
      kind: "action",
      table,
      phase: "top_level",
      typedPrefix: extractTrailingIdentifierPrefix(normalized, cursorOffset),
    };
  }

  return undefined;
}

function findAlterTableTokenIndex(tokens: IToken[]): number {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (
      tokens[index].tokenType.name === "Alter" &&
      tokens[index + 1].tokenType.name === "Table"
    ) {
      return index;
    }
  }
  return -1;
}

function isCursorInAlterTableTarget(
  tableFragment: string,
  pathParsed: FromJoinContext | undefined,
  _tableRef: { nextIndex: number },
  cursorOffset: number,
  tableFragmentStart: number,
): boolean {
  if (!pathParsed) {
    return false;
  }

  const trimmed = tableFragment.trim();
  if (trimmed.length === 0) {
    return true;
  }

  if (trimmed.endsWith(".") || trimmed.endsWith("..")) {
    return true;
  }

  const fragmentWithoutLeadingSpace = tableFragment.replace(/^\s+/, "");
  const contentStart =
    tableFragmentStart + (tableFragment.length - fragmentWithoutLeadingSpace.length);
  const tableTextEnd =
    contentStart + fragmentWithoutLeadingSpace.trimEnd().length;

  if (cursorOffset < tableTextEnd) {
    return true;
  }

  if (pathParsed.kind !== "from_join_name") {
    return trimmed.includes(".");
  }

  return false;
}

function resolveAlterTablePhaseFromCst(
  sql: string,
  cursorOffset: number,
  databaseKind: DatabaseKind | undefined,
  table: QualifiedTableName,
): { phase: AlterTablePhase; typedPrefix: string } | undefined {
  const parserFriendlySql =
    sql.substring(0, cursorOffset) +
    (cursorOffset > 0 && cursorOffset <= sql.length ? "__JB_COMPLETION__" : "");
  const parseResult = parseSqlStatements({
    sql: parserFriendlySql,
    databaseKind,
    ignoreParserError: isIgnorableTrailingDotParserError,
  });
  if (!parseResult.cst || parseResult.actionableParserErrors.length > 0) {
    return undefined;
  }

  const alterNode = findAlterTableStatementAtCursor(parseResult.cst, cursorOffset);
  if (!alterNode) {
    return undefined;
  }

  const qualifiedNameNode = getChildNodes(alterNode, "qualifiedName")[0];
  const qualifiedRange = qualifiedNameNode
    ? getNodeTextRange(qualifiedNameNode)
    : undefined;
  if (!qualifiedRange || cursorOffset <= qualifiedRange.end) {
    return undefined;
  }

  if (!getChildNodes(alterNode, "alterTableAction")[0]) {
    return {
      phase: "top_level",
      typedPrefix: extractTrailingIdentifierPrefix(sql, cursorOffset),
    };
  }

  return resolvePhaseWithinAlterAction(alterNode, sql, cursorOffset, table);
}

function findAlterTableStatementAtCursor(
  root: CstNode,
  cursorOffset: number,
): CstNode | undefined {
  let bestMatch: CstNode | undefined;
  const visit = (node: CstNode): void => {
    if (node.name === "alterTableStatement") {
      const range = getNodeTextRange(node);
      if (range && cursorOffset >= range.start && cursorOffset <= range.end + 1) {
        bestMatch = node;
      }
    }
    const children = node.children ?? {};
    for (const value of Object.values(children)) {
      if (!Array.isArray(value)) {
        continue;
      }
      for (const child of value) {
        if (isCstNode(child)) {
          visit(child);
        }
      }
    }
  };
  visit(root);
  return bestMatch;
}

function resolvePhaseWithinAlterAction(
  alterNode: CstNode,
  sql: string,
  cursorOffset: number,
  _table: QualifiedTableName,
): { phase: AlterTablePhase; typedPrefix: string } | undefined {
  const actionNode = getChildNodes(alterNode, "alterTableAction")[0];
  if (!actionNode) {
    return {
      phase: "top_level",
      typedPrefix: extractTrailingIdentifierPrefix(sql, cursorOffset),
    };
  }

  const typedPrefix = extractTrailingIdentifierPrefix(sql, cursorOffset);
  const actionName = actionNode.children
    ? Object.keys(actionNode.children).find((key) =>
        key.startsWith("alterTable"),
      )
    : undefined;

  switch (actionName) {
    case "alterTableAddColumnAction": {
      const addNode = getChildNodes(actionNode, "alterTableAddColumnAction")[0];
      if (!addNode) {
        return { phase: "add_column", typedPrefix };
      }
      const definitions = getChildNodes(addNode, "columnDefinition");
      const lastDefinition = definitions[definitions.length - 1];
      if (!lastDefinition) {
        return { phase: "add_column", typedPrefix };
      }
      const hasType = getChildNodes(lastDefinition, "typeName").length > 0;
      return hasType
        ? { phase: "column_constraint", typedPrefix }
        : { phase: "add_column_type", typedPrefix };
    }
    case "alterTableAddConstraintAction":
      return { phase: "add_constraint", typedPrefix };
    case "alterTableDropColumnAction":
      return { phase: "drop_column", typedPrefix };
    case "alterTableDropConstraintAction":
      return { phase: "drop_constraint", typedPrefix };
    case "alterTableAlterColumnAction": {
      const alterColumnNode = getChildNodes(
        actionNode,
        "alterTableAlterColumnAction",
      )[0];
      const columnNames = alterColumnNode
        ? getChildNodes(alterColumnNode, "columnName")
        : [];
      if (columnNames.length === 0) {
        return { phase: "alter_column", typedPrefix };
      }
      return { phase: "alter_column_default", typedPrefix };
    }
    case "alterTableModifyColumnAction":
      return { phase: "modify_column", typedPrefix };
    case "alterTableRenameColumnAction": {
      const renameNode = getChildNodes(
        actionNode,
        "alterTableRenameColumnAction",
      )[0];
      const columnNames = renameNode
        ? getChildNodes(renameNode, "columnName")
        : [];
      return columnNames.length >= 2
        ? { phase: "rename_column_target", typedPrefix }
        : { phase: "rename_column", typedPrefix };
    }
    case "alterTableRenameTableAction":
      return { phase: "rename_table", typedPrefix };
    case "alterTableOwnerAction":
      return { phase: "owner_to", typedPrefix };
    case "alterTableSetPrivilegesAction":
      return { phase: "set_privileges", typedPrefix };
    default:
      break;
  }

  if (getChildNodes(alterNode, "organizeClause")[0]) {
    return { phase: "organize_on", typedPrefix };
  }

  return { phase: "top_level", typedPrefix };
}

function resolveAlterTablePhaseFromTokens(
  tokens: IToken[],
  afterTableIndex: number,
  sql: string,
  cursorOffset: number,
): { phase: AlterTablePhase; typedPrefix: string } | undefined {
  if (afterTableIndex >= tokens.length) {
    return {
      phase: "top_level",
      typedPrefix: extractTrailingIdentifierPrefix(sql, cursorOffset),
    };
  }

  const typedPrefix = extractTrailingIdentifierPrefix(sql, cursorOffset);
  let index = afterTableIndex;

  while (index < tokens.length && tokens[index].tokenType.name === "Dot") {
    index += 1;
    if (isIdentifierTokenName(tokens[index]?.tokenType.name)) {
      index += 1;
    }
  }

  if (index >= tokens.length) {
    return { phase: "top_level", typedPrefix };
  }

  const starter = tokens[index].tokenType.name;
  if (!ALTER_TABLE_ACTION_STARTERS.has(starter)) {
    return undefined;
  }

  if (starter === "Add") {
    const next = tokens[index + 1]?.tokenType.name;
    if (!next) {
      return { phase: "add", typedPrefix };
    }
    if (next === "Column") {
      const afterColumn = index + 2;
      if (afterColumn >= tokens.length) {
        return { phase: "add_column", typedPrefix };
      }
      const hasType = tokens
        .slice(afterColumn)
        .some((token) => isKnownDataTypeToken(token));
      return hasType
        ? { phase: "column_constraint", typedPrefix }
        : { phase: "add_column_type", typedPrefix };
    }
    return { phase: "add_constraint", typedPrefix };
  }

  if (starter === "Drop") {
    const next = tokens[index + 1]?.tokenType.name;
    if (next === "Constraint") {
      return { phase: "drop_constraint", typedPrefix };
    }
    if (
      next === "Column" ||
      next === "Identifier" ||
      next === "QuotedIdentifier"
    ) {
      return { phase: "drop_column", typedPrefix };
    }
    return { phase: "drop", typedPrefix };
  }

  if (starter === "Alter") {
    const hasColumn = tokens[index + 1]?.tokenType.name === "Column";
    const columnIndex = hasColumn ? index + 2 : index + 1;
    if (columnIndex >= tokens.length) {
      return { phase: "alter_column", typedPrefix };
    }
    return { phase: "alter_column_default", typedPrefix };
  }

  if (starter === "Rename") {
    if (tokens[index + 1]?.tokenType.name === "To") {
      return { phase: "rename_table", typedPrefix };
    }
    const hasTo = tokens
      .slice(index)
      .some((token) => token.tokenType.name === "To");
    return hasTo
      ? { phase: "rename_column_target", typedPrefix }
      : { phase: "rename_column", typedPrefix };
  }

  if (starter === "Modify") {
    return { phase: "modify_column", typedPrefix };
  }

  if (starter === "Owner") {
    return { phase: "owner_to", typedPrefix };
  }

  if (starter === "Set") {
    return { phase: "set_privileges", typedPrefix };
  }

  if (starter === "Organize") {
    return { phase: "organize_on", typedPrefix };
  }

  return { phase: "top_level", typedPrefix };
}

function isIdentifierTokenName(tokenName: string | undefined): boolean {
  return tokenName === "Identifier" || tokenName === "QuotedIdentifier";
}

function isKnownDataTypeToken(token: IToken): boolean {
  const image = stripQuotes(token.image).toUpperCase();
  return NETEZZA_ALTER_TABLE_DATA_TYPES.some(
    (typeName) => typeName === image || image.startsWith(`${typeName}(`),
  );
}

function extractTrailingIdentifierPrefix(
  sql: string,
  cursorOffset: number,
): string {
  const prefix = sql.substring(0, cursorOffset);
  const match = prefix.match(/([A-Za-z_][A-Za-z0-9_$"]*)$/);
  return match ? stripQuotes(match[1]) : "";
}

function isCursorInsideAlterTableExpression(
  sql: string,
  cursorOffset: number,
): boolean {
  const actionMatch = sql.match(
    /\bALTER\s+TABLE\s+[\w".]+(?:\.[\w".]+)*(?:\.\.|\.[\w".]+)*\s+(?:ADD\s+COLUMN|ADD|ALTER(?:\s+COLUMN)?|DROP|MODIFY\s+COLUMN|RENAME(?:\s+(?:COLUMN|TO))?|OWNER\s+TO|SET\s+PRIVILEGES\s+TO)\b/i,
  );
  if (!actionMatch || actionMatch.index === undefined) {
    return false;
  }

  let depth = 0;
  const scanStart = actionMatch.index + actionMatch[0].length;
  for (let index = scanStart; index < cursorOffset; index += 1) {
    const char = sql[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth > 0;
}
