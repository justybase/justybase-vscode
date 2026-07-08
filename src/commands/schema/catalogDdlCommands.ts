import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connectionManager';
import { resolveExtensionSqlRenameSymbol } from '../../core/extensionDocumentParseSession';
import {
    buildCatalogDdlQuery,
    CATALOG_DDL_URI_PATH,
    resolveCatalogObjectAtOffset,
} from '../../server/catalogNavigation';
import { isSqlAuthoringLanguageId } from '../../utils/sqlLanguage';

function revealOccurrence(
    editor: vscode.TextEditor,
    document: vscode.TextDocument,
    startOffset: number,
    endOffset: number,
): void {
    const start = document.positionAt(startOffset);
    const end = document.positionAt(endOffset);
    const range = new vscode.Range(start, end);
    editor.selection = new vscode.Selection(start, start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

export function registerCatalogDdlCommands(deps: {
    connectionManager: ConnectionManager;
}): vscode.Disposable[] {
    const { connectionManager } = deps;

    return [
        vscode.commands.registerCommand('netezza.goToCatalogDdl', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isSqlAuthoringLanguageId(editor.document.languageId)) {
                await vscode.commands.executeCommand('editor.action.revealDefinition');
                return;
            }

            const document = editor.document;
            const documentUri = document.uri.toString();
            const offset = document.offsetAt(editor.selection.active);
            const sql = document.getText();
            const databaseKind = connectionManager.getExecutionDatabaseKind(documentUri);

            const symbol = resolveExtensionSqlRenameSymbol(document, offset, databaseKind);
            if (symbol) {
                const definitionOccurrence =
                    symbol.occurrences.find((occurrence) => occurrence.role === 'definition') ??
                    symbol.target;
                revealOccurrence(
                    editor,
                    document,
                    definitionOccurrence.startOffset,
                    definitionOccurrence.endOffset,
                );
                return;
            }

            const effectiveDatabase =
                connectionManager.getDocumentDatabase(documentUri) ?? undefined;
            const effectiveSchema =
                (await connectionManager.getEffectiveSchema(documentUri)) ?? undefined;

            const catalogObject = resolveCatalogObjectAtOffset(
                sql,
                offset,
                databaseKind,
                effectiveDatabase,
                effectiveSchema,
            );
            if (!catalogObject) {
                await vscode.commands.executeCommand('editor.action.revealDefinition');
                return;
            }

            const ddlUri = vscode.Uri.from({
                scheme: 'netezza-catalog',
                path: CATALOG_DDL_URI_PATH,
                query: buildCatalogDdlQuery(catalogObject, documentUri),
            });
            const ddlDocument = await vscode.workspace.openTextDocument(ddlUri);
            const languageId = isSqlAuthoringLanguageId(document.languageId)
                ? document.languageId
                : 'sql';
            await vscode.languages.setTextDocumentLanguage(ddlDocument, languageId);
            await vscode.window.showTextDocument(ddlDocument, { preview: false });
        }),
    ];
}
