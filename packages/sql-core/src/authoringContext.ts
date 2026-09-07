import { SqlLexer } from "./netezza/lexer";
import { parseNetezzaSqlStatements } from "./parser/runtime";
import type { CstNode, IToken } from "chevrotain";

export interface NetezzaTableReference {
  name: string;
  database?: string;
  schema?: string;
  alias?: string;
  startOffset?: number;
  endOffset?: number;
  nameStartOffset?: number;
  nameEndOffset?: number;
  aliasStartOffset?: number;
  aliasEndOffset?: number;
}

export interface NetezzaQualifiedColumnReference {
  qualifier: string;
  column: string;
  qualifierStartOffset?: number;
  qualifierEndOffset?: number;
  columnStartOffset?: number;
  columnEndOffset?: number;
  endOffset: number;
}

export interface NetezzaAuthoringContext {
  tableReferences: readonly NetezzaTableReference[];
  qualifiedColumnReferences: readonly NetezzaQualifiedColumnReference[];
}

/**
 * Parses Netezza authoring context without a platform or metadata dependency.
 * Adapters own metadata lookup and cache lifetimes; this function owns only
 * SQL structure so comments and string literals cannot look like references.
 */
export function collectNetezzaAuthoringContext(sql: string): NetezzaAuthoringContext {
  const parseResult = parseNetezzaSqlStatements({ sql });
  return {
    tableReferences: parseResult.cst
      ? collectTableReferences(parseResult.cst)
      : [],
    qualifiedColumnReferences: collectQualifiedColumnReferences(sql),
  };
}

