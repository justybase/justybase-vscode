/**
 * Snowflake Data Type Specification
 * Based on: https://docs.snowflake.com/en/sql-reference/intro-summary-data-types.html
 */

export interface SnowflakeTypeSpec {
    canonical: string;
    paramsMin: number;
    paramsMax: number;
    warnIfNoLength?: boolean;
}

export const normalizeTypeName = (name: string): string => name.toUpperCase().replace(/\s+/g, ' ').trim();

const specsByAlias = new Map<string, SnowflakeTypeSpec>();

const addType = (
    canonical: string,
    aliases: string[],
    paramsMin: number,
    paramsMax: number,
    warnIfNoLength: boolean = false,
): void => {
    const spec: SnowflakeTypeSpec = {
        canonical,
        paramsMin,
        paramsMax,
        warnIfNoLength,
    };
    for (const a of aliases) {
        specsByAlias.set(normalizeTypeName(a), spec);
    }
};

// =============================================================================
// Numeric Types
// https://docs.snowflake.com/en/sql-reference/data-types-numeric.html
// =============================================================================

// NUMBER/DECIMAL/NUMERIC - Fixed precision and scale
addType('NUMBER', ['NUMBER', 'DECIMAL', 'DEC', 'NUMERIC'], 0, 2);

// Integer types (all are aliases for NUMBER with specific precision)
addType('INT', ['INT', 'INTEGER'], 0, 0);
addType('BIGINT', ['BIGINT'], 0, 0);
addType('SMALLINT', ['SMALLINT'], 0, 0);
addType('TINYINT', ['TINYINT'], 0, 0);
addType('BYTEINT', ['BYTEINT'], 0, 0);

// Floating point types
addType('FLOAT', ['FLOAT', 'FLOAT4', 'FLOAT8'], 0, 1);
addType('DOUBLE', ['DOUBLE', 'DOUBLE PRECISION'], 0, 0);
addType('REAL', ['REAL'], 0, 0);

// =============================================================================
// String Types
// https://docs.snowflake.com/en/sql-reference/data-types-string.html
// =============================================================================

addType(
    'VARCHAR',
    ['VARCHAR', 'CHARACTER VARYING', 'NVARCHAR', 'NVARCHAR2', 'CHAR VARYING', 'NCHAR VARYING'],
    0,
    1,
    true,
);
addType('CHAR', ['CHAR', 'CHARACTER', 'NCHAR', 'NATIONAL CHARACTER', 'NATIONAL CHAR'], 0, 1, true);
addType('STRING', ['STRING'], 0, 0);
addType('TEXT', ['TEXT'], 0, 0);

// Binary types
addType('BINARY', ['BINARY'], 0, 1);
addType('VARBINARY', ['VARBINARY'], 0, 1);

// =============================================================================
// Boolean Type
// https://docs.snowflake.com/en/sql-reference/data-types-boolean.html
// =============================================================================

addType('BOOLEAN', ['BOOLEAN', 'BOOL'], 0, 0);

// =============================================================================
// Date/Time Types
// https://docs.snowflake.com/en/sql-reference/data-types-datetime.html
// =============================================================================

addType('DATE', ['DATE'], 0, 0);
addType('DATETIME', ['DATETIME'], 0, 1);
addType('TIME', ['TIME'], 0, 1);
addType('TIMESTAMP', ['TIMESTAMP', 'TIMESTAMPTZ', 'TIMESTAMP WITH TIME ZONE'], 0, 1);
addType('TIMESTAMP_LTZ', ['TIMESTAMP_LTZ', 'TIMESTAMP_LTZ WITH TIME ZONE'], 0, 1);
addType('TIMESTAMP_NTZ', ['TIMESTAMP_NTZ', 'TIMESTAMP_NTZ WITHOUT TIME ZONE'], 0, 1);
addType('TIMESTAMP_TZ', ['TIMESTAMP_TZ', 'TIMESTAMP_TZ WITH TIME ZONE'], 0, 1);

// Interval type
addType('INTERVAL', ['INTERVAL'], 0, 1);

