import * as vscode from 'vscode';
import { MetadataCache } from '../metadata/cache/MetadataCache';
import {
    removeTableObject,
    replaceTableObjectTypeForDatabase,
    toTableMetadata,
    upsertTableObject,
} from '../metadata/cache/tableObjectMutation';

jest.mock('vscode');

describe('tableObjectMutation', () => {
    function createCache(): MetadataCache {
        return new MetadataCache({ globalStorageUri: vscode.Uri.file('/tmp/table-object-mutation') } as vscode.ExtensionContext);
    }

    it('upserts and removes one object without replacing other table-like types', () => {
        const cache = createCache();
        cache.setTables(
            'CONN',
            'DB1.ADMIN',
            [
                { OBJNAME: 'T1', SCHEMA: 'ADMIN', OBJID: 1, objType: 'TABLE', label: 'T1' },
                { OBJNAME: 'V1', SCHEMA: 'ADMIN', OBJID: 2, objType: 'VIEW', label: 'V1' },
            ],
            new Map(),
        );

        upsertTableObject(
            cache,
            'CONN',
            'DB1',
            'ADMIN',
            toTableMetadata({
                OBJNAME: 'GTT1',
                SCHEMA: 'ADMIN',
                OBJID: 3,
                OBJTYPE: 'GLOBAL TEMP TABLE',
            }),
        );

        expect(cache.getTables('CONN', 'DB1.ADMIN')?.map(row => row.OBJNAME)).toEqual([
            'T1',
            'V1',
            'GTT1',
        ]);
        expect(removeTableObject(cache, 'CONN', 'DB1', 'ADMIN', 't1')).toBe(true);
        expect(cache.getTables('CONN', 'DB1.ADMIN')?.map(row => row.OBJNAME)).toEqual([
            'V1',
            'GTT1',
        ]);
    });

    it('inserts a new table in OBJNAME order within its object type', () => {
        const cache = createCache();
        cache.setTables(
            'CONN',
            'DB1.ADMIN',
            [
                { OBJNAME: 'T1', SCHEMA: 'ADMIN', OBJID: 1, objType: 'TABLE', label: 'T1' },
                { OBJNAME: 'V1', SCHEMA: 'ADMIN', OBJID: 2, objType: 'VIEW', label: 'V1' },
                { OBJNAME: 'T9', SCHEMA: 'ADMIN', OBJID: 3, objType: 'TABLE', label: 'T9' },
            ],
            new Map(),
        );

        upsertTableObject(
            cache,
            'CONN',
            'DB1',
            'ADMIN',
            toTableMetadata({
                OBJNAME: 'T5',
                SCHEMA: 'ADMIN',
                OBJID: 4,
                OBJTYPE: 'TABLE',
            }),
        );

        expect(cache.getTables('CONN', 'DB1.ADMIN')?.map(row => row.OBJNAME)).toEqual([
            'V1',
            'T1',
            'T5',
            'T9',
        ]);
        expect(
            cache.getObjectsByType('CONN', 'DB1', 'TABLE')?.map(entry => entry.item.OBJNAME),
        ).toEqual(['T1', 'T5', 'T9']);
    });

    it('replaces one type across schemas and preserves other types', () => {
        const cache = createCache();
        cache.setTables(
            'CONN',
            'DB1.ADMIN',
            [
                { OBJNAME: 'OLD_ADMIN', SCHEMA: 'ADMIN', objType: 'TABLE', label: 'OLD_ADMIN' },
                { OBJNAME: 'V1', SCHEMA: 'ADMIN', objType: 'VIEW', label: 'V1' },
            ],
            new Map(),
        );
        cache.setTables(
            'CONN',
            'DB1.STAGE',
            [{ OBJNAME: 'OLD_STAGE', SCHEMA: 'STAGE', objType: 'TABLE', label: 'OLD_STAGE' }],
            new Map(),
        );

        replaceTableObjectTypeForDatabase(
            cache,
            'CONN',
            'DB1',
            'TABLE',
            [
                toTableMetadata({ OBJNAME: 'NEW_ADMIN', SCHEMA: 'ADMIN', OBJTYPE: 'TABLE' }),
                toTableMetadata({ OBJNAME: 'NEW_STAGE', SCHEMA: 'STAGE', OBJTYPE: 'TABLE' }),
            ],
        );

        expect(cache.getTables('CONN', 'DB1.ADMIN')?.map(row => row.OBJNAME)).toEqual([
            'V1',
            'NEW_ADMIN',
        ]);
        expect(cache.getTables('CONN', 'DB1.STAGE')?.map(row => row.OBJNAME)).toEqual([
            'NEW_STAGE',
        ]);
    });

    it('invalidates only one table column layer until live columns replace it', async () => {
        const cache = createCache();
        cache.setColumns('CONN', 'DB1.ADMIN.T1', [{ ATTNAME: 'OLD', FORMAT_TYPE: 'INTEGER' }]);
        cache.setColumns('CONN', 'DB1.ADMIN.T2', [{ ATTNAME: 'KEEP', FORMAT_TYPE: 'INTEGER' }]);

        cache.invalidateTableColumns('CONN', 'DB1', 'ADMIN', 'T1');
        await cache.ensureColumnsLoadedForTableKey('CONN', 'DB1.ADMIN.T1');

        expect(cache.getColumns('CONN', 'DB1.ADMIN.T1')).toBeUndefined();
        expect(cache.getColumns('CONN', 'DB1.ADMIN.T2')?.[0].ATTNAME).toBe('KEEP');
        cache.setColumns('CONN', 'DB1.ADMIN.T1', [{ ATTNAME: 'NEW', FORMAT_TYPE: 'INTEGER' }]);
        expect(cache.getColumns('CONN', 'DB1.ADMIN.T1')?.[0].ATTNAME).toBe('NEW');
    });
});
