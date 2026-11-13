/**
 * Public, platform-neutral Netezza validation entrypoint.
 *
 * The structural model lives in `validation/types.ts` and
 * `validation/schemaProvider.ts`; this file only composes and re-exports the
 * native parser and semantic validator APIs.
 */
export {
  NetezzaSqlSemanticValidator,
  netezzaSqlSemanticValidator,
  type NetezzaSqlSemanticValidationResult,
  type ScopeSeed,
  type StatementBoundary,
} from "./validation/semanticValidator";
export { NETEZZA_SQL_VALIDATION_PROFILE } from "./validation/netezzaProfile";
export {
  createSqlLineIndex,
  type SqlLineIndex,
} from "./validation/lineIndex";
export { GROUPING_AGGREGATE_FUNCTIONS } from "./validation/aggregateFunctions";
export { detectNetezzaSyntaxRestrictions, detectNetezzaSyntaxRestrictionWarnings } from "./validation/netezzaSyntaxRestrictions";
export { mayContainUnusedSymbolDefinitions } from "./validation/symbols";
export {
  CLAUSE_KEYWORDS,
  COMMON_KEYWORD_TYPOS,
  SQL_KEYWORD_SET,
  SQL_TYPO_KEYWORDS,
  collectKeywordTypos,
  isSingleEditAway,
  type KeywordTypoOptions,
} from "./validation/keywordTypos";
export type {
  ColumnInfo,
  CteInfo,
  Scope,
  ValidationResult,
  TableInfo,
  TokenPosition,
  ValidationError,
} from "./validation/types";
export type {
  QualificationProposal,
  SchemaProvider,
  TableQualificationRequest,
} from "./validation/schemaProvider";
export {
  NETEZZA_SQL_PARSING_RUNTIME,
  parseNetezzaSqlStatements,
  sanitizeNetezzaSql,
  type NetezzaSqlLexResult,
  type MacroReferenceRange,
  type NetezzaSqlParseOptions,
  type NetezzaSqlParseResult,
  type NetezzaSqlParsingRuntime,
} from "./parser/runtime";

/** Compatibility aliases for consumers that used the first native API names. */
export type {
  ColumnInfo as NetezzaSqlColumnInfo,
  Scope as NetezzaSqlScope,
  TableInfo as NetezzaSqlTableInfo,
  TokenPosition as NetezzaSqlTokenPosition,
  ValidationResult as NetezzaSqlValidationResult,
  ValidationError as NetezzaSqlValidationError,
} from "./validation/types";
export type { SchemaProvider as NetezzaSqlSchemaProvider } from "./validation/schemaProvider";
