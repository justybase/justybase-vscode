/**
 * One-pass-per-statement workspace SQL extractor.
 *
 * The extractor runs only in the host indexer, never on the completion path.
 * It uses the same Chevrotain parser as diagnostics and completion, but emits
 * identifier/counter-only contributions. Ambiguous clauses, CTE/derived-table
 * targets, USING, OR, subqueries, non-equality predicates and DDL are skipped
 * rather than guessed.
 */

import type { CstNode, IToken } from "chevrotain";
import { normalizeSqlForFingerprint } from "@justybase/sql-core/joinKnowledge";
import {
  canonicalizeRelation,
  normalizeIdentityIdentifier,
  normalizeObjectRef,
  normalizeTableRef,
  tableRefKey,
  type TableRef,
} from "@justybase/sql-core/joinKnowledge";
import { parseSqlStatements } from "../sqlParser/parsingRuntime";
import { SqlParser } from "../sql/sqlParser";
import {
  getChildNodesByKey,
  getChildNodesFlat,
  getFirstTokenFromCstNode,
  getTokensByKey,
} from "../providers/parsers/scope/cstNodeUtils";
import {
  getOrderedCstTokens,
  isCstNode,
  isToken,
} from "../providers/parsers/scope/referenceTokenCollector";
import type { DatabaseKind } from "../contracts/database";
import type {
  WorkspaceEvidenceConfidence,
  WorkspaceFileColumnContribution,
  WorkspaceFileObjectContribution,
  WorkspaceFileRelationContribution,
  WorkspaceSkipReason,
} from "@justybase/sql-core/joinKnowledge";
import type { ObjectUsageKind } from "@justybase/sql-core/joinKnowledge";

export interface WorkspaceSqlExtraction {
  relations: WorkspaceFileRelationContribution[];
  objects: WorkspaceFileObjectContribution[];
  /** Columns referenced through an unambiguous table binding. */
  columns: WorkspaceFileColumnContribution[];
  fingerprints: string[];
  skipped: Partial<Record<WorkspaceSkipReason, number>>;
}

export interface WorkspaceSqlExtractorOptions {
  databaseKind?: DatabaseKind;
  /** Hash of {@link normalizeSqlForFingerprint}; the caller supplies the salt. */
  fingerprint: (normalizedSql: string) => string;
  maxStatements?: number;
}

interface ParsedTableName {
  ref: TableRef;
  parts: Array<{ value: string; quoted: boolean }>;
  dots: number;
}

type TableBinding = {
  kind: "table";
  ref: TableRef;
  key: string;
};

type NonTableBinding = {
  kind: "cte" | "derived";
};

type SourceBinding = TableBinding | NonTableBinding;

type ScopeValue = SourceBinding | "ambiguous";

type Scope = Map<string, ScopeValue>;

interface ScopedColumn {
  qualifier: Array<{ value: string; quoted: boolean }>;
  column: string;
}

const DML_ROOTS = new Set([
  "selectStatement",
  "withStatement",
  "withAnyStatement",
  "insertStatement",
  "updateStatement",
  "deleteStatement",
]);

const DDL_ROOT_PATTERN = /^(?:create|alter|drop|truncate|grant|revoke|comment|rename|analyze|groom|vacuum|execute|call|prepare|deallocate)/u;

function unquoteIdentifier(value: string): { value: string; quoted: boolean } {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return { value: trimmed.slice(1, -1).replace(/""/gu, '"'), quoted: true };
  }
  if (trimmed.length >= 2 && trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return { value: trimmed.slice(1, -1).replace(/\]\]/gu, "]"), quoted: true };
  }
  if (trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return { value: trimmed.slice(1, -1).replace(/``/gu, "`"), quoted: true };
  }
  return { value: trimmed, quoted: false };
}

function scopeKey(value: string, quoted: boolean): string {
  return quoted ? `q:${value}` : `u:${value.toUpperCase()}`;
}

/** Preserve quoted identifier bytes for the shared identity normalizer. */
function identityIdentifier(part: { value: string; quoted: boolean }): string {
  return part.quoted ? `"${part.value.replace(/"/gu, '""')}"` : part.value;
}

