/**
 * Classification of parsed SQL types into coarse families used by the
 * cross-dialect type translation.
 */

import type { ParsedSqlType } from './parseSqlType';

export type SqlTypeFamily =
    | 'integer'
    | 'decimal'
    | 'float'
    | 'boolean'
    | 'date'
    | 'time'
    | 'timestamp'
    | 'interval'
    | 'char'
    | 'varchar'
    | 'nvarchar'
    | 'text'
    | 'clob'
    | 'blob'
    | 'binary'
    | 'uuid'
    | 'json'
    | 'xml'
    | 'money'
    | 'unknown';

const INTEGER_BASES = new Set([
    'BYTEINT',
    'TINYINT',
    'INT1',
    'INT2',
    'SMALLINT',
    'INT',
    'INTEGER',
    'INT4',
    'BIGINT',
    'INT8',
    'INT64',
    'MEDIUMINT',
    'SERIAL',
    'BIGSERIAL',
    'SMALLSERIAL',
    'YEAR',
]);

const DECIMAL_BASES = new Set(['NUMERIC', 'DECIMAL', 'DEC', 'NUMBER', 'FIXED']);

const FLOAT_BASES = new Set([
    'FLOAT',
    'DOUBLE',
    'DOUBLE PRECISION',
    'REAL',
    'DECFLOAT',
    'FLOAT4',
    'FLOAT8',
    'BINARY_FLOAT',
    'BINARY_DOUBLE',
]);

const BOOLEAN_BASES = new Set(['BOOLEAN', 'BOOL', 'BIT', 'BIT VARYING']);

const DATE_BASES = new Set(['DATE']);

const TIME_BASES = new Set(['TIME', 'TIMETZ']);

const TIMESTAMP_BASES = new Set(['TIMESTAMP', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'ABSTIME', 'TIMESTAMPTZ']);

const INTERVAL_BASES = new Set(['INTERVAL']);

const CHAR_BASES = new Set(['CHAR', 'CHARACTER', 'NCHAR', 'BPCHAR']);

const VARCHAR_BASES = new Set(['VARCHAR', 'VARCHAR2', 'STRING', 'CHARACTER VARYING']);

const NVARCHAR_BASES = new Set(['NVARCHAR', 'NVARCHAR2', 'NATIONAL CHARACTER VARYING']);

const TEXT_BASES = new Set(['TEXT', 'LONG VARCHAR', 'LONG NVARCHAR', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT']);

const CLOB_BASES = new Set(['CLOB', 'NCLOB', 'TEXTDATA', 'NTEXT']);

const BLOB_BASES = new Set(['BLOB', 'IMAGE', 'LONG RAW', 'BYTEA']);

const BINARY_BASES = new Set([
    'BINARY',
    'VARBINARY',
    'VARBYTE',
    'RAW',
    'BYTES',
    'BINARY VARYING',
    'BINARY LARGE OBJECT',
    'VARBINARY(MAX)',
]);

const UUID_BASES = new Set(['UUID', 'UNIQUEIDENTIFIER', 'GUID']);

const JSON_BASES = new Set(['JSON', 'JSONB', 'VARIANT', 'OBJECT']);

const XML_BASES = new Set(['XML']);

const MONEY_BASES = new Set(['MONEY', 'SMALLMONEY', 'CURRENCY', 'MONEY(10,2)']);

export function classifySqlTypeFamily(parsed: ParsedSqlType): SqlTypeFamily {
    const base = parsed.base;
    if (!base) {
        return 'unknown';
    }
    if (INTEGER_BASES.has(base)) {
        return 'integer';
    }
    if (DECIMAL_BASES.has(base)) {
        return 'decimal';
    }
    if (FLOAT_BASES.has(base)) {
        return 'float';
    }
    if (BOOLEAN_BASES.has(base)) {
        return 'boolean';
    }
    if (DATE_BASES.has(base)) {
        return 'date';
    }
    if (TIME_BASES.has(base)) {
        return 'time';
    }
    if (TIMESTAMP_BASES.has(base)) {
        return 'timestamp';
    }
    if (INTERVAL_BASES.has(base)) {
        return 'interval';
    }
    if (CHAR_BASES.has(base)) {
        return 'char';
    }
    if (VARCHAR_BASES.has(base)) {
        return 'varchar';
    }
    if (NVARCHAR_BASES.has(base)) {
        return 'nvarchar';
    }
    if (TEXT_BASES.has(base)) {
        return 'text';
    }
    if (CLOB_BASES.has(base)) {
        return 'clob';
    }
    if (BLOB_BASES.has(base)) {
        return 'blob';
    }
    if (BINARY_BASES.has(base)) {
        return 'binary';
    }
    if (UUID_BASES.has(base)) {
        return 'uuid';
    }
    if (JSON_BASES.has(base)) {
        return 'json';
    }
    if (XML_BASES.has(base)) {
        return 'xml';
    }
    if (MONEY_BASES.has(base)) {
        return 'money';
    }
    return 'unknown';
}

/**
 * Human-readable label for a family (used in warnings / UI).
 */
export function getSqlTypeFamilyLabel(family: SqlTypeFamily): string {
    switch (family) {
        case 'integer': return 'integer';
        case 'decimal': return 'decimal';
        case 'float': return 'floating point';
        case 'boolean': return 'boolean';
        case 'date': return 'date';
        case 'time': return 'time';
        case 'timestamp': return 'timestamp';
        case 'interval': return 'interval';
        case 'char': return 'character';
        case 'varchar': return 'variable character';
        case 'nvarchar': return 'unicode character';
        case 'text': return 'large text';
        case 'clob': return 'character large object';
        case 'blob': return 'binary large object';
        case 'binary': return 'binary';
        case 'uuid': return 'uuid';
        case 'json': return 'json';
        case 'xml': return 'xml';
        case 'money': return 'money';
        default: return 'unknown';
    }
}
