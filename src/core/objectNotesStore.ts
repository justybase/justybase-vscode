/**
 * Local user notes attached to database objects and columns.
 *
 * Notes live in `object-notes.json` under the extension's global storage, never
 * in the workspace or the database. Writes are atomic (temp file + rename) so a
 * crash cannot leave a half-written file behind.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const OBJECT_NOTES_FILE_NAME = 'object-notes.json';
const OBJECT_NOTES_VERSION = 1;

/** Identifies the object (or one of its columns) that a note belongs to. */
export interface ObjectNoteRef {
    connectionName: string;
    database: string;
    schema?: string;
    objectType: string;
    name: string;
    column?: string;
}

export interface ObjectNote {
    ref: ObjectNoteRef;
    note: string;
    updatedAt: number;
}

interface ObjectNotesFile {
    version: number;
    notes: Record<string, ObjectNote>;
}

export function objectNoteKey(ref: ObjectNoteRef): string {
    const parts = [ref.connectionName, ref.database, ref.schema ?? '', ref.objectType, ref.name];
    if (ref.column) {
        parts.push(ref.column);
    }
    return parts.join('|');
}

/** Rebuilds the reference of a key written before the file stored `ref` (version 0). */
function refFromKey(key: string): ObjectNoteRef | undefined {
    const parts = key.split('|');
    if (parts.length < 5 || parts.length > 6) {
        return undefined;
    }
    const [connectionName, database, schema, objectType, name, column] = parts;
    return { connectionName, database, schema: schema || undefined, objectType, name, column };
}

function isRef(value: unknown): value is ObjectNoteRef {
    const ref = value as ObjectNoteRef | undefined;
    return !!ref
        && typeof ref.connectionName === 'string'
        && typeof ref.database === 'string'
        && typeof ref.objectType === 'string'
        && typeof ref.name === 'string';
}

/**
 * Accepts the current format and the version-0 format (a plain `key -> text` map).
 * Entries that cannot be read are dropped; the rest are re-keyed from their reference.
 */
export function parseObjectNotesFile(content: string): Map<string, ObjectNote> {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Object notes file must contain a JSON object.');
    }
    const record = parsed as Partial<ObjectNotesFile> & Record<string, unknown>;
    const notes = new Map<string, ObjectNote>();

    if (typeof record.version !== 'number') {
        for (const [key, value] of Object.entries(record)) {
            const ref = refFromKey(key);
            if (ref && typeof value === 'string' && value.trim()) {
                notes.set(objectNoteKey(ref), { ref, note: value.trim(), updatedAt: 0 });
            }
        }
        return notes;
    }

    for (const entry of Object.values(record.notes ?? {})) {
        if (isRef(entry?.ref) && typeof entry.note === 'string' && entry.note.trim()) {
            notes.set(objectNoteKey(entry.ref), {
                ref: entry.ref,
                note: entry.note.trim(),
                updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
            });
        }
    }
    return notes;
}

export function serializeObjectNotes(notes: Iterable<ObjectNote>): string {
    const file: ObjectNotesFile = { version: OBJECT_NOTES_VERSION, notes: {} };
    for (const note of notes) {
        file.notes[objectNoteKey(note.ref)] = note;
    }
    return `${JSON.stringify(file, null, 2)}\n`;
}

const sameName = (left: string | undefined, right: string | undefined): boolean =>
    (left ?? '').toUpperCase() === (right ?? '').toUpperCase();

/** The schema tree fields that identify an object or column. */
export interface ObjectNoteTreeItem {
    label?: string;
    rawLabel?: string;
    dbName?: string;
    schema?: string;
    objType?: string;
    connectionName?: string;
    contextValue?: string;
    parentName?: string;
}

const OBJECT_CONTEXT = /^(netezza|favoritesObject):/;

/** The note reference of a schema tree object or column, or undefined for other nodes. */
export function objectNoteRefForItem(item: ObjectNoteTreeItem | undefined): ObjectNoteRef | undefined {
    if (!item?.connectionName || !item.dbName || !item.objType) {
        return undefined;
    }
    const name = item.rawLabel || item.label;
    if (!name) {
        return undefined;
    }
    if (item.contextValue === 'column') {
        return item.parentName
            ? { connectionName: item.connectionName, database: item.dbName, schema: item.schema, objectType: item.objType, name: item.parentName, column: name }
            : undefined;
    }
    if (item.contextValue && OBJECT_CONTEXT.test(item.contextValue)) {
        return { connectionName: item.connectionName, database: item.dbName, schema: item.schema, objectType: item.objType, name };
    }
    return undefined;
}

