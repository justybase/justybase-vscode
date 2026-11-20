jest.mock('../../core/factories/databaseDialectRegistry', () => ({
    getDatabaseDialectByKind: jest.fn(),
}));
jest.mock('../../core/connectedDatabaseFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: jest.fn(),
}));
jest.mock('../../core/mcpConnectionFactory', () => ({
    createConnectedNetezzaConnectionFromDetails: jest.fn(),
}));

import { getDatabaseDialectByKind } from '../../core/factories/databaseDialectRegistry';
import { createConnectedDatabaseConnectionFromDetails } from '../../core/connectedDatabaseFactory';
import { createConnectedNetezzaConnectionFromDetails } from '../../core/mcpConnectionFactory';
import { createConnectionFromDetails } from '../../dialects/netezza/ddl/helpers';
import type { ConnectionDetails } from '../../types';

const getDialect = getDatabaseDialectByKind as jest.Mock;
const createDialectConnection = createConnectedDatabaseConnectionFromDetails as jest.Mock;
const createMcpConnection = createConnectedNetezzaConnectionFromDetails as jest.Mock;

const details: ConnectionDetails = {
    host: 'h',
    database: 'DWH',
    user: 'ADMIN',
    password: 'secret',
    dbType: 'netezza',
};

describe('Netezza DDL connection factory', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        createDialectConnection.mockResolvedValue({ source: 'dialect' });
        createMcpConnection.mockResolvedValue({ source: 'mcp' });
    });

    it('uses the registered dialect in the extension host', async () => {
        getDialect.mockReturnValue({ kind: 'netezza' });

        const connection = await createConnectionFromDetails(details, 'OTHER');

        expect(connection).toEqual({ source: 'dialect' });
        expect(createDialectConnection).toHaveBeenCalledWith(details, 'OTHER');
        expect(createMcpConnection).not.toHaveBeenCalled();
    });

    it('falls back to the VS Code-free Netezza factory in the MCP process', async () => {
        getDialect.mockReturnValue(undefined);

        const connection = await createConnectionFromDetails(details, 'OTHER');

        expect(connection).toEqual({ source: 'mcp' });
        expect(createMcpConnection).toHaveBeenCalledWith(details, 'OTHER');
        expect(createDialectConnection).not.toHaveBeenCalled();
    });
});
