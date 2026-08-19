import * as vscode from 'vscode';
import { runQueryRaw } from '../core/queryRunner';
import { MetadataProvider } from '../providers/providers/metadataProvider';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import type { ColumnMetadata } from '../metadata/types';

jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn(),
}));

describe('MetadataProvider completion labels', () => {
    it('keeps PK emoji when column has documentation', async () => {
        const cachedColumns: ColumnMetadata[] = [
            {
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INT4',
                label: 'ID',
                kind: vscode.CompletionItemKind.Field,
                detail: 'INT4',
                documentation: 'Primary key column',
                isPk: true,
                isFk: false,
            },
        ];

        const metadataCache = {
            getColumns: jest.fn().mockReturnValue(cachedColumns),
            ensureColumnsLoaded: jest.fn().mockResolvedValue(undefined),
            findTableId: jest.fn(),
            findObjectWithType: jest.fn().mockReturnValue({ objType: 'TABLE', schema: 'ADMIN' }),
        } as unknown as MetadataCache;

        const provider = new MetadataProvider(
            {} as vscode.ExtensionContext,
            metadataCache,
            {
                ensureFullyLoaded: jest.fn().mockResolvedValue(undefined),
                getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            } as unknown as ConnectionManager,
        );

        const items = await provider.getColumns('CONN', 'DB', 'ADMIN', 'FACT_001');
        const idItem = items.find((item) => item.insertText === 'ID');
        expect(idItem).toBeDefined();

        const labelText =
            typeof idItem!.label === 'string' ? idItem!.label : idItem!.label.label;
        expect(labelText).toContain('🔑');
        expect(idItem!.documentation).toBeDefined();
        if (typeof idItem!.label === 'object') {
            expect(idItem!.label.description).toBe('Primary key column');
        }
    });

    it('does not start a live Netezza query on a completion cache miss', async () => {
        const metadataCache = {
            getColumns: jest.fn().mockReturnValue(undefined),
            getColumnsAnySchema: jest.fn().mockReturnValue(undefined),
            ensureColumnsLoaded: jest.fn().mockResolvedValue(undefined),
            ensureColumnsLoadedForTableKey: jest.fn().mockResolvedValue(undefined),
            findTableId: jest.fn(),
            findObjectWithType: jest.fn().mockReturnValue(undefined),
            whenConnectionMetadataHydrated: jest.fn().mockResolvedValue(undefined),
        } as unknown as MetadataCache;
        const connectionManager = {
            ensureFullyLoaded: jest.fn().mockResolvedValue(undefined),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
        } as unknown as ConnectionManager;
        const provider = new MetadataProvider(
            {} as vscode.ExtensionContext,
            metadataCache,
            connectionManager,
        );

        const items = await provider.getColumns(
            'CONN',
            'DB',
            'ADMIN',
            'MISSING_TABLE',
            { allowDatabaseFetch: false, requestSource: 'completion' },
        );

        expect(items).toEqual([]);
        expect(runQueryRaw).not.toHaveBeenCalled();
    });
});
