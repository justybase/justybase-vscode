/**
 * Unit tests for the connection capsule (services/connectionCapsule.ts).
 */

import * as vscode from 'vscode';
import {
    SHOW_CONNECTION_CAPSULE_COMMAND,
    collectConnectionCapsuleSnapshot,
    createConnectionCapsule,
    getCapsuleHeaderInfo,
    renderConnectionCapsule,
    updateConnectionCapsule,
    type ConnectionCapsuleSnapshot,
} from '../services/connectionCapsule';
import { ConnectionManager } from '../core/connectionManager';

jest.mock('vscode');

function setActiveEditor(languageId: string, uri: string): void {
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
        document: {
            languageId,
            uri: { toString: () => uri },
        },
    };
}

function createManagerMock(overrides: Record<string, unknown> = {}): ConnectionManager {
    return {
        getConnectionForExecution: jest.fn().mockReturnValue('NZ'),
        getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(true),
        getEffectiveDatabase: jest.fn().mockResolvedValue('JUST_DATA'),
        getEffectiveSchemaSync: jest.fn().mockReturnValue('ADMIN'),
        getDocumentConnection: jest.fn().mockReturnValue(undefined),
        isConnectionAvailable: jest.fn().mockReturnValue(true),
        getDocumentDatabase: jest.fn().mockReturnValue(undefined),
        getConnectionMetadata: jest.fn().mockReturnValue({
            name: 'NZ',
            host: '192.168.0.144',
            port: 5480,
            database: 'JUST_DATA',
            user: 'admin',
        }),
        getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
        hasDocumentPersistentConnection: jest.fn().mockReturnValue(false),
        ...overrides,
    } as unknown as ConnectionManager;
}

const baseSnapshot: ConnectionCapsuleSnapshot = {
    documentUri: 'file:///test.sql',
    connectionName: 'NZ',
    isMissing: false,
    isPinned: false,
    database: 'JUST_DATA',
    schema: 'ADMIN',
    keepOpen: true,
    connected: false,
};

