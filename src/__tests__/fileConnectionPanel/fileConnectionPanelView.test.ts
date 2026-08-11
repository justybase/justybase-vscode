/**
 * Message handler tests for the File Connection Manager webview panel.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { FileConnectionPanelWebviewToHostMessage } from '../../contracts/webviews/fileConnectionPanelContracts';
import { FileConnectionPanelView } from '../../views/fileConnectionPanelView';

jest.mock('@justybase/spreadsheet-tasks', () => ({
    ReaderFactory: {
        create: () => ({
            open: jest.fn().mockResolvedValue(undefined),
            getSheetNames: () => ['Sheet1', 'Sheet2'],
            close: jest.fn().mockResolvedValue(undefined),
        }),
    },
}));

function createFakePanel() {
    const posted: unknown[] = [];
    let messageHandler: ((message: unknown) => void) | undefined;
    const panel = {
        title: '',
        webview: {
            options: undefined,
            html: '',
            cspSource: 'mock-csp-source',
            asWebviewUri: jest.fn((uri: unknown) => uri),
            onDidReceiveMessage: jest.fn((handler: (message: unknown) => void) => {
                messageHandler = handler;
                return { dispose: jest.fn() };
            }),
            postMessage: jest.fn(async (message: unknown) => {
                posted.push(message);
                return true;
            }),
        },
        onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
        reveal: jest.fn(),
        dispose: jest.fn(),
    };
    return { panel, posted, getHandler: () => messageHandler };
}

interface MockManager {
    getConnections: jest.Mock;
    getConnection: jest.Mock;
    saveConnection: jest.Mock;
    deleteConnection: jest.Mock;
    getConnectionMetadata: jest.Mock;
    setDocumentConnection: jest.Mock;
    refreshFileConnection: jest.Mock;
    onDidChangeConnections: jest.Mock;
}

function createMockManager(initialConnections: Array<Record<string, unknown>> = []) {
    const connections: Array<Record<string, unknown>> = initialConnections.length > 0
        ? initialConnections
        : [
            {
                name: 'Sales Files',
                host: 'local',
                database: '/data/sales.csv',
                user: 'file',
                dbType: 'file',
                options: {},
            },
        ];
    return {
        getConnections: jest.fn(async () => connections.map(connection => ({ ...connection }))),
        getConnection: jest.fn(async (name: string) => {
            const connection = connections.find(entry => entry.name === name);
            return connection ? { ...connection } : undefined;
        }),
        saveConnection: jest.fn(async (details: Record<string, unknown>) => {
            const index = connections.findIndex(entry => entry.name === details.name);
            if (index >= 0) {
                connections[index] = details;
            } else {
                connections.push(details);
            }
        }),
        deleteConnection: jest.fn(async (name: string) => {
            const index = connections.findIndex(entry => entry.name === name);
            if (index >= 0) {
                connections.splice(index, 1);
            }
        }),
        getConnectionMetadata: jest.fn(),
        setDocumentConnection: jest.fn().mockResolvedValue(undefined),
        refreshFileConnection: jest.fn().mockResolvedValue(undefined),
        onDidChangeConnections: jest.fn(() => ({ dispose: jest.fn() })),
    };
}

const mockedWindow = vscode.window as unknown as {
    createWebviewPanel: jest.Mock;
    activeTextEditor: unknown;
    showTextDocument: jest.Mock;
    showWarningMessage: jest.Mock;
    showOpenDialog: jest.Mock;
    showSaveDialog: jest.Mock;
};
const mockedWorkspace = vscode.workspace as unknown as {
    openTextDocument: jest.Mock;
    findFiles: jest.Mock;
    workspaceFolders: unknown;
};
const mockedCommands = vscode.commands as unknown as { executeCommand: jest.Mock };

async function flush(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 25));
}

async function sendMessage(view: FileConnectionPanelView, message: FileConnectionPanelWebviewToHostMessage): Promise<void> {
    await (view as unknown as {
        handleMessage(message: FileConnectionPanelWebviewToHostMessage): Promise<void>;
    }).handleMessage(message);
    await flush();
}

function stateMessage(posted: unknown[]): { type: 'state'; state: { selectedConnectionName: string; files: unknown[]; mode: string; connections: string[] } } {
    const message = posted[posted.length - 1] as { type: 'state'; state: { selectedConnectionName: string; files: unknown[]; mode: string; connections: string[] } };
    expect(message.type).toBe('state');
    return message;
}

function lastNotice(posted: unknown[]): { type: 'notice'; message: string } {
    for (let index = posted.length - 1; index >= 0; index--) {
        const entry = posted[index] as { type?: string };
        if (entry.type === 'notice') {
            return entry as { type: 'notice'; message: string };
        }
    }
    throw new Error('No notice message was posted.');
}

describe('FileConnectionPanelView', () => {
    let manager: MockManager;

    beforeEach(() => {
        jest.clearAllMocks();
        (FileConnectionPanelView as unknown as { currentPanel?: { dispose(): void } }).currentPanel?.dispose();
        manager = createMockManager();
        mockedWindow.createWebviewPanel.mockReturnValue(createFakePanel().panel);
        mockedWindow.activeTextEditor = undefined;
        mockedWindow.showWarningMessage.mockResolvedValue(undefined);
        mockedWindow.showOpenDialog.mockResolvedValue(undefined);
        mockedWindow.showSaveDialog.mockResolvedValue(undefined);
        mockedWorkspace.workspaceFolders = [];
        mockedWorkspace.findFiles.mockResolvedValue([]);
        mockedCommands.executeCommand.mockResolvedValue(undefined);
    });

    function createView(connectionName?: string) {
        const context = {
            extensionUri: vscode.Uri.file('/test'),
        } as unknown as vscode.ExtensionContext;
        return FileConnectionPanelView.createOrShow(context, manager as unknown as never, { connectionName });
    }

    it('posts the initial state with the preselected connection', async () => {
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        createView('Sales Files');
        await flush();

        const state = stateMessage(fake.posted).state;
        expect(state.selectedConnectionName).toBe('Sales Files');
        expect(state.connections).toEqual(['Sales Files']);
        expect(state.files).toEqual([expect.objectContaining({ name: 'sales.csv', format: 'csv' })]);
    });

    it('lists all file connections in the dropdown', async () => {
        manager = createMockManager([
            { name: 'Netezza', host: 'h', database: 'd', user: 'u', dbType: 'netezza' },
            { name: 'Files A', host: 'local', database: '/a.csv', user: 'file', dbType: 'file' },
            { name: 'Files B', host: 'local', database: '/b.tsv', user: 'file', dbType: 'file' },
        ]);
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        createView('Files B');
        await flush();

        const state = stateMessage(fake.posted).state;
        expect(state.connections).toEqual(['Files A', 'Files B']);
        expect(state.selectedConnectionName).toBe('Files B');
    });

    it('switches the selected connection on selectConnection', async () => {
        manager = createMockManager([
            { name: 'Files A', host: 'local', database: '/a.csv', user: 'file', dbType: 'file' },
            { name: 'Files B', host: 'local', database: '/b.tsv', user: 'file', dbType: 'file' },
        ]);
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Files A');
        await flush();

        await sendMessage(view, { type: 'selectConnection', connectionName: 'Files B' });
        const state = stateMessage(fake.posted).state;
        expect(state.selectedConnectionName).toBe('Files B');
        expect(state.files).toEqual([expect.objectContaining({ name: 'b.tsv', format: 'tsv' })]);
    });

    it('adds files through the dialog and converts to a workspace', async () => {
        mockedWindow.showOpenDialog.mockResolvedValue([
            vscode.Uri.file('/data/sales.xlsx'),
            vscode.Uri.file('/data/extra.csv'),
        ]);
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'addFiles', paths: [] });
        expect(manager.saveConnection).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Sales Files',
            database: '/data/sales.csv',
            options: expect.objectContaining({ fileWorkspace: JSON.stringify({ version: 1, files: ['/data/sales.csv', '/data/sales.xlsx', '/data/extra.csv'] }) }),
        }));

        const state = stateMessage(fake.posted).state;
        expect(state.mode).toBe('workspace');
        expect(state.files).toHaveLength(3);
    });

    it('ignores unsupported files when adding', async () => {
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'addFiles', paths: ['/data/notes.txt', '/data/extra.csv'] });
        const saved = manager.saveConnection.mock.calls[0][0] as { options: Record<string, string> };
        expect(JSON.parse(saved.options.fileWorkspace as string)).toEqual({
            version: 1,
            files: ['/data/sales.csv', '/data/extra.csv'],
        });
        const notice = lastNotice(fake.posted);
        expect(notice.type).toBe('notice');
        expect(notice.message).toContain('unsupported');
    });

    it('removes a file from the profile', async () => {
        manager.getConnection.mockResolvedValue({
            name: 'Sales Files',
            host: 'local',
            database: '/data/sales.csv',
            user: 'file',
            dbType: 'file',
            options: { fileWorkspace: JSON.stringify({ version: 1, files: ['/data/sales.csv', '/data/extra.csv'] }) },
        });
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'removeFile', path: '/data/extra.csv' });
        expect(manager.saveConnection).toHaveBeenCalledWith(expect.objectContaining({
            database: '/data/sales.csv',
        }));
        const saved = manager.saveConnection.mock.calls[0][0] as { options: Record<string, unknown> };
        expect(saved.options.fileWorkspace).toBeUndefined();
    });

    it('does not remove the last file from a profile', async () => {
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'removeFile', path: '/data/sales.csv' });

        expect(manager.saveConnection).not.toHaveBeenCalled();
        expect(lastNotice(fake.posted).message).toContain('at least one');
    });

    it('toggles the editable copy in single-file mode', async () => {
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'setEditable', enabled: true });
        expect(manager.saveConnection).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ editable: true }),
        }));
    });

    it('deletes the connection after confirmation and selects the next one', async () => {
        manager = createMockManager([
            { name: 'Files A', host: 'local', database: '/a.csv', user: 'file', dbType: 'file' },
            { name: 'Files B', host: 'local', database: '/b.tsv', user: 'file', dbType: 'file' },
        ]);
        mockedWindow.showWarningMessage.mockResolvedValue('Delete');
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Files A');
        await flush();

        await sendMessage(view, { type: 'deleteConnection' });
        expect(manager.deleteConnection).toHaveBeenCalledWith('Files A');
        const state = stateMessage(fake.posted).state;
        expect(state.selectedConnectionName).toBe('Files B');
    });

    it('previews a file through the existing preview command', async () => {
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'previewFile', path: '/data/sales.csv' });
        expect(mockedCommands.executeCommand).toHaveBeenCalledWith(
            'netezza.openInFilePreview',
            expect.objectContaining({ fsPath: '/data/sales.csv' }),
        );
    });

    it('binds the opened SQL editor to the selected file connection', async () => {
        const sqlUri = vscode.Uri.file('/tmp/untitled-query.sql');
        mockedWorkspace.openTextDocument.mockResolvedValue({ uri: sqlUri, languageId: 'sql' });
        mockedWindow.showTextDocument.mockResolvedValue({ document: { uri: sqlUri } });
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'queryFile', path: '/data/sales.csv' });
        expect(mockedWindow.showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ uri: sqlUri }),
            expect.objectContaining({ preview: false }),
        );
        expect(manager.setDocumentConnection).toHaveBeenCalledWith(
            sqlUri.toString(),
            'Sales Files',
        );
    });

    it('starts a workspace query from the file whose SQL action was clicked', async () => {
        const workspaceFiles = ['/data/first.csv', '/data/second.csv'];
        manager = createMockManager([{
            name: 'Sales Files',
            host: 'local',
            database: workspaceFiles[0],
            user: 'file',
            dbType: 'file',
            options: { fileWorkspace: JSON.stringify({ version: 1, files: workspaceFiles }) },
        }]);
        const sqlUri = vscode.Uri.file('/tmp/workspace-query.sql');
        const document = { uri: sqlUri, languageId: 'sql' };
        mockedWorkspace.openTextDocument.mockResolvedValue(document);
        mockedWindow.showTextDocument.mockResolvedValue({ document });
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'queryFile', path: workspaceFiles[1] });

        expect(mockedWorkspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining(`SELECT * FROM "${workspaceFiles[1]}" LIMIT 100;`),
        }));
    });

    it('returns xlsx sheet names', async () => {
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'requestSheets', path: '/data/book.xlsx' });
        const message = fake.posted[fake.posted.length - 1] as { type: 'sheets'; sheetNames: string[] };
        expect(message.type).toBe('sheets');
        expect(message.sheetNames).toEqual(['Sheet1', 'Sheet2']);
    });

    it('exports the selected connection profile as JSON', async () => {
        const exportTarget = path.join(os.tmpdir(), 'exported-connections.json');
        mockedWindow.showSaveDialog.mockResolvedValue(vscode.Uri.file(exportTarget));
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'exportConnections' });
        const written = JSON.parse(fs.readFileSync(exportTarget, 'utf8')) as { format: string; connections: Array<{ name: string; files: string[] }> };
        expect(written.format).toBe('justybase.file-connections');
        expect(written.connections).toEqual([{ name: 'Sales Files', files: ['/data/sales.csv'] }]);
        fs.unlinkSync(exportTarget);
    });

    it('imports connections from a JSON file', async () => {
        const importSource = path.join(os.tmpdir(), 'imported-connections.json');
        fs.writeFileSync(importSource, JSON.stringify({
            format: 'justybase.file-connections',
            version: 1,
            connections: [{ name: 'Imported', files: ['/data/imported.csv'] }],
        }));
        mockedWindow.showOpenDialog.mockResolvedValue([vscode.Uri.file(importSource)]);
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'importConnections' });
        expect(manager.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ name: 'Imported' }));
        const notice = lastNotice(fake.posted);
        expect(notice.type).toBe('notice');
        expect(notice.message).toContain('Imported');
        fs.unlinkSync(importSource);
    });

    it('resolves dropped names within the workspace folder', async () => {
        mockedWorkspace.findFiles.mockResolvedValue([vscode.Uri.file('/workspace/data/extra.csv')]);
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'resolveDroppedNames', names: ['extra.csv'] });
        expect(manager.saveConnection).toHaveBeenCalledWith(expect.objectContaining({
            database: '/data/sales.csv',
        }));
        const saved = manager.saveConnection.mock.calls[0][0] as { options: Record<string, string> };
        expect(JSON.parse(saved.options.fileWorkspace as string)).toEqual({
            version: 1,
            files: ['/data/sales.csv', '/workspace/data/extra.csv'],
        });
    });

    it('preserves an external file URI from a drop', async () => {
        const externalPath = path.join(os.tmpdir(), `file-connection-drop-${Date.now()}.csv`);
        fs.writeFileSync(externalPath, 'id\n1\n');
        try {
            const fake = createFakePanel();
            mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
            const view = createView('Sales Files');
            await flush();

            await sendMessage(view, { type: 'resolveDroppedNames', names: [vscode.Uri.file(externalPath).toString()] });

            const saved = manager.saveConnection.mock.calls[0][0] as { options: Record<string, string> };
            expect(JSON.parse(saved.options.fileWorkspace as string).files).toContain(path.resolve(externalPath).split(path.sep).join('/'));
            expect(mockedWorkspace.findFiles).not.toHaveBeenCalled();
        } finally {
            fs.unlinkSync(externalPath);
        }
    });

    it('reports unresolved dropped names', async () => {
        mockedWorkspace.findFiles.mockResolvedValue([]);
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Sales Files');
        await flush();

        await sendMessage(view, { type: 'resolveDroppedNames', names: ['missing.csv'] });
        expect(manager.saveConnection).not.toHaveBeenCalled();
        const notice = lastNotice(fake.posted);
        expect(notice.type).toBe('notice');
        expect(notice.message).toContain('missing.csv');
    });
});
