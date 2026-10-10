import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { DatabaseKind } from '../contracts/database';
import { getExtensionConfiguration } from '../compatibility/configuration';
import {
    createSelectionExecutionCodeActions,
    resolveCodeActionSelectionContext,
    SELECTION_EXECUTION_CODE_ACTION_KIND,
} from './sqlSelectionActionUtils';
import {
    HUB_PREVIEW_ROW_LIMITS,
    applyHubTextEdit,
    buildAddToGroupByEdit,
    buildHubQualifiedName,
    buildHubSchemaItemData,
    buildPreviewSql,
    buildQualifyColumnEdit,
    findHubStatement,
    isHubCteReference,
    resolveHubCatalogRef,
    resolveHubColumn,
    verifyHubSqlParses,
    type HubStatement,
} from './sqlActionHubUtils';
import { isLargeScriptDocument } from '../sqlParser/validationConfig';

/**
 * Optional hub dependencies. The provider keeps working without them
 * (capability gates are skipped), which also keeps unit tests light.
 */
export interface SqlExecutionCodeActionHubDeps {
    connectionManager?: Pick<
        ConnectionManager,
        | 'getActiveConnectionName'
        | 'getConnectionForExecution'
        | 'getDocumentDatabase'
        | 'getExecutionDatabaseKind'
        | 'supportsCapability'
    >;
}

/**
 * Selection execution actions plus the context-sensitive SQL Action Hub.
 *
 * The hub expands this existing provider (no parallel action system):
 * - statement at cursor: run / preview / explain / visualize / format / export
 * - table/view at cursor: DDL / reveal / top 100 / dependencies / refresh
 * - column at cursor: info / references / qualify / group by
 *
 * Diagnostic quick fixes stay owned by the linter/LSP providers (including
 * "Fix with Copilot"); the hub never duplicates them. Table statistics and
 * alias generation have no equivalent command and are intentionally omitted.
 */
