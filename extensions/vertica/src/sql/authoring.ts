import type {
    DatabaseSqlAuthoring,
    DatabaseSqlFunctionSignature,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile,
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
    mergeUniqueStrings,
} from '../../../../src/sql/authoring/baseProfiles';

const VERTICA_COMPLETION_KEYWORD_OVERLAYS = [
    'LEFT JOIN',
    'RIGHT JOIN',
    'FULL JOIN',
    'CROSS JOIN',
    'COPY',
    'EXPORT',
    'PROJECTION',
    'FUNCTION',
    'ANALYZE_STATISTICS',
    'HAVING',
    'SEGMENTED BY',
    'UNSEGMENTED ALL NODES',
    'KSAFE',
    'ORDER BY',
    'GROUP BY',
    'PARTITION BY',
] as const;

const VERTICA_COMPLETION_KEYWORDS = mergeUniqueStrings(
    BASE_SQL_COMPLETION_KEYWORDS,
    VERTICA_COMPLETION_KEYWORD_OVERLAYS
);

const VERTICA_BUILTIN_FUNCTION_OVERLAYS = new Set<string>([
    'ANALYZE_STATISTICS',
    'CASE',
    'CLOSE_SESSION',
    'CURRENT_DATABASE',
    'CURRENT_SCHEMA',
    'CURRENT_SESSION',
    'CURRENT_TIMESTAMP',
    'EXPORT_OBJECTS',
    'HASH',
    'PURGE_TABLE',
]);

const VERTICA_SPECIAL_BUILTIN_VALUE_OVERLAYS = new Set<string>(['NULL', 'TRUE', 'FALSE']);

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

const VERTICA_SIGNATURE_OVERLAYS = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
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

const verticaFormatterProfile = extendFormatterProfile(BASE_SQL_FORMATTER_PROFILE, {
    keywords: VERTICA_COMPLETION_KEYWORD_OVERLAYS,
    clauseKeywords: ['GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET'],
    newlineBeforeKeywords: ['GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET']
});

const verticaValidationProfile: DatabaseSqlValidationProfile = {
    builtinFunctions: mergeStringSets(BASE_SQL_BUILTIN_FUNCTIONS, VERTICA_BUILTIN_FUNCTION_OVERLAYS),
    systemColumns: new Set(),
    specialBuiltinValues: mergeStringSets(BASE_SQL_SPECIAL_BUILTIN_VALUES, VERTICA_SPECIAL_BUILTIN_VALUE_OVERLAYS),
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
    signatures: mergeFunctionSignatures(BASE_SQL_FUNCTION_SIGNATURES, VERTICA_SIGNATURE_OVERLAYS),
    formatter: verticaFormatterProfile,
    validation: verticaValidationProfile,
    qualityRules: [],
};
