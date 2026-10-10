jest.unmock('chevrotain');

import * as vscode from 'vscode';
import { SqlExecutionCodeActionProvider } from '../providers/sqlExecutionCodeActions';
import {
    applyHubTextEdit,
    buildAddToGroupByEdit,
    buildPreviewSql,
    findHubStatement,
    getHubStatementSupport,
} from '../providers/sqlActionHubUtils';

jest.mock('vscode', () => {
    class Position {
        constructor(public line: number, public character: number) {}
    }

    class Range {
        constructor(public start: Position, public end: Position) {}

        get isEmpty(): boolean {
            return (
                this.start.line === this.end.line && this.start.character === this.end.character
            );
        }
    }

    class Selection extends Range {
        public anchor: Position;
        public active: Position;

        constructor(anchor: Position, active: Position) {
            super(anchor, active);
            this.anchor = anchor;
            this.active = active;
        }
    }

    class WorkspaceEdit {
        public insert = jest.fn();
        public replace = jest.fn();
        public delete = jest.fn();
    }

    class CodeActionKindValue {
        constructor(public value: string) {}

        contains(other: CodeActionKindValue): boolean {
            return other.value === this.value || other.value.startsWith(`${this.value}.`);
        }
    }

    class CodeAction {
        public command?: { command: string; title: string; arguments?: unknown[] };
        public edit?: WorkspaceEdit;
        public diagnostics?: unknown[];

        constructor(public title: string, public kind?: CodeActionKindValue) {}
    }

    return {
        Position,
        Range,
        Selection,
        WorkspaceEdit,
        CodeAction,
        CodeActionKind: {
            Empty: new CodeActionKindValue(''),
            QuickFix: new CodeActionKindValue('quickfix'),
            Refactor: new CodeActionKindValue('refactor'),
        },
        Uri: {
            parse: (value: string) => ({ toString: () => value }),
        },
        window: {
            activeTextEditor: undefined,
            showWarningMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            showInformationMessage: jest.fn(),
        },
        workspace: {
            openTextDocument: jest.fn(),
            getConfiguration: jest.fn(() => ({
                get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
            })),
        },
        commands: {
            registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
            executeCommand: jest.fn(),
        },
    };
});

jest.mock('../compatibility/configuration', () => ({
    getExtensionConfiguration: jest.fn(() => ({
        get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    })),
}));

interface TestCodeAction {
    title: string;
    command?: { command: string; title: string; arguments?: unknown[] };
    edit?: { insert: jest.Mock; replace: jest.Mock; delete: jest.Mock };
}

function createMockDocument(text: string): vscode.TextDocument {
    const lineStarts = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === '\n') {
            lineStarts.push(index + 1);
        }
    }

    return {
        uri: { toString: () => 'file:///hub.sql' } as vscode.Uri,
        languageId: 'sql',
        version: 1,
        lineCount: lineStarts.length,
        getText: jest.fn(() => text),
        offsetAt: jest.fn((position: vscode.Position) => {
            const lineStart = lineStarts[position.line] ?? 0;
            return lineStart + position.character;
        }),
        positionAt: jest.fn((offset: number) => {
            let line = 0;
            for (let index = 0; index < lineStarts.length; index += 1) {
                const currentStart = lineStarts[index];
                const nextStart = lineStarts[index + 1] ?? text.length + 1;
                if (offset >= currentStart && offset < nextStart) {
                    line = index;
                    break;
                }
            }
            return new vscode.Position(line, offset - (lineStarts[line] ?? 0));
        }),
    } as unknown as vscode.TextDocument;
}

function cursorAt(text: string, snippet: string, occurrence = 0): vscode.Range {
    let from = -1;
    let start = -1;
    for (let index = 0; index <= occurrence; index += 1) {
        start = text.indexOf(snippet, from + 1);
        from = start;
    }
    if (start < 0) {
        throw new Error(`Snippet '${snippet}' not found in test SQL`);
    }
    const position = new vscode.Position(0, start + 1);
    return new vscode.Range(position, position);
}

function emptyRangeAt(offset: number): vscode.Range {
    const position = new vscode.Position(0, offset);
    return new vscode.Range(position, position);
}

