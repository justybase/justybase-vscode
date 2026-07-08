import { BASE_SQL_FUNCTION_SIGNATURES, mergeFunctionSignatures } from '../../../../src/sql/authoring/baseProfiles';
import type { DatabaseSqlFunctionSignature } from '../../../../src/sql/authoring/types';

/**
 * Snowflake-specific function signature overlays
 * These extend or override the base SQL function signatures
 * @see https://docs.snowflake.com/en/sql-reference-functions
 */
const SNOWFLAKE_FUNCTION_SIGNATURE_OVERLAYS: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> = new Map([
    // Aggregate functions
    ['ARRAY_AGG', [{ name: 'ARRAY_AGG', parameters: ['expr'], description: 'Returns an ARRAY of non-NULL values' }]],
    [
        'LISTAGG',
        [
            {
                name: 'LISTAGG',
                parameters: ['expr', 'delimiter'],
                description: 'Aggregates values into a single string with delimiter',
            },
        ],
    ],
    [
        'APPROX_COUNT_DISTINCT',
        [
            {
                name: 'APPROX_COUNT_DISTINCT',
                parameters: ['expr'],
                description: 'Returns an approximate count of distinct values',
            },
        ],
    ],

    // Conditional functions
    [
        'IFF',
        [
            {
                name: 'IFF',
                parameters: ['condition', 'true_expr', 'false_expr'],
                description: 'Returns true_expr if condition is true, otherwise false_expr',
            },
        ],
    ],
    [
        'ZEROIFNULL',
        [
            {
                name: 'ZEROIFNULL',
                parameters: ['expr'],
                description: 'Returns 0 if expr is NULL, otherwise returns expr',
            },
        ],
    ],

    // Conversion functions
    [
        'PARSE_JSON',
        [{ name: 'PARSE_JSON', parameters: ['text_expr'], description: 'Parses a JSON string into a VARIANT value' }],
    ],
    [
        'TRY_PARSE_JSON',
        [{ name: 'TRY_PARSE_JSON', parameters: ['text_expr'], description: 'Parses JSON and returns NULL on failure' }],
    ],
    ['TO_VARIANT', [{ name: 'TO_VARIANT', parameters: ['expr'], description: 'Converts any value to VARIANT type' }]],
    [
        'TRY_TO_DATE',
        [
            {
                name: 'TRY_TO_DATE',
                parameters: ['expr', 'format'],
                description: 'Converts string to DATE, returns NULL on failure',
            },
        ],
    ],
    [
        'TRY_TO_TIMESTAMP',
        [
            {
                name: 'TRY_TO_TIMESTAMP',
                parameters: ['expr', 'format'],
                description: 'Converts string to TIMESTAMP, returns NULL on failure',
            },
        ],
    ],
    [
        'TRY_TO_NUMBER',
        [
            {
                name: 'TRY_TO_NUMBER',
                parameters: ['expr', 'format'],
                description: 'Converts string to NUMBER, returns NULL on failure',
            },
        ],
    ],

    // Date/Time functions
    [
        'DATEADD',
        [
            {
                name: 'DATEADD',
                parameters: ['date_part', 'value', 'source'],
                description: 'Adds specified value to date/time',
            },
        ],
    ],
    [
        'DATEDIFF',
        [
            {
                name: 'DATEDIFF',
                parameters: ['date_part', 'source1', 'source2'],
                description: 'Returns difference between two dates/times',
            },
        ],
    ],
    [
        'CONVERT_TIMEZONE',
        [
            {
                name: 'CONVERT_TIMEZONE',
                parameters: ['source_tz', 'target_tz', 'source_time'],
                description: 'Converts timezone of timestamp',
            },
        ],
    ],

    // Semi-structured functions
    [
        'GET',
        [
            {
                name: 'GET',
                parameters: ['variant_expr', 'index'],
                description: 'Extracts element from VARIANT array or object',
            },
        ],
    ],
    [
        'GET_PATH',
        [
            {
                name: 'GET_PATH',
                parameters: ['variant_expr', 'path'],
                description: 'Extracts value at path from VARIANT',
            },
        ],
    ],
    [
        'FLATTEN',
        [
            {
                name: 'FLATTEN',
                parameters: ['input', 'path', 'outer', 'recursive', 'mode'],
                description: 'Expands VARIANT array or object into rows',
            },
        ],
    ],
    [
        'ARRAY_CONSTRUCT',
        [{ name: 'ARRAY_CONSTRUCT', parameters: ['val1', 'val2', '...'], description: 'Constructs ARRAY from values' }],
    ],
    [
        'ARRAY_GENERATE_RANGE',
        [
            {
                name: 'ARRAY_GENERATE_RANGE',
                parameters: ['start', 'stop', 'step'],
                description: 'Generates an array over a numeric range',
            },
        ],
    ],
    [
        'OBJECT_CONSTRUCT',
        [
            {
                name: 'OBJECT_CONSTRUCT',
                parameters: ['key1', 'val1', 'key2', 'val2', '...'],
                description: 'Constructs OBJECT from key-value pairs',
            },
        ],
    ],
    [
        'OBJECT_CONSTRUCT_KEEP_NULL',
        [
            {
                name: 'OBJECT_CONSTRUCT_KEEP_NULL',
                parameters: ['key1', 'val1', 'key2', 'val2', '...'],
                description: 'Constructs OBJECT and preserves null values',
            },
        ],
    ],
    [
        'OBJECT_KEYS',
        [{ name: 'OBJECT_KEYS', parameters: ['variant_expr'], description: 'Returns array of keys in OBJECT' }],
    ],
    [
        'ARRAY_SIZE',
        [{ name: 'ARRAY_SIZE', parameters: ['array_expr'], description: 'Returns number of elements in ARRAY' }],
    ],
    [
        'IS_ARRAY',
        [
            {
                name: 'IS_ARRAY',
                parameters: ['variant_expr'],
                description: 'Returns true if the VARIANT contains an array',
            },
        ],
    ],
    [
        'IS_OBJECT',
        [
            {
                name: 'IS_OBJECT',
                parameters: ['variant_expr'],
                description: 'Returns true if the VARIANT contains an object',
            },
        ],
    ],
    [
        'IS_NULL_VALUE',
        [{ name: 'IS_NULL_VALUE', parameters: ['variant_expr'], description: 'Returns true for JSON null values' }],
    ],

    // Table functions
    [
        'RESULT_SCAN',
        [
            {
                name: 'RESULT_SCAN',
                parameters: ['query_id'],
                description: 'Returns results of previously executed query',
            },
        ],
    ],
    [
        'GENERATOR',
        [{ name: 'GENERATOR', parameters: ['ROWCOUNT => n'], description: 'Generates specified number of rows' }],
    ],

    // Context functions
    [
        'CURRENT_DATABASE',
        [{ name: 'CURRENT_DATABASE()', parameters: [], description: 'Returns current database name' }],
    ],
    ['CURRENT_SCHEMA', [{ name: 'CURRENT_SCHEMA()', parameters: [], description: 'Returns current schema name' }]],
    [
        'CURRENT_WAREHOUSE',
        [{ name: 'CURRENT_WAREHOUSE()', parameters: [], description: 'Returns current warehouse name' }],
    ],
    ['CURRENT_ROLE', [{ name: 'CURRENT_ROLE()', parameters: [], description: 'Returns current role name' }]],
    ['CURRENT_USER', [{ name: 'CURRENT_USER()', parameters: [], description: 'Returns current user name' }]],
    ['CURRENT_ACCOUNT', [{ name: 'CURRENT_ACCOUNT()', parameters: [], description: 'Returns current account name' }]],
    ['LAST_QUERY_ID', [{ name: 'LAST_QUERY_ID()', parameters: [], description: 'Returns last query ID' }]],

    // Utility functions
    ['UUID_STRING', [{ name: 'UUID_STRING', parameters: [], description: 'Generates UUID string' }]],
    ['HASH', [{ name: 'HASH', parameters: ['expr'], description: 'Returns hash value' }]],
    ['HASH_AGG', [{ name: 'HASH_AGG', parameters: ['expr'], description: 'Returns aggregate hash of values' }]],
    ['MD5', [{ name: 'MD5', parameters: ['expr'], description: 'Returns MD5 hash' }]],
    ['SHA1', [{ name: 'SHA1', parameters: ['expr'], description: 'Returns SHA1 hash' }]],
    ['SHA2', [{ name: 'SHA2', parameters: ['expr', 'numBits'], description: 'Returns SHA2 hash' }]],
    [
        'UNIFORM',
        [{ name: 'UNIFORM', parameters: ['min', 'max', 'seed'], description: 'Generates random number in range' }],
    ],
]);

/**
 * Complete Snowflake function signatures
 * Merges base SQL signatures with Snowflake-specific overlays
 */
export const SNOWFLAKE_FUNCTION_SIGNATURES = mergeFunctionSignatures(
    BASE_SQL_FUNCTION_SIGNATURES,
    SNOWFLAKE_FUNCTION_SIGNATURE_OVERLAYS,
);
