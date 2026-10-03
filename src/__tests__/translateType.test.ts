/**
 * Table-driven coverage for the cross-dialect type translation pipeline.
 *
 * These modules are pure and drive every migration plan, so they are the
 * highest-leverage coverage target in `src/migration`.
 */

import {
    getSqlTypeFamilyLabel,
    classifySqlTypeFamily,
    type SqlTypeFamily,
} from '../migration/typeTranslation/classifySqlType';
import { getNumericScaleFromType, parseSqlType } from '../migration/typeTranslation/parseSqlType';
import {
    getUnknownTypeFamilyLabel,
    MAX_CANONICAL_PRECISION,
    MAX_CANONICAL_SCALE,
    renderTargetType,
    toCanonicalType,
    translateType,
} from '../migration/typeTranslation/translateType';

describe('parseSqlType', () => {
    it('parses numeric precision and scale', () => {
        expect(parseSqlType('NUMERIC(10,2)')).toMatchObject({ base: 'NUMERIC', precision: 10, scale: 2 });
        expect(parseSqlType('DECIMAL(8)')).toMatchObject({ base: 'DECIMAL', precision: 8 });
        expect(parseSqlType('NUMBER(38, 12)')).toMatchObject({ base: 'NUMBER', precision: 38, scale: 12 });
    });

    it('parses single-parameter lengths including CHAR/BYTE suffixes', () => {
        expect(parseSqlType('VARCHAR(255)')).toMatchObject({ base: 'VARCHAR', length: 255 });
        expect(parseSqlType('VARCHAR2(4000)')).toMatchObject({ base: 'VARCHAR2', length: 4000 });
        expect(parseSqlType('RAW(16)')).toMatchObject({ base: 'RAW', length: 16 });
    });

    it('detects time-zone timestamps and times', () => {
        expect(parseSqlType('TIMESTAMP(3) WITH TIME ZONE')).toMatchObject({ base: 'TIMESTAMP', withTimeZone: true, scale: 3 });
        expect(parseSqlType('TIMESTAMP WITH LOCAL TIME ZONE')).toMatchObject({ base: 'TIMESTAMP', withTimeZone: true });
        expect(parseSqlType('TIMESTAMP')).toMatchObject({ base: 'TIMESTAMP', withTimeZone: false });
        expect(parseSqlType('TIME WITH TIME ZONE')).toMatchObject({ base: 'TIME', withTimeZone: true });
    });

    it('handles empty input', () => {
        expect(parseSqlType(undefined)).toEqual({ base: '', normalized: '' });
        expect(parseSqlType('   ')).toEqual({ base: '', normalized: '' });
    });

    it('exposes numeric scale only for decimal bases', () => {
        expect(getNumericScaleFromType('NUMERIC(10,4)')).toBe(4);
        expect(getNumericScaleFromType('VARCHAR(10)')).toBeUndefined();
    });
});

describe('classifySqlTypeFamily', () => {
    it.each([
        ['BYTEINT', 'integer'],
        ['BIGSERIAL', 'integer'],
        ['FIXED', 'decimal'],
        ['BINARY_FLOAT', 'float'],
        ['BOOL', 'boolean'],
        ['DATE', 'date'],
        ['TIMETZ', 'time'],
        ['TIMESTAMPTZ', 'timestamp'],
        ['INTERVAL', 'interval'],
        ['NCHAR', 'char'],
        ['CHARACTER VARYING', 'varchar'],
        ['NVARCHAR2', 'nvarchar'],
        ['LONGTEXT', 'text'],
        ['NCLOB', 'clob'],
        ['BYTEA', 'blob'],
        ['VARBINARY', 'binary'],
        ['GUID', 'uuid'],
        ['VARIANT', 'json'],
        ['XML', 'xml'],
        ['SMALLMONEY', 'money'],
        ['NOT_A_TYPE', 'unknown'],
    ] as [string, SqlTypeFamily][])('classifies %s as %s', (type, family) => {
        expect(classifySqlTypeFamily(parseSqlType(type))).toBe(family);
    });

    it('returns unknown for an empty base', () => {
        expect(classifySqlTypeFamily(parseSqlType(''))).toBe('unknown');
    });

    it('labels every family', () => {
        expect(getSqlTypeFamilyLabel('float')).toBe('floating point');
        expect(getSqlTypeFamilyLabel('nvarchar')).toBe('unicode character');
        expect(getSqlTypeFamilyLabel('unknown')).toBe('unknown');
    });
});

