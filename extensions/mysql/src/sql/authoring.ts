import type {
    DatabaseSqlAuthoring,
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile
} from '../../../../src/sql/authoring/types';

const MYSQL_COMPLETION_KEYWORDS = [
    'SELECT',
    'FROM',
    'WHERE',
    'INSERT',
    'UPDATE',
    'DELETE',
    'WITH',
    'RECURSIVE',
    'RETURNING',
    'CREATE',
    'ALTER',
    'DROP',
    'TABLE',
    'VIEW',
    'INDEX',
    'FUNCTION',
    'PROCEDURE',
    'TRIGGER',
    'EVENT',
    'ORDER BY',
    'GROUP BY',
    'LIMIT',
    'OFFSET'
] as const;

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
    JSON: { canonical: 'JSON', paramsMin: 0, paramsMax: 0 }
};

const MYSQL_SIGNATURES = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
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

const mysqlFormatterProfile: DatabaseSqlFormatterProfile = {
    keywords: new Set(MYSQL_COMPLETION_KEYWORDS),
    clauseKeywords: new Set(['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET', 'RETURNING']),
    newlineBeforeKeywords: new Set(['FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET', 'RETURNING']),
    joinModifiers: new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS']),
    commaNewlineClauses: new Set(['SELECT']),
    logicalBreakKeywords: new Set(['AND', 'OR'])
};

const mysqlValidationProfile: DatabaseSqlValidationProfile = {
    builtinFunctions: new Set([
        'ABS',
        'AVG',
        'COALESCE',
        'CONCAT',
        'COUNT',
        'CURRENT_DATE',
        'CURRENT_TIME',
        'CURRENT_TIMESTAMP',
        'IFNULL',
        'LENGTH',
        'LOWER',
        'MAX',
        'MIN',
        'NOW',
        'ROUND',
        'SUBSTRING',
        'SUM',
        'UPPER'
    ]),
    systemColumns: new Set(),
    specialBuiltinValues: new Set(['NULL', 'TRUE', 'FALSE', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP']),
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        if (!typeName) return undefined;
        return MYSQL_TYPE_SPECS[typeName.trim().toUpperCase()];
    },
    supportsProcedureAnySizeArgument(): boolean {
        return false;
    },
    syntaxValidationMode: 'bestEffort'
};

export const mysqlSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: MYSQL_COMPLETION_KEYWORDS,
    signatures: MYSQL_SIGNATURES,
    formatter: mysqlFormatterProfile,
    validation: mysqlValidationProfile,
    qualityRules: []
};
