import type {
    DatabaseSqlAuthoring,
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile
} from '../../../../src/sql/authoring/types';

const DB2_COMPLETION_KEYWORDS = [
    'SELECT',
    'FROM',
    'WHERE',
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'CALL',
    'CREATE',
    'ALTER',
    'DROP',
    'TABLE',
    'VIEW',
    'PROCEDURE',
    'FUNCTION',
    'SEQUENCE',
    'TRIGGER',
    'FETCH FIRST',
    'WITH UR',
    'ORDER BY',
    'GROUP BY'
] as const;

const DB2_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
    SMALLINT: { canonical: 'SMALLINT', paramsMin: 0, paramsMax: 0 },
    INTEGER: { canonical: 'INTEGER', paramsMin: 0, paramsMax: 0 },
    BIGINT: { canonical: 'BIGINT', paramsMin: 0, paramsMax: 0 },
    DECIMAL: { canonical: 'DECIMAL', paramsMin: 1, paramsMax: 2 },
    NUMERIC: { canonical: 'NUMERIC', paramsMin: 1, paramsMax: 2 },
    CHAR: { canonical: 'CHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    VARCHAR: { canonical: 'VARCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    DATE: { canonical: 'DATE', paramsMin: 0, paramsMax: 0 },
    TIME: { canonical: 'TIME', paramsMin: 0, paramsMax: 0 },
    TIMESTAMP: { canonical: 'TIMESTAMP', paramsMin: 0, paramsMax: 1 }
};

const DB2_SIGNATURES = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
    [
        'COUNT',
        [{
            name: 'COUNT',
            parameters: ['expression'],
            description: 'Returns the number of non-null values for the expression.'
        }]
    ],
    [
        'COALESCE',
        [{
            name: 'COALESCE',
            parameters: ['value1', 'value2', '...'],
            description: 'Returns the first non-null argument.'
        }]
    ],
    [
        'CONCAT',
        [{
            name: 'CONCAT',
            parameters: ['left', 'right'],
            description: 'Concatenates two string expressions.'
        }]
    ]
]);

const db2FormatterProfile: DatabaseSqlFormatterProfile = {
    keywords: new Set(DB2_COMPLETION_KEYWORDS),
    clauseKeywords: new Set(['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'FETCH FIRST', 'WITH UR']),
    newlineBeforeKeywords: new Set(['FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'FETCH FIRST', 'WITH UR']),
    joinModifiers: new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS']),
    commaNewlineClauses: new Set(['SELECT']),
    logicalBreakKeywords: new Set(['AND', 'OR'])
};

const db2ValidationProfile: DatabaseSqlValidationProfile = {
    builtinFunctions: new Set([
        'ABS',
        'AVG',
        'COALESCE',
        'CONCAT',
        'COUNT',
        'CURRENT DATE',
        'CURRENT TIME',
        'CURRENT TIMESTAMP',
        'CURRENT USER',
        'MAX',
        'MIN',
        'SUM'
    ]),
    systemColumns: new Set(),
    specialBuiltinValues: new Set(['NULL', 'CURRENT DATE', 'CURRENT TIME', 'CURRENT TIMESTAMP', 'CURRENT USER']),
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        if (!typeName) return undefined;
        return DB2_TYPE_SPECS[typeName.trim().toUpperCase()];
    },
    supportsProcedureAnySizeArgument(): boolean {
        return false;
    },
    syntaxValidationMode: 'bestEffort'
};

export const db2SqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: DB2_COMPLETION_KEYWORDS,
    signatures: DB2_SIGNATURES,
    formatter: db2FormatterProfile,
    validation: db2ValidationProfile,
    qualityRules: []
};
