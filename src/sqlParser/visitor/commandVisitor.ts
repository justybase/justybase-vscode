import { CstNode, type IToken } from "chevrotain";
import type { ColumnInfo, TableInfo } from "../types";
import type { SqlVisitorHost } from "./sqlVisitorHost";
import { addTableQualificationWarningFromQualifiedName } from "./queryScopeVisitor";

export function visitCommandTail(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.commandTail) {
    host.visit(ctx.commandTail[0]);
  }
}

export function variableSetStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
}

export function parenthesizedSetStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.selectStatement) {
    ctx.selectStatement.forEach((stmt: CstNode) => {
      host.visit(stmt);
    });
  }
  if (ctx.setOperation) {
    ctx.setOperation.forEach((op: CstNode) => {
      host.visit(op);
    });
  }
}

export function createSequenceStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.qualifiedName) {
    host.visit(ctx.qualifiedName[0]);
  }
}

export function lockStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  validateQualifiedTableCommand(host, ctx);
  visitCommandTail(host, ctx);
}

export function createViewStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  let createdView: TableInfo | undefined;
  const explicitColumnNames = ctx.viewColumnAliasList
    ? host.visitAs<string[]>(ctx.viewColumnAliasList[0])
    : [];
  let columns: ColumnInfo[] = [];

  if (ctx.qualifiedName) {
    const nameInfo = host.visitAs<{
      name: string;
      schema?: string;
      database?: string;
    }>(ctx.qualifiedName[0]);
    createdView = {
      name: nameInfo.name || "",
      schema: nameInfo.schema,
      database: nameInfo.database,
      isCte: false,
      isTempTable: false,
      columns: [],
    };

  }

  if (ctx.withStatement) {
    columns = host.visitAs<ColumnInfo[]>(ctx.withStatement[0]);
  } else if (ctx.selectStatement) {
    columns = host.visitAs<ColumnInfo[]>(ctx.selectStatement[0]);
  }

  if (explicitColumnNames.length > 0) {
    if (columns.length > 0) {
      columns = columns.map((col, idx) => ({
        ...col,
        name: explicitColumnNames[idx] ?? col.name,
      }));
      if (explicitColumnNames.length > columns.length) {
        explicitColumnNames.slice(columns.length).forEach((name) => {
          columns.push({ name });
        });
      }
    } else {
      columns = explicitColumnNames.map((name) => ({ name }));
    }
  }

  if (createdView) {
    createdView.columns = columns;
    host.getScopeBuilder().addTable(createdView);
    if (!host.getInProcedureContext()) {
      host.addScriptCreatedTable(createdView);
    }
  }
}

export function commentStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const schemaProvider = host.getSchemaProvider();
  if (
    ctx.qualifiedName &&
    schemaProvider &&
    (ctx.Table || ctx.View || ctx.Procedure)
  ) {
    const nameInfo = host.visitAs<{
      name: string;
      schema?: string;
      database?: string;
    }>(ctx.qualifiedName[0]);
    const relationName = host.formatRelationName(
      nameInfo.database,
      nameInfo.schema,
      nameInfo.name,
    );
    const isProcedureComment = !!ctx.Procedure;
    if (isProcedureComment && host.hasScriptCreatedProcedure(relationName)) {
      return;
    }
    const isQualified = !!(nameInfo.database || nameInfo.schema);
    if (isQualified) {
      const table: TableInfo = {
        name: nameInfo.name,
        database: nameInfo.database,
        schema: nameInfo.schema,
        isCte: false,
        isTempTable: false,
        columns: [],
      };
      host.validateTableExists(table, ctx.qualifiedName[0]);
    }
  }
}

export function truncateStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  validateQualifiedTableCommand(host, ctx);
  visitCommandTail(host, ctx);
}

export function explainStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  visitCommandTail(host, ctx);
}

export function commandTail(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.commandTailToken) {
    ctx.commandTailToken.forEach((tokenNode: CstNode) =>
      host.visit(tokenNode),
    );
  }
}

export function constraintDefinition(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.primaryKeyConstraint) host.visit(ctx.primaryKeyConstraint[0]);
  if (ctx.uniqueConstraint) host.visit(ctx.uniqueConstraint[0]);
  if (ctx.foreignKeyConstraint) host.visit(ctx.foreignKeyConstraint[0]);
  if (ctx.checkConstraint) host.visit(ctx.checkConstraint[0]);
}

export function checkConstraint(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
}

export function groomStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  validateQualifiedTableCommand(host, ctx);
}

