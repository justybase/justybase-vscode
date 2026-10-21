/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for objectNoteCommands.ts (local user notes on schema tree objects).
 */

import * as vscode from 'vscode';
import { registerObjectNoteCommands } from '../commands/schema/objectNoteCommands';
import type { SchemaCommandsDependencies } from '../commands/schema/types';
import { getObjectNotesStore } from '../core/objectNotesStore';

const store = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    all: jest.fn().mockReturnValue([]),
    importFrom: jest.fn().mockResolvedValue(2),
    serialize: jest.fn().mockReturnValue('{}'),
    filePath: '/storage/object-notes.json',
};

jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn((command: string, handler: any) => ({ command, handler, dispose: jest.fn() })),
    },
    window: {
        showInputBox: jest.fn(),
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showOpenDialog: jest.fn(),
    },
    workspace: { fs: { readFile: jest.fn() } },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

jest.mock('../core/objectNotesStore', () => ({
    ...jest.requireActual('../core/objectNotesStore'),
    getObjectNotesStore: jest.fn(),
}));

const table = { contextValue: 'netezza:TABLE', connectionName: 'NZ', dbName: 'SALES', schema: 'ADMIN', objType: 'TABLE', label: 'ORDERS' };
const ref = { connectionName: 'NZ', database: 'SALES', schema: 'ADMIN', objectType: 'TABLE', name: 'ORDERS' };

function handler(command: string): (item?: any) => Promise<void> {
    const registered = registerObjectNoteCommands({} as SchemaCommandsDependencies) as unknown as Array<{ command: string; handler: (item?: any) => Promise<void> }>;
    const found = registered.find(entry => entry.command === command);
    if (!found) throw new Error(`${command} not registered`);
    return found.handler;
}

describe('object note commands', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (getObjectNotesStore as jest.Mock).mockReturnValue(store);
    });

    it('prefills the current note and saves the edited text', async () => {
        store.get.mockReturnValue({ note: 'old' });
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('new text');

        await handler('netezza.editObjectNote')(table);

        expect(vscode.window.showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'old', title: 'Note for ADMIN.ORDERS' }));
        expect(store.set).toHaveBeenCalledWith(ref, 'new text');
    });

    it('removes the note when the text is cleared, and does nothing on cancel', async () => {
        store.get.mockReturnValue({ note: 'old' });
        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('');
        await handler('netezza.editObjectNote')(table);
        expect(store.set).toHaveBeenCalledWith(ref, '');

        store.set.mockClear();
        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);
        await handler('netezza.editObjectNote')(table);
        expect(store.set).not.toHaveBeenCalled();
    });

    it('rejects nodes that are not objects or columns', async () => {
        await handler('netezza.editObjectNote')({ contextValue: 'database', connectionName: 'NZ', dbName: 'SALES', label: 'SALES' });

        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });

    it('imports a chosen notes file into the store', async () => {
        (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/tmp/notes.json' }]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('{"version":1,"notes":{}}'));

        await handler('netezza.importObjectNotes')();

        expect(store.importFrom).toHaveBeenCalledWith('{"version":1,"notes":{}}');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Imported 2'));
    });
});
