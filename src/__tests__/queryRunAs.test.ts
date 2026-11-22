/**
 * Unit tests for the Run As one-off execution flow.
 * Verifies scope resolution, profile selection, risk confirmation and the
 * isolation guarantees of the transient run-as session.
 */

import * as vscode from 'vscode';
import type { QueryCommandsDependencies } from '../commands/query/queryCommandTypes';
import {
    confirmRunAsRisk,
    pickRunAsConnection,
    registerRunAsCommands,
    resolveRunAsQueries,
    runQueryAs,
} from '../commands/query/queryRunAs';

jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
        executeCommand: jest.fn(),
    },
    window: {
        activeTextEditor: undefined,
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn().mockResolvedValue(undefined),
        showInformationMessage: jest.fn().mockResolvedValue(undefined),
        showQuickPick: jest.fn(),
        setStatusBarMessage: jest.fn(() => ({ dispose: jest.fn() })),
    },
}));

const runSmartSequentialQuery = jest.fn();
jest.mock('../commands/query/querySmartSequentialRun', () => ({
    runSmartSequentialQuery: (...args: unknown[]) => runSmartSequentialQuery(...args),
}));

jest.mock('../sql/sqlParser', () => ({
    SqlParser: {
        splitStatements: jest.fn((sql: string) => sql.split(';').filter(statement => statement.trim())),
        getStatementAtPosition: jest.fn(),
    },
}));

import { SqlParser } from '../sql/sqlParser';

interface EditorOptions {
    text?: string;
    selectionText?: string;
    languageId?: string;
}

function createEditor({ text = 'SELECT 1', selectionText = '', languageId = 'sql' }: EditorOptions = {}) {
    const document = {
        uri: { toString: () => 'file:///workspace/script.sql' },
        languageId,
        getText: jest.fn((range?: unknown) => (range ? selectionText : text)),
        offsetAt: jest.fn(() => 0),
    };
    return {
        document,
        selection: {
            isEmpty: selectionText.length === 0,
            active: { line: 0, character: 0 },
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
        },
    } as unknown as vscode.TextEditor;
}

function createConnectionManager(overrides: Record<string, unknown> = {}) {
    return {
        getConnections: jest.fn().mockResolvedValue([
            { name: 'APP', host: 'app-host', database: 'APP_DB' },
            { name: 'ADMIN', host: 'admin-host', database: 'ADMIN_DB' },
        ]),
        getConnectionForExecution: jest.fn().mockReturnValue('APP'),
        getActiveConnectionName: jest.fn().mockReturnValue('APP'),
        getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
        getExecutionDatabaseKind: jest.fn().mockReturnValue('netezza'),
        getDocumentDatabase: jest.fn().mockReturnValue('TAB_DB'),
        getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(true),
        getConnection: jest.fn().mockResolvedValue({ name: 'ADMIN', host: 'admin-host', database: 'ADMIN_DB' }),
        setDocumentConnection: jest.fn(),
        ...overrides,
    };
}

function createDeps(connectionManager = createConnectionManager()): QueryCommandsDependencies {
    return {
        context: {} as vscode.ExtensionContext,
        connectionManager: connectionManager as unknown as QueryCommandsDependencies['connectionManager'],
        resultPanelProvider: {
            log: jest.fn(),
            setActiveSource: jest.fn(),
            startExecution: jest.fn(),
            finalizeExecution: jest.fn(),
            registerExecutionSource: jest.fn(),
            markOneOffExecution: jest.fn(),
            beginWorkspaceExecution: jest.fn(),
        } as unknown as QueryCommandsDependencies['resultPanelProvider'],
    };
}

function setActiveEditor(editor: vscode.TextEditor | undefined): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).activeTextEditor = editor;
}

