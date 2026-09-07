import { CstNode, type IToken } from "chevrotain";
import type { ColumnInfo, TableInfo } from "../types";
import type { SqlVisitorHost } from "./sqlVisitorHost";
import { addTableQualificationWarning } from "./queryScopeVisitor";

export function callStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.qualifiedName) {
    host.visit(ctx.qualifiedName[0]);
  }
  if (ctx.functionArguments) {
    host.visit(ctx.functionArguments[0]);
  }
}

export function insertStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const schemaProvider = host.getSchemaProvider();
  if (ctx.tableName) {
    const table = host.visitAs<TableInfo>(ctx.tableName[0]);
    addTableQualificationWarning(host, table, ctx.tableName[0]);

    const isQualified = !!(table.database || table.schema);
    if (isQualified && !table.isTempTable && !table.isCte && schemaProvider) {
      host.validateTableExists(table, ctx.tableName[0]);

      if (ctx.Identifier && ctx.Identifier.length > 0) {
        const schemaTable = schemaProvider.getTable(
          table.database,
          table.schema,
          table.name,
        );
        if (schemaTable && schemaTable.columns.length > 0) {
          const tableColNames = new Set(
            schemaTable.columns.map((c) => c.name.toUpperCase()),
          );
          for (const colNode of ctx.Identifier) {
            const colToken = colNode as unknown as IToken;
            const colName = host.getTokenText(colToken);
            if (!tableColNames.has(colName.toUpperCase())) {
              host.addError(
                `Column '${colName}' not found in table '${table.name}'`,
                colToken,
                "error",
                "SQL004",
              );
            }
          }
        }
      }
    }
  }

  if (ctx.valuesClause) {
    host.visit(ctx.valuesClause[0]);
    if (ctx.Identifier && ctx.Identifier.length > 0) {
      validateInsertColumnValueCounts(
        host,
        ctx.Identifier as unknown as IToken[],
        ctx.valuesClause[0],
      );
    }
  } else if (ctx.selectStatement) {
    host.visit(ctx.selectStatement[0]);
  } else if (ctx.insertWithClause) {
    host.visit(ctx.insertWithClause[0]);
  }
}

export function insertWithClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const scopeBuilder = host.getScopeBuilder();
  scopeBuilder.enterScope();

  if (ctx.insertCteDefinition) {
    ctx.insertCteDefinition.forEach((cte: CstNode) => {
      host.visit(cte);
    });
  }

  if (ctx.selectStatement) {
    host.visit(ctx.selectStatement[0]);
  }

  scopeBuilder.exitScope();
}

export function insertCteDefinition(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const cteToken = ctx.Identifier?.[0] as unknown as IToken | undefined;
  if (!cteToken) return;

  const cteName = host.getTokenText(cteToken);
  const selectNode = ctx.selectStatement?.[0];
  const baseColumns = ctx.withStatement
    ? host.visitAs<ColumnInfo[]>(ctx.withStatement[0])
    : selectNode
      ? host.visitAs<ColumnInfo[]>(selectNode)
      : [];
  const explicitColumnNames = ctx.cteColumnList
    ? host.visitAs<string[]>(ctx.cteColumnList[0])
    : [];
  let columns = baseColumns;

  if (explicitColumnNames.length > 0) {
    if (baseColumns.length > 0) {
      columns = baseColumns.map((col, idx) => ({
        ...col,
        name: explicitColumnNames[idx] ?? col.name,
      }));
      if (explicitColumnNames.length > baseColumns.length) {
        explicitColumnNames.slice(baseColumns.length).forEach((name) => {
          columns.push({ name });
        });
      }
    } else {
      columns = explicitColumnNames.map((name) => ({ name }));
    }
  }

  host.getScopeBuilder().addCte({
    name: cteName,
    isCte: true,
    isTempTable: false,
    columns,
    recursive: false,
  });
}

export function valuesClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => {
      host.visit(expr);
    });
  }
}

