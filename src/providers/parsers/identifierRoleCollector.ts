import { CstNode, type IToken } from "chevrotain";
import type { DatabaseKind } from "../../contracts/database";
import {
  parseSemanticScopeWithParser,
  type ParserSemanticScope,
} from "./parserSqlContext";
import { getOrderedReferenceTokens, isCstNode, isToken } from "./scope";

export type IdentifierSemanticRole =
  | "alias"
  | "column"
  | "table"
  | "schema"
  | "database"
  | "cte"
  | "localVariable"
  | "unknown";

export interface IdentifierOccurrence {
  startOffset: number;
  endOffset: number;
  role: IdentifierSemanticRole;
}

class IdentifierRoleCollector {
  private readonly _occurrences = new Map<number, IdentifierOccurrence>();
  private readonly _aliasBindings: Map<string, { db?: string; schema?: string; table: string }>;
  private readonly _cteNames = new Set<string>();
  private readonly _localVariableNames = new Set<string>();

  constructor(
    aliasBindings: Map<string, { db?: string; schema?: string; table: string }>,
    cteNames: Iterable<string>,
  ) {
    this._aliasBindings = aliasBindings;
    for (const name of cteNames) {
      this._cteNames.add(name.toUpperCase());
    }
  }

  collect(root: CstNode): Map<number, IdentifierOccurrence> {
    this.visitNode(root);
    return this._occurrences;
  }

  private visitNode(node: CstNode): void {
    switch (node.name) {
      case "cteDefinition":
      case "insertCteDefinition":
        this.visitCteDefinition(node);
        return;
      case "tableSource":
        this.visitTableSource(node);
        return;
      case "tableName":
        this.registerTableNameNode(node);
        return;
      case "updateStatement":
        this.visitUpdateOrDeleteStatement(node);
        return;
      case "deleteStatement":
        this.visitUpdateOrDeleteStatement(node);
        return;
      case "insertStatement":
        this.visitInsertStatement(node);
        return;
      case "createViewStatement":
        this.visitQualifiedTableDdl(node);
        return;
      case "createProcedureStatement":
        this.visitCreateProcedureStatement(node);
        return;
      case "variableDeclaration":
        this.visitVariableDeclaration(node);
        return;
      case "procedureArgument":
        this.visitProcedureArgument(node);
        return;
      case "assignmentStatement":
        this.visitAssignmentStatement(node);
        return;
      case "forStatement":
        this.visitForStatement(node);
        return;
      case "columnReference":
        this.visitColumnReference(node);
        return;
      case "starExpression":
        this.visitStarExpression(node);
        return;
      case "createTableStatement":
      case "truncateStatement":
      case "groomStatement":
      case "createSequenceStatement":
      case "alterTableStatement":
      case "callStatement":
        this.visitQualifiedTableDdl(node);
        return;
      case "dropStatement":
        this.visitChildren(node);
        return;
      case "dropTarget":
        this.registerQualifiedTableNameTokens(
          this.getChildNodes(node, "qualifiedName")[0],
        );
        this.visitChildren(node);
        return;
      default:
        this.visitChildren(node);
    }
  }

  private visitChildren(node: CstNode): void {
    const children = node.children ?? {};
    for (const value of Object.values(children)) {
      if (!Array.isArray(value)) {
        continue;
      }
      for (const child of value) {
        if (isCstNode(child)) {
          this.visitNode(child);
        }
      }
    }
  }

  private visitCteDefinition(node: CstNode): void {
    const cteNameToken = this.getIdentifierToken(node);
    if (cteNameToken) {
      this.registerOccurrence(cteNameToken, "cte");
    }
    this.visitChildren(node);
  }

  private visitTableSource(node: CstNode): void {
    const tableWithFinalQualifiedNameNode = this.getChildNodes(
      node,
      "qualifiedName",
    )[0];

    if (tableWithFinalQualifiedNameNode) {
      this.registerQualifiedTableNameTokens(tableWithFinalQualifiedNameNode);
    }

    const aliasToken = this.getAliasToken(
      this.getChildNodes(node, "aliasOptional")[0],
    );
    if (aliasToken) {
      this.registerOccurrence(aliasToken, "alias");
    }

    this.visitChildren(node);
  }

  private registerTableNameNode(tableNameNode: CstNode): void {
    const qualifiedNameNode = this.getChildNodes(
      tableNameNode,
      "qualifiedName",
    )[0];
    this.registerQualifiedTableNameTokens(qualifiedNameNode);
  }

