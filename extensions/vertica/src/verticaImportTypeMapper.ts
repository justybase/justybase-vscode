import type {
    DatabaseColumnTypeChooser,
    DatabaseImportDataType,
    DatabaseImportTypeMapper,
} from '@justybase/contracts';
import { ColumnTypeChooser } from '../../../src/dialects/netezza/import/typeMapping';

const DEFAULT_VARCHAR_LENGTH = 255;
const DEFAULT_CHAR_LENGTH = 1;
const DEFAULT_BINARY_LENGTH = 255;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value) || (value ?? 0) < 1) {
        return fallback;
    }

    return Math.floor(value!);
}

export class VerticaImportDataType implements DatabaseImportDataType {
    public constructor(
        public dbType: string,
        public precision?: number,
        public scale?: number,
        public length?: number,
    ) {}

    public toString(): string {
        const normalizedType = this.dbType.trim().toUpperCase();

        if (normalizedType === 'DATETIME') {
            return 'TIMESTAMP';
        }
        if (normalizedType === 'TIMESTAMP WITH TIME ZONE') {
            return 'TIMESTAMPTZ';
        }
        if (normalizedType === 'NUMERIC' || normalizedType === 'DECIMAL') {
            if (Number.isFinite(this.precision) && Number.isFinite(this.scale)) {
                return `NUMERIC(${Math.floor(this.precision!)},${Math.floor(this.scale!)})`;
            }
            if (Number.isFinite(this.precision)) {
                return `NUMERIC(${Math.floor(this.precision!)})`;
            }
            return 'NUMERIC';
        }
        if (normalizedType === 'NVARCHAR' || normalizedType === 'VARCHAR') {
            return `VARCHAR(${normalizePositiveInteger(this.length, DEFAULT_VARCHAR_LENGTH)})`;
        }
        if (normalizedType === 'CHAR' || normalizedType === 'CHARACTER') {
            return `CHAR(${normalizePositiveInteger(this.length, DEFAULT_CHAR_LENGTH)})`;
        }
        if (normalizedType === 'VARBINARY' || normalizedType === 'BINARY') {
            return `VARBINARY(${normalizePositiveInteger(this.length, DEFAULT_BINARY_LENGTH)})`;
        }
        if (normalizedType === 'TEXT' || normalizedType === 'LONGVARCHAR' || normalizedType === 'LONG VARCHAR') {
            return 'LONG VARCHAR';
        }

        return normalizedType;
    }
}

export const verticaImportTypeMapper: DatabaseImportTypeMapper = {
    createDataType(
        dbType: string,
        precision?: number,
        scale?: number,
        length?: number,
    ): DatabaseImportDataType {
        return new VerticaImportDataType(dbType, precision, scale, length);
    },
    createColumnTypeChooser(decimalDelimiter?: string): DatabaseColumnTypeChooser {
        return new ColumnTypeChooser(decimalDelimiter);
    },
};