describe('toCanonicalType', () => {
    it.each([
        ['BYTEINT', 'BYTEINT'],
        ['TINYINT', 'BYTEINT'],
        ['INT1', 'BYTEINT'],
        ['SMALLINT', 'SMALLINT'],
        ['INT2', 'SMALLINT'],
        ['YEAR', 'SMALLINT'],
        ['INT', 'INT'],
        ['INTEGER', 'INT'],
        ['BIGINT', 'BIGINT'],
        ['INT8', 'BIGINT'],
        ['INT64', 'BIGINT'],
        ['BIGSERIAL', 'BIGINT'],
        ['NUMERIC(10,2)', 'NUMERIC(10,2)'],
        ['REAL', 'REAL'],
        ['FLOAT4', 'REAL'],
        ['BINARY_FLOAT', 'REAL'],
        ['DECFLOAT', 'DECFLOAT'],
        ['DOUBLE', 'DOUBLE'],
        ['BOOLEAN', 'BOOLEAN'],
        ['DATE', 'DATE'],
        ['TIME', 'TIME'],
        ['TIMETZ', 'TIMETZ'],
        ['TIMESTAMP', 'TIMESTAMP'],
        ['TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH TIME ZONE'],
        ['DATETIME', 'DATETIME'],
        ['INTERVAL', 'INTERVAL'],
        ['CHAR', 'CHAR(1)'],
        ['CHAR(10)', 'CHAR(10)'],
        ['VARCHAR', 'VARCHAR(255)'],
        ['NVARCHAR(20)', 'NVARCHAR(20)'],
        ['TEXT', 'TEXT'],
        ['CLOB', 'CLOB'],
        ['NCLOB', 'NCLOB'],
        ['NTEXT', 'NCLOB'],
        ['BLOB', 'BLOB'],
        ['BINARY', 'VARBINARY(2000)'],
        ['UUID', 'UUID'],
        ['JSON', 'JSON'],
        ['JSONB', 'JSONB'],
        ['VARIANT', 'JSONB'],
        ['XML', 'XML'],
        ['MONEY', 'MONEY'],
    ])('maps %s to %s', (source, canonical) => {
        expect(toCanonicalType(source).type).toBe(canonical);
    });

    it('caps precision and scale and warns', () => {
        const result = toCanonicalType('NUMERIC(40,20)');
        expect(result.type).toBe(`NUMERIC(${MAX_CANONICAL_PRECISION},${MAX_CANONICAL_SCALE})`);
        expect(result.warnings).toHaveLength(2);
        expect(result.warnings.join(' ')).toMatch(/scale/);
        expect(result.warnings.join(' ')).toMatch(/precision/);
    });

    it('raises precision to the scale when precision is smaller', () => {
        expect(toCanonicalType('NUMBER(5,10)').type).toBe('NUMERIC(10,10)');
    });

    it('maps an unknown type to text and warns', () => {
        const result = toCanonicalType('MYSTERY_TYPE');
        expect(result.type).toBe('NVARCHAR(255)');
        expect(result.warnings.join(' ')).toMatch(/not recognized/);
    });
});

