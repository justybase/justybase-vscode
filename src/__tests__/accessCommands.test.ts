import * as vscode from 'vscode';
import { registerAccessCommands } from '../commands/schema/accessCommands';
import type { SchemaItem } from '../providers/schemaProvider';
import type { SchemaCommandsDependencies } from '../commands/schema/types';

describe('Access schema commands', () => {
    let handler: ((item?: SchemaItem) => Promise<void>) | undefined;

    beforeEach(() => {
        jest.clearAllMocks();
        handler = undefined;
        (vscode.commands.registerCommand as jest.Mock).mockImplementation(
            (command: string, callback: (item?: SchemaItem) => Promise<void>) => {
                if (command === 'netezza.revealAccessFile') {
                    handler = callback;
                }
                return { dispose: jest.fn() };
            },
        );
    });

    it('reveals the Access database file for an Access schema node', async () => {
        const connectionManager = {
            getActiveConnectionName: jest.fn().mockReturnValue('Access profile'),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('access'),
            getConnection: jest.fn().mockResolvedValue({ database: process.execPath }),
        } as unknown as SchemaCommandsDependencies['connectionManager'];

        registerAccessCommands({ connectionManager } as SchemaCommandsDependencies);
        await handler?.({ connectionName: 'Access profile' } as SchemaItem);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'revealFileInOS',
            expect.objectContaining({
                scheme: 'file',
                fsPath: process.execPath,
                path: process.execPath,
            }),
        );
    });
});