function fullRange(text: string): vscode.Selection {
    return new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, text.length));
}

const emptyContext = { diagnostics: [], only: undefined } as unknown as vscode.CodeActionContext;
const cancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
} as unknown as vscode.CancellationToken;

function commandsOf(actions: TestCodeAction[]): string[] {
    return actions.map((action) => action.command?.command ?? '(edit)');
}

function createConnectionManager(kind: string) {
    return {
        getActiveConnectionName: jest.fn(() => 'dev'),
        getConnectionForExecution: jest.fn(() => 'dev'),
        getDocumentDatabase: jest.fn(() => 'DEVDB'),
        getExecutionDatabaseKind: jest.fn(() => kind),
        getConnectionDatabaseKind: jest.fn(() => kind),
        supportsCapability: jest.fn(() => true),
    };
}

describe('sqlActionHubUtils', () => {
    it('gates statement support like the per-statement CodeLens', () => {
        expect(getHubStatementSupport('SELECT * FROM T')).toEqual({
            canRun: true,
            canExplain: true,
            canExport: true,
            canVisualize: true,
        });
        expect(getHubStatementSupport('SET CURRENT SCHEMA X').canRun).toBe(true);
        expect(getHubStatementSupport('FOOBAR ???')).toEqual({
            canRun: false,
            canExplain: false,
            canExport: false,
            canVisualize: false,
        });
    });

    it('finds the statement at the cursor', () => {
        const text = 'SELECT 1;\nSELECT 2';
        const statement = findHubStatement(text, text.indexOf('SELECT 2') + 2);
        expect(statement?.sql).toContain('SELECT 2');
        expect(findHubStatement('   ', 1)).toBeUndefined();
    });

    it('builds dialect-aware preview SQL for SELECT/WITH only', () => {
        expect(buildPreviewSql('SELECT * FROM T;', 100, 'netezza')).toBe(
            'SELECT * FROM (\nSELECT * FROM T\n) AS justybase_preview LIMIT 100',
        );
        expect(buildPreviewSql('SELECT * FROM T', 1000, 'mssql')).toContain('TOP (1000)');
        expect(buildPreviewSql('SELECT * FROM T', 10000, 'oracle')).toContain('FETCH FIRST 10000 ROWS ONLY');
        expect(buildPreviewSql('COMMIT;', 100, 'netezza')).toBeUndefined();
    });

    it('appends to an existing GROUP BY list', () => {
        const sql = 'SELECT ID, NAME FROM T GROUP BY ID';
        const statement = findHubStatement(sql, 8);
        expect(statement).toBeDefined();
        const edit = buildAddToGroupByEdit(sql, statement!, 'NAME');
        expect(edit).toEqual({ insertOffset: sql.length, insertText: ', NAME' });
        expect(applyHubTextEdit(sql, edit!)).toBe('SELECT ID, NAME FROM T GROUP BY ID, NAME');
    });

    it('inserts GROUP BY before ORDER BY when missing', () => {
        const sql = 'SELECT ID FROM T ORDER BY ID';
        const edit = buildAddToGroupByEdit(sql, findHubStatement(sql, 8)!, 'ID');
        expect(applyHubTextEdit(sql, edit!)).toBe('SELECT ID FROM T GROUP BY ID ORDER BY ID');
    });

    it('skips GROUP BY when the column is already grouped', () => {
        const sql = 'SELECT ID FROM T GROUP BY ID';
        expect(buildAddToGroupByEdit(sql, findHubStatement(sql, 8)!, 'ID')).toBeUndefined();
    });
});

