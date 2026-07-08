import * as vscode from 'vscode';
import { SchemaRecentObjectsService } from '../services/schemaRecentObjects';

describe('SchemaRecentObjectsService', () => {
    const globalState = new Map<string, unknown>();

    const context = {
        globalState: {
            get: <T>(key: string, defaultValue: T) => (globalState.get(key) as T | undefined) ?? defaultValue,
            update: async (key: string, value: unknown) => {
                globalState.set(key, value);
            },
        },
    } as unknown as vscode.ExtensionContext;

    beforeEach(() => {
        globalState.clear();
    });

    it('stores and returns recent objects for a connection', () => {
        const service = new SchemaRecentObjectsService(context);
        service.add({
            connectionName: 'conn1',
            database: 'MYDB',
            schema: 'ADMIN',
            name: 'DIM_ACCOUNT',
            objType: 'TABLE',
        });

        const recents = service.getRecents('conn1');
        expect(recents).toHaveLength(1);
        expect(recents[0].name).toBe('DIM_ACCOUNT');
    });

    it('moves duplicate entries to the top', () => {
        const service = new SchemaRecentObjectsService(context);
        service.add({
            connectionName: 'conn1',
            database: 'MYDB',
            schema: 'ADMIN',
            name: 'FIRST',
            objType: 'TABLE',
        });
        service.add({
            connectionName: 'conn1',
            database: 'MYDB',
            schema: 'ADMIN',
            name: 'SECOND',
            objType: 'TABLE',
        });
        service.add({
            connectionName: 'conn1',
            database: 'MYDB',
            schema: 'ADMIN',
            name: 'FIRST',
            objType: 'TABLE',
        });

        const recents = service.getRecents('conn1');
        expect(recents.map((entry) => entry.name)).toEqual(['FIRST', 'SECOND']);
    });
});
