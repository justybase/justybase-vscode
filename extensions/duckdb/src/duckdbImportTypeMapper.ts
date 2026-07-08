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
 * into DuckDB-specific data types.
 */
export class DuckDbImportDataType implements DatabaseImportDataType {
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

        if (normalizedType === 'NVARCHAR' || normalizedType === 'VARCHAR') {
            return `VARCHAR(${normalizePositiveInteger(this.length, DEFAULT_VARCHAR_LENGTH)})`;
        }

        if (normalizedType === 'CHAR') {
            return `VARCHAR(${normalizePositiveInteger(this.length, DEFAULT_CHAR_LENGTH)})`;
        }

        if (normalizedType === 'BIGINT' || normalizedType === 'INTEGER' || normalizedType === 'INT') {
            return 'BIGINT';
        }

        if (normalizedType === 'DATE') {
            return 'DATE';
        }

        if (normalizedType === 'BOOLEAN') {
            return 'BOOLEAN';
        }

        if (normalizedType === 'TEXT' || normalizedType === 'CLOB') {
            return 'VARCHAR';
        }

        if (normalizedType === 'JSON') {
            return 'JSON';
        }

        return normalizedType;
    }
}

/**
 * Type mapper for DuckDB data imports.
 * Reuses the Netezza ColumnTypeChooser for robust CSV type inference,
 * then maps the results to DuckDB types via DuckDbImportDataType.
 */
export const duckdbImportTypeMapper: DatabaseImportTypeMapper = {
    createDataType(
        dbType: string,
        precision?: number,
        scale?: number,
        length?: number
    ): DatabaseImportDataType {
        return new DuckDbImportDataType(dbType, precision, scale, length);
    },
    createColumnTypeChooser(decimalDelimiter?: string): DatabaseColumnTypeChooser {
        return new ColumnTypeChooser(decimalDelimiter);
    }
};