export function updateStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const scopeBuilder = host.getScopeBuilder();
  const schemaProvider = host.getSchemaProvider();
  scopeBuilder.enterScope();

  let table: TableInfo | undefined;
  let tableNameNode: CstNode | undefined;
  const updateToken = ctx.Update?.[0] as unknown as IToken | undefined;

  if (!ctx.whereClause && updateToken) {
    host.addError(
      "UPDATE statement without WHERE clause will update all rows",
      updateToken,
      "error",
      "SQL044",
    );
  }

  if (ctx.tableName) {
    tableNameNode = ctx.tableName[0];
    table = host.visitAs<TableInfo>(tableNameNode);

    const known = scopeBuilder.findTable(table.name);
    if (known) {
      host.applyKnownTableInfo(table, known);
    }

    if (table.columns.length === 0 && schemaProvider) {
      const schemaTable = schemaProvider.getTable(
        table.database,
        table.schema,
        table.name,
      );
      if (schemaTable) {
        table.columns = schemaTable.columns;
      } else {
        const isQualified = !!(table.database || table.schema);
        if (
          isQualified &&
          !table.isTempTable &&
          !table.isCte &&
          tableNameNode
        ) {
          host.validateTableExists(table, tableNameNode);
        }
      }
    }

    if (ctx.aliasOptional) {
      const asToken = ctx.aliasOptional[0].children?.As?.[0] as unknown as
        | IToken
        | undefined;
      if (asToken) {
        host.addError(
          'Netezza UPDATE statements do not support "AS" for table aliases. Use "UPDATE table alias" instead.',
          asToken,
          "error",
          "SQL046",
        );
      }
      const alias = host.visitAs<string | undefined>(ctx.aliasOptional[0]);
      if (alias) {
        table.alias = alias;
      }
    }

    scopeBuilder.addTable(table);
    addTableQualificationWarning(host, table, tableNameNode);
  }

  if (ctx.fromClause) {
    host.visit(ctx.fromClause[0]);
  }

  if (ctx.updateSetItem) {
    ctx.updateSetItem.forEach((item: CstNode) => {
      host.visit(item);
    });
  }

  if (ctx.whereClause) {
    host.visit(ctx.whereClause[0]);
  }

  scopeBuilder.exitScope();
}

export function updateSetItem(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.columnReference) {
    host.visit(ctx.columnReference[0]);
  }
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
}

export function deleteStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const scopeBuilder = host.getScopeBuilder();
  const schemaProvider = host.getSchemaProvider();
  scopeBuilder.enterScope();

  let table: TableInfo | undefined;
  let tableNameNode: CstNode | undefined;
  const deleteToken = ctx.Delete?.[0] as unknown as IToken | undefined;

  if (!ctx.whereClause && deleteToken) {
    host.addError(
      "DELETE statement without WHERE clause will delete all rows",
      deleteToken,
      "error",
      "SQL043",
    );
  }

  if (ctx.tableName) {
    tableNameNode = ctx.tableName[0];
    table = host.visitAs<TableInfo>(tableNameNode);

    const known = scopeBuilder.findTable(table.name);
    if (known) {
      host.applyKnownTableInfo(table, known);
    }

    if (table.columns.length === 0 && schemaProvider) {
      const schemaTable = schemaProvider.getTable(
        table.database,
        table.schema,
        table.name,
      );
      if (schemaTable) {
        table.columns = schemaTable.columns;
      } else {
        const isQualified = !!(table.database || table.schema);
        if (
          isQualified &&
          !table.isTempTable &&
          !table.isCte &&
          tableNameNode
        ) {
          host.validateTableExists(table, tableNameNode);
        }
      }
    }

    if (ctx.aliasOptional) {
      const alias = host.visitAs<string | undefined>(ctx.aliasOptional[0]);
      if (alias) {
        table.alias = alias;
      }
    }

    scopeBuilder.addTable(table);
    addTableQualificationWarning(host, table, tableNameNode);
  }

  if (ctx.whereClause) {
    host.visit(ctx.whereClause[0]);
  }

  scopeBuilder.exitScope();
}

function validateInsertColumnValueCounts(
  host: SqlVisitorHost,
  columnTokens: IToken[],
  valuesClause: CstNode,
): void {
  const expectedCount = columnTokens.length;
  const rowCounts = getValuesRowExpressionCounts(valuesClause);
  for (const rowCount of rowCounts) {
    if (rowCount !== expectedCount) {
      host.addError(
        `INSERT column count (${expectedCount}) does not match VALUES count (${rowCount})`,
        columnTokens[0],
        "error",
        "SQL029",
      );
      return;
    }
  }
}

function getValuesRowExpressionCounts(valuesClause: CstNode): number[] {
  const expressions =
    (valuesClause.children?.expression as CstNode[] | undefined) ?? [];
  const rowCount =
    (valuesClause.children?.LParen as unknown[] | undefined)?.length ?? 0;
  if (expressions.length === 0) {
    return [];
  }
  if (rowCount <= 1) {
    return [expressions.length];
  }
  const perRow = expressions.length / rowCount;
  if (!Number.isInteger(perRow)) {
    return [expressions.length];
  }
  return Array.from({ length: rowCount }, () => perRow);
}
