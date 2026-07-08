import type {
    DatabaseSqlAuthoring,
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile,
} from '../../../../src/sql/authoring/types';

const VERTICA_COMPLETION_KEYWORDS = [
    'SELECT',
    'DISTINCT',
    'FROM',
    'WHERE',
    'JOIN',
    'LEFT JOIN',
    'RIGHT JOIN',
    'FULL JOIN',
    'CROSS JOIN',
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'WITH',
    'COPY',
    'EXPORT',
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
    'TABLE',
    'VIEW',
    'PROJECTION',
    'SEQUENCE',
    'FUNCTION',
    'PROCEDURE',
    'EXPLAIN',
    'ANALYZE_STATISTICS',
    'ORDER BY',
    'GROUP BY',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'SEGMENTED BY',
    'UNSEGMENTED ALL NODES',
    'KSAFE',
    'PARTITION BY',
] as const;

const VERTICA_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
    BOOLEAN: { canonical: 'BOOLEAN', paramsMin: 0, paramsMax: 0 },
    INT: { canonical: 'INT', paramsMin: 0, paramsMax: 0 },
    INTEGER: { canonical: 'INTEGER', paramsMin: 0, paramsMax: 0 },
    BIGINT: { canonical: 'BIGINT', paramsMin: 0, paramsMax: 0 },
    SMALLINT: { canonical: 'SMALLINT', paramsMin: 0, paramsMax: 0 },
    FLOAT: { canonical: 'FLOAT', paramsMin: 0, paramsMax: 0 },
    DOUBLE: { canonical: 'DOUBLE PRECISION', paramsMin: 0, paramsMax: 0 },
    'DOUBLE PRECISION': { canonical: 'DOUBLE PRECISION', paramsMin: 0, paramsMax: 0 },
    NUMERIC: { canonical: 'NUMERIC', paramsMin: 1, paramsMax: 2 },
    DECIMAL: { canonical: 'DECIMAL', paramsMin: 1, paramsMax: 2 },
    CHAR: { canonical: 'CHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    VARCHAR: { canonical: 'VARCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    'LONG VARCHAR': { canonical: 'LONG VARCHAR', paramsMin: 0, paramsMax: 0 },
    BINARY: { canonical: 'BINARY', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    VARBINARY: { canonical: 'VARBINARY', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    'LONG VARBINARY': { canonical: 'LONG VARBINARY', paramsMin: 0, paramsMax: 0 },
    DATE: { canonical: 'DATE', paramsMin: 0, paramsMax: 0 },
    TIME: { canonical: 'TIME', paramsMin: 0, paramsMax: 1 },
    TIMESTAMP: { canonical: 'TIMESTAMP', paramsMin: 0, paramsMax: 1 },
    TIMESTAMPTZ: { canonical: 'TIMESTAMPTZ', paramsMin: 0, paramsMax: 1 },
    INTERVAL: { canonical: 'INTERVAL', paramsMin: 0, paramsMax: 0 },
    UUID: { canonical: 'UUID', paramsMin: 0, paramsMax: 0 },
    ARRAY: { canonical: 'ARRAY', paramsMin: 0, paramsMax: 0 },
};

const VERTICA_SIGNATURES = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
    [
        'COUNT',
        [{ name: 'COUNT', parameters: ['expression'], description: 'Returns the number of non-null input rows.' }],
    ],
    [
        'COALESCE',
        [{ name: 'COALESCE', parameters: ['value1', 'value2', '...'], description: 'Returns the first non-null argument.' }],
    ],
    [
        'DATE_TRUNC',
        [{ name: 'DATE_TRUNC', parameters: ['precision', 'source'], description: 'Truncates a timestamp to the requested precision.' }],
    ],
    [
        'EXPORT_OBJECTS',
        [{ name: 'EXPORT_OBJECTS', parameters: ['destination', 'scope?', 'mark_ksafe?'], description: 'Exports DDL for catalog objects.' }],
    ],
    [
        'CLOSE_SESSION',
        [{ name: 'CLOSE_SESSION', parameters: ['session_id'], description: 'Closes an external Vertica session.' }],
    ],
    [
        'PURGE_TABLE',
        [{ name: 'PURGE_TABLE', parameters: ['qualified_table_name'], description: 'Purges deleted storage for a table.' }],
    ],
]);

const verticaFormatterProfile: DatabaseSqlFormatterProfile = {
    keywords: new Set(VERTICA_COMPLETION_KEYWORDS),
    clauseKeywords: new Set(['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET']),
    newlineBeforeKeywords: new Set(['FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET']),
    joinModifiers: new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS']),
    commaNewlineClauses: new Set(['SELECT']),
    logicalBreakKeywords: new Set(['AND', 'OR']),
};

const verticaValidationProfile: DatabaseSqlValidationProfile = {
    builtinFunctions: new Set([
        'ABS',
        'ANALYZE_STATISTICS',
        'AVG',
        'CASE',
        'CLOSE_SESSION',
        'COALESCE',
        'COUNT',
        'CURRENT_DATABASE',
        'CURRENT_SCHEMA',
        'CURRENT_SESSION',
        'CURRENT_TIMESTAMP',
        'DATE_TRUNC',
        'EXPORT_OBJECTS',
        'HASH',
        'MAX',
        'MIN',
        'NOW',
        'PURGE_TABLE',
        'SUM',
        'UPPER',
    ]),
    systemColumns: new Set(),
    specialBuiltinValues: new Set(['NULL', 'TRUE', 'FALSE', 'CURRENT_DATE', 'CURRENT_SCHEMA', 'CURRENT_TIMESTAMP']),
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        if (!typeName) {
            return undefined;
        }
        return VERTICA_TYPE_SPECS[typeName.trim().toUpperCase()];
    },
    supportsProcedureAnySizeArgument(): boolean {
        return false;
    },
    syntaxValidationMode: 'bestEffort',
};

export const verticaSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: VERTICA_COMPLETION_KEYWORDS,
    signatures: VERTICA_SIGNATURES,
    formatter: verticaFormatterProfile,
    validation: verticaValidationProfile,
    qualityRules: [],
};
