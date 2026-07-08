import { CstNode, type IToken } from "chevrotain";
import { getOrderedReferenceTokens } from "../../providers/parsers/scope";
import {
  getCstNodeTokenSpan,
  getTokenSpanPositionFromEndpoints,
} from "../tokenSpanUtils";
import type { ColumnInfo, TableInfo } from "../types";
import type { SqlVisitorHost } from "./sqlVisitorHost";

const RESERVED_UNQUOTED_TABLE_NAME_TOKENS = new Set([
  "From",
  "Where",
  "Join",
  "On",
  "Select",
  "Insert",
  "Update",
  "Delete",
  "Create",
  "Drop",
  "Alter",
  "With",
  "GroupBy",
  "OrderBy",
  "Having",
  "Limit",
  "Offset",
  "Union",
  "Intersect",
  "Except",
  "MinusSet",
]);

const AGGREGATE_FUNCTIONS = new Set([
  "SUM",
  "COUNT",
  "AVG",
  "MIN",
  "MAX",
  "STDDEV",
  "STDDEV_POP",
  "STDDEV_SAMP",
  "VARIANCE",
  "VAR_POP",
  "VAR_SAMP",
  "GROUP_CONCAT",
  "GROUP_CONCAT_SORT",
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "PERCENT_RANK",
  "CUME_DIST",
  "NTILE",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "NTH_VALUE",
]);

const GROUPING_AGGREGATE_FUNCTIONS = new Set([
  "SUM",
  "COUNT",
  "AVG",
  "MIN",
  "MAX",
  "STDDEV",
  "STDDEV_POP",
  "STDDEV_SAMP",
  "VARIANCE",
  "VAR_POP",
  "VAR_SAMP",
  "GROUP_CONCAT",
  "GROUP_CONCAT_SORT",
]);

export function selectStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): ColumnInfo[] {
  const scopeBuilder = host.getScopeBuilder();
  scopeBuilder.enterScope();
  host.pushSelectOutputAliases(new Set());
  const savedCanReferenceSelectAliases = host.getCanReferenceSelectAliases();

  if (!ctx.fromClause && ctx.selectClause) {
    detectMissingFromClause(host, ctx.selectClause[0]);
  }
  if (
    !ctx.fromClause &&
    ctx.whereClause &&
    host.getEmbeddedSelectDepth() === 0
  ) {
    const whereToken =
      (ctx.whereClause[0].children?.Where?.[0] as unknown as
        | IToken
        | undefined) ?? host.getFirstTokenFromCst(ctx.whereClause[0]);
    if (whereToken) {
      host.addError(
        "WHERE clause used without FROM clause. SELECT statements with WHERE require a FROM clause.",
        whereToken,
        "warning",
        "SQL042",
      );
    }
  }

  if (ctx.fromClause) {
    host.visit(ctx.fromClause[0]);
  }

  const outputColumns = ctx.selectClause
    ? host.visitAs<ColumnInfo[]>(ctx.selectClause[0])
    : [];
  host.replaceCurrentSelectOutputAliases(
    new Set(outputColumns.map((c) => c.name.toUpperCase())),
  );

  host.setCanReferenceSelectAliases(true);

  if (ctx.whereClause) {
    host.visit(ctx.whereClause[0]);
  }

  if (ctx.groupByClause) {
    host.visit(ctx.groupByClause[0]);
  }

  if (ctx.havingClause) {
    host.visit(ctx.havingClause[0]);
  }

  if (ctx.orderByClause) {
    host.visit(ctx.orderByClause[0]);
  }

  if (ctx.selectClause?.[0]) {
    const selectClause = ctx.selectClause[0];
    const hasGroupBy = !!ctx.groupByClause?.[0];
    const hasAggregates = selectContainsAggregates(host, selectClause);
    if (hasGroupBy && ctx.groupByClause?.[0]) {
      if (!groupByContainsGroupingExtension(host, ctx.groupByClause[0])) {
        validateGroupBySelectAlignment(host, selectClause, ctx.groupByClause[0]);
        if (ctx.orderByClause?.[0] && hasAggregates) {
          validateOrderByInGroupedQuery(
            host,
            selectClause,
            ctx.groupByClause[0],
            ctx.orderByClause[0],
          );
        }
      }
    } else if (hasAggregates) {
      validateSelectAggregatesWithoutGroupBy(host, selectClause);
    }
  }

  if (ctx.limitClause) {
    host.visit(ctx.limitClause[0]);
  }

  if (ctx.fetchFirstClause) {
    host.visit(ctx.fetchFirstClause[0]);
  }

  if (ctx.setOperation) {
    ctx.setOperation.forEach((op: CstNode) => {
      host.visit(op);
    });
  }

  if (ctx.selectStatement) {
    ctx.selectStatement.forEach((setExpr: CstNode) => {
      host.visit(setExpr);
    });
  }

  const procedureScope = host.getProcedureScope();
  if (procedureScope && host.getProcedureTopLevelSelect() && ctx.selectClause?.[0]) {
    const selectClauseNode = ctx.selectClause[0];
    const selectToken = host.getFirstTokenFromCst(selectClauseNode);
    if (selectToken) {
      const selectClauseChildren = selectClauseNode.children as Record<
        string,
        CstNode[]
      >;
      procedureScope.checkStandaloneSelect(
        selectToken,
        !!selectClauseChildren.intoClause?.length,
      );
    }
  }

  if (ctx.withStatement) {
    ctx.withStatement.forEach((setExpr: CstNode) => {
      host.visit(setExpr);
    });
  }

  host.popSelectOutputAliases();
  host.setCanReferenceSelectAliases(savedCanReferenceSelectAliases);
  scopeBuilder.exitScope();

  return outputColumns;
}

