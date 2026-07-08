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

interface ProcedureBlock {
    sql: string;
    startOffset: number;
    endOffset: number;
}

const STATEMENTS_TOGGLE_KEY = 'codeLens.statements';

export class SqlCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    private _enabled = true;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _globalState: vscode.Memento;

    private _scanOffset = 0;
    private _scanState = { inSingleQuote: false, inDoubleQuote: false, inLineComment: false, inBlockComment: false };

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

        const lenses: vscode.CodeLens[] = [];

        const text = document.getText();
        const procedureBlocks = this.findProcedureBlocks(text);
        lenses.push(...this.createProcedureCodeLenses(document, procedureBlocks));
        lenses.push(...this.createFileLevelCodeLenses(document));

        if (this._enabled) {
            if (this.getStatementsEnabled()) {
                lenses.push(...this.createStatementCodeLenses(document, text, procedureBlocks));
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
        const blocks: ProcedureBlock[] = [];
        const createProcedureRegex = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/gi;
        let match: RegExpExecArray | null;

        this._scanOffset = 0;
        this._scanState = { inSingleQuote: false, inDoubleQuote: false, inLineComment: false, inBlockComment: false };

        while ((match = createProcedureRegex.exec(text)) !== null) {
            if (!this.isSqlCodeOffset(text, match.index)) {
                continue;
            }

            const endProcMatch = this.findKeywordOutsideTrivia(
                text,
                /\bEND_PROC\b/gi,
                match.index + match[0].length,
            );
            if (!endProcMatch) {
                continue;
            }

            const startOffset = match.index;
            let endOffset = endProcMatch.index + endProcMatch.text.length;
            endOffset = this.includeOptionalTerminatingSemicolon(text, endOffset);

            blocks.push({
                sql: text.substring(startOffset, endOffset).trim(),
                startOffset,
                endOffset,
            });
            createProcedureRegex.lastIndex = endOffset;
        }

        return blocks;
    }

    private findKeywordOutsideTrivia(
        text: string,
        regex: RegExp,
        startOffset: number,
    ): { index: number; text: string } | undefined {
        regex.lastIndex = startOffset;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            if (this.isSqlCodeOffset(text, match.index)) {
                return { index: match.index, text: match[0] };
            }
        }

        return undefined;
    }

    private includeOptionalTerminatingSemicolon(text: string, offset: number): number {
        let current = offset;
        while (current < text.length && /\s/.test(text[current])) {
            current++;
        }
        return text[current] === ';' ? current + 1 : offset;
    }

    private isSqlCodeOffset(text: string, offset: number): boolean {
        let { inSingleQuote, inDoubleQuote, inLineComment, inBlockComment } = this._scanState;

        if (offset < this._scanOffset) {
            this._scanOffset = 0;
            this._scanState = { inSingleQuote: false, inDoubleQuote: false, inLineComment: false, inBlockComment: false };
            return false;
        }

        for (let i = this._scanOffset; i < offset; i++) {
            const char = text[i];
            const nextChar = i + 1 < offset ? text[i + 1] : '';

            if (inLineComment) {
                if (char === '\n') {
                    inLineComment = false;
                }
            } else if (inBlockComment) {
                if (char === '*' && nextChar === '/') {
                    inBlockComment = false;
                    i++;
                }
            } else if (inSingleQuote) {
                if (char === "'" && nextChar === "'") {
                    i++;
                } else if (char === "'") {
                    inSingleQuote = false;
                }
            } else if (inDoubleQuote) {
                if (char === '"') {
                    inDoubleQuote = false;
                }
            } else if (char === '-' && nextChar === '-') {
                inLineComment = true;
                i++;
            } else if (char === '/' && nextChar === '*') {
                inBlockComment = true;
                i++;
            } else if (char === "'") {
                inSingleQuote = true;
            } else if (char === '"') {
                inDoubleQuote = true;
            }
        }

        this._scanOffset = offset;
        this._scanState = { inSingleQuote, inDoubleQuote, inLineComment, inBlockComment };
        return !inSingleQuote && !inDoubleQuote && !inLineComment && !inBlockComment;
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
