import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { inflateSync } from 'node:zlib';
import MDBReader, { type Column, type Table as MdbTable, type Value as MdbValue } from 'mdb-reader';
import type {
    AccessAtomicWriteResult,
    AccessAtomicWriter,
    AccessAttachment,
    AccessColumnDefinition,
    AccessComplexItem,
    AccessComplexKind,
    AccessComplexValue,
    AccessFileCreationOptions,
    AccessFileCreationFormat,
    AccessFileFormat,
    AccessFileSessionOptions,
    AccessIndexDefinition,
    AccessLinkedTableDefinition,
    AccessQueryDefinition,
    AccessQueryType,
    AccessReadOptions,
    AccessRelationshipDefinition,
    AccessScalarValue,
    AccessSingleValue,
    AccessTableDefinition,
    AccessTableSnapshot,
    AccessValue,
    AccessVersion,
} from './types';
import { ACCESS_COMPLEX_KIND } from './types';

const ACCESS_HEADER_SIZE = 21;
const ACCESS_VERSION_OFFSET = 20;

interface QueryRow {
    readonly attribute: number;
    readonly flag: number;
    readonly extra: number;
    readonly name1?: string;
    readonly name2?: string;
    readonly expression?: string;
}

interface RuntimeComplexMetadata {
    readonly typeId: number;
    readonly tableDefinitionPage: number;
}

type RuntimeMdbColumn = Column & { readonly complex?: RuntimeComplexMetadata };

const ATTACHMENT_COLUMN_NAMES = new Set([
    'FileName',
    'FileType',
    'FileData',
    'FileURL',
    'FileTimeStamp',
    'FileFlags',
]);

export class AccessFileError extends Error {
    public constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'AccessFileError';
    }
}

export class AccessFileReadOnlyError extends AccessFileError {
    public constructor(filePath: string) {
        super(`Microsoft Access file is read-only: ${filePath}`);
        this.name = 'AccessFileReadOnlyError';
    }
}

export function detectAccessFileFormat(buffer: Uint8Array, filePath = 'database'): AccessFileFormat {
    if (buffer.byteLength < ACCESS_HEADER_SIZE) {
        throw new AccessFileError(`File is too small to be an Access database: ${filePath}`);
    }

    const engineName = Buffer.from(buffer.subarray(4, 20)).toString('ascii').replace(/\0+$/, '').trim();
    if (!engineName.startsWith('Standard Jet DB') && !engineName.startsWith('Standard ACE DB')) {
        throw new AccessFileError(`File is not a supported MDB/ACCDB database: ${filePath}`);
    }

    const version = buffer[ACCESS_VERSION_OFFSET];
    if (engineName.startsWith('Standard Jet DB')) {
        return version === 0x00 ? 'jet3' : version === 0x01 ? 'jet4' : 'unknown';
    }

    switch (version) {
        case 0x02:
            return 'accdb2007';
        case 0x03:
            return 'accdb2010';
        case 0x04:
            return 'accdb2013';
        case 0x05:
            return 'accdb2016';
        case 0x06:
            return 'accdb2019';
        default:
            return 'unknown';
    }
}

function normalizeAccessValue(value: unknown): AccessScalarValue {
    if (value === null || typeof value === 'boolean' || typeof value === 'number'
        || typeof value === 'bigint' || typeof value === 'string' || value instanceof Date) {
        return value;
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return value;
    }
    throw new AccessFileError(`Unsupported value returned by MDB reader: ${typeof value}`);
}

interface AccessTableLayout {
    readonly columnCountOffset: number;
    readonly realIndexCountOffset: number;
    readonly realIndexStartOffset: number;
    readonly realIndexEntrySize: number;
    readonly columnEntrySize: number;
    readonly columnNameLengthSize: number;
    readonly physicalIndexEntrySize: number;
    readonly logicalIndexEntrySize: number;
    readonly logicalIndexBackingOffset: number;
    readonly logicalIndexTypeOffset: number;
    readonly utf16: boolean;
}

function tableLayout(format: AccessFileFormat): AccessTableLayout {
    if (format === 'jet3') {
        return {
            columnCountOffset: 25,
            realIndexCountOffset: 31,
            realIndexStartOffset: 43,
            realIndexEntrySize: 8,
            columnEntrySize: 18,
            columnNameLengthSize: 1,
            physicalIndexEntrySize: 39,
            logicalIndexEntrySize: 20,
            logicalIndexBackingOffset: 4,
            logicalIndexTypeOffset: 19,
            utf16: false,
        };
    }
    return {
        columnCountOffset: 45,
        realIndexCountOffset: 51,
        realIndexStartOffset: 63,
        realIndexEntrySize: 12,
        columnEntrySize: 25,
        columnNameLengthSize: 2,
        physicalIndexEntrySize: 52,
        logicalIndexEntrySize: 28,
        logicalIndexBackingOffset: 8,
        logicalIndexTypeOffset: 23,
        utf16: true,
    };
}

function readTableDefinition(buffer: Buffer, format: AccessFileFormat, definitionPage: number): Buffer {
    const pageSize = format === 'jet3' ? 2048 : 4096;
    const firstOffset = definitionPage * pageSize;
    if (firstOffset < 0 || firstOffset + pageSize > buffer.length) {
        throw new AccessFileError(`Access table definition page ${definitionPage} is outside the file.`);
    }
    const chunks = [buffer.subarray(firstOffset, firstOffset + pageSize)];
    let nextPage = chunks[0]?.readUInt32LE(4) ?? 0;
    while (nextPage !== 0) {
        const offset = nextPage * pageSize;
        if (offset < 0 || offset + pageSize > buffer.length) {
            throw new AccessFileError(`Access table definition page ${nextPage} is outside the file.`);
        }
        chunks.push(buffer.subarray(offset + 8, offset + pageSize));
        nextPage = buffer.readUInt32LE(offset + 4);
    }
    return Buffer.concat(chunks);
}

