import type { DatabaseSqlAuthoring } from '../../../../src/sql/authoring/types';
import {
    SNOWFLAKE_COMPLETION_KEYWORDS,
    snowflakeFormatterProfile
} from './keywords';
import { getSnowflakeTypeSpec, supportsProcedureAnySizeArgument } from './dataTypes';
import {
    SNOWFLAKE_BUILTIN_FUNCTIONS,
    SNOWFLAKE_SPECIAL_BUILTIN_VALUES,
    SNOWFLAKE_SYSTEM_COLUMNS
} from './builtins';
import { SNOWFLAKE_FUNCTION_SIGNATURES } from './signatures';

/**
 * Snowflake SQL Authoring Profile
 *
 * Provides Snowflake-specific SQL authoring capabilities including:
 * - Snowflake SQL completion keywords
 * - Snowflake data type specifications
 * - Snowflake formatter profile
 * - Snowflake built-in functions validation
 *
 * @see https://docs.snowflake.com/en/sql-reference
 */
export const snowflakeSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: SNOWFLAKE_COMPLETION_KEYWORDS,
    signatures: SNOWFLAKE_FUNCTION_SIGNATURES,
    formatter: snowflakeFormatterProfile,
    validation: {
        builtinFunctions: SNOWFLAKE_BUILTIN_FUNCTIONS,
        systemColumns: SNOWFLAKE_SYSTEM_COLUMNS,
        specialBuiltinValues: SNOWFLAKE_SPECIAL_BUILTIN_VALUES,
        getTypeSpec: getSnowflakeTypeSpec,
        supportsProcedureAnySizeArgument,
        syntaxValidationMode: 'bestEffort'
    },
    qualityRules: [] // Empty for now - will be populated in Phase 5
};
