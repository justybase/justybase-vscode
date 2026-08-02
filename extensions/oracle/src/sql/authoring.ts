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
    mergeUniqueStrings,
    replaceFunctionSignatures
} from '../../../../src/sql/authoring/baseProfiles';
import { oracleSqlQualityRules } from './qualityRules';

const ORACLE_COMPLETION_KEYWORD_OVERLAYS = [
    'FUNCTION',
    'PACKAGE',
    'TRIGGER',
    'SYNONYM',
    'INDEX',
    'MATERIALIZED VIEW',
    'COMMIT',
    'ROLLBACK',
    'SAVEPOINT',
    'RETURNING INTO',
    'PIVOT',
    'UNPIVOT',
    'CONNECT BY',
    'START WITH',
    'FETCH FIRST',
    'FETCH NEXT',
    'ROWNUM',
    'DUAL'
] as const;

const ORACLE_COMPLETION_KEYWORDS = mergeUniqueStrings(
    BASE_SQL_COMPLETION_KEYWORDS,
    ORACLE_COMPLETION_KEYWORD_OVERLAYS
);

const ORACLE_BUILTIN_FUNCTION_OVERLAYS = new Set<string>([
    'CAST',
    'CURRENT_DATE',
    'CURRENT_TIMESTAMP',
    'INSTR',
    'DBMS_METADATA.GET_DDL',
    'REGEXP_LIKE',
    'REGEXP_REPLACE',
    'REGEXP_SUBSTR',
    'SYSDATE',
    'SYSTIMESTAMP',
    'SYS_CONTEXT',
    'TO_CLOB',
    'UID'
]);

const ORACLE_SPECIAL_BUILTIN_VALUE_OVERLAYS = new Set<string>([
    'NULL',
    'SYSDATE',
    'SYSTIMESTAMP'
]);

