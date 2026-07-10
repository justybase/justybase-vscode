import type {
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature
} from './types';

export const BASE_SQL_COMPLETION_KEYWORDS = [
    'SELECT',
    'FROM',
    'WHERE',
    'GROUP BY',
    'ORDER BY',
    'LIMIT',
    'OFFSET',
    'INSERT',
    'INTO',
    'VALUES',
    'UPDATE',
    'SET',
    'DELETE',
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
    'TABLE',
    'VIEW',
    'DATABASE',
    'SCHEMA',
    'SEQUENCE',
    'PROCEDURE',
    'REPLACE',
    'TEMP',
    'TEMPORARY',
    'EXPLAIN',
    'VERBOSE',
    'WITH',
    'RECURSIVE',
    'JOIN',
    'INNER',
    'LEFT',
    'RIGHT',
    'FULL',
    'OUTER',
    'CROSS',
    'NATURAL',
    'ONLY',
    'ON',
    'AND',
    'OR',
    'NOT',
    'NULL',
    'NULLS',
    'IS',
    'IN',
    'BETWEEN',
    'LIKE',
    'ILIKE',
    'EXISTS',
    'AS',
    'DISTINCT',
    'ALL',
    'ANY',
    'SOME',
    'UNION',
    'INTERSECT',
    'EXCEPT',
    'CASE',
    'WHEN',
    'THEN',
    'ELSE',
    'END',
    'FETCH',
    'FIRST',
    'ROW',
    'ROWS',
    'RANGE',
    'OVER',
    'PARTITION BY',
    'ASC',
    'DESC',
    'BEGIN',
    'DECLARE',
    'EXCEPTION',
    'RETURN',
    'IF',
    'ELSIF',
    'LOOP',
    'WHILE',
    'EXIT',
    'RAISE',
    'CALL',
    'EXECUTE',
    'EXEC',
    'USING',
    'LANGUAGE',
    'RETURNS',
    'COMMENT',
    'ADD',
    'CONSTRAINT',
    'PRIMARY',
    'FOREIGN',
    'REFERENCES',
    'UNIQUE',
    'CHECK',
    'GRANT',
    'REVOKE',
    'TO',
    'PUBLIC',
    'OWNER',
    'MERGE',
    'MATCHED'
] as const;

export const BASE_SQL_FORMATTER_PROFILE: DatabaseSqlFormatterProfile = {
    keywords: new Set([
        'SELECT',
        'FROM',
        'WHERE',
        'GROUP',
        'BY',
        'ORDER',
        'HAVING',
        'LIMIT',
        'OFFSET',
        'INSERT',
        'INTO',
        'VALUES',
        'UPDATE',
        'SET',
        'DELETE',
        'CREATE',
        'ALTER',
        'DROP',
        'TRUNCATE',
        'TABLE',
        'VIEW',
        'DATABASE',
        'SCHEMA',
        'SEQUENCE',
        'PROCEDURE',
        'REPLACE',
        'TEMP',
        'TEMPORARY',
        'EXPLAIN',
        'VERBOSE',
        'WITH',
        'RECURSIVE',
        'JOIN',
        'INNER',
        'LEFT',
        'RIGHT',
        'FULL',
        'OUTER',
        'CROSS',
        'NATURAL',
        'ONLY',
        'ON',
        'AND',
        'OR',
        'NOT',
        'NULL',
        'NULLS',
        'IS',
        'IN',
        'BETWEEN',
        'LIKE',
        'ILIKE',
        'EXISTS',
        'AS',
        'DISTINCT',
        'ALL',
        'ANY',
        'SOME',
        'UNION',
        'INTERSECT',
        'EXCEPT',
        'CASE',
        'WHEN',
        'THEN',
        'ELSE',
        'END',
        'FETCH',
        'FIRST',
        'ROW',
        'ROWS',
        'RANGE',
        'OVER',
        'PARTITION',
        'ASC',
        'DESC',
        'BEGIN',
        'DECLARE',
        'EXCEPTION',
        'RETURN',
        'IF',
        'ELSIF',
        'LOOP',
        'WHILE',
        'EXIT',
        'RAISE',
        'CALL',
        'EXECUTE',
        'EXEC',
        'USING',
        'LANGUAGE',
        'RETURNS',
        'COMMENT',
        'ADD',
        'CONSTRAINT',
        'PRIMARY',
        'FOREIGN',
        'REFERENCES',
        'UNIQUE',
        'CHECK',
        'GRANT',
        'REVOKE',
        'TO',
        'PUBLIC',
        'OWNER',
        'MERGE',
        'MATCHED'
    ]),
    clauseKeywords: new Set(['SELECT', 'FROM', 'WHERE', 'HAVING', 'SET', 'VALUES', 'ON', 'USING']),
    newlineBeforeKeywords: new Set([
        'SELECT',
        'FROM',
        'WHERE',
        'HAVING',
        'SET',
        'VALUES',
        'ON',
        'USING',
        'UNION',
        'INTERSECT',
        'EXCEPT',
        'RETURNING',
        'LIMIT',
        'OFFSET',
    ]),
    joinModifiers: new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER']),
    commaNewlineClauses: new Set(['SELECT', 'FROM', 'SET', 'GROUP', 'ORDER', 'VALUES']),
    logicalBreakKeywords: new Set(['AND', 'OR'])
};

