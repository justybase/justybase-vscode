import type { DatabaseSqlAuthoring } from '../../../sql/authoring/types';
import { DUCKDB_BUILTIN_FUNCTIONS, DUCKDB_SPECIAL_BUILTIN_VALUES, DUCKDB_SYSTEM_COLUMNS } from './builtins';
import { getDuckDbTypeSpec, supportsDuckDbProcedureAnySizeArgument } from './dataTypes';
import { DUCKDB_COMPLETION_KEYWORDS, duckdbFormatterProfile } from './keywords';
import { DUCKDB_FUNCTION_SIGNATURES } from './signatures';
import { duckdbSqlQualityRules } from '../../../../extensions/duckdb/src/sql/qualityRules';

export const duckdbSqlAuthoring: DatabaseSqlAuthoring = {
  completionKeywords: DUCKDB_COMPLETION_KEYWORDS,
  signatures: DUCKDB_FUNCTION_SIGNATURES,
  formatter: duckdbFormatterProfile,
  validation: {
    databaseKind: 'duckdb',
    builtinFunctions: DUCKDB_BUILTIN_FUNCTIONS,
    systemColumns: DUCKDB_SYSTEM_COLUMNS,
    specialBuiltinValues: DUCKDB_SPECIAL_BUILTIN_VALUES,
    getTypeSpec: getDuckDbTypeSpec,
    supportsProcedureAnySizeArgument: supportsDuckDbProcedureAnySizeArgument,
    syntaxValidationMode: 'strict',
  },
  qualityRules: duckdbSqlQualityRules,
  parsing: {
    lexerModulePath: 'src/dialects/duckdb/sql/lexer.ts',
    parserModulePath: 'src/dialects/duckdb/sql/parser.ts',
  },
  staticAssets: {
    snippetsPath: 'dialects/duckdb/snippets/duckdb.code-snippets',
    grammarPath: 'dialects/duckdb/syntaxes/duckdb.tmLanguage.json',
    grammarScopeName: 'duckdb.injection',
  },
};
