export { SqlValidator, sqlValidator } from "./validator";
export {
  DocumentParseSession,
  resolveSqlRenameSymbolWithSession,
  type DocumentParseRequest,
} from "./documentParseSession";
export { DocumentValidationSession } from "./documentValidationSession";
export {
  buildStatementIndex,
  diffStatementIndexes,
  type StatementBoundary,
  type StatementIndex,
  type StatementIndexDiff,
} from "./statementIndex";
export {
  expandDirtyIndicesForScriptContext,
  isScriptScopeAffectingStatement,
  SCRIPT_SCOPE_CREATE_STATEMENT_PATTERN,
  SCRIPT_SCOPE_DROP_STATEMENT_PATTERN,
} from "./scriptScopeStatements";
export { SqlLexer } from "./lexer";
export { sqlParser, getSqlParserInstance } from "./parser";
export { BaseSqlParser } from "./BaseSqlParser";
export {
  BASE_SQL_PARSING_RUNTIME,
  NETEZZA_SQL_PARSING_RUNTIME,
  ORACLE_SQL_PARSING_RUNTIME,
  parseSqlStatements,
  resolveSqlParsingRuntime,
  runWithSqlParserSession,
  registerSqlParsingRuntime,
  clearActiveParserSessions,
} from "./parsingRuntime";
export type {
  SqlParserSession,
  SqlStatementsParseResult,
} from "./parsingRuntime";
export { SqlVisitor } from "./visitor/sqlVisitor";
export { ScopeBuilder } from "./visitor/scopeBuilder";
export { formatSqlRenameReplacement } from "./renameFormatting";
export {
  resolveSqlRenameSymbol,
  collectSqlSymbolUsages,
  collectSqlSymbolUsagesFromCst,
} from "./symbols";
export { analyzeSqlScriptFlow } from "./flowAnalyzer";
export {
  analyzeSqlQueryStructures,
  statementSupportsQueryFlow,
  rangeContainsOffsets,
  rangesIntersect,
} from "./queryStructureAnalyzer";
export {
  buildCteToTempTableTransform,
  buildCreateTempTableStatement,
} from "./cteToTempTableTransformer";
export type {
  SqlRenameResolution,
  SqlRenameOccurrence,
  SqlRenameSymbolKind,
  SqlSymbolUsage,
} from "./symbols";
export type {
  SqlScriptFlowAnalysis,
  SqlLineageEdge,
  SqlUnusedSymbolInfo,
  SqlRefactorCandidate,
  SqlLineageAction,
} from "./flowAnalyzer";
export type {
  SqlStatementKind,
  SqlTextRange,
  ExtractSubqueryCandidate,
  CteMaterializationCandidate,
  CteBulkMaterializationCandidate,
  TempTableInlineCandidate,
  QueryFlowNode,
  QueryFlowEdge,
  QueryFlowGraph,
  SqlQueryStructureAnalysis,
} from "./queryStructureAnalyzer";
export type {
  TempTableMaterializationKind,
  CteToTempTableTransformPlan,
} from "./cteToTempTableTransformer";
export type {
  TokenPosition,
  ValidationError,
  ColumnInfo,
  TableInfo,
  CteInfo,
  Scope,
  ParsedStatement,
  ValidationResult,
} from "./types";
