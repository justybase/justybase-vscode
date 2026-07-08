import { CstNode, type IToken } from "chevrotain";
import type { SqlParser } from "../parser";
import { getDatabaseSqlAuthoring } from "../../core/connectionFactory";
import { resolveSqlParsingRuntime } from "../parsingRuntime";
import { ScopeBuilder } from "./scopeBuilder";
import type {
  Scope,
  TableInfo,
  ColumnInfo,
  ValidationError,
  TokenPosition,
} from "../types";
import type { SchemaProvider } from "../schemaProvider";
import type { ExternalOptionValueInfo } from "./externalTableConstants";
import * as commandVisitor from "./commandVisitor";
import * as ddlVisitor from "./ddlVisitor";
import * as dmlVisitor from "./dmlVisitor";
import { type DdlVisitorHost } from "./ddlVisitor";
import * as externalTableVisitor from "./externalTableVisitor";
import * as expressionVisitor from "./expressionVisitor";
import { type ExternalTableVisitorHost } from "./externalTableVisitor";
import * as procedureVisitor from "./procedureVisitor";
import * as procedureControlVisitor from "./procedureControlVisitor";
import { type ProcedureVisitorHost } from "./procedureVisitor";
import * as queryScopeVisitor from "./queryScopeVisitor";
import { type TypeComparisonVisitorHost } from "./typeComparisonVisitor";
import type { SqlVisitorHost } from "./sqlVisitorHost";
import type { DatabaseSqlValidationProfile } from "../../sql/authoring/types";
import { unquoteIdentifier } from "../../utils/identifierUtils";
import { ProcedureScopeBuilder } from "../procedure/procedureScopeBuilder";

// Base visitor class from Chevrotain - lazily initialized
type BaseCstVisitorConstructor = ReturnType<
  SqlParser["getBaseCstVisitorConstructor"]
>;
let _BaseSqlVisitor: BaseCstVisitorConstructor | undefined;
function getBaseSqlVisitor(): BaseCstVisitorConstructor {
  if (!_BaseSqlVisitor) {
    _BaseSqlVisitor = resolveSqlParsingRuntime()
      .getSqlParserInstance()
      .getBaseCstVisitorConstructor();
  }
  return _BaseSqlVisitor;
}

const BOOLEAN_CONTEXT_TOKEN_TYPES = new Set([
  "Equals",
  "NotEquals",
  "LessThan",
  "GreaterThan",
  "LessThanEquals",
  "GreaterThanEquals",
  "Like",
  "In",
  "Between",
  "Is",
  "Exists",
  "Or",
  "And",
]);

