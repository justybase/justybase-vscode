import {
    applySearchIndexFilters,
    searchMetadataIndex,
    searchResultToSchemaItem,
} from '../metadata/searchIndex';
import { MetadataCache } from '../metadataCache';

describe('metadata/searchIndex', () => {
    let storage: MetadataCache;

    beforeEach(() => {
        storage = new MetadataCache({} as unknown as import('vscode').ExtensionContext);
    });

    it('filters results by schema and match type', () => {
        storage.setTables(
            'conn1',
            'MYDB.ADMIN',
            [
                { label: 'DIM_ACCOUNT', objType: 'TABLE', kind: 6, DESCRIPTION: 'Account dimension' },
                { label: 'FACT_SALES', objType: 'TABLE', kind: 6 },
            ],
            new Map(),
        );

        const results = searchMetadataIndex(storage, 'dimension', {
            connectionName: 'conn1',
            matchType: 'OBJ_DESC',
        });

        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('DIM_ACCOUNT');
    });

    it('maps cache search results to schema search items', () => {
        const item = searchResultToSchemaItem(
            {
                name: 'ORDERS',
                type: 'TABLE',
                database: 'MYDB',
                schema: 'ADMIN',
                matchType: 'NAME',
            },
            'conn1',
        );

        expect(item).toEqual(
            expect.objectContaining({
                NAME: 'ORDERS',
                TYPE: 'TABLE',
                DESCRIPTION: 'Result from Cache',
                MATCH_TYPE: 'NAME',
                connectionName: 'conn1',
            }),
        );
    });

    it('applySearchIndexFilters keeps only selected object type', () => {
        const filtered = applySearchIndexFilters(
            [
                { name: 'A', type: 'TABLE' },
                { name: 'B', type: 'COLUMN', parent: 'A' },
            ],
            { objectType: 'COLUMN' },
        );

        expect(filtered).toHaveLength(1);
        expect(filtered[0].name).toBe('B');
    });
});
