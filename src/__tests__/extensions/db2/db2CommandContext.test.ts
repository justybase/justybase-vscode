import type * as vscode from 'vscode';
import { db2MaintenanceProvider } from '../../../../extensions/db2/src/db2MaintenanceProvider';
import { Db2MaintenanceApi, resolveOperationContext } from '../../../../extensions/db2/src/db2CommandContext';

describe('Db2 command context', () => {
    it('uses the core connection profile and concrete Db2 maintenance provider', async () => {
        const api: Db2MaintenanceApi = {
            getConnectionSummary: jest.fn().mockResolvedValue({
                name: 'db2-connection',
                database: 'SAMPLE',
                databaseKind: 'db2'
            }),
            executeConnectionSql: jest.fn(),
            executeConnectionSqlQuery: jest.fn()
        };

        const resolved = await resolveOperationContext(
            {} as vscode.ExtensionContext,
            api,
            {
                label: 'SALES',
                rawLabel: 'SALES',
                dbName: 'SAMPLE',
                schema: 'ADMIN',
                objType: 'TABLE',
                connectionName: 'db2-connection'
            },
            'Create index'
        );

        expect(resolved).toBeDefined();
        expect(resolved?.provider).toBe(db2MaintenanceProvider);
        expect(resolved?.target).toEqual({
            connectionName: 'db2-connection',
            databaseName: 'SAMPLE',
            schemaName: 'ADMIN',
            tableName: 'SALES',
            qualifiedName: 'ADMIN.SALES'
        });
    });
});
