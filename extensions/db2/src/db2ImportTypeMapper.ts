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
 * into Db2 LUW-specific data types.
 */
export class Db2ImportDataType implements DatabaseImportDataType {
    constructor(
        public dbType: string,
        public precision?: number,
        public scale?: number,
        public length?: number
    ) { }

    toString(): string {
        const normalizedType = this.dbType.trim().toUpperCase();

        if (normalizedType === 'DATETIME') {
            return 'TIMESTAMP';
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

        if (normalizedType === 'NVARCHAR') {
            return `NVARCHAR(${normalizePositiveInteger(this.length, DEFAULT_VARCHAR_LENGTH)})`;
        }

        if (normalizedType === 'VARCHAR') {
            return `VARCHAR(${normalizePositiveInteger(this.length, DEFAULT_VARCHAR_LENGTH)})`;
        }

        if (normalizedType === 'CHAR') {
            return `CHAR(${normalizePositiveInteger(this.length, DEFAULT_CHAR_LENGTH)})`;
        }

        if (normalizedType === 'BIGINT' || normalizedType === 'INTEGER' || normalizedType === 'INT') {
            return 'BIGINT';
        }

        if (normalizedType === 'BOOLEAN') {
            return 'BOOLEAN';
        }

        if (normalizedType === 'DATE') {
            return 'DATE';
        }

        if (normalizedType === 'TEXT' || normalizedType === 'CLOB') {
            return 'CLOB';
        }

        if (normalizedType === 'BLOB') {
            return 'BLOB';
        }

        if (normalizedType === 'DECFLOAT') {
            return 'DECFLOAT';
        }

        return normalizedType;
    }
}

/**
 * Type mapper for Db2 LUW data imports.
 * Reuses the Netezza ColumnTypeChooser for robust CSV type inference,
 * then maps the results to Db2 types via Db2ImportDataType.
 */
export const db2ImportTypeMapper: DatabaseImportTypeMapper = {
    createDataType(
        dbType: string,
        precision?: number,
        scale?: number,
        length?: number
    ): DatabaseImportDataType {
        return new Db2ImportDataType(dbType, precision, scale, length);
    },
    createColumnTypeChooser(decimalDelimiter?: string): DatabaseColumnTypeChooser {
        return new ColumnTypeChooser(decimalDelimiter);
    }
};
