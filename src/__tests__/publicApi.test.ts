import * as vscode from 'vscode';
import { createJustyBaseLiteApi } from '../api/publicApi';
import {
    type DatabaseCommand,
    type DatabaseConnection,
    type DatabaseConnectionConfig,
    type DatabaseConnectionStaticConstructor,
    type DatabaseDialect,
    createDatabaseCapabilities,
    createDatabaseDialectTraits
} from '../contracts/database';
import { getDatabaseCapabilities, getDatabaseDialect } from '../core/connectionFactory';
import type { ConnectionManager } from '../core/connectionManager';
import { resetDatabaseDialectTestingState } from './dialectTestUtils';
import { sqliteMetadataProvider } from '../dialects/sqlite/metadata/provider';
import { sqliteSqlAuthoring } from '../dialects/sqlite/sql/authoring';
import { postgresqlDialect } from '../../extensions/postgresql/src/postgresqlDialect';
import { oracleDialect } from '../../extensions/oracle/src/oracleDialect';

class MockDb2Connection implements DatabaseConnection {
    _connected = false;

    constructor(_config: DatabaseConnectionConfig) {}

    async connect(): Promise<void> {
        this._connected = true;
    }

    async close(): Promise<void> {
        this._connected = false;
    }

    createCommand(_sql: string): DatabaseCommand {
        return {
            commandTimeout: 0,
            async executeReader() {
                throw new Error('Not implemented for tests.');
            },
            async cancel() {},
            async execute() {},
            _recordsAffected: 0
        };
    }

    on(_event: string, _listener: (arg: unknown) => void): void {}

    removeListener(_event: string, _listener: (arg: unknown) => void): void {}
}

describe('createJustyBaseLiteApi', () => {
    beforeEach(() => {
        resetDatabaseDialectTestingState();
    });

    it('registers external dialects so core factories can resolve db2', () => {
        const api = createJustyBaseLiteApi();
        const connectionConstructor = MockDb2Connection as unknown as DatabaseConnectionStaticConstructor;
        const db2Dialect: DatabaseDialect = {
            kind: 'db2',
            displayName: 'Db2 LUW',
            defaultPort: 50000,
            capabilities: createDatabaseCapabilities({
                supportsProcedures: true,
                supportsTableMaintenance: true,
                supportsSessionMonitor: true
            }),
            traits: createDatabaseDialectTraits({
                completion: {
                    singleDotPathNamespace: 'schema'
                }
            }),
            metadataProvider: sqliteMetadataProvider,
            sqlAuthoring: sqliteSqlAuthoring,
            getConnectionConstructor(): DatabaseConnectionStaticConstructor {
                return connectionConstructor;
            },
            createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
                return new MockDb2Connection(config);
            }
        };

        api.registerDatabaseDialect(db2Dialect);

        expect(api.listRegisteredDatabaseDialects().some(item => item.kind === 'db2')).toBe(true);
        expect(getDatabaseDialect('db2')).toBe(db2Dialect);
    });

    it.each([
        ['oracle', oracleDialect, 'connectString'],
        ['postgresql', postgresqlDialect, 'searchPath']
    ] as const)(
        'registers the %s runtime dialect through the public API so core resolves the companion implementation',
        (kind, dialect, expectedFieldKey) => {
            const api = createJustyBaseLiteApi();

            expect(api.registerDatabaseDialect(dialect)).toBe(dialect);
            expect(api.listRegisteredDatabaseDialects().some(item => item.kind === kind)).toBe(true);
            expect(getDatabaseDialect(kind)).toBe(dialect);
            expect(getDatabaseCapabilities(kind)).toEqual(dialect.capabilities);
            expect(dialect.connectionForm?.fields.map(field => field.key)).toContain(expectedFieldKey);
        }
    );

    it('keeps the first registered PostgreSQL runtime dialect when a later registration conflicts on kind', () => {
        const api = createJustyBaseLiteApi();
        api.registerDatabaseDialect(postgresqlDialect);

        const competingDialect: DatabaseDialect = {
            ...postgresqlDialect,
            displayName: 'Competing PostgreSQL',
            capabilities: createDatabaseCapabilities()
        };

        expect(api.registerDatabaseDialect(competingDialect)).toBe(postgresqlDialect);
        expect(getDatabaseDialect('postgresql')).toBe(postgresqlDialect);
        expect(getDatabaseCapabilities('postgresql')).toEqual(postgresqlDialect.capabilities);
    });

    it('does not reuse a non-file profile for a File SQL session with the same name', async () => {
        const saveConnection = jest.fn();
        const connectionManager = {
            getConnections: jest.fn().mockResolvedValue([
                {
                    name: 'shared-name',
                    host: 'localhost',
                    database: 'warehouse',
                    user: 'analyst',
                    dbType: 'sqlite',
                },
            ]),
            saveConnection,
        } as unknown as ConnectionManager;
        const api = createJustyBaseLiteApi({} as vscode.ExtensionContext, connectionManager);

        await expect(api.openFileSqlSession(
            {
                name: 'shared-name',
                host: 'local',
                database: '/tmp/orders.csv',
                user: 'file',
                dbType: 'file',
            },
            { connectionName: 'shared-name' },
        )).rejects.toThrow('not a File SQL profile');
        expect(saveConnection).not.toHaveBeenCalled();
    });

    it('updates and reconnects an existing single-file profile when requested', async () => {
        const saveConnection = jest.fn().mockResolvedValue(undefined);
        const refreshFileConnection = jest.fn().mockResolvedValue(undefined);
        const connectionManager = {
            getConnections: jest.fn().mockResolvedValue([
                {
                    name: 'File SQL: sales.csv',
                    host: 'local',
                    database: '/data/sales.csv',
                    user: 'file',
                    dbType: 'file',
                    options: { editable: false },
                },
            ]),
            saveConnection,
            refreshFileConnection,
            setDocumentConnection: jest.fn().mockResolvedValue(undefined),
        } as unknown as ConnectionManager;
        const api = createJustyBaseLiteApi({} as vscode.ExtensionContext, connectionManager);
        const document = { uri: vscode.Uri.file('/tmp/file-sql-edit.sql') };
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);
        (vscode.window.showTextDocument as jest.Mock).mockResolvedValue({ document });

        await api.openFileSqlSession(
            {
                name: 'File SQL: sales.csv',
                host: 'local',
                database: '/data/sales.csv',
                user: 'file',
                dbType: 'file',
                options: { editable: true },
            },
            { connectionName: 'File SQL: sales.csv', updateExisting: true },
        );

        expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({
            name: 'File SQL: sales.csv',
            database: '/data/sales.csv',
            options: { editable: true },
        }));
        expect(refreshFileConnection).toHaveBeenCalledWith('File SQL: sales.csv');
    });
});