function parseTokenParts(tokens: readonly IToken[]): {
  parts: Array<{ value: string; quoted: boolean }>;
  dots: number;
} {
  const parts: Array<{ value: string; quoted: boolean }> = [];
  let dots = 0;
  for (const token of tokens) {
    if (token.image === ".") {
      dots += 1;
      continue;
    }
    if (token.image.trim().length === 0) {
      continue;
    }
    parts.push(unquoteIdentifier(token.image));
  }
  return { parts, dots };
}

function parseTableNameNode(node: CstNode | undefined): ParsedTableName | undefined {
  if (!node) {
    return undefined;
  }
  const tokens = getOrderedCstTokens(node);
  const { parts, dots } = parseTokenParts(tokens);
  if (parts.length === 0 || parts.length > 3) {
    return undefined;
  }
  let ref: TableRef;
  if (parts.length === 1) {
    ref = { table: identityIdentifier(parts[0]) };
  } else if (parts.length === 2 && dots === 1) {
    ref = {
      schema: identityIdentifier(parts[0]),
      table: identityIdentifier(parts[1]),
    };
  } else if (parts.length === 2 && dots === 2) {
    ref = {
      database: identityIdentifier(parts[0]),
      table: identityIdentifier(parts[1]),
    };
  } else if (parts.length === 3 && dots === 2) {
    ref = {
      database: identityIdentifier(parts[0]),
      schema: identityIdentifier(parts[1]),
      table: identityIdentifier(parts[2]),
    };
  } else {
    return undefined;
  }
  return { ref, parts, dots };
}

function findTableNode(tableSource: CstNode): {
  tableNode: CstNode | undefined;
  qualifiedNode: CstNode | undefined;
} {
  const tableName = getChildNodesByKey(tableSource, "tableName")[0];
  const tableNode = tableName ?? getChildNodesByKey(tableSource, "qualifiedName")[0];
  const qualifiedNode = tableName
    ? getChildNodesByKey(tableName, "qualifiedName")[0]
    : getChildNodesByKey(tableSource, "qualifiedName")[0];
  return { tableNode, qualifiedNode };
}

function getAliasToken(tableSource: CstNode): IToken | undefined {
  const aliasOptional = getChildNodesByKey(tableSource, "aliasOptional")[0];
  const alias = aliasOptional ? getChildNodesByKey(aliasOptional, "alias")[0] : undefined;
  return alias ? getFirstTokenFromCstNode(alias) : undefined;
}

function getNestedSelect(node: CstNode): CstNode | undefined {
  return getChildNodesByKey(node, "withStatement")[0]
    ?? getChildNodesByKey(node, "selectStatement")[0];
}

function collectNodes(
  node: CstNode,
  name: string,
  into: CstNode[] = [],
): CstNode[] {
  if (node.name === name) {
    into.push(node);
    return into;
  }
  for (const child of getChildNodesFlat(node)) {
    collectNodes(child, name, into);
  }
  return into;
}

function containsToken(node: CstNode, tokenName: string): boolean {
  for (const value of Object.values(node.children ?? {})) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const child of value) {
      if (isToken(child) && child.tokenType?.name === tokenName) {
        return true;
      }
      if (isCstNode(child) && containsToken(child, tokenName)) {
        return true;
      }
    }
  }
  return false;
}

function simpleColumnOperand(node: CstNode | undefined): ScopedColumn | undefined {
  if (!node) {
    return undefined;
  }
  const columns = collectNodes(node, "columnReference");
  if (columns.length !== 1) {
    return undefined;
  }
  const operandTokens = getOrderedCstTokens(node);
  const columnTokens = getOrderedCstTokens(columns[0]);
  if (operandTokens.length !== columnTokens.length) {
    return undefined;
  }
  const { parts, dots } = parseTokenParts(columnTokens);
  if (parts.length < 2 || parts.length - 1 !== dots) {
    return undefined;
  }
  const column = parts[parts.length - 1];
  const qualifier = parts.slice(0, -1);
  return {
    qualifier,
    column: identityIdentifier(column),
  };
}

