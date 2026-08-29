import type {
    DatabaseColumnTypeChooser,
    DatabaseImportDataType,
    DatabaseImportTypeMapper,
} from '@justybase/contracts';
import { ColumnTypeChooser } from '../../../src/dialects/netezza/import/typeMapping';

function positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : fallback;
}

export class ClickHouseImportDataType implements DatabaseImportDataType {
    public constructor(
        public dbType: string,
        public precision?: number,
        public scale?: number,
        public length?: number,
    ) {}

    public toString(): string {
        const type = this.dbType.trim().toUpperCase();
        if (type === 'BOOLEAN' || type === 'BOOL') return 'Bool';
        if (type === 'DATE') return 'Date';
        if (type === 'DATETIME' || type === 'TIMESTAMP') return 'DateTime64(3)';
        if (type === 'UUID') return 'UUID';
        if (type === 'TEXT' || type === 'CLOB' || type === 'VARCHAR' || type === 'NVARCHAR' || type === 'CHAR' || type === 'JSON') return 'String';
        if (type === 'SMALLINT' || type === 'TINYINT' || type === 'INTEGER' || type === 'INT' || type === 'BIGINT') return 'Int64';
        if (type === 'FLOAT' || type === 'REAL' || type === 'DOUBLE') return 'Float64';
        if (type === 'NUMERIC' || type === 'DECIMAL' || type === 'NUMBER') {
            const precision = positiveInteger(this.precision, 38);
            const scale = Math.max(0, Math.min(this.scale ?? 10, precision - 1));
            return `Decimal(${precision},${scale})`;
        }
        if (type === 'VARCHAR2') return 'String';
        return this.dbType.trim() || 'String';
    }
}

export const clickhouseImportTypeMapper: DatabaseImportTypeMapper = {
    createDataType(dbType, precision, scale, length): DatabaseImportDataType {
        return new ClickHouseImportDataType(dbType, precision, scale, length);
    },
    createColumnTypeChooser(decimalDelimiter?: string): DatabaseColumnTypeChooser {
        return new ColumnTypeChooser(decimalDelimiter);
    },
};