const ORACLE_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
    NUMBER: { canonical: 'NUMBER', paramsMin: 0, paramsMax: 2 },
    FLOAT: { canonical: 'FLOAT', paramsMin: 0, paramsMax: 1 },
    BINARY_FLOAT: { canonical: 'BINARY_FLOAT', paramsMin: 0, paramsMax: 0 },
    BINARY_DOUBLE: { canonical: 'BINARY_DOUBLE', paramsMin: 0, paramsMax: 0 },
    CHAR: { canonical: 'CHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    NCHAR: { canonical: 'NCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    VARCHAR2: { canonical: 'VARCHAR2', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    NVARCHAR2: { canonical: 'NVARCHAR2', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    RAW: { canonical: 'RAW', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
    DATE: { canonical: 'DATE', paramsMin: 0, paramsMax: 0 },
    TIMESTAMP: { canonical: 'TIMESTAMP', paramsMin: 0, paramsMax: 1 },
    'TIMESTAMP WITH TIME ZONE': { canonical: 'TIMESTAMP WITH TIME ZONE', paramsMin: 0, paramsMax: 1 },
    'TIMESTAMP WITH LOCAL TIME ZONE': { canonical: 'TIMESTAMP WITH LOCAL TIME ZONE', paramsMin: 0, paramsMax: 1 },
    CLOB: { canonical: 'CLOB', paramsMin: 0, paramsMax: 0 },
    NCLOB: { canonical: 'NCLOB', paramsMin: 0, paramsMax: 0 },
    BLOB: { canonical: 'BLOB', paramsMin: 0, paramsMax: 0 },
    LONG: { canonical: 'LONG', paramsMin: 0, paramsMax: 0 },
    'LONG RAW': { canonical: 'LONG RAW', paramsMin: 0, paramsMax: 0 },
    ROWID: { canonical: 'ROWID', paramsMin: 0, paramsMax: 0 },
    UROWID: { canonical: 'UROWID', paramsMin: 0, paramsMax: 1 },
    BOOLEAN: { canonical: 'BOOLEAN', paramsMin: 0, paramsMax: 0 },
    XMLTYPE: { canonical: 'XMLTYPE', paramsMin: 0, paramsMax: 0 },
    JSON: { canonical: 'JSON', paramsMin: 0, paramsMax: 0 },
    'INTERVAL YEAR TO MONTH': { canonical: 'INTERVAL YEAR TO MONTH', paramsMin: 1, paramsMax: 1 },
    'INTERVAL DAY TO SECOND': { canonical: 'INTERVAL DAY TO SECOND', paramsMin: 1, paramsMax: 1 }
};

/** Functions whose Oracle signature supersedes the ANSI base signature (same name, different arity/defaults). */
const ORACLE_SIGNATURE_REPLACEMENTS: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> = new Map([
    ['COUNT', [{
        name: 'COUNT',
        parameters: ['expression'],
        description: 'Returns the number of non-null values for the expression.'
    }]],
    ['COALESCE', [{
        name: 'COALESCE',
        parameters: ['value1', 'value2', '...'],
        description: 'Returns the first non-null argument.'
    }]],
    ['TO_CHAR', [{
        name: 'TO_CHAR',
        parameters: ['value', 'format?'],
        description: 'Converts a value to VARCHAR2 using an optional format mask.'
    }]],
    ['SUBSTR', [{
        name: 'SUBSTR',
        parameters: ['value', 'start', 'length?'],
        description: 'Returns a substring starting at the given offset.'
    }]],
    ['TO_DATE', [{
        name: 'TO_DATE',
        parameters: ['value', 'format?'],
        description: 'Converts text to an Oracle DATE using an optional format mask.',
        example: "TO_DATE('2026-01-31', 'YYYY-MM-DD')",
    }]]
]);

const ORACLE_SIGNATURE_OVERLAYS: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> = new Map([
    [
        'NVL',
        [{
            name: 'NVL',
            parameters: ['value', 'fallback'],
            description: 'Returns the fallback when the value is null.'
        }]
    ],
    [
        'SYS_CONTEXT',
        [{
            name: 'SYS_CONTEXT',
            parameters: ['namespace', 'parameter'],
            description: 'Returns the value of an Oracle application or USERENV context.'
        }]
    ],
    [
        'REGEXP_LIKE',
        [{
            name: 'REGEXP_LIKE',
            parameters: ['source', 'pattern', 'match_parameter?'],
            description: 'Tests whether a source value matches a regular expression.',
        }]
    ],
    [
        'ADD_MONTHS',
        [{
            name: 'ADD_MONTHS',
            parameters: ['date', 'months'],
            description: 'Returns a date shifted by the requested number of months.',
        }]
    ]
]);

const ORACLE_SIGNATURES = replaceFunctionSignatures(
    mergeFunctionSignatures(BASE_SQL_FUNCTION_SIGNATURES, ORACLE_SIGNATURE_OVERLAYS),
    ORACLE_SIGNATURE_REPLACEMENTS
);

const oracleFormatterProfile = extendFormatterProfile(BASE_SQL_FORMATTER_PROFILE, {
    keywords: [
        ...ORACLE_COMPLETION_KEYWORD_OVERLAYS,
        'NEXT',
        'CONNECT',
        'START',
        'RETURNING',
        'PRIOR',
        'NOCYCLE',
        'SIBLINGS'
    ],
    clauseKeywords: ['GROUP BY', 'ORDER BY', 'CONNECT BY', 'START WITH'],
    newlineBeforeKeywords: ['GROUP BY', 'ORDER BY', 'CONNECT BY', 'START WITH']
});

const oracleValidationProfile: DatabaseSqlValidationProfile = {
    builtinFunctions: mergeStringSets(BASE_SQL_BUILTIN_FUNCTIONS, ORACLE_BUILTIN_FUNCTION_OVERLAYS),
    systemColumns: new Set(),
    specialBuiltinValues: mergeStringSets(BASE_SQL_SPECIAL_BUILTIN_VALUES, ORACLE_SPECIAL_BUILTIN_VALUE_OVERLAYS),
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        if (!typeName) return undefined;
        return ORACLE_TYPE_SPECS[typeName.trim().toUpperCase()];
    },
    supportsProcedureAnySizeArgument(): boolean {
        return false;
    },
    syntaxValidationMode: 'strict',
};

export const oracleSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: ORACLE_COMPLETION_KEYWORDS,
    signatures: ORACLE_SIGNATURES,
    formatter: oracleFormatterProfile,
    validation: oracleValidationProfile,
    qualityRules: oracleSqlQualityRules,
    parsing: {
        lexerModulePath: 'src/dialects/oracle/sql/lexer.ts',
        parserModulePath: 'src/dialects/oracle/sql/parser.ts',
    },
    staticAssets: {
        snippetsPath: 'dialects/oracle/snippets/oracle.code-snippets',
        grammarPath: 'dialects/oracle/syntaxes/oracle.tmLanguage.json',
        grammarScopeName: 'oracle.injection',
    },
};