function getRootStatementNode(cst: CstNode): CstNode | undefined {
  const statement = getChildNodesByKey(cst, "statement")[0];
  if (!statement) {
    return undefined;
  }
  const children = getChildNodesFlat(statement)
    .map((child) => ({
      child,
      start: getFirstTokenFromCstNode(child)?.startOffset ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => left.start - right.start);
  return children[0]?.child;
}

class StatementExtractor {
  private readonly relations = new Map<string, WorkspaceFileRelationContribution>();
  private readonly objects = new Map<string, WorkspaceFileObjectContribution>();
  private readonly columns = new Map<string, WorkspaceFileColumnContribution>();
  private readonly processedSelects = new WeakSet<CstNode>();

  constructor(
    private readonly fingerprint: string,
    private readonly databaseKind: DatabaseKind | undefined,
    private readonly skipped: Partial<Record<WorkspaceSkipReason, number>>,
  ) {}

  public extract(root: CstNode): {
    relations: WorkspaceFileRelationContribution[];
    objects: WorkspaceFileObjectContribution[];
    columns: WorkspaceFileColumnContribution[];
  } {
    this.processStatementLike(root, new Set<string>());
    return {
      relations: [...this.relations.values()],
      objects: [...this.objects.values()],
      columns: [...this.columns.values()],
    };
  }

  private skip(reason: WorkspaceSkipReason): void {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
  }

  private processStatementLike(node: CstNode, cteNames: ReadonlySet<string>): void {
    switch (node.name) {
      case "selectStatement":
        this.processSelect(node, cteNames);
        return;
      case "withStatement":
      case "withAnyStatement":
        this.processWith(node, cteNames, "cteDefinition");
        return;
      case "insertStatement":
        this.processInsert(node, cteNames);
        return;
      case "updateStatement":
        this.processUpdate(node, cteNames);
        return;
      case "deleteStatement":
        this.processDelete(node, cteNames);
        return;
      case "mergeStatement":
        this.skip("unsupported");
        return;
      default:
        this.skip(DDL_ROOT_PATTERN.test(node.name) ? "ddl" : "unsupported");
    }
  }

  private processWith(
    node: CstNode,
    outerCtes: ReadonlySet<string>,
    definitionKey: "cteDefinition" | "insertCteDefinition",
  ): void {
    const definitions = getChildNodesByKey(node, definitionKey);
    const localNames = new Set(outerCtes);
    for (const definition of definitions) {
      const nameToken = getFirstTokenFromCstNode(definition);
      if (nameToken) {
        localNames.add(unquoteIdentifier(nameToken.image).value.toUpperCase());
      }
    }
    for (const definition of definitions) {
      const nested = getNestedSelect(definition);
      if (nested) {
        this.processStatementLike(nested, localNames);
      }
    }
    const main = getChildNodesByKey(node, "selectStatement")[0]
      ?? getChildNodesByKey(node, "insertStatement")[0]
      ?? getChildNodesByKey(node, "updateStatement")[0]
      ?? getChildNodesByKey(node, "deleteStatement")[0];
    if (main) {
      this.processStatementLike(main, localNames);
    } else {
      this.skip("unsupported");
    }
  }

  private processInsert(node: CstNode, cteNames: ReadonlySet<string>): void {
    const targetNode = getChildNodesByKey(node, "tableName")[0];
    const target = parseTableNameNode(
      targetNode ? getChildNodesByKey(targetNode, "qualifiedName")[0] : undefined,
    );
    if (target) {
      this.addObjectUsage(target.ref, "insert", "exact");
    }
    const insertWith = getChildNodesByKey(node, "insertWithClause")[0];
    if (insertWith) {
      this.processWith(insertWith, cteNames, "insertCteDefinition");
      return;
    }
    const select = getChildNodesByKey(node, "selectStatement")[0];
    if (select) {
      this.processSelect(select, cteNames);
    }
  }

  private processUpdate(node: CstNode, cteNames: ReadonlySet<string>): void {
    const targetNode = getChildNodesByKey(node, "tableName")[0];
    const target = parseTableNameNode(
      targetNode ? getChildNodesByKey(targetNode, "qualifiedName")[0] : undefined,
    );
    const scope: Scope = new Map();
    if (target) {
      this.addObjectUsage(target.ref, "update", "exact");
      const normalized = normalizeTableRef(target.ref, this.databaseKind);
      if (normalized) {
        const binding: TableBinding = {
          kind: "table",
          ref: target.ref,
          key: tableRefKey(normalized),
        };
        const alias = getAliasToken(node);
        if (alias) {
          const parsedAlias = unquoteIdentifier(alias.image);
          this.addScopeBinding(scope, parsedAlias.value, parsedAlias.quoted, binding);
        } else {
          const last = target.parts[target.parts.length - 1];
          this.addScopeBinding(scope, last.value, last.quoted, binding);
        }
      }
    }
    const fromClause = getChildNodesByKey(node, "fromClause")[0];
    if (fromClause) {
      this.processFromClause(fromClause, scope, cteNames, "select");
    }
    const whereClause = getChildNodesByKey(node, "whereClause")[0];
    if (whereClause) {
      this.processSubqueriesIn(whereClause, cteNames);
    }
  }

  private processDelete(node: CstNode, cteNames: ReadonlySet<string>): void {
    const targetNode = getChildNodesByKey(node, "tableName")[0];
    const target = parseTableNameNode(
      targetNode ? getChildNodesByKey(targetNode, "qualifiedName")[0] : undefined,
    );
    if (target) {
      this.addObjectUsage(target.ref, "delete", "exact");
    }
    const whereClause = getChildNodesByKey(node, "whereClause")[0];
    if (whereClause) {
      this.processSubqueriesIn(whereClause, cteNames);
    }
  }

  private processSelect(select: CstNode, cteNames: ReadonlySet<string>): void {
    if (this.processedSelects.has(select)) {
      return;
    }
    this.processedSelects.add(select);
    const scope: Scope = new Map();
    const fromClause = getChildNodesByKey(select, "fromClause")[0];
    if (fromClause) {
      this.processFromClause(fromClause, scope, cteNames, "select");
    }
    this.collectColumnUsage(select, scope);
    this.processSubqueriesIn(select, cteNames);
  }

  /**
   * Record `alias.column` references that resolve to one table binding of this
   * SELECT, and unqualified columns when the scope has exactly one table and
   * nothing else. Nested SELECTs are skipped here; they have their own scope.
   */
  private collectColumnUsage(select: CstNode, scope: Scope): void {
    const tables = [...scope.values()].filter(
      (value): value is TableBinding => value !== "ambiguous" && value.kind === "table",
    );
    if (tables.length === 0) {
      return;
    }
    const soleTable = tables.length === scope.size
      && new Set(tables.map((table) => table.key)).size === 1
      ? tables[0]
      : undefined;
    const visit = (node: CstNode): void => {
      for (const child of getChildNodesFlat(node)) {
        if (
          child.name === "subquery"
          || child.name === "selectStatement"
          || child.name === "withStatement"
          || child.name === "withAnyStatement"
        ) {
          continue;
        }
        if (child.name !== "columnReference") {
          visit(child);
          continue;
        }
        const { parts, dots } = parseTokenParts(getOrderedCstTokens(child));
        if (parts.length === 0 || parts.length - 1 !== dots) {
          continue;
        }
        const column = parts[parts.length - 1];
        const binding = parts.length === 1
          ? soleTable
          : this.lookupBinding(scope, { qualifier: parts.slice(0, -1), column: column.value });
        const normalizedColumn = normalizeIdentityIdentifier(
          identityIdentifier(column),
          this.databaseKind,
        );
        if (binding && normalizedColumn) {
          this.addColumnUsage(binding.ref, normalizedColumn);
        }
      }
    };
    visit(select);
  }

  private addColumnUsage(ref: TableRef, column: string): void {
    const object = normalizeObjectRef(
      { database: ref.database, schema: ref.schema, name: ref.table },
      this.databaseKind,
    );
    if (!object || column === "*") {
      return;
    }
    const key = `${object.database ?? ""}\u0000${object.schema ?? ""}\u0000${object.name}\u0000${column.toUpperCase()}`;
    if (!this.columns.has(key)) {
      this.columns.set(key, { object, column, fingerprint: this.fingerprint });
    }
  }

  private processFromClause(
    fromClause: CstNode,
    scope: Scope,
    cteNames: ReadonlySet<string>,
    usageKind: ObjectUsageKind,
  ): void {
    for (const tableReference of getChildNodesByKey(fromClause, "tableReference")) {
      const primary = getChildNodesByKey(tableReference, "tableSource")[0];
      if (primary) {
        this.addTableSource(primary, scope, cteNames, usageKind);
      }
      for (const joinClause of getChildNodesByKey(tableReference, "joinClause")) {
        const targetSource = getChildNodesByKey(joinClause, "tableSource")[0];
        if (!targetSource) {
          continue;
        }
        // A JOIN target is not a FROM source: object bands rank only the
        // FROM-source list, where joined dimensions would otherwise outrank
        // the tables queries start from. JOIN targets have their own ranking.
        const target = this.addTableSource(targetSource, scope, cteNames, usageKind, false);
        if (target?.kind === "table") {
          this.extractJoinRelation(joinClause, scope, target);
        } else if (target?.kind === "derived") {
          this.skip("subquery");
        } else {
          this.skip("unresolved");
        }
      }
    }
  }

  private addTableSource(
    tableSource: CstNode,
    scope: Scope,
    cteNames: ReadonlySet<string>,
    usageKind: ObjectUsageKind,
    recordObjectUsage = true,
  ): SourceBinding | undefined {
    const subquery = getChildNodesByKey(tableSource, "subquery")[0];
    if (subquery) {
      const nested = getNestedSelect(subquery);
      if (nested) {
        this.processSelect(nested, cteNames);
      }
      const alias = getAliasToken(tableSource);
      if (alias) {
        const parsedAlias = unquoteIdentifier(alias.image);
        this.addScopeBinding(scope, parsedAlias.value, parsedAlias.quoted, { kind: "derived" });
      }
      return { kind: "derived" };
    }

    const { qualifiedNode } = findTableNode(tableSource);
    const parsed = parseTableNameNode(qualifiedNode);
    if (!parsed) {
      this.skip("unresolved");
      return undefined;
    }
    const alias = getAliasToken(tableSource);
    const qualified = parsed.parts.length > 1;
    const tableName = parsed.parts[parsed.parts.length - 1];
    if (
      !qualified
      && cteNames.has(tableName.value.toUpperCase())
    ) {
      if (alias) {
        const parsedAlias = unquoteIdentifier(alias.image);
        this.addScopeBinding(scope, parsedAlias.value, parsedAlias.quoted, { kind: "cte" });
      } else {
        this.addScopeBinding(scope, tableName.value, tableName.quoted, { kind: "cte" });
      }
      return { kind: "cte" };
    }

    const normalized = normalizeTableRef(parsed.ref, this.databaseKind);
    if (!normalized) {
      this.skip("unresolved");
      return undefined;
    }
    // Keep the raw (quoted-capable) ref for canonicalization/SQL display and
    // the normalized key for alias/scope comparisons.
    if (recordObjectUsage) {
      this.addObjectUsage(parsed.ref, usageKind, "exact");
    }
    const binding: TableBinding = {
      kind: "table",
      ref: parsed.ref,
      key: tableRefKey(normalized),
    };
    if (alias) {
      const parsedAlias = unquoteIdentifier(alias.image);
      this.addScopeBinding(scope, parsedAlias.value, parsedAlias.quoted, binding);
    } else {
      this.addScopeBinding(scope, tableName.value, tableName.quoted, binding);
    }
    return binding;
  }

  private addScopeBinding(
    scope: Scope,
    name: string,
    quoted: boolean,
    binding: SourceBinding,
  ): void {
    if (!name) {
      return;
    }
    const key = scopeKey(name, quoted);
    const existing = scope.get(key);
    if (existing === undefined) {
      scope.set(key, binding);
      return;
    }
    if (existing === "ambiguous") {
      return;
    }
    if (
      existing.kind !== binding.kind
      || (existing.kind === "table"
        && binding.kind === "table"
        && existing.key !== binding.key)
    ) {
      scope.set(key, "ambiguous");
    }
  }

  private lookupBinding(scope: Scope, column: ScopedColumn): TableBinding | undefined {
    if (column.qualifier.length === 1) {
      const qualifier = column.qualifier[0];
      const value = scope.get(scopeKey(qualifier.value, qualifier.quoted));
      return value && value !== "ambiguous" && value.kind === "table"
        ? value
        : undefined;
    }
    if (column.qualifier.length === 2) {
      const schema = column.qualifier[0];
      const table = column.qualifier[1];
      const matches = new Map<string, TableBinding>();
      for (const value of scope.values()) {
        if (value === "ambiguous" || value.kind !== "table") {
          continue;
        }
        if (
          value.ref.table.toUpperCase() === table.value.toUpperCase()
          && (value.ref.schema ?? "").toUpperCase() === schema.value.toUpperCase()
        ) {
          matches.set(value.key, value);
        }
      }
      if (matches.size === 1) {
        return [...matches.values()][0];
      }
    }
    return undefined;
  }

  private extractJoinRelation(
    joinClause: CstNode,
    scope: Scope,
    target: TableBinding,
  ): void {
    if (containsToken(joinClause, "Using")) {
      this.skip("using");
      return;
    }
    const expression = getChildNodesByKey(joinClause, "expression")[0];
    if (!expression) {
      this.skip("no-columns");
      return;
    }
    if (containsToken(expression, "Or")) {
      this.skip("or");
      return;
    }
    if (collectNodes(expression, "subquery").length > 0) {
      this.skip("subquery");
      return;
    }
    const comparisons = collectNodes(expression, "comparisonExpression");
    if (comparisons.length === 0) {
      this.skip("no-columns");
      return;
    }

    const pairsBySource = new Map<string, {
      source: TableBinding;
      pairs: Array<{ sourceColumn: string; targetColumn: string }>;
    }>();

    for (const comparison of comparisons) {
      if (getTokensByKey(comparison, "Equals").length !== 1) {
        this.skip("non-equality");
        return;
      }
      const left = simpleColumnOperand(
        getChildNodesByKey(comparison, "additiveExpression")[0],
      );
      const comparisonRhs = getChildNodesByKey(comparison, "comparisonRhs")[0];
      const right = simpleColumnOperand(
        comparisonRhs
          ? getChildNodesByKey(comparisonRhs, "additiveExpression")[0]
          : undefined,
      );
      if (!left || !right) {
        this.skip("unresolved");
        return;
      }
      const leftBinding = this.lookupBinding(scope, left);
      const rightBinding = this.lookupBinding(scope, right);
      if (!leftBinding || !rightBinding) {
        this.skip("unresolved");
        return;
      }
      const leftIsTarget = leftBinding.key === target.key;
      const rightIsTarget = rightBinding.key === target.key;
      if (leftIsTarget === rightIsTarget) {
        this.skip("ambiguous");
        return;
      }
      const sourceBinding = leftIsTarget ? rightBinding : leftBinding;
      const sourceColumn = leftIsTarget ? right.column : left.column;
      const targetColumn = leftIsTarget ? left.column : right.column;
      if (sourceBinding.key === target.key) {
        this.skip("ambiguous");
        return;
      }
      const group = pairsBySource.get(sourceBinding.key) ?? {
        source: sourceBinding,
        pairs: [],
      };
      group.pairs.push({ sourceColumn, targetColumn });
      pairsBySource.set(sourceBinding.key, group);
    }

    if (pairsBySource.size !== 1) {
      this.skip("ambiguous");
      return;
    }
    const group = [...pairsBySource.values()][0];
    const relation = canonicalizeRelation(
      {
        left: group.source.ref,
        right: target.ref,
        columns: group.pairs.map((pair) => ({
          left: pair.sourceColumn,
          right: pair.targetColumn,
        })),
      },
      this.databaseKind,
    );
    if (!relation) {
      this.skip("ambiguous");
      return;
    }
    const key = `${relation.key}\u0000${this.fingerprint}`;
    if (!this.relations.has(key)) {
      this.relations.set(key, { relation, fingerprint: this.fingerprint });
    }
  }

  private addObjectUsage(
    ref: TableRef,
    kind: ObjectUsageKind,
    confidence: WorkspaceEvidenceConfidence,
  ): void {
    const object = normalizeObjectRef(
      {
        database: ref.database,
        schema: ref.schema,
        name: ref.table,
      },
      this.databaseKind,
    );
    if (!object) {
      this.skip("unresolved");
      return;
    }
    const key = `${object.database ?? ""}\u0000${object.schema ?? ""}\u0000${object.name}\u0000${kind}\u0000${this.fingerprint}`;
    if (!this.objects.has(key)) {
      this.objects.set(key, {
        object,
        kind,
        fingerprint: this.fingerprint,
        confidence,
      });
    }
  }

  private processSubqueriesIn(node: CstNode, cteNames: ReadonlySet<string>): void {
    const visit = (current: CstNode): void => {
      for (const child of getChildNodesFlat(current)) {
        if (child.name === "subquery") {
          const nested = getNestedSelect(child);
          if (nested) {
            this.processSelect(nested, cteNames);
          }
          continue;
        }
        if (
          child.name === "selectStatement"
          || child.name === "withStatement"
          || child.name === "withAnyStatement"
        ) {
          continue;
        }
        visit(child);
      }
    };
    visit(node);
  }
}

/**
 * Parse every statement once and extract JOIN relations + object usage.
 *
 * A statement that fails lexing/parsing contributes nothing. A file with one
 * broken statement still yields evidence from its valid statements.
 */
export function extractWorkspaceSql(
  sql: string,
  options: WorkspaceSqlExtractorOptions,
): WorkspaceSqlExtraction {
  const skipped: Partial<Record<WorkspaceSkipReason, number>> = {};
  const relations = new Map<string, WorkspaceFileRelationContribution>();
  const objects = new Map<string, WorkspaceFileObjectContribution>();
  const columns = new Map<string, WorkspaceFileColumnContribution>();
  const fingerprints: string[] = [];
  const statements = SqlParser.splitStatementsWithPositions(sql, options.databaseKind);
  const maxStatements = options.maxStatements ?? 2000;
  for (const statement of statements.slice(0, maxStatements)) {
    if (!statement.sql.trim()) {
      continue;
    }
    const parsed = parseSqlStatements({
      sql: statement.sql,
      databaseKind: options.databaseKind,
    });
    if (
      parsed.lexResult.errors.length > 0
      || !parsed.cst
      || parsed.actionableParserErrors.length > 0
    ) {
      skipped["parse-error"] = (skipped["parse-error"] ?? 0) + 1;
      continue;
    }
    const normalized = normalizeSqlForFingerprint(statement.sql);
    if (!normalized) {
      continue;
    }
    const fingerprint = options.fingerprint(normalized);
    fingerprints.push(fingerprint);
    const root = getRootStatementNode(parsed.cst);
    if (!root) {
      skipped["parse-error"] = (skipped["parse-error"] ?? 0) + 1;
      continue;
    }
    if (!DML_ROOTS.has(root.name)) {
      skipped[DDL_ROOT_PATTERN.test(root.name) ? "ddl" : "unsupported"]
        = (skipped[DDL_ROOT_PATTERN.test(root.name) ? "ddl" : "unsupported"] ?? 0) + 1;
      continue;
    }
    const extractor = new StatementExtractor(
      fingerprint,
      options.databaseKind,
      skipped,
    );
    const result = extractor.extract(root);
    for (const relation of result.relations) {
      const key = `${relation.relation.key}\u0000${relation.fingerprint}`;
      relations.set(key, relation);
    }
    for (const object of result.objects) {
      const key = `${object.object.database ?? ""}\u0000${object.object.schema ?? ""}\u0000${object.object.name}\u0000${object.kind}\u0000${object.fingerprint}`;
      objects.set(key, object);
    }
    for (const column of result.columns) {
      const key = `${column.object.database ?? ""}\u0000${column.object.schema ?? ""}\u0000${column.object.name}\u0000${column.column.toUpperCase()}\u0000${column.fingerprint}`;
      columns.set(key, column);
    }
  }
  if (statements.length > maxStatements) {
    skipped["too-large"] = (skipped["too-large"] ?? 0) + (statements.length - maxStatements);
  }
  return {
    relations: [...relations.values()],
    objects: [...objects.values()],
    columns: [...columns.values()],
    fingerprints,
    skipped,
  };
}

/** Exported for focused tests. */
export function __TEST_ONLY_parseQualifiedTableName(
  sql: string,
): ParsedTableName | undefined {
  const parsed = parseSqlStatements({ sql: `SELECT * FROM ${sql}`, databaseKind: "netezza" });
  if (!parsed.cst) {
    return undefined;
  }
  const tableName = collectNodes(parsed.cst, "tableName")[0];
  return parseTableNameNode(tableName ? getChildNodesByKey(tableName, "qualifiedName")[0] : undefined);
}