function primaryKeyColumnNames(
    buffer: Buffer,
    format: AccessFileFormat,
    definitionPage: number,
    columnNames: readonly string[],
): Set<string> {
    try {
        const layout = tableLayout(format);
        const definition = readTableDefinition(buffer, format, definitionPage);
        const columnCount = definition.readUInt16LE(layout.columnCountOffset);
        const realIndexCount = definition.readUInt32LE(layout.realIndexCountOffset);
        const logicalIndexCount = definition.readUInt32LE(format === 'jet3' ? 27 : 47);
        const columnsOffset = layout.realIndexStartOffset + realIndexCount * layout.realIndexEntrySize;
        const namesOffset = columnsOffset + columnCount * layout.columnEntrySize;
        let cursor = namesOffset;
        const parsedNames: string[] = [];
        for (let index = 0; index < columnCount; index++) {
            if (cursor + layout.columnNameLengthSize > definition.length) return new Set();
            const byteLength = definition.readUIntLE(cursor, layout.columnNameLengthSize);
            cursor += layout.columnNameLengthSize;
            if (cursor + byteLength > definition.length) return new Set();
            parsedNames.push(definition.toString(
                layout.utf16 ? 'utf16le' : 'latin1',
                cursor,
                cursor + byteLength,
            ).replace(/\0+$/, ''));
            cursor += byteLength;
        }

        const physicalKeys: number[][] = [];
        for (let index = 0; index < realIndexCount; index++) {
            const physicalOffset = cursor + index * layout.physicalIndexEntrySize;
            const keyOffset = physicalOffset + (format === 'jet3' ? 0 : 4);
            const keys: number[] = [];
            for (let keyIndex = 0; keyIndex < 10; keyIndex++) {
                const columnNumber = definition.readUInt16LE(keyOffset + keyIndex * 3);
                if (columnNumber === 0xffff) break;
                keys.push(columnNumber);
            }
            physicalKeys.push(keys);
        }

        const logicalOffset = cursor + realIndexCount * layout.physicalIndexEntrySize;
        const primaryKeys = new Set<string>();
        for (let index = 0; index < logicalIndexCount; index++) {
            const offset = logicalOffset + index * layout.logicalIndexEntrySize;
            if (offset + layout.logicalIndexTypeOffset >= definition.length) break;
            if (definition[offset + layout.logicalIndexTypeOffset] !== 0x01) continue;
            const physicalIndex = definition.readUInt32LE(offset + layout.logicalIndexBackingOffset);
            for (const columnNumber of physicalKeys[physicalIndex] ?? []) {
                const name = parsedNames[columnNumber] ?? columnNames[columnNumber];
                if (name) primaryKeys.add(name.toLowerCase());
            }
        }
        return primaryKeys;
    } catch {
        // Metadata must not make an otherwise readable Access table unusable.
        return new Set();
    }
}

function normalizeColumn(column: Column, primaryKeys: ReadonlySet<string>): AccessColumnDefinition {
    const complex = column.type === 'complex' ? (column as RuntimeMdbColumn).complex : undefined;
    return {
        name: column.name,
        accessType: column.type,
        nullable: column.nullable,
        fixedLength: column.fixedLength,
        size: column.size,
        ...(column.precision === undefined ? {} : { precision: column.precision }),
        ...(column.scale === undefined ? {} : { scale: column.scale }),
        autoLong: column.autoLong,
        autoUuid: column.autoUUID,
        isPrimaryKey: primaryKeys.has(column.name.toLowerCase()),
        ...(complex === undefined ? {} : {
            complexTypeId: complex.typeId,
            complexTableDefinitionPage: complex.tableDefinitionPage,
        }),
    };
}

function tableDefinitionColumns(table: MdbTable): AccessColumnDefinition[] {
    return table.getColumns().map(column => normalizeColumn(column, new Set()));
}

function numericValue(value: unknown): number | undefined {
    const number = typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : Number(value);
    return Number.isInteger(number) && Number.isFinite(number) ? number : undefined;
}

function maskedTableId(value: unknown): number | undefined {
    const number = numericValue(value);
    return number === undefined || number <= 0 ? undefined : number & 0x00ffffff;
}

