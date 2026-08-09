import { ConnectionManager } from '../../core/connectionManager';
import { McpHttpServerManager } from '../../mcp/mcpHttpServerManager';
import { NetezzaMcpServerDefinitionProvider } from '../../mcp/mcpServerDefinitionProvider';
import {
    getAvailableNetezzaConnectionNames,
    resolveSelectedMcpConnection
} from '../../mcp/mcpConnection';

function createConnectionManager(kind: string): ConnectionManager {
    return {
        getActiveConnectionName: jest.fn().mockReturnValue('active'),
        getConnectionDatabaseKind: jest.fn().mockReturnValue(kind),
        getConnection: jest.fn(),
        onDidChangeActiveConnection: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    } as unknown as ConnectionManager;
}

describe('MCP Netezza-only connection gate', () => {
    it('does not publish a stdio server for a selected non-Netezza connection', () => {
        const connectionManager = createConnectionManager('postgresql');
        const provider = new NetezzaMcpServerDefinitionProvider(
            { subscriptions: [] } as never,
            connectionManager,
            () => 'active',
        );

        provider.setEnabled(true);

        expect(provider.hasSelectedNetezzaConnection()).toBe(false);
        expect(provider.provideMcpServerDefinitions()).toEqual([]);
    });

    it('does not spawn HTTP mode for a selected non-Netezza connection', async () => {
        const connectionManager = createConnectionManager('duckdb');
        const manager = new McpHttpServerManager(
            { subscriptions: [] } as never,
            connectionManager,
            () => 'active',
        );

        const status = await manager.start(37210);

        expect(status.running).toBe(false);
        expect(status.lastError).toContain('is not a Netezza connection');
        expect(connectionManager.getConnection).not.toHaveBeenCalled();
        manager.dispose();
    });

    it('blocks startup until a connection is selected', async () => {
        const connectionManager = createConnectionManager('netezza');
        const manager = new McpHttpServerManager(
            { subscriptions: [] } as never,
            connectionManager,
            () => undefined,
        );

        const status = await manager.start(37210);

        expect(status.running).toBe(false);
        expect(status.lastError).toContain('Select an Netezza connection');
        expect(connectionManager.getConnection).not.toHaveBeenCalled();
        manager.dispose();
    });

    it('reports a deleted or inaccessible selected connection without falling back', async () => {
        const connectionManager = createConnectionManager('netezza');
        (connectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue(undefined);
        const manager = new McpHttpServerManager(
            { subscriptions: [] } as never,
            connectionManager,
            () => 'deleted-nz',
        );

        const status = await manager.start(37210);

        expect(status.running).toBe(false);
        expect(status.lastError).toContain('deleted-nz');
        expect(status.lastError).toContain('not found');
        expect(connectionManager.getActiveConnectionName).not.toHaveBeenCalled();
        manager.dispose();
    });

    it('uses the selected connection even when the active editor connection differs', async () => {
        const connectionManager = {
            getActiveConnectionName: jest.fn().mockReturnValue('active-postgres'),
            getConnectionDatabaseKind: jest.fn((name?: string) => name === 'selected-nz' ? 'netezza' : 'postgresql'),
            getConnection: jest.fn().mockResolvedValue({
                name: 'selected-nz',
                host: 'nz.example.com',
                database: 'SYSTEM',
                user: 'ADMIN',
                password: 'secret',
                dbType: 'netezza'
            }),
            onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        } as unknown as ConnectionManager;
        const resolution = await resolveSelectedMcpConnection(connectionManager, 'selected-nz');

        expect('error' in resolution).toBe(false);
        expect(connectionManager.getConnectionDatabaseKind).toHaveBeenCalledWith('selected-nz');
        expect(connectionManager.getConnection).toHaveBeenCalledWith('selected-nz');
        if (!('error' in resolution)) {
            expect(resolution.connectionName).toBe('selected-nz');
            expect(resolution.details.name).toBe('selected-nz');
        }
    });

    it('lists only saved Netezza connection names for the panel', async () => {
        const connectionManager = {
            getConnections: jest.fn().mockResolvedValue([
                { name: 'z-nz', host: 'h', database: 'd', user: 'u', dbType: 'netezza' },
                { name: 'a-postgres', host: 'h', database: 'd', user: 'u', dbType: 'postgresql' },
                { name: 'a-nz', host: 'h', database: 'd', user: 'u', dbType: 'netezza' },
            ]),
            getConnectionDatabaseKind: jest.fn((name?: string) => name?.endsWith('nz') ? 'netezza' : 'postgresql'),
            getConnection: jest.fn(),
        } as unknown as ConnectionManager;

        await expect(getAvailableNetezzaConnectionNames(connectionManager)).resolves.toEqual(['a-nz', 'z-nz']);
    });
});
