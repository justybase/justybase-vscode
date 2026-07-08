type ReaderSchemaRow = {
    ColumnName?: string;
    ColumnOrdinal?: number;
    ColumnSize?: number;
    NumericPrecision?: number;
    NumericScale?: number;
    ProviderType?: number;
};

type ReaderSchemaTable = { Rows?: ReaderSchemaRow[] } | ReaderSchemaRow[] | null | undefined;

type ReaderColumnDescription = {
    name?: string;
    typeOid?: number;
    typeLen?: number;
    typeMod?: number;
    format?: number;
};

type ReaderColumnMetadata = Record<string, unknown> | null | undefined;

type ResultMetadataReader = {
    getTypeName(index: number): string;
    getDeclaredTypeName?(index: number): string;
    getColumnMetadata?(index: number): ReaderColumnMetadata;
    getTypeLength?(index: number): number;
    getTypeModifier?(index: number): number;
    getSchemaTable?: () => ReaderSchemaTable;
    columnDescriptions?: ReaderColumnDescription[];
};
const TYPE_MOD_OFFSET = 16;
const NETEZZA_PROVIDER_CHARACTER_TYPES = new Map<number, 'NCHAR' | 'NVARCHAR'>([
    [2522, 'NCHAR'],
    [2530, 'NVARCHAR']
]);
const NUMERIC_SCALE_TYPE_ALIASES = new Set([
    'INT',
    'INT2',
    'INT4',
    'INT8',
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'NUMERIC',
    'DECIMAL',
    'DEC',
    'NUMBER',
    'FIXED',
    'FLOAT',
    'FLOAT4',
    'FLOAT8',
    'REAL',
    'DOUBLE',
    'DOUBLE PRECISION',
    'BINARY_FLOAT',
    'BINARY_DOUBLE',
    'DECFLOAT',
    'SERIAL',
    'SERIAL2',
    'SERIAL4',
    'SERIAL8',
]);

function normalizeTypeName(type?: string): string | undefined {
    if (!type) {
        return undefined;
    }

    const normalizedType = String(type).trim().replace(/\s+/g, ' ').toUpperCase();
    if (!normalizedType) {
        return undefined;
    }

    if (normalizedType.startsWith('NATIONAL CHARACTER VARYING')) {
        return normalizedType.replace(/^NATIONAL CHARACTER VARYING/, 'NVARCHAR');
    }

    if (normalizedType.startsWith('NATIONAL CHARACTER')) {
        return normalizedType.replace(/^NATIONAL CHARACTER/, 'NCHAR');
    }

    return normalizedType;
}

function getSchemaRows(schemaTable: ReaderSchemaTable): ReaderSchemaRow[] {
    if (Array.isArray(schemaTable)) {
        return schemaTable;
    }

    if (schemaTable && Array.isArray(schemaTable.Rows)) {
        return schemaTable.Rows;
    }

    return [];
}

function getColumnDescription(reader: ResultMetadataReader, index: number): ReaderColumnDescription | undefined {
    return Array.isArray(reader.columnDescriptions) ? reader.columnDescriptions[index] : undefined;
}

function getColumnMetadata(reader: ResultMetadataReader, index: number): Record<string, unknown> | undefined {
    if (typeof reader.getColumnMetadata !== 'function') {
        return undefined;
    }

    const metadata = reader.getColumnMetadata(index);
    return metadata && typeof metadata === 'object' ? metadata : undefined;
}

function getMetadataNumberValue(metadata: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
    for (const key of keys) {
        const value = metadata?.[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
    }

    return undefined;
}

function getMetadataStringValue(metadata: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = metadata?.[key];
        if (typeof value === 'string' && value.trim()) {
            return value;
        }
    }

    return undefined;
}

function getColumnLengthFromTypeMod(typeMod?: number): number | undefined {
    if (typeof typeMod !== 'number' || !Number.isFinite(typeMod) || typeMod <= TYPE_MOD_OFFSET) {
        return undefined;
    }

    return typeMod - TYPE_MOD_OFFSET;
}

function getDeclaredLengthFromTypeName(type?: string): number | undefined {
    const normalizedType = normalizeTypeName(type);
    if (!normalizedType) {
        return undefined;
    }

    const lengthMatch = normalizedType.match(/\(\s*(\d+)\s*(?:,\s*\d+\s*)?\)/);
    if (!lengthMatch) {
        return undefined;
    }

    const length = Number(lengthMatch[1]);
    return Number.isFinite(length) && length > 0 ? length : undefined;
}

function formatCharacterType(baseType: 'CHAR' | 'VARCHAR' | 'NCHAR' | 'NVARCHAR', length?: number): string {
    return typeof length === 'number' && Number.isFinite(length) && length > 0
        ? `${baseType}(${length})`
        : baseType;
}

function extractBaseTypeName(type?: string): string | undefined {
    const normalizedType = normalizeTypeName(type);
    if (!normalizedType) {
        return undefined;
    }

    const parenIndex = normalizedType.indexOf('(');
    return (parenIndex >= 0 ? normalizedType.slice(0, parenIndex) : normalizedType).trim();
}

function getDriverTypeName(reader: ResultMetadataReader, index: number): string | undefined {
    const metadata = getColumnMetadata(reader, index);
    const metadataType = getMetadataStringValue(metadata, 'typeName', 'TypeName');
    if (metadataType) {
        return metadataType;
    }

    const typeName = reader.getTypeName(index);
    return typeof typeName === 'string' && typeName.trim() ? typeName : undefined;
}