export function generateStatisticsStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.qualifiedName) {
    for (const qualifiedNameNode of ctx.qualifiedName) {
      validateAndQualifyTableReference(host, qualifiedNameNode);
    }
  }
}

export function columnDefinitionList(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): ColumnInfo[] {
  const cols: ColumnInfo[] = [];
  if (ctx.columnOrConstraintDefinition) {
    ctx.columnOrConstraintDefinition.forEach((cd: CstNode) => {
      const result = host.visit(cd);
      if (result && typeof result === "object" && "name" in result) {
        cols.push(result as ColumnInfo);
      }
    });
  }
  return cols;
}

export function columnOrConstraintDefinition(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): ColumnInfo | void {
  if (ctx.columnDefinition) {
    return host.visitAs<ColumnInfo>(ctx.columnDefinition[0]);
  }
  if (ctx.tableConstraintDefinition) {
    host.visit(ctx.tableConstraintDefinition[0]);
  }
}

export function tableConstraintDefinition(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.constraintDefinition) {
    host.visit(ctx.constraintDefinition[0]);
  }
}

export function columnDefinition(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): ColumnInfo {
  const name = ctx.columnName ? host.visitAs<string>(ctx.columnName[0]) : "";
  if (ctx.typeName) {
    host.visit(ctx.typeName[0]);
  }
  return { name };
}

export function columnName(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): string {
  if (ctx.identifier) {
    return host.visitAs<string>(ctx.identifier[0]);
  }
  return "";
}

export function typeName(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[] | IToken[]>,
): {
  name: string;
  params: string[];
} {
  const parts = [
    ...(ctx.typeNameWord ?? []).map((node) => ({
      offset: host.getFirstTokenFromCst(node as CstNode)?.startOffset ?? 0,
      text: host.visitAs<string>(node as CstNode),
    })),
    ...((ctx.With as IToken[] | undefined) ?? []).map((token) => ({
      offset: token.startOffset ?? 0,
      text: host.getTokenText(token),
    })),
  ]
    .sort((left, right) => left.offset - right.offset)
    .map((part) => part.text)
    .filter((part) => part.length > 0);

  const params = (ctx.typeArgument ?? [])
    .map((node) => host.visitAs<string>(node as CstNode))
    .filter((param) => param.length > 0);

  const info = { name: parts.join(" "), params };

  const token =
    (ctx.typeNameWord && ctx.typeNameWord[0]
      ? host.getFirstTokenFromCst(ctx.typeNameWord[0] as CstNode)
      : undefined) ||
    (ctx.Identifier?.[0] as IToken | undefined) ||
    (ctx.QuotedIdentifier?.[0] as IToken | undefined);
  if (token) {
    host.validateDataType(info, token);
  }

  return info;
}

export function typeNameWord(
  host: SqlVisitorHost,
  ctx: Record<string, IToken[]>,
): string {
  const token =
    ctx.Identifier?.[0]
    || ctx.QuotedIdentifier?.[0]
    || ctx.To?.[0];
  const text = host.getTokenText(token);
  return text.replace(/"/g, "");
}

export function typeArgument(
  host: SqlVisitorHost,
  ctx: Record<string, IToken[]>,
): string {
  const token =
    ctx.NumberLiteral?.[0] ||
    ctx.Identifier?.[0] ||
    ctx.QuotedIdentifier?.[0] ||
    ctx.Any?.[0];
  const text = host.getTokenText(token);
  return text.replace(/"/g, "");
}

function validateQualifiedTableCommand(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.qualifiedName?.[0]) {
    validateAndQualifyTableReference(host, ctx.qualifiedName[0]);
  }
}

function validateAndQualifyTableReference(
  host: SqlVisitorHost,
  qualifiedNameNode: CstNode,
): void {
  const schemaProvider = host.getSchemaProvider();
  if (!schemaProvider) {
    return;
  }

  const nameInfo = host.visitAs<{
    name: string;
    schema?: string;
    database?: string;
  }>(qualifiedNameNode);
  const isQualified = !!(nameInfo.database || nameInfo.schema);
  if (isQualified) {
    const table: TableInfo = {
      name: nameInfo.name,
      database: nameInfo.database,
      schema: nameInfo.schema,
      isCte: false,
      isTempTable: false,
      columns: [],
    };
    host.validateTableExists(table, qualifiedNameNode);
  }
  addTableQualificationWarningFromQualifiedName(
    host,
    nameInfo,
    qualifiedNameNode,
  );
}
