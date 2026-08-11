/**
 * Cross-dialect type translation.
 *
 * Two-stage pipeline:
 *  1. `toCanonicalType(sourceType)` — normalize any source dialect type into the
 *     canonical import vocabulary shared by the per-dialect importers
 *     (`BIGINT`, `NUMERIC(p,s)`, `NVARCHAR(n)`, `DATETIME`, `BOOLEAN`, ...).
 *  2. `renderTargetType(kind, canonicalType)` — render the canonical type as a
 *     native type of the target dialect.
 */

import type { DatabaseKind } from '../../contracts/database';
import { classifySqlTypeFamily, getSqlTypeFamilyLabel, type SqlTypeFamily } from './classifySqlType';
import { parseSqlType } from './parseSqlType';

export const MAX_CANONICAL_PRECISION = 38;
export const MAX_CANONICAL_SCALE = 18;

const DEFAULT_VARCHAR_LENGTH = 255;
const DEFAULT_BINARY_LENGTH = 2000;

function capNumeric(
    precision: number | undefined,
    scale: number | undefined,
    warnings: string[],
    sourceType: string,
): { precision: number; scale: number } {
    let p = precision ?? MAX_CANONICAL_PRECISION;
    let s = scale ?? 0;
    if (s > MAX_CANONICAL_SCALE) {
        warnings.push(
            `Type "${sourceType}" declares scale ${s} which exceeds the supported maximum of ${MAX_CANONICAL_SCALE}; scale was reduced.`,
        );
        s = MAX_CANONICAL_SCALE;
    }
    if (p > MAX_CANONICAL_PRECISION) {
        warnings.push(
            `Type "${sourceType}" declares precision ${p} which exceeds the supported maximum of ${MAX_CANONICAL_PRECISION}; precision was reduced.`,
        );
        p = MAX_CANONICAL_PRECISION;
    }
    if (p < s) {
        p = s;
    }
    return { precision: p, scale: s };
}

function lengthOrDefault(length: number | undefined, fallback: number): number {
    if (typeof length !== 'number' || !Number.isFinite(length) || length < 1) {
        return fallback;
    }
    return Math.floor(length);
}

/**
 * Converts a source SQL type string into the canonical import vocabulary.
 * Returns the canonical type plus any warnings produced during conversion.
 */
export function toCanonicalType(sourceType: string): { type: string; warnings: string[] } {
    const warnings: string[] = [];
    const parsed = parseSqlType(sourceType);
    const family: SqlTypeFamily = classifySqlTypeFamily(parsed);
    const base = parsed.base;

    switch (family) {
        case 'integer':
            if (base === 'BYTEINT' || base === 'TINYINT' || base === 'INT1') {
                return { type: 'BYTEINT', warnings };
            }
            if (base === 'SMALLINT' || base === 'INT2' || base === 'YEAR') {
                return { type: 'SMALLINT', warnings };
            }
            if (base === 'BIGINT' || base === 'INT8' || base === 'INT64' || base === 'BIGSERIAL') {
                return { type: 'BIGINT', warnings };
            }
            return { type: 'INT', warnings };

        case 'decimal': {
            const { precision, scale } = capNumeric(parsed.precision, parsed.scale, warnings, sourceType);
            return { type: `NUMERIC(${precision},${scale})`, warnings };
        }

        case 'float':
            if (base === 'REAL' || base === 'FLOAT4' || base === 'BINARY_FLOAT') {
                return { type: 'REAL', warnings };
            }
            if (base === 'DECFLOAT') {
                return { type: 'DECFLOAT', warnings };
            }
            return { type: 'DOUBLE', warnings };

        case 'boolean':
            return { type: 'BOOLEAN', warnings };

        case 'date':
            return { type: 'DATE', warnings };

        case 'time':
            return { type: parsed.withTimeZone || base === 'TIMETZ' ? 'TIMETZ' : 'TIME', warnings };

        case 'timestamp':
            if (parsed.withTimeZone) {
                return { type: base === 'TIMESTAMPTZ' ? 'TIMESTAMPTZ' : 'TIMESTAMP WITH TIME ZONE', warnings };
            }
            if (base === 'TIMESTAMP') {
                return { type: 'TIMESTAMP', warnings };
            }
            return { type: 'DATETIME', warnings };

        case 'interval':
            return { type: 'INTERVAL', warnings };

        case 'char': {
            const length = lengthOrDefault(parsed.length, 1);
            return { type: `CHAR(${length})`, warnings };
        }

        case 'varchar': {
            const length = lengthOrDefault(parsed.length, DEFAULT_VARCHAR_LENGTH);
            return { type: `VARCHAR(${length})`, warnings };
        }

        case 'nvarchar': {
            const length = lengthOrDefault(parsed.length, DEFAULT_VARCHAR_LENGTH);
            return { type: `NVARCHAR(${length})`, warnings };
        }

        case 'text':
            return { type: 'TEXT', warnings };

        case 'clob':
            return { type: base === 'NCLOB' || base === 'NTEXT' ? 'NCLOB' : 'CLOB', warnings };

        case 'blob':
            return { type: 'BLOB', warnings };

        case 'binary': {
            const length = lengthOrDefault(parsed.length, DEFAULT_BINARY_LENGTH);
            return { type: `VARBINARY(${length})`, warnings };
        }

        case 'uuid':
            return { type: 'UUID', warnings };

        case 'json':
            return { type: base === 'JSONB' || base === 'VARIANT' ? 'JSONB' : 'JSON', warnings };

        case 'xml':
            return { type: 'XML', warnings };

        case 'money':
            return { type: 'MONEY', warnings };

        case 'unknown':
        default:
            warnings.push(
                `Type "${sourceType}" is not recognized; it will be mapped to a default text type.`,
            );
            return { type: 'NVARCHAR(255)', warnings };
    }
}

