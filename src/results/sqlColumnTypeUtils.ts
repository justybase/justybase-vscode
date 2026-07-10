const INTEGER_TYPE_ALIASES = new Set([
    'tinyint',
    'smallint',
    'mediumint',
    'int',
    'integer',
    'bigint',
    'byteint',
    'serial',
    'smallserial',
    'bigserial',
    'serial2',
    'serial4',
    'serial8',
    'int1',
    'int2',
    'int4',
    'int8',
    'int16',
    'int32',
    'int64',
]);

const DECIMAL_TYPE_ALIASES = new Set([
    'numeric',
    'decimal',
    'dec',
    'number',
    'fixed',
    'float',
    'float4',
    'float8',
    'real',
    'double',
    'double precision',
    'binary_float',
    'binary_double',
    'single',
    'single precision',
    'decfloat',
    'money',
    'smallmoney',
]);

const TEMPORAL_TYPE_ALIASES = new Set([
    'date',
    'datetime',
    'datetime2',
    'datetimeoffset',
    'smalldatetime',
    'timestamp',
    'timestamp without time zone',
    'timestamp with time zone',
    'timestamptz',
    'timestamp_ntz',
    'timestamp_ltz',
    'timestamp_tz',
    'time',
    'timetz',
    'abstime',
    'reltime',
    'interval',
]);

function extractBaseTypeName(type: string | undefined | null): string {
    const normalizedType = String(type || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const parenIndex = normalizedType.indexOf('(');
    return (parenIndex >= 0 ? normalizedType.slice(0, parenIndex) : normalizedType).trim();
}

export function isNumericSqlColumnType(dataType: string | undefined): boolean {
    const baseType = extractBaseTypeName(dataType);
    return INTEGER_TYPE_ALIASES.has(baseType) || DECIMAL_TYPE_ALIASES.has(baseType);
}

export function isTemporalSqlColumnType(dataType: string | undefined): boolean {
    return TEMPORAL_TYPE_ALIASES.has(extractBaseTypeName(dataType));
}
