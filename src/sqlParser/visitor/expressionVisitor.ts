import { CstNode, type IToken } from "chevrotain";
import {
  visitComparisonExpression,
  visitComparisonRhs,
  visitInExpression,
} from "./comparisonVisitorRules";
import {
  classifyLiteralToken,
  classifyNetezzaDataType,
  getArithmeticMixedTypeWarning,
  type LiteralKind,
  type SqlTypeFamily,
} from "./typeComparisonUtils";
import {
  validateComparisonExpressionTypes,
} from "./typeComparisonVisitor";
import { getOrderedReferenceTokens } from "../../providers/parsers/scope";
import { unquoteIdentifier } from "../../utils/identifierUtils";
import type { TableInfo } from "../types";
import type { SqlVisitorHost } from "./sqlVisitorHost";

const BOOLEAN_LITERAL_IDENTIFIERS = new Set(["TRUE", "FALSE"]);

const AGGREGATE_FUNCTIONS = new Set([
  "SUM",
  "COUNT",
  "AVG",
  "MIN",
  "MAX",
  "STDDEV",
  "STDDEV_POP",
  "STDDEV_SAMP",
  "VARIANCE",
  "VAR_POP",
  "VAR_SAMP",
  "GROUP_CONCAT",
  "GROUP_CONCAT_SORT",
  "PERCENTILE_CONT",
  "PERCENTILE_DISC",
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "PERCENT_RANK",
  "CUME_DIST",
  "NTILE",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "NTH_VALUE",
]);

const WINDOW_FUNCTIONS_REQUIRING_ORDER_BY = new Set([
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "NTILE",
  "LEAD",
  "LAG",
  "FIRST_VALUE",
  "LAST_VALUE",
  "PERCENT_RANK",
  "CUME_DIST",
  "NTH_VALUE",
]);

const ORDERED_SET_AGGREGATE_FUNCTIONS = new Set([
  "PERCENTILE_CONT",
  "PERCENTILE_DISC",
]);

const WINDOW_FUNCTIONS_WITHOUT_FRAME = new Set([
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "NTILE",
  "PERCENT_RANK",
  "CUME_DIST",
]);

export function expression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.orExpression) {
    host.visit(ctx.orExpression[0]);
  }
}

export function orExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.andExpression) {
    ctx.andExpression.forEach((expr: CstNode) => {
      host.visit(expr);
    });
  }
}

export function andExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.notExpression) {
    ctx.notExpression.forEach((expr: CstNode) => {
      host.visit(expr);
    });
  }
}

export function notExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.comparisonExpression) {
    host.visit(ctx.comparisonExpression[0]);
  }
}

export function comparisonExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  visitComparisonExpression(host, ctx);
  if (!host.getInProcedureContext()) {
    validateComparisonExpressionTypes(host, ctx);
  }
}

export function comparisonRhs(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  visitComparisonRhs(host, ctx);
}

export function inExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  visitInExpression(host, ctx);
}

export function additiveExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.multiplicativeExpression) {
    ctx.multiplicativeExpression.forEach((expr: CstNode) => {
      host.visit(expr);
    });
  }
  if (
    ctx.multiplicativeExpression &&
    (ctx.Plus || ctx.Minus) &&
    !host.getInProcedureContext()
  ) {
    validateArithmeticExpressionTypes(host, ctx.multiplicativeExpression);
  }
}

export function multiplicativeExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.unaryExpression) {
    ctx.unaryExpression.forEach((expr: CstNode) => {
      host.visit(expr);
    });
  }
  if (ctx.unaryExpression && !host.getInProcedureContext()) {
    validateArithmeticExpressionTypes(host, ctx.unaryExpression);
  }
}

export function unaryExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.castExpression) {
    host.visit(ctx.castExpression[0]);
  } else if (ctx.primaryExpression) {
    host.visit(ctx.primaryExpression[0]);
  }
}

export function castExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.primaryExpression) {
    host.visit(ctx.primaryExpression[0]);
  }

  if (ctx.typeName) {
    ctx.typeName.forEach((typeNode: CstNode) => host.visit(typeNode));
  }
}