describe('connectionCapsule', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setActiveEditor('sql', 'file:///test.sql');
    });

    describe('renderConnectionCapsule', () => {
        it('renders the capsule text as CONN / DB', () => {
            const presentation = renderConnectionCapsule(baseSnapshot, {
                dbLabel: 'Netezza',
                target: '192.168.0.144:5480/JUST_DATA',
                user: 'admin',
            });

            expect(presentation.text).toBe('$(circle-outline) NZ / JUST_DATA');
            expect(presentation.tooltip).toContain('Netezza');
            expect(presentation.tooltip).toContain('Database: JUST_DATA');
            expect(presentation.tooltip).toContain('Schema: ADMIN');
            expect(presentation.tooltip).toContain('Session: Persistent · Keep ON');
            expect(presentation.tooltip).toContain('Click to open the connection menu');
        });

        it('marks per-tab pins and live sessions', () => {
            const presentation = renderConnectionCapsule(
                { ...baseSnapshot, isPinned: true, connected: true },
                undefined,
            );

            expect(presentation.text).toBe('📌 $(circle-filled) NZ / JUST_DATA');
        });

        it('renders transient sessions', () => {
            const presentation = renderConnectionCapsule({ ...baseSnapshot, keepOpen: false }, undefined);

            expect(presentation.tooltip).toContain('Session: Transient · Keep OFF');
        });

        it('renders a missing tab connection as a warning', () => {
            const presentation = renderConnectionCapsule(
                { ...baseSnapshot, isMissing: true },
                undefined,
            );

            expect(presentation.text).toContain('(missing)');
            expect(presentation.tooltip).toContain('no longer available');
        });

        it('renders no connection as a select prompt', () => {
            const presentation = renderConnectionCapsule(
                {
                    documentUri: 'file:///test.sql',
                    connectionName: undefined,
                    isMissing: false,
                    isPinned: false,
                    database: null,
                    schema: null,
                    keepOpen: true,
                    connected: false,
                },
                undefined,
            );

            expect(presentation.text).toContain('Select connection');
            expect(presentation.tooltip).toContain('No connection');
        });

        it('renders an em dash when schema is unknown', () => {
            const presentation = renderConnectionCapsule({ ...baseSnapshot, schema: null }, undefined);

            expect(presentation.tooltip).toContain('Schema: —');
        });
    });

    describe('getCapsuleHeaderInfo', () => {
        it('formats the dialect label, target and user from cached metadata', () => {
            const info = getCapsuleHeaderInfo(createManagerMock(), 'NZ');

            expect(info).toEqual({
                dbLabel: 'Netezza',
                target: '192.168.0.144:5480/JUST_DATA',
                user: 'admin',
            });
        });

        it('returns undefined when the profile metadata is gone', () => {
            const manager = createManagerMock({
                getConnectionMetadata: jest.fn().mockReturnValue(undefined),
            });

            expect(getCapsuleHeaderInfo(manager, 'NZ')).toBeUndefined();
        });
    });

    describe('collectConnectionCapsuleSnapshot', () => {
        it('collects connection, database, schema, session and liveness', async () => {
            const manager = createManagerMock({
                getDocumentConnection: jest.fn().mockReturnValue('NZ'),
                getDocumentDatabase: jest.fn().mockReturnValue('JUST_DATA'),
                hasDocumentPersistentConnection: jest.fn().mockReturnValue(true),
            });

            const snapshot = await collectConnectionCapsuleSnapshot(manager, 'file:///test.sql');

            expect(snapshot).toEqual({
                documentUri: 'file:///test.sql',
                connectionName: 'NZ',
                isMissing: false,
                isPinned: true,
                database: 'JUST_DATA',
                schema: 'ADMIN',
                keepOpen: true,
                connected: true,
            });
        });

        it('flags a missing tab connection without hiding the capsule', async () => {
            const manager = createManagerMock({
                getDocumentConnection: jest.fn().mockReturnValue('NZ'),
                isConnectionAvailable: jest.fn().mockReturnValue(false),
            });

            const snapshot = await collectConnectionCapsuleSnapshot(manager, 'file:///test.sql');

            expect(snapshot.isMissing).toBe(true);
        });

        it('returns an empty snapshot when no connection is selected', async () => {
            const manager = createManagerMock({
                getConnectionForExecution: jest.fn().mockReturnValue(undefined),
            });

            const snapshot = await collectConnectionCapsuleSnapshot(manager, 'file:///test.sql');

            expect(snapshot.connectionName).toBeUndefined();
            expect(snapshot.database).toBeNull();
            expect(snapshot.connected).toBe(false);
        });
    });

    describe('createConnectionCapsule', () => {
        it('registers a bottom-bar item that previews the connection and opens the menu', () => {
            const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
            const manager = createManagerMock();
            const mockStatusBarItem = {
                text: '',
                tooltip: undefined,
                command: undefined,
                show: jest.fn(),
                hide: jest.fn(),
                dispose: jest.fn(),
            };
            (vscode.window.createStatusBarItem as jest.Mock).mockReturnValue(mockStatusBarItem);

            const { statusBarItem, updateFn } = createConnectionCapsule(context, manager);

            expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
                vscode.StatusBarAlignment.Left,
                100,
            );
            expect(statusBarItem.command).toBe(SHOW_CONNECTION_CAPSULE_COMMAND);
            expect(context.subscriptions).toContain(statusBarItem);
            expect(typeof updateFn).toBe('function');
        });
    });

    describe('updateConnectionCapsule', () => {
        it('previews the current connection on the bottom bar', async () => {
            const statusBarItem = {
                text: '',
                tooltip: undefined,
                show: jest.fn(),
                hide: jest.fn(),
            } as unknown as vscode.StatusBarItem;

            await updateConnectionCapsule(statusBarItem, createManagerMock());

            expect(statusBarItem.text).toBe('$(circle-outline) NZ / JUST_DATA');
            expect(statusBarItem.tooltip).toContain('Database: JUST_DATA');
            expect(statusBarItem.show).toHaveBeenCalled();
        });

        it('hides outside SQL editors', async () => {
            setActiveEditor('python', 'file:///test.py');
            const statusBarItem = {
                text: 'before',
                show: jest.fn(),
                hide: jest.fn(),
            } as unknown as vscode.StatusBarItem;

            await updateConnectionCapsule(statusBarItem, createManagerMock());

            expect(statusBarItem.hide).toHaveBeenCalled();
            expect(statusBarItem.text).toBe('before');
        });

        it('ignores stale async completions after the active editor changes', async () => {
            let resolveEffectiveDb: ((value: string) => void) | undefined;
            const manager = createManagerMock({
                getEffectiveDatabase: jest.fn(
                    () => new Promise<string>((resolve) => {
                        resolveEffectiveDb = resolve;
                    }),
                ),
            });
            const statusBarItem = { text: 'before' } as unknown as vscode.StatusBarItem;

            const update = updateConnectionCapsule(statusBarItem, manager);
            setActiveEditor('sql', 'file:///second.sql');
            resolveEffectiveDb?.('JUST_DATA');
            await update;

            expect(statusBarItem.text).toBe('before');
        });
    });
});
