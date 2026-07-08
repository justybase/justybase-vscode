import { CstNode, type IToken } from "chevrotain";
import type { TableInfo, ValidationError } from "../types";
import type { SchemaProvider } from "../schemaProvider";
import {
  classifyLiteralToken,
  classifyNetezzaDataType,
  getColumnTypeMismatchWarning,
  getTypeMismatchWarning,
  type LiteralKind,
  type SqlTypeFamily,
} from "./typeComparisonUtils";
import { getOrderedReferenceTokens } from "../../providers/parsers/scope";
import type { ScopeBuilder } from "./scopeBuilder";

export interface TypeComparisonVisitorHost {
  addError(
    message: string,
    token: IToken,
    severity: ValidationError["severity"],
    code: string,
  ): void;
  getTokenText(token: IToken | IToken[] | undefined): string;
  getFirstTokenFromCst(node: CstNode): IToken | undefined;
  getCstText(node: CstNode): string;
  findDescendantCstNode(node: CstNode, targetName: string): CstNode | undefined;
  findDescendantCstNodeBounded(
    node: CstNode,
    targetName: string,
    boundaryRules?: ReadonlySet<string>,
  ): CstNode | undefined;
  getScopeBuilder(): ScopeBuilder;
  getSchemaProvider(): SchemaProvider | undefined;
}

export function validateComparisonExpressionTypes(
  host: TypeComparisonVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const lhsNode = ctx.additiveExpression?.[0];
  if (!lhsNode) {
    return;
  }

  const columnRef = extractSimpleColumnReference(host, lhsNode);
  const lhsLiteral = columnRef ? undefined : extractLiteralFromExpression(host, lhsNode);

  const operatorNames = [
    "Equals",
    "NotEquals",
    "LessThan",
    "GreaterThan",
    "LessThanEquals",
    "GreaterThanEquals",
  ] as const;
  const mixedCtx = ctx as Record<string, CstNode[] | IToken[]>;

  for (const operatorName of operatorNames) {
    const operatorEntry = mixedCtx[operatorName]?.[0];
    if (!operatorEntry || !("image" in operatorEntry)) {
      continue;
    }

    const rhsNode = ctx.comparisonRhs?.[0];
    if (!rhsNode) {
      continue;
    }

    if (columnRef) {
      const columnType = resolveColumnDataType(host, columnRef);
      const columnFamily = classifyNetezzaDataType(columnType);

      const castType = extractExplicitCastType(host, rhsNode);
      if (castType) {
        const castFamily = classifyNetezzaDataType(castType);
        const castWarning = getColumnTypeMismatchWarning(
          columnFamily,
          castFamily,
          operatorName,
        );
        if (castWarning) {
          const castToken =
            host.getFirstTokenFromCst(rhsNode) ?? columnRef.token;
          host.addError(
            castWarning.message,
            castToken,
            "warning",
            castWarning.code,
          );
        }
        continue;
      }

      const literal = extractLiteralFromExpression(host, rhsNode);
      if (literal) {
        const warning = getTypeMismatchWarning(
          columnFamily,
          literal.kind,
          operatorName,
        );
        if (warning) {
          host.addError(
            warning.message,
            literal.token,
            "warning",
            warning.code,
          );
        }
        continue;
      }

      const rhsColumnRef = extractSimpleColumnReference(host, rhsNode);
      if (!rhsColumnRef) {
        continue;
      }

      const rhsColumnType = resolveColumnDataType(host, rhsColumnRef);
      const rhsColumnFamily = classifyNetezzaDataType(rhsColumnType);
      const columnWarning = getColumnTypeMismatchWarning(
        columnFamily,
        rhsColumnFamily,
        operatorName,
      );
      if (columnWarning) {
        host.addError(
          columnWarning.message,
          rhsColumnRef.token,
          "warning",
          columnWarning.code,
        );
      }
    } else if (lhsLiteral) {
      const lhsFamily: SqlTypeFamily =
        lhsLiteral.kind === "number"
          ? "numeric"
          : lhsLiteral.kind === "string"
            ? "string"
            : "unknown";

      const rhsLiteral = extractLiteralFromExpression(host, rhsNode);
      if (rhsLiteral) {
        const warning = getTypeMismatchWarning(
          lhsFamily,
          rhsLiteral.kind,
          operatorName,
        );
        if (warning) {
          host.addError(
            warning.message,
            rhsLiteral.token,
            "warning",
            warning.code,
          );
        }
        continue;
      }

      const rhsColumnRef = extractSimpleColumnReference(host, rhsNode);
      if (rhsColumnRef) {
        const rhsColumnType = resolveColumnDataType(host, rhsColumnRef);
        const rhsColumnFamily = classifyNetezzaDataType(rhsColumnType);
        const columnWarning = getColumnTypeMismatchWarning(
          lhsFamily,
          rhsColumnFamily,
          operatorName,
        );
        if (columnWarning) {
          host.addError(
            columnWarning.message,
            rhsColumnRef.token,
            "warning",
            columnWarning.code,
          );
        }
      }
    }
  }
}

function extractSimpleColumnReference(
  host: TypeComparisonVisitorHost,
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

  const tokens = getOrderedReferenceTokens(colRef);
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
  host: TypeComparisonVisitorHost,
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
      if (
        typeof child !== "object" ||
        child === null ||
        !("image" in child) ||
        !("tokenType" in child)
      ) {
        continue;
      }
      const token = child as IToken;
      const kind = classifyLiteralToken(
        (token.tokenType as { name?: string } | undefined)?.name,
      );
      if (kind !== "unknown") {
        return { kind, token };
      }
    }
  }

  return undefined;
}

function extractExplicitCastType(
  host: TypeComparisonVisitorHost,
  expressionNode: CstNode,
): string | undefined {
  const castExpr = host.findDescendantCstNodeBounded(
    expressionNode,
    "castExpression",
  );
  const castTypeNodes = castExpr?.children?.typeName as CstNode[] | undefined;
  if (castTypeNodes && castTypeNodes.length > 0) {
    const lastType = castTypeNodes[castTypeNodes.length - 1];
    return host.getCstText(lastType).replace(/\s+/g, " ").trim();
  }

  const castFn = host.findDescendantCstNodeBounded(
    expressionNode,
    "castFunctionExpression",
  );
  const fnType = castFn?.children?.typeName?.[0] as CstNode | undefined;
  if (fnType) {
    return host.getCstText(fnType).replace(/\s+/g, " ").trim();
  }

  return undefined;
}

function resolveColumnDataType(
  host: TypeComparisonVisitorHost,
  ref: {
    qualifier?: string;
    column: string;
  },
): string | undefined {
  const scopeBuilder = host.getScopeBuilder();
  let table: TableInfo | undefined;
  if (ref.qualifier) {
    table = scopeBuilder.findTable(ref.qualifier);
  } else {
    const tables = scopeBuilder.getCurrentScopeTables();
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
