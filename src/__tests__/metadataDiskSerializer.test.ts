import { beforeEach, describe, expect, it } from '@jest/globals';
import * as vscode from 'vscode';
import { MetadataCache } from '../metadataCache';
import {
    buildTableIdMap,
    hydrateConnectionIntoCache,
    isConnectionCacheComplete,
    serializeConnectionFromCache,
} from '../metadata/diskStorage/metadataDiskSerializer';
import { DOCUMENTATION_MAX_LENGTH } from '../metadata/diskStorage/metadataDiskTypes';
import { Logger } from '../utils/logger';

jest.mock('vscode');

describe('metadataDiskSerializer', () => {
    let cache: MetadataCache;

    beforeEach(() => {
        const mockOutputChannel = {
            appendLine: jest.fn(),
            show: jest.fn(),
            dispose: jest.fn(),
        } as unknown as vscode.OutputChannel;
        Logger.initialize(mockOutputChannel);

        const mockContext = {
            globalStorageUri: vscode.Uri.file('/tmp/metadata-cache-test'),
        } as vscode.ExtensionContext;

        jest.spyOn(
            require('../compatibility/configuration'),
            'getExtensionConfiguration',
        ).mockReturnValue({
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'metadataCache.diskPersistence') {
                    return false;
                }
                return defaultValue;
            },
        });

        cache = new MetadataCache(mockContext);
    });

    function populateFullConnection(connectionName: string): void {
        cache.setDatabases(connectionName, [{ DATABASE: 'DB1', label: 'DB1', kind: 9 }]);
        cache.setSchemas(connectionName, 'DB1', [{ SCHEMA: 'ADMIN', label: 'ADMIN', kind: 19 }]);
        const idMap = new Map<string, number>();
        idMap.set('DB1.ADMIN.T1', 100);
        cache.setTables(
            connectionName,
            'DB1.ADMIN',
            [{
                OBJNAME: 'T1',
                OBJID: 100,
                SCHEMA: 'ADMIN',
                objType: 'TABLE',
                kind: 6,
                label: 'T1',
            }],
            idMap,
        );
        cache.setProcedures(connectionName, 'DB1..', [{
            PROCEDURE: 'P1',
            SCHEMA: 'ADMIN',
            label: 'P1',
        }]);
        cache.setColumns(connectionName, 'DB1.ADMIN.T1', [{
            ATTNAME: 'COL1',
            FORMAT_TYPE: 'INTEGER',
            label: 'COL1',
            isPk: true,
        }]);
        cache.setTypeGroups(connectionName, 'DB1', ['TABLE', 'VIEW']);
    }

    it('should roundtrip connection data through serialize and hydrate', () => {
        populateFullConnection('conn1');
        const serialized = serializeConnectionFromCache(
            cache,
            'conn1',
            'fingerprint',
            Date.now(),
        );
        expect(serialized).toBeDefined();
        expect(isConnectionCacheComplete(serialized!)).toBe(true);

        const cache2 = new MetadataCache({ globalStorageUri: vscode.Uri.file('/tmp/x') } as vscode.ExtensionContext);
        hydrateConnectionIntoCache(cache2, 'conn1', serialized!);

        expect(cache2.getDatabases('conn1')).toEqual(cache.getDatabases('conn1'));
        expect(cache2.getSchemas('conn1', 'DB1')).toEqual(cache.getSchemas('conn1', 'DB1'));
        expect(cache2.getTables('conn1', 'DB1.ADMIN')).toEqual(cache.getTables('conn1', 'DB1.ADMIN'));
        expect(cache2.findTableId('conn1', 'DB1.ADMIN.T1')).toBe(100);
    });

    it('should strip unknown keys and truncate documentation (E15)', () => {
        populateFullConnection('conn1');
        cache.setColumns('conn1', 'DB1.ADMIN.T1', [{
            ATTNAME: 'DOC_COL',
            FORMAT_TYPE: 'VARCHAR',
            documentation: 'x'.repeat(10_000),
            extraRuntimeField: 'remove-me',
        } as never]);

        const serialized = serializeConnectionFromCache(cache, 'conn1', 'fp', Date.now());
        const col = serialized!.column['DB1.ADMIN.T1'].data[0];
        expect(col.documentation).toHaveLength(DOCUMENTATION_MAX_LENGTH);
        expect((col as Record<string, unknown>).extraRuntimeField).toBeUndefined();
    });

    it('should build table id map from OBJID fields', () => {
        const idMap = buildTableIdMap('DB1.ADMIN', [{
            OBJNAME: 'T1',
            OBJID: 42,
            SCHEMA: 'ADMIN',
            label: 'T1',
        }]);
        expect(idMap.get('DB1.ADMIN.T1')).toBe(42);
    });

    it('should roundtrip case-sensitive table column keys', () => {
        populateFullConnection('conn1');
        cache.setColumns('conn1', 'DB1.ADMIN.lower_table', [{
            ATTNAME: 'COL1',
            FORMAT_TYPE: 'INTEGER',
            label: 'COL1',
            isPk: false,
            isDistributionKey: false,
        }]);

        const serialized = serializeConnectionFromCache(cache, 'conn1', 'fp', Date.now());
        expect(serialized!.column['DB1.ADMIN.lower_table']).toBeDefined();

        const cache2 = new MetadataCache({ globalStorageUri: vscode.Uri.file('/tmp/x2') } as vscode.ExtensionContext);
        hydrateConnectionIntoCache(cache2, 'conn1', serialized!);

        expect(cache2.getColumns('conn1', 'DB1.ADMIN.lower_table')).toEqual(
            cache.getColumns('conn1', 'DB1.ADMIN.lower_table'),
        );
    });

    it('should report incomplete cache when layers missing', () => {
        cache.setDatabases('conn1', [{ DATABASE: 'DB1', label: 'DB1' }]);
        const serialized = serializeConnectionFromCache(cache, 'conn1', 'fp', Date.now());
        expect(serialized).toBeUndefined();
    });
});