/**
 * Renders a canonical type as a native type of the target dialect.
 * Returns the rendered type plus warnings (e.g. length caps, unsupported types).
 */
export function renderTargetType(targetKind: DatabaseKind, canonicalType: string): { type: string; warnings: string[] } {
    const warnings: string[] = [];
    const parsed = parseSqlType(canonicalType);
    const family = classifySqlTypeFamily(parsed);
    const length = lengthOrDefault(parsed.length, DEFAULT_VARCHAR_LENGTH);
    const rendered = renderFamilyType(targetKind, family, parsed.base, parsed.precision, parsed.scale, length, parsed.withTimeZone, canonicalType, warnings);
    return { type: rendered, warnings };
}

function renderFamilyType(
    kind: DatabaseKind,
    family: SqlTypeFamily,
    base: string,
    precision: number | undefined,
    scale: number | undefined,
    length: number,
    withTimeZone: boolean | undefined,
    canonicalType: string,
    warnings: string[],
): string {
    const p = precision ?? MAX_CANONICAL_PRECISION;
    const s = scale ?? 0;

    switch (kind) {
        case 'netezza':
            return renderNetezzaType(family, base, p, s, length, canonicalType, warnings);
        case 'postgresql':
            return renderPostgreSqlType(family, p, s, length, withTimeZone, warnings);
        case 'oracle':
            return renderOracleType(family, p, s, length, withTimeZone, warnings);
        case 'db2':
            return renderDb2Type(family, p, s, length, withTimeZone, warnings);
        case 'mssql':
            return renderMsSqlType(family, p, s, length, withTimeZone, warnings);
        case 'mysql':
            return renderMySqlType(family, p, s, length, warnings);
        case 'sqlite':
            return renderSqliteType(family, length);
        case 'duckdb':
            return renderDuckDbType(family, p, s, length, withTimeZone, warnings);
        case 'vertica':
            return renderVerticaType(family, p, s, length, withTimeZone, warnings);
        case 'snowflake':
            return renderSnowflakeType(family, p, s, length, withTimeZone, warnings);
        case 'access':
            return renderAccessType(family, p, s, length, warnings);
        default:
            warnings.push(`No type translation defined for target dialect "${kind}"; using source type.`);
            return canonicalType;
    }
}

