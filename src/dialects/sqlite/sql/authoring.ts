import type {
    DatabaseSqlAuthoring,
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile
} from '../../../sql/authoring/types';
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
} from '../../../sql/authoring/baseProfiles';
import { sqliteSqlQualityRules } from './qualityRules';

const SQLITE_COMPLETION_KEYWORDS = mergeUniqueStrings(BASE_SQL_COMPLETION_KEYWORDS, [
    'ATTACH',
    'AUTOINCREMENT',
    'COLLATE',
    'CONFLICT',
    'CREATE INDEX',
    'CREATE TRIGGER',
    'DETACH',
    'DROP INDEX',
    'DROP TRIGGER',
    'EXPLAIN QUERY PLAN',
    'FOREIGN KEY',
    'GENERATED ALWAYS AS',
    'IF NOT EXISTS',
    'INSERT OR IGNORE',
    'INSERT OR REPLACE',
    'ON CONFLICT',
    'PRAGMA',
    'REINDEX',
    'RELEASE SAVEPOINT',
    'RETURNING',
    'SAVEPOINT',
    'STRICT',
    'TRIGGER',
    'VACUUM INTO',
    'VIRTUAL',
    'WITHOUT ROWID',
]);

const SQLITE_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
    BLOB: { canonical: 'BLOB', paramsMin: 0, paramsMax: 0 },
    BOOLEAN: { canonical: 'BOOLEAN', paramsMin: 0, paramsMax: 0 },
    CHAR: { canonical: 'CHAR', paramsMin: 0, paramsMax: 1 },
    CLOB: { canonical: 'CLOB', paramsMin: 0, paramsMax: 1 },
    DATE: { canonical: 'DATE', paramsMin: 0, paramsMax: 0 },
    DATETIME: { canonical: 'DATETIME', paramsMin: 0, paramsMax: 0 },
    DECIMAL: { canonical: 'DECIMAL', paramsMin: 0, paramsMax: 2 },
    DOUBLE: { canonical: 'DOUBLE', paramsMin: 0, paramsMax: 0 },
    FLOAT: { canonical: 'FLOAT', paramsMin: 0, paramsMax: 0 },
    INTEGER: { canonical: 'INTEGER', paramsMin: 0, paramsMax: 0 },
    INT: { canonical: 'INT', paramsMin: 0, paramsMax: 0 },
    NUMERIC: { canonical: 'NUMERIC', paramsMin: 0, paramsMax: 2 },
    REAL: { canonical: 'REAL', paramsMin: 0, paramsMax: 0 },
    TEXT: { canonical: 'TEXT', paramsMin: 0, paramsMax: 1 },
    TIME: { canonical: 'TIME', paramsMin: 0, paramsMax: 0 },
    TIMESTAMP: { canonical: 'TIMESTAMP', paramsMin: 0, paramsMax: 0 },
    VARCHAR: { canonical: 'VARCHAR', paramsMin: 0, paramsMax: 1 },
};

const SQLITE_BUILTIN_FUNCTIONS = mergeStringSets(BASE_SQL_BUILTIN_FUNCTIONS, [
    'DATE',
    'DATETIME',
    'GROUP_CONCAT',
    'HEX',
    'IFNULL',
    'IIF',
    'JSON',
    'JSON_ARRAY',
    'JSON_ARRAY_LENGTH',
    'JSON_EXTRACT',
    'JSON_OBJECT',
    'JSON_REMOVE',
    'JSON_SET',
    'JSON_TYPE',
    'JULIANDAY',
    'PRINTF',
    'QUOTE',
    'RANDOMBLOB',
    'STRFTIME',
    'TOTAL',
    'UNICODE',
    'ZEROBLOB',
]);

const SQLITE_SPECIAL_BUILTIN_VALUES = mergeStringSets(BASE_SQL_SPECIAL_BUILTIN_VALUES, [
    'FALSE',
    'TRUE',
]);

const SQLITE_SIGNATURES: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> = mergeFunctionSignatures(
    BASE_SQL_FUNCTION_SIGNATURES,
    new Map([
        ['DATE', [{ name: 'DATE', parameters: ['timestring', 'modifier'], description: 'Returns an ISO-8601 date.' }]],
        ['DATETIME', [{ name: 'DATETIME', parameters: ['timestring', 'modifier'], description: 'Returns an ISO-8601 date/time value.' }]],
        ['GROUP_CONCAT', [{ name: 'GROUP_CONCAT', parameters: ['expression', 'separator'], description: 'Concatenates non-null values.' }]],
        ['JSON_EXTRACT', [{ name: 'JSON_EXTRACT', parameters: ['json', 'path'], description: 'Extracts a value from JSON.' }]],
        ['PRINTF', [{ name: 'PRINTF', parameters: ['format', 'value'], description: 'Formats values using a printf-style format.' }]],
        ['STRFTIME', [{ name: 'STRFTIME', parameters: ['format', 'timestring', 'modifier'], description: 'Formats a date/time value.' }]],
    ]),
);

const sqliteFormatterProfile: DatabaseSqlFormatterProfile = extendFormatterProfile(
    BASE_SQL_FORMATTER_PROFILE,
    {
        keywords: [
            'ATTACH', 'AUTOINCREMENT', 'COLLATE', 'CONFLICT', 'DETACH', 'GENERATED',
            'INDEX', 'PRAGMA', 'REINDEX', 'RETURNING', 'SAVEPOINT', 'STRICT', 'TRIGGER',
            'VACUUM', 'VIRTUAL', 'WINDOW', 'WITHOUT',
        ],
        clauseKeywords: [
            'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'RETURNING', 'WINDOW',
        ],
        newlineBeforeKeywords: [
            'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'RETURNING', 'WINDOW',
        ],
    },
);

const sqliteValidationProfile: DatabaseSqlValidationProfile = {
    databaseKind: 'sqlite',
    builtinFunctions: SQLITE_BUILTIN_FUNCTIONS,
    systemColumns: new Set(),
    specialBuiltinValues: SQLITE_SPECIAL_BUILTIN_VALUES,
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        const normalized = typeName.trim().toUpperCase().replace(/\s+/g, ' ');
        // SQLite accepts arbitrary declared type names.  Known names get
        // parameter validation; unknown names are left to SQLite affinity.
        return SQLITE_TYPE_SPECS[normalized];
    },
    supportsProcedureAnySizeArgument(): boolean {
        return false;
    },
    syntaxValidationMode: 'strict',
};

export const sqliteSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: SQLITE_COMPLETION_KEYWORDS,
    signatures: SQLITE_SIGNATURES,
    formatter: sqliteFormatterProfile,
    validation: sqliteValidationProfile,
    qualityRules: sqliteSqlQualityRules,
    parsing: {
        lexerModulePath: 'src/dialects/sqlite/sql/lexer.ts',
        parserModulePath: 'src/dialects/sqlite/sql/parser.ts',
    },
    staticAssets: {
        snippetsPath: 'dialects/sqlite/snippets/sqlite.code-snippets',
        grammarPath: 'dialects/sqlite/syntaxes/sqlite.tmLanguage.json',
        grammarScopeName: 'sqlite.injection',
    },
};
