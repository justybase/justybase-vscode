import type {
    DatabaseSqlAuthoring,
    DatabaseSqlFunctionSignature,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile
} from '../../../../src/sql/authoring/types';
import {
    BASE_SQL_BUILTIN_FUNCTIONS,
    BASE_SQL_COMPLETION_KEYWORDS,
    BASE_SQL_FORMATTER_PROFILE,
    BASE_SQL_FUNCTION_SIGNATURES,
    BASE_SQL_SPECIAL_BUILTIN_VALUES,
    extendFormatterProfile,
    mergeFunctionSignatures,
    mergeStringSets,
    mergeUniqueStrings
} from '../../../../src/sql/authoring/baseProfiles';

const MYSQL_COMPLETION_KEYWORD_OVERLAYS = [
    'RETURNING',
    'INDEX',
    'FUNCTION',
    'TRIGGER',
    'EVENT',
    'ORDER BY',
    'GROUP BY'
] as const;

const MYSQL_COMPLETION_KEYWORDS = mergeUniqueStrings(
    BASE_SQL_COMPLETION_KEYWORDS,
    MYSQL_COMPLETION_KEYWORD_OVERLAYS
);

const MYSQL_BUILTIN_FUNCTION_OVERLAYS = new Set<string>([
    'CURRENT_DATE',
    'CURRENT_TIME',
    'CURRENT_TIMESTAMP',
    'IF',
    'IFNULL',
    'CURDATE',
    'CURTIME',
    'DATE_FORMAT',
    'STR_TO_DATE',
    'TIMESTAMPDIFF',
    'TIMESTAMPADD',
    'GROUP_CONCAT',
    'JSON_ARRAY',
    'JSON_CONTAINS',
    'JSON_EXTRACT',
    'JSON_OBJECT',
    'JSON_SET',
    'JSON_UNQUOTE',
    'REGEXP_LIKE',
    'REGEXP_REPLACE',
    'REGEXP_SUBSTR',
    'FIND_IN_SET',
    'LAST_INSERT_ID',
    'UUID',
    'VERSION',
]);

const MYSQL_SPECIAL_BUILTIN_VALUE_OVERLAYS = new Set<string>(['NULL', 'TRUE', 'FALSE']);