function renderNetezzaType(
    family: SqlTypeFamily,
    base: string,
    p: number,
    s: number,
    length: number,
    canonicalType: string,
    warnings: string[],
): string {
    switch (family) {
        // BIGINT/DATETIME/NVARCHAR are also the canonical transport types
        // used by Netezza's external-table loader.
        case 'integer': return 'BIGINT';
        case 'decimal': return `NUMERIC(${p},${s})`;
        case 'float': return base === 'REAL' ? 'REAL' : base === 'DECFLOAT' ? 'DECFLOAT' : 'DOUBLE PRECISION';
        case 'boolean': return 'BIGINT';
        case 'date': return 'DATE';
        case 'time': return base === 'TIMETZ' ? 'TIMETZ' : 'TIME';
        case 'timestamp': return 'DATETIME';
        case 'interval': return 'INTERVAL';
        case 'char': return `NVARCHAR(${length})`;
        case 'varchar': return `NVARCHAR(${length})`;
        case 'nvarchar': return `NVARCHAR(${length})`;
        case 'text': {
            warnings.push('Canonical TEXT type is not available on Netezza; using NVARCHAR(1024).');
            return 'NVARCHAR(1024)';
        }
        case 'clob': {
            warnings.push('LOB types are not available on Netezza; using NVARCHAR(32000).');
            return 'NVARCHAR(32000)';
        }
        case 'blob': {
            warnings.push('BLOB is not available on Netezza; the column is mapped to NVARCHAR(32000).');
            return 'NVARCHAR(32000)';
        }
        case 'binary': {
            warnings.push('Binary types are not available on Netezza; the column is mapped to VARCHAR(64000).');
            return 'VARCHAR(64000)';
        }
        case 'uuid': return 'NVARCHAR(36)';
        case 'json': {
            warnings.push('JSON type is not available on Netezza; using NVARCHAR(1024).');
            return 'NVARCHAR(1024)';
        }
        case 'xml': {
            warnings.push('XML type is not available on Netezza; using NVARCHAR(1024).');
            return 'NVARCHAR(1024)';
        }
        case 'money': return 'NUMERIC(19,4)';
        default: return canonicalType;
    }
}

function renderPostgreSqlType(
    family: SqlTypeFamily,
    p: number,
    s: number,
    length: number,
    withTimeZone: boolean | undefined,
    _warnings: string[],
): string {
    switch (family) {
        case 'integer': return baseByBaseKind('integer', 'postgresql', 'SMALLINT');
        case 'decimal': return `NUMERIC(${p},${s})`;
        case 'float': return 'DOUBLE PRECISION';
        case 'boolean': return 'BOOLEAN';
        case 'date': return 'DATE';
        case 'time': return 'TIMETZ';
        case 'timestamp': return withTimeZone ? 'TIMESTAMPTZ' : 'TIMESTAMP';
        case 'interval': return 'INTERVAL';
        case 'char': return `CHAR(${length})`;
        case 'varchar': return `VARCHAR(${length})`;
        case 'nvarchar': return `VARCHAR(${length})`;
        case 'text': return 'TEXT';
        case 'clob': return 'TEXT';
        case 'blob': return 'BYTEA';
        case 'binary': return 'BYTEA';
        case 'uuid': return 'UUID';
        case 'json': return 'JSONB';
        case 'xml': return 'XML';
        case 'money': return 'MONEY';
        default: return 'TEXT';
    }
}

function renderOracleType(
    family: SqlTypeFamily,
    p: number,
    s: number,
    length: number,
    withTimeZone: boolean | undefined,
    warnings: string[],
): string {
    switch (family) {
        case 'integer': return baseByBaseKind('integer', 'oracle', 'NUMBER(5,0)');
        case 'decimal': return `NUMBER(${p},${s})`;
        case 'float': return 'BINARY_DOUBLE';
        case 'boolean': return 'NUMBER(1)';
        case 'date': return 'DATE';
        case 'time': return 'TIMESTAMP';
        case 'timestamp': return withTimeZone ? 'TIMESTAMP WITH TIME ZONE' : 'TIMESTAMP';
        case 'interval': return 'INTERVAL DAY TO SECOND';
        case 'char': return `CHAR(${Math.min(length, 2000)} CHAR)`;
        case 'varchar': {
            const capped = Math.min(length, 4000);
            if (capped < length) {
                warnings.push(`VARCHAR length ${length} exceeds Oracle's 4000 character limit; using 4000.`);
            }
            return `VARCHAR2(${capped} CHAR)`;
        }
        case 'nvarchar': {
            const capped = Math.min(length, 4000);
            if (capped < length) {
                warnings.push(`NVARCHAR length ${length} exceeds Oracle's 4000 character limit; using 4000.`);
            }
            return `NVARCHAR2(${capped})`;
        }
        case 'text': return 'CLOB';
        case 'clob': return 'CLOB';
        case 'blob': return 'BLOB';
        case 'binary': return `RAW(${Math.min(length, 2000)})`;
        case 'uuid': return 'RAW(16)';
        case 'json': return 'CLOB';
        case 'xml': return 'XMLTYPE';
        case 'money': return 'NUMBER(19,4)';
        default: return 'VARCHAR2(255 CHAR)';
    }
}