function getDriverDeclaredTypeName(reader: ResultMetadataReader, index: number): string | undefined {
    const metadata = getColumnMetadata(reader, index);
    const metadataType = getMetadataStringValue(metadata, 'declaredTypeName', 'DeclaredTypeName');
    if (metadataType) {
        return metadataType;
    }

    if (typeof reader.getDeclaredTypeName !== 'function') {
        return undefined;
    }

    const declaredType = reader.getDeclaredTypeName(index);
    return typeof declaredType === 'string' && declaredType.trim() ? declaredType : undefined;
}

function getReaderTypeModifier(reader: ResultMetadataReader, index: number): number | undefined {
    const metadata = getColumnMetadata(reader, index);
    const metadataTypeModifier = getMetadataNumberValue(metadata, 'typeModifier', 'TypeModifier', 'typeMod', 'TypeMod');
    if (typeof metadataTypeModifier === 'number') {
        return metadataTypeModifier;
    }

    if (typeof reader.getTypeModifier === 'function') {
        const typeModifier = reader.getTypeModifier(index);
        if (typeof typeModifier === 'number' && Number.isFinite(typeModifier)) {
            return typeModifier;
        }
    }

    const typeMod = getColumnDescription(reader, index)?.typeMod;
    return typeof typeMod === 'number' && Number.isFinite(typeMod) ? typeMod : undefined;
}

function getDriverCharacterType(reader: ResultMetadataReader, index: number): string | undefined {
    const driverType = getDriverTypeName(reader, index);
    const baseType = extractBaseTypeName(driverType);

    if (baseType !== 'CHAR' && baseType !== 'VARCHAR' && baseType !== 'NCHAR' && baseType !== 'NVARCHAR') {
        return undefined;
    }

    const explicitLength = getDeclaredLengthFromTypeName(getDriverDeclaredTypeName(reader, index) || driverType);
    const columnSize = explicitLength ?? getResultReaderColumnSize(reader, index);
    return formatCharacterType(baseType, columnSize);
}

function getSchemaProviderCharacterType(reader: ResultMetadataReader, index: number): string | undefined {
    const providerType = getResultReaderSchemaRow(reader, index)?.ProviderType;
    if (typeof providerType !== 'number' || !Number.isFinite(providerType)) {
        return undefined;
    }

    const baseType = NETEZZA_PROVIDER_CHARACTER_TYPES.get(providerType);
    if (!baseType) {
        return undefined;
    }

    return formatCharacterType(baseType, getResultReaderColumnSize(reader, index));
}

export function normalizeResultColumnType(type?: string): string | undefined {
    return normalizeTypeName(type);
}

export function getResultReaderSchemaRow(reader: ResultMetadataReader, index: number): ReaderSchemaRow | undefined {
    if (typeof reader.getSchemaTable !== 'function') {
        return undefined;
    }

    return getSchemaRows(reader.getSchemaTable())[index];
}

export function getResultReaderColumnSize(reader: ResultMetadataReader, index: number): number | undefined {
    const metadata = getColumnMetadata(reader, index);
    const metadataColumnSize = getMetadataNumberValue(metadata, 'declaredLength', 'DeclaredLength', 'typeLength', 'TypeLength', 'columnSize', 'ColumnSize');
    if (typeof metadataColumnSize === 'number' && metadataColumnSize > 0) {
        return metadataColumnSize;
    }

    if (typeof reader.getTypeLength === 'function') {
        const typeLength = reader.getTypeLength(index);
        if (typeof typeLength === 'number' && Number.isFinite(typeLength) && typeLength > 0) {
            return typeLength;
        }
    }

    const schemaColumnSize = getResultReaderSchemaRow(reader, index)?.ColumnSize;
    if (typeof schemaColumnSize === 'number' && Number.isFinite(schemaColumnSize) && schemaColumnSize > 0) {
        return schemaColumnSize;
    }

    const typeModLength = getColumnLengthFromTypeMod(getReaderTypeModifier(reader, index));
    if (typeof typeModLength === 'number' && typeModLength > 0) {
        return typeModLength;
    }

    return getDeclaredLengthFromTypeName(getDriverDeclaredTypeName(reader, index) || getDriverTypeName(reader, index));
}

export function getResultReaderNumericScale(reader: ResultMetadataReader, index: number): number | undefined {
    const metadata = getColumnMetadata(reader, index);
    const metadataScale = getMetadataNumberValue(metadata, 'numericScale', 'NumericScale');
    const scale = typeof metadataScale === 'number' ? metadataScale : getResultReaderSchemaRow(reader, index)?.NumericScale;
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0) {
        return undefined;
    }

    const effectiveType = getEffectiveResultColumnType(reader, index);
    const baseType = extractBaseTypeName(effectiveType);
    return baseType && NUMERIC_SCALE_TYPE_ALIASES.has(baseType) ? scale : undefined;
}

export function getEffectiveResultColumnType(reader: ResultMetadataReader, index: number): string | undefined {
    const declaredType = getDriverDeclaredTypeName(reader, index);
    if (declaredType) {
        return normalizeTypeName(declaredType);
    }

    const providerCharacterType = getSchemaProviderCharacterType(reader, index);
    if (providerCharacterType) {
        return providerCharacterType;
    }

    const driverCharacterType = getDriverCharacterType(reader, index);
    if (driverCharacterType) {
        return driverCharacterType;
    }

    return normalizeTypeName(getDriverTypeName(reader, index));
}
