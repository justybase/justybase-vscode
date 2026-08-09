import type {
    DatabaseSqlAuthoring,
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile
} from '../../../sql/authoring/types';

const ACCESS_COMPLETION_KEYWORDS = [
    'SELECT',
    'FROM',
    'WHERE',
    'INSERT',
    'UPDATE',
    'DELETE',
    'CREATE',
    'TABLE',
    'VIEW',
    'ORDER BY',
    'GROUP BY',
    'LIMIT',
    'TOP',
    'DISTINCT',
    'DISTINCTROW',
    'INNER JOIN',
    'LEFT JOIN',
    'RIGHT JOIN'
] as const;

const ACCESS_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
    TEXT: { canonical: 'TEXT', paramsMin: 1, paramsMax: 255, warnIfNoLength: true },
    CHAR: { canonical: 'CHAR', paramsMin: 1, paramsMax: 255, warnIfNoLength: true },
    MEMO: { canonical: 'MEMO', paramsMin: 0, paramsMax: 0 },
    LONGVARCHAR: { canonical: 'MEMO', paramsMin: 0, paramsMax: 0 },
    INTEGER: { canonical: 'INTEGER', paramsMin: 0, paramsMax: 0 },
    COUNTER: { canonical: 'COUNTER', paramsMin: 0, paramsMax: 0 },
    BIGINT: { canonical: 'BIGINT', paramsMin: 0, paramsMax: 0 },
    SMALLINT: { canonical: 'SMALLINT', paramsMin: 0, paramsMax: 0 },
    DOUBLE: { canonical: 'DOUBLE', paramsMin: 0, paramsMax: 0 },
    SINGLE: { canonical: 'SINGLE', paramsMin: 0, paramsMax: 0 },
    CURRENCY: { canonical: 'CURRENCY', paramsMin: 0, paramsMax: 0 },
    DECIMAL: { canonical: 'DECIMAL', paramsMin: 1, paramsMax: 2, warnIfNoLength: true },
    NUMERIC: { canonical: 'DECIMAL', paramsMin: 1, paramsMax: 2, warnIfNoLength: true },
    DATETIME: { canonical: 'DATETIME', paramsMin: 0, paramsMax: 0 },
    TIMESTAMP: { canonical: 'DATETIME', paramsMin: 0, paramsMax: 0 },
    DATE: { canonical: 'DATETIME', paramsMin: 0, paramsMax: 0 },
    BOOLEAN: { canonical: 'BOOLEAN', paramsMin: 0, paramsMax: 0 },
    YESNO: { canonical: 'BOOLEAN', paramsMin: 0, paramsMax: 0 },
    BIT: { canonical: 'BOOLEAN', paramsMin: 0, paramsMax: 0 },
    OLE: { canonical: 'OLE', paramsMin: 0, paramsMax: 0 },
    VARBINARY: { canonical: 'OLE', paramsMin: 0, paramsMax: 0 },
    GUID: { canonical: 'GUID', paramsMin: 0, paramsMax: 0 },
    HYPERLINK: { canonical: 'MEMO', paramsMin: 0, paramsMax: 0 }
};