function renderDb2Type(
    family: SqlTypeFamily,
    p: number,
    s: number,
    length: number,
    withTimeZone: boolean | undefined,
    warnings: string[],
): string {
    switch (family) {
        case 'integer': return baseByBaseKind('integer', 'db2', 'SMALLINT');
        case 'decimal': return `DECIMAL(${p},${s})`;
        case 'float': return 'DOUBLE';
        case 'boolean': return 'BOOLEAN';
        case 'date': return 'DATE';
        case 'time': return 'TIME';
        case 'timestamp': return withTimeZone ? 'TIMESTAMP WITH TIME ZONE' : 'TIMESTAMP';
        case 'interval': return 'INTERVAL DAY TO SECOND';
        case 'char': return `CHAR(${Math.min(length, 254)})`;
        case 'varchar': {
            const capped = Math.min(length, 32672);
            if (capped < length) {
                warnings.push(`VARCHAR length ${length} exceeds Db2's 32672 limit; using ${capped}.`);
            }
            return `VARCHAR(${capped})`;
        }
        case 'nvarchar': {
            const capped = Math.min(length, 32672);
            if (capped < length) {
                warnings.push(`NVARCHAR length ${length} exceeds Db2's 32672 limit; using ${capped}.`);
            }
            return `VARCHAR(${capped})`;
        }
        case 'text': return 'CLOB';
        case 'clob': return 'CLOB';
        case 'blob': return 'BLOB';
        case 'binary': return `VARBINARY(${Math.min(length, 32672)})`;
        case 'uuid': return 'CHAR(36)';
        case 'json': return 'CLOB';
        case 'xml': return 'XML';
        case 'money': return 'DECIMAL(19,4)';
        default: return 'VARCHAR(255)';
    }
}

function renderMsSqlType(
    family: SqlTypeFamily,
    p: number,
    s: number,
    length: number,
    withTimeZone: boolean | undefined,
    warnings: string[],
): string {
    switch (family) {
        case 'integer': return baseByBaseKind('integer', 'mssql', 'SMALLINT');
        case 'decimal': return `DECIMAL(${p},${s})`;
        case 'float': return 'FLOAT';
        case 'boolean': return 'BIT';
        case 'date': return 'DATE';
        case 'time': return 'TIME';
        case 'timestamp': return withTimeZone ? 'DATETIMEOFFSET' : 'DATETIME2';
        case 'interval': {
            warnings.push('INTERVAL type is not supported by MS SQL Server; using NVARCHAR(50).');
            return 'NVARCHAR(50)';
        }
        case 'char': return `CHAR(${length})`;
        case 'varchar': return `VARCHAR(${length})`;
        case 'nvarchar': {
            const capped = Math.min(length, 4000);
            if (capped < length) {
                warnings.push(`NVARCHAR length ${length} exceeds MS SQL Server's 4000 limit for inline columns; using ${capped}.`);
            }
            return `NVARCHAR(${capped})`;
        }
        case 'text': return 'NVARCHAR(MAX)';
        case 'clob': return 'NVARCHAR(MAX)';
        case 'blob': return 'VARBINARY(MAX)';
        case 'binary': return `VARBINARY(${Math.min(length, 8000)})`;
        case 'uuid': return 'UNIQUEIDENTIFIER';
        case 'json': return 'NVARCHAR(MAX)';
        case 'xml': return 'XML';
        case 'money': return 'MONEY';
        default: return 'NVARCHAR(255)';
    }
}