export function fromClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.tableReference) {
    ctx.tableReference.forEach((ref: CstNode) => {
      host.visit(ref);
    });
  }
}

export function tableReference(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.tableSource) {
    host.visit(ctx.tableSource[0]);
  }

  if (ctx.joinClause) {
    ctx.joinClause.forEach((join: CstNode) => {
      host.visit(join);
    });
  }
}

export function tableSource(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const scopeBuilder = host.getScopeBuilder();
  const schemaProvider = host.getSchemaProvider();
  let table: TableInfo | undefined;
  let tableNameNode: CstNode | undefined;
  let hasInvalidKeywordTableName = false;
  const alias = ctx.aliasOptional
    ? host.visitAs<string | undefined>(ctx.aliasOptional[0])
    : undefined;

  if (ctx.tableName) {
    tableNameNode = ctx.tableName[0];
    table = host.visitAs<TableInfo>(tableNameNode);

    const invalidKeywordToken = getInvalidUnquotedKeywordTableIdentifier(
      host,
      tableNameNode,
    );
    if (invalidKeywordToken) {
      host.addError(
        `Unquoted reserved keyword '${invalidKeywordToken.image.toUpperCase()}' cannot be used as table name. Use "${invalidKeywordToken.image.toUpperCase()}"`,
        invalidKeywordToken,
        "error",
        "SQL015",
      );
      hasInvalidKeywordTableName = true;
    }

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
        const canValidateUnqualified =
          !isQualified &&
          (schemaProvider.canValidateUnqualifiedTableReferences?.() ?? false);
        if (
          !hasInvalidKeywordTableName &&
          (isQualified || canValidateUnqualified) &&
          !table.isTempTable &&
          !table.isCte
        ) {
          host.validateTableExists(table, tableNameNode);
        }
      }
    }

    addTableQualificationWarning(host, table, tableNameNode);
  } else if (ctx.subquery) {
    table = host.visitAs<TableInfo>(ctx.subquery[0]);
    if (!alias) {
      const token = host.getFirstTokenFromCst(ctx.subquery[0]);
      if (token) {
        host.addError(
          "Subquery in FROM/JOIN must have an alias",
          token,
          "error",
          "SQL020",
        );
      }
    }
  } else if (ctx.Final && ctx.qualifiedName) {
    const functionSource = host.visitAs<{
      name: string;
      schema?: string;
      database?: string;
    }>(ctx.qualifiedName[0]);
    table = {
      name: functionSource.name || "",
      schema: functionSource.schema,
      database: functionSource.database,
      isCte: false,
      isTempTable: false,
      columns: [],
    };
  }

  if (!table) return;

  if (alias) {
    table.alias = alias;
  }

  const existingTable = scopeBuilder.addTable(table);
  if (existingTable) {
    const key = (table.alias || table.name).toUpperCase();
    const token = host.getFirstTokenFromCst(
      ctx.tableName?.[0] || ctx.subquery?.[0] || ctx.qualifiedName?.[0],
    );
    if (token) {
      host.addError(
        `Table name "${key}" specified more than once`,
        token,
        "error",
        "SQL011",
      );
    }
  }
}

export function addTableQualificationWarning(
  host: SqlVisitorHost,
  table: TableInfo,
  tableNameNode: CstNode | undefined,
): void {
  if (
    !tableNameNode ||
    table.isCte ||
    table.isTempTable ||
    (table.database && table.schema)
  ) {
    return;
  }

  const schemaProvider = host.getSchemaProvider();
  const proposals = schemaProvider?.proposeTableQualification?.({
    database: table.database,
    schema: table.schema,
    name: table.name,
  }) ?? [];
  if (proposals.length === 0) {
    return;
  }

  const qualifiedNameNode =
    host.findDescendantCstNode(tableNameNode, "qualifiedName") ?? tableNameNode;
  const span = getCstNodeTokenSpan(qualifiedNameNode);
  if (!span) {
    return;
  }

  host.addErrorAtPosition(
    `Table '${host.formatRelationName(table.database, table.schema, table.name)}' can be qualified as '${proposals[0].qualifiedText}'`,
    span,
    "information",
    "SQL048",
    proposals[0].qualifiedText,
  );
}

export function addTableQualificationWarningFromQualifiedName(
  host: SqlVisitorHost,
  nameInfo: { name: string; schema?: string; database?: string },
  qualifiedNameNode: CstNode,
): void {
  addTableQualificationWarning(
    host,
    {
      name: nameInfo.name,
      schema: nameInfo.schema,
      database: nameInfo.database,
      isCte: false,
      isTempTable: false,
      columns: [],
    },
    qualifiedNameNode,
  );
}

export function tableName(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): TableInfo {
  const qualifiedName = ctx.qualifiedName
    ? host.visitAs<{ name: string; schema?: string; database?: string }>(
        ctx.qualifiedName[0],
      )
    : { name: "" };

  return {
    name: qualifiedName.name || "",
    schema: qualifiedName.schema,
    database: qualifiedName.database,
    isCte: false,
    isTempTable: false,
    columns: [],
  };
}

