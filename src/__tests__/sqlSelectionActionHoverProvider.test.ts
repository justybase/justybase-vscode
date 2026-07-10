import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import * as vscode from 'vscode';
import { SqlSelectionActionHoverProvider } from '../providers/sqlSelectionActionHoverProvider';
import { SELECTION_EXECUTION_COMMANDS } from '../providers/sqlSelectionActionUtils';
import type { SqlDataAffordanceResolver } from '../providers/sqlDataAffordanceResolver';

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

function createDocument(text: string, uri = 'file:///test.sql'): vscode.TextDocument {
    const lines = text.split('\n');

    return {
        languageId: 'sql',
        version: 1,
        uri: { toString: () => uri } as vscode.Uri,
        getText: (range?: vscode.Range) => {
            if (!range) {
                return text;
            }
            const startOffset = lines
                .slice(0, range.start.line)
                .reduce((acc, line) => acc + line.length + 1, 0) + range.start.character;
            const endOffset = lines
                .slice(0, range.end.line)
                .reduce((acc, line) => acc + line.length + 1, 0) + range.end.character;
            return text.substring(startOffset, endOffset);
        },
        lineAt: (line: number) => ({ text: lines[line] || '' }),
        offsetAt: (pos: vscode.Position) => {
            let offset = 0;
            for (let i = 0; i < pos.line; i++) {
                offset += (lines[i] || '').length + 1;
            }
            return offset + pos.character;
        },
    } as unknown as vscode.TextDocument;
}

function setActiveEditor(
    document: vscode.TextDocument,
    selection: vscode.Selection,
): void {
    (vscode.window as { activeTextEditor?: vscode.TextEditor }).activeTextEditor = {
        document,
        selection,
    } as vscode.TextEditor;
}

describe('SqlSelectionActionHoverProvider', () => {
    const sql = 'SELECT * FROM DIMDATE';
    const document = createDocument(sql);
    const selection = new vscode.Selection(
        new vscode.Position(0, 0),
        new vscode.Position(0, sql.length),
    );

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfigGet.mockImplementation((_key: string, defaultValue: unknown) => defaultValue);
        setActiveEditor(document, selection);
    });

    it('shows Run/Export links when hovering inside a non-object part of the selection', async () => {
        const provider = new SqlSelectionActionHoverProvider();
        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 9),
            createMockCancellationToken(),
        );

        expect(hover).toBeDefined();
        const content = hover?.contents;
        const markdown = (Array.isArray(content) ? content[0] : content) as vscode.MarkdownString;
        expect(markdown.value).toContain('**Selected SQL**');
        expect(markdown.value).toContain(`command:${SELECTION_EXECUTION_COMMANDS.run}`);
        expect(markdown.value).toContain(`command:${SELECTION_EXECUTION_COMMANDS.exportToFile}`);
        expect(markdown.value).toContain(`command:${SELECTION_EXECUTION_COMMANDS.exportXlsbClipboard}`);
        expect(hover?.range).toEqual(selection);
    });

    it('returns undefined when hovering on a table reference resolved by affordance resolver', async () => {
        const affordanceResolver = {
            getReferenceAtPosition: jest.fn(async () => ({
                tableName: 'DIMDATE',
                range: new vscode.Range(0, 14, 0, 21),
            })),
        } as unknown as SqlDataAffordanceResolver;

        const provider = new SqlSelectionActionHoverProvider(affordanceResolver);
        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 16),
            createMockCancellationToken(),
        );

        expect(hover).toBeUndefined();
        expect(affordanceResolver.getReferenceAtPosition).toHaveBeenCalled();
    });

    it('returns undefined when there is no active selection', async () => {
        setActiveEditor(document, new vscode.Selection(0, 0, 0, 0));

        const provider = new SqlSelectionActionHoverProvider();
        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 9),
            createMockCancellationToken(),
        );

        expect(hover).toBeUndefined();
    });

    it('returns undefined when hover position is outside the selection', async () => {
        const provider = new SqlSelectionActionHoverProvider();
        const hover = await provider.provideHover(
            document,
            new vscode.Position(1, 0),
            createMockCancellationToken(),
        );

        expect(hover).toBeUndefined();
    });

    it('returns undefined when showSelectionActionHover is disabled', async () => {
        mockConfigGet.mockImplementation((key: string, defaultValue: unknown) => {
            if (key === 'showSelectionActionHover') {
                return false;
            }
            return defaultValue;
        });

        const provider = new SqlSelectionActionHoverProvider();
        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 9),
            createMockCancellationToken(),
        );

        expect(hover).toBeUndefined();
    });

    it('returns undefined when showHoverTooltips is disabled', async () => {
        mockConfigGet.mockImplementation((key: string, defaultValue: unknown) => {
            if (key === 'showHoverTooltips') {
                return false;
            }
            return defaultValue;
        });

        const provider = new SqlSelectionActionHoverProvider();
        const hover = await provider.provideHover(
            document,
            new vscode.Position(0, 9),
            createMockCancellationToken(),
        );

        expect(hover).toBeUndefined();
    });
});