function renderMySqlType(
    family: SqlTypeFamily,
    p: number,
    s: number,
    length: number,
    warnings: string[],
): string {
    switch (family) {
        case 'integer': return baseByBaseKind('integer', 'mysql', 'SMALLINT');
        case 'decimal': return `DECIMAL(${p},${s})`;
        case 'float': return 'DOUBLE';
        case 'boolean': return 'BOOLEAN';
        case 'date': return 'DATE';
        case 'time': return 'TIME';
        case 'timestamp': return 'TIMESTAMP';
        case 'interval': {
            warnings.push('INTERVAL type is not supported by MySQL; using VARCHAR(50).');
            return 'VARCHAR(50)';
        }
        case 'char': return `CHAR(${Math.min(length, 255)})`;
        case 'varchar': {
            const capped = Math.min(length, 65535);
            if (capped < length) {
                warnings.push(`VARCHAR length ${length} exceeds MySQL's 65535 byte row limit; using ${capped}.`);
            }
            return `VARCHAR(${capped})`;
        }
        case 'nvarchar': return `VARCHAR(${Math.min(length, 65535)})`;
        case 'text': return 'TEXT';
        case 'clob': return 'LONGTEXT';
        case 'blob': return 'LONGBLOB';
        case 'binary': return `VARBINARY(${Math.min(length, 65535)})`;
        case 'uuid': return 'CHAR(36)';
        case 'json': return 'JSON';
        case 'xml': return 'TEXT';
        case 'money': return 'DECIMAL(19,4)';
        default: return 'VARCHAR(255)';
    }
}

function renderSqliteType(family: SqlTypeFamily, _length: number): string {
    switch (family) {
        case 'integer': return 'INTEGER';
        case 'decimal': return 'NUMERIC';
        case 'float': return 'REAL';
        case 'boolean': return 'INTEGER';
        case 'date': return 'DATE';
        case 'time': return 'TIME';
        case 'timestamp': return 'TIMESTAMP';
        case 'interval': return 'TEXT';
        case 'char':
        case 'varchar':
        case 'nvarchar':
        case 'text':
        case 'clob':
        case 'json':
        case 'xml':
        case 'uuid':
        case 'money':
            return 'TEXT';
        case 'blob':
        case 'binary':
            return 'BLOB';
        default: return 'TEXT';
    }
}

function renderDuckDbType(
    family: SqlTypeFamily,
    p: number,
    s: number,
    length: number,
    withTimeZone: boolean | undefined,
    _warnings: string[],
): string {
    switch (family) {
        case 'integer': return baseByBaseKind('integer', 'duckdb', 'SMALLINT');
        case 'decimal': return `DECIMAL(${p},${s})`;
        case 'float': return 'DOUBLE';
        case 'boolean': return 'BOOLEAN';
        case 'date': return 'DATE';
        case 'time': return 'TIME';
        case 'timestamp': return withTimeZone ? 'TIMESTAMPTZ' : 'TIMESTAMP';
        case 'interval': return 'INTERVAL';
        case 'char': return `CHAR(${length})`;
        case 'varchar':
        case 'nvarchar':
        case 'text':
        case 'clob':
            return 'VARCHAR';
        case 'blob':
        case 'binary':
            return 'BLOB';
        case 'uuid': return 'UUID';
        case 'json': return 'JSON';
        case 'xml': return 'VARCHAR';
        case 'money': return 'DOUBLE';
        default: return 'VARCHAR';
    }
}

function renderVerticaType(
    family: SqlTypeFamily,
    p: number,
    s: number,
    length: number,
    withTimeZone: boolean | undefined,
    _warnings: string[],
): string {
    switch (family) {
        case 'integer': return baseByBaseKind('integer', 'vertica', 'INTEGER');
        case 'decimal': return `NUMERIC(${p},${s})`;
        case 'float': return 'FLOAT';
        case 'boolean': return 'BOOLEAN';
        case 'date': return 'DATE';
        case 'time': return 'TIME';
        case 'timestamp': return withTimeZone ? 'TIMESTAMPTZ' : 'TIMESTAMP';
        case 'interval': return 'INTERVAL';
        case 'char': return `CHAR(${length})`;
        case 'varchar': return `VARCHAR(${length})`;
        case 'nvarchar': return `VARCHAR(${length})`;
        case 'text': return 'LONG VARCHAR';
        case 'clob': return 'LONG VARCHAR';
        case 'blob': return 'VARBINARY';
        case 'binary': return `VARBINARY(${length})`;
        case 'uuid': return 'UUID';
        case 'json': return 'LONG VARCHAR';
        case 'xml': return 'LONG VARCHAR';
        case 'money': return 'NUMERIC(19,4)';
        default: return 'VARCHAR(255)';
    }
}