describe('renderTargetType', () => {
    it.each([
        ['netezza', 'INTEGER', 'BIGINT'],
        ['netezza', 'BOOLEAN', 'BIGINT'],
        ['netezza', 'TIMESTAMP', 'DATETIME'],
        ['netezza', 'MONEY', 'NUMERIC(19,4)'],
        ['postgresql', 'INTEGER', 'INTEGER'],
        ['postgresql', 'BOOLEAN', 'BOOLEAN'],
        ['postgresql', 'JSON', 'JSONB'],
        ['oracle', 'INTEGER', 'NUMBER(10,0)'],
        ['oracle', 'BOOLEAN', 'NUMBER(1)'],
        ['oracle', 'UUID', 'RAW(16)'],
        ['db2', 'INTEGER', 'INTEGER'],
        ['db2', 'BOOLEAN', 'BOOLEAN'],
        ['mssql', 'INTEGER', 'INT'],
        ['mssql', 'BOOLEAN', 'BIT'],
        ['mssql', 'UUID', 'UNIQUEIDENTIFIER'],
        ['mysql', 'INTEGER', 'INT'],
        ['mysql', 'BOOLEAN', 'BOOLEAN'],
        ['sqlite', 'INTEGER', 'INTEGER'],
        ['sqlite', 'DECIMAL(10,2)', 'NUMERIC'],
        ['sqlite', 'BOOLEAN', 'INTEGER'],
        ['duckdb', 'INTEGER', 'INTEGER'],
        ['duckdb', 'TEXT', 'VARCHAR'],
        ['vertica', 'INTEGER', 'INTEGER'],
        ['vertica', 'TEXT', 'LONG VARCHAR'],
        ['snowflake', 'INTEGER', 'INTEGER'],
        ['snowflake', 'JSON', 'VARIANT'],
        ['access', 'INTEGER', 'INTEGER'],
        ['access', 'TEXT', 'MEMO'],
        ['access', 'MONEY', 'CURRENCY'],
    ] as [string, string, string][])('renders %s %s as %s', (kind, canonical, expected) => {
        expect(renderTargetType(kind as never, canonical).type).toBe(expected);
    });

    it('renders time-zone timestamps per dialect', () => {
        expect(renderTargetType('postgresql', 'TIMESTAMP WITH TIME ZONE').type).toBe('TIMESTAMPTZ');
        expect(renderTargetType('mssql', 'TIMESTAMP WITH TIME ZONE').type).toBe('DATETIMEOFFSET');
        expect(renderTargetType('snowflake', 'TIMESTAMP WITH TIME ZONE').type).toBe('TIMESTAMP_TZ');
    });

    it('emits warnings for capped and unsupported types', () => {
        expect(renderTargetType('oracle', 'VARCHAR(5000)').warnings.join(' ')).toMatch(/4000/);
        expect(renderTargetType('db2', 'VARCHAR(40000)').warnings.join(' ')).toMatch(/32672/);
        expect(renderTargetType('mssql', 'NVARCHAR(5000)').warnings.join(' ')).toMatch(/4000/);
        expect(renderTargetType('mysql', 'VARCHAR(70000)').warnings.join(' ')).toMatch(/65535/);
        expect(renderTargetType('mssql', 'INTERVAL').warnings.join(' ')).toMatch(/not supported/);
        expect(renderTargetType('mysql', 'INTERVAL').warnings.join(' ')).toMatch(/not supported/);
        expect(renderTargetType('access', 'INTERVAL').warnings.join(' ')).toMatch(/not supported/);
        expect(renderTargetType('netezza', 'TEXT').warnings.join(' ')).toMatch(/NVARCHAR\(1024\)/);
        expect(renderTargetType('netezza', 'BLOB').warnings.join(' ')).toMatch(/BLOB/);
        expect(renderTargetType('netezza', 'BINARY').warnings.join(' ')).toMatch(/Binary/);
    });

    it('falls back to the canonical type for an unknown target dialect', () => {
        const result = renderTargetType('unsupported' as never, 'NUMERIC(10,2)');
        expect(result.type).toBe('NUMERIC(10,2)');
        expect(result.warnings.join(' ')).toMatch(/No type translation/);
    });
});

describe('translateType', () => {
    it('runs the full pipeline and merges warnings', () => {
        expect(translateType('oracle', 'NUMBER(40,20)')).toMatchObject({
            canonicalType: `NUMERIC(${MAX_CANONICAL_PRECISION},${MAX_CANONICAL_SCALE})`,
            targetType: `NUMBER(${MAX_CANONICAL_PRECISION},${MAX_CANONICAL_SCALE})`,
        });
        expect(translateType('postgresql', 'TEXT')).toMatchObject({ canonicalType: 'TEXT', targetType: 'TEXT' });
    });

    it('reports the unknown family label', () => {
        expect(getUnknownTypeFamilyLabel('MYSTERY')).toBe('unknown');
        expect(getUnknownTypeFamilyLabel('BIGINT')).toBe('integer');
    });
});
