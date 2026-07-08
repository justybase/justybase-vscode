import { CstNode } from 'chevrotain';
import type { SqlVisitorHost } from './sqlVisitorHost';

type VisitorCtx = Record<string, CstNode[]>;

export function visitComparisonExpression(visitor: SqlVisitorHost, ctx: VisitorCtx): void {
    if (ctx.additiveExpression) {
        ctx.additiveExpression.forEach((expr: CstNode) => {
            visitor.visit(expr);
        });
    }

    if (ctx.comparisonRhs) {
        ctx.comparisonRhs.forEach((rhs: CstNode) => {
            visitor.visit(rhs);
        });
    }

    if (ctx.inExpression) {
        visitor.visit(ctx.inExpression[0]);
    }
    if (ctx.betweenExpression) {
        visitor.visit(ctx.betweenExpression[0]);
    }
    if (ctx.isExpression) {
        visitor.visit(ctx.isExpression[0]);
    }
}

export function visitComparisonRhs(visitor: SqlVisitorHost, ctx: VisitorCtx): void {
    if (ctx.selectStatement) {
        visitor.visitEmbeddedSelectNode(ctx.selectStatement[0]);
    }
    if (ctx.withStatement) {
        visitor.visitEmbeddedSelectNode(ctx.withStatement[0]);
    }
    if (ctx.additiveExpression) {
        ctx.additiveExpression.forEach((expr: CstNode) => {
            visitor.visit(expr);
        });
    }
}

export function visitInExpression(visitor: SqlVisitorHost, ctx: VisitorCtx): void {
    if (ctx.selectStatement) {
        visitor.visitEmbeddedSelectNode(ctx.selectStatement[0]);
    } else if (ctx.withStatement) {
        visitor.visitEmbeddedSelectNode(ctx.withStatement[0]);
    } else if (ctx.expression) {
        ctx.expression.forEach((expr: CstNode) => {
            visitor.visit(expr);
        });
    }
}
