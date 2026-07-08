/**
 * Unit tests for statusBarManager.ts - keep-connection and active connection status bars
 */

import * as vscode from 'vscode';
import {
    updateKeepConnectionStatusBar,
    createKeepConnectionStatusBar,
    createActiveConnectionStatusBar,
    createActiveDatabaseStatusBar
} from '../services/statusBarManager';
import { ConnectionManager } from '../core/connectionManager';

jest.mock('vscode');

describe('statusBarManager - keep connection & active connection', () => {
    let mockStatusBarItem: vscode.StatusBarItem;
    let mockContext: vscode.ExtensionContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockConnectionManager: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockStatusBarItem = {
            text: '',
            tooltip: undefined,
            backgroundColor: undefined,
            command: undefined,
            show: jest.fn(),
            hide: jest.fn(),
            dispose: jest.fn()
        } as unknown as vscode.StatusBarItem;

        mockContext = {
            subscriptions: []
        } as unknown as vscode.ExtensionContext;

        (vscode.window.createStatusBarItem as jest.Mock).mockReturnValue(mockStatusBarItem);

        mockConnectionManager = {
            getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(true) as jest.Mock,
            hasDocumentKeepConnectionOpen: jest.fn().mockReturnValue(false) as jest.Mock,
            getConnectionForExecution: jest.fn().mockReturnValue('my-connection') as jest.Mock,
            getEffectiveDatabase: jest.fn().mockResolvedValue('MY_DB') as jest.Mock,
            getDocumentDatabase: jest.fn().mockReturnValue(undefined) as jest.Mock
        };

        // Default: active SQL editor
        (vscode.window.activeTextEditor as unknown as { document: { languageId: string; uri: { toString: () => string } } }) = {
            document: {
                languageId: 'sql',
                uri: { toString: () => 'file:///test.sql' }
            }
        };
    });

    describe('updateKeepConnectionStatusBar', () => {
        it('should show "Keep ON" when keep connection is enabled', () => {
            mockConnectionManager.getDocumentKeepConnectionOpen!.mockReturnValue(true);
            mockConnectionManager.hasDocumentKeepConnectionOpen!.mockReturnValue(false);

            updateKeepConnectionStatusBar(
                mockStatusBarItem,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.text).toContain('Keep ON');
            expect(mockStatusBarItem.show).toHaveBeenCalled();
        });

        it('should show "Keep OFF" when keep connection is disabled', () => {
            mockConnectionManager.getDocumentKeepConnectionOpen!.mockReturnValue(false);
            mockConnectionManager.hasDocumentKeepConnectionOpen!.mockReturnValue(false);

            updateKeepConnectionStatusBar(
                mockStatusBarItem,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.text).toContain('Keep OFF');
            expect(mockStatusBarItem.show).toHaveBeenCalled();
        });

        it('should include pin prefix when per-document override is set', () => {
            mockConnectionManager.getDocumentKeepConnectionOpen!.mockReturnValue(true);
            mockConnectionManager.hasDocumentKeepConnectionOpen!.mockReturnValue(true);

            updateKeepConnectionStatusBar(
                mockStatusBarItem,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.text).toContain('📌');
        });

        it('should not include pin prefix when using default setting', () => {
            mockConnectionManager.getDocumentKeepConnectionOpen!.mockReturnValue(false);
            mockConnectionManager.hasDocumentKeepConnectionOpen!.mockReturnValue(false);

            updateKeepConnectionStatusBar(
                mockStatusBarItem,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.text).not.toContain('📌');
        });

        it('should hide when active editor is not SQL', () => {
            (vscode.window.activeTextEditor as unknown as { document: { languageId: string } }) = {
                document: { languageId: 'python' }
            };

            updateKeepConnectionStatusBar(
                mockStatusBarItem,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.hide).toHaveBeenCalled();
        });

        it('should hide when there is no active editor', () => {
            Object.defineProperty(vscode.window, 'activeTextEditor', { value: undefined, configurable: true });

            updateKeepConnectionStatusBar(
                mockStatusBarItem,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.hide).toHaveBeenCalled();
        });

        it('should set tooltip for enabled keep connection', () => {
            mockConnectionManager.getDocumentKeepConnectionOpen!.mockReturnValue(true);

            updateKeepConnectionStatusBar(
                mockStatusBarItem,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.tooltip).toContain('ENABLED');
            expect(mockStatusBarItem.tooltip).toContain('Click to toggle');
        });

        it('should set tooltip for disabled keep connection', () => {
            mockConnectionManager.getDocumentKeepConnectionOpen!.mockReturnValue(false);

            updateKeepConnectionStatusBar(
                mockStatusBarItem,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.tooltip).toContain('DISABLED');
        });
    });

    describe('createKeepConnectionStatusBar', () => {
        it('should create a status bar item and add to subscriptions', () => {
            createKeepConnectionStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
            expect(mockContext.subscriptions).toContain(mockStatusBarItem);
        });

        it('should set the command to toggle keep connection', () => {
            createKeepConnectionStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.command).toBe('netezza.toggleKeepConnectionForTab');
        });
    });

    describe('createActiveConnectionStatusBar', () => {
        it('should create a status bar item for active connection', () => {
            const { statusBarItem } = createActiveConnectionStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
            expect(mockContext.subscriptions).toContain(statusBarItem);
        });

        it('should set command to select connection for tab', () => {
            createActiveConnectionStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.command).toBe('netezza.selectConnectionForTab');
        });

        it('updateFn should show connection name for SQL files', async () => {
            const { updateFn } = createActiveConnectionStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.text).toContain('my-connection');
            expect(mockStatusBarItem.show).toHaveBeenCalled();
        });

        it('updateFn should show "Select Connection" when no connection set', async () => {
            mockConnectionManager.getConnectionForExecution!.mockReturnValue(null);

            const { updateFn } = createActiveConnectionStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.text).toContain('Select Connection');
            expect(mockStatusBarItem.show).toHaveBeenCalled();
        });

        it('updateFn should hide when not a SQL file', async () => {
            (vscode.window.activeTextEditor as unknown as { document: { languageId: string } }) = {
                document: { languageId: 'javascript' }
            };

            const { updateFn } = createActiveConnectionStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.hide).toHaveBeenCalled();
        });

        it('updateFn should hide when no active editor', async () => {
            Object.defineProperty(vscode.window, 'activeTextEditor', { value: undefined, configurable: true });

            const { updateFn } = createActiveConnectionStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.hide).toHaveBeenCalled();
        });
    });

    describe('createActiveDatabaseStatusBar', () => {
        it('should create a status bar item for active database', () => {
            createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
            expect(mockContext.subscriptions).toContain(mockStatusBarItem);
        });

        it('should set command to select database for tab', () => {
            createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            expect(mockStatusBarItem.command).toBe('netezza.selectDatabaseForTab');
        });

        it('updateFn should show database name for SQL files with connection', async () => {
            const { updateFn } = createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.text).toContain('MY_DB');
            expect(mockStatusBarItem.show).toHaveBeenCalled();
        });

        it('updateFn should include pin prefix when database has per-tab override', async () => {
            mockConnectionManager.getDocumentDatabase!.mockReturnValue('OVERRIDE_DB');

            const { updateFn } = createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.text).toContain('📌');
        });

        it('updateFn should not include pin prefix when using connection default', async () => {
            mockConnectionManager.getDocumentDatabase!.mockReturnValue(undefined);

            const { updateFn } = createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.text).not.toContain('📌');
        });

        it('updateFn should show "Select Database" when no database available', async () => {
            mockConnectionManager.getEffectiveDatabase!.mockResolvedValue(null);

            const { updateFn } = createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.text).toContain('Select Database');
        });

        it('updateFn should hide when no connection is set', async () => {
            mockConnectionManager.getConnectionForExecution!.mockReturnValue(null);

            const { updateFn } = createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.hide).toHaveBeenCalled();
        });

        it('updateFn should hide when not a SQL file', async () => {
            (vscode.window.activeTextEditor as unknown as { document: { languageId: string } }) = {
                document: { languageId: 'typescript' }
            };

            const { updateFn } = createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.hide).toHaveBeenCalled();
        });

        it('updateFn should hide when no active editor', async () => {
            Object.defineProperty(vscode.window, 'activeTextEditor', { value: undefined, configurable: true });

            const { updateFn } = createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.hide).toHaveBeenCalled();
        });

        it('updateFn should show database for netezza-sql language files', async () => {
            (vscode.window.activeTextEditor as unknown as { document: { languageId: string; uri: { toString: () => string } } }) = {
                document: {
                    languageId: 'netezza-sql',
                    uri: { toString: () => 'file:///test.sql' }
                }
            };

            const { updateFn } = createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            await updateFn();

            expect(mockStatusBarItem.text).toContain('MY_DB');
            expect(mockStatusBarItem.show).toHaveBeenCalled();
        });

        it('updateFn should ignore stale async completions after active editor changes', async () => {
            let resolveEffectiveDb: ((value: string) => void) | undefined;
            mockConnectionManager.getEffectiveDatabase!.mockImplementation(
                () => new Promise<string>((resolve) => {
                    resolveEffectiveDb = resolve;
                })
            );

            const firstEditor = {
                document: {
                    languageId: 'sql',
                    uri: { toString: () => 'file:///first.sql' }
                }
            };
            const secondEditor = {
                document: {
                    languageId: 'sql',
                    uri: { toString: () => 'file:///second.sql' }
                }
            };

            (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = firstEditor;

            const { updateFn } = createActiveDatabaseStatusBar(
                mockContext,
                mockConnectionManager as unknown as ConnectionManager
            );

            const firstUpdate = updateFn();
            (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = secondEditor;
            resolveEffectiveDb?.('MY_DB');
            await firstUpdate;

            expect(mockStatusBarItem.text).not.toContain('MY_DB');
        });
    });
});