export function primaryExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.columnReference) {
    host.visit(ctx.columnReference[0]);
  } else if (ctx.sequenceValueExpression) {
    host.visit(ctx.sequenceValueExpression[0]);
  } else if (ctx.functionCall) {
    host.visit(ctx.functionCall[0]);
  } else if (ctx.castFunctionExpression) {
    host.visit(ctx.castFunctionExpression[0]);
  } else if (ctx.extractExpression) {
    host.visit(ctx.extractExpression[0]);
  } else if (ctx.subquery) {
    host.visit(ctx.subquery[0]);
  } else if (ctx.caseExpression) {
    host.visit(ctx.caseExpression[0]);
  } else if (ctx.existsExpression) {
    host.visit(ctx.existsExpression[0]);
  } else if (ctx.expressionList) {
    host.visit(ctx.expressionList[0]);
  } else if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => {
      host.visit(expr);
    });
  }
}

export function existsExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.subquery) {
    host.visit(ctx.subquery[0]);
  }
}

export function sequenceValueExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.qualifiedName) {
    host.visit(ctx.qualifiedName[0]);
  }
}

export function expressionList(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => {
      host.visit(expr);
    });
  }
}

export function columnReference(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[] | IToken[]>,
): void {
  const rawTokens = getOrderedReferenceTokens(ctx);

  if (rawTokens.length === 0) return;
  const procedureScope = host.getProcedureScope();
  if (host.getInProcedureContext() && !host.getInProcedureSqlContext()) {
    if (procedureScope && rawTokens.length >= 1) {
      procedureScope.markNameUsed(
        unquoteIdentifier(host.getTokenText(rawTokens[0])),
      );
    }
    return;
  }

  const tokens = rawTokens;
  const normalizeIdentifier = (token: IToken): string =>
    host.getTokenText(token).replace(/"/g, "");

  if (tokens.length === 1) {
    const columnName = normalizeIdentifier(tokens[0]);
    const upperColumn = columnName.toUpperCase();
    const tokenTypeName = (
      tokens[0].tokenType as { name?: string } | undefined
    )?.name;

    if (
      tokenTypeName !== "QuotedIdentifier" &&
      BOOLEAN_LITERAL_IDENTIFIERS.has(upperColumn)
    ) {
      return;
    }

    if (
      tokenTypeName !== "QuotedIdentifier" &&
      host.getValidationProfile().specialBuiltinValues.has(upperColumn)
    ) {
      return;
    }

    if (host.getInOrderBy()) {
      const aliases = host.getCurrentSelectOutputAliases();
      if (aliases?.has(upperColumn)) {
        return;
      }
    }

    if (
      host.getInSelectList() &&
      host.getSelectListAliasesSoFar().has(upperColumn)
    ) {
      return;
    }

    if (host.getCanReferenceSelectAliases()) {
      const aliases = host.getCurrentSelectOutputAliases();
      if (aliases?.has(upperColumn)) {
        return;
      }
    }

    const visibleTables = host.getScopeBuilder().getAllVisibleTables();
    const tablesWithKnownColumns = visibleTables.filter(
      (t) => t.columns.length > 0,
    );

    if (tablesWithKnownColumns.length === 0) {
      return;
    }

    if (host.getValidationProfile().systemColumns.has(upperColumn)) {
      return;
    }

    const currentScopeTables = host.getScopeBuilder().getCurrentScopeTables();
    const currentScopeWithColumns = currentScopeTables.filter(
      (t) => t.columns.length > 0,
    );
    const currentMatches = currentScopeWithColumns.filter((table) =>
      table.columns.some(
        (c) =>
          c.name.toUpperCase() === upperColumn ||
          c.alias?.toUpperCase() === upperColumn,
      ),
    );

    if (currentMatches.length > 0) {
      if (currentMatches.length === 1) {
        return;
      }
      host.addError(
        `Column '${columnName}' is ambiguous`,
        tokens[0],
        "error",
        "SQL008",
      );
      return;
    }

    const matches = tablesWithKnownColumns.filter((table) =>
      table.columns.some(
        (c) =>
          c.name.toUpperCase() === upperColumn ||
          c.alias?.toUpperCase() === upperColumn,
      ),
    );

    if (matches.length === 1) {
      return;
    }

    if (matches.length > 1) {
      host.addError(
        `Column '${columnName}' is ambiguous`,
        tokens[0],
        "error",
        "SQL008",
      );
      return;
    }

    if (tablesWithKnownColumns.length === 1) {
      validateColumnExists(host, tablesWithKnownColumns[0], columnName, tokens[0]);
      return;
    }

    if (tablesWithKnownColumns.length === visibleTables.length) {
      host.addError(
        `Column '${columnName}' not found in any source table`,
        tokens[0],
        "error",
        "SQL004",
      );
    }
  } else if (tokens.length === 2) {
    const tableName = normalizeIdentifier(tokens[0]);
    const columnName = normalizeIdentifier(tokens[1]);

    const table = host.getScopeBuilder().findTable(tableName);
    if (!table) {
      host.addError(
        `Table or alias '${tableName}' not found in scope`,
        tokens[0],
        "error",
        "SQL003",
      );
    } else {
      validateColumnExists(host, table, columnName, tokens[1]);
    }
  } else if (tokens.length >= 3) {
    const tableOrSchemaName = normalizeIdentifier(tokens[0]);
    const table = host.getScopeBuilder().findTable(tableOrSchemaName);
    if (!table) {
      const fullTableName =
        normalizeIdentifier(tokens[0]) + "." + normalizeIdentifier(tokens[1]);
      const table2 = host.getScopeBuilder().findTable(fullTableName);
      if (!table2) {
        host.addError(
          `Table or alias '${tableOrSchemaName}' not found in scope`,
          tokens[0],
          "error",
          "SQL003",
        );
      } else {
        const columnName = normalizeIdentifier(tokens[2]);
        validateColumnExists(host, table2, columnName, tokens[2]);
      }
    } else {
      const columnName = normalizeIdentifier(tokens[2]);
      validateColumnExists(host, table, columnName, tokens[2]);
    }
  }
}

export function functionCall(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[] | IToken[]>,
): void {
  const identifierTokens = (ctx.Identifier as unknown as IToken[] | undefined) ?? [];
  const fnToken =
    (ctx.OracleQualifiedFunction?.[0] as unknown as IToken | undefined) ||
    (identifierTokens[0] as IToken | undefined) ||
    (ctx.Replace?.[0] as unknown as IToken | undefined) ||
    (ctx.Random?.[0] as unknown as IToken | undefined);
  let upper = "";

  if (fnToken) {
    const fnName = identifierTokens.length > 1
      ? identifierTokens.map((token) => host.getTokenText(token)).join(".")
      : host.getTokenText(fnToken);
    upper = fnName.toUpperCase();

    if (host.getInWhere() && AGGREGATE_FUNCTIONS.has(upper)) {
      const argsCst = ctx.functionArguments?.[0] as CstNode | undefined;
      const isScalarMinMax =
        (upper === "MIN" || upper === "MAX") &&
        argsCst?.children?.expression?.length !== undefined &&
        argsCst.children.expression.length >= 2;

      if (!isScalarMinMax) {
        host.addError(
          `Aggregate functions are not allowed in the WHERE clause`,
          fnToken,
          "error",
          "SQL021",
        );
      }
    }

    if (
      !host.getInPerformContext() &&
      upper !== "ROLLUP" &&
      upper !== "CUBE" &&
      !host.getValidationProfile().builtinFunctions.has(upper)
    ) {
      host.addError(
        `Function '${fnName}' does not exist`,
        fnToken,
        "error",
        "SQL011",
      );
    }
  }

  if (ctx.functionArguments) {
    host.visit(ctx.functionArguments[0] as unknown as CstNode);
  }

  if (ctx.filterClause) {
    host.visit(ctx.filterClause[0] as unknown as CstNode);
  }

  if (ctx.withinGroupClause) {
    const withinGroupNode = ctx.withinGroupClause[0] as unknown as CstNode;
    if (fnToken && ctx.overClause) {
      host.addError(
        `Ordered-set aggregate '${upper}' cannot be used as a window aggregate`,
        fnToken,
        "error",
        "SQL047",
      );
    }
    host.visit(withinGroupNode);
  } else if (
    fnToken &&
    ORDERED_SET_AGGREGATE_FUNCTIONS.has(upper)
  ) {
    host.addError(
      `Ordered-set aggregate '${upper}' requires WITHIN GROUP (ORDER BY ...) clause`,
      fnToken,
      "error",
      "SQL047",
    );
  }

  if (ctx.overClause) {
    const overNode = ctx.overClause[0] as unknown as CstNode;
    if (
      fnToken &&
      WINDOW_FUNCTIONS_REQUIRING_ORDER_BY.has(upper) &&
      !overNode.children?.orderByClause
    ) {
      host.addError(
        `Window function '${upper}' requires ORDER BY in OVER() clause`,
        fnToken,
        "error",
        "SQL022",
      );
    }
    if (
      fnToken &&
      WINDOW_FUNCTIONS_WITHOUT_FRAME.has(upper) &&
      overNode.children?.windowFrameClause
    ) {
      host.addError(
        `Window function '${upper}' cannot include a framing specification`,
        fnToken,
        "error",
        "SQL024",
      );
    }
    host.visit(overNode);
  }
}

export function functionArguments(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => {
      host.visit(expr);
    });
  }
}

