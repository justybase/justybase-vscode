import {
    getEffectiveResultColumnType,
    normalizeResultColumnType as normalizeResultMetadataType
} from './resultColumnMetadata';

/**
 * Formats and transforms query results for different consumers.
 * Handles type conversions, especially for BigInt values.
 */
export class ResultFormatter {
    /**
     * Convert QueryResult (columns[] + data[][]) to array of typed objects.
     * This avoids JSON serialization/deserialization overhead.
     */
    static queryResultToRows<T extends Record<string, unknown>>(result: {
        columns: { name: string; type?: string; scale?: number }[];
        data: unknown[][];
    }): T[] {
        if (!result.columns || !result.data || result.data.length === 0) {
            return [];
        }

        return result.data.map(row => {
            const obj: Record<string, unknown> = {};
            result.columns.forEach((col, index) => {
                let value = row[index];
                // Handle BigInt like JSON.stringify does
                if (typeof value === 'bigint') {
                    if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
                        value = Number(value);
                    } else {
                        value = value.toString();
                    }
                }
                obj[col.name] = value;
            });
            return obj as T;
        });
    }

    /**
     * Handle BigInt conversion safely
     */
    static handleBigInt(value: bigint): number | string {
        if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
            return Number(value);
        }
        return value.toString();
    }

    /**
     * Extract column metadata from a reader
     */
    static extractColumns(reader: { fieldCount: number; getName(i: number): string; getTypeName(i: number): string }): {
        name: string;
        type?: string;
        scale?: number;
    }[] {
        const columns: { name: string; type?: string; scale?: number }[] = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            columns.push({ name: reader.getName(i), type: getEffectiveResultColumnType(reader, i) });
        }
        return columns;
    }
    static normalizeResultColumnType(type?: string): string | undefined {
        return normalizeResultMetadataType(type);
    }
}