const ACCESS_SIGNATURES = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
    ['COUNT', [{
        name: 'COUNT',
        parameters: ['expression'],
        description: 'Returns the number of non-null values for the expression.'
    }]],
    ['SUM', [{
        name: 'SUM',
        parameters: ['expression'],
        description: 'Returns the sum of the expression values.'
    }]],
    ['AVG', [{
        name: 'AVG',
        parameters: ['expression'],
        description: 'Returns the average of the expression values.'
    }]],
    ['MIN', [{
        name: 'MIN',
        parameters: ['expression'],
        description: 'Returns the minimum value of the expression.'
    }]],
    ['MAX', [{
        name: 'MAX',
        parameters: ['expression'],
        description: 'Returns the maximum value of the expression.'
    }]],
    ['IIF', [{
        name: 'IIF',
        parameters: ['condition', 'valueIfTrue', 'valueIfFalse'],
        description: 'Returns one of two values depending on the condition.'
    }]],
    ['NZ', [{
        name: 'NZ',
        parameters: ['value', 'valueIfNull'],
        description: 'Returns the value, or valueIfNull when the value is Null.'
    }]],
    ['DATEDIFF', [{
        name: 'DATEDIFF',
        parameters: ['interval', 'date1', 'date2'],
        description: 'Returns the difference between two dates in the given interval.'
    }]],
    ['LEFT', [{
        name: 'LEFT',
        parameters: ['value', 'length'],
        description: 'Returns the leftmost characters of a string.'
    }]],
    ['RIGHT', [{
        name: 'RIGHT',
        parameters: ['value', 'length'],
        description: 'Returns the rightmost characters of a string.'
    }]],
    ['MID', [{
        name: 'MID',
        parameters: ['value', 'start', 'length'],
        description: 'Returns a substring starting at the given offset.'
    }]],
    ['LEN', [{
        name: 'LEN',
        parameters: ['value'],
        description: 'Returns the length of a string.'
    }]],
    ['UPPER', [{
        name: 'UPPER',
        parameters: ['value'],
        description: 'Returns the string converted to upper case.'
    }]],
    ['LOWER', [{
        name: 'LOWER',
        parameters: ['value'],
        description: 'Returns the string converted to lower case.'
    }]],
    ['ROUND', [{
        name: 'ROUND',
        parameters: ['value', 'decimalPlaces'],
        description: 'Rounds a number to the given number of decimal places.'
    }]],
    ['ABS', [{
        name: 'ABS',
        parameters: ['number'],
        description: 'Returns the absolute value of a number.'
    }]],
    ['TRIM', [{
        name: 'TRIM',
        parameters: ['value'],
        description: 'Removes leading and trailing spaces from a string.'
    }]]
]);

const accessFormatterProfile: DatabaseSqlFormatterProfile = {
    keywords: new Set(ACCESS_COMPLETION_KEYWORDS),
    clauseKeywords: new Set(['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT']),
    newlineBeforeKeywords: new Set(['FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT']),
    joinModifiers: new Set(['INNER', 'LEFT', 'RIGHT', 'OUTER', 'ON']),
    commaNewlineClauses: new Set(['SELECT']),
    logicalBreakKeywords: new Set(['AND', 'OR'])
};

const accessValidationProfile: DatabaseSqlValidationProfile = {
    builtinFunctions: new Set([
        'ABS', 'ASC', 'AVG', 'COUNT', 'DATEDIFF', 'DATEADD', 'DATESERIAL', 'DATEVALUE',
        'DAY', 'HOUR', 'IIF', 'INSTR', 'INT', 'LEN', 'LEFT', 'RIGHT', 'MID', 'MIN', 'MAX',
        'MONTH', 'NOW', 'NZ', 'ROUND', 'RTRIM', 'LTRIM', 'SUM', 'TIME', 'TIMEVALUE', 'TRIM',
        'UPPER', 'LOWER', 'UCASE', 'LCASE', 'YEAR'
    ]),
    systemColumns: new Set(),
    specialBuiltinValues: new Set(['NULL', 'TRUE', 'FALSE', 'DATE()', 'NOW()', 'TIME()']),
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
        if (!typeName) {
            return undefined;
        }
        const normalized = typeName.trim().toUpperCase();
        const direct = ACCESS_TYPE_SPECS[normalized];
        if (direct) {
            return direct;
        }
        if (normalized.startsWith('VARCHAR')) {
            return ACCESS_TYPE_SPECS.TEXT;
        }
        if (normalized.startsWith('TIMESTAMP')) {
            return ACCESS_TYPE_SPECS.DATETIME;
        }
        return undefined;
    },
    supportsProcedureAnySizeArgument(): boolean {
        return false;
    }
};

export const accessSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: ACCESS_COMPLETION_KEYWORDS,
    signatures: ACCESS_SIGNATURES,
    formatter: accessFormatterProfile,
    validation: accessValidationProfile,
    qualityRules: []
};