export function overClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.partitionByClause) {
    host.visit(ctx.partitionByClause[0]);
  }
  if (ctx.orderByClause) {
    host.visit(ctx.orderByClause[0]);
  }
  if (ctx.windowFrameClause) {
    host.visit(ctx.windowFrameClause[0]);
  }
}

export function filterClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
}

export function withinGroupClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.orderByClause) {
    host.visit(ctx.orderByClause[0]);
  }
}

export function partitionByClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => {
      host.visit(expr);
    });
  }
}

export function windowFrameClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.frameBound) {
    ctx.frameBound.forEach((bound: CstNode) => {
      host.visit(bound);
    });
  }
}

export function castFunctionExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }

  if (ctx.typeName) {
    host.visit(ctx.typeName[0]);
  }
}

export function extractExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
}

export function caseExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => {
      host.visit(expr);
    });
  }
}

export function whereClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    const prev = host.getInWhere();
    host.setInWhere(true);
    host.visit(ctx.expression[0]);
    host.setInWhere(prev);

    const whereToken =
      (ctx.Where?.[0] as unknown as IToken | undefined) ||
      host.getFirstTokenFromCst(ctx.expression[0]);
    if (whereToken) {
      host.validateBooleanContext(ctx.expression[0], whereToken, "WHERE");
    }
  }
}

