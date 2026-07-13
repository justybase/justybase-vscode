import * as vscode from 'vscode';
import { NetezzaFoldingRangeProvider } from '../providers/foldingProvider';
import { NetezzaDocumentSymbolProvider } from '../providers/documentSymbolProvider';
import { NetezzaSignatureHelpProvider } from '../providers/signatureHelpProvider';
import { NetezzaSemanticTokensProvider } from '../providers/semanticTokensProvider';
import { registerSqlShortcuts } from '../editors/sqlShortcuts';
import { MetadataCache } from '../metadataCache';
import { ConnectionManager } from '../core/connectionManager';
import { NetezzaParserHoverProvider } from '../providers/parserHoverProvider';
import { SqlSelectionActionHoverProvider } from '../providers/sqlSelectionActionHoverProvider';
import { SqlExecutionCodeActionProvider } from '../providers/sqlExecutionCodeActions';
import {
    getExtensionDocumentParseSession,
    registerExtensionDocumentParseSessionLifecycle,
} from '../core/extensionDocumentParseSession';
import { SqlCodeLensProvider } from '../providers/sqlCodeLensProvider';
import { SqlDataAffordanceResolver } from '../providers/sqlDataAffordanceResolver';
import { SqlFormattingProvider } from '../providers/sqlFormattingProvider';
import { SQL_AUTHORING_LANGUAGE_IDS, isSqlAuthoringLanguageId } from '../utils/sqlLanguage';

interface SqlLanguageRegistrationParams {
    context: vscode.ExtensionContext;
    metadataCache: MetadataCache;
    connectionManager: ConnectionManager;
}

export function registerSqlLanguageFeatures(params: SqlLanguageRegistrationParams): void {
    const { context, metadataCache, connectionManager } = params;
    const parseSession = getExtensionDocumentParseSession();
    registerExtensionDocumentParseSessionLifecycle(context);
    const dataAffordanceResolver = new SqlDataAffordanceResolver(
        metadataCache,
        connectionManager,
        parseSession,
    );
    const sqlCodeLensProvider = new SqlCodeLensProvider(connectionManager, context.globalState);
    const sqlAuthoringSelector = [...SQL_AUTHORING_LANGUAGE_IDS];
    // Always register hover provider to show table columns + description on hover
    // (without requiring Ctrl). The reveal-in-schema action is handled by
    // DocumentLinkProvider which only fires on Ctrl+click.
    const shouldRegisterLocalHoverProvider = true;
    const shouldRegisterLocalSignatureHelpProvider = process.env.NODE_ENV === 'test';

    const formattingProvider = new SqlFormattingProvider(connectionManager);

    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(sqlAuthoringSelector, new NetezzaFoldingRangeProvider())
    );

    // Register Document Formatting Provider for standard Format Document/Range
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            sqlAuthoringSelector,
            formattingProvider
        ),
        vscode.languages.registerDocumentRangeFormattingEditProvider(
            sqlAuthoringSelector,
            formattingProvider
        )
    );

    // Register Document Symbol Provider for outline view
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(
            sqlAuthoringSelector,
            new NetezzaDocumentSymbolProvider(parseSession, connectionManager),
        )
    );

    if (shouldRegisterLocalSignatureHelpProvider) {
        // Register Signature Help Provider for function parameter hints (LSP in production)
        context.subscriptions.push(
            vscode.languages.registerSignatureHelpProvider(
                sqlAuthoringSelector,
                new NetezzaSignatureHelpProvider(connectionManager),
                '(',
                ','
            )
        );
    }

    registerSqlShortcuts(context);

    context.subscriptions.push(dataAffordanceResolver, sqlCodeLensProvider);

    // Register CodeLens provider for SQL statements
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            sqlAuthoringSelector,
            sqlCodeLensProvider
        )
    );

    // Register Semantic Tokens provider for Netezza syntax highlighting
    // Passes MetadataCache + ConnectionManager for identifier-aware coloring (column vs table vs alias)
    const semanticTokensProvider = new NetezzaSemanticTokensProvider(
        metadataCache,
        connectionManager,
        parseSession,
    );
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            sqlAuthoringSelector,
            semanticTokensProvider,
            semanticTokensProvider.getLegend()
        ),
        semanticTokensProvider,
        metadataCache.onDidInvalidate(() => {
            semanticTokensProvider.refresh();
        }),
        metadataCache.onDidExternalRefresh((connectionName) => {
            semanticTokensProvider.refresh(connectionName);
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            semanticTokensProvider.releaseDocument(document.uri.toString());
        }),
        connectionManager.onDidChangeDocumentConnection((documentUri) => {
            semanticTokensProvider.invalidateDocument(documentUri);
        }),
        connectionManager.onDidChangeDocumentDatabase((documentUri) => {
            semanticTokensProvider.invalidateDocument(documentUri);
        })
    );

    if (shouldRegisterLocalHoverProvider) {
        context.subscriptions.push(
            vscode.languages.registerHoverProvider(
                sqlAuthoringSelector,
                new NetezzaParserHoverProvider(
                    metadataCache,
                    connectionManager,
                    dataAffordanceResolver,
                    parseSession,
                )
            ),
            vscode.languages.registerHoverProvider(
                sqlAuthoringSelector,
                new SqlSelectionActionHoverProvider(dataAffordanceResolver),
            ),
        );
    }

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            sqlAuthoringSelector,
            new SqlExecutionCodeActionProvider(),
            { providedCodeActionKinds: SqlExecutionCodeActionProvider.providedCodeActionKinds },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('netezza.lintSql', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active SQL editor');
                return;
            }

            if (!isSqlAuthoringLanguageId(editor.document.languageId)) {
                vscode.window.showWarningMessage('Active file is not a supported SQL file');
                return;
            }

            const { getSqlLinter } = await import('../providers/sqlLinterProvider');
            const linter = getSqlLinter();
            const issues = await linter.lintDocument(editor.document, true);
            if (issues.length === 0) {
                vscode.window.showInformationMessage('SQL linting passed - no issues found');
            } else {
                vscode.window.showWarningMessage(`SQL linting found ${issues.length} issue(s)`);
            }
        })
    );
}
