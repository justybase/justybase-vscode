/**
 * CodeLens provider for SQL statements.
 * Shows a top-level file toolbar and per-statement action links.
 *
 * Per-statement visibility is controlled by a single globalState toggle
 * so it takes effect instantly without requiring an editor reload.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { SqlParser } from '../sql/sqlParser';
import { SqlLexer } from '../sqlParser/lexer';
import { affectsExtensionConfiguration, getExtensionConfiguration } from '../compatibility/configuration';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';
import { isLargeScriptDocument } from '../sqlParser/validationConfig';
import {
    findProcedureBlocks,
    findProcedureAndViewHeaders,
    findViewBlocks,
    type ProcedureBlock,
    type ProcedureHeader,
    type ViewBlock,
    type ViewHeader,
} from '../sqlParser/procedure/procedureCodeLens';

const RUNNABLE_STATEMENT_TOKENS = new Set([
    'Select',
    'With',
    'Insert',
    'Update',
    'Delete',
    'Create',
    'Alter',
    'Drop',
    'Truncate',
    'Call',
    'Exec',
    'Execute',
    'Merge',
    'Groom',
    'Generate',
    'Grant',
    'Revoke',
    'Comment',
    'Show',
    'Copy',
    'Lock',
    'Reindex',
    'Reset',
    'Commit',
    'Rollback',
    'Set',
    'AtSet',
    'Explain'
]);
const EXPLAINABLE_STATEMENT_TOKENS = new Set(['Select', 'With', 'Insert', 'Update', 'Delete', 'Merge']);
const EXPORTABLE_STATEMENT_TOKENS = new Set(['Select', 'With']);
const QUERY_FLOW_STATEMENT_TOKENS = new Set(['With', 'Select', 'Insert', 'Update', 'Delete']);

interface StatementLensSupport {
    canRun: boolean;
    canExplain: boolean;
    canExport: boolean;
    canVisualize: boolean;
}

const STATEMENTS_TOGGLE_KEY = 'codeLens.statements';

export class SqlCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    private _enabled = true;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _globalState: vscode.Memento;

    constructor(
        private readonly _connectionManager?: ConnectionManager,
        globalState?: vscode.Memento,
    ) {
        this._globalState = globalState ?? {
            get: <T>(_key: string, defaultValue?: T) => defaultValue as T,
            update: async () => {},
        } as unknown as vscode.Memento;

        this._disposables.push(
            vscode.commands.registerCommand('netezza.toggleStatementCodeLens', () => {
                const current = this.getStatementsEnabled();
                this.setStatementsEnabled(!current);
            }),
        );

        this.trackDisposable(vscode.workspace.onDidChangeConfiguration(e => {
            if (
                affectsExtensionConfiguration(e, 'codeLens.enabled') ||
                affectsExtensionConfiguration(e, 'codeLens.run') ||
                affectsExtensionConfiguration(e, 'codeLens.runBatch') ||
                affectsExtensionConfiguration(e, 'codeLens.openAsXlsx') ||
                affectsExtensionConfiguration(e, 'codeLens.openAsXlsb') ||
                affectsExtensionConfiguration(e, 'codeLens.export') ||
                affectsExtensionConfiguration(e, 'codeLens.markdown') ||
                affectsExtensionConfiguration(e, 'codeLens.import') ||
                affectsExtensionConfiguration(e, 'codeLens.explain')
            ) {
                this._enabled = getExtensionConfiguration().get<boolean>('codeLens.enabled', true) ?? true;
                this._onDidChangeCodeLenses.fire();
            }
        }));

        if (this._connectionManager) {
            this.trackDisposable(this._connectionManager.onDidChangeActiveConnection(() => this.refreshCodeLenses()));
            this.trackDisposable(this._connectionManager.onDidChangeDocumentConnection(() => this.refreshCodeLenses()));
            this.trackDisposable(this._connectionManager.onDidChangeDocumentDatabase(() => this.refreshCodeLenses()));
        }

        this._enabled = getExtensionConfiguration().get<boolean>('codeLens.enabled', true) ?? true;
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CodeLens[]> {
        if (document.uri.scheme === 'vscode-notebook-cell') {
            return [];
        }
        if (!isSqlAuthoringLanguageId(document.languageId)) {
            return [];
        }

        const text = document.getText();
        // Large scripts: skip procedure/view body scans that re-walk the whole
        // document while typing. Headers remain visible; terminators are
        // resolved when the lens is clicked.
        if (isLargeScriptDocument(document.lineCount, text.length)) {
            const headers = findProcedureAndViewHeaders(text);
            return [
                ...this.createProcedureHeaderCodeLenses(document, headers.procedures),
                ...this.createViewHeaderCodeLenses(document, headers.views),
                ...this.createFileLevelCodeLenses(document),
            ];
        }

        const lenses: vscode.CodeLens[] = [];

        const procedureBlocks = this.findProcedureBlocks(text);
        const viewBlocks = findViewBlocks(text);
        lenses.push(...this.createProcedureCodeLenses(document, procedureBlocks));
        lenses.push(...this.createViewCodeLenses(document, viewBlocks));
        lenses.push(...this.createFileLevelCodeLenses(document));

        if (this._enabled) {
            if (this.getStatementsEnabled()) {
                lenses.push(...this.createStatementCodeLenses(document, text, [...procedureBlocks, ...viewBlocks]));
            }
        }

        return lenses;
    }

    public dispose(): void {
        for (const disposable of this._disposables) {
            disposable.dispose();
        }
        this._disposables.length = 0;
        this._onDidChangeCodeLenses.dispose();
    }

    private getStatementsEnabled(): boolean {
        return this._globalState.get<boolean>(STATEMENTS_TOGGLE_KEY, false);
    }

    private setStatementsEnabled(value: boolean): void {
        this._globalState.update(STATEMENTS_TOGGLE_KEY, value);
        this._onDidChangeCodeLenses.fire();
    }

    private createFileLevelCodeLenses(_document: vscode.TextDocument): vscode.CodeLens[] {
        const config = getExtensionConfiguration();

        if (!config.get<boolean>('codeLens.enabled', true)) {
            return [];
        }

        const range = new vscode.Range(0, 0, 0, 0);
        const lenses: vscode.CodeLens[] = [];

        if (config.get<boolean>('codeLens.run', true)) {
            lenses.push(new vscode.CodeLens(range, {
                title: '$(debug-start) Run',
                command: 'netezza.runQuery',
                tooltip: 'Execute selected text or statement at cursor',
            }));
        }
        if (config.get<boolean>('codeLens.runBatch', true)) {
            lenses.push(new vscode.CodeLens(range, {
                title: '$(run-all) Run Batch',
                command: 'netezza.runQueryBatch',
                tooltip: 'Execute selected text or entire file',
            }));
        }
        if (config.get<boolean>('codeLens.openAsXlsb', true)) {
            lenses.push(new vscode.CodeLens(range, {
                title: '$(file-binary) Open as XLSB',
                command: 'netezza.exportQueryAndOpenXlsb',
                tooltip: 'Execute and open results as XLSB',
            }));
        }
        if (config.get<boolean>('codeLens.export', true)) {
            lenses.push(new vscode.CodeLens(range, {
                title: '$(export) Export',
                command: 'netezza.exportWithFormatPicker',
                tooltip: 'Export results with format selection',
            }));
        }
        if (config.get<boolean>('codeLens.markdown', true)) {
            lenses.push(new vscode.CodeLens(range, {
                title: '$(markdown) MD',
                command: 'netezza.exportToMdFile',
                tooltip: 'Export results as Markdown',
            }));
        }
        if (config.get<boolean>('codeLens.import', true)) {
            lenses.push(new vscode.CodeLens(range, {
                title: '$(cloud-upload) Import',
                command: 'netezza.importWithPicker',
                tooltip: 'Import data from clipboard or file',
            }));
        }
        if (config.get<boolean>('codeLens.explain', true)) {
            lenses.push(new vscode.CodeLens(range, {
                title: '$(info) Explain',
                command: 'netezza.explainQuery',
                tooltip: 'Show EXPLAIN plan for selected or current statement',
            }));
        }

        // Single toggle button for all per-statement lenses
        const on = this.getStatementsEnabled();
        lenses.push(new vscode.CodeLens(range, {
            title: on ? '$(check) Statements' : '$(close) Statements',
            command: 'netezza.toggleStatementCodeLens',
            tooltip: on ? 'Per-statement lenses ON — click to hide all' : 'Per-statement lenses OFF — click to show all',
        }));

        return lenses;
    }

    private createProcedureCodeLenses(
        document: vscode.TextDocument,
        procedureBlocks: readonly ProcedureBlock[],
    ): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];

        for (const block of procedureBlocks) {
            const startPos = document.positionAt(block.startOffset);
            const endPos = document.positionAt(block.endOffset);
            const range = new vscode.Range(startPos, endPos);

            lenses.push(
                new vscode.CodeLens(range, {
                    title: '$(run-all) Compile Procedure',
                    command: 'netezza.compileProcedureFromLens',
                    arguments: [document.uri, block.sql],
                    tooltip: 'Compile this stored procedure',
                })
            );
        }

        return lenses;
    }

    private createProcedureHeaderCodeLenses(
        document: vscode.TextDocument,
        headers: readonly ProcedureHeader[],
    ): vscode.CodeLens[] {
        return headers.map((header) => {
            const range = new vscode.Range(
                document.positionAt(header.startOffset),
                document.positionAt(header.endOffset),
            );

            return new vscode.CodeLens(range, {
                title: '$(run-all) Compile Procedure',
                command: 'netezza.compileProcedureFromLens',
                arguments: [document.uri, header.startOffset],
                tooltip: 'Compile this stored procedure',
            });
        });
    }

    private createViewCodeLenses(
        document: vscode.TextDocument,
        viewBlocks: readonly ViewBlock[],
    ): vscode.CodeLens[] {
        return viewBlocks.map((block) => this.createViewCodeLens(
            document,
            block.startOffset,
            block.endOffset,
            block.sql,
        ));
    }

    private createViewHeaderCodeLenses(
        document: vscode.TextDocument,
        headers: readonly ViewHeader[],
    ): vscode.CodeLens[] {
        return headers.map((header) => this.createViewCodeLens(
            document,
            header.startOffset,
            header.endOffset,
            header.startOffset,
        ));
    }

    private createViewCodeLens(
        document: vscode.TextDocument,
        startOffset: number,
        endOffset: number,
        statementOrOffset: string | number,
    ): vscode.CodeLens {
        const range = new vscode.Range(
            document.positionAt(startOffset),
            document.positionAt(endOffset),
        );

        return new vscode.CodeLens(range, {
            title: '$(run-all) Compile View',
            command: 'netezza.runStatementFromLens',
            arguments: [document.uri, statementOrOffset],
            tooltip: 'Compile this view',
        });
    }

    private createStatementCodeLenses(
        document: vscode.TextDocument,
        text: string,
        procedureBlocks: readonly ProcedureBlock[],
    ): vscode.CodeLens[] {
        const statements = SqlParser.splitStatementsWithPositions(text);
        const lenses: vscode.CodeLens[] = [];

        for (const stmt of statements) {
            if (procedureBlocks.some(block => this.rangesOverlap(stmt, block))) {
                continue;
            }

            const support = this.getStatementLensSupport(stmt.sql);
            if (!support.canRun && !support.canExplain && !support.canExport && !support.canVisualize) {
                continue;
            }

            const startPos = document.positionAt(stmt.startOffset);
            const endPos = document.positionAt(stmt.endOffset);
            const range = new vscode.Range(startPos, endPos);

            if (support.canRun) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: '$(debug-start) Run',
                        command: 'netezza.runStatementFromLens',
                        arguments: [document.uri, stmt.sql],
                        tooltip: 'Execute this SQL statement',
                    })
                );
            }

            if (support.canExplain) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: '$(info) Explain',
                        command: 'netezza.explainStatementFromLens',
                        arguments: [document.uri, stmt.sql],
                        tooltip: 'Show EXPLAIN plan for this statement',
                    })
                );
            }

            if (support.canVisualize) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: '$(graph) Visualize Query Flow',
                        command: 'netezza.visualizeQueryFlow',
                        arguments: [document.uri, stmt.startOffset],
                        tooltip: 'Render an interactive dependency graph for this SQL statement',
                    })
                );
            }

            if (support.canExport) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: '$(export) Export',
                        command: 'netezza.exportStatementFromLens',
                        arguments: [document.uri, stmt.sql],
                        tooltip: 'Export results of this statement to file',
                    })
                );
            }
        }

        return lenses;
    }

    private findProcedureBlocks(text: string): ProcedureBlock[] {
        return findProcedureBlocks(text);
    }

    private rangesOverlap(
        left: { startOffset: number; endOffset: number },
        right: { startOffset: number; endOffset: number },
    ): boolean {
        return left.startOffset < right.endOffset && right.startOffset < left.endOffset;
    }

    private refreshCodeLenses(): void {
        this._onDidChangeCodeLenses.fire();
    }

    private getStatementLensSupport(statementSql: string): StatementLensSupport {
        const lexResult = SqlLexer.tokenize(statementSql);
        if (lexResult.errors.length > 0 || lexResult.tokens.length === 0) {
            return {
                canRun: false,
                canExplain: false,
                canExport: false,
                canVisualize: false,
            };
        }

        const firstTokenName = lexResult.tokens[0].tokenType.name;

        return {
            canRun: RUNNABLE_STATEMENT_TOKENS.has(firstTokenName),
            canExplain: EXPLAINABLE_STATEMENT_TOKENS.has(firstTokenName),
            canExport: EXPORTABLE_STATEMENT_TOKENS.has(firstTokenName),
            canVisualize: QUERY_FLOW_STATEMENT_TOKENS.has(firstTokenName),
        };
    }

    private trackDisposable(disposable: vscode.Disposable | undefined): void {
        if (disposable) {
            this._disposables.push(disposable);
        }
    }
}