export const BASE_SQL_BUILTIN_FUNCTIONS = new Set<string>([
    'AVG',
    'COUNT',
    'MAX',
    'MIN',
    'SUM',
    'STDDEV',
    'STDDEV_POP',
    'STDDEV_SAMP',
    'VARIANCE',
    'VAR_POP',
    'VAR_SAMP',
    'ABS',
    'ACOS',
    'ASIN',
    'ATAN',
    'ATAN2',
    'CEIL',
    'CEILING',
    'COS',
    'COT',
    'DEGREES',
    'EXP',
    'FLOOR',
    'LN',
    'LOG',
    'LOG10',
    'MOD',
    'PI',
    'POWER',
    'RADIANS',
    'RANDOM',
    'ROUND',
    'SIGN',
    'SIN',
    'SQRT',
    'TAN',
    'TRUNC',
    'WIDTH_BUCKET',
    'ASCII',
    'CHAR_LENGTH',
    'CHARACTER_LENGTH',
    'CHR',
    'CONCAT',
    'INITCAP',
    'LEFT',
    'LENGTH',
    'LOWER',
    'LPAD',
    'LTRIM',
    'OCTET_LENGTH',
    'POSITION',
    'REPLACE',
    'REPEAT',
    'REVERSE',
    'RIGHT',
    'RPAD',
    'RTRIM',
    'SPLIT_PART',
    'SUBSTR',
    'SUBSTRING',
    'TRANSLATE',
    'TRIM',
    'UPPER',
    'COALESCE',
    'DECODE',
    'GREATEST',
    'LEAST',
    'NULLIF',
    'NVL',
    'NVL2',
    'NOW',
    'YEAR',
    'MONTH',
    'DAY',
    'HOUR',
    'MINUTE',
    'SECOND',
    'DATE_PART',
    'DATE_TRUNC',
    'TO_TIMESTAMP',
    'TO_CHAR',
    'TO_DATE',
    'TO_NUMBER',
    'LAST_DAY',
    'ADD_MONTHS',
    'MONTHS_BETWEEN',
    'NEXT_DAY',
    'EXTRACT',
    'AGE',
    'ISFINITE',
    'JUSTIFY_DAYS',
    'JUSTIFY_HOURS',
    'JUSTIFY_INTERVAL',
    'QUOTE_IDENT',
    'QUOTE_LITERAL',
    'ROW_NUMBER',
    'RANK',
    'DENSE_RANK',
    'PERCENT_RANK',
    'CUME_DIST',
    'NTILE',
    'LAG',
    'LEAD',
    'FIRST_VALUE',
    'LAST_VALUE',
    'NTH_VALUE'
]);

export const BASE_SQL_SPECIAL_BUILTIN_VALUES = new Set<string>([
    'CURRENT_TIMESTAMP',
    'CURRENT_DATE',
    'CURRENT_TIME',
    'CURRENT_USER',
    'SESSION_USER',
    'SYSTEM_USER',
    'CURRENT_CATALOG',
    'CURRENT_SCHEMA'
]);