describe('Run As', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setActiveEditor(undefined);
        runSmartSequentialQuery.mockResolvedValue('completed');
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'ADMIN', name: 'ADMIN' });
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ sql: 'SELECT 1', start: 0, end: 8 });
    });

    describe('resolveRunAsQueries', () => {
        it('splits the selection into statements', () => {
            const editor = createEditor({ selectionText: 'SELECT 1; SELECT 2;' });
            expect(resolveRunAsQueries(editor, 'selection', 'netezza')).toEqual(['SELECT 1', ' SELECT 2']);
        });

        it('returns an empty scope when nothing is selected', () => {
            expect(resolveRunAsQueries(createEditor(), 'selection', 'netezza')).toEqual([]);
        });

        it('falls back to the statement under the cursor', () => {
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ sql: 'SELECT * FROM T', start: 0, end: 17 });
            expect(resolveRunAsQueries(createEditor(), 'statement', 'netezza')).toEqual(['SELECT * FROM T']);
        });

        it('keeps a whole-file procedure as one payload', () => {
            const editor = createEditor({
                text: 'CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC BEGIN RETURN 1; END; END_PROC;',
            });
            const queries = resolveRunAsQueries(editor, 'wholeDocument', 'netezza');
            expect(queries).toHaveLength(1);
            expect(queries[0]).toContain('BEGIN_PROC');
        });

        it('splits a whole file of plain statements', () => {
            const editor = createEditor({ text: 'SELECT 1; SELECT 2;' });
            expect(resolveRunAsQueries(editor, 'wholeDocument', 'netezza')).toHaveLength(2);
        });
    });

    describe('pickRunAsConnection', () => {
        it('offers only saved profiles and returns the picked name', async () => {
            const deps = createDeps();
            await expect(pickRunAsConnection(deps, 'file:///workspace/script.sql')).resolves.toBe('ADMIN');
            expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({ name: 'APP' }),
                    expect.objectContaining({ name: 'ADMIN' }),
                ]),
                expect.objectContaining({ title: 'Run As' }),
            );
        });

        it('warns when no profiles exist', async () => {
            const deps = createDeps(createConnectionManager({
                getConnections: jest.fn().mockResolvedValue([]),
            }));
            await expect(pickRunAsConnection(deps, 'file:///a.sql')).resolves.toBeUndefined();
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringContaining('No connections configured'),
            );
        });

        it('returns undefined when the picker is dismissed', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
            await expect(pickRunAsConnection(createDeps(), 'file:///a.sql')).resolves.toBeUndefined();
        });
    });

    describe('confirmRunAsRisk', () => {
        it('skips confirmation for safe SQL', async () => {
            await expect(confirmRunAsRisk(['SELECT 1'], 'ADMIN')).resolves.toBe(true);
            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        });

        it('asks about DELETE without WHERE and honours rejection', async () => {
            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
            await expect(confirmRunAsRisk(['DELETE FROM T'], 'ADMIN')).resolves.toBe(false);
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringContaining('ADMIN'),
                expect.objectContaining({ modal: true }),
                'Run As Anyway',
            );
        });

        it('proceeds when the operator accepts', async () => {
            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Run As Anyway');
            await expect(confirmRunAsRisk(['TRUNCATE TABLE T'], 'ADMIN')).resolves.toBe(true);
        });
    });

    describe('runQueryAs', () => {
        it('does nothing outside a SQL editor', async () => {
            setActiveEditor(createEditor({ languageId: 'plaintext' }));
            await runQueryAs(createDeps(), 'statement');
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringContaining('only in a SQL editor'),
            );
            expect(runSmartSequentialQuery).not.toHaveBeenCalled();
        });

        it('does not execute when the profile picker is dismissed', async () => {
            setActiveEditor(createEditor());
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
            await runQueryAs(createDeps(), 'wholeDocument');
            expect(runSmartSequentialQuery).not.toHaveBeenCalled();
        });

        it('passes the selected profile and scoped SQL without switching the tab', async () => {
            setActiveEditor(createEditor({ text: 'SELECT 1; SELECT 2;' }));
            const deps = createDeps();
            await runQueryAs(deps, 'wholeDocument');

            expect(runSmartSequentialQuery).toHaveBeenCalledWith(
                deps,
                expect.objectContaining({
                    queries: ['SELECT 1', ' SELECT 2'],
                    runAs: { connectionName: 'ADMIN' },
                }),
            );
            expect(deps.connectionManager.setDocumentConnection).not.toHaveBeenCalled();
            expect(deps.connectionManager.getDocumentDatabase).not.toHaveBeenCalled();
        });

        it('reports success in the status bar and offers results', async () => {
            setActiveEditor(createEditor());
            await runQueryAs(createDeps(), 'statement');
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('Run As ADMIN'),
                'Show Results',
            );
            expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
                expect.stringContaining('$(check) Run As ADMIN'),
                expect.any(Number),
            );
        });

        it('keeps a failure visible without claiming success', async () => {
            setActiveEditor(createEditor());
            runSmartSequentialQuery.mockResolvedValue('failed');
            await runQueryAs(createDeps(), 'statement');
            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
            expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
                expect.stringContaining('$(error) Run As ADMIN'),
                expect.any(Number),
            );
        });

        it('reports cancellation', async () => {
            setActiveEditor(createEditor());
            runSmartSequentialQuery.mockResolvedValue('cancelled');
            await runQueryAs(createDeps(), 'statement');
            expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
                expect.stringContaining('cancelled'),
                expect.any(Number),
            );
        });

        it('aborts without executing when risky DML is not confirmed', async () => {
            setActiveEditor(createEditor({ text: 'DELETE FROM T' }));
            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
            await runQueryAs(createDeps(), 'wholeDocument');
            expect(runSmartSequentialQuery).not.toHaveBeenCalled();
        });

        it('warns when the selection is empty for the selection scope', async () => {
            setActiveEditor(createEditor());
            await runQueryAs(createDeps(), 'selection');
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringContaining('select the SQL'),
            );
            expect(runSmartSequentialQuery).not.toHaveBeenCalled();
        });

        it('rejects notebook cells explicitly', async () => {
            const editor = createEditor();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (editor.document.uri as any).scheme = 'vscode-notebook-cell';
            setActiveEditor(editor);
            await runQueryAs(createDeps(), 'statement');
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringContaining('notebook cells'),
            );
            expect(runSmartSequentialQuery).not.toHaveBeenCalled();
        });
    });

    describe('registerRunAsCommands', () => {
        it('registers the three scope commands', () => {
            const disposables = registerRunAsCommands(createDeps());
            expect(disposables).toHaveLength(3);
            expect(vscode.commands.registerCommand).toHaveBeenCalledWith('netezza.runAsSelection', expect.any(Function));
            expect(vscode.commands.registerCommand).toHaveBeenCalledWith('netezza.runAsStatement', expect.any(Function));
            expect(vscode.commands.registerCommand).toHaveBeenCalledWith('netezza.runAsWholeFile', expect.any(Function));
        });
    });
});