function collectTableReferences(root: CstNode): NetezzaTableReference[] {
  const references: NetezzaTableReference[] = [];
  const seen = new Set<string>();
  const cteNames = new Set(
    collectNodes(root, "cteDefinition")
      .map(node => firstIdentifierToken(node)?.image)
      .filter((name): name is string => Boolean(name))
      .map(normalizeIdentifier)
      .map(name => name.toUpperCase()),
  );
  for (const source of collectNodes(root, "tableSource")) {
    const tableName = source.children.tableName?.[0];
    if (!isCstNode(tableName)) continue;
    const parsed = parseTableName(tableName);
    if (!parsed || cteNames.has(parsed.name.toUpperCase())) continue;
    const aliasNode = source.children.aliasOptional?.[0];
    const alias = isCstNode(aliasNode)
      ? firstIdentifierToken(aliasNode)?.image
      : undefined;
    const tableTokens = collectTokens(tableName);
    const tableIdentifiers = tableTokens.filter(token => isIdentifierLike(token.tokenType.name));
    const tableIdentifier = tableIdentifiers[tableIdentifiers.length - 1];
    const aliasTokens = aliasNode && isCstNode(aliasNode) ? collectTokens(aliasNode) : [];
    const aliasToken = aliasNode && isCstNode(aliasNode) ? firstIdentifierToken(aliasNode) : undefined;
    const sourceEndToken = aliasTokens[aliasTokens.length - 1] ?? tableTokens[tableTokens.length - 1];
    const reference: NetezzaTableReference = {
      ...parsed,
      alias: alias ? normalizeIdentifier(alias) : undefined,
    };
    defineNonEnumerable(reference, {
      startOffset: tableTokens[0]?.startOffset,
      endOffset: sourceEndToken?.endOffset === undefined ? undefined : sourceEndToken.endOffset + 1,
      nameStartOffset: tableIdentifier?.startOffset,
      nameEndOffset: tableIdentifier?.endOffset === undefined ? undefined : tableIdentifier.endOffset + 1,
      aliasStartOffset: aliasToken?.startOffset,
      aliasEndOffset: aliasToken?.endOffset === undefined ? undefined : aliasToken.endOffset + 1,
    });
    const key = [reference.database, reference.schema, reference.name, reference.alias]
      .map(value => value?.toUpperCase() ?? "")
      .join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

function parseTableName(tableName: CstNode): Omit<NetezzaTableReference, "alias"> | undefined {
  const qualifiedName = tableName.children.qualifiedName?.[0];
  if (!isCstNode(qualifiedName)) return undefined;
  const identifiers = (qualifiedName.children.identifier ?? [])
    .flatMap(node => isCstNode(node) ? [firstToken(node)] : [])
    .filter((token): token is IToken => Boolean(token))
    .map(token => normalizeIdentifier(token.image));
  const dots = qualifiedName.children.Dot ?? [];
  if (identifiers.length === 1) return { name: identifiers[0] };
  if (identifiers.length === 2) {
    return dots.length === 2
      ? { database: identifiers[0], name: identifiers[1] }
      : { schema: identifiers[0], name: identifiers[1] };
  }
  if (identifiers.length === 3) {
    return { database: identifiers[0], schema: identifiers[1], name: identifiers[2] };
  }
  return undefined;
}

function collectNodes(root: CstNode, name: string): CstNode[] {
  const nodes: CstNode[] = [];
  const visit = (node: CstNode): void => {
    if (node.name === name) nodes.push(node);
    for (const values of Object.values(node.children)) {
      for (const value of values) {
        if (isCstNode(value)) visit(value);
      }
    }
  };
  visit(root);
  return nodes;
}

function collectTokens(root: CstNode): IToken[] {
  const tokens: IToken[] = [];
  const visit = (value: CstNode | IToken): void => {
    if (isCstNode(value)) {
      for (const children of Object.values(value.children)) {
        for (const child of children) {
          if (isCstNode(child) || isToken(child)) visit(child);
        }
      }
      return;
    }
    tokens.push(value);
  };
  visit(root);
  return tokens.sort((left, right) => (left.startOffset ?? 0) - (right.startOffset ?? 0));
}

function firstIdentifierToken(root: CstNode): IToken | undefined {
  return collectTokens(root).find(token => isIdentifierLike(token.tokenType.name));
}

function firstToken(root: CstNode): IToken | undefined {
  return collectTokens(root)[0];
}

function isCstNode(value: unknown): value is CstNode {
  return typeof value === "object" && value !== null && "name" in value && "children" in value;
}

function isToken(value: unknown): value is IToken {
  return typeof value === "object" && value !== null && "tokenType" in value;
}

function collectQualifiedColumnReferences(sql: string): NetezzaQualifiedColumnReference[] {
  const lexical = SqlLexer.tokenize(sql);
  const references: NetezzaQualifiedColumnReference[] = [];
  for (let index = 0; index < lexical.tokens.length - 2; index += 1) {
    const qualifier = lexical.tokens[index];
    const dot = lexical.tokens[index + 1];
    const column = lexical.tokens[index + 2];
    if (!isIdentifierLike(qualifier?.tokenType.name)
      || dot?.tokenType.name !== "Dot"
      || !isIdentifierLike(column?.tokenType.name)
      || column.endOffset === undefined) {
      continue;
    }
    const reference: NetezzaQualifiedColumnReference = {
      qualifier: normalizeIdentifier(qualifier.image),
      column: normalizeIdentifier(column.image),
      endOffset: column.endOffset + 1,
    };
    defineNonEnumerable(reference, {
      qualifierStartOffset: qualifier.startOffset,
      qualifierEndOffset: qualifier.endOffset === undefined ? undefined : qualifier.endOffset + 1,
      columnStartOffset: column.startOffset,
      columnEndOffset: column.endOffset + 1,
    });
    references.push(reference);
  }
  return references;
}

function isIdentifierLike(tokenName: string | undefined): boolean {
  return tokenName === "Identifier" || tokenName === "QuotedIdentifier";
}

function normalizeIdentifier(identifier: string): string {
  return identifier.startsWith('"') && identifier.endsWith('"')
    ? identifier.slice(1, -1).replace(/""/g, '"')
    : identifier;
}

function defineNonEnumerable<T extends object>(target: T, values: Partial<T>): void {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(target, key, { value, enumerable: false, configurable: true });
  }
}
