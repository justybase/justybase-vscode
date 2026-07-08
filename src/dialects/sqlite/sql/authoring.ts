import type {
    DatabaseSqlAuthoring,
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile
} from '../../../sql/authoring/types';

const SQLITE_COMPLETION_KEYWORDS = [
    'SELECT',
    'FROM',
    'WHERE',
    'INSERT',
    'UPDATE',
    'DELETE',
    'CREATE',
    'TABLE',
    'VIEW',
    'PRAGMA',
    'ORDER BY',
    'GROUP BY',
    'LIMIT'
] as const;

const SQLITE_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
    INTEGER: {
        canonical: 'INTEGER',
        paramsMin: 0,
        paramsMax: 0
    },
    TEXT: {
        canonical: 'TEXT',
        paramsMin: 0,
        paramsMax: 0
    },
    REAL: {
        canonical: 'REAL',
        paramsMin: 0,
        paramsMax: 0
    },
    BLOB: {
        canonical: 'BLOB',
        paramsMin: 0,
        paramsMax: 0
    },
    NUMERIC: {
        canonical: 'NUMERIC',
        paramsMin: 0,
        paramsMax: 0
    }
};

const SQLITE_SIGNATURES = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
    [
        'COUNT',
        [{
            name: 'COUNT',
            parameters: ['expression'],
            description: 'Returns the number of non-null values for the expression.'
        }]
    ],
    [
        'SUBSTR',
        [{
            name: 'SUBSTR',
            parameters: ['value', 'start', 'length'],
            description: 'Returns a substring starting at the given offset.'
        }]
    ]
]);

const sqliteFormatterProfile: DatabaseSqlFormatterProfile = {
    keywords: new Set(SQLITE_COMPLETION_KEYWORDS),
    clauseKeywords: new Set(['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT']),
    newlineBeforeKeywords: new Set(['FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT']),
    joinModifiers: new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS']),
    commaNewlineClauses: new Set(['SELECT']),
    logicalBreakKeywords: new Set(['AND', 'OR'])
};

const sqliteValidationProfile: DatabaseSqlValidationProfile = {
    builtinFunctions: new Set(['ABS', 'AVG', 'COUNT', 'COALESCE', 'LOWER', 'MAX', 'MIN', 'ROUND', 'SUBSTR', 'SUM', 'UPPER']),
    systemColumns: new Set(),
    specialBuiltinValues: new Set(['NULL', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP']),
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        if (!typeName) return undefined;
        return SQLITE_TYPE_SPECS[typeName.trim().toUpperCase()];
    },
    supportsProcedureAnySizeArgument(): boolean {
        return false;
    }
};

export const sqliteSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: SQLITE_COMPLETION_KEYWORDS,
    signatures: SQLITE_SIGNATURES,
    formatter: sqliteFormatterProfile,
    validation: sqliteValidationProfile,
    qualityRules: []
};