export function groupByClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.groupByElement) {
    ctx.groupByElement.forEach((element: CstNode) => {
      host.visit(element);
    });
  }
}

export function groupByElement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  } else if (ctx.groupingSetsExpression) {
    host.visit(ctx.groupingSetsExpression[0]);
  }
}

export function groupingSetsExpression(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.groupingSet) {
    ctx.groupingSet.forEach((set: CstNode) => host.visit(set));
  }
}

export function groupingSet(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => host.visit(expr));
  }
}

export function havingClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
    const havingToken =
      (ctx.Having?.[0] as unknown as IToken | undefined) ||
      host.getFirstTokenFromCst(ctx.expression[0]);
    if (havingToken) {
      host.validateBooleanContext(ctx.expression[0], havingToken, "HAVING");
    }
  }
}

export function orderByClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.orderByItem) {
    const prev = host.getInOrderBy();
    host.setInOrderBy(true);
    ctx.orderByItem.forEach((item: CstNode) => {
      host.visit(item);
    });
    host.setInOrderBy(prev);
  }
}

export function orderByItem(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
}

function extractSimpleColumnReference(
  host: SqlVisitorHost,
  expressionNode: CstNode,
):
  | {
      qualifier?: string;
      column: string;
      token: IToken;
    }
  | undefined {
  const colRef = host.findDescendantCstNode(expressionNode, "columnReference");
  if (!colRef) {
    return undefined;
  }

  const tokens = getOrderedReferenceTokens(colRef.children ?? {});
  if (tokens.length === 0 || tokens.length > 2) {
    return undefined;
  }

  const columnToken = tokens[tokens.length - 1];
  const qualifier =
    tokens.length === 2
      ? host.getTokenText(tokens[0]).replace(/"/g, "")
      : undefined;
  return {
    qualifier,
    column: host.getTokenText(columnToken).replace(/"/g, ""),
    token: columnToken,
  };
}

function extractLiteralFromExpression(
  host: SqlVisitorHost,
  expressionNode: CstNode,
):
  | {
      kind: LiteralKind;
      token: IToken;
    }
  | undefined {
  const literalNode = host.findDescendantCstNode(expressionNode, "literal");
  if (!literalNode) {
    return undefined;
  }

  const children = literalNode.children ?? {};
  for (const value of Object.values(children)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const child of value) {
      if (!host.isToken(child)) {
        continue;
      }
      const kind = classifyLiteralToken(
        (child.tokenType as { name?: string } | undefined)?.name,
      );
      if (kind !== "unknown") {
        return { kind, token: child };
      }
    }
  }

  return undefined;
}

function resolveColumnDataType(
  host: SqlVisitorHost,
  ref: {
    qualifier?: string;
    column: string;
  },
): string | undefined {
  let table: TableInfo | undefined;
  if (ref.qualifier) {
    table = host.getScopeBuilder().findTable(ref.qualifier);
  } else {
    const tables = host.getScopeBuilder().getCurrentScopeTables();
    if (tables.length === 1) {
      table = tables[0];
    }
  }

  if (!table) {
    return undefined;
  }

  const upperColumn = ref.column.toUpperCase();
  const schemaProvider = host.getSchemaProvider();

  if (schemaProvider) {
    const schemaTable = schemaProvider.getTable(
      table.database,
      table.schema,
      table.name,
    );
    const schemaColumn = schemaTable?.columns.find(
      (col) => col.name.toUpperCase() === upperColumn,
    );
    if (schemaColumn?.dataType) {
      return schemaColumn.dataType;
    }
  }

  const knownColumn = table.columns.find(
    (col) => col.name.toUpperCase() === upperColumn,
  );
  return knownColumn?.dataType;
}

function validateColumnExists(
  host: SqlVisitorHost,
  table: TableInfo,
  columnName: string,
  token: IToken,
): void {
  const upperColumnName = columnName.toUpperCase();

  if (host.getValidationProfile().systemColumns.has(upperColumnName)) {
    return;
  }

  const columnExists = table.columns.some(
    (col) =>
      col.name.toUpperCase() === upperColumnName ||
      col.alias?.toUpperCase() === upperColumnName,
  );

  if (columnExists) {
    return;
  }

  const schemaProvider = host.getSchemaProvider();
  if (schemaProvider) {
    const schemaTable = schemaProvider.getTable(
      table.database,
      table.schema,
      table.name,
    );
    if (schemaTable) {
      const schemaColumnExists = schemaTable.columns.some(
        (col) => col.name.toUpperCase() === upperColumnName,
      );
      if (!schemaColumnExists) {
        host.addError(
          `Column '${columnName}' not found in table '${table.alias || table.name}'`,
          token,
          "error",
          "SQL004",
        );
      }
      return;
    }
  }

  if (table.columns.length > 0) {
    host.addError(
      `Column '${columnName}' not found in table '${table.alias || table.name}'`,
      token,
      "error",
      "SQL004",
    );
    return;
  }

  if (!table.isCte && !table.isTempTable) {
    host.addError(
      `Cannot validate column '${columnName}' - table '${table.alias || table.name}' not found in schema cache. ` +
        `Try refreshing the schema or the table may not exist.`,
      token,
      "warning",
      "SQL005",
    );
  }
}

function validateArithmeticExpressionTypes(
  host: SqlVisitorHost,
  operands: CstNode[],
): void {
  if (operands.length < 2) return;

  const columns: Array<{ family: SqlTypeFamily; token: IToken }> = [];
  const literals: Array<{ kind: LiteralKind; token: IToken }> = [];

  for (const operand of operands) {
    const colRef = extractSimpleColumnReference(host, operand);
    if (colRef) {
      const columnType = resolveColumnDataType(host, colRef);
      const columnFamily = classifyNetezzaDataType(columnType);
      if (columnFamily !== "unknown") {
        columns.push({ family: columnFamily, token: colRef.token });
      }
    }

    const literal = extractLiteralFromExpression(host, operand);
    if (literal && literal.kind !== "unknown" && literal.kind !== "null") {
      literals.push(literal);
    }
  }

  if (columns.length > 0 && literals.length > 0) {
    for (const col of columns) {
      for (const lit of literals) {
        const literalFamily =
          lit.kind === "number"
            ? "numeric"
            : lit.kind === "string"
              ? "string"
              : "unknown";
        const warning = getArithmeticMixedTypeWarning(
          col.family,
          literalFamily,
        );
        if (warning) {
          host.addError(
            warning.message,
            lit.token,
            "warning",
            warning.code,
          );
        }
      }
    }
  }

  for (let i = 0; i < columns.length; i++) {
    for (let j = i + 1; j < columns.length; j++) {
      const warning = getArithmeticMixedTypeWarning(
        columns[i].family,
        columns[j].family,
      );
      if (warning) {
        host.addError(
          warning.message,
          columns[j].token,
          "warning",
          warning.code,
        );
      }
    }
  }

  for (let i = 0; i < literals.length; i++) {
    for (let j = i + 1; j < literals.length; j++) {
      const leftFamily =
        literals[i].kind === "number"
          ? "numeric"
          : literals[i].kind === "string"
            ? "string"
            : "unknown";
      const rightFamily =
        literals[j].kind === "number"
          ? "numeric"
          : literals[j].kind === "string"
            ? "string"
            : "unknown";
      const warning = getArithmeticMixedTypeWarning(leftFamily, rightFamily);
      if (warning) {
        host.addError(
          warning.message,
          literals[j].token,
          "warning",
          warning.code,
        );
      }
    }
  }
}
