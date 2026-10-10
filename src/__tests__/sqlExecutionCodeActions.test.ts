import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import * as vscode from 'vscode';
import { SqlExecutionCodeActionProvider } from '../providers/sqlExecutionCodeActions';
import { SELECTION_EXECUTION_COMMANDS } from '../providers/sqlSelectionActionUtils';

const mockConfigGet = jest.fn((_key: string, defaultValue: unknown) => defaultValue);

jest.mock('../compatibility/configuration', () => ({
    getExtensionConfiguration: jest.fn(() => ({
        get: mockConfigGet,
    })),
}));

function createMockCancellationToken(): vscode.CancellationToken {
    return {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
    } as unknown as vscode.CancellationToken;
}

function createDocument(text: string): vscode.TextDocument {
    return {
        languageId: 'sql',
        version: 1,
        lineCount: 1,
        uri: { toString: () => 'file:///test.sql' } as vscode.Uri,
        getText: (range?: vscode.Range) => {
            if (!range) {
                return text;
            }
            return text.substring(range.start.character, range.end.character);
        },
        offsetAt: (position: vscode.Position) => position.character,
        positionAt: (offset: number) => new vscode.Position(0, offset),
    } as unknown as vscode.TextDocument;
}

describe('SqlExecutionCodeActionProvider', () => {
    const provider = new SqlExecutionCodeActionProvider();
    const document = createDocument('SELECT * FROM DIMDATE');
    const selection = new vscode.Selection(
        new vscode.Position(0, 0),
        new vscode.Position(0, document.getText().length),
    );
    const emptyContext = { diagnostics: [], only: undefined } as unknown as vscode.CodeActionContext;

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfigGet.mockImplementation((_key: string, defaultValue: unknown) => defaultValue);
    });

    it('returns Run and Export actions for a non-empty selection', () => {
        const actions = provider.provideCodeActions(
            document,
            selection,
            emptyContext,
            createMockCancellationToken(),
        );

        const titles = actions.map((action) => action.title);
        expect(titles.slice(0, 3)).toEqual(['Run Query', 'Export to file', 'Export as XLSB (Copy to clipboard)']);
        // The action hub adds non-duplicating statement actions alongside
        // the selection actions (no second Run/Preview/Export).
        expect(titles).toContain('Explain Statement');
        expect(titles).toContain('Visualize Query Flow');
        expect(titles).toContain('Format Statement');
        expect(titles).not.toContain('Run Statement');
        expect(titles.find((title) => title.startsWith('Run Preview:'))).toBeUndefined();
        expect(titles).not.toContain('Export Statement');
        expect(actions[0].command?.command).toBe(SELECTION_EXECUTION_COMMANDS.run);
        expect(actions[1].command?.command).toBe(SELECTION_EXECUTION_COMMANDS.exportToFile);
        expect(actions[2].command?.command).toBe(SELECTION_EXECUTION_COMMANDS.exportXlsbClipboard);
    });

    it('returns statement hub actions for an empty range', () => {
        const actions = provider.provideCodeActions(
            document,
            new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
            emptyContext,
            createMockCancellationToken(),
        );

        const titles = actions.map((action) => action.title);
        expect(titles).toContain('Run Statement');
        // The mocked parser cannot validate the wrapped preview SQL, so the
        // preview safety gate correctly omits previews here. Real-parser
        // coverage asserts all three previews (see sqlActionHub.test.ts).
        expect(actions.filter((action) => action.title.startsWith('Run Preview:'))).toHaveLength(0);
        expect(titles).toContain('Explain Statement');
        expect(titles).toContain('Visualize Query Flow');
        expect(titles).toContain('Format Statement');
        expect(titles).toContain('Export Statement');
    });

    it('returns no actions when showSelectionExecutionCodeActions is disabled', () => {
        mockConfigGet.mockImplementation((key: string, defaultValue: unknown) => {
            if (key === 'showSelectionExecutionCodeActions') {
                return false;
            }
            return defaultValue;
        });

        const actions = provider.provideCodeActions(
            document,
            selection,
            emptyContext,
            createMockCancellationToken(),
        );

        expect(actions).toEqual([]);
    });

    it('returns actions when context.only requests quickfix actions', () => {
        const actions = provider.provideCodeActions(
            document,
            selection,
            {
                diagnostics: [],
                only: vscode.CodeActionKind.QuickFix,
            } as unknown as vscode.CodeActionContext,
            createMockCancellationToken(),
        );

        expect(actions).toHaveLength(6);
    });

    it('filters actions when context.only excludes quickfix actions', () => {
        const refactorKind = (vscode.CodeActionKind as unknown as { Refactor?: vscode.CodeActionKind }).Refactor
            ?? new (class { value = 'refactor'; contains() { return false; } })();
        const actions = provider.provideCodeActions(
            document,
            selection,
            {
                diagnostics: [],
                only: refactorKind,
            } as unknown as vscode.CodeActionContext,
            createMockCancellationToken(),
        );

        expect(actions).toEqual([]);
    });
});