export function qualifiedName(
  host: SqlVisitorHost,
  ctx: { identifier?: CstNode[]; Dot?: IToken[] },
): {
  name: string;
  schema?: string;
  database?: string;
} {
  const identifiers = (ctx.identifier ?? [])
    .map((node) => host.visitAs<string>(node))
    .filter((text) => text.length > 0);
  const dotCount = ctx.Dot?.length ?? 0;

  if (identifiers.length === 1) {
    return { name: identifiers[0] };
  }

  if (identifiers.length === 2) {
    let treatAsDatabaseDotDot = false;

    if (dotCount === 1) {
      const databases = host.getSchemaProvider()?.getDatabases?.();
      const first = identifiers[0]?.toUpperCase();
      if (
        databases &&
        first &&
        databases.some((db) => db.toUpperCase() === first)
      ) {
        const firstToken = ctx.identifier?.[0]
          ? host.getFirstTokenFromCst(ctx.identifier[0])
          : undefined;
        const lastToken = ctx.identifier?.[1]
          ? host.getFirstTokenFromCst(ctx.identifier[1])
          : undefined;
        if (firstToken && lastToken) {
          const suggestedFix = host.getSchemaProvider()
            ?.proposeTableQualification?.({
              database: identifiers[0],
              name: identifiers[1],
            })[0]?.qualifiedText;
          host.addErrorAtPosition(
            `Invalid two-part name '${identifiers[0]}.${identifiers[1]}'. Use '${identifiers[0]}..${identifiers[1]}' or '${identifiers[0]}.<schema>.${identifiers[1]}'`,
            getTokenSpanPositionFromEndpoints(firstToken, lastToken),
            "error",
            "SQL007",
            suggestedFix,
          );
        }
        treatAsDatabaseDotDot = true;
      }
    }

    if (dotCount === 2 || treatAsDatabaseDotDot) {
      return { database: identifiers[0], name: identifiers[1] };
    }
    return { schema: identifiers[0], name: identifiers[1] };
  }

  if (identifiers.length >= 3) {
    return {
      database: identifiers[0],
      schema: identifiers[1],
      name: identifiers[2],
    };
  }

  return { name: "" };
}

export function subquery(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): TableInfo {
  const prevWhere = host.getInWhere();
  host.setInWhere(false);

  const selectNode = ctx.selectStatement?.[0];
  const withNode = ctx.withStatement?.[0];
  const simpleStarSource = selectNode
    ? inferSimpleStarSubquerySourceTable(host, selectNode)
    : undefined;

  let columns: ColumnInfo[];
  host.setEmbeddedSelectDepth(host.getEmbeddedSelectDepth() + 1);
  try {
    columns = selectNode
      ? host.visitAs<ColumnInfo[]>(selectNode)
      : withNode
        ? host.visitAs<ColumnInfo[]>(withNode)
        : [];
  } finally {
    host.setEmbeddedSelectDepth(host.getEmbeddedSelectDepth() - 1);
  }

  host.setInWhere(prevWhere);
  return {
    name: simpleStarSource?.name ?? "subquery",
    database: simpleStarSource?.database,
    schema: simpleStarSource?.schema,
    isCte: false,
    isTempTable: false,
    columns: columns.length > 0 ? columns : (simpleStarSource?.columns ?? []),
  };
}

export function joinClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.tableSource) {
    host.visit(ctx.tableSource[0]);
  }

  if (ctx.expression) {
    host.visit(ctx.expression[0]);

    const onToken =
      (ctx.On?.[0] as unknown as IToken | undefined) ||
      host.getFirstTokenFromCst(ctx.expression[0]);
    if (onToken) {
      host.validateBooleanContext(ctx.expression[0], onToken, "JOIN/ON");
    }
  }

  if (ctx.columnList) {
    host.visit(ctx.columnList[0]);
  }

  const isCrossJoin = Boolean(ctx.Cross);
  const isNaturalJoin = Boolean(ctx.Natural);
  const hasOnOrUsing = Boolean(ctx.expression?.length || ctx.columnList?.length);

  if (!isCrossJoin && !isNaturalJoin && !hasOnOrUsing) {
    const token =
      (ctx.Join?.[0] as unknown as IToken | undefined) ||
      (ctx.tableSource?.[0]
        ? host.getFirstTokenFromCst(ctx.tableSource[0])
        : undefined);
    if (token) {
      host.addError(
        "JOIN requires ON or USING clause",
        token,
        "error",
        "SQL027",
      );
    }
  }

  if (isCrossJoin && hasOnOrUsing) {
    const token = ctx.Cross[0] as unknown as IToken;
    host.addError(
      "CROSS JOIN should not have ON/USING clause",
      token,
      "warning",
      "SQL002",
    );
  }
}

export function selectClause(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): ColumnInfo[] {
  return ctx.selectList ? host.visitAs<ColumnInfo[]>(ctx.selectList[0]) : [];
}

export function selectList(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): ColumnInfo[] {
  const columns: ColumnInfo[] = [];

  const savedInSelectList = host.getInSelectList();
  const savedAliasesSoFar = host.getSelectListAliasesSoFar();
  host.setInSelectList(true);
  host.setSelectListAliasesSoFar(new Set());

  if (ctx.selectItem) {
    ctx.selectItem.forEach((item: CstNode) => {
      columns.push(...host.visitAs<ColumnInfo[]>(item));
    });
  }

  host.setInSelectList(savedInSelectList);
  host.setSelectListAliasesSoFar(savedAliasesSoFar);

  return columns;
}

