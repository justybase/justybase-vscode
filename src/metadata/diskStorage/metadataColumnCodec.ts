/**
 * Dictionary-encoded column file format (schema v3) — smaller JSON for disk persistence.
 */

import type { ColumnMetadata } from '../types';
import {
    COLUMN_FILE_SCHEMA_VERSION,
    COLUMN_FLAG_DISTRIBUTION_KEY,
    COLUMN_FLAG_FK,
    COLUMN_FLAG_PK,
    type EncodedColumnLayer,
    type EncodedColumnRecord,
    type SerializedColumnFile,
    type SerializedColumnFileV2,
    type SerializedColumnFileV3,
    type SerializedLayerEntry,
} from './metadataDiskTypes';

function intern(table: string[], value: string): number {
    const existing = table.indexOf(value);
    if (existing >= 0) {
        return existing;
    }
    table.push(value);
    return table.length - 1;
}

function internTable(
    tables: Array<{ schema: number; name: string }>,
    schemaIdx: number,
    name: string,
): number {
    const existing = tables.findIndex((entry) => entry.schema === schemaIdx && entry.name === name);
    if (existing >= 0) {
        return existing;
    }
    tables.push({ schema: schemaIdx, name });
    return tables.length - 1;
}

export function parseColumnLayerKey(
    layerKey: string,
    database: string,
): { schemaName: string; tableName: string } {
    if (layerKey.startsWith(`${database}..`)) {
        return {
            schemaName: '',
            tableName: layerKey.slice(database.length + 2),
        };
    }

    let remainder = layerKey;
    if (layerKey.startsWith(`${database}.`)) {
        remainder = layerKey.slice(database.length + 1);
    }

    const dotIndex = remainder.indexOf('.');
    if (dotIndex >= 0) {
        return {
            schemaName: remainder.slice(0, dotIndex),
            tableName: remainder.slice(dotIndex + 1),
        };
    }

    return { schemaName: '', tableName: remainder };
}

export function encodeColumnLayers(
    database: string,
    column: Record<string, SerializedLayerEntry<ColumnMetadata>>,
): SerializedColumnFileV3 {
    const schemas: string[] = [];
    const types: string[] = [];
    const tables: Array<{ schema: number; name: string }> = [];
    const docs: string[] = [];
    const layers: Record<string, EncodedColumnLayer> = {};

    for (const [layerKey, entry] of Object.entries(column)) {
        const { schemaName, tableName } = parseColumnLayerKey(layerKey, database);
        const schemaIdx = intern(schemas, schemaName);
        const tableIdx = internTable(tables, schemaIdx, tableName);

        const encodedColumns: EncodedColumnRecord[] = [];
        for (const col of entry.data) {
            const name = String(col.ATTNAME ?? col.label ?? '');
            const typeName = String(col.FORMAT_TYPE ?? 'UNKNOWN');
            let flags = 0;
            if (col.isPk) {
                flags |= COLUMN_FLAG_PK;
            }
            if (col.isFk) {
                flags |= COLUMN_FLAG_FK;
            }
            if (col.isDistributionKey) {
                flags |= COLUMN_FLAG_DISTRIBUTION_KEY;
            }

            const record: EncodedColumnRecord = {
                schema: schemaIdx,
                table: tableIdx,
                type: intern(types, typeName),
                name,
                flags,
            };
            if (typeof col.documentation === 'string' && col.documentation.length > 0) {
                record.doc = intern(docs, col.documentation);
            }
            encodedColumns.push(record);
        }

        layers[layerKey] = {
            timestamp: entry.timestamp,
            columns: encodedColumns,
        };
    }

    return {
        schemaVersion: COLUMN_FILE_SCHEMA_VERSION,
        database,
        schemas,
        types,
        tables,
        docs,
        layers,
    };
}

function decodeLayerColumnsV3(
    file: SerializedColumnFileV3,
    layer: EncodedColumnLayer,
): ColumnMetadata[] {
    return layer.columns.map((encoded) => {
        const metadata: ColumnMetadata = {
            ATTNAME: encoded.name,
            FORMAT_TYPE: file.types[encoded.type] ?? 'UNKNOWN',
            label: encoded.name,
            isPk: (encoded.flags & COLUMN_FLAG_PK) !== 0,
            isFk: (encoded.flags & COLUMN_FLAG_FK) !== 0,
            isDistributionKey: (encoded.flags & COLUMN_FLAG_DISTRIBUTION_KEY) !== 0,
        };
        if (encoded.doc !== undefined && file.docs[encoded.doc] !== undefined) {
            metadata.documentation = file.docs[encoded.doc];
        }

        return metadata;
    });
}

export function resolveColumnLayerKeyInFile(
    file: SerializedColumnFile,
    layerKey: string,
): string | undefined {
    const normalized = layerKey.toUpperCase();
    if (file.schemaVersion === COLUMN_FILE_SCHEMA_VERSION) {
        if (file.layers[layerKey]) {
            return layerKey;
        }
        for (const key of Object.keys(file.layers)) {
            if (key.toUpperCase() === normalized) {
                return key;
            }
        }
        return undefined;
    }

    const legacy = (file as SerializedColumnFileV2).column;
    if (legacy[layerKey]) {
        return layerKey;
    }
    for (const key of Object.keys(legacy)) {
        if (key.toUpperCase() === normalized) {
            return key;
        }
    }
    return undefined;
}

/** Decode one table's columns from a persisted column file (disk persistence). */
export function decodeColumnLayerFromFile(
    file: SerializedColumnFile,
    layerKey: string,
): ColumnMetadata[] | undefined {
    const resolvedKey = resolveColumnLayerKeyInFile(file, layerKey);
    if (!resolvedKey) {
        return undefined;
    }

    if (file.schemaVersion === COLUMN_FILE_SCHEMA_VERSION) {
        const layer = file.layers[resolvedKey];
        if (!layer) {
            return undefined;
        }
        return decodeLayerColumnsV3(file, layer);
    }

    const entry = (file as SerializedColumnFileV2).column[resolvedKey];
    return entry?.data;
}

export function decodeColumnFile(file: SerializedColumnFile): Record<string, SerializedLayerEntry<ColumnMetadata>> {
    if (file.schemaVersion === COLUMN_FILE_SCHEMA_VERSION) {
        return decodeColumnFileV3(file);
    }
    return (file as SerializedColumnFileV2).column;
}

function decodeColumnFileV3(file: SerializedColumnFileV3): Record<string, SerializedLayerEntry<ColumnMetadata>> {
    const column: Record<string, SerializedLayerEntry<ColumnMetadata>> = {};

    for (const [layerKey, layer] of Object.entries(file.layers)) {
        column[layerKey] = {
            timestamp: layer.timestamp,
            data: decodeLayerColumnsV3(file, layer),
        };
    }

    return column;
}

export function expandColumnFileToLegacy(file: SerializedColumnFile): SerializedColumnFileV2 {
    if (file.schemaVersion === COLUMN_FILE_SCHEMA_VERSION) {
        return {
            schemaVersion: 2,
            database: file.database,
            column: decodeColumnFileV3(file),
        };
    }
    return file;
}
