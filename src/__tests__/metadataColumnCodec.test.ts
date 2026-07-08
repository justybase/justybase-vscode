import { beforeEach, describe, expect, it } from '@jest/globals';
import * as vscode from 'vscode';
import { MetadataCache } from '../metadataCache';
import {
    decodeColumnFile,
    decodeColumnLayerFromFile,
    encodeColumnLayers,
    parseColumnLayerKey,
} from '../metadata/diskStorage/metadataColumnCodec';
import {
    COLUMN_FILE_SCHEMA_VERSION,
    DOCUMENTATION_MAX_LENGTH,
    type SerializedLayerEntry,
} from '../metadata/diskStorage/metadataDiskTypes';
import type { ColumnMetadata } from '../metadata/types';
import { Logger } from '../utils/logger';

jest.mock('vscode');

describe('metadataColumnCodec', () => {
    beforeEach(() => {
        const mockOutputChannel = {
            appendLine: jest.fn(),
            show: jest.fn(),
            dispose: jest.fn(),
        } as unknown as vscode.OutputChannel;
        Logger.initialize(mockOutputChannel);
    });

    const sampleLayers: Record<string, SerializedLayerEntry<ColumnMetadata>> = {
        'DB1.SALES.ORDERS': {
            timestamp: 100,
            data: [
                {
                    ATTNAME: 'CUSTOMER_ID',
                    FORMAT_TYPE: 'INTEGER',
                    label: 'CUSTOMER_ID',
                    isPk: true,
                },
                {
                    ATTNAME: 'STATUS',
                    FORMAT_TYPE: 'VARCHAR',
                    label: 'STATUS',
                    documentation: 'x'.repeat(500),
                },
            ],
        },
        'DB1..NICK_TABLE': {
            timestamp: 200,
            data: [
                {
                    ATTNAME: 'COL_A',
                    FORMAT_TYPE: 'TIMESTAMP',
                    label: 'COL_A',
                    isDistributionKey: true,
                },
            ],
        },
    };

    it('should parse standard and double-dot layer keys', () => {
        expect(parseColumnLayerKey('DB1.SALES.ORDERS', 'DB1')).toEqual({
            schemaName: 'SALES',
            tableName: 'ORDERS',
        });
        expect(parseColumnLayerKey('DB1..NICK_TABLE', 'DB1')).toEqual({
            schemaName: '',
            tableName: 'NICK_TABLE',
        });
    });

    it('should decode a single column layer without expanding all tables', () => {
        const encoded = encodeColumnLayers('DB1', sampleLayers);
        const single = decodeColumnLayerFromFile(encoded, 'DB1.SALES.ORDERS');
        expect(single?.map((col) => col.ATTNAME)).toEqual(['CUSTOMER_ID', 'STATUS']);
        expect(decodeColumnLayerFromFile(encoded, 'db1.sales.orders')?.[0].isPk).toBe(true);
        expect(decodeColumnLayerFromFile(encoded, 'DB1.S1.MISSING')).toBeUndefined();
    });

    it('should roundtrip column layers through dictionary encoding', () => {
        const encoded = encodeColumnLayers('DB1', sampleLayers);
        expect(encoded.schemaVersion).toBe(COLUMN_FILE_SCHEMA_VERSION);
        expect(encoded.schemas).toContain('SALES');
        expect(encoded.types).toEqual(expect.arrayContaining(['INTEGER', 'VARCHAR', 'TIMESTAMP']));

        const decoded = decodeColumnFile(encoded);
        expect(decoded['DB1.SALES.ORDERS'].data[0].ATTNAME).toBe('CUSTOMER_ID');
        expect(decoded['DB1.SALES.ORDERS'].data[0].isPk).toBe(true);
        expect(decoded['DB1.SALES.ORDERS'].data[1].documentation).toHaveLength(500);
        expect(decoded['DB1..NICK_TABLE'].data[0].isDistributionKey).toBe(true);
    });

    it('should produce smaller JSON than expanded column objects at scale', () => {
        const largeLayers: Record<string, SerializedLayerEntry<ColumnMetadata>> = {};
        for (let table = 0; table < 50; table++) {
            const columns: ColumnMetadata[] = [];
            for (let col = 0; col < 40; col++) {
                columns.push({
                    ATTNAME: `COL_${col}`,
                    FORMAT_TYPE: col % 3 === 0 ? 'INTEGER' : col % 3 === 1 ? 'VARCHAR' : 'TIMESTAMP',
                    label: `COL_${col}`,
                    isPk: col === 0,
                });
            }
            largeLayers[`DB1.SALES.TABLE_${table}`] = { timestamp: table, data: columns };
        }

        const encoded = encodeColumnLayers('DB1', largeLayers);
        const expanded = {
            schemaVersion: 2,
            database: 'DB1',
            column: largeLayers,
        };
        const encodedSize = JSON.stringify(encoded).length;
        const expandedSize = JSON.stringify(expanded).length;
        expect(encodedSize).toBeLessThan(expandedSize);
    });

    it('should roundtrip via serializeColumnsByDatabase and hydrate', () => {
        const cache = new MetadataCache({ globalStorageUri: vscode.Uri.file('/tmp/codec') } as vscode.ExtensionContext);
        cache.setDatabases('conn', [{ DATABASE: 'DB1', label: 'DB1' }]);
        cache.setSchemas('conn', 'DB1', [{ SCHEMA: 'SALES', label: 'SALES' }]);
        cache.setColumns('conn', 'DB1.SALES.ORDERS', sampleLayers['DB1.SALES.ORDERS'].data);
        cache.setColumns('conn', 'DB1..NICK_TABLE', sampleLayers['DB1..NICK_TABLE'].data);

        const { serializeColumnsByDatabase, mergeMetadataWithColumnFiles } = require('../metadata/diskStorage/metadataDiskSerializer');
        const columnFiles = [...serializeColumnsByDatabase(cache, 'conn').values()];
        expect(columnFiles[0].schemaVersion).toBe(COLUMN_FILE_SCHEMA_VERSION);

        const merged = mergeMetadataWithColumnFiles({
            prefetchCompletedAt: Date.now(),
            connectionFingerprint: 'fp',
            database: { timestamp: 1, data: [{ DATABASE: 'DB1' }] },
            schema: { DB1: { timestamp: 1, data: [{ SCHEMA: 'SALES' }] } },
            table: { 'DB1.SALES': { timestamp: 1, data: [{ OBJNAME: 'ORDERS', SCHEMA: 'SALES' }] } },
            procedure: { 'DB1..': { timestamp: 1, data: [{ PROCEDURE: 'P1' }] } },
            typeGroup: { DB1: { timestamp: 1, data: ['TABLE'] } },
        }, columnFiles);

        expect(merged.column['DB1.SALES.ORDERS'].data[0].FORMAT_TYPE).toBe('INTEGER');
        expect(merged.column['DB1..NICK_TABLE'].data[0].ATTNAME).toBe('COL_A');
    });

    it('should truncate documentation only at serializer strip stage, not in codec', () => {
        const layers = {
            'DB1.S1.T1': {
                timestamp: 1,
                data: [{
                    ATTNAME: 'DOC',
                    FORMAT_TYPE: 'VARCHAR',
                    documentation: 'y'.repeat(DOCUMENTATION_MAX_LENGTH + 50),
                }],
            },
        };
        const encoded = encodeColumnLayers('DB1', layers);
        const decoded = decodeColumnFile(encoded);
        expect(decoded['DB1.S1.T1'].data[0].documentation?.length).toBe(DOCUMENTATION_MAX_LENGTH + 50);
    });
});
