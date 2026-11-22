import type {
    DatabaseColumnTypeChooser,
    DatabaseImportDataType,
    DatabaseImportTypeMapper,
} from '@justybase/contracts';
import { ColumnTypeChooser } from '@justybase/database-utils/importTypeMapping';

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
        const base = normalized.replace(/\(.*$/, '').trim();
        const typeArguments = normalized.match(/\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/);

        if (/^(CLOB|LONGTEXT|MEMO|NTEXT|JSON|JSONB)$/.test(base)) {
            return 'MEMO';
        }
        if (/^(VARCHAR|NVARCHAR|CHAR|NCHAR|CHARACTER|STRING|BPCHAR|TEXT)$/.test(base)) {
            // Access TEXT(n) counts characters; values that cannot fit into
            // 255 characters belong in MEMO.
            const explicitLength = typeArguments ? Number(typeArguments[1]) : this.length;
            if (explicitLength === undefined) {
                // A bare TEXT is an unbounded long-text type, while a bare
                // VARCHAR defaults to the Access text width.
                return base === 'TEXT' ? 'MEMO' : 'TEXT(255)';
            }
            return explicitLength > 255 ? 'MEMO' : `TEXT(${Math.max(1, explicitLength)})`;
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
        if (/^(BINARY|VARBINARY|BLOB|IMAGE|BYTEA|OLE|LONGBINARY|LONGVARBINARY)$/.test(base)) {
            return 'OLE';
        }
        if (/^(NUMERIC|DECIMAL|DEC|NUMBER)$/.test(base)) {
            const precision = typeArguments ? Number(typeArguments[1]) : this.precision ?? 18;
            const scale = typeArguments?.[2] ? Number(typeArguments[2]) : this.scale ?? 0;
            return `DECIMAL(${precision},${scale})`;
        }
        return base || 'MEMO';
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
