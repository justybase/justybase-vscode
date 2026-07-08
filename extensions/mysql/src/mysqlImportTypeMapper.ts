import type {
    DatabaseColumnTypeChooser,
    DatabaseImportDataType,
    DatabaseImportTypeMapper
} from '@justybase/contracts';
import { ColumnTypeChooser } from '../../../src/dialects/netezza/import/typeMapping';

const DEFAULT_VARCHAR_LENGTH = 255;
const DEFAULT_CHAR_LENGTH = 1;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value) || (value ?? 0) < 1) {
        return fallback;
    }

    return Math.floor(value!);
}

/**
 * Maps the standard database-agnostic types inferred from CSV/Excel files
 * into MySQL-specific data types.
 */
export class MysqlImportDataType implements DatabaseImportDataType {
    constructor(
        public dbType: string,
        public precision?: number,
        public scale?: number,
        public length?: number
    ) { }

    toString(): string {
        const normalizedType = this.dbType.trim().toUpperCase();

        if (normalizedType === 'DATETIME') {
            return 'DATETIME';
        }

        if (normalizedType === 'NUMERIC' || normalizedType === 'DECIMAL') {
            if (Number.isFinite(this.precision) && Number.isFinite(this.scale)) {
                return `DECIMAL(${Math.floor(this.precision!)},${Math.floor(this.scale!)})`;
            }

            if (Number.isFinite(this.precision)) {
                return `DECIMAL(${Math.floor(this.precision!)})`;
            }

            return 'DECIMAL';
        }

        if (normalizedType === 'NVARCHAR' || normalizedType === 'VARCHAR') {
            return `VARCHAR(${normalizePositiveInteger(this.length, DEFAULT_VARCHAR_LENGTH)})`;
        }

        if (normalizedType === 'CHAR') {
            return `CHAR(${normalizePositiveInteger(this.length, DEFAULT_CHAR_LENGTH)})`;
        }

        if (normalizedType === 'BIGINT' || normalizedType === 'INTEGER' || normalizedType === 'INT') {
            return 'BIGINT';
        }

        if (normalizedType === 'BOOLEAN') {
            return 'TINYINT(1)';
        }

        if (normalizedType === 'DATE') {
            return 'DATE';
        }

        if (normalizedType === 'TEXT' || normalizedType === 'CLOB') {
            return 'LONGTEXT';
        }

        if (normalizedType === 'JSON') {
            return 'JSON';
        }

        return normalizedType;
    }
}

/**
 * Type mapper for MySQL data imports.
 * Reuses the Netezza ColumnTypeChooser for robust CSV type inference,
 * then maps the results to MySQL types via MysqlImportDataType.
 */
export const mysqlImportTypeMapper: DatabaseImportTypeMapper = {
    createDataType(
        dbType: string,
        precision?: number,
        scale?: number,
        length?: number
    ): DatabaseImportDataType {
        return new MysqlImportDataType(dbType, precision, scale, length);
    },
    createColumnTypeChooser(decimalDelimiter?: string): DatabaseColumnTypeChooser {
        return new ColumnTypeChooser(decimalDelimiter);
    }
};
