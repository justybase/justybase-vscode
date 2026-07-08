import type {
    DatabaseSqlAuthoring,
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile
} from '../../../../src/sql/authoring/types';

const MSSQL_COMPLETION_KEYWORDS = [
    'SELECT',
    'FROM',
    'WHERE',
    'INSERT',
    'UPDATE',
    'DELETE',
    'WITH',
    'OUTPUT',
    'CREATE',
    'ALTER',
    'DROP',
    'TABLE',
    'VIEW',
    'INDEX',
    'PROCEDURE',
    'FUNCTION',
    'TRIGGER',
    'ORDER BY',
    'GROUP BY',
    'TOP',
    'OFFSET',
    'FETCH NEXT',
    'GO'
] as const;

const MSSQL_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
    TINYINT: { canonical: 'TINYINT', paramsMin: 0, paramsMax: 0 },
    SMALLINT: { canonical: 'SMALLINT', paramsMin: 0, paramsMax: 0 },
    INT: { canonical: 'INT', paramsMin: 0, paramsMax: 0 },
    BIGINT: { canonical: 'BIGINT', paramsMin: 0, paramsMax: 0 },
    NUMERIC: { canonical: 'NUMERIC', paramsMin: 1, paramsMax: 2 },
    DECIMAL: { canonical: 'DECIMAL', paramsMin: 1, paramsMax: 2 },
    REAL: { canonical: 'REAL', paramsMin: 0, paramsMax: 0 },
    FLOAT: { canonical: 'FLOAT', paramsMin: 0, paramsMax: 1 },
    BIT: { canonical: 'BIT', paramsMin: 0, paramsMax: 0 },
    CHAR: { canonical: 'CHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    VARCHAR: { canonical: 'VARCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    NCHAR: { canonical: 'NCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    NVARCHAR: { canonical: 'NVARCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    TEXT: { canonical: 'TEXT', paramsMin: 0, paramsMax: 0 },
    NTEXT: { canonical: 'NTEXT', paramsMin: 0, paramsMax: 0 },
    DATE: { canonical: 'DATE', paramsMin: 0, paramsMax: 0 },
    TIME: { canonical: 'TIME', paramsMin: 0, paramsMax: 1 },
    DATETIME: { canonical: 'DATETIME', paramsMin: 0, paramsMax: 0 },
    SMALLDATETIME: { canonical: 'SMALLDATETIME', paramsMin: 0, paramsMax: 0 },
    DATETIME2: { canonical: 'DATETIME2', paramsMin: 0, paramsMax: 1 },
    DATETIMEOFFSET: { canonical: 'DATETIMEOFFSET', paramsMin: 0, paramsMax: 1 },
    MONEY: { canonical: 'MONEY', paramsMin: 0, paramsMax: 0 },
    SMALLMONEY: { canonical: 'SMALLMONEY', paramsMin: 0, paramsMax: 0 },
    BINARY: { canonical: 'BINARY', paramsMin: 1, paramsMax: 1 },
    VARBINARY: { canonical: 'VARBINARY', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    IMAGE: { canonical: 'IMAGE', paramsMin: 0, paramsMax: 0 },
    XML: { canonical: 'XML', paramsMin: 0, paramsMax: 0 },
    UNIQUEIDENTIFIER: { canonical: 'UNIQUEIDENTIFIER', paramsMin: 0, paramsMax: 0 },
    SQL_VARIANT: { canonical: 'SQL_VARIANT', paramsMin: 0, paramsMax: 0 }
};

const MSSQL_SIGNATURES = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
    [
        'COUNT',
        [{
            name: 'COUNT',
            parameters: ['expression'],
            description: 'Returns the number of items found in a group.'
        }]
    ],
    [
        'ISNULL',
        [{
            name: 'ISNULL',
            parameters: ['check_expression', 'replacement_value'],
            description: 'Replaces NULL with the specified replacement value.'
        }]
    ],
    [
        'GETDATE',
        [{
            name: 'GETDATE',
            parameters: [],
            description: 'Returns the current database system timestamp.'
        }]
    ]
]);

const mssqlFormatterProfile: DatabaseSqlFormatterProfile = {
    keywords: new Set(MSSQL_COMPLETION_KEYWORDS),
    clauseKeywords: new Set(['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'OFFSET', 'FETCH NEXT', 'OUTPUT']),
    newlineBeforeKeywords: new Set(['FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'OFFSET', 'FETCH NEXT', 'OUTPUT']),
    joinModifiers: new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'APPLY']),
    commaNewlineClauses: new Set(['SELECT']),
    logicalBreakKeywords: new Set(['AND', 'OR'])
};

const mssqlValidationProfile: DatabaseSqlValidationProfile = {
    builtinFunctions: new Set([
        'ABS',
        'AVG',
        'CAST',
        'CEILING',
        'CHARINDEX',
        'CHOOSE',
        'COALESCE',
        'CONCAT',
        'CONVERT',
        'COUNT',
        'DATALENGTH',
        'DATEADD',
        'DATEDIFF',
        'DAY',
        'DENSE_RANK',
        'FLOOR',
        'FORMAT',
        'GETDATE',
        'IIF',
        'ISNULL',
        'LEFT',
        'LEN',
        'LOWER',
        'LTRIM',
        'MAX',
        'MIN',
        'MONTH',
        'NEWID',
        'NULLIF',
        'RANK',
        'REPLACE',
        'REVERSE',
        'RIGHT',
        'ROUND',
        'ROW_NUMBER',
        'RTRIM',
        'STUFF',
        'SUBSTRING',
        'SUM',
        'SYSDATETIME',
        'TRIM',
        'UPPER',
        'YEAR'
    ]),
    systemColumns: new Set([]),
    specialBuiltinValues: new Set([
        'NULL'
    ]),
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        if (!typeName) return undefined;
        return MSSQL_TYPE_SPECS[typeName.trim().toUpperCase()];
    },
    supportsProcedureAnySizeArgument(): boolean {
        return false;
    },
    syntaxValidationMode: 'bestEffort'
};

export const mssqlSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: MSSQL_COMPLETION_KEYWORDS,
    signatures: MSSQL_SIGNATURES,
    formatter: mssqlFormatterProfile,
    validation: mssqlValidationProfile,
    qualityRules: []
};
