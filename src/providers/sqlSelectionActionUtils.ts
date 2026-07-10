import * as vscode from 'vscode';
import type { SqlDataAffordanceResolver } from './sqlDataAffordanceResolver';

export const SELECTION_EXECUTION_COMMANDS = {
    run: 'netezza.runQuery',
    exportToFile: 'netezza.exportWithFormatPicker',
    exportXlsbClipboard: 'netezza.copyXlsbToClipboard',
} as const;

export const SELECTION_EXECUTION_CODE_ACTION_KIND = vscode.CodeActionKind.QuickFix;

export interface SelectionExecutionContext {
    selection: vscode.Selection;
    selectedText: string;
}

export function getActiveSelectionContext(
    document: vscode.TextDocument,
    position?: vscode.Position,
): SelectionExecutionContext | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
        return undefined;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
        return undefined;
    }

    if (position && !selection.contains(position)) {
        return undefined;
    }

    const selectedText = document.getText(selection).trim();
    if (!selectedText) {
        return undefined;
    }

    return { selection, selectedText };
}

export function resolveCodeActionSelectionContext(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
): SelectionExecutionContext | undefined {
    const activeContext = getActiveSelectionContext(document);
    if (activeContext) {
        return activeContext;
    }

    const selectedText = getSelectionTextFromRange(document, range);
    if (!selectedText) {
        return undefined;
    }

    const selection = range instanceof vscode.Selection
        ? range
        : new vscode.Selection(range.start, range.end);

    return { selection, selectedText };
}

export function getSelectionTextFromRange(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
): string | undefined {
    if (range.isEmpty) {
        return undefined;
    }

    const selectedText = document.getText(range).trim();
    return selectedText || undefined;
}

export async function resolveSelectionExecutionContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    dataAffordanceResolver?: SqlDataAffordanceResolver,
    options?: { requirePositionInSelection?: boolean },
): Promise<SelectionExecutionContext | undefined> {
    const context = getActiveSelectionContext(
        document,
        options?.requirePositionInSelection !== false ? position : undefined,
    );
    if (!context) {
        return undefined;
    }

    if (dataAffordanceResolver) {
        const dataReference = await dataAffordanceResolver.getReferenceAtPosition(document, position);
        if (dataReference) {
            return undefined;
        }
    }

    return context;
}

export function appendSelectionExecutionActionLinks(markdown: vscode.MarkdownString): void {
    markdown.appendMarkdown('**Selected SQL**\n\n');
    markdown.appendMarkdown(`[▶ Run](command:${SELECTION_EXECUTION_COMMANDS.run})\n\n`);
    markdown.appendMarkdown(`[Export to file](command:${SELECTION_EXECUTION_COMMANDS.exportToFile})\n\n`);
    markdown.appendMarkdown(`[Export XLSB (Clipboard)](command:${SELECTION_EXECUTION_COMMANDS.exportXlsbClipboard})`);
    markdown.isTrusted = true;
}

export function createSelectionExecutionHover(context: SelectionExecutionContext): vscode.Hover {
    const markdown = new vscode.MarkdownString();
    appendSelectionExecutionActionLinks(markdown);
    return new vscode.Hover(markdown, context.selection);
}

export function createSelectionExecutionCodeActions(): vscode.CodeAction[] {
    return [
        createCommandCodeAction('Run Query', SELECTION_EXECUTION_COMMANDS.run),
        createCommandCodeAction(
            'Export to file',
            SELECTION_EXECUTION_COMMANDS.exportToFile,
        ),
        createCommandCodeAction(
            'Export as XLSB (Copy to clipboard)',
            SELECTION_EXECUTION_COMMANDS.exportXlsbClipboard,
        ),
    ];
}

function createCommandCodeAction(title: string, command: string): vscode.CodeAction {
    const action = new vscode.CodeAction(title, SELECTION_EXECUTION_CODE_ACTION_KIND);
    action.command = { command, title };
    return action;
}