function rowValue(row: Record<string, MdbValue>, name: string): MdbValue | null {
    const key = Object.keys(row).find(candidate => candidate.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
    return key === undefined ? null : row[key] ?? null;
}

function nullableString(value: MdbValue | null): string | null {
    return typeof value === 'string' ? value : null;
}

function nullableDate(value: MdbValue | null): Date | null {
    return value instanceof Date ? value : null;
}

function bytesValue(value: MdbValue | null): Uint8Array | null {
    return value instanceof Uint8Array ? Uint8Array.from(value) : null;
}

function decodeAttachmentData(value: MdbValue | null): Uint8Array | null {
    const encoded = bytesValue(value);
    if (encoded === null) return null;
    const buffer = Buffer.from(encoded);
    if (buffer.length < 8) {
        throw new AccessFileError('Access attachment data has an invalid wrapper.');
    }
    const typeFlag = buffer.readInt32LE(0);
    const dataLength = buffer.readInt32LE(4);
    let content = buffer.subarray(8);
    if (typeFlag === 1) {
        content = inflateSync(content);
    } else if (typeFlag !== 0) {
        throw new AccessFileError(`Access attachment data has an unknown compression flag ${typeFlag}.`);
    }
    if (content.length < 4) {
        throw new AccessFileError('Access attachment data is missing its content header.');
    }
    const headerLength = content.readInt32LE(0);
    const payloadEnd = Math.min(dataLength, content.length);
    if (headerLength < 4 || headerLength >= payloadEnd) {
        throw new AccessFileError('Access attachment data has an invalid content header.');
    }
    return Uint8Array.from(content.subarray(headerLength, payloadEnd));
}

interface ResolvedComplexTable {
    readonly complexTypeObjectId: number;
    readonly tableName: string;
}

interface ComplexFlatTableCache {
    readonly columns: readonly Column[];
    readonly rows: readonly Record<string, MdbValue>[];
    readonly foreignKeyName?: string;
    readonly kind: AccessComplexKind;
}

interface ComplexValueCache {
    metadata?: readonly Record<string, MdbValue>[];
    objects?: readonly Record<string, MdbValue>[];
    readonly resolutions: Map<string, ResolvedComplexTable | undefined>;
    readonly flatTables: Map<string, ComplexFlatTableCache>;
}

function createComplexValueCache(): ComplexValueCache {
    return {
        resolutions: new Map(),
        flatTables: new Map(),
    };
}

function tagComplexValue(items: readonly AccessComplexItem[], kind: AccessComplexKind): AccessComplexValue {
    const value = [...items] as AccessComplexValue;
    Object.defineProperty(value, ACCESS_COMPLEX_KIND, {
        configurable: false,
        enumerable: false,
        value: kind,
        writable: false,
    });
    return value;
}

function resolveComplexTable(
    reader: MDBReader,
    conceptualTablePage: number,
    column: AccessColumnDefinition,
    cache: ComplexValueCache,
): ResolvedComplexTable | undefined {
    if (column.complexTypeId === undefined) return undefined;
    const cacheKey = `${conceptualTablePage}\u0000${column.name.toLowerCase()}`;
    if (cache.resolutions.has(cacheKey)) return cache.resolutions.get(cacheKey);
    cache.metadata ??= reader.getTable('MSysComplexColumns').getData() as readonly Record<string, MdbValue>[];
    cache.objects ??= reader.getTable('MSysObjects').getData({ columns: ['Id', 'Name'] }) as readonly Record<string, MdbValue>[];
    const conceptualId = conceptualTablePage & 0x00ffffff;
    for (const row of cache.metadata) {
        if (maskedTableId(row.ConceptualTableID) !== conceptualId) continue;
        const typeId = numericValue(row.ComplexTypeObjectID);
        const alternateId = numericValue(row.ComplexID);
        const nameMatches = typeof row.ColumnName === 'string'
            && row.ColumnName.localeCompare(column.name, undefined, { sensitivity: 'accent' }) === 0;
        if (typeId !== column.complexTypeId && alternateId !== column.complexTypeId && !nameMatches) continue;
        const flatId = maskedTableId(row.FlatTableID);
        const flatObject = cache.objects.find(candidate => maskedTableId(candidate.Id) === flatId);
        const tableName = typeof flatObject?.Name === 'string' ? flatObject.Name : undefined;
        if (flatId !== undefined && tableName !== undefined) {
            const resolved = { complexTypeObjectId: typeId ?? alternateId ?? column.complexTypeId, tableName };
            cache.resolutions.set(cacheKey, resolved);
            return resolved;
        }
    }
    cache.resolutions.set(cacheKey, undefined);
    return undefined;
}

function enrichComplexColumnMetadata(
    reader: MDBReader,
    definition: AccessTableDefinition,
    conceptualTablePage: number,
): AccessTableDefinition {
    if (!definition.columns.some(column => column.accessType === 'complex')) return definition;
    let metadata: readonly Record<string, MdbValue>[];
    try {
        metadata = reader.getTable('MSysComplexColumns').getData() as readonly Record<string, MdbValue>[];
    } catch {
        return definition;
    }
    const conceptualId = conceptualTablePage & 0x00ffffff;
    return {
        ...definition,
        columns: definition.columns.map(column => {
            if (column.accessType !== 'complex') return column;
            const row = metadata.find(candidate => maskedTableId(candidate.ConceptualTableID) === conceptualId
                && typeof candidate.ColumnName === 'string'
                && candidate.ColumnName.localeCompare(column.name, undefined, { sensitivity: 'accent' }) === 0);
            const typeId = numericValue(row?.ComplexTypeObjectID) ?? numericValue(row?.ComplexID);
            return {
                ...column,
                ...(typeId === undefined ? {} : { complexTypeId: typeId }),
                complexTableDefinitionPage: conceptualTablePage,
            };
        }),
    };
}

function foreignKeyColumnName(table: MdbTable, conceptualColumnName: string): string | undefined {
    const columns = table.getColumns();
    const explicit = columns.find(column => column.name.localeCompare(`_${conceptualColumnName}`, undefined, { sensitivity: 'accent' }) === 0);
    if (explicit) return explicit.name;
    return columns.find(column => column.type === 'long' && !column.autoLong && !ATTACHMENT_COLUMN_NAMES.has(column.name))?.name
        ?? columns.find(column => column.type === 'integer' && !column.autoLong)?.name;
}

function complexItemValue(row: Record<string, MdbValue>, name: string): AccessScalarValue {
    return normalizeAccessValue(rowValue(row, name) ?? null);
}

function resolveComplexValue(
    reader: MDBReader,
    conceptualTablePage: number,
    column: AccessColumnDefinition,
    rawValue: AccessScalarValue,
    cache: ComplexValueCache,
): AccessValue {
    if (rawValue === null) return null;
    const resolved = resolveComplexTable(reader, conceptualTablePage, column, cache);
    if (!resolved) {
        const complexKey = numericValue(rawValue);
        return complexKey === undefined || complexKey <= 0 ? [] : rawValue;
    }

    const flatCacheKey = resolved.tableName.toLowerCase();
    let flat = cache.flatTables.get(flatCacheKey);
    if (!flat) {
        const flatTable = reader.getTable(resolved.tableName);
        const columns = flatTable.getColumns();
        const foreignKeyName = foreignKeyColumnName(flatTable, column.name);
        const flatRows = flatTable.getData() as readonly Record<string, MdbValue>[];
        const attachment = resolved.complexTypeObjectId === 39
            || columns.some(candidate => candidate.name.localeCompare('FileData', undefined, { sensitivity: 'accent' }) === 0);
        const version = columns.some(candidate => candidate.name.localeCompare('Modified', undefined, { sensitivity: 'accent' }) === 0)
            || columns.some(candidate => candidate.name.localeCompare('Version', undefined, { sensitivity: 'accent' }) === 0);
        flat = {
            columns,
            rows: flatRows,
            ...(foreignKeyName === undefined ? {} : { foreignKeyName }),
            kind: attachment ? 'attachment' : version ? 'version' : 'single',
        };
        cache.flatTables.set(flatCacheKey, flat);
    }

    const complexKey = numericValue(rawValue);
    if (complexKey === undefined || complexKey <= 0 || !flat.foreignKeyName) {
        return tagComplexValue([], flat.kind);
    }
    const children = flat.rows.filter(row => numericValue(rowValue(row, flat.foreignKeyName!)) === complexKey);
    if (flat.kind === 'attachment') {
        return tagComplexValue(children.map(row => ({
            data: decodeAttachmentData(rowValue(row, 'FileData')),
            flags: numericValue(rowValue(row, 'FileFlags')) ?? null,
            name: nullableString(rowValue(row, 'FileName')),
            timestamp: nullableDate(rowValue(row, 'FileTimeStamp')),
            type: nullableString(rowValue(row, 'FileType')),
            url: nullableString(rowValue(row, 'FileURL')),
        } satisfies AccessAttachment)), 'attachment');
    }
    if (flat.kind === 'version') {
        return tagComplexValue(children.map(row => ({
            modified: nullableDate(rowValue(row, 'Modified')),
            value: complexItemValue(row, 'Value'),
        } satisfies AccessVersion)), 'version');
    }
    return tagComplexValue(children.map(row => ({ value: complexItemValue(row, 'Value') } satisfies AccessSingleValue)), 'single');
}

interface ParsedIndexes {
    readonly physicalKeys: readonly (readonly number[])[];
    readonly physicalFlags: readonly number[];
    readonly logicalTypes: readonly number[];
    readonly logicalBacking: readonly number[];
    readonly names: readonly string[];
}

function parseTableIndexes(
    buffer: Buffer,
    format: AccessFileFormat,
    definitionPage: number,
): ParsedIndexes {
    const layout = tableLayout(format);
    const definition = readTableDefinition(buffer, format, definitionPage);
    const columnCount = definition.readUInt16LE(layout.columnCountOffset);
    const realIndexCount = definition.readUInt32LE(layout.realIndexCountOffset);
    const logicalIndexCount = definition.readUInt32LE(format === 'jet3' ? 27 : 47);
    const columnsOffset = layout.realIndexStartOffset + realIndexCount * layout.realIndexEntrySize;
    const namesOffset = columnsOffset + columnCount * layout.columnEntrySize;
    let cursor = namesOffset;
    const parsedNames: string[] = [];
    for (let index = 0; index < columnCount; index++) {
        if (cursor + layout.columnNameLengthSize > definition.length) break;
        const byteLength = definition.readUIntLE(cursor, layout.columnNameLengthSize);
        cursor += layout.columnNameLengthSize;
        if (cursor + byteLength > definition.length) break;
        parsedNames.push(definition.toString(
            layout.utf16 ? 'utf16le' : 'latin1',
            cursor,
            cursor + byteLength,
        ).replace(/\0+$/, ''));
        cursor += byteLength;
    }

    const physicalKeys: number[][] = [];
    const physicalFlags: number[] = [];
    for (let index = 0; index < realIndexCount; index++) {
        const physicalOffset = cursor + index * layout.physicalIndexEntrySize;
        const keyOffset = physicalOffset + (format === 'jet3' ? 0 : 4);
        const keys: number[] = [];
        for (let keyIndex = 0; keyIndex < 10; keyIndex++) {
            const columnNumber = definition.readUInt16LE(keyOffset + keyIndex * 3);
            if (columnNumber === 0xffff) break;
            keys.push(columnNumber);
        }
        physicalKeys.push(keys);
        // unique (0x01) / ignore-nulls (0x02) / required (0x08) flags
        const flagOffset = physicalOffset + (format === 'jet3' ? 33 : 46);
        physicalFlags.push(flagOffset < definition.length ? definition[flagOffset] : 0);
    }

    const logicalOffset = cursor + realIndexCount * layout.physicalIndexEntrySize;
    const logicalTypes: number[] = [];
    const logicalBacking: number[] = [];
    for (let index = 0; index < logicalIndexCount; index++) {
        const offset = logicalOffset + index * layout.logicalIndexEntrySize;
        if (offset + layout.logicalIndexTypeOffset >= definition.length) break;
        logicalTypes.push(definition[offset + layout.logicalIndexTypeOffset]);
        logicalBacking.push(definition.readUInt32LE(offset + layout.logicalIndexBackingOffset));
    }

    const names: string[] = [];
    let nameCursor = logicalOffset + logicalIndexCount * layout.logicalIndexEntrySize;
    for (let index = 0; index < logicalIndexCount; index++) {
        if (nameCursor + layout.columnNameLengthSize > definition.length) break;
        const byteLength = definition.readUIntLE(nameCursor, layout.columnNameLengthSize);
        nameCursor += layout.columnNameLengthSize;
        if (nameCursor + byteLength > definition.length) break;
        names.push(definition.toString(
            layout.utf16 ? 'utf16le' : 'latin1',
            nameCursor,
            nameCursor + byteLength,
        ).replace(/\0+$/, ''));
        nameCursor += byteLength;
    }

    return { physicalKeys, physicalFlags, logicalTypes, logicalBacking, names };
}

function tableIndexes(
    buffer: Buffer,
    format: AccessFileFormat,
    definitionPage: number,
    columns: readonly AccessColumnDefinition[],
): AccessIndexDefinition[] {
    try {
        const columnNames = columns.map(column => column.name);
        const parsed = parseTableIndexes(buffer, format, definitionPage);
        return parsed.logicalTypes.map((type, index) => {
            const physicalIndex = parsed.logicalBacking[index] ?? 0;
            const keys = parsed.physicalKeys[physicalIndex] ?? [];
            const flags = parsed.physicalFlags[physicalIndex] ?? 0;
            return {
                name: parsed.names[index] ?? `Index${index}`,
                columns: keys
                    .map(columnNumber => columnNames[columnNumber] ?? `Column${columnNumber}`)
                    .filter(Boolean),
                primaryKey: type === 0x01,
                unique: (flags & 0x01) !== 0,
                ignoreNulls: (flags & 0x02) !== 0,
                required: (flags & 0x08) !== 0,
            };
        });
    } catch {
        return [];
    }
}

/**
 * Reads the "Description" property from the table-definition property block
 * (Jet property map).  Returns undefined when the file has no property block
 * or the property is absent.
 */
/**
 * Decodes the table-level Description from MSysObjects.LvProp.
 *
 * The property map is not stored on the table-definition page.  A property
 * name list (block 0x80) is followed by a table property-value block (0x00);
 * each value carries a DDL flag, type, property-name index and byte length.
 * Column property blocks (0x01) use the same value envelope but have an
 * additional map-name prefix, so they must not be parsed as table properties.
 */
export function parseAccessPropertyMapDescription(
    propertyBytes: Uint8Array | undefined,
    format: AccessFileFormat,
): string | undefined {
    try {
        if (!propertyBytes || propertyBytes.length < 10) return undefined;
        const bytes = Buffer.from(propertyBytes);
        const header = bytes.subarray(0, 4).toString('ascii');
        if (header !== 'MR2\0' && header !== 'KKD\0') return undefined;

        const utf16 = format !== 'jet3';
        const encoding = utf16 ? 'utf16le' : 'latin1';
        let propertyNames: string[] | undefined;
        let cursor = 4;
        while (cursor + 6 <= bytes.length) {
            const blockLength = bytes.readUInt32LE(cursor);
            const blockType = bytes.readUInt16LE(cursor + 4);
            if (blockLength < 6 || cursor + blockLength > bytes.length) return undefined;
            const blockStart = cursor + 6;
            const blockEnd = cursor + blockLength;

            if (blockType === 0x80) {
                propertyNames = [];
                let nameCursor = blockStart;
                while (nameCursor + 2 <= blockEnd) {
                    const nameLength = bytes.readUInt16LE(nameCursor);
                    nameCursor += 2;
                    if (nameCursor + nameLength > blockEnd) return undefined;
                    propertyNames.push(bytes.toString(encoding, nameCursor, nameCursor + nameLength));
                    nameCursor += nameLength;
                }
            } else if (blockType === 0x00 && propertyNames) {
                // Table-level maps have an empty map name.  The four-byte
                // prefix includes the two-byte name length and its six-byte
                // minimum envelope, matching Jackcess/PropertyMapCodec.
                if (blockStart + 4 > blockEnd) return undefined;
                const mapLength = bytes.readUInt32LE(blockStart);
                if (mapLength < 6 || blockStart + mapLength > blockEnd) return undefined;
                let valueCursor = blockStart + mapLength;
                while (valueCursor + 2 <= blockEnd) {
                    const valueStart = valueCursor;
                    const valueLength = bytes.readUInt16LE(valueCursor);
                    const valueEnd = valueStart + valueLength;
                    valueCursor += 2;
                    if (valueLength < 8 || valueEnd > blockEnd || valueCursor + 6 > valueEnd) return undefined;
                    valueCursor += 1; // DDL flag
                    const valueType = bytes[valueCursor++] ?? 0;
                    const propertyIndex = bytes.readUInt16LE(valueCursor);
                    valueCursor += 2;
                    const dataLength = bytes.readUInt16LE(valueCursor);
                    valueCursor += 2;
                    if (valueCursor + dataLength > valueEnd) return undefined;
                    const propertyName = propertyNames[propertyIndex];
                    if (propertyName?.toLowerCase() === 'description'
                        && (valueType === 0x0a || valueType === 0x0c)) {
                        // Inline text (0x0a) starts at valueCursor.  Long
                        // text (0x0c) carries a four-byte length prefix
                        // before the encoded characters.
                        const textStart = valueType === 0x0c ? valueCursor + 4 : valueCursor;
                        if (textStart > valueCursor + dataLength) return undefined;
                        return bytes.toString(encoding, textStart, valueCursor + dataLength).replace(/\0+$/, '');
                    }
                    valueCursor = valueEnd;
                }
            }
            cursor += blockLength;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function tablePropertyBytes(reader: MDBReader, tableName: string): Buffer | undefined {
    try {
        const rows = reader.getTable('MSysObjects').getData({ columns: ['Name', 'LvProp'] }) as readonly Record<string, MdbValue>[];
        const row = rows.find(candidate => String(candidate.Name ?? '').toLowerCase() === tableName.toLowerCase());
        const value = row?.LvProp;
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
    } catch {
        // Property metadata is optional; table data remains usable without it.
    }
    return undefined;
}

const DEFAULT_TEMPLATES: Record<AccessFileCreationFormat, string> = {
    mdb2000: 'empty.mdb',
    mdb2003: 'empty.mdb',
    accdb2007: 'empty2007.accdb',
    accdb2010: 'empty2010.accdb',
    accdb2016: 'empty2016.accdb',
};

function expectedCreatedFormat(format: AccessFileCreationFormat): AccessFileFormat {
    if (format === 'mdb2000' || format === 'mdb2003') return 'jet4';
    return format;
}

function defaultTemplatePath(format: AccessFileCreationFormat): string {
    return path.resolve(__dirname, '..', 'resources', DEFAULT_TEMPLATES[format]);
}

function tableDefinition(
    table: MdbTable,
    name: string,
    isSystem: boolean,
    buffer: Buffer,
    format: AccessFileFormat,
    definitionPage: number,
): AccessTableDefinition {
    const columns = table.getColumns();
    const primaryKeys = primaryKeyColumnNames(buffer, format, definitionPage, columns.map(column => column.name));
    return {
        name,
        columns: columns.map(column => normalizeColumn(column, primaryKeys)),
        rowCount: table.rowCount,
        isSystem,
    };
}

function tableIsSystem(name: string): boolean {
    return /^MSys/i.test(name);
}

function queryTypeFromFlags(flags: number, rows: readonly QueryRow[]): AccessQueryType {
    const objectType = flags & 0xf0;
    if (objectType !== 0) {
        const objectTypes: Record<number, AccessQueryType> = {
            0x10: 'crosstab',
            0x20: 'delete',
            0x30: 'update',
            0x40: 'append',
            0x50: 'make-table',
            0x60: 'data-definition',
            0x70: 'pass-through',
            0x80: 'union',
        };
        return objectTypes[objectType] ?? 'unknown';
    }
    const typeRow = rows.find(row => row.attribute === 1)?.flag;
    const rowTypes: Record<number, AccessQueryType> = {
        1: 'select',
        2: 'make-table',
        3: 'append',
        4: 'update',
        5: 'delete',
        6: 'crosstab',
        7: 'data-definition',
        8: 'pass-through',
        9: 'union',
    };
    return rowTypes[typeRow ?? 1] ?? 'unknown';
}

function queryParameterType(flag: number, extra: number): string {
    const type = {
        1: 'BOOLEAN',
        2: 'TINYINT',
        3: 'SMALLINT',
        4: 'INTEGER',
        5: 'DECIMAL',
        6: 'REAL',
        7: 'DOUBLE',
        8: 'TIMESTAMP',
        10: `VARCHAR(${Math.max(1, extra)})`,
        15: 'UUID',
        16: 'DECIMAL',
        19: 'BIGINT',
    }[flag];
    return type ?? 'VARCHAR';
}

function quoteQueryIdentifier(value: string): string {
    if (value.startsWith('[') && value.endsWith(']')) {
        return value;
    }
    return `[${value.replace(/]/g, ']]')}]`;
}

interface QueryTableSource {
    readonly keys: readonly string[];
    readonly sql: string;
}

function queryTableSource(row: QueryRow): QueryTableSource | undefined {
    const table = row.name1?.trim();
    if (!table) {
        return undefined;
    }
    const database = row.expression?.trim();
    const qualified = `${database ? `${quoteQueryIdentifier(database)}.` : ''}${table.split('.').map(quoteQueryIdentifier).join('.')}`;
    const alias = row.name2?.trim();
    return {
        keys: alias ? [table, alias] : [table],
        sql: alias ? `${qualified} AS ${quoteQueryIdentifier(alias)}` : qualified,
    };
}

function sourceContains(source: QueryTableSource, name: string): boolean {
    return source.keys.some(key => key.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
}

function queryFromSources(rows: readonly QueryRow[]): string[] | undefined {
    const sources = rows
        .filter(row => row.attribute === 5)
        .map(queryTableSource)
        .filter((source): source is QueryTableSource => Boolean(source));
    for (const join of rows.filter(row => row.attribute === 7)) {
        const leftName = join.name1?.trim();
        const rightName = join.name2?.trim();
        const joinType = {
            1: 'INNER JOIN',
            2: 'LEFT JOIN',
            3: 'RIGHT JOIN',
        }[join.flag];
        if (!leftName || !rightName || !joinType || !join.expression?.trim()) {
            return undefined;
        }
        const leftIndex = sources.findIndex(source => sourceContains(source, leftName));
        const rightIndex = sources.findIndex(source => sourceContains(source, rightName));
        if (leftIndex < 0 || rightIndex < 0 || leftIndex === rightIndex) {
            return undefined;
        }
        const left = sources[leftIndex];
        const right = sources[rightIndex];
        const leftSql = left.sql.includes(' JOIN ') ? `(${left.sql})` : left.sql;
        const rightSql = right.sql.includes(' JOIN ') ? `(${right.sql})` : right.sql;
        const joined: QueryTableSource = {
            keys: [...new Set([...left.keys, ...right.keys])],
            sql: `${leftSql} ${joinType} ${rightSql} ON ${join.expression.trim()}`,
        };
        for (const index of [leftIndex, rightIndex].sort((a, b) => b - a)) {
            sources.splice(index, 1);
        }
        sources.push(joined);
    }
    return sources.map(source => source.sql);
}

function reconstructSelectQuery(rows: readonly QueryRow[]): string | undefined {
    const flagRow = rows.find(row => row.attribute === 3);
    const selectColumns = rows
        .filter(row => row.attribute === 6 && row.expression)
        .map(row => `${row.expression}${row.name1 ? ` AS ${quoteQueryIdentifier(row.name1)}` : ''}`);
    if ((flagRow?.flag ?? 0) & 0x01) {
        selectColumns.push('*');
    }
    if (selectColumns.length === 0) {
        return undefined;
    }

    const parameters = rows.filter(row => row.attribute === 2 && row.name1);
    const parameterClause = parameters.length > 0
        ? `PARAMETERS ${parameters.map(row => `${quoteQueryIdentifier(row.name1 ?? '')} ${queryParameterType(row.flag, row.extra)}`).join(', ')};\n`
        : '';
    const distinct = (flagRow?.flag ?? 0) & 0x02
        ? 'DISTINCT '
        : (flagRow?.flag ?? 0) & 0x08 ? 'DISTINCTROW ' : '';
    const top = (flagRow?.flag ?? 0) & 0x10
        ? `TOP ${flagRow?.name1 ?? '1'}${(flagRow?.flag ?? 0) & 0x20 ? ' PERCENT' : ''} `
        : '';
    const tables = queryFromSources(rows);
    if (!tables) {
        return undefined;
    }
    const where = rows.find(row => row.attribute === 8)?.expression;
    const groupBy = rows.filter(row => row.attribute === 9).map(row => row.expression).filter((value): value is string => Boolean(value));
    const having = rows.find(row => row.attribute === 10)?.expression;
    const orderBy = rows
        .filter(row => row.attribute === 11 && row.expression)
        .map(row => `${row.expression}${row.name1?.toUpperCase() === 'D' ? ' DESC' : ''}`);

    let sql = `${parameterClause}SELECT ${distinct}${top}${selectColumns.join(', ')}`;
    if (tables.length > 0) sql += `\nFROM ${tables.join(', ')}`;
    if (where) sql += `\nWHERE ${where}`;
    if (groupBy.length > 0) sql += `\nGROUP BY ${groupBy.join(', ')}`;
    if (having) sql += `\nHAVING ${having}`;
    if (orderBy.length > 0) sql += `\nORDER BY ${orderBy.join(', ')}`;
    return sql;
}

function queryDefinitionFromRows(
    object: { readonly name: string; readonly id: number; readonly flags: number },
    rows: readonly QueryRow[],
): AccessQueryDefinition {
    const type = queryTypeFromFlags(object.flags, rows);
    return {
        name: object.name,
        objectId: object.id,
        type,
        ...(type === 'select' ? { sql: reconstructSelectQuery(rows) } : {}),
        hasParameters: rows.some(row => row.attribute === 2),
    };
}

function validateReadOptions(options: AccessReadOptions): { rowOffset: number; rowLimit: number } {
    const rowOffset = options.rowOffset ?? 0;
    const rowLimit = options.rowLimit ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(rowOffset) || rowOffset < 0) {
        throw new AccessFileError(`rowOffset must be a non-negative integer; received ${rowOffset}`);
    }
    if (!(rowLimit === Number.POSITIVE_INFINITY || (Number.isInteger(rowLimit) && rowLimit >= 0))) {
        throw new AccessFileError(`rowLimit must be a non-negative integer; received ${rowLimit}`);
    }
    return { rowOffset, rowLimit };
}

function makeStagedPath(filePath: string): string {
    const suffix = randomBytes(10).toString('hex');
    return path.join(path.dirname(filePath), `.${path.basename(filePath)}.justybase-${suffix}.tmp`);
}

function makeBackupPath(filePath: string): string {
    const suffix = randomBytes(10).toString('hex');
    return path.join(path.dirname(filePath), `.${path.basename(filePath)}.justybase-${suffix}.bak`);
}

function isReplaceRenameError(error: unknown): boolean {
    return error instanceof Error && 'code' in error
        && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String((error as { code?: unknown }).code));
}

async function replaceFileAtomically(stagedPath: string, targetPath: string): Promise<void> {
    try {
        await fs.rename(stagedPath, targetPath);
        return;
    } catch (error) {
        // POSIX replaces the destination in one rename. Windows refuses that
        // operation while the destination exists, so keep a recoverable
        // backup while performing the platform-specific fallback.
        if (!isReplaceRenameError(error)) {
            throw error;
        }
    }

    const backupPath = makeBackupPath(targetPath);
    await fs.rename(targetPath, backupPath);
    try {
        await fs.rename(stagedPath, targetPath);
    } catch (error) {
        await fs.rename(backupPath, targetPath).catch(() => undefined);
        throw error;
    }
    await fs.rm(backupPath, { force: true });
}

async function flushFile(filePath: string): Promise<void> {
    const handle = await fs.open(filePath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export class AccessFileSession {
    private _reader: MDBReader;
    private _closed = false;

    private constructor(
        private readonly _options: AccessFileSessionOptions,
        private _buffer: Buffer,
        private _format: AccessFileFormat,
        reader: MDBReader,
    ) {
        this._reader = reader;
    }

    public static async open(options: AccessFileSessionOptions): Promise<AccessFileSession> {
        const filePath = path.resolve(options.filePath);
        const buffer = await fs.readFile(filePath);
        const format = detectAccessFileFormat(buffer, filePath);
        let reader: MDBReader;
        try {
            reader = new MDBReader(buffer, { password: options.password });
        } catch (error) {
            throw new AccessFileError(
                `Cannot read Access database ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
        return new AccessFileSession({ ...options, filePath }, buffer, format, reader);
    }

    /**
     * Creates a new empty database from the version-specific template shipped
     * with the package.  Copying a known-good Access template is deliberate:
     * an empty MDB/ACCDB contains format-specific system catalogs and usage
     * maps which cannot be safely synthesized by merely writing a header.
     *
     * `templatePath` is available for test fixtures and downstream builds that
     * provide their own licensed template; the resulting header is always
     * checked against the requested format before the session is opened.
     */
    public static async create(options: AccessFileCreationOptions): Promise<AccessFileSession> {
        const filePath = path.resolve(options.filePath);
        const templatePath = path.resolve(options.templatePath ?? defaultTemplatePath(options.format));
        const expectedFormat = expectedCreatedFormat(options.format);
        let targetCreated = false;
        try {
            await fs.copyFile(templatePath, filePath, fsConstants.COPYFILE_EXCL);
            targetCreated = true;
            const buffer = await fs.readFile(filePath);
            const actualFormat = detectAccessFileFormat(buffer, filePath);
            if (actualFormat !== expectedFormat) {
                throw new AccessFileError(
                    `Template '${templatePath}' has format '${actualFormat}', expected '${expectedFormat}' for '${options.format}'.`,
                );
            }
            return await AccessFileSession.open({
                filePath,
                password: options.password,
                readOnly: false,
            });
        } catch (error) {
            if (targetCreated) {
                await fs.rm(filePath, { force: true }).catch(() => undefined);
            }
            if (error instanceof AccessFileError) throw error;
            throw new AccessFileError(
                `Cannot create Access database ${filePath} from template ${templatePath}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    }

    public get filePath(): string {
        return this._options.filePath;
    }

    public get format(): AccessFileFormat {
        return this._format;
    }

    public get readOnly(): boolean {
        return this._options.readOnly !== false;
    }

    public async close(): Promise<void> {
        this._closed = true;
        this._buffer = Buffer.alloc(0);
    }

    public listTableNames(includeSystem = false): string[] {
        this.ensureOpen();
        const names = this._reader
            .getTableNames({ normalTables: true, systemTables: includeSystem, linkedTables: false })
            .filter(name => includeSystem || !tableIsSystem(name));
        if (includeSystem) return names;
        const existing = new Set(names.map(name => name.toLowerCase()));
        for (const name of this.listComplexFlatTableNames()) {
            if (!existing.has(name.toLowerCase())) {
                names.push(name);
                existing.add(name.toLowerCase());
            }
        }
        return names;
    }

    /**
     * Access stores the physical tables behind attachment and multivalue
     * columns as hidden catalog objects.  They are ordinary Jet tables and
     * are intentionally surfaced as SQL tables so their rows can be edited.
     */
    private listComplexFlatTableNames(): string[] {
        try {
            const normalNames = new Set(this._reader.getTableNames({
                normalTables: true,
                systemTables: false,
                linkedTables: false,
            }).map(name => name.toLowerCase()));
            const complexRows = this.getMdbTable('MSysComplexColumns').getData({
                columns: ['ConceptualTableID', 'FlatTableID'],
            }) as readonly Record<string, MdbValue>[];
            const objects = this.getMdbTable('MSysObjects').getData({
                columns: ['Id', 'Name', 'Type'],
            }) as readonly Record<string, MdbValue>[];
            const conceptualIds = new Set(
                objects
                    .filter(row => Number(row.Type) === 1 && normalNames.has(String(row.Name ?? '').toLowerCase()))
                    .filter(row => {
                        try {
                            return this.getMdbTable(String(row.Name ?? '')).getColumns()
                                .some(column => column.type === 'complex');
                        } catch {
                            return false;
                        }
                    })
                    .map(row => maskedTableId(row.Id))
                    .filter((id): id is number => id !== undefined),
            );
            const flatIds = new Set(
                complexRows
                    .filter(row => conceptualIds.has(maskedTableId(row.ConceptualTableID) ?? -1))
                    .map(row => maskedTableId(row.FlatTableID))
                    .filter((id): id is number => id !== undefined),
            );
            if (flatIds.size === 0) return [];
            return objects
                .filter(row => Number(row.Type) === 1 && flatIds.has(maskedTableId(row.Id) ?? -1))
                .map(row => String(row.Name ?? ''))
                .filter(name => name.length > 0);
        } catch {
            return [];
        }
    }

    public listTables(includeSystem = false): AccessTableDefinition[] {
        return this.listTableNames(includeSystem).map(name => this.getTableDefinition(name));
    }

    public listQueryDefinitions(): AccessQueryDefinition[] {
        this.ensureOpen();
        const objects = this.getMdbTable('MSysObjects').getData({
            columns: ['Id', 'Name', 'Type', 'Flags'],
        }) as readonly Record<string, MdbValue>[];
        const queries = objects
            .filter(row => Number(row.Type) === 5)
            .map(row => ({
                name: String(row.Name ?? ''),
                id: Number(row.Id),
                flags: Number(row.Flags) || 0,
            }))
            .filter(query => query.name.length > 0 && Number.isInteger(query.id));
        if (queries.length === 0) {
            return [];
        }

        let queryRows: readonly Record<string, MdbValue>[];
        try {
            queryRows = this.getMdbTable('MSysQueries').getData({
                columns: ['ObjectId', 'Attribute', 'Name1', 'Name2', 'Expression', 'Flag', 'LvExtra'],
            }) as readonly Record<string, MdbValue>[];
        } catch {
            return queries.map(query => queryDefinitionFromRows(query, []));
        }
        const rowsByObjectId = new Map<number, QueryRow[]>();
        for (const row of queryRows) {
            const objectId = Number(row.ObjectId);
            if (!Number.isInteger(objectId)) continue;
            const rows = rowsByObjectId.get(objectId) ?? [];
            rows.push({
                attribute: Number(row.Attribute),
                flag: Number(row.Flag) || 0,
                extra: Number(row.LvExtra) || 0,
                name1: typeof row.Name1 === 'string' ? row.Name1 : undefined,
                name2: typeof row.Name2 === 'string' ? row.Name2 : undefined,
                expression: typeof row.Expression === 'string' ? row.Expression : undefined,
            });
            rowsByObjectId.set(objectId, rows);
        }
        return queries.map(query => queryDefinitionFromRows(query, rowsByObjectId.get(query.id) ?? []));
    }

    public getQueryDefinition(name: string): AccessQueryDefinition {
        const query = this.listQueryDefinitions().find(candidate => candidate.name.toLowerCase() === name.toLowerCase());
        if (!query) {
            throw new AccessFileError(`Access query definition '${name}' cannot be found.`);
        }
        return query;
    }

    public getTableDefinition(name: string): AccessTableDefinition {
        const table = this.getMdbTable(name);
        const conceptualTablePage = this.tableDefinitionPage(name);
        const definition = tableDefinition(
            table,
            name,
            tableIsSystem(name),
            this._buffer,
            this._format,
            conceptualTablePage,
        );
        const enrichedDefinition = enrichComplexColumnMetadata(this._reader, definition, conceptualTablePage);
        const description = parseAccessPropertyMapDescription(
            tablePropertyBytes(this._reader, name),
            this._format,
        );
        return description === undefined ? enrichedDefinition : { ...enrichedDefinition, description };
    }

    /**
     * Lists the indexes defined on a table (primary key, unique and plain
     * non-key indexes), parsed from the table-definition page chain.
     */
    public listIndexes(name: string): AccessIndexDefinition[] {
        this.ensureOpen();
        const table = this.getMdbTable(name);
        const columns = tableDefinitionColumns(table);
        return tableIndexes(
            this._buffer,
            this._format,
            this.tableDefinitionPage(name),
            columns,
        );
    }

    /**
     * Lists the linked (external) tables recorded in MSysObjects with their
     * connection strings.
     */
    public listLinkedTables(): AccessLinkedTableDefinition[] {
        this.ensureOpen();
        let names: string[];
        try {
            names = this._reader.getTableNames({ normalTables: false, systemTables: false, linkedTables: true });
        } catch {
            return [];
        }
        if (names.length === 0) {
            return [];
        }
        const objects = this.getMdbTable('MSysObjects').getData({
            columns: ['Name', 'Database', 'Connect', 'ForeignName'],
        }) as readonly Record<string, MdbValue>[];
        return names.map(name => {
            const row = objects.find(candidate => String(candidate.Name ?? '') === name);
            return {
                name,
                target: typeof row?.Connect === 'string' ? row.Connect : (typeof row?.Database === 'string' ? row.Database : ''),
                foreignName: typeof row?.ForeignName === 'string' ? row.ForeignName : '',
                isSystem: false,
            };
        });
    }

    /**
     * Lists the foreign-key relationships recorded in MSysRelationships.
     * Both Jet3 and ACE (.accdb) files store relationships in the same
     * szRelationship/grbit/ccolumn/icolumn row layout.
     */
    public listRelationships(): AccessRelationshipDefinition[] {
        this.ensureOpen();
        let rows: readonly Record<string, MdbValue>[];
        try {
            rows = this.getMdbTable('MSysRelationships').getData({
                columns: ['szRelationship', 'grbit', 'ccolumn', 'icolumn', 'szObject', 'szColumn', 'szReferencedObject', 'szReferencedColumn'],
            }) as readonly Record<string, MdbValue>[];
        } catch {
            return [];
        }
        const grouped = new Map<string, {
            table: string;
            columns: string[];
            foreignTable: string;
            foreignColumns: string[];
            enforced: boolean;
            updateCascade: boolean;
            deleteCascade: boolean;
        }>();
        const grbitAttributes = (grbit: number): { enforced: boolean; updateCascade: boolean; deleteCascade: boolean } => ({
            enforced: (grbit & 0x01) !== 0,
            updateCascade: (grbit & 0x08) !== 0,
            deleteCascade: (grbit & 0x10) !== 0,
        });
        for (const row of rows) {
            const relationshipName = String(row.szRelationship ?? '');
            if (!relationshipName) continue;
            const attributes = grbitAttributes(Number(row.grbit) || 0);
            const tableName = String(row.szObject ?? '');
            const columnName = String(row.szColumn ?? '');
            const foreignTable = String(row.szReferencedObject ?? '');
            const foreignColumn = String(row.szReferencedColumn ?? '');
            const existing = grouped.get(relationshipName);
            if (existing) {
                existing.columns.push(columnName);
                existing.foreignColumns.push(foreignColumn);
                continue;
            }
            grouped.set(relationshipName, {
                table: tableName,
                columns: [columnName],
                foreignTable,
                foreignColumns: [foreignColumn],
                ...attributes,
            });
        }
        return Array.from(grouped.entries()).map(([name, relationship]) => ({
            name,
            table: relationship.table,
            columns: relationship.columns,
            foreignTable: relationship.foreignTable,
            foreignColumns: relationship.foreignColumns,
            enforced: relationship.enforced,
            updateCascade: relationship.updateCascade,
            deleteCascade: relationship.deleteCascade,
        }));
    }

    public async readTable(name: string, options: AccessReadOptions = {}): Promise<AccessTableSnapshot> {
        this.ensureOpen();
        const { rowOffset, rowLimit } = validateReadOptions(options);
        const table = this.getMdbTable(name);
        const definition = this.getTableDefinition(name);
        if (definition.columns.some(column => column.accessType === 'complex')) {
            return this.readComplexTable(table, name, definition, rowOffset, rowLimit);
        }
        const columnNames = definition.columns.map(column => column.name);
        const data = table.getData({
            rowOffset,
            rowLimit,
            columns: columnNames,
        }) as readonly Record<string, MdbValue>[];
        const rows = data.map(row => columnNames.map(columnName => normalizeAccessValue(row[columnName] ?? null)));
        return { definition, rows };
    }

    private async readComplexTable(
        table: MdbTable,
        name: string,
        definition: AccessTableDefinition,
        rowOffset: number,
        rowLimit: number,
    ): Promise<AccessTableSnapshot> {
        const [{ JetPageChannel }, { jetLayoutFor }, { JetTable }] = await Promise.all([
            import('./jet/JetPageChannel'),
            import('./jet/JetLayout'),
            import('./jet/JetTable'),
        ]);
        const channel = new JetPageChannel(this._buffer, jetLayoutFor(this._format));
        const jetTable = new JetTable(channel, name, this.tableDefinitionPage(name));
        const locations = jetTable.rowLocations();
        const end = rowLimit === Number.POSITIVE_INFINITY ? undefined : rowOffset + rowLimit;
        const selectedLocations = locations.slice(rowOffset, end);
        const conceptualTablePage = this.tableDefinitionPage(name);
        const rawColumnIndexes = new Map(jetTable.columns.map((column, index) => [column.name.toLowerCase(), index]));
        const ordinaryColumns = definition.columns.filter(column => column.accessType !== 'complex');
        const ordinaryColumnNames = ordinaryColumns.map(column => column.name);
        const ordinaryRows = ordinaryColumnNames.length === 0
            ? selectedLocations.map(() => ({} as Record<string, MdbValue>))
            : table.getData({
                rowOffset,
                rowLimit,
                columns: ordinaryColumnNames,
            }) as readonly Record<string, MdbValue>[];
        const complexCache = createComplexValueCache();
        const rows = selectedLocations.map((location, rowIndex) => {
            const rawValues = jetTable.readRowValues(location);
            const ordinaryRow = ordinaryRows[rowIndex] ?? {};
            return definition.columns.map(column => {
                const rawIndex = rawColumnIndexes.get(column.name.toLowerCase());
                const scalar = column.accessType === 'complex'
                    ? normalizeAccessValue(rawIndex === undefined ? null : rawValues[rawIndex] ?? null)
                    : normalizeAccessValue(ordinaryRow[column.name] ?? null);
                return column.accessType === 'complex'
                    ? resolveComplexValue(this._reader, conceptualTablePage, column, scalar, complexCache)
                    : scalar;
            });
        });
        return { definition, rows };
    }

    public async *iterateTable(name: string, options: AccessReadOptions = {}): AsyncGenerator<AccessValue[], void, void> {
        const snapshot = await this.readTable(name, options);
        for (const row of snapshot.rows) {
            yield [...row];
        }
    }

    public async writeAtomically(writer: AccessAtomicWriter): Promise<AccessAtomicWriteResult> {
        this.ensureOpen();
        if (this.readOnly) {
            throw new AccessFileReadOnlyError(this.filePath);
        }

        const stagedPath = makeStagedPath(this.filePath);
        try {
            await fs.copyFile(this.filePath, stagedPath);
            await writer({ sourcePath: this.filePath, stagedPath, format: this.format });
            await flushFile(stagedPath);
            await replaceFileAtomically(stagedPath, this.filePath);
        } catch (error) {
            await fs.rm(stagedPath, { force: true }).catch(() => undefined);
            throw error;
        }

        this._buffer = await fs.readFile(this.filePath);
        this._format = detectAccessFileFormat(this._buffer, this.filePath);
        this._reader = new MDBReader(this._buffer, { password: this._options.password });
        return { targetPath: this.filePath, format: this.format };
    }

    private getMdbTable(name: string): MdbTable {
        this.ensureOpen();
        try {
            return this._reader.getTable(name);
        } catch (error) {
            throw new AccessFileError(
                `Access table '${name}' cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    }

    private tableDefinitionPage(name: string): number {
        if (name.localeCompare('MSysObjects', undefined, { sensitivity: 'accent' }) === 0) {
            return 2;
        }
        const objects = this.getMdbTable('MSysObjects').getData({ columns: ['Id', 'Name'] }) as readonly Record<string, MdbValue>[];
        const row = objects.find(candidate => String(candidate.Name ?? '').localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
        const id = Number(row?.Id);
        if (!Number.isInteger(id) || id <= 0) {
            throw new AccessFileError(`Access table definition for '${name}' cannot be found.`);
        }
        return id & 0x00ffffff;
    }

    private ensureOpen(): void {
        if (this._closed) {
            throw new AccessFileError('Access file session is closed.');
        }
    }
}
