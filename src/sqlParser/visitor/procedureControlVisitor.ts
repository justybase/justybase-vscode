import { CstNode } from "chevrotain";
import { getOrderedReferenceTokens } from "../../providers/parsers/scope";
import { unquoteIdentifier } from "../../utils/identifierUtils";
import type { SqlVisitorHost } from "./sqlVisitorHost";

export function arrayAssignmentStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => host.visit(expr));
  }
}

export function assignmentStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const procedureScope = host.getProcedureScope();
  if (ctx.columnReference && procedureScope) {
    const tokens = getOrderedReferenceTokens(
      ctx.columnReference[0].children ?? {},
    );
    if (tokens.length > 0) {
      procedureScope.markNameUsed(
        unquoteIdentifier(host.getTokenText(tokens[0])),
      );
    }
  }
  if (ctx.columnReference) {
    host.visit(ctx.columnReference[0]);
  }
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => host.visit(expr));
  }
}

export function returnStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  host.getProcedureScope()?.setHasReturn();
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
}

export function ifStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
  if (ctx.procedureStatements) {
    ctx.procedureStatements.forEach((s: CstNode) => host.visit(s));
  }
  if (ctx.elsifClause) {
    ctx.elsifClause.forEach((e: CstNode) => host.visit(e));
  }
}

export function elsifClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
  if (ctx.procedureStatements) {
    host.visit(ctx.procedureStatements[0]);
  }
}

export function loopStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.procedureStatements) {
    host.visit(ctx.procedureStatements[0]);
  }
}

export function whileStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
  if (ctx.procedureStatements) {
    host.visit(ctx.procedureStatements[0]);
  }
}

export function forStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => host.visit(expr));
  }
  if (ctx.selectStatement) {
    host.visit(ctx.selectStatement[0]);
  }
  if (ctx.procedureStatements) {
    host.visit(ctx.procedureStatements[0]);
  }
}

export function exitStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.identifier) {
    host.visit(ctx.identifier[0]);
  }
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
}

export function raiseStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => host.visit(expr));
  }
}

export function executeImmediateStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => host.visit(expr));
  }
}

export function performStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const prev = host.getInPerformContext();
  host.setInPerformContext(true);
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
  host.setInPerformContext(prev);
}

export function arrayMethodStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.identifier) {
    host.visit(ctx.identifier[0]);
  }
  if (ctx.expression) {
    ctx.expression.forEach((expr: CstNode) => host.visit(expr));
  }
}

export function exceptionBlock(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.whenClause) {
    ctx.whenClause.forEach((w: CstNode) => host.visit(w));
  }
}

export function whenClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.procedureStatements) {
    host.visit(ctx.procedureStatements[0]);
  }
}