  private visitUpdateOrDeleteStatement(node: CstNode): void {
    const aliasToken = this.getAliasToken(
      this.getChildNodes(node, "aliasOptional")[0],
    );
    if (aliasToken) {
      this.registerOccurrence(aliasToken, "alias");
    } else {
      const tableNameNode = this.getChildNodes(node, "tableName")[0];
      const qualifiedNameNode = tableNameNode
        ? this.getChildNodes(tableNameNode, "qualifiedName")[0]
        : undefined;
      const identifierTokens = this.getChildNodes(
        qualifiedNameNode ?? tableNameNode ?? ({} as CstNode),
        "identifier",
      )
        .map((idNode) => this.getFirstTokenFromCst(idNode))
        .filter((token): token is IToken => !!token);
      const targetTableToken = identifierTokens[identifierTokens.length - 1];
      if (targetTableToken) {
        // Unaliased DML target acts as implicit qualifier (UPDATE t SET t.col = ...)
        this.registerOccurrence(targetTableToken, "alias");
      }
    }
    this.visitChildren(node);
  }

  private visitInsertStatement(node: CstNode): void {
    if (this.getTokens(node, "LParen").length > 0) {
      for (const columnToken of this.getTokens(node, "Identifier")) {
        this.registerOccurrence(columnToken, "column");
      }
    }
    this.visitChildren(node);
  }

  private visitCreateProcedureStatement(node: CstNode): void {
    const qualifiedNameNode = this.getChildNodes(node, "qualifiedName")[0];
    this.registerQualifiedTableNameTokens(qualifiedNameNode);
    this.visitChildren(node);
  }

  private visitVariableDeclaration(node: CstNode): void {
    const nameToken = this.getIdentifierToken(node);
    if (nameToken) {
      this.registerLocalVariable(nameToken);
    }
    this.visitChildren(node);
  }

  private visitProcedureArgument(node: CstNode): void {
    const identifierNode = this.getChildNodes(node, "identifier")[0];
    const nameToken = identifierNode
      ? this.getFirstTokenFromCst(identifierNode)
      : undefined;
    if (nameToken) {
      this.registerLocalVariable(nameToken);
    }
    this.visitChildren(node);
  }

  private visitAssignmentStatement(node: CstNode): void {
    const columnRefNode = this.getChildNodes(node, "columnReference")[0];
    if (columnRefNode) {
      for (const token of getOrderedReferenceTokens(columnRefNode)) {
        this.registerOccurrence(token, "localVariable");
      }
    }
    this.visitChildren(node);
  }

  private visitForStatement(node: CstNode): void {
    const identifierNode = this.getChildNodes(node, "identifier")[0];
    const loopVarToken = identifierNode
      ? this.getFirstTokenFromCst(identifierNode)
      : undefined;
    if (loopVarToken) {
      this.registerLocalVariable(loopVarToken);
    }
    this.visitChildren(node);
  }

  private registerLocalVariable(token: IToken): void {
    this._localVariableNames.add(this.normalizeIdentifier(token).toUpperCase());
    this.registerOccurrence(token, "localVariable");
  }

  private visitQualifiedTableDdl(node: CstNode): void {
    const qualifiedNameNode = this.getChildNodes(node, "qualifiedName")[0];
    this.registerQualifiedTableNameTokens(qualifiedNameNode);
    this.visitChildren(node);
  }

  private visitColumnReference(node: CstNode): void {
    const tokens = getOrderedReferenceTokens(node);
    if (tokens.length === 0) {
      return;
    }

    if (tokens.length === 1) {
      const name = this.normalizeIdentifier(tokens[0]).toUpperCase();
      if (this._localVariableNames.has(name)) {
        this.registerOccurrence(tokens[0], "localVariable");
      } else {
        this.registerOccurrence(tokens[0], "column");
      }
      return;
    }

    const columnToken = tokens[tokens.length - 1];
    this.registerOccurrence(columnToken, "column");

    for (let i = 0; i < tokens.length - 1; i++) {
      const qualifierToken = tokens[i];
      const qualifierName = this.normalizeIdentifier(qualifierToken).toUpperCase();
      const role = this.resolveQualifierRole(qualifierName, tokens.length - 1 - i);
      this.registerOccurrence(qualifierToken, role);
    }
  }

  private visitStarExpression(node: CstNode): void {
    const qualifier = this.getTokens(node, "Identifier")[0];
    if (qualifier) {
      const role = this.resolveQualifierRole(
        this.normalizeIdentifier(qualifier).toUpperCase(),
        1,
      );
      this.registerOccurrence(qualifier, role);
    }
    this.visitChildren(node);
  }

  private resolveQualifierRole(
    qualifierName: string,
    segmentsRemaining: number,
  ): IdentifierSemanticRole {
    if (this._aliasBindings.has(qualifierName)) {
      return "alias";
    }
    if (this._cteNames.has(qualifierName)) {
      return "cte";
    }
    if (segmentsRemaining >= 2) {
      return "database";
    }
    if (segmentsRemaining === 1) {
      return "schema";
    }
    return "table";
  }