const ARITHMETIC_TOKEN_TYPES = new Set([
  "Plus",
  "Minus",
  "Multiply",
  "Divide",
  "Modulo",
  "Caret",
  "Concat",
]);
export class SqlVisitor
  extends getBaseSqlVisitor()
  implements
    DdlVisitorHost,
    ExternalTableVisitorHost,
    ProcedureVisitorHost,
    SqlVisitorHost,
    TypeComparisonVisitorHost
{
  private scopeBuilder: ScopeBuilder;
  private errors: ValidationError[] = [];
  private schemaProvider?: SchemaProvider;
  private readonly validationProfile: DatabaseSqlValidationProfile;
  private inOrderBy = false;
  private inWhere = false;
  private inProcedureContext = false;
  private inPerformContext = false;
  private procedureScope: ProcedureScopeBuilder | null = null;
  private procedureTopLevelSelect = false;
  private stringBodyOffsetShift = 0;
  private scriptCreatedProcedureSeed = new Set<string>();
  private scriptCreatedProcedures = new Set<string>();
  private scriptCreatedTableSeed: TableInfo[] = [];
  private selectOutputAliasesStack: Array<Set<string>> = [];
  // Tracks aliases defined earlier in the current SELECT list (for Netezza alias reuse in select items)
  private selectListAliasesSoFar: Set<string> = new Set();
  private inSelectList = false;
  // In Netezza SQL, WHERE, GROUP BY, and HAVING can also reference SELECT aliases
  private canReferenceSelectAliases = false;
  /** Subqueries in expressions (IN, EXISTS, scalar subselect) — not CTE bodies. */
  private embeddedSelectDepth = 0;

  constructor(
    schemaProvider?: SchemaProvider,
    validationProfile: DatabaseSqlValidationProfile = getDatabaseSqlAuthoring()
      .validation,
  ) {
    super();
    this.scopeBuilder = new ScopeBuilder();
    this.schemaProvider = schemaProvider;
    this.validationProfile = validationProfile;
    this.validateVisitor();
  }

  seedScriptCreatedProcedures(procedureNames: readonly string[]): void {
    this.scriptCreatedProcedureSeed = new Set(procedureNames);
    this.scriptCreatedProcedures = new Set(this.scriptCreatedProcedureSeed);
  }

  visitEmbeddedSelectNode(node: CstNode): void {
    const prevWhere = this.inWhere;
    this.inWhere = false;
    this.embeddedSelectDepth++;
    try {
      this.visit(node);
    } finally {
      this.embeddedSelectDepth--;
      this.inWhere = prevWhere;
    }
  }

  seedScriptCreatedTables(tables: readonly TableInfo[]): void {
    this.scriptCreatedTableSeed = tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => ({ ...column })),
    }));
  }

  getScriptCreatedProcedureNames(): string[] {
    return Array.from(this.scriptCreatedProcedures);
  }

  getScriptScopeTables(): TableInfo[] {
    return this.scopeBuilder
      .getAllVisibleTables()
      .filter((table) => !table.isCte)
      .map((table) => ({
        ...table,
        columns: table.columns.map((column) => ({ ...column })),
      }));
  }

  getScopeBuilder(): ScopeBuilder {
    return this.scopeBuilder;
  }

  getSchemaProvider(): SchemaProvider | undefined {
    return this.schemaProvider;
  }

  getInProcedureContext(): boolean {
    return this.inProcedureContext;
  }

  setInProcedureContext(value: boolean): void {
    this.inProcedureContext = value;
  }

  getProcedureScope(): ProcedureScopeBuilder | null {
    return this.procedureScope;
  }

  getInOrderBy(): boolean {
    return this.inOrderBy;
  }

  setInOrderBy(value: boolean): void {
    this.inOrderBy = value;
  }

  getInWhere(): boolean {
    return this.inWhere;
  }

  setInWhere(value: boolean): void {
    this.inWhere = value;
  }

  getInPerformContext(): boolean {
    return this.inPerformContext;
  }

  setInPerformContext(value: boolean): void {
    this.inPerformContext = value;
  }

  getInSelectList(): boolean {
    return this.inSelectList;
  }

  setInSelectList(value: boolean): void {
    this.inSelectList = value;
  }

  getSelectListAliasesSoFar(): Set<string> {
    return this.selectListAliasesSoFar;
  }

  setSelectListAliasesSoFar(value: Set<string>): void {
    this.selectListAliasesSoFar = value;
  }

  getCanReferenceSelectAliases(): boolean {
    return this.canReferenceSelectAliases;
  }

  setCanReferenceSelectAliases(value: boolean): void {
    this.canReferenceSelectAliases = value;
  }

  getEmbeddedSelectDepth(): number {
    return this.embeddedSelectDepth;
  }

  setEmbeddedSelectDepth(value: number): void {
    this.embeddedSelectDepth = value;
  }

  setProcedureScope(scope: ProcedureScopeBuilder | null): void {
    this.procedureScope = scope;
  }

  getProcedureTopLevelSelect(): boolean {
    return this.procedureTopLevelSelect;
  }

  setProcedureTopLevelSelect(value: boolean): void {
    this.procedureTopLevelSelect = value;
  }

  getStringBodyOffsetShift(): number {
    return this.stringBodyOffsetShift;
  }

  setStringBodyOffsetShift(value: number): void {
    this.stringBodyOffsetShift = value;
  }

  getValidationProfile(): DatabaseSqlValidationProfile {
    return this.validationProfile;
  }

  addScriptCreatedProcedure(name: string): void {
    this.scriptCreatedProcedures.add(name);
  }

  hasScriptCreatedProcedure(name: string): boolean {
    return this.scriptCreatedProcedures.has(name);
  }

  formatRelationName(
    database: string | undefined,
    schema: string | undefined,
    name: string,
  ): string {
    if (database && schema) return `${database}.${schema}.${name}`;
    if (database && !schema) return `${database}..${name}`;
    if (!database && schema) return `${schema}.${name}`;
    return name;
  }

  isDropTargetTableLike(): boolean {
    return this._dropTargetIsTableLike;
  }

  setDropTargetIsTableLike(value: boolean): void {
    this._dropTargetIsTableLike = value;
  }

  validateTableExists(table: TableInfo, tableNameNode: CstNode): void {
    if (!this.schemaProvider) return;

    // SchemaProvider implementations may return "true" when existence is unknown (e.g. cache not loaded).
    if (
      this.schemaProvider.tableExists(table.database, table.schema, table.name)
    ) {
      return;
    }

    const token = this.getFirstTokenFromCst(tableNameNode);
    if (!token) return;

    const relationName = this.formatRelationName(
      table.database,
      table.schema,
      table.name,
    );
    this.addError(
      `Relation '${relationName}' does not exist`,
      token,
      "error",
      "SQL006",
    );
  }

  // Helper methods
  private getTokenPosition(token: IToken): TokenPosition {
    return {
      startLine: token.startLine || 1,
      startColumn: token.startColumn || 1,
      endLine: token.endLine || token.startLine || 1,
      endColumn:
        token.endColumn ||
        (token.startColumn || 1) + (token.image?.length || 0),
      offset: token.startOffset || 0,
    };
  }

  addError(
    message: string,
    token: IToken,
    severity: ValidationError["severity"] = "error",
    code = "SQL001",
    suggestedFix?: string,
  ): void {
    this.addErrorAtPosition(
      message,
      this.getTokenPosition(token),
      severity,
      code,
      suggestedFix,
    );
  }

  addErrorAtPosition(
    message: string,
    position: TokenPosition,
    severity: ValidationError["severity"] = "error",
    code = "SQL001",
    suggestedFix?: string,
  ): void {
    const resolvedPosition =
      this.stringBodyOffsetShift !== 0
        ? {
            ...position,
            offset: (position.offset ?? 0) + this.stringBodyOffsetShift,
          }
        : position;
    this.errors.push({
      message,
      severity,
      position: resolvedPosition,
      code,
      suggestedFix,
    });
  }

  getTokenText(token: IToken | IToken[] | undefined): string {
    if (!token) return "";
    if (Array.isArray(token)) {
      return token[0]?.image || "";
    }
    return token?.image || "";
  }

  isCstNode(value: unknown): value is CstNode {
    return (
      typeof value === "object" &&
      value !== null &&
      "name" in value &&
      "children" in value
    );
  }

  isToken(value: unknown): value is IToken {
    return (
      typeof value === "object" &&
      value !== null &&
      "image" in value &&
      "tokenType" in value
    );
  }

  getFirstTokenFromCst(node: CstNode): IToken | undefined {
    const children = node.children ?? {};

    for (const value of Object.values(children)) {
      if (!Array.isArray(value)) continue;

      for (const child of value) {
        if (this.isToken(child)) return child;
        if (this.isCstNode(child)) {
          const token = this.getFirstTokenFromCst(child);
          if (token) return token;
        }
      }
    }

    return undefined;
  }

  getCurrentSelectOutputAliases(): Set<string> | undefined {
    return this.selectOutputAliasesStack[
      this.selectOutputAliasesStack.length - 1
    ];
  }

  pushSelectOutputAliases(value: Set<string>): void {
    this.selectOutputAliasesStack.push(value);
  }

  replaceCurrentSelectOutputAliases(value: Set<string>): void {
    this.selectOutputAliasesStack[this.selectOutputAliasesStack.length - 1] =
      value;
  }

  popSelectOutputAliases(): Set<string> | undefined {
    return this.selectOutputAliasesStack.pop();
  }

  private containsTokenType(
    node: CstNode,
    tokenTypeNames: Set<string>,
  ): boolean {
    const children = node.children ?? {};

    for (const value of Object.values(children)) {
      if (!Array.isArray(value)) continue;

      for (const child of value) {
        if (this.isToken(child)) {
          const typeName = (child.tokenType as { name?: string } | undefined)
            ?.name;
          if (typeName && tokenTypeNames.has(typeName)) {
            return true;
          }
        } else if (this.isCstNode(child)) {
          if (this.containsTokenType(child, tokenTypeNames)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  validateBooleanContext(
    expressionNode: CstNode,
    token: IToken,
    context: string,
  ): void {
    // If we see any comparison / boolean operators - assume boolean.
    if (this.containsTokenType(expressionNode, BOOLEAN_CONTEXT_TOKEN_TYPES)) {
      return;
    }

    // If it looks like arithmetic/concat without comparisons, flag as error (common mistake in ON/WHERE).
    if (this.containsTokenType(expressionNode, ARITHMETIC_TOKEN_TYPES)) {
      this.addError(
        `${context} expression must be boolean`,
        token,
        "error",
        "SQL010",
      );
    }
  }

  validateDataType(
    typeInfo: { name: string; params: string[] },
    token: IToken,
  ): void {
    const spec = this.validationProfile.getTypeSpec(typeInfo.name);
    if (!spec) {
      this.addError(
        `Data type '${typeInfo.name}' does not exist`,
        token,
        "error",
        "SQL013",
      );
      return;
    }

    const normalizedParams = typeInfo.params.map((p) => p.toUpperCase());
    const hasAny = normalizedParams.includes("ANY");
    if (hasAny) {
      const isSingleAny =
        normalizedParams.length === 1 && normalizedParams[0] === "ANY";
      const canUseAny =
        isSingleAny &&
        this.inProcedureContext &&
        this.validationProfile.supportsProcedureAnySizeArgument(typeInfo.name);
      if (!canUseAny) {
        this.addError(
          `Invalid parameters for data type '${typeInfo.name}'`,
          token,
          "error",
          "SQL014",
        );
      }
      return;
    }

    if (
      typeInfo.params.length < spec.paramsMin ||
      typeInfo.params.length > spec.paramsMax
    ) {
      this.addError(
        `Invalid parameters for data type '${typeInfo.name}'`,
        token,
        "error",
        "SQL014",
      );
    }

    if (spec.warnIfNoLength && typeInfo.params.length === 0) {
      this.addError(
        `Type '${typeInfo.name}' should specify a length, e.g. ${spec.canonical}(10)`,
        token,
        "warning",
        "SQL012",
      );
    }
  }

  findDescendantCstNode(
    node: CstNode,
    targetName: string,
  ): CstNode | undefined {
    if (node.name === targetName) return node;

    const children = node.children ?? {};
    for (const value of Object.values(children)) {
      if (!Array.isArray(value)) continue;

      for (const child of value) {
        if (!this.isCstNode(child)) continue;
        const found = this.findDescendantCstNode(child, targetName);
        if (found) return found;
      }
    }

    return undefined;
  }

  findDescendantCstNodeBounded(
    node: CstNode,
    targetName: string,
    boundaryRules: ReadonlySet<string> = SqlVisitor.expressionSearchBoundaries,
  ): CstNode | undefined {
    if (boundaryRules.has(node.name)) {
      return undefined;
    }
    if (node.name === targetName) return node;

    const children = node.children ?? {};
    for (const value of Object.values(children)) {
      if (!Array.isArray(value)) continue;

      for (const child of value) {
        if (!this.isCstNode(child)) continue;
        const found = this.findDescendantCstNodeBounded(
          child,
          targetName,
          boundaryRules,
        );
        if (found) return found;
      }
    }

    return undefined;
  }

  private static readonly expressionSearchBoundaries = new Set([
    "subquery",
    "selectStatement",
    "withStatement",
  ]);

  applyKnownTableInfo(table: TableInfo, known: TableInfo): void {
    table.database ??= known.database;
    table.schema ??= known.schema;
    table.isCte = table.isCte || known.isCte;
    table.isTempTable = table.isTempTable || known.isTempTable;
    if (table.columns.length === 0 && known.columns.length > 0) {
      table.columns = known.columns;
    }
  }

  visitAs<T>(cstNode: CstNode): T {
    return this.visit(cstNode) as T;
  }

  statements(ctx: Record<string, CstNode[]>): {
    scope: Scope;
    errors: ValidationError[];
  } {
    this.scopeBuilder.reset();
    this.errors = [];
    this.scriptCreatedProcedures = new Set(this.scriptCreatedProcedureSeed);
    for (const table of this.scriptCreatedTableSeed) {
      this.scopeBuilder.addTable({
        ...table,
        columns: table.columns.map((column) => ({ ...column })),
      });
    }

    if (ctx.statement) {
      ctx.statement.forEach((statement: CstNode) => {
        this.visit(statement);
      });
    }

    return {
      scope: this.scopeBuilder.getCurrentScope(),
      errors: this.errors,
    };
  }

  statement(ctx: Record<string, CstNode[]>): void {
    // Delegate to specific statement type
    if (ctx.selectStatement) {
      this.visit(ctx.selectStatement[0]);
    } else if (ctx.withAnyStatement) {
      this.visit(ctx.withAnyStatement[0]);
    } else if (ctx.createDatabaseStatement) {
      this.visit(ctx.createDatabaseStatement[0]);
    } else if (ctx.createGroupStatement) {
      this.visit(ctx.createGroupStatement[0]);
    } else if (ctx.createSequenceStatement) {
      this.visit(ctx.createSequenceStatement[0]);
    } else if (ctx.createExternalTableStatement) {
      this.visit(ctx.createExternalTableStatement[0]);
    } else if (ctx.createTableStatement) {
      this.visit(ctx.createTableStatement[0]);
    } else if (ctx.createProcedureStatement) {
      this.visit(ctx.createProcedureStatement[0]);
    } else if (ctx.createSynonymStatement) {
      this.visit(ctx.createSynonymStatement[0]);
    } else if (ctx.createViewStatement) {
      this.visit(ctx.createViewStatement[0]);
    } else if (ctx.commentStatement) {
      this.visit(ctx.commentStatement[0]);
    } else if (ctx.alterTableStatement) {
      this.visit(ctx.alterTableStatement[0]);
    } else if (ctx.dropStatement) {
      this.visit(ctx.dropStatement[0]);
    } else if (ctx.truncateStatement) {
      this.visit(ctx.truncateStatement[0]);
    } else if (ctx.groomStatement) {
      this.visit(ctx.groomStatement[0]);
    } else if (ctx.generateStatisticsStatement) {
      this.visit(ctx.generateStatisticsStatement[0]);
    } else if (ctx.showStatement) {
      this.visit(ctx.showStatement[0]);
    } else if (ctx.copyStatement) {
      this.visit(ctx.copyStatement[0]);
    } else if (ctx.lockStatement) {
      this.visit(ctx.lockStatement[0]);
    } else if (ctx.mergeStatement) {
      this.visit(ctx.mergeStatement[0]);
    } else if (ctx.reindexStatement) {
      this.visit(ctx.reindexStatement[0]);
    } else if (ctx.resetStatement) {
      this.visit(ctx.resetStatement[0]);
    } else if (ctx.withStatement) {
      this.visit(ctx.withStatement[0]);
    } else if (ctx.insertStatement) {
      this.visit(ctx.insertStatement[0]);
    } else if (ctx.updateStatement) {
      this.visit(ctx.updateStatement[0]);
    } else if (ctx.deleteStatement) {
      this.visit(ctx.deleteStatement[0]);
    } else if (ctx.commitStatement) {
      this.visit(ctx.commitStatement[0]);
    } else if (ctx.rollbackStatement) {
      this.visit(ctx.rollbackStatement[0]);
    } else if (ctx.beginStatement) {
      this.visit(ctx.beginStatement[0]);
    } else if (ctx.setStatement) {
      this.visit(ctx.setStatement[0]);
    } else if (ctx.variableSetStatement) {
      this.visit(ctx.variableSetStatement[0]);
    }
  }

  setStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.visitCommandTail(this, ctx);
  }

  showStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.visitCommandTail(this, ctx);
  }

  copyStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.visitCommandTail(this, ctx);
  }

  lockStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.lockStatement(this, ctx);
  }

  mergeStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.visitCommandTail(this, ctx);
  }

  reindexStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.visitCommandTail(this, ctx);
  }

  resetStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.visitCommandTail(this, ctx);
  }

  beginStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.visitCommandTail(this, ctx);
  }

  variableSetStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.variableSetStatement(this, ctx);
  }

  selectStatement(ctx: Record<string, CstNode[]>): ColumnInfo[] {
    return queryScopeVisitor.selectStatement(this, ctx);
  }

  setOperation(): void {
    // Syntax-only construct; no semantic checks needed.
  }

  parenthesizedSetStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.parenthesizedSetStatement(this, ctx);
  }

  createSequenceStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.createSequenceStatement(this, ctx);
  }

  fromClause(ctx: Record<string, CstNode[]>): void {
    queryScopeVisitor.fromClause(this, ctx);
  }

  tableReference(ctx: Record<string, CstNode[]>): void {
    queryScopeVisitor.tableReference(this, ctx);
  }

  tableSource(ctx: Record<string, CstNode[]>): void {
    queryScopeVisitor.tableSource(this, ctx);
  }

  tableName(ctx: Record<string, CstNode[]>): TableInfo {
    return queryScopeVisitor.tableName(this, ctx);
  }

  qualifiedName(ctx: { identifier?: CstNode[]; Dot?: IToken[] }): {
    name: string;
    schema?: string;
    database?: string;
  } {
    return queryScopeVisitor.qualifiedName(this, ctx);
  }

  identifier(ctx: Record<string, IToken[]>): string {
    // Get the first token (identifier or keyword)
    for (const key in ctx) {
      const tokens = ctx[key];
      if (Array.isArray(tokens) && tokens.length > 0) {
        return unquoteIdentifier(this.getTokenText(tokens[0]));
      }
    }
    return "";
  }

  aliasOptional(ctx: Record<string, CstNode[]>): string | undefined {
    if (ctx.alias) {
      return this.visitAs<string>(ctx.alias[0]);
    }
    return undefined;
  }

  alias(ctx: Record<string, CstNode[] | IToken[]>): string {
    if (ctx.identifier) {
      return unquoteIdentifier(
        this.visitAs<string>(ctx.identifier[0] as unknown as CstNode),
      );
    }
    const relaxedNameNode = ctx.netezzaRelaxedName?.[0];
    if (relaxedNameNode && this.isCstNode(relaxedNameNode)) {
      const token = this.getFirstTokenFromCst(relaxedNameNode);
      return unquoteIdentifier(this.getTokenText(token));
    }
    const token =
      (ctx.Identifier?.[0] as unknown as IToken | undefined) ||
      (ctx.QuotedIdentifier?.[0] as unknown as IToken | undefined);
    return unquoteIdentifier(this.getTokenText(token));
  }

  netezzaRelaxedName(): void {
    // Tokens are consumed by parent alias/columnReference handlers.
  }

  subquery(ctx: Record<string, CstNode[]>): TableInfo {
    return queryScopeVisitor.subquery(this, ctx);
  }

  joinClause(ctx: Record<string, CstNode[]>): void {
    queryScopeVisitor.joinClause(this, ctx);
  }

  selectClause(ctx: Record<string, CstNode[]>): ColumnInfo[] {
    return queryScopeVisitor.selectClause(this, ctx);
  }

  intoClause(): void {
    // INTO targets in NZPLSQL are variables, not table references.
  }

  selectList(ctx: Record<string, CstNode[]>): ColumnInfo[] {
    return queryScopeVisitor.selectList(this, ctx);
  }

  selectItem(ctx: Record<string, CstNode[]>): ColumnInfo[] {
    return queryScopeVisitor.selectItem(this, ctx);
  }

  starExpression(ctx: Record<string, IToken[]>): ColumnInfo[] {
    return queryScopeVisitor.starExpression(this, ctx);
  }

  expression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.expression(this, ctx);
  }

  orExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.orExpression(this, ctx);
  }

  andExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.andExpression(this, ctx);
  }

  notExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.notExpression(this, ctx);
  }

  comparisonExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.comparisonExpression(this, ctx);
  }

  comparisonRhs(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.comparisonRhs(this, ctx);
  }

  inExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.inExpression(this, ctx);
  }

  betweenExpression(): void {
    // Handled by comparisonExpression
  }

  isExpression(): void {
    // Handled by comparisonExpression
  }

  literal(): void {
    // No validation needed for literals
  }

  typeLiteral(): void {
    // No validation needed for type literals (e.g., ABSTIME 'now', TIMESTAMP '2023-01-01')
  }

  additiveExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.additiveExpression(this, ctx);
  }

  multiplicativeExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.multiplicativeExpression(this, ctx);
  }

  unaryExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.unaryExpression(this, ctx);
  }

  castExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.castExpression(this, ctx);
  }

  primaryExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.primaryExpression(this, ctx);
  }

  existsExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.existsExpression(this, ctx);
  }

  sequenceValueExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.sequenceValueExpression(this, ctx);
  }

  expressionList(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.expressionList(this, ctx);
  }

  columnReference(ctx: Record<string, CstNode[] | IToken[]>): void {
    expressionVisitor.columnReference(this, ctx);
  }

  functionCall(ctx: Record<string, CstNode[] | IToken[]>): void {
    expressionVisitor.functionCall(this, ctx);
  }

  functionArguments(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.functionArguments(this, ctx);
  }

  overClause(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.overClause(this, ctx);
  }

  filterClause(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.filterClause(this, ctx);
  }

  partitionByClause(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.partitionByClause(this, ctx);
  }

  windowFrameClause(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.windowFrameClause(this, ctx);
  }

  frameBound(): void {
    // Syntax-only construct.
  }

  excludeClause(): void {
    // Syntax-only construct.
  }

  castFunctionExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.castFunctionExpression(this, ctx);
  }

  extractExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.extractExpression(this, ctx);
  }

  caseExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.caseExpression(this, ctx);
  }

  whereClause(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.whereClause(this, ctx);
  }

  groupByClause(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.groupByClause(this, ctx);
  }

  groupByElement(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.groupByElement(this, ctx);
  }

  groupingSetsExpression(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.groupingSetsExpression(this, ctx);
  }

  groupingSet(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.groupingSet(this, ctx);
  }

  havingClause(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.havingClause(this, ctx);
  }

  orderByClause(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.orderByClause(this, ctx);
  }

  orderByItem(ctx: Record<string, CstNode[]>): void {
    expressionVisitor.orderByItem(this, ctx);
  }

  limitClause(): void {
    // No validation needed
  }

  fetchFirstClause(): void {
    // No validation needed
  }

  createTableStatement(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.createTableStatement(this, ctx);
  }

  createDatabaseStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.visitCommandTail(this, ctx);
  }

  createGroupStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.visitCommandTail(this, ctx);
  }

  createExternalTableStatement(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.createExternalTableStatement(this, ctx);
  }

  externalTableUsingClause(ctx: Record<string, CstNode[]>): void {
    externalTableVisitor.externalTableUsingClause(this, ctx);
  }

  externalTableOptionList(ctx: Record<string, CstNode[]>): void {
    externalTableVisitor.externalTableOptionList(this, ctx);
  }

  externalTableOption(ctx: Record<string, CstNode[]>): void {
    externalTableVisitor.externalTableOption(this, ctx);
  }

  externalTableOptionValue(
    ctx: Record<string, CstNode[] | IToken[]>,
  ): ExternalOptionValueInfo {
    return externalTableVisitor.externalTableOptionValue(this, ctx);
  }

  externalTableNumericValue(
    ctx: Record<string, IToken[]>,
  ): ExternalOptionValueInfo {
    return externalTableVisitor.externalTableNumericValue(this, ctx);
  }

  externalTableParenthesizedValue(
    ctx: Record<string, CstNode[] | IToken[]>,
  ): ExternalOptionValueInfo {
    return externalTableVisitor.externalTableParenthesizedValue(this, ctx);
  }

  externalTableParenthesizedElement(
    ctx: Record<string, CstNode[] | IToken[]>,
  ): ExternalOptionValueInfo {
    return externalTableVisitor.externalTableParenthesizedElement(this, ctx);
  }

  createProcedureStatement(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.createProcedureStatement(this, ctx);
  }

  procedureArguments(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.procedureArguments(this, ctx);
  }

  procedureArgument(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.procedureArgument(this, ctx);
  }

  procedureArgumentMode(): void {
    procedureVisitor.procedureArgumentMode();
  }

  procedureReturnType(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.procedureReturnType(this, ctx);
  }

  procedureSignatureSpec(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.procedureSignatureSpec(this, ctx);
  }

  executeAsClause(): void {
    procedureVisitor.executeAsClause();
  }

  procedureBody(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.procedureBody(this, ctx);
  }

  beginProcBody(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.beginProcBody(this, ctx);
  }

  procedureBlock(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.procedureBlock(this, ctx);
  }

  autocommitClause(): void {
    procedureVisitor.autocommitClause();
  }

  procedureDeclareSection(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.procedureDeclareSection(this, ctx);
  }

  variableDeclarations(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.variableDeclarations(this, ctx);
  }

  variableDeclaration(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.variableDeclaration(this, ctx);
  }

  procedureStatements(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.procedureStatements(this, ctx);
  }

  procedureStatement(ctx: Record<string, CstNode[]>): void {
    procedureVisitor.procedureStatement(this, ctx);
  }

  arrayAssignmentStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.arrayAssignmentStatement(this, ctx);
  }

  assignmentStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.assignmentStatement(this, ctx);
  }

  returnStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.returnStatement(this, ctx);
  }

  ifStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.ifStatement(this, ctx);
  }

  elsifClause(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.elsifClause(this, ctx);
  }

  procedureLabel(_ctx: Record<string, CstNode[]>): void {
    procedureVisitor.procedureLabel(_ctx);
  }

  loopStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.loopStatement(this, ctx);
  }

  whileStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.whileStatement(this, ctx);
  }

  forStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.forStatement(this, ctx);
  }

  exitStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.exitStatement(this, ctx);
  }

  raiseStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.raiseStatement(this, ctx);
  }

  rollbackStatement(): void {
    // No validation needed
  }

  commitStatement(): void {
    // No validation needed
  }

  callStatement(ctx: Record<string, CstNode[]>): void {
    dmlVisitor.callStatement(this, ctx);
  }

  executeImmediateStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.executeImmediateStatement(this, ctx);
  }

  performStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.performStatement(this, ctx);
  }

  arrayMethodStatement(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.arrayMethodStatement(this, ctx);
  }

  exceptionBlock(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.exceptionBlock(this, ctx);
  }

  whenClause(ctx: Record<string, CstNode[]>): void {
    procedureControlVisitor.whenClause(this, ctx);
  }

  createViewStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.createViewStatement(this, ctx);
  }

  commentStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.commentStatement(this, ctx);
  }

  alterTableStatement(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableStatement(this, ctx);
  }

  alterTableAction(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableAction(this, ctx);
  }

  alterTableAddColumnAction(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableAddColumnAction(this, ctx);
  }

  alterTableAddConstraintAction(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableAddConstraintAction(this, ctx);
  }

  alterTableAlterColumnAction(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableAlterColumnAction(this, ctx);
  }

  alterTableDropColumnAction(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableDropColumnAction(this, ctx);
  }

  alterTableDropConstraintAction(): void {
    ddlVisitor.alterTableDropConstraintAction();
  }

  alterTableModifyColumnAction(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableModifyColumnAction(this, ctx);
  }

  alterTableOwnerAction(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableOwnerAction(this, ctx);
  }

  alterTableRenameColumnAction(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableRenameColumnAction(this, ctx);
  }

  alterTableRenameTableAction(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableRenameTableAction(this, ctx);
  }

  alterTableSetPrivilegesAction(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.alterTableSetPrivilegesAction(this, ctx);
  }

  alterTableCascadeRestrictClause(): void {
    ddlVisitor.alterTableCascadeRestrictClause();
  }

  alterObjectStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.visitCommandTail(this, ctx);
  }

  private _dropTargetIsTableLike = false;

  dropStatement(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.dropStatement(this, ctx);
  }

  dropTargetList(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.dropTargetList(this, ctx);
  }

  dropTarget(ctx: Record<string, CstNode[]>): void {
    ddlVisitor.dropTarget(this, ctx);
  }

  truncateStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.truncateStatement(this, ctx);
  }

  explainStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.explainStatement(this, ctx);
  }

  commandTail(ctx: Record<string, CstNode[]>): void {
    commandVisitor.commandTail(this, ctx);
  }

  commandTailToken(): void {
    // No validation needed
  }

  constraintDefinition(ctx: Record<string, CstNode[]>): void {
    commandVisitor.constraintDefinition(this, ctx);
  }

  primaryKeyConstraint(): void {
    // No validation needed
  }

  uniqueConstraint(): void {
    // No validation needed
  }

  foreignKeyConstraint(): void {
    // No validation needed
  }

  checkConstraint(ctx: Record<string, CstNode[]>): void {
    commandVisitor.checkConstraint(this, ctx);
  }

  columnList(): void {
    // No validation needed
  }

  groomStatement(ctx: Record<string, CstNode[]>): void {
    commandVisitor.groomStatement(this, ctx);
  }

  generateStatisticsStatement(): void {
    // No validation needed
  }

  groomModeClause(): void {
    // No validation needed
  }

  groomReclaimClause(): void {
    // No validation needed
  }

  generateStatisticsColumnsClause(): void {
    // No validation needed
  }

  grantStatement(): void {
    // Uses commandTail — no deep validation
  }

  revokeStatement(): void {
    // Uses commandTail — no deep validation
  }

  createUserStatement(): void {
    // Uses commandTail — no deep validation
  }

  createSynonymStatement(): void {
    // Uses commandTail — no deep validation
  }

  distributeClause(): void {
    // No validation needed at this level
  }

  organizeClause(): void {
    // No validation needed at this level
  }

  tableTypeClause(): void {
    // No validation needed
  }

  columnDefinitionList(ctx: Record<string, CstNode[]>): ColumnInfo[] {
    return commandVisitor.columnDefinitionList(this, ctx);
  }

  columnOrConstraintDefinition(ctx: Record<string, CstNode[]>): ColumnInfo | void {
    return commandVisitor.columnOrConstraintDefinition(this, ctx);
  }

  tableConstraintDefinition(ctx: Record<string, CstNode[]>): void {
    commandVisitor.tableConstraintDefinition(this, ctx);
  }

  columnDefinition(ctx: Record<string, CstNode[]>): ColumnInfo {
    return commandVisitor.columnDefinition(this, ctx);
  }

  columnName(ctx: Record<string, CstNode[]>): string {
    return commandVisitor.columnName(this, ctx);
  }

  typeName(ctx: Record<string, CstNode[] | IToken[]>): {
    name: string;
    params: string[];
  } {
    return commandVisitor.typeName(this, ctx);
  }

  typeNameWord(ctx: Record<string, IToken[]>): string {
    return commandVisitor.typeNameWord(this, ctx);
  }

  typeArgument(ctx: Record<string, IToken[]>): string {
    return commandVisitor.typeArgument(this, ctx);
  }

  withAnyStatement(ctx: Record<string, CstNode[]>): ColumnInfo[] {
    return queryScopeVisitor.withAnyStatement(this, ctx);
  }

  withStatement(ctx: Record<string, CstNode[]>): ColumnInfo[] {
    return queryScopeVisitor.withStatement(this, ctx);
  }

  cteDefinition(ctx: Record<string, CstNode[]>): void {
    queryScopeVisitor.cteDefinition(this, ctx);
  }

  cteColumnList(ctx: Record<string, CstNode[]>): string[] {
    return queryScopeVisitor.cteColumnList(this, ctx);
  }

  viewColumnAliasList(ctx: Record<string, CstNode[]>): string[] {
    return queryScopeVisitor.viewColumnAliasList(this, ctx);
  }

  insertStatement(ctx: Record<string, CstNode[]>): void {
    dmlVisitor.insertStatement(this, ctx);
  }

  insertWithClause(ctx: Record<string, CstNode[]>): void {
    dmlVisitor.insertWithClause(this, ctx);
  }

  insertCteDefinition(ctx: Record<string, CstNode[]>): void {
    dmlVisitor.insertCteDefinition(this, ctx);
  }

  valuesClause(ctx: Record<string, CstNode[]>): void {
    dmlVisitor.valuesClause(this, ctx);
  }

  updateStatement(ctx: Record<string, CstNode[]>): void {
    dmlVisitor.updateStatement(this, ctx);
  }

  updateSetItem(ctx: Record<string, CstNode[]>): void {
    dmlVisitor.updateSetItem(this, ctx);
  }

  deleteStatement(ctx: Record<string, CstNode[]>): void {
    dmlVisitor.deleteStatement(this, ctx);
  }

  tempClause(): void {
    // No validation needed
  }

  selectModifier(): void {
    // No validation needed
  }

  getCstText(node: CstNode): string {
    const tokens: string[] = [];
    const walk = (current: CstNode | IToken): void => {
      if ("tokenType" in current && current.tokenType) {
        tokens.push(current.image ?? "");
        return;
      }
      const cst = current as CstNode;
      for (const childNodes of Object.values(cst.children ?? {})) {
        for (const child of childNodes) {
          if (typeof child === "object" && child !== null && "name" in child) {
            walk(child as CstNode);
          } else if (
            typeof child === "object" &&
            child !== null &&
            "tokenType" in child
          ) {
            walk(child as IToken);
          }
        }
      }
    };
    walk(node);
    return tokens.join(" ");
  }

  getErrors(): ValidationError[] {
    return this.errors;
  }

  getScope(): Scope {
    return this.scopeBuilder.getCurrentScope();
  }
}
