/**
 * Maps Netezza SQL column types to SAS XPORT v5 variable attributes.
 */

export interface SasColumnDef {
    /** 1=numeric, 2=character */
    sasType: number;
    /** Storage length in bytes (8 for numeric, variable for character) */
    length: number;
    /** Position in the observation record (1-based) */
    position: number;
    /** SAS label (max 40) */
    label: string;
    /** SAS output format name (e.g. "DATE9.", "DATETIME.") */
    format: string;
    /** SAS output format length */
    formatLength: number;
    /** SAS input/informat name */
    inform: string;
    /** SAS input/informat length */
    informLength: number;
}

export interface ColumnMappingWarning {
    column: string;
    message: string;
}

const NUMERIC_LENGTH = 8; // Standard SAS numeric is 8 bytes

/**
 * Map a Netezza column type to SAS XPORT attributes.
 *
 * @param columnName - Original Netezza column name (for warnings).
 * @param netezzaType - Netezza SQL type (VARCHAR, INTEGER, DATE, etc.).
 * @param width - Character width for CHAR/VARCHAR (or undefined for numeric).
 * @param label - Optional column label.
 */
export function mapColumnType(
    columnName: string,
    netezzaType: string | undefined,
    width: number | undefined,
    label: string | undefined,
): { def: SasColumnDef; dropped: boolean; warning?: ColumnMappingWarning } {
    const upperType = (netezzaType || '').toUpperCase();

    // Detect numeric types.
    if (isNumericType(upperType)) {
        return {
            def: {
                sasType: 1,
                length: NUMERIC_LENGTH,
                position: 0, // filled in later
                label: (label || columnName).slice(0, 40),
                format: '',
                formatLength: 0,
                inform: '',
                informLength: 0,
            },
            dropped: false,
        };
    }

    // DATE type → SAS numeric with DATE9. format
    if (upperType === 'DATE') {
        return {
            def: {
                sasType: 1,
                length: NUMERIC_LENGTH,
                position: 0,
                label: (label || columnName).slice(0, 40),
                format: 'DATE9.',
                formatLength: 9,
                inform: 'DATE9.',
                informLength: 9,
            },
            dropped: false,
        };
    }

    // TIMESTAMP types → SAS numeric with DATETIME. format
    if (
        upperType === 'TIMESTAMP' ||
        upperType === 'TIMESTAMPTZ' ||
        upperType === 'TIMESTAMP WITH TIME ZONE' ||
        upperType === 'TIMESTAMP WITHOUT TIME ZONE' ||
        upperType === 'DATETIME'
    ) {
        return {
            def: {
                sasType: 1,
                length: NUMERIC_LENGTH,
                position: 0,
                label: (label || columnName).slice(0, 40),
                format: 'DATETIME.',
                formatLength: 18,
                inform: 'DATETIME.',
                informLength: 18,
            },
            dropped: false,
        };
    }

    // TIME type → SAS numeric (seconds since midnight)
    if (upperType.startsWith('TIME')) {
        return {
            def: {
                sasType: 1,
                length: NUMERIC_LENGTH,
                position: 0,
                label: (label || columnName).slice(0, 40),
                format: 'TIME8.',
                formatLength: 8,
                inform: 'TIME8.',
                informLength: 8,
            },
            dropped: false,
        };
    }

    // BOOLEAN → numeric 0/1
    if (upperType === 'BOOLEAN' || upperType === 'BOOL') {
        return {
            def: {
                sasType: 1,
                length: NUMERIC_LENGTH,
                position: 0,
                label: (label || columnName).slice(0, 40),
                format: '',
                formatLength: 0,
                inform: '',
                informLength: 0,
            },
            dropped: false,
        };
    }

    // String/character types.
    if (
        upperType.startsWith('CHAR') ||
        upperType.startsWith('VARCHAR') ||
        upperType.startsWith('NVARCHAR') ||
        upperType.startsWith('NCHAR') ||
        upperType.startsWith('TEXT') ||
        upperType.startsWith('CLOB') ||
        upperType === 'STRING'
    ) {
        const charWidth = width ?? 255;
        return {
            def: {
                sasType: 2,
                length: Math.min(charWidth, 65535), // SAS supports up to 65535 for char
                position: 0,
                label: (label || columnName).slice(0, 40),
                format: '',
                formatLength: 0,
                inform: '',
                informLength: 0,
            },
            dropped: false,
        };
    }

    // Unsupported types (BLOB, BINARY, VARBINARY, JSON, ARRAY, etc.)
    return {
        def: {
            sasType: 2,
            length: 1,
            position: 0,
            label: '',
            format: '',
            formatLength: 0,
            inform: '',
            informLength: 0,
        },
        dropped: true,
        warning: {
            column: columnName,
            message: `Skipping column "${columnName}" with unsupported type "${netezzaType || 'unknown'}" (SAS XPORT v5 does not support binary/complex types)`,
        },
    };
}

function isNumericType(type: string): boolean {
    const numerics = new Set([
        'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'BYTEINT',
        'NUMERIC', 'DECIMAL', 'NUMBER', 'DEC',
        'REAL', 'FLOAT', 'FLOAT4', 'FLOAT8', 'DOUBLE',
        'DOUBLE PRECISION', 'BINARY_DOUBLE', 'BINARY_FLOAT',
    ]);
    // Also match types like INT, INT2, INT4, INT8, etc.
    for (const n of numerics) {
        if (type === n) return true;
    }
    if (/^(INT|INTEGER)\d*$/.test(type)) return true;
    if (/^(NUMERIC|DECIMAL|DEC)\s*\(/.test(type)) return true;
    return false;
}