export const BASE_SQL_FUNCTION_SIGNATURES: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> = new Map([
    ['COUNT', [
        { name: 'COUNT', parameters: ['expression'], description: 'Count non-null values' },
        { name: 'COUNT', parameters: ['*'], description: 'Count all rows' },
        { name: 'COUNT', parameters: ['DISTINCT expression'], description: 'Count distinct non-null values' }
    ]],
    ['SUM', [
        { name: 'SUM', parameters: ['expression'], description: 'Sum of values' },
        { name: 'SUM', parameters: ['DISTINCT expression'], description: 'Sum of distinct values' }
    ]],
    ['AVG', [
        { name: 'AVG', parameters: ['expression'], description: 'Average of values' },
        { name: 'AVG', parameters: ['DISTINCT expression'], description: 'Average of distinct values' }
    ]],
    ['MIN', [
        { name: 'MIN', parameters: ['expression'], description: 'Minimum value' }
    ]],
    ['MAX', [
        { name: 'MAX', parameters: ['expression'], description: 'Maximum value' }
    ]],
    ['SUBSTRING', [
        { name: 'SUBSTRING', parameters: ['string', 'start', 'length'], description: 'Extract substring' },
        { name: 'SUBSTRING', parameters: ['string FROM start FOR length'], description: 'Extract substring (SQL standard)' }
    ]],
    ['SUBSTR', [
        { name: 'SUBSTR', parameters: ['string', 'start'], description: 'Extract substring from start' },
        { name: 'SUBSTR', parameters: ['string', 'start', 'length'], description: 'Extract substring' }
    ]],
    ['CONCAT', [
        { name: 'CONCAT', parameters: ['string1', 'string2', '...'], description: 'Concatenate strings' }
    ]],
    ['LPAD', [
        { name: 'LPAD', parameters: ['string', 'length', 'fill'], description: 'Left-pad string' }
    ]],
    ['RPAD', [
        { name: 'RPAD', parameters: ['string', 'length', 'fill'], description: 'Right-pad string' }
    ]],
    ['TRIM', [
        { name: 'TRIM', parameters: ['string'], description: 'Remove leading/trailing whitespace' },
        { name: 'TRIM', parameters: ['LEADING characters FROM string'], description: 'Remove leading characters' },
        { name: 'TRIM', parameters: ['TRAILING characters FROM string'], description: 'Remove trailing characters' },
        { name: 'TRIM', parameters: ['BOTH characters FROM string'], description: 'Remove leading and trailing characters' }
    ]],
    ['REPLACE', [
        { name: 'REPLACE', parameters: ['string', 'from', 'to'], description: 'Replace all occurrences' }
    ]],
    ['SPLIT_PART', [
        { name: 'SPLIT_PART', parameters: ['string', 'delimiter', 'field'], description: 'Split string and return part' }
    ]],
    ['TO_DATE', [
        {
            name: 'TO_DATE',
            parameters: ['value', 'format'],
            description: 'Convert a value to date using the specified format mask.',
            example: "SELECT TO_DATE(20260605, 'YYYYMMDD');"
        }
    ]],
    ['TO_TIMESTAMP', [
        { name: 'TO_TIMESTAMP', parameters: ['string', 'format'], description: 'Convert string to timestamp' }
    ]],
    ['TO_CHAR', [
        {
            name: 'TO_CHAR',
            parameters: ['value', 'format'],
            description: 'Convert a value to formatted string using the specified format mask.',
            example: "SELECT TO_CHAR(CURRENT_DATE, 'YYYYMMDD');"
        }
    ]],
    ['DATE_PART', [
        { name: 'DATE_PART', parameters: ['field', 'source'], description: 'Extract date part' }
    ]],
    ['DATE_TRUNC', [
        { name: 'DATE_TRUNC', parameters: ['field', 'source'], description: 'Truncate to precision' }
    ]],
    ['EXTRACT', [
        { name: 'EXTRACT', parameters: ['field FROM source'], description: 'Extract date/time field' }
    ]],
    ['COALESCE', [
        { name: 'COALESCE', parameters: ['value1', 'value2', '...'], description: 'Return first non-null value' }
    ]],
    ['NULLIF', [
        { name: 'NULLIF', parameters: ['value1', 'value2'], description: 'Return NULL if values are equal' }
    ]],
    ['ROUND', [
        { name: 'ROUND', parameters: ['value'], description: 'Round to integer' },
        { name: 'ROUND', parameters: ['value', 'decimals'], description: 'Round to specified decimals' }
    ]],
    ['TRUNC', [
        { name: 'TRUNC', parameters: ['value'], description: 'Truncate to integer' },
        { name: 'TRUNC', parameters: ['value', 'decimals'], description: 'Truncate to specified decimals' }
    ]],
    ['POWER', [
        { name: 'POWER', parameters: ['base', 'exponent'], description: 'Raise to power' }
    ]],
    ['MOD', [
        { name: 'MOD', parameters: ['dividend', 'divisor'], description: 'Modulo operation' }
    ]],
    ['WIDTH_BUCKET', [
        { name: 'WIDTH_BUCKET', parameters: ['value', 'min', 'max', 'buckets'], description: 'Assign to bucket' }
    ]],
    ['ROW_NUMBER', [
        { name: 'ROW_NUMBER', parameters: ['OVER (ORDER BY ...)'], description: 'Row number in partition' }
    ]],
    ['RANK', [
        { name: 'RANK', parameters: ['OVER (ORDER BY ...)'], description: 'Rank with gaps' }
    ]],
    ['DENSE_RANK', [
        { name: 'DENSE_RANK', parameters: ['OVER (ORDER BY ...)'], description: 'Rank without gaps' }
    ]],
    ['LAG', [
        { name: 'LAG', parameters: ['expression', 'offset', 'default'], description: 'Previous row value' }
    ]],
    ['LEAD', [
        { name: 'LEAD', parameters: ['expression', 'offset', 'default'], description: 'Next row value' }
    ]],
    ['FIRST_VALUE', [
        { name: 'FIRST_VALUE', parameters: ['expression OVER (ORDER BY ...)'], description: 'First value in window' }
    ]],
    ['LAST_VALUE', [
        { name: 'LAST_VALUE', parameters: ['expression OVER (ORDER BY ...)'], description: 'Last value in window' }
    ]],
    ['NTH_VALUE', [
        { name: 'NTH_VALUE', parameters: ['expression', 'n'], description: 'Nth value in window' }
    ]],
    ['CAST', [
        { name: 'CAST', parameters: ['expression AS type'], description: 'Convert type' }
    ]]
]);