export function selectItem(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): ColumnInfo[] {
  if (ctx.starExpression) {
    return host.visitAs<ColumnInfo[]>(ctx.starExpression[0]);
  }

  if (!ctx.expression) return [];

  host.visit(ctx.expression[0]);

  const alias = ctx.aliasOptional
    ? host.visitAs<string | undefined>(ctx.aliasOptional[0])
    : undefined;
  const inferred = alias ?? inferSelectItemName(host, ctx.expression[0]);

  if (inferred) {
    host.getSelectListAliasesSoFar().add(inferred.toUpperCase());
  }

  let dataType: string | undefined;
  if (inferred && !alias) {
    dataType = resolveSelectItemDataType(host, ctx.expression[0], inferred);
  }

  return inferred ? [{ name: inferred, ...(dataType ? { dataType } : {}) }] : [];
}

export function starExpression(
  host: SqlVisitorHost,
  ctx: Record<string, IToken[]>,
): ColumnInfo[] {
  const qualifier = ctx.Identifier?.[0]?.image;

  if (qualifier) {
    const table = host.getScopeBuilder().findTable(qualifier);
    if (!table) {
      host.addError(
        `Table or alias '${qualifier}' not found in scope`,
        ctx.Identifier[0],
        "error",
        "SQL003",
      );
      return [];
    }
    return table.columns.map((col) => ({ ...col }));
  }

  const columns: ColumnInfo[] = [];
  host.getScopeBuilder().getAllVisibleTables().forEach((table) => {
    columns.push(...table.columns.map((col) => ({ ...col })));
  });
  return columns;
}

export function withAnyStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): ColumnInfo[] {
  const scopeBuilder = host.getScopeBuilder();
  scopeBuilder.enterScope();

  if (ctx.cteDefinition) {
    ctx.cteDefinition.forEach((cte: CstNode) => {
      host.visit(cte);
    });
  }

  let outputColumns: ColumnInfo[] = [];
  if (ctx.selectStatement) {
    outputColumns = host.visitAs<ColumnInfo[]>(ctx.selectStatement[0]);
  } else if (ctx.insertStatement) {
    host.visit(ctx.insertStatement[0]);
  } else if (ctx.updateStatement) {
    host.visit(ctx.updateStatement[0]);
  } else if (ctx.deleteStatement) {
    host.visit(ctx.deleteStatement[0]);
  }

  scopeBuilder.exitScope();
  return outputColumns;
}

export function withStatement(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): ColumnInfo[] {
  const scopeBuilder = host.getScopeBuilder();
  scopeBuilder.enterScope();

  if (ctx.cteDefinition) {
    ctx.cteDefinition.forEach((cte: CstNode) => {
      host.visit(cte);
    });
  }

  const outputColumns = ctx.selectStatement
    ? host.visitAs<ColumnInfo[]>(ctx.selectStatement[0])
    : [];

  scopeBuilder.exitScope();

  return outputColumns;
}

export function cteDefinition(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const cteToken = ctx.Identifier?.[0] as unknown as IToken | undefined;
  if (!cteToken) return;

  const cteName = host.getTokenText(cteToken);

  const selectNode = ctx.selectStatement?.[0];
  const simpleStarSource = selectNode
    ? inferSimpleStarSubquerySourceTable(host, selectNode)
    : undefined;

  const baseColumns = ctx.withStatement
    ? host.visitAs<ColumnInfo[]>(ctx.withStatement[0])
    : selectNode
      ? host.visitAs<ColumnInfo[]>(selectNode)
      : [];
  const explicitColumnNames = ctx.cteColumnList
    ? host.visitAs<string[]>(ctx.cteColumnList[0])
    : [];

  let columns =
    baseColumns.length > 0 ? baseColumns : (simpleStarSource?.columns ?? []);

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

  const colNames = columns.map((c) => c.name.toUpperCase());
  const dupes = colNames.filter((n, i) => colNames.indexOf(n) !== i);
  if (dupes.length > 0) {
    host.addError(
      `Duplicate column name '${dupes[0]}' in CTE '${cteName}'`,
      cteToken,
      "error",
      "SQL023",
    );
  }

  host.getScopeBuilder().addCte({
    name: cteName,
    isCte: true,
    isTempTable: false,
    columns,
    recursive: false,
  });
}

export function cteColumnList(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): string[] {
  if (!ctx.identifier) return [];
  return ctx.identifier.map((node) => host.visitAs<string>(node));
}

export function viewColumnAliasList(
  host: SqlVisitorHost,
  ctx: Record<string, CstNode[]>,
): string[] {
  if (!ctx.identifier) return [];
  return ctx.identifier.map((node) => host.visitAs<string>(node));
}

function detectMissingFromClause(
  host: SqlVisitorHost,
  selectClauseNode: CstNode,
): void {
  const selectListNode = selectClauseNode.children?.selectList?.[0] as
    | CstNode
    | undefined;
  if (!selectListNode) return;

  const selectItemNodes = selectListNode.children?.selectItem as
    | CstNode[]
    | undefined;
  if (!selectItemNodes) return;

  for (const selectItem of selectItemNodes) {
    const aliasOptionalNode = selectItem.children?.aliasOptional?.[0] as
      | CstNode
      | undefined;
    if (!aliasOptionalNode) continue;

    const hasAsKeyword = !!aliasOptionalNode.children?.As?.[0];
    if (hasAsKeyword) continue;

    const aliasNode = aliasOptionalNode.children?.alias?.[0] as
      | CstNode
      | undefined;
    if (!aliasNode) continue;

    const aliasToken = host.getFirstTokenFromCst(aliasNode);
    if (!aliasToken) continue;

    const skipKeywords = new Set(["DUAL", "SYS", "USER", "TABLE"]);
    if (skipKeywords.has(aliasToken.image.toUpperCase())) continue;

    host.addError(
      `Possible missing FROM clause. '${aliasToken.image}' is used as an alias but no FROM clause is present. Did you mean 'SELECT ... FROM ${aliasToken.image}'?`,
      aliasToken,
      "error",
      "SQL016",
    );
    break;
  }
}

