import * as vscode from 'vscode';
import { EXTRACT_SUBQUERY_PREVIEW_COMMAND } from './sqlRefactorCodeActions';

export type SqlRefactorPreviewChoice = 'Apply' | 'Apply & Close Diff' | 'Discard' | undefined;

export interface ExtractSubqueryPreviewArgs {
    sourceUri: string;
    expectedVersion: number;
    originalSql: string;
    proposedSql: string;
    languageId: string;
}

export interface SqlRefactorPreviewDependencies {
    findSourceDocument(uri: string): vscode.TextDocument | undefined;
    openSourceDocument(uri: vscode.Uri): Thenable<vscode.TextDocument>;
    openPreviewDocument(content: string, languageId: string): Thenable<vscode.TextDocument>;
    openDiff(source: vscode.Uri, proposal: vscode.Uri, title: string): Thenable<unknown>;
    choose(): Thenable<SqlRefactorPreviewChoice>;
    apply(document: vscode.TextDocument, proposedSql: string): Thenable<boolean>;
    closeDiff(source: vscode.Uri, proposal: vscode.Uri): Thenable<unknown>;
    showStaleMessage(): void;
    showApplyFailureMessage(): void;
}

const defaultDependencies: SqlRefactorPreviewDependencies = {
    findSourceDocument: uri => vscode.workspace.textDocuments.find(document => document.uri.toString() === uri),
    openSourceDocument: uri => vscode.workspace.openTextDocument(uri),
    openPreviewDocument: (content, languageId) => vscode.workspace.openTextDocument({ content, language: languageId }),
    openDiff: (source, proposal, title) => vscode.commands.executeCommand(
        'vscode.diff', source, proposal, title, { preview: true },
    ),
    choose: () => vscode.window.showInformationMessage<Exclude<SqlRefactorPreviewChoice, undefined>>(
        'Review the proposed SQL changes. Pressing Escape discards this refactor.',
        { modal: true },
        'Apply',
        'Apply & Close Diff',
        'Discard',
    ),
    apply: (document, proposedSql) => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            proposedSql,
        );
        return vscode.workspace.applyEdit(edit);
    },
    closeDiff: (source, proposal) => {
        const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (
            activeInput instanceof vscode.TabInputTextDiff
            && activeInput.original.toString() === source.toString()
            && activeInput.modified.toString() === proposal.toString()
        ) {
            return vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
        return Promise.resolve(undefined);
    },
    showStaleMessage: () => {
        void vscode.window.showErrorMessage('The SQL document changed during the preview. No changes were applied.');
    },
    showApplyFailureMessage: () => {
        void vscode.window.showErrorMessage('VS Code could not apply the SQL refactor.');
    },
};

function getDisplayName(document: vscode.TextDocument): string {
    const fileName = document.fileName.split(/[\\/]/u).pop();
    return `Extract Subquery as CTE: ${fileName || 'SQL document'}`;
}

function isCurrentSource(document: vscode.TextDocument, args: ExtractSubqueryPreviewArgs): boolean {
    return document.version === args.expectedVersion && document.getText() === args.originalSql;
}

/** Show a source-to-proposal diff and apply the full-document edit only after explicit confirmation. */
export async function runExtractSubqueryPreview(
    args: ExtractSubqueryPreviewArgs,
    dependencies: SqlRefactorPreviewDependencies = defaultDependencies,
): Promise<void> {
    if (
        !args || typeof args.sourceUri !== 'string' || typeof args.originalSql !== 'string'
        || typeof args.proposedSql !== 'string' || !Number.isInteger(args.expectedVersion)
    ) {
        return;
    }

    const uri = vscode.Uri.parse(args.sourceUri);
    const sourceDocument = dependencies.findSourceDocument(args.sourceUri)
        ?? await dependencies.openSourceDocument(uri);
    if (!isCurrentSource(sourceDocument, args)) {
        dependencies.showStaleMessage();
        return;
    }

    const proposalDocument = await dependencies.openPreviewDocument(args.proposedSql, args.languageId || 'sql');
    await dependencies.openDiff(sourceDocument.uri, proposalDocument.uri, getDisplayName(sourceDocument));

    const choice = await dependencies.choose();
    if (choice !== 'Apply' && choice !== 'Apply & Close Diff') {
        await dependencies.closeDiff(sourceDocument.uri, proposalDocument.uri);
        return;
    }

    // Check the live, open document again after the modal. Do not overwrite edits made during review.
    const currentDocument = dependencies.findSourceDocument(args.sourceUri);
    if (!currentDocument || !isCurrentSource(currentDocument, args)) {
        dependencies.showStaleMessage();
        return;
    }

    const applied = await dependencies.apply(currentDocument, args.proposedSql);
    if (!applied) {
        dependencies.showApplyFailureMessage();
        return;
    }
    if (choice === 'Apply & Close Diff') {
        await dependencies.closeDiff(sourceDocument.uri, proposalDocument.uri);
    }
}

export function registerSqlRefactorPreviewCommand(): vscode.Disposable {
    return vscode.commands.registerCommand(
        EXTRACT_SUBQUERY_PREVIEW_COMMAND,
        (args: ExtractSubqueryPreviewArgs) => runExtractSubqueryPreview(args),
    );
}
