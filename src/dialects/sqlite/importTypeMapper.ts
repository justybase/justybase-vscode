import type {
    DatabaseColumnTypeChooser,
    DatabaseImportDataType,
    DatabaseImportTypeMapper,
} from '../../contracts/database';
import { ColumnTypeChooser } from '../netezza/import/typeMapping';

function normalizeType(type: string): string {
    return type.trim().toUpperCase();
}

export class SqliteImportDataType implements DatabaseImportDataType {
    public constructor(
        public dbType: string,
        public precision?: number,
        public scale?: number,
        public length?: number,
    ) {}

    public toString(): string {
        const normalized = normalizeType(this.dbType);
        if (normalized.startsWith('NUMERIC') || normalized.startsWith('DECIMAL')) {
            if (Number.isFinite(this.precision) && Number.isFinite(this.scale)) {
                return `NUMERIC(${Math.floor(this.precision!)},${Math.floor(this.scale!)})`;
            }
            const parameterMatch = normalized.match(/^(?:NUMERIC|DECIMAL)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/);
            if (parameterMatch) {
                return parameterMatch[2]
                    ? `NUMERIC(${parameterMatch[1]},${parameterMatch[2]})`
                    : `NUMERIC(${parameterMatch[1]})`;
            }
            return 'NUMERIC';
        }

        if (normalized.startsWith('VARCHAR') || normalized.startsWith('CHAR') || normalized.startsWith('NVARCHAR')) {
            return 'TEXT';
        }

        if (normalized === 'BOOLEAN' || normalized === 'INT' || normalized === 'BIGINT') {
            return 'INTEGER';
        }

        // Preserve the historical import behavior so existing imports do not
        // silently change their DATE/TIMESTAMP family mapping.
        if (normalized === 'DATE') {
            return 'DATE';
        }
        if (normalized === 'DATETIME' || normalized === 'TIMESTAMP') {
            return 'TIMESTAMP';
        }
        if (normalized === 'TIME') {
            return 'TEXT';
        }

        return normalized || 'TEXT';
    }
}

/** Shared SQLite type mapping used by the import wizard and programmatic imports. */
export const sqliteImportTypeMapper: DatabaseImportTypeMapper = {
    createDataType(
        dbType: string,
        precision?: number,
        scale?: number,
        length?: number,
    ): DatabaseImportDataType {
        return new SqliteImportDataType(dbType, precision, scale, length);
    },
    createColumnTypeChooser(decimalDelimiter?: string): DatabaseColumnTypeChooser {
        return new ColumnTypeChooser(decimalDelimiter);
    },
};
