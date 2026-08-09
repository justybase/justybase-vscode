import * as vscode from 'vscode';
import {
    getAccessConnectionName,
    isAccessDatabasePath,
    registerSaveAccessFileAsConnectionCommand,
} from '../commands/saveAccessFileAsConnection';

describe('save Access file as connection command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.commands.registerCommand as jest.Mock).mockImplementation(() => ({ dispose: jest.fn() }));
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    });

    it('recognizes only Access database extensions and derives the profile name', () => {
        expect(isAccessDatabasePath('/data/sample.accdb')).toBe(true);
        expect(isAccessDatabasePath('/data/sample.MDB')).toBe(true);
        expect(isAccessDatabasePath('/data/sample.sqlite')).toBe(false);
        expect(getAccessConnectionName('C:\\data\\monthly-report.accdb')).toBe('monthly-report');
    });

    it('saves, activates and refreshes an Access profile without prompting for a password', async () => {
        const getConnection = jest.fn().mockResolvedValue(undefined);
        const saveConnection = jest.fn().mockResolvedValue(undefined);
        const setActiveConnection = jest.fn().mockResolvedValue(undefined);
        const clearConnectionMetadata = jest.fn();
        const clearConnectionError = jest.fn();
        const refresh = jest.fn();

        registerSaveAccessFileAsConnectionCommand({
            connectionManager: { getConnection, saveConnection, setActiveConnection },
            metadataCache: { clearConnectionMetadata },
            schemaProvider: { clearConnectionError, refresh },
        });

        const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls[0][1] as
            (uri?: vscode.Uri) => Promise<void>;
        await handler(vscode.Uri.file('/data/monthly-report.accdb'));

        expect(saveConnection).toHaveBeenCalledWith({
            name: 'monthly-report',
            host: '',
            database: '/data/monthly-report.accdb',
            user: '',
            password: undefined,
            dbType: 'access',
        });
        expect(setActiveConnection).toHaveBeenCalledWith('monthly-report');
        expect(clearConnectionMetadata).toHaveBeenCalledWith('monthly-report');
        expect(clearConnectionError).toHaveBeenCalledWith('monthly-report');
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('preserves an existing password after confirming an overwrite', async () => {
        const getConnection = jest.fn().mockResolvedValue({
            name: 'monthly-report',
            host: '',
            database: '/old/monthly-report.accdb',
            user: '',
            password: 'existing-secret',
            dbType: 'access',
        });
        const saveConnection = jest.fn().mockResolvedValue(undefined);
        const setActiveConnection = jest.fn().mockResolvedValue(undefined);
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Overwrite');

        registerSaveAccessFileAsConnectionCommand({
            connectionManager: { getConnection, saveConnection, setActiveConnection },
            metadataCache: { clearConnectionMetadata: jest.fn() },
            schemaProvider: { clearConnectionError: jest.fn(), refresh: jest.fn() },
        });

        const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls[0][1] as
            (uri?: vscode.Uri) => Promise<void>;
        await handler(vscode.Uri.file('/data/monthly-report.accdb'));

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            "A connection named 'monthly-report' already exists. Overwrite it?",
            { modal: true },
            'Overwrite',
        );
        expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({
            database: '/data/monthly-report.accdb',
            password: 'existing-secret',
            dbType: 'access',
        }));
    });

    it('does not save when overwrite is cancelled', async () => {
        const saveConnection = jest.fn();
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

        registerSaveAccessFileAsConnectionCommand({
            connectionManager: {
                getConnection: jest.fn().mockResolvedValue({ name: 'sample', password: 'secret' }),
                saveConnection,
                setActiveConnection: jest.fn(),
            },
            metadataCache: { clearConnectionMetadata: jest.fn() },
            schemaProvider: { clearConnectionError: jest.fn(), refresh: jest.fn() },
        });

        const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls[0][1] as
            (uri?: vscode.Uri) => Promise<void>;
        await handler(vscode.Uri.file('/data/sample.mdb'));

        expect(saveConnection).not.toHaveBeenCalled();
    });
});