function renderSnowflakeType(
    family: SqlTypeFamily,
    p: number,
    s: number,
    length: number,
    withTimeZone: boolean | undefined,
    _warnings: string[],
): string {
    switch (family) {
        case 'integer': return baseByBaseKind('integer', 'snowflake', 'SMALLINT');
        case 'decimal': return `NUMBER(${p},${s})`;
        case 'float': return 'FLOAT';
        case 'boolean': return 'BOOLEAN';
        case 'date': return 'DATE';
        case 'time': return 'TIME';
        case 'timestamp': return withTimeZone ? 'TIMESTAMP_TZ' : 'TIMESTAMP_NTZ';
        case 'interval': return 'INTERVAL';
        case 'char': return `CHAR(${length})`;
        case 'varchar': return `VARCHAR(${length})`;
        case 'nvarchar': return `VARCHAR(${length})`;
        case 'text': return 'TEXT';
        case 'clob': return 'TEXT';
        case 'blob': return 'BINARY';
        case 'binary': return `BINARY(${Math.min(length, 8388608)})`;
        case 'uuid': return 'VARCHAR(36)';
        case 'json': return 'VARIANT';
        case 'xml': return 'VARIANT';
        case 'money': return 'NUMBER(19,4)';
        default: return 'VARCHAR(255)';
    }
}

function renderAccessType(
    family: SqlTypeFamily,
    p: number,
    s: number,
    length: number,
    warnings: string[],
): string {
    switch (family) {
        case 'integer': return baseByBaseKind('integer', 'access', 'INTEGER');
        case 'decimal': return `DECIMAL(${p},${s})`;
        case 'float': return 'DOUBLE';
        case 'boolean': return 'BOOLEAN';
        case 'date':
        case 'time':
        case 'timestamp':
            return 'DATETIME';
        case 'interval': {
            warnings.push('INTERVAL type is not supported by MS Access; using TEXT(50).');
            return 'TEXT(50)';
        }
        case 'char':
        case 'varchar':
        case 'nvarchar':
            return `TEXT(${Math.min(length, 255)})`;
        case 'text':
        case 'clob':
        case 'json':
        case 'xml':
            return 'MEMO';
        case 'blob':
        case 'binary':
            return 'OLEOBJECT';
        case 'uuid': return 'TEXT(36)';
        case 'money': return 'CURRENCY';
        default: return 'TEXT(255)';
    }
}

/**
 * Maps an integer canonical base to the dialect-specific integer type.
 */
function baseByBaseKind(_family: SqlTypeFamily, kind: DatabaseKind, fallback: string): string {
    switch (kind) {
        case 'netezza': return fallback;
        case 'postgresql':
        case 'duckdb':
        case 'vertica':
        case 'snowflake':
            return 'INTEGER';
        case 'oracle': return 'NUMBER(10,0)';
        case 'db2': return 'INTEGER';
        case 'mssql': return 'INT';
        case 'mysql': return 'INT';
        case 'access': return 'INTEGER';
        default: return 'INTEGER';
    }
}

export interface TranslationResult {
    canonicalType: string;
    targetType: string;
    warnings: string[];
}

/**
 * Full translation pipeline: source type -> canonical -> target dialect type.
 */
export function translateType(targetKind: DatabaseKind, sourceType: string): TranslationResult {
    const canonical = toCanonicalType(sourceType);
    const rendered = renderTargetType(targetKind, canonical.type);
    return {
        canonicalType: canonical.type,
        targetType: rendered.type,
        warnings: [...canonical.warnings, ...rendered.warnings],
    };
}

export function getUnknownTypeFamilyLabel(sourceType: string): string {
    const parsed = parseSqlType(sourceType);
    return getSqlTypeFamilyLabel(classifySqlTypeFamily(parsed));
}
