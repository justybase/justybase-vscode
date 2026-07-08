import type {
    DatabaseSqlAuthoring,
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile
} from '../../../../src/sql/authoring/types';

const ORACLE_COMPLETION_KEYWORDS = [
    'SELECT',
    'FROM',
    'WHERE',
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'BEGIN',
    'DECLARE',
    'CALL',
    'CREATE',
    'ALTER',
    'DROP',
    'TABLE',
    'VIEW',
    'SEQUENCE',
    'PROCEDURE',
    'FUNCTION',
    'PACKAGE',
    'TRIGGER',
    'SYNONYM',
    'ORDER BY',
    'GROUP BY',
    'CONNECT BY',
    'START WITH',
    'FETCH FIRST',
    'FETCH NEXT',
    'ROWNUM',
    'DUAL'
] as const;

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
    BLOB: { canonical: 'BLOB', paramsMin: 0, paramsMax: 0 }
};

const ORACLE_SIGNATURES = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
    [
        'COUNT',
        [{
            name: 'COUNT',
            parameters: ['expression'],
            description: 'Returns the number of non-null values for the expression.'
        }]
    ],
    [
        'NVL',
        [{
            name: 'NVL',
            parameters: ['value', 'fallback'],
            description: 'Returns the fallback when the value is null.'
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
        'TO_CHAR',
        [{
            name: 'TO_CHAR',
            parameters: ['value', 'format?'],
            description: 'Converts a value to VARCHAR2 using an optional format mask.'
        }]
    ],
    [
        'SUBSTR',
        [{
            name: 'SUBSTR',
            parameters: ['value', 'start', 'length?'],
            description: 'Returns a substring starting at the given offset.'
        }]
    ],
    [
        'SYS_CONTEXT',
        [{
            name: 'SYS_CONTEXT',
            parameters: ['namespace', 'parameter'],
            description: 'Returns the value of an Oracle application or USERENV context.'
        }]
    ]
]);

const oracleFormatterProfile: DatabaseSqlFormatterProfile = {
    keywords: new Set([
        'SELECT',
        'FROM',
        'WHERE',
        'GROUP',
        'BY',
        'ORDER',
        'FETCH',
        'FIRST',
        'NEXT',
        'ROWS',
        'ROW',
        'ONLY',
        'INSERT',
        'UPDATE',
        'DELETE',
        'MERGE',
        'INTO',
        'VALUES',
        'SET',
        'WITH',
        'CONNECT',
        'START',
        'JOIN',
        'INNER',
        'LEFT',
        'RIGHT',
        'FULL',
        'OUTER',
        'CROSS',
        'ON',
        'AND',
        'OR',
        'NOT',
        'NULL',
        'AS',
        'BEGIN',
        'DECLARE',
        'END',
        'EXCEPTION',
        'CREATE',
        'ALTER',
        'DROP',
        'TABLE',
        'VIEW',
        'PACKAGE',
        'PROCEDURE',
        'FUNCTION',
        'TRIGGER',
        'SEQUENCE',
        'SYNONYM'
    ]),
    clauseKeywords: new Set(['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'SET', 'VALUES', 'ON', 'CONNECT BY', 'START WITH']),
    newlineBeforeKeywords: new Set(['FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'SET', 'VALUES', 'CONNECT BY', 'START WITH']),
    joinModifiers: new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS']),
    commaNewlineClauses: new Set(['SELECT']),
    logicalBreakKeywords: new Set(['AND', 'OR'])
};

const oracleValidationProfile: DatabaseSqlValidationProfile = {
    builtinFunctions: new Set([
        'ABS',
        'AVG',
        'COALESCE',
        'COUNT',
        'CURRENT_DATE',
        'CURRENT_TIMESTAMP',
        'DBMS_METADATA.GET_DDL',
        'LOWER',
        'MAX',
        'MIN',
        'NVL',
        'ROUND',
        'SUBSTR',
        'SUM',
        'SYSDATE',
        'SYSTIMESTAMP',
        'SYS_CONTEXT',
        'TO_CHAR',
        'TO_DATE',
        'TO_NUMBER',
        'TO_TIMESTAMP',
        'UPPER'
    ]),
    systemColumns: new Set(),
    specialBuiltinValues: new Set([
        'NULL',
        'CURRENT_DATE',
        'CURRENT_TIMESTAMP',
        'CURRENT_SCHEMA',
        'CURRENT_USER',
        'SYSDATE',
        'SYSTIMESTAMP'
    ]),
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        if (!typeName) return undefined;
        return ORACLE_TYPE_SPECS[typeName.trim().toUpperCase()];
    },
    supportsProcedureAnySizeArgument(): boolean {
        return false;
    },
    syntaxValidationMode: 'bestEffort'
};

export const oracleSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: ORACLE_COMPLETION_KEYWORDS,
    signatures: ORACLE_SIGNATURES,
    formatter: oracleFormatterProfile,
    validation: oracleValidationProfile,
    qualityRules: []
};