// =============================================================================
// Semi-structured Types
// https://docs.snowflake.com/en/sql-reference/data-types-semistructured.html
// =============================================================================

addType('VARIANT', ['VARIANT'], 0, 0);
addType('OBJECT', ['OBJECT'], 0, 0);
addType('ARRAY', ['ARRAY'], 0, 0);

// =============================================================================
// Geospatial Types
// https://docs.snowflake.com/en/sql-reference/data-types-geospatial.html
// =============================================================================

addType('GEOGRAPHY', ['GEOGRAPHY'], 0, 0);
addType('GEOMETRY', ['GEOMETRY'], 0, 0);

// Vector type
addType('VECTOR', ['VECTOR'], 1, 1);

// =============================================================================
// Type specification lookup
// =============================================================================

export const getSnowflakeTypeSpec = (typeName: string): SnowflakeTypeSpec | undefined => {
    if (!typeName) return undefined;
    const normalized = normalizeTypeName(typeName);
    const direct = specsByAlias.get(normalized);
    if (direct) {
        return direct;
    }

    // Accept qualified interval forms such as:
    // INTERVAL YEAR TO MONTH, INTERVAL DAY TO SECOND, etc.
    if (normalized.startsWith('INTERVAL ')) {
        return specsByAlias.get('INTERVAL');
    }

    return undefined;
};

/**
 * Check if a type supports procedure ANY SIZE argument
 * In Snowflake, text types can use ANY SIZE in procedure definitions
 */
const PROCEDURE_ANY_SIZE_TEXT_TYPES = new Set(['CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'STRING', 'TEXT']);

export const supportsProcedureAnySizeArgument = (typeName: string): boolean => {
    const spec = getSnowflakeTypeSpec(typeName);
    return !!spec && PROCEDURE_ANY_SIZE_TEXT_TYPES.has(spec.canonical);
};

/**
 * Get the canonical type name for a given type alias
 */
export const getCanonicalTypeName = (typeName: string): string | undefined => {
    const spec = getSnowflakeTypeSpec(typeName);
    return spec?.canonical;
};

/**
 * Check if a type is a numeric type
 */
export const isNumericType = (typeName: string): boolean => {
    const spec = getSnowflakeTypeSpec(typeName);
    if (!spec) return false;
    const canonical = spec.canonical;
    return [
        'NUMBER',
        'DECIMAL',
        'NUMERIC',
        'INT',
        'INTEGER',
        'BIGINT',
        'SMALLINT',
        'TINYINT',
        'BYTEINT',
        'FLOAT',
        'DOUBLE',
        'REAL',
    ].includes(canonical);
};

/**
 * Check if a type is a string type
 */
export const isStringType = (typeName: string): boolean => {
    const spec = getSnowflakeTypeSpec(typeName);
    if (!spec) return false;
    const canonical = spec.canonical;
    return ['VARCHAR', 'CHAR', 'STRING', 'TEXT', 'BINARY', 'VARBINARY'].includes(canonical);
};

/**
 * Check if a type is a date/time type
 */
export const isDateTimeType = (typeName: string): boolean => {
    const spec = getSnowflakeTypeSpec(typeName);
    if (!spec) return false;
    const canonical = spec.canonical;
    return [
        'DATE',
        'DATETIME',
        'TIME',
        'TIMESTAMP',
        'TIMESTAMP_LTZ',
        'TIMESTAMP_NTZ',
        'TIMESTAMP_TZ',
        'INTERVAL',
    ].includes(canonical);
};

/**
 * Check if a type is a semi-structured type
 */
export const isSemiStructuredType = (typeName: string): boolean => {
    const spec = getSnowflakeTypeSpec(typeName);
    if (!spec) return false;
    const canonical = spec.canonical;
    return ['VARIANT', 'OBJECT', 'ARRAY'].includes(canonical);
};

/**
 * Check if a type is a geospatial type
 */
export const isGeospatialType = (typeName: string): boolean => {
    const spec = getSnowflakeTypeSpec(typeName);
    if (!spec) return false;
    const canonical = spec.canonical;
    return ['GEOGRAPHY', 'GEOMETRY'].includes(canonical);
};