const MYSQL_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
    TINYINT: { canonical: 'TINYINT', paramsMin: 0, paramsMax: 1 },
    SMALLINT: { canonical: 'SMALLINT', paramsMin: 0, paramsMax: 1 },
    MEDIUMINT: { canonical: 'MEDIUMINT', paramsMin: 0, paramsMax: 1 },
    INT: { canonical: 'INT', paramsMin: 0, paramsMax: 1 },
    INTEGER: { canonical: 'INTEGER', paramsMin: 0, paramsMax: 1 },
    BIGINT: { canonical: 'BIGINT', paramsMin: 0, paramsMax: 1 },
    DECIMAL: { canonical: 'DECIMAL', paramsMin: 1, paramsMax: 2 },
    NUMERIC: { canonical: 'NUMERIC', paramsMin: 1, paramsMax: 2 },
    FLOAT: { canonical: 'FLOAT', paramsMin: 0, paramsMax: 2 },
    DOUBLE: { canonical: 'DOUBLE', paramsMin: 0, paramsMax: 2 },
    BIT: { canonical: 'BIT', paramsMin: 0, paramsMax: 1 },
    CHAR: { canonical: 'CHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    VARCHAR: { canonical: 'VARCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    BINARY: { canonical: 'BINARY', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    VARBINARY: { canonical: 'VARBINARY', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    TINYTEXT: { canonical: 'TINYTEXT', paramsMin: 0, paramsMax: 0 },
    TEXT: { canonical: 'TEXT', paramsMin: 0, paramsMax: 0 },
    MEDIUMTEXT: { canonical: 'MEDIUMTEXT', paramsMin: 0, paramsMax: 0 },
    LONGTEXT: { canonical: 'LONGTEXT', paramsMin: 0, paramsMax: 0 },
    TINYBLOB: { canonical: 'TINYBLOB', paramsMin: 0, paramsMax: 0 },
    BLOB: { canonical: 'BLOB', paramsMin: 0, paramsMax: 0 },
    MEDIUMBLOB: { canonical: 'MEDIUMBLOB', paramsMin: 0, paramsMax: 0 },
    LONGBLOB: { canonical: 'LONGBLOB', paramsMin: 0, paramsMax: 0 },
    DATE: { canonical: 'DATE', paramsMin: 0, paramsMax: 0 },
    TIME: { canonical: 'TIME', paramsMin: 0, paramsMax: 1 },
    DATETIME: { canonical: 'DATETIME', paramsMin: 0, paramsMax: 1 },
    TIMESTAMP: { canonical: 'TIMESTAMP', paramsMin: 0, paramsMax: 1 },
    YEAR: { canonical: 'YEAR', paramsMin: 0, paramsMax: 0 },
    JSON: { canonical: 'JSON', paramsMin: 0, paramsMax: 0 },
    ENUM: { canonical: 'ENUM', paramsMin: 0, paramsMax: 255 },
    SET: { canonical: 'SET', paramsMin: 0, paramsMax: 255 },
    BOOLEAN: { canonical: 'BOOLEAN', paramsMin: 0, paramsMax: 0 },
    BOOL: { canonical: 'BOOL', paramsMin: 0, paramsMax: 0 },
    REAL: { canonical: 'REAL', paramsMin: 0, paramsMax: 2 },
    GEOMETRY: { canonical: 'GEOMETRY', paramsMin: 0, paramsMax: 0 },
    POINT: { canonical: 'POINT', paramsMin: 0, paramsMax: 0 }
};

const MYSQL_SIGNATURE_OVERLAYS = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
    [
        'COUNT',
        [{ name: 'COUNT', parameters: ['expression'], description: 'Returns the number of input rows where the expression is not null.' }]
    ],
    [
        'COALESCE',
        [{ name: 'COALESCE', parameters: ['value1', 'value2', '...'], description: 'Returns the first non-null argument.' }]
    ],
    [
        'NOW',
        [{ name: 'NOW', parameters: [], description: 'Returns the current date and time.' }]
    ],
    [
        'CONCAT',
        [{ name: 'CONCAT', parameters: ['str1', 'str2', '...'], description: 'Concatenates strings.' }]
    ]
]);

const mysqlFormatterProfile = extendFormatterProfile(BASE_SQL_FORMATTER_PROFILE, {
    keywords: MYSQL_COMPLETION_KEYWORD_OVERLAYS,
    clauseKeywords: ['GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET', 'RETURNING'],
    newlineBeforeKeywords: ['GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET', 'RETURNING']
});

const mysqlValidationProfile: DatabaseSqlValidationProfile = {
    databaseKind: 'mysql',
    builtinFunctions: mergeStringSets(BASE_SQL_BUILTIN_FUNCTIONS, MYSQL_BUILTIN_FUNCTION_OVERLAYS),
    systemColumns: new Set(),
    specialBuiltinValues: mergeStringSets(BASE_SQL_SPECIAL_BUILTIN_VALUES, MYSQL_SPECIAL_BUILTIN_VALUE_OVERLAYS),
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        if (!typeName) return undefined;
        return MYSQL_TYPE_SPECS[typeName.trim().toUpperCase()];
    },
    supportsProcedureAnySizeArgument(): boolean {
        return false;
    },
    syntaxValidationMode: 'strict'
};

export const mysqlSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: MYSQL_COMPLETION_KEYWORDS,
    signatures: mergeFunctionSignatures(BASE_SQL_FUNCTION_SIGNATURES, MYSQL_SIGNATURE_OVERLAYS),
    formatter: mysqlFormatterProfile,
    validation: mysqlValidationProfile,
    qualityRules: []
};