export class SqlExecutionCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [SELECTION_EXECUTION_CODE_ACTION_KIND];

    public constructor(private readonly hubDeps?: SqlExecutionCodeActionHubDeps) {}

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken,
    ): vscode.CodeAction[] {
        const enabled = getExtensionConfiguration('sql').get<boolean>(
            'showSelectionExecutionCodeActions',
            true,
        ) ?? true;
        if (!enabled) {
            return [];
        }

        if (
            context.only
            && !SqlExecutionCodeActionProvider.providedCodeActionKinds.some(kind =>
                kind.contains(context.only!) || context.only!.contains(kind)
            )
        ) {
            return [];
        }

        const actions: vscode.CodeAction[] = [];
        const selectionContext = resolveCodeActionSelectionContext(document, range);
        if (selectionContext) {
            actions.push(...createSelectionExecutionCodeActions());
        }

        const text = document.getText();
        if (!text.trim()) {
            return actions;
        }

        const offset = document.offsetAt(range.start);
        const statement = findHubStatement(text, offset);
        if (statement) {
            actions.push(...this.createStatementActions(document, statement, selectionContext !== undefined));
        }

        // Full-parse contexts are skipped for very large scripts; the
        // statement splitter and lexer above stay cheap.
        if (isLargeScriptDocument(document.lineCount, text.length)) {
            return actions;
        }

        actions.push(...this.createTableActions(document, text, offset));
        actions.push(...this.createColumnActions(document, text, offset, statement));

        return actions;
    }

    private resolveDatabaseKind(document: vscode.TextDocument): DatabaseKind | undefined {
        try {
            return this.hubDeps?.connectionManager?.getExecutionDatabaseKind(document.uri.toString());
        } catch {
            return undefined;
        }
    }

    private resolveConnectionName(document: vscode.TextDocument): string | undefined {
        const manager = this.hubDeps?.connectionManager;
        if (!manager) {
            return undefined;
        }
        try {
            return manager.getConnectionForExecution(document.uri.toString())
                ?? manager.getActiveConnectionName()
                ?? undefined;
        } catch {
            return undefined;
        }
    }

    private isExplainSupported(document: vscode.TextDocument): boolean {
        const manager = this.hubDeps?.connectionManager;
        if (!manager) {
            return true;
        }
        try {
            return manager.supportsCapability('supportsExplainPlan', document.uri.toString());
        } catch {
            return true;
        }
    }

    private createCommandAction(title: string, command: string, args: unknown[]): vscode.CodeAction {
        const action = new vscode.CodeAction(title, SELECTION_EXECUTION_CODE_ACTION_KIND);
        action.command = { command, title, arguments: args };
        return action;
    }

    private createStatementActions(
        document: vscode.TextDocument,
        statement: HubStatement,
        selectionActive: boolean,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const { support } = statement;
        if (!support.canRun && !support.canExplain && !support.canExport && !support.canVisualize) {
            return actions;
        }

        // When a selection is active the selection Run/Export actions above
        // already cover execution; statement Run/Preview/Export would duplicate
        // them, so only the non-overlapping statement actions are added.
        if (support.canRun && !selectionActive) {
            actions.push(this.createCommandAction(
                'Run Statement',
                'netezza.runStatementFromLens',
                [document.uri, statement.sql],
            ));
            const databaseKind = this.resolveDatabaseKind(document);
            for (const limit of HUB_PREVIEW_ROW_LIMITS) {
                const previewSql = buildPreviewSql(statement.sql, limit, databaseKind);
                if (previewSql) {
                    actions.push(this.createCommandAction(
                        `Run Preview: ${limit.toLocaleString('en-US')} rows`,
                        'netezza.runStatementFromLens',
                        [document.uri, previewSql],
                    ));
                }
            }
        }

        if (support.canExplain && this.isExplainSupported(document)) {
            actions.push(this.createCommandAction(
                'Explain Statement',
                'netezza.explainStatementFromLens',
                [document.uri, statement.sql],
            ));
        }

        if (support.canVisualize) {
            actions.push(this.createCommandAction(
                'Visualize Query Flow',
                'netezza.visualizeQueryFlow',
                [document.uri, statement.startOffset],
            ));
        }

        actions.push(this.createCommandAction(
            'Format Statement',
            'netezza.formatSQL',
            [{ startOffset: statement.startOffset, endOffset: statement.endOffset }],
        ));

        if (support.canExport && !selectionActive) {
            actions.push(this.createCommandAction(
                'Export Statement',
                'netezza.exportStatementFromLens',
                [document.uri, statement.sql],
            ));
        }

        return actions;
    }

    private createTableActions(
        document: vscode.TextDocument,
        text: string,
        offset: number,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const documentUri = document.uri.toString();
        const databaseKind = this.resolveDatabaseKind(document);
        let effectiveDatabase: string | undefined;
        try {
            effectiveDatabase = this.hubDeps?.connectionManager?.getDocumentDatabase(documentUri) ?? undefined;
        } catch {
            effectiveDatabase = undefined;
        }

        const ref = resolveHubCatalogRef(text, offset, databaseKind, effectiveDatabase);
        if (!ref || (ref.kind !== 'table' && ref.kind !== 'view')) {
            return actions;
        }
        if (isHubCteReference(text, offset, ref.name, databaseKind)) {
            return actions;
        }

        actions.push(this.createCommandAction(
            `Show DDL for ${buildHubQualifiedName(ref, databaseKind)}`,
            'netezza.goToCatalogDdl',
            [],
        ));

        const connectionName = this.resolveConnectionName(document);
        if (!connectionName) {
            return actions;
        }
        const item = buildHubSchemaItemData(ref, connectionName);
        actions.push(this.createCommandAction(
            `Reveal ${ref.name} in Schema Browser`,
            'netezza.revealInSchema',
            [{
                name: ref.name,
                objType: ref.kind.toUpperCase(),
                database: ref.database,
                schema: ref.schema,
                connectionName,
            }],
        ));

        if (ref.database) {
            actions.push(this.createCommandAction(
                `Select Top 100 from ${ref.name}`,
                'netezza.copySelectAll',
                [item, { limit: 100 }],
            ));
        }

        if (databaseKind === 'netezza') {
            actions.push(this.createCommandAction(
                `Show Dependencies of ${ref.name}`,
                'netezza.showDependencies',
                [item],
            ));
            actions.push(this.createCommandAction(
                `Show Used By of ${ref.name}`,
                'netezza.showUsedBy',
                [item],
            ));
            actions.push(this.createCommandAction(
                `Impact Analysis for ${ref.name}`,
                'netezza.impactAnalysis',
                [item],
            ));
        }

        if (ref.database && ref.schema) {
            actions.push(this.createCommandAction(
                `Refresh Metadata for ${ref.name}`,
                'netezza.refreshSchemaSelection',
                [{
                    ...item,
                    contextValue: `netezza:${ref.kind}`,
                }],
            ));
        }

        return actions;
    }

    private createColumnActions(
        document: vscode.TextDocument,
        text: string,
        offset: number,
        statement: HubStatement | undefined,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const databaseKind = this.resolveDatabaseKind(document);
        const column = resolveHubColumn(text, offset, databaseKind);
        if (!column) {
            return actions;
        }

        actions.push(this.createCommandAction(
            `Show Column Information for ${column.text}`,
            'editor.action.showHover',
            [],
        ));
        actions.push(this.createCommandAction(
            `Find References of ${column.text}`,
            'editor.action.findReferences',
            [],
        ));

        const qualifyEdit = buildQualifyColumnEdit(column);
        if (qualifyEdit && column.singleAlias) {
            const qualified = applyHubTextEdit(text, qualifyEdit);
            if (verifyHubSqlParses(qualified, databaseKind)) {
                actions.push(this.createEditAction(
                    document,
                    `Qualify with Alias (${column.singleAlias}.${column.text})`,
                    qualifyEdit.insertOffset,
                    qualifyEdit.insertText,
                ));
            }
        }

        if (statement?.support.canExport) {
            const groupByEdit = buildAddToGroupByEdit(text, statement, column.text, databaseKind);
            if (groupByEdit) {
                const grouped = applyHubTextEdit(text, groupByEdit);
                if (verifyHubSqlParses(grouped, databaseKind)) {
                    actions.push(this.createEditAction(
                        document,
                        `Add ${column.text} to GROUP BY`,
                        groupByEdit.insertOffset,
                        groupByEdit.insertText,
                    ));
                }
            }
        }

        return actions;
    }

    private createEditAction(
        document: vscode.TextDocument,
        title: string,
        insertOffset: number,
        insertText: string,
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(title, SELECTION_EXECUTION_CODE_ACTION_KIND);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(insertOffset), insertText);
        action.edit = edit;
        return action;
    }
}
