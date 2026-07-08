import {
    BASE_SQL_BUILTIN_FUNCTIONS,
    BASE_SQL_SPECIAL_BUILTIN_VALUES,
    mergeStringSets,
} from '../../../../src/sql/authoring/baseProfiles';

/**
 * Snowflake-specific built-in function overlays
 * These are functions unique to Snowflake, in addition to the base SQL functions
 * @see https://docs.snowflake.com/en/sql-reference-functions
 */
const SNOWFLAKE_BUILTIN_FUNCTION_OVERLAYS = new Set<string>([
    // Aggregate functions
    'ARRAY_AGG',
    'LISTAGG',
    'APPROX_COUNT_DISTINCT',
    'APPROX_TOP_K',
    'COMBINED_MATCHLIST',
    'CORR',
    'COVAR_POP',
    'COVAR_SAMP',
    'REGR_AVGX',
    'REGR_AVGY',
    'REGR_COUNT',
    'REGR_INTERCEPT',
    'REGR_R2',
    'REGR_SLOPE',
    'REGR_SXX',
    'REGR_SXY',
    'REGR_SYY',
    'STDDEV',
    'STDDEV_POP',
    'STDDEV_SAMP',
    'VARIANCE',
    'VAR_POP',
    'VAR_SAMP',

    // Conditional functions
    'COALESCE',
    'IFF',
    'IFNULL',
    'NULLIF',
    'ZEROIFNULL',

    // Conversion functions
    'TO_DATE',
    'TO_TIMESTAMP',
    'TO_NUMBER',
    'TO_VARIANT',
    'PARSE_JSON',
    'TRY_PARSE_JSON',
    'TRY_TO_DATE',
    'TRY_TO_TIMESTAMP',
    'TRY_TO_NUMBER',
    'CAST',
    'TRY_CAST',

    // Date/Time functions
    'DATEADD',
    'DATEDIFF',
    'DATE_TRUNC',
    'LAST_DAY',
    'NEXT_DAY',
    'CONVERT_TIMEZONE',

    // String functions
    'CONCAT_WS',
    'CONTAINS',
    'ENCRYPT',
    'DECRYPT',
    'REGEXP_SUBSTR_ALL',
    'SPLIT',
    'REGEXP_REPLACE',
    'REGEXP_SUBSTR',

    // Semi-structured functions
    'GET',
    'GET_PATH',
    'ARRAY_CONSTRUCT',
    'OBJECT_CONSTRUCT',
    'FLATTEN',
    'ARRAY_APPEND',
    'ARRAY_CAT',
    'ARRAY_CONTAINS',
    'ARRAY_GENERATE_RANGE',
    'ARRAY_INSERT',
    'ARRAY_PREPEND',
    'ARRAY_SIZE',
    'ARRAY_SLICE',
    'AS_ARRAY',
    'AS_OBJECT',
    'AS_VARCHAR',
    'AS_VARIANT',
    'IS_ARRAY',
    'IS_OBJECT',
    'IS_NULL_VALUE',
    'OBJECT_CONSTRUCT_KEEP_NULL',
    'OBJECT_DELETE',
    'OBJECT_INSERT',
    'OBJECT_KEYS',
    'OBJECT_PICK',

    // Table functions
    'RESULT_SCAN',
    'GENERATOR',
    'SEQ1',
    'SEQ2',
    'SEQ4',
    'SEQ8',

    // Context functions
    'CURRENT_DATABASE',
    'CURRENT_SCHEMA',
    'CURRENT_WAREHOUSE',
    'CURRENT_ROLE',
    'CURRENT_USER',
    'CURRENT_VERSION',
    'CURRENT_STATEMENT',
    'CURRENT_TRANSACTION',
    'IS_ROLE_IN_SESSION',
    'GETVARIABLE',
    'LAST_QUERY_ID',
    'LAST_TRANSACTION',

    // Utility functions
    'GROUPING',
    'GROUPING_ID',
    'LOCALTIME',
    'LOCALTIMESTAMP',
    'CURRENT_SCHEMAS',
    'CURRENT_REGION',
    'CURRENT_IP_ADDRESS',
    'CURRENT_APPLICATION_ROLE',
    'CURRENT_AVAILABLE_ROLES',
    'CURRENT_ORGANIZATION_NAME',
    'CURRENT_ACCOUNT',
    'UNIFORM',
    'NORMAL',
    'UUID_STRING',
    'HASH',
    'HASH_AGG',
    'MD5',
    'MD5_HEX',
    'SHA1',
    'SHA2',
    'ENCRYPT_RAW',
    'DECRYPT_RAW',
    'VALIDATE_UTF8',
    'TO_CHAR',
    'TO_VARCHAR',
    'TO_BINARY',
    'TO_BOOLEAN',
    'TO_DOUBLE',
    'TO_GEOGRAPHY',
    'TO_GEOMETRY',
    'TO_JSON',
    'TO_OBJECT',
    'TO_TIME',
    'TO_TIMESTAMP_LTZ',
    'TO_TIMESTAMP_NTZ',
    'TO_TIMESTAMP_TZ',
    'TO_XML',
]);

/**
 * Snowflake-specific special builtin value overlays
 */
const SNOWFLAKE_SPECIAL_BUILTIN_VALUE_OVERLAYS = new Set<string>([
    'CURRENT_VERSION',
    'CURRENT_STATEMENT',
    'CURRENT_TRANSACTION',
    'CURRENT_IP_ADDRESS',
    'CURRENT_REGION',
    'CURRENT_ACCOUNT',
    'CURRENT_ORGANIZATION_NAME',
]);

/**
 * Complete set of Snowflake built-in functions
 * Combines base SQL functions with Snowflake-specific extensions
 */
export const SNOWFLAKE_BUILTIN_FUNCTIONS = mergeStringSets(
    BASE_SQL_BUILTIN_FUNCTIONS,
    SNOWFLAKE_BUILTIN_FUNCTION_OVERLAYS,
);

/**
 * Complete set of Snowflake special builtin values
 * Combines base SQL special values with Snowflake-specific extensions
 */
export const SNOWFLAKE_SPECIAL_BUILTIN_VALUES = mergeStringSets(
    BASE_SQL_SPECIAL_BUILTIN_VALUES,
    SNOWFLAKE_SPECIAL_BUILTIN_VALUE_OVERLAYS,
);

/**
 * Snowflake system columns
 * Snowflake does not expose system pseudo-columns like Netezza's ROWID/CREATEXID
 * @see https://docs.snowflake.com/en/sql-reference/sql/show-columns
 */
export const SNOWFLAKE_SYSTEM_COLUMNS = new Set<string>([]);
