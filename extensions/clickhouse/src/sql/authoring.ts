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

const CLICKHOUSE_KEYWORDS = mergeUniqueStrings(BASE_SQL_COMPLETION_KEYWORDS, [
    'PREWHERE', 'ARRAY JOIN', 'FINAL', 'SAMPLE', 'LIMIT BY', 'WITH FILL',
    'QUALIFY', 'ENGINE', 'PARTITION BY', 'PRIMARY KEY', 'ORDER BY', 'SAMPLE BY',
    'TTL', 'SETTINGS', 'OPTIMIZE', 'MATERIALIZED VIEW', 'PROJECTION', 'FORMAT',
]);

const CLICKHOUSE_BUILTINS = new Set<string>([
    'COUNT', 'UNIQ', 'UNIQEXACT', 'ARGMAX', 'ARGMIN', 'ANY', 'ANYLAST',
    'TOSTRING', 'TOFIXEDSTRING', 'TODATE', 'TODATE32', 'TODATETIME',
    'TODATETIME64', 'TOSTARTOFYEAR', 'TOSTARTOFMONTH', 'TOSTARTOFWEEK',
    'TOSTARTOFDAY', 'TOSTARTOFHOUR', 'IF', 'MULTIIF', 'COALESCE', 'IFNULL',
    'ISNULL', 'ASSUME_NOT_NULL', 'DICTGET', 'JSONEXTRACTSTRING',
    'JSONEXTRACTRAW', 'JSONEXTRACTINT', 'JSONEXTRACTFLOAT', 'ARRAYJOIN',
    'GROUPARRAY', 'GROUPUNIQARRAY', 'QUANTILE', 'MEDIAN', 'TOPK', 'LENGTH',
    'LOWER', 'UPPER', 'REPLACEALL', 'REGEXP_REPLACE', 'NOW', 'TODAY',
]);

const CLICKHOUSE_TYPES: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
    INT8: { canonical: 'Int8', paramsMin: 0, paramsMax: 0 },
    INT16: { canonical: 'Int16', paramsMin: 0, paramsMax: 0 },
    INT32: { canonical: 'Int32', paramsMin: 0, paramsMax: 0 },
    INT64: { canonical: 'Int64', paramsMin: 0, paramsMax: 0 },
    INT128: { canonical: 'Int128', paramsMin: 0, paramsMax: 0 },
    INT256: { canonical: 'Int256', paramsMin: 0, paramsMax: 0 },
    UINT8: { canonical: 'UInt8', paramsMin: 0, paramsMax: 0 },
    UINT16: { canonical: 'UInt16', paramsMin: 0, paramsMax: 0 },
    UINT32: { canonical: 'UInt32', paramsMin: 0, paramsMax: 0 },
    UINT64: { canonical: 'UInt64', paramsMin: 0, paramsMax: 0 },
    UINT128: { canonical: 'UInt128', paramsMin: 0, paramsMax: 0 },
    UINT256: { canonical: 'UInt256', paramsMin: 0, paramsMax: 0 },
    FLOAT32: { canonical: 'Float32', paramsMin: 0, paramsMax: 0 },
    FLOAT64: { canonical: 'Float64', paramsMin: 0, paramsMax: 0 },
    DECIMAL: { canonical: 'Decimal', paramsMin: 2, paramsMax: 2 },
    DECIMAL32: { canonical: 'Decimal32', paramsMin: 1, paramsMax: 1 },
    DECIMAL64: { canonical: 'Decimal64', paramsMin: 1, paramsMax: 1 },
    DECIMAL128: { canonical: 'Decimal128', paramsMin: 1, paramsMax: 1 },
    DECIMAL256: { canonical: 'Decimal256', paramsMin: 1, paramsMax: 1 },
    STRING: { canonical: 'String', paramsMin: 0, paramsMax: 0 },
    FIXEDSTRING: { canonical: 'FixedString', paramsMin: 1, paramsMax: 1 },
    BOOL: { canonical: 'Bool', paramsMin: 0, paramsMax: 0 },
    BOOLEAN: { canonical: 'Bool', paramsMin: 0, paramsMax: 0 },
    UUID: { canonical: 'UUID', paramsMin: 0, paramsMax: 0 },
    DATE: { canonical: 'Date', paramsMin: 0, paramsMax: 0 },
    DATE32: { canonical: 'Date32', paramsMin: 0, paramsMax: 0 },
    DATETIME: { canonical: 'DateTime', paramsMin: 0, paramsMax: 1 },
    DATETIME64: { canonical: 'DateTime64', paramsMin: 1, paramsMax: 2 },
    ENUM8: { canonical: 'Enum8', paramsMin: 1, paramsMax: 255 },
    ENUM16: { canonical: 'Enum16', paramsMin: 1, paramsMax: 255 },
    ARRAY: { canonical: 'Array', paramsMin: 1, paramsMax: 1 },
    MAP: { canonical: 'Map', paramsMin: 2, paramsMax: 2 },
    TUPLE: { canonical: 'Tuple', paramsMin: 1, paramsMax: 255 },
    NULLABLE: { canonical: 'Nullable', paramsMin: 1, paramsMax: 1 },
    LOWCARDINALITY: { canonical: 'LowCardinality', paramsMin: 1, paramsMax: 1 },
};