  private registerQualifiedTableNameTokens(
    qualifiedNameNode: CstNode | undefined,
  ): void {
    if (!qualifiedNameNode) {
      return;
    }

    const identifierTokens = this.getChildNodes(qualifiedNameNode, "identifier")
      .map((idNode) => this.getFirstTokenFromCst(idNode))
      .filter((token): token is IToken => !!token);
    if (identifierTokens.length === 0) {
      return;
    }

    const dotCount = this.getTokens(qualifiedNameNode, "Dot").length;
    const roles = this.rolesForQualifiedTableSegments(
      identifierTokens.length,
      dotCount,
    );

    for (let i = 0; i < identifierTokens.length; i++) {
      const role = roles[i] ?? "table";
      this.registerOccurrence(identifierTokens[i], role);
    }
  }

  private rolesForQualifiedTableSegments(
    segmentCount: number,
    dotCount: number,
  ): IdentifierSemanticRole[] {
    if (segmentCount === 1) {
      return ["table"];
    }
    if (segmentCount === 2) {
      if (dotCount === 2) {
        return ["database", "table"];
      }
      return ["schema", "table"];
    }
    if (segmentCount >= 3) {
      return ["database", "schema", "table"];
    }
    return [];
  }

  private registerOccurrence(
    token: IToken,
    role: IdentifierSemanticRole,
  ): void {
    const startOffset = token.startOffset ?? 0;
    const endOffset = this.getTokenEndOffset(token);
    const existing = this._occurrences.get(startOffset);
    if (existing) {
      if (this.rolePriority(role) > this.rolePriority(existing.role)) {
        this._occurrences.set(startOffset, { startOffset, endOffset, role });
      }
      return;
    }
    this._occurrences.set(startOffset, { startOffset, endOffset, role });
  }

  private rolePriority(role: IdentifierSemanticRole): number {
    switch (role) {
      case "localVariable":
        return 7;
      case "alias":
        return 6;
      case "column":
        return 5;
      case "database":
        return 4;
      case "schema":
        return 3;
      case "table":
        return 2;
      case "cte":
        return 1;
      default:
        return 0;
    }
  }

  private getIdentifierToken(node: CstNode): IToken | undefined {
    const identifierNode = this.getChildNodes(node, "identifier")[0];
    if (identifierNode) {
      return this.getFirstTokenFromCst(identifierNode);
    }
    return (
      this.getTokens(node, "Identifier")[0] ??
      this.getTokens(node, "QuotedIdentifier")[0]
    );
  }

  private getAliasToken(aliasOptionalNode: CstNode | undefined): IToken | undefined {
    if (!aliasOptionalNode) {
      return undefined;
    }
    const aliasNode = this.getChildNodes(aliasOptionalNode, "alias")[0];
    if (!aliasNode) {
      return undefined;
    }
    return this.getFirstTokenFromCst(aliasNode);
  }

  private getChildNodes(node: CstNode, key: string): CstNode[] {
    const value = node.children?.[key];
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((child): child is CstNode => isCstNode(child));
  }

  private getTokens(node: CstNode, key: string): IToken[] {
    const value = node.children?.[key];
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((child): child is IToken => isToken(child));
  }

  private getFirstTokenFromCst(node: CstNode | undefined): IToken | undefined {
    if (!node) {
      return undefined;
    }
    const children = node.children ?? {};
    for (const value of Object.values(children)) {
      if (!Array.isArray(value)) {
        continue;
      }
      for (const child of value) {
        if (isToken(child)) {
          return child;
        }
        if (isCstNode(child)) {
          const nested = this.getFirstTokenFromCst(child);
          if (nested) {
            return nested;
          }
        }
      }
    }
    return undefined;
  }

  private normalizeIdentifier(token: IToken): string {
    const text = token.image;
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      return text.slice(1, -1);
    }
    return text;
  }

  private getTokenEndOffset(token: IToken): number {
    const tokenStart = token.startOffset ?? 0;
    if (token.endOffset !== undefined) {
      return token.endOffset + 1;
    }
    return tokenStart + token.image.length;
  }
}

export function collectIdentifierOccurrencesFromScope(
  scope: ParserSemanticScope,
): Map<number, IdentifierOccurrence> {
  const bindingsForColoring =
    scope.globalAliasBindings.size > 0
      ? scope.globalAliasBindings
      : scope.preferredAliasBindings;
  const cteNames = scope.localDefinitions
    .filter((def) => def.type === "CTE")
    .map((def) => def.name.toUpperCase());

  const cst = scope.cst;
  if (!cst) {
    return new Map();
  }

  const collector = new IdentifierRoleCollector(bindingsForColoring, cteNames);
  return collector.collect(cst);
}

export function collectIdentifierOccurrences(
  sql: string,
  databaseKind?: DatabaseKind,
): Map<number, IdentifierOccurrence> {
  const scope = parseSemanticScopeWithParser(sql, undefined, databaseKind);
  return collectIdentifierOccurrencesFromScope(scope);
}
