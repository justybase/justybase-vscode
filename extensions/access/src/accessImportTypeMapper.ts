import type {
    DatabaseColumnTypeChooser,
    DatabaseImportDataType,
    DatabaseImportTypeMapper,
} from '@justybase/contracts';
import { ColumnTypeChooser } from '../../../src/dialects/netezza/import/typeMapping';

function normalizeType(type: string): string {
    return type.trim().toUpperCase();
}

/**
 * Maps a generic source type to the Access DDL type accepted by the
 * JustyBase.UCanAccessCs grammar (COUNTER/LONG/DOUBLE/CURRENCY/DATETIME/
 * BOOLEAN/TEXT(n)/MEMO/GUID).
 */
export class AccessImportDataType implements DatabaseImportDataType {
    public constructor(
        public dbType: string,
        public precision?: number,
        public scale?: number,
        public length?: number,
    ) {}

    public toString(): string {
        const normalized = normalizeType(this.dbType);
        const base = normalized.replace(/\(.*$/, '');
        if (/^(VARCHAR|NVARCHAR|CHAR|NCHAR|TEXT|STRING|BPCHAR|CLOB|LONGTEXT|MEMO|NTEXT|JSONB)$/.test(base)) {
            return 'TEXT';
        }
        if (/^(INT|INTEGER|INT2|INT4|SMALLINT|TINYINT|SHORT|MEDIUMINT)$/.test(base)) {
            return 'INTEGER';
        }
        if (/^(BIGINT|INT8|LONG|COUNTER|SERIAL|BIGSERIAL|AUTOINCREMENT)$/.test(base)) {
            return 'LONG';
        }
        if (/^(REAL|FLOAT4|SINGLE)$/.test(base)) {
            return 'SINGLE';
        }
        if (/^(FLOAT|FLOAT8|DOUBLE|DOUBLE PRECISION)$/.test(base)) {
            return 'DOUBLE';
        }
        if (/^(MONEY|CURRENCY|SMALLMONEY)$/.test(base)) {
            return 'CURRENCY';
        }
        if (/^(DATETIME|DATETIME2|SMALLDATETIME|TIMESTAMP|TIMESTAMPTZ|DATE|TIME)$/.test(base)) {
            return 'DATETIME';
        }
        if (/^(BOOLEAN|BOOL|BIT|YESNO|LOGICAL)$/.test(base)) {
            return 'BOOLEAN';
        }
        if (/^(UUID|UNIQUEIDENTIFIER|GUID)$/.test(base)) {
            return 'GUID';
        }
        if (/^(BINARY|VARBINARY|BLOB|IMAGE|BYTEA|OLE)$/.test(base)) {
            return 'BINARY';
        }
        if (/^(NUMERIC|DECIMAL|DEC|NUMBER)$/.test(base)) {
            return 'DECIMAL';
        }
        return base || 'TEXT';
    }
}

/** Access type mapping used by the import wizard and programmatic imports. */
export const accessImportTypeMapper: DatabaseImportTypeMapper = {
    createDataType(
        dbType: string,
        precision?: number,
        scale?: number,
        length?: number,
    ): DatabaseImportDataType {
        return new AccessImportDataType(dbType, precision, scale, length);
    },
    createColumnTypeChooser(decimalDelimiter?: string): DatabaseColumnTypeChooser {
        return new ColumnTypeChooser(decimalDelimiter);
    },
};
