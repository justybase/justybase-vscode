/**
 * Schema Commands - Local user notes on database objects
 * Commands: editObjectNote, openObjectNotesFile, exportObjectNotes, importObjectNotes
 *
 * Notes are stored by `ObjectNotesStore` in the extension's global storage;
 * they are never written to the database.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { getObjectNotesStore, objectNoteRefForItem, type ObjectNoteRef, type ObjectNotesStore } from '../../core/objectNotesStore';
import { SchemaCommandsDependencies, SchemaItemData } from './types';

const describeRef = (ref: ObjectNoteRef): string =>
    [ref.schema, ref.name, ref.column].filter(Boolean).join('.');

function requireStore(): ObjectNotesStore | undefined {
    const store = getObjectNotesStore();
    if (!store) {
        vscode.window.showErrorMessage('Object notes are not available yet. Try again after the extension has started.');
    }
    return store;
}

/**
 * Register object note commands
 */
export function registerObjectNoteCommands(_deps: SchemaCommandsDependencies): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.editObjectNote', async (item: SchemaItemData) => {
            const ref = objectNoteRefForItem(item);
            if (!ref) {
                vscode.window.showErrorMessage('Right-click a database object or column to add a note.');
                return;
            }
            const store = requireStore();
            if (!store) return;
            const current = store.get(ref)?.note ?? '';
            const note = await vscode.window.showInputBox({
                title: `Note for ${describeRef(ref)}`,
                prompt: 'Stored only on this computer. Leave empty to remove the note.',
                value: current,
                placeHolder: 'e.g. Loaded nightly by the ETL job; do not truncate',
            });
            if (note === undefined || note.trim() === current) {
                return;
            }
            await store.set(ref, note);
        }),

        vscode.commands.registerCommand('netezza.openObjectNotesFile', async () => {
            const store = requireStore();
            if (!store) return;
            if (!fs.existsSync(store.filePath)) {
                vscode.window.showInformationMessage('No object notes yet. Right-click an object and choose "Edit Note…".');
                return;
            }
            await vscode.window.showTextDocument(vscode.Uri.file(store.filePath), { preview: false });
        }),

        vscode.commands.registerCommand('netezza.exportObjectNotes', async () => {
            const store = requireStore();
            if (!store) return;
            if (store.all().length === 0) {
                vscode.window.showInformationMessage('There are no object notes to export.');
                return;
            }
            const target = await vscode.window.showSaveDialog({
                title: 'Export Object Notes',
                defaultUri: vscode.Uri.file('object-notes.json'),
                filters: { JSON: ['json'] },
            });
            if (!target) return;
            await vscode.workspace.fs.writeFile(target, Buffer.from(store.serialize(), 'utf8'));
            vscode.window.showInformationMessage(`Exported ${store.all().length} object note(s).`);
        }),

        vscode.commands.registerCommand('netezza.importObjectNotes', async () => {
            const store = requireStore();
            if (!store) return;
            const [source] = await vscode.window.showOpenDialog({
                title: 'Import Object Notes',
                canSelectMany: false,
                filters: { JSON: ['json'] },
            }) ?? [];
            if (!source) return;
            try {
                const content = Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8');
                const imported = await store.importFrom(content);
                vscode.window.showInformationMessage(`Imported ${imported} object note(s); newer local notes were kept.`);
            } catch (error) {
                vscode.window.showErrorMessage(`Could not import object notes: ${error instanceof Error ? error.message : String(error)}`);
            }
        }),
    ];
}