describe('SqlExecutionCodeActionProvider hub', () => {
    it('offers statement actions without duplicating selection actions', () => {
        const text = 'SELECT * FROM CUSTOMER';
        const provider = new SqlExecutionCodeActionProvider();
        const actions = provider.provideCodeActions(
            createMockDocument(text),
            emptyRangeAt(0),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];

        const commands = commandsOf(actions);
        expect(commands).toContain('netezza.runStatementFromLens');
        expect(actions.filter((action) => action.title.startsWith('Run Preview:'))).toHaveLength(3);
        expect(commands).toContain('netezza.explainStatementFromLens');
        expect(commands).toContain('netezza.visualizeQueryFlow');
        expect(commands).toContain('netezza.formatSQL');
        expect(commands).toContain('netezza.exportStatementFromLens');

        const run = actions.find((action) => action.title === 'Run Statement');
        expect(run?.command?.arguments?.[1]).toBe(text);
        const format = actions.find((action) => action.title === 'Format Statement');
        expect(format?.command?.arguments?.[0]).toEqual({ startOffset: 0, endOffset: text.length });
    });

    it('skips statement Run/Preview/Export when a selection is active', () => {
        const text = 'SELECT * FROM CUSTOMER';
        const provider = new SqlExecutionCodeActionProvider();
        const actions = provider.provideCodeActions(
            createMockDocument(text),
            fullRange(text),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];

        const titles = actions.map((action) => action.title);
        expect(titles).toContain('Run Query');
        expect(titles).not.toContain('Run Statement');
        expect(titles.find((title) => title.startsWith('Run Preview:'))).toBeUndefined();
        expect(titles).not.toContain('Export Statement');
        expect(titles).toContain('Explain Statement');
        expect(titles).toContain('Visualize Query Flow');
        expect(titles).toContain('Format Statement');
    });

    it('returns no actions for unrunnable statements', () => {
        const provider = new SqlExecutionCodeActionProvider();
        const actions = provider.provideCodeActions(
            createMockDocument('FOOBAR ???'),
            emptyRangeAt(0),
            emptyContext,
            cancellationToken,
        );
        expect(actions).toEqual([]);
    });

    it('respects context.only filters', () => {
        const provider = new SqlExecutionCodeActionProvider();
        const actions = provider.provideCodeActions(
            createMockDocument('SELECT 1'),
            emptyRangeAt(0),
            { diagnostics: [], only: vscode.CodeActionKind.Refactor } as unknown as vscode.CodeActionContext,
            cancellationToken,
        );
        expect(actions).toEqual([]);
    });

    it('hides Explain when the dialect does not support it', () => {
        const text = 'SELECT * FROM T';
        const manager = createConnectionManager('netezza');
        manager.supportsCapability.mockReturnValue(false);
        const provider = new SqlExecutionCodeActionProvider({ connectionManager: manager });
        const actions = provider.provideCodeActions(
            createMockDocument(text),
            emptyRangeAt(0),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];
        expect(commandsOf(actions)).not.toContain('netezza.explainStatementFromLens');
        expect(commandsOf(actions)).toContain('netezza.runStatementFromLens');
    });

    it('offers table actions for a resolvable Netezza object', () => {
        const text = 'SELECT * FROM DEVDB.PUBLIC.CUSTOMER';
        const provider = new SqlExecutionCodeActionProvider({
            connectionManager: createConnectionManager('netezza'),
        });
        const actions = provider.provideCodeActions(
            createMockDocument(text),
            cursorAt(text, 'CUSTOMER'),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];
        const commands = commandsOf(actions);

        expect(commands).toContain('netezza.goToCatalogDdl');
        expect(commands).toContain('netezza.revealInSchema');
        expect(commands).toContain('netezza.copySelectAll');
        expect(commands).toContain('netezza.showDependencies');
        expect(commands).toContain('netezza.showUsedBy');
        expect(commands).toContain('netezza.impactAnalysis');
        expect(commands).toContain('netezza.refreshSchemaSelection');

        const reveal = actions.find((action) => action.command?.command === 'netezza.revealInSchema');
        expect(reveal?.command?.arguments?.[0]).toEqual({
            name: 'CUSTOMER',
            objType: 'TABLE',
            database: 'DEVDB',
            schema: 'PUBLIC',
            connectionName: 'dev',
        });
        const top = actions.find((action) => action.command?.command === 'netezza.copySelectAll');
        expect(top?.command?.arguments?.[1]).toEqual({ limit: 100 });
        const refresh = actions.find((action) => action.command?.command === 'netezza.refreshSchemaSelection');
        expect(refresh?.command?.arguments?.[0]).toMatchObject({ contextValue: 'netezza:table' });
    });

    it('omits object refresh when the reference has no schema', () => {
        const text = 'SELECT * FROM PUBLIC.CUSTOMER';
        const provider = new SqlExecutionCodeActionProvider({
            connectionManager: createConnectionManager('netezza'),
        });
        const actions = provider.provideCodeActions(
            createMockDocument(text),
            cursorAt(text, 'CUSTOMER'),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];
        const commands = commandsOf(actions);
        expect(commands).toContain('netezza.goToCatalogDdl');
        expect(commands).toContain('netezza.copySelectAll');
        expect(commands).not.toContain('netezza.refreshSchemaSelection');
    });

    it('omits dependency actions for non-Netezza dialects', () => {
        const text = 'SELECT * FROM PUBLIC.CUSTOMER';
        const provider = new SqlExecutionCodeActionProvider({
            connectionManager: createConnectionManager('sqlite'),
        });
        const actions = provider.provideCodeActions(
            createMockDocument(text),
            cursorAt(text, 'CUSTOMER'),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];
        const commands = commandsOf(actions);
        expect(commands).toContain('netezza.goToCatalogDdl');
        expect(commands).toContain('netezza.revealInSchema');
        expect(commands).not.toContain('netezza.showDependencies');
        expect(commands).not.toContain('netezza.showUsedBy');
        expect(commands).not.toContain('netezza.impactAnalysis');
    });

    it('offers no table actions for CTE references', () => {
        const text = 'WITH C AS (SELECT 1) SELECT * FROM C';
        const provider = new SqlExecutionCodeActionProvider({
            connectionManager: createConnectionManager('netezza'),
        });
        const actions = provider.provideCodeActions(
            createMockDocument(text),
            cursorAt(text, 'FROM C', 0),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];
        const commands = commandsOf(actions);
        expect(commands).not.toContain('netezza.goToCatalogDdl');
        expect(commands).not.toContain('netezza.revealInSchema');
    });

    it('offers column actions with a safe qualify edit for a single alias', () => {
        const text = 'SELECT ID, NAME FROM CUSTOMER C';
        const provider = new SqlExecutionCodeActionProvider({
            connectionManager: createConnectionManager('netezza'),
        });
        const actions = provider.provideCodeActions(
            createMockDocument(text),
            cursorAt(text, 'ID'),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];
        const titles = actions.map((action) => action.title);

        expect(titles).toContain('Show Column Information for ID');
        expect(titles).toContain('Find References of ID');
        const qualify = actions.find((action) => action.title.startsWith('Qualify with Alias'));
        expect(qualify?.title).toBe('Qualify with Alias (C.ID)');
        expect(qualify?.edit?.insert).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ line: 0, character: 7 }),
            'C.',
        );
        expect(titles).toContain('Add ID to GROUP BY');
    });

    it('skips qualify when the column is already qualified or ambiguous', () => {
        const qualified = 'SELECT C.ID FROM CUSTOMER C';
        const provider = new SqlExecutionCodeActionProvider({
            connectionManager: createConnectionManager('netezza'),
        });
        const qualifiedActions = provider.provideCodeActions(
            createMockDocument(qualified),
            cursorAt(qualified, 'ID'),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];
        expect(qualifiedActions.map((action) => action.title).find((title) => title.startsWith('Qualify'))).toBeUndefined();

        const ambiguous = 'SELECT X.ID FROM A X JOIN B Y ON X.ID = Y.ID';
        const ambiguousActions = provider.provideCodeActions(
            createMockDocument(ambiguous),
            cursorAt(ambiguous, 'X.ID'),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];
        expect(ambiguousActions.map((action) => action.title).find((title) => title.startsWith('Qualify'))).toBeUndefined();
    });

    it('skips large-script column/table resolution but keeps statement actions', () => {
        const padding = '-- pad\n'.repeat(600);
        const text = `SELECT * FROM PUBLIC.CUSTOMER\n${padding}`;
        const provider = new SqlExecutionCodeActionProvider({
            connectionManager: createConnectionManager('netezza'),
        });
        const actions = provider.provideCodeActions(
            createMockDocument(text),
            cursorAt(text, 'CUSTOMER'),
            emptyContext,
            cancellationToken,
        ) as unknown as TestCodeAction[];
        const commands = commandsOf(actions);
        expect(commands).toContain('netezza.runStatementFromLens');
        expect(commands).not.toContain('netezza.goToCatalogDdl');
    });
});