export class ObjectNotesStore implements vscode.Disposable {
    private notes = new Map<string, ObjectNote>();
    private writeChain: Promise<void> = Promise.resolve();
    /** Pending load; edits wait for it so the file contents cannot replace them. */
    private loading: Promise<void> = Promise.resolve();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(readonly filePath: string, private readonly now: () => number = Date.now) { }

    /**
     * Loads the notes file. A file that cannot be parsed is kept aside as
     * `object-notes.json.corrupt-<time>` so the next save does not destroy it.
     */
    load(): Promise<void> {
        this.loading = this.readFile();
        return this.loading;
    }

    private async readFile(): Promise<void> {
        let content: string;
        try {
            content = await fs.promises.readFile(this.filePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                this.notes = new Map();
                return;
            }
            throw error;
        }
        try {
            this.notes = parseObjectNotesFile(content);
        } catch {
            await fs.promises.rename(this.filePath, `${this.filePath}.corrupt-${this.now()}`).catch(() => undefined);
            this.notes = new Map();
        }
        this._onDidChange.fire();
    }

    get(ref: ObjectNoteRef): ObjectNote | undefined {
        return this.notes.get(objectNoteKey(ref));
    }

    all(): ObjectNote[] {
        return [...this.notes.values()];
    }

    /** Notes for one object and its columns on any connection, matched case-insensitively. */
    findForObject(database: string, schema: string | undefined, name: string): ObjectNote[] {
        return this.all().filter(({ ref }) =>
            sameName(ref.database, database)
            && (schema === undefined || sameName(ref.schema, schema))
            && sameName(ref.name, name));
    }

    /** Stores the note; an empty text removes it. */
    async set(ref: ObjectNoteRef, note: string): Promise<void> {
        await this.loading.catch(() => undefined);
        const text = note.trim();
        const key = objectNoteKey(ref);
        if (text) {
            this.notes.set(key, { ref, note: text, updatedAt: this.now() });
        } else if (!this.notes.delete(key)) {
            return;
        }
        await this.save();
    }

    async remove(ref: ObjectNoteRef): Promise<void> {
        await this.set(ref, '');
    }

    /** Adds the notes of another file; on the same object the newer note wins. Returns the number taken over. */
    async importFrom(content: string): Promise<number> {
        await this.loading.catch(() => undefined);
        let imported = 0;
        for (const [key, incoming] of parseObjectNotesFile(content)) {
            const existing = this.notes.get(key);
            if (!existing || incoming.updatedAt >= existing.updatedAt) {
                this.notes.set(key, incoming);
                imported++;
            }
        }
        if (imported > 0) {
            await this.save();
        }
        return imported;
    }

    serialize(): string {
        return serializeObjectNotes(this.notes.values());
    }

    private async save(): Promise<void> {
        const content = this.serialize();
        const write = this.writeChain.then(() => this.writeAtomic(content));
        this.writeChain = write.catch(() => undefined);
        this._onDidChange.fire();
        await write;
    }

    private async writeAtomic(content: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.tmp`;
        try {
            await fs.promises.writeFile(tempPath, content, 'utf8');
            await fs.promises.rename(tempPath, this.filePath);
        } catch (error) {
            await fs.promises.unlink(tempPath).catch(() => undefined);
            throw error;
        }
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}

/** Markdown section with the user's local notes, for Copilot tool results. */
export function formatObjectNotesForCopilot(notes: readonly ObjectNote[]): string[] {
    if (notes.length === 0) {
        return [];
    }
    const lines = ['', '### User Notes (local, not stored in the database)', ''];
    const ordered = [...notes].sort((left, right) => (left.ref.column ?? '').localeCompare(right.ref.column ?? ''));
    for (const { ref, note } of ordered) {
        lines.push(`- ${ref.column ? `Column **${ref.column}**` : `**${ref.name}**`}: ${note.replace(/\s*\n\s*/g, ' ')}`);
    }
    return lines;
}

let sharedStore: ObjectNotesStore | undefined;

/**
 * Creates the store used by the schema tree, commands and Copilot tools. The
 * store is usable at once (empty) and fires `onDidChange` when the file is loaded.
 */
export function initializeObjectNotesStore(context: vscode.ExtensionContext): { store: ObjectNotesStore; loaded: Promise<void> } {
    const store = new ObjectNotesStore(path.join(context.globalStorageUri.fsPath, OBJECT_NOTES_FILE_NAME));
    sharedStore = store;
    context.subscriptions.push(store);
    return { store, loaded: store.load() };
}

export function getObjectNotesStore(): ObjectNotesStore | undefined {
    return sharedStore;
}
