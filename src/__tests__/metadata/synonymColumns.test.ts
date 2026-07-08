import { mirrorSynonymColumnsForConnection } from '../../metadata/synonymColumns';
import type { MetadataCache } from '../../metadataCache';
import type { ColumnMetadata, TableMetadata } from '../../metadata/types';

function createMockCache(
    tables: TableMetadata[],
    columns: Map<string, ColumnMetadata[]>,
): MetadataCache {
    const tableCache = new Map<string, { data: TableMetadata[]; timestamp: number }>([
        ['CONN|DB1.PUBLIC', { data: tables, timestamp: Date.now() }],
    ]);

    return {
        tableCache,
        ensureColumnsLoaded: jest.fn(async () => undefined),
        getColumns: jest.fn((connectionName: string, key: string) => {
            const fullKey = `${connectionName}|${key}`;
            return columns.get(fullKey);
        }),
        getColumnsAnySchema: jest.fn(),
        setColumns: jest.fn((connectionName: string, key: string, value: ColumnMetadata[]) => {
            columns.set(`${connectionName}|${key}`, value);
        }),
    } as unknown as MetadataCache;
}

describe('mirrorSynonymColumnsForConnection', () => {
    it('copies target table columns onto synonym cache key', async () => {
        const targetColumns: ColumnMetadata[] = [
            {
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INT4',
                label: 'ID',
                kind: 5,
                detail: 'INT4',
            },
        ];
        const columns = new Map<string, ColumnMetadata[]>([
            ['CONN|DB1.PUBLIC.ORDERS', targetColumns],
        ]);

        const cache = createMockCache(
            [
                {
                    OBJNAME: 'ORDERS_SYN',
                    label: 'ORDERS_SYN',
                    objType: 'SYNONYM',
                    SCHEMA: 'PUBLIC',
                    REFOBJNAME: 'PUBLIC.ORDERS',
                },
            ],
            columns,
        );

        const mirrored = await mirrorSynonymColumnsForConnection(cache, 'CONN');

        expect(mirrored).toBe(1);
        expect(cache.setColumns).toHaveBeenCalledWith(
            'CONN',
            'DB1.PUBLIC.ORDERS_SYN',
            targetColumns,
        );
    });
});