export function mergeUniqueStrings(...sources: ReadonlyArray<Iterable<string>>): string[] {
    const seen = new Set<string>();
    const values: string[] = [];

    for (const source of sources) {
        for (const value of source) {
            if (seen.has(value)) {
                continue;
            }
            seen.add(value);
            values.push(value);
        }
    }

    return values;
}

export function mergeStringSets(...sources: ReadonlyArray<Iterable<string>>): ReadonlySet<string> {
    return new Set(mergeUniqueStrings(...sources));
}

export function mergeFunctionSignatures(
    ...sources: ReadonlyArray<ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]>>
): ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> {
    const merged = new Map<string, readonly DatabaseSqlFunctionSignature[]>();

    for (const source of sources) {
        for (const [name, signatures] of source.entries()) {
            const existing = merged.get(name);
            if (!existing) {
                merged.set(name, [...signatures]);
                continue;
            }

            merged.set(name, [...existing, ...signatures]);
        }
    }

    return merged;
}

export function extendFormatterProfile(
    baseProfile: DatabaseSqlFormatterProfile,
    overlay: Partial<Record<keyof DatabaseSqlFormatterProfile, Iterable<string>>>
): DatabaseSqlFormatterProfile {
    return {
        keywords: mergeStringSets(baseProfile.keywords, overlay.keywords ?? []),
        clauseKeywords: mergeStringSets(baseProfile.clauseKeywords, overlay.clauseKeywords ?? []),
        newlineBeforeKeywords: mergeStringSets(
            baseProfile.newlineBeforeKeywords,
            overlay.newlineBeforeKeywords ?? []
        ),
        joinModifiers: mergeStringSets(baseProfile.joinModifiers, overlay.joinModifiers ?? []),
        commaNewlineClauses: mergeStringSets(baseProfile.commaNewlineClauses, overlay.commaNewlineClauses ?? []),
        logicalBreakKeywords: mergeStringSets(baseProfile.logicalBreakKeywords, overlay.logicalBreakKeywords ?? [])
    };
}