const CLICKHOUSE_SIGNATURES = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
    ['COUNT', [{ name: 'count', parameters: ['expression'], description: 'Counts rows or non-null values.' }]],
    ['UNIQ', [{ name: 'uniq', parameters: ['expression'], description: 'Approximate distinct count.' }]],
    ['ARGMAX', [{ name: 'argMax', parameters: ['arg', 'val'], description: 'Returns arg for the maximum val.' }]],
    ['ARGMIN', [{ name: 'argMin', parameters: ['arg', 'val'], description: 'Returns arg for the minimum val.' }]],
    ['TOSTARTOFMONTH', [{ name: 'toStartOfMonth', parameters: ['date'], description: 'Rounds a date down to the first day of its month.' }]],
    ['JSONEXTRACTSTRING', [{ name: 'JSONExtractString', parameters: ['json', 'key'], description: 'Extracts a string from JSON.' }]],
]);

const clickhouseFormatterProfile = extendFormatterProfile(BASE_SQL_FORMATTER_PROFILE, {
    keywords: ['PREWHERE', 'ARRAY', 'JOIN', 'FINAL', 'SAMPLE', 'QUALIFY', 'ENGINE', 'TTL', 'SETTINGS', 'OPTIMIZE'],
    clauseKeywords: ['PREWHERE', 'ARRAY JOIN', 'QUALIFY', 'PARTITION BY', 'PRIMARY KEY', 'ORDER BY', 'SAMPLE BY', 'TTL', 'SETTINGS'],
    newlineBeforeKeywords: ['PREWHERE', 'ARRAY JOIN', 'QUALIFY', 'PARTITION BY', 'PRIMARY KEY', 'ORDER BY', 'SAMPLE BY', 'TTL', 'SETTINGS'],
});

const clickhouseValidationProfile: DatabaseSqlValidationProfile = {
    databaseKind: 'clickhouse',
    builtinFunctions: mergeStringSets(BASE_SQL_BUILTIN_FUNCTIONS, CLICKHOUSE_BUILTINS),
    systemColumns: new Set(['_PARTITION_ID', '_PARTITION_VALUE', '_SAMPLE_FACTOR', '_SIGN', '_VERSION']),
    specialBuiltinValues: mergeStringSets(BASE_SQL_SPECIAL_BUILTIN_VALUES, new Set(['NULL', 'TRUE', 'FALSE'])),
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        const normalized = typeName.trim().toUpperCase().replace(/\s+/g, '');
        return CLICKHOUSE_TYPES[normalized];
    },
    supportsProcedureAnySizeArgument: () => false,
    syntaxValidationMode: 'strict',
};

const clickhouseQualityRules = [
    {
        id: 'CH001',
        name: 'Background mutation',
        description: 'ALTER TABLE UPDATE/DELETE is a background mutation in ClickHouse.',
        defaultSeverity: 2 as const,
        check(sql: string) {
            const match = /\bALTER\s+TABLE\b[\s\S]*?\b(UPDATE|DELETE)\b/i.exec(sql);
            if (!match || match.index === undefined) {
                return [];
            }
            const keywordOffset = match[0].toUpperCase().lastIndexOf(match[1].toUpperCase());
            const startOffset = match.index + keywordOffset;
            return [{
                ruleId: 'CH001',
                message: 'ClickHouse mutations run asynchronously and are not transactional.',
                severity: 2 as const,
                startOffset,
                endOffset: startOffset + match[1].length,
            }];
        },
    },
    {
        id: 'CH002',
        name: 'OPTIMIZE FINAL',
        description: 'OPTIMIZE FINAL can force an expensive full merge.',
        defaultSeverity: 2 as const,
        check(sql: string) {
            const match = /\bOPTIMIZE\s+TABLE\b[\s\S]*?\bFINAL\b/i.exec(sql);
            if (!match || match.index === undefined) {
                return [];
            }
            const finalOffset = match.index + match[0].toUpperCase().lastIndexOf('FINAL');
            return [{
                ruleId: 'CH002',
                message: 'OPTIMIZE FINAL may be expensive; run it only when a full merge is required.',
                severity: 2 as const,
                startOffset: finalOffset,
                endOffset: finalOffset + 5,
            }];
        },
    },
];

export const clickhouseSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: CLICKHOUSE_KEYWORDS,
    signatures: mergeFunctionSignatures(BASE_SQL_FUNCTION_SIGNATURES, CLICKHOUSE_SIGNATURES),
    formatter: clickhouseFormatterProfile,
    validation: clickhouseValidationProfile,
    qualityRules: clickhouseQualityRules,
    parsing: {
        lexerModulePath: 'src/dialects/clickhouse/sql/lexer.ts',
        parserModulePath: 'src/dialects/clickhouse/sql/parser.ts',
    },
    staticAssets: {
        snippetsPath: 'dialects/clickhouse/snippets/clickhouse.code-snippets',
        grammarPath: 'dialects/clickhouse/syntaxes/clickhouse.tmLanguage.json',
        grammarScopeName: 'clickhouse.injection',
    },
};
