import type { CstNode } from "chevrotain";
import {
  visitComparisonExpression,
  visitComparisonRhs,
  visitInExpression,
} from "../src/validation/visitor/comparisonVisitorRules";
import type { SqlVisitorHost } from "../src/validation/visitor/sqlVisitorHost";

describe("sql-core comparison visitor rules", () => {
  it("visits every comparison expression branch", () => {
    const node = {} as CstNode;
    const visitor = {
      visit: jest.fn(),
      visitEmbeddedSelectNode: jest.fn(),
    } as unknown as SqlVisitorHost;

    visitComparisonExpression(visitor, {
      additiveExpression: [node],
      comparisonRhs: [node],
      inExpression: [node],
      betweenExpression: [node],
      isExpression: [node],
    });
    visitComparisonExpression(visitor, {});

    visitComparisonRhs(visitor, {
      selectStatement: [node],
      withStatement: [node],
      additiveExpression: [node],
    });
    visitComparisonRhs(visitor, {});

    visitInExpression(visitor, { selectStatement: [node] });
    visitInExpression(visitor, { withStatement: [node] });
    visitInExpression(visitor, { expression: [node] });
    visitInExpression(visitor, {});

    expect(visitor.visit).toHaveBeenCalled();
    expect(visitor.visitEmbeddedSelectNode).toHaveBeenCalled();
  });
});