function getInvalidUnquotedKeywordTableIdentifier(
  host: SqlVisitorHost,
  tableNameNode: CstNode,
): IToken | undefined {
  const qualifiedNameNode = (
    tableNameNode.children?.qualifiedName as CstNode[] | undefined
  )?.[0];
  if (!qualifiedNameNode) return undefined;

  const identifierNodes =
    (qualifiedNameNode.children?.identifier as CstNode[] | undefined) ?? [];
  const relationIdentifierNode = identifierNodes[identifierNodes.length - 1];
  if (!relationIdentifierNode) return undefined;

  const token = host.getFirstTokenFromCst(relationIdentifierNode);
  if (!token) return undefined;

  const tokenTypeName = (token.tokenType as { name?: string } | undefined)
    ?.name;
  if (tokenTypeName && RESERVED_UNQUOTED_TABLE_NAME_TOKENS.has(tokenTypeName)) {
    return token;
  }

  return undefined;
}

function inferSelectItemName(
  host: SqlVisitorHost,
  expressionNode: CstNode,
): string | undefined {
  const colRef = host.findDescendantCstNode(expressionNode, "columnReference");
  if (!colRef) return undefined;

  const allTokens = getOrderedReferenceTokens(colRef.children);
  const last = allTokens[allTokens.length - 1];
  return last?.image?.replace(/"/g, "");
}

function inferSimpleStarSubquerySourceTable(
  host: SqlVisitorHost,
  selectNode: CstNode,
): TableInfo | undefined {
  const selectClause = selectNode.children.selectClause?.[0];
  if (!host.isCstNode(selectClause)) {
    return undefined;
  }

  const selectList = selectClause.children.selectList?.[0];
  if (!host.isCstNode(selectList)) {
    return undefined;
  }

  const selectItems =
    (selectList.children.selectItem as unknown as CstNode[] | undefined) ?? [];
  if (selectItems.length !== 1) {
    return undefined;
  }

  const selectItem = selectItems[0];
  if (!host.isCstNode(selectItem)) {
    return undefined;
  }

  const starExpressionNode = selectItem.children.starExpression?.[0];
  if (!host.isCstNode(starExpressionNode)) {
    return undefined;
  }

  const fromClauseNode = selectNode.children.fromClause?.[0];
  if (!host.isCstNode(fromClauseNode)) {
    return undefined;
  }

  const tableRefs =
    (fromClauseNode.children.tableReference as unknown as
      | CstNode[]
      | undefined) ?? [];
  if (tableRefs.length !== 1) {
    return undefined;
  }

  const tableRef = tableRefs[0];
  if (!host.isCstNode(tableRef)) {
    return undefined;
  }

  const joinClauses =
    (tableRef.children.joinClause as unknown as CstNode[] | undefined) ?? [];
  if (joinClauses.length > 0) {
    return undefined;
  }

  const tableSourceNode = tableRef.children.tableSource?.[0];
  if (!host.isCstNode(tableSourceNode)) {
    return undefined;
  }

  const tableNameNode = tableSourceNode.children.tableName?.[0];
  if (!host.isCstNode(tableNameNode)) {
    return undefined;
  }

  const table = host.visitAs<TableInfo>(tableNameNode);
  const starQualifierToken = starExpressionNode.children.Identifier?.[0] as
    | IToken
    | undefined;
  if (starQualifierToken) {
    const expectedQualifier = host.getTokenText(starQualifierToken).toUpperCase();
    const sourceAliasNode = tableSourceNode.children.aliasOptional?.[0];
    const sourceAlias = host.isCstNode(sourceAliasNode)
      ? host.visitAs<string | undefined>(sourceAliasNode)
      : undefined;
    const sourceQualifier = (sourceAlias || table.name).toUpperCase();
    if (expectedQualifier !== sourceQualifier) {
      return undefined;
    }
  }

  return table;
}

function resolveSelectItemDataType(
  host: SqlVisitorHost,
  expressionNode: CstNode,
  columnName: string,
): string | undefined {
  const colRef = host.findDescendantCstNode(expressionNode, "columnReference");
  if (!colRef) {
    return undefined;
  }
  const tokens = getOrderedReferenceTokens(colRef.children ?? {});
  const qualifier =
    tokens.length === 2
      ? host.getTokenText(tokens[0]).replace(/"/g, "")
      : undefined;
  const upperName = columnName.toUpperCase();
  if (qualifier) {
    const table = host.getScopeBuilder().findTable(qualifier);
    if (table) {
      for (const col of table.columns) {
        if (col.name.toUpperCase() === upperName && col.dataType) {
          return col.dataType;
        }
      }
    }
  } else {
    const tables = host.getScopeBuilder().getCurrentScopeTables();
    for (const table of tables) {
      for (const col of table.columns) {
        if (col.name.toUpperCase() === upperName && col.dataType) {
          return col.dataType;
        }
      }
    }
  }
  return undefined;
}

function getSelectItemNodes(selectClause: CstNode): CstNode[] {
  const selectList = selectClause.children?.selectList?.[0] as
    | CstNode
    | undefined;
  return (selectList?.children?.selectItem as CstNode[] | undefined) ?? [];
}

function buildGroupBySignatureSet(
  host: SqlVisitorHost,
  selectClause: CstNode,
  groupByClause: CstNode,
): Set<string> {
  const groupExprs = getGroupByExpressionNodes(groupByClause);
  const groupSignatures = new Set(
    groupExprs.map((expr) => normalizeExpressionSignature(host, expr)),
  );
  const selectItems = getSelectItemNodes(selectClause);

  for (const expr of groupExprs) {
    const ordinal = extractGroupByOrdinal(host, expr);
    if (ordinal === undefined || ordinal < 1 || ordinal > selectItems.length) {
      continue;
    }

    const item = selectItems[ordinal - 1];
    const itemExpr = item.children?.expression?.[0] as CstNode | undefined;
    if (itemExpr) {
      groupSignatures.add(normalizeExpressionSignature(host, itemExpr));
    }
  }

  return groupSignatures;
}

function buildSimpleGroupByColumnSignatureSet(
  host: SqlVisitorHost,
  selectClause: CstNode,
  groupByClause: CstNode,
): Set<string> {
  const groupExprs = getGroupByExpressionNodes(groupByClause);
  const selectItems = getSelectItemNodes(selectClause);
  const columnSignatures = new Set<string>();

  const addExpressionIfSimpleColumn = (expr: CstNode): void => {
    if (!isSimpleColumnReferenceExpression(host, expr)) {
      return;
    }
    for (const signatures of collectColumnReferenceSignatureGroups(host, expr)) {
      for (const signature of signatures) {
        columnSignatures.add(signature);
      }
    }
  };

  for (const expr of groupExprs) {
    addExpressionIfSimpleColumn(expr);

    const ordinal = extractGroupByOrdinal(host, expr);
    if (ordinal === undefined || ordinal < 1 || ordinal > selectItems.length) {
      continue;
    }

    const item = selectItems[ordinal - 1];
    const itemExpr = item.children?.expression?.[0] as CstNode | undefined;
    if (itemExpr) {
      addExpressionIfSimpleColumn(itemExpr);
    }
  }

  return columnSignatures;
}

function extractGroupByOrdinal(
  host: SqlVisitorHost,
  expr: CstNode,
): number | undefined {
  const signature = normalizeExpressionSignature(host, expr);
  if (!/^\d+$/.test(signature)) {
    return undefined;
  }
  const value = Number.parseInt(signature, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function getGroupByExpressionNodes(groupByClause: CstNode): CstNode[] {
  const direct =
    (groupByClause.children?.expression as CstNode[] | undefined) ?? [];
  if (direct.length > 0) {
    return direct;
  }

  const expressions: CstNode[] = [];
  const elements =
    (groupByClause.children?.groupByElement as CstNode[] | undefined) ?? [];
  for (const element of elements) {
    const expr = element.children?.expression?.[0] as CstNode | undefined;
    if (expr) {
      expressions.push(expr);
    }
  }
  return expressions;
}

function getOrderByExpressionNodes(orderByClause: CstNode): CstNode[] {
  const items =
    (orderByClause.children?.orderByItem as CstNode[] | undefined) ?? [];
  const expressions: CstNode[] = [];
  for (const item of items) {
    const expr = item.children?.expression?.[0] as CstNode | undefined;
    if (expr) {
      expressions.push(expr);
    }
  }
  return expressions;
}

function normalizeExpressionSignature(
  host: SqlVisitorHost,
  node: CstNode,
): string {
  return stripSurroundingQuotes(
    host.getCstText(node).replace(/\s+/g, " ").trim().toUpperCase(),
  );
}

function stripParenthesizedExpressionSignature(signature: string): string {
  let current = signature;
  while (current.startsWith("( ") && current.endsWith(" )")) {
    current = current.slice(2, -2).trim();
  }
  return current;
}

function stripSurroundingQuotes(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function isExpressionPureLiteral(host: SqlVisitorHost, expr: CstNode): boolean {
  if (!host.findDescendantCstNode(expr, "literal")) return false;
  if (host.findDescendantCstNode(expr, "columnReference")) return false;
  if (host.findDescendantCstNode(expr, "functionCall")) return false;
  if (host.findDescendantCstNode(expr, "castFunctionExpression")) return false;
  if (host.findDescendantCstNode(expr, "caseExpression")) return false;
  if (host.findDescendantCstNode(expr, "existsExpression")) return false;
  if (host.findDescendantCstNode(expr, "extractExpression")) return false;
  if (host.findDescendantCstNode(expr, "subquery")) return false;
  return true;
}

function collectColumnReferenceSignatureGroups(
  host: SqlVisitorHost,
  node: CstNode,
): string[][] {
  const references: string[][] = [];
  const walk = (current: CstNode): void => {
    if (current.name === "columnReference") {
      references.push([normalizeExpressionSignature(host, current)]);
      return;
    }

    for (const childNodes of Object.values(current.children ?? {})) {
      for (const child of childNodes) {
        if (host.isCstNode(child)) {
          walk(child);
        }
      }
    }
  };

  walk(node);
  return references;
}

function isSimpleColumnReferenceExpression(
  host: SqlVisitorHost,
  expr: CstNode,
): boolean {
  const references = collectColumnReferenceSignatureGroups(host, expr);
  if (references.length !== 1) {
    return false;
  }

  const signature = stripParenthesizedExpressionSignature(
    normalizeExpressionSignature(host, expr),
  );
  return references[0].includes(signature);
}

function expressionReferencesOnlyGroupedColumns(
  host: SqlVisitorHost,
  expr: CstNode,
  groupColumnSignatures: Set<string>,
  groupSafeAliases: Set<string> = new Set(),
): boolean {
  if (host.findDescendantCstNode(expr, "subquery")) return false;
  if (host.findDescendantCstNode(expr, "existsExpression")) return false;

  const references = collectColumnReferenceSignatureGroups(host, expr);
  if (references.length === 0) {
    return false;
  }

  return references.every((signatures) =>
    signatures.some(
      (signature) =>
        groupColumnSignatures.has(signature) ||
        groupSafeAliases.has(signature),
    ),
  );
}

function isExpressionDeterministic(
  host: SqlVisitorHost,
  expr: CstNode,
): boolean {
  if (isExpressionPureLiteral(host, expr)) return true;

  if (host.findDescendantCstNode(expr, "subquery")) return false;
  if (host.findDescendantCstNode(expr, "existsExpression")) return false;
  if (nodeContainsGroupingAggregate(host, expr)) return false;

  if (!allColumnRefsAreSessionConstants(host, expr)) return false;

  if (host.findDescendantCstNode(expr, "literal")) return true;

  const colRef = host.findDescendantCstNode(expr, "columnReference");
  if (colRef) {
    const token = host.getFirstTokenFromCst(colRef);
    if (token) {
      const text = token.image.toUpperCase();
      return host.getValidationProfile().specialBuiltinValues.has(text);
    }
  }

  return false;
}

function allColumnRefsAreSessionConstants(
  host: SqlVisitorHost,
  node: CstNode,
): boolean {
  if (node.name === "columnReference") {
    const token = host.getFirstTokenFromCst(node);
    if (!token) return false;
    const text = token.image.toUpperCase();
    return host.getValidationProfile().specialBuiltinValues.has(text);
  }

  for (const childNodes of Object.values(node.children ?? {})) {
    for (const child of childNodes) {
      if (host.isCstNode(child)) {
        if (!allColumnRefsAreSessionConstants(host, child)) {
          return false;
        }
      }
    }
  }

  return true;
}

function expressionIsSubqueryExpression(
  host: SqlVisitorHost,
  expr: CstNode,
): boolean {
  if (expr.name === "subquery" || expr.children?.selectStatement) {
    return true;
  }
  if (expr.name === "parenthesizedExpression" && expr.children?.expression?.[0]) {
    return expressionIsSubqueryExpression(
      host,
      expr.children.expression[0] as CstNode,
    );
  }
  for (const childNodes of Object.values(expr.children ?? {})) {
    for (const child of childNodes) {
      if (
        host.isCstNode(child) &&
        expressionIsSubqueryExpression(host, child)
      ) {
        return true;
      }
    }
  }
  return false;
}

function nodeContainsRule(
  host: SqlVisitorHost,
  node: CstNode,
  ruleName: string,
): boolean {
  if (node.name === ruleName) {
    return true;
  }
  for (const childNodes of Object.values(node.children ?? {})) {
    for (const child of childNodes) {
      if (host.isCstNode(child) && nodeContainsRule(host, child, ruleName)) {
        return true;
      }
    }
  }
  return false;
}

function groupByContainsGroupingExtension(
  host: SqlVisitorHost,
  groupByClause: CstNode,
): boolean {
  if (nodeContainsRule(host, groupByClause, "groupingSetsExpression")) {
    return true;
  }
  const normalizedGroupBy = host.getCstText(groupByClause).toUpperCase();
  if (
    /\bROLLUP\s*\(/.test(normalizedGroupBy) ||
    /\bCUBE\s*\(/.test(normalizedGroupBy)
  ) {
    return true;
  }

  const stack: CstNode[] = [groupByClause];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.name === "functionCall") {
      const fnToken =
        (node.children?.Identifier?.[0] as unknown as IToken | undefined) ??
        (node.children?.Replace?.[0] as unknown as IToken | undefined);
      const fnName = fnToken ? host.getTokenText(fnToken).toUpperCase() : "";
      if (fnName === "ROLLUP" || fnName === "CUBE") {
        return true;
      }
    }
    for (const childNodes of Object.values(node.children ?? {})) {
      for (const child of childNodes) {
        if (host.isCstNode(child)) {
          stack.push(child);
        }
      }
    }
  }

  return false;
}

function nodeContainsGroupingAggregate(
  host: SqlVisitorHost,
  node: CstNode,
): boolean {
  if (node.name === "functionCall") {
    if (node.children?.overClause) {
      return false;
    }
    const fnToken =
      (node.children?.Identifier?.[0] as unknown as IToken | undefined) ??
      (node.children?.Replace?.[0] as unknown as IToken | undefined);
    if (fnToken) {
      const fnName = host.getTokenText(fnToken).toUpperCase();
      if (GROUPING_AGGREGATE_FUNCTIONS.has(fnName)) {
        return true;
      }
    }
  }
  for (const childNodes of Object.values(node.children ?? {})) {
    for (const child of childNodes) {
      if (
        host.isCstNode(child) &&
        nodeContainsGroupingAggregate(host, child)
      ) {
        return true;
      }
    }
  }
  return false;
}

function nodeContainsWindowFunction(
  host: SqlVisitorHost,
  node: CstNode,
): boolean {
  if (node.name === "functionCall" && node.children?.overClause) {
    return true;
  }
  for (const childNodes of Object.values(node.children ?? {})) {
    for (const child of childNodes) {
      if (host.isCstNode(child) && nodeContainsWindowFunction(host, child)) {
        return true;
      }
    }
  }
  return false;
}

function selectItemHasWindowFunction(
  host: SqlVisitorHost,
  item: CstNode,
): boolean {
  const expr = item.children?.expression?.[0] as CstNode | undefined;
  if (!expr) {
    return false;
  }
  return nodeContainsWindowFunction(host, expr);
}

function nodeContainsAggregate(host: SqlVisitorHost, node: CstNode): boolean {
  if (node.name === "functionCall") {
    const fnToken =
      (node.children?.Identifier?.[0] as unknown as IToken | undefined) ??
      (node.children?.Replace?.[0] as unknown as IToken | undefined);
    if (fnToken) {
      const fnName = host.getTokenText(fnToken).toUpperCase();
      if (AGGREGATE_FUNCTIONS.has(fnName)) {
        return true;
      }
    }
  }
  for (const childNodes of Object.values(node.children ?? {})) {
    for (const child of childNodes) {
      if (host.isCstNode(child) && nodeContainsAggregate(host, child)) {
        return true;
      }
    }
  }
  return false;
}

function selectItemHasTopLevelAggregate(
  host: SqlVisitorHost,
  item: CstNode,
): boolean {
  const expr = item.children?.expression?.[0] as CstNode | undefined;
  if (!expr) {
    return false;
  }
  if (expressionIsSubqueryExpression(host, expr)) {
    return false;
  }
  return nodeContainsGroupingAggregate(host, expr);
}

function selectContainsAggregates(
  host: SqlVisitorHost,
  selectClause: CstNode,
): boolean {
  return getSelectItemNodes(selectClause).some((item) =>
    selectItemHasTopLevelAggregate(host, item),
  );
}

function validateGroupBySelectAlignment(
  host: SqlVisitorHost,
  selectClause: CstNode,
  groupByClause: CstNode,
): void {
  const groupSignatures = buildGroupBySignatureSet(
    host,
    selectClause,
    groupByClause,
  );
  const groupColumnSignatures = buildSimpleGroupByColumnSignatureSet(
    host,
    selectClause,
    groupByClause,
  );
  const groupSafeAliases = new Set<string>();

  for (const item of getSelectItemNodes(selectClause)) {
    if (item.children?.starExpression) {
      continue;
    }
    const expr = item.children?.expression?.[0] as CstNode | undefined;
    if (!expr) {
      continue;
    }

    const aliasNode = item.children?.aliasOptional?.[0] as CstNode | undefined;
    const alias = aliasNode
      ? host.visitAs<string | undefined>(aliasNode)
      : undefined;
    const signature = normalizeExpressionSignature(host, expr);
    const aliasUpper = alias?.toUpperCase();

    let isGroupSafe = false;
    if (selectItemHasTopLevelAggregate(host, item)) {
      isGroupSafe = true;
    } else if (selectItemHasWindowFunction(host, item)) {
      isGroupSafe = true;
    } else if (isExpressionDeterministic(host, expr)) {
      isGroupSafe = true;
    } else if (
      groupSignatures.has(signature) ||
      (aliasUpper && groupSignatures.has(aliasUpper))
    ) {
      isGroupSafe = true;
    } else if (
      expressionReferencesOnlyGroupedColumns(
        host,
        expr,
        groupColumnSignatures,
        groupSafeAliases,
      )
    ) {
      isGroupSafe = true;
    }

    if (isGroupSafe) {
      if (aliasUpper) {
        groupSafeAliases.add(aliasUpper);
      }
      continue;
    }

    const token = host.getFirstTokenFromCst(expr);
    if (token) {
      host.addError(
        `Possibly non-aggregated SELECT item should appear in GROUP BY clause`,
        token,
        "information",
        "SQL028",
      );
    }
  }
}

function validateSelectAggregatesWithoutGroupBy(
  host: SqlVisitorHost,
  selectClause: CstNode,
): void {
  for (const item of getSelectItemNodes(selectClause)) {
    if (item.children?.starExpression) {
      continue;
    }
    if (selectItemHasTopLevelAggregate(host, item)) {
      continue;
    }
    if (selectItemHasWindowFunction(host, item)) {
      continue;
    }
    const expr = item.children?.expression?.[0] as CstNode | undefined;
    if (!expr) {
      continue;
    }
    if (isExpressionDeterministic(host, expr)) {
      continue;
    }
    const token = host.getFirstTokenFromCst(expr);
    if (token) {
      host.addError(
        `Possibly non-aggregated SELECT item should be aggregated or included in GROUP BY when aggregate functions are present`,
        token,
        "information",
        "SQL028",
      );
    }
  }
}

function validateOrderByInGroupedQuery(
  host: SqlVisitorHost,
  selectClause: CstNode,
  groupByClause: CstNode,
  orderByClause: CstNode,
): void {
  const groupSignatures = buildGroupBySignatureSet(
    host,
    selectClause,
    groupByClause,
  );
  const outputAliases = host.getCurrentSelectOutputAliases() ?? new Set<string>();

  for (const expr of getOrderByExpressionNodes(orderByClause)) {
    if (nodeContainsAggregate(host, expr)) {
      continue;
    }
    const signature = normalizeExpressionSignature(host, expr);
    if (groupSignatures.has(signature)) {
      continue;
    }
    if (outputAliases.has(signature)) {
      continue;
    }
    const token = host.getFirstTokenFromCst(expr);
    if (token) {
      host.addError(
        `ORDER BY expression must appear in GROUP BY clause for grouped queries`,
        token,
        "warning",
        "SQL030",
      );
    }
  }
}
