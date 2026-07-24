import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { DocumentParseSession } from '../sqlParser/documentParseSession';
import {
    collectSqlSymbolUsages,
    collectSqlSymbolUsagesFromCst,
} from '../sqlParser/symbols';

type OutlineOccurrenceRole = 'definition' | 'reference';

interface OutlineOccurrence {
    kind: string;
    role: OutlineOccurrenceRole;
    startOffset: number;
    endOffset: number;
    text: string;
}

interface OutlineSymbol {
    kind: string;
    name: string;
    occurrences: OutlineOccurrence[];
}

interface MacroDeclaration {
    symbol: OutlineSymbol;
    normalizedName: string;
    startOffset: number;
}

/**
 * DocumentSymbolProvider for SQL files.
 * Provides outline view with CTEs, table aliases, created tables, and macro variables.
 */
export class NetezzaDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    constructor(
        private readonly _parseSession?: DocumentParseSession,
        private readonly _connectionManager?: Pick<
            ConnectionManager,
            'getExecutionDatabaseKind'
        >,
    ) {}

    public provideDocumentSymbols(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
        const sql = document.getText();
        const symbols = this.collectSymbols(document, sql);
        const documentSymbols = symbols.map(symbol => this.createDocumentSymbol(document, symbol));
        return documentSymbols;
    }

    private collectSymbols(
        document: vscode.TextDocument,
        sql: string,
    ): OutlineSymbol[] {
        if (!sql.trim()) {
            return [];
        }

        const macroSymbols = this.collectMacroVariableSymbols(sql);

        if (this._parseSession) {
            const documentUri = document.uri.toString();
            const databaseKind = this._connectionManager?.getExecutionDatabaseKind?.(
                documentUri,
            );
            const parseResult = this._parseSession.getParseResult({
                documentUri,
                documentVersion: document.version,
                sql,
                databaseKind,
            });
            if (
                parseResult.lexResult.errors.length === 0
                && parseResult.cst
                && parseResult.actionableParserErrors.length === 0
            ) {
                const sqlSymbols = collectSqlSymbolUsagesFromCst(parseResult.cst);
                return this.sortSymbolsByDefinitionOffset([
                    ...macroSymbols,
                    ...sqlSymbols,
                ]);
            }
        }

        const sqlSymbols = collectSqlSymbolUsages(sql);
        return this.sortSymbolsByDefinitionOffset([
            ...macroSymbols,
            ...sqlSymbols,
        ]);
    }

    private collectMacroVariableSymbols(sql: string): OutlineSymbol[] {
        const declarations: MacroDeclaration[] = [];
        const declarationPattern = /^\s*%let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/gim;

        for (const match of sql.matchAll(declarationPattern)) {
            const name = match[1];
            if (!name || match.index === undefined) {
                continue;
            }

            const nameStart = match.index + match[0].lastIndexOf(name);
            declarations.push({
                normalizedName: this.normalizeMacroName(name),
                startOffset: nameStart,
                symbol: {
                    kind: 'macro_variable',
                    name,
                    occurrences: [
                        {
                            kind: 'macro_variable',
                            role: 'definition',
                            startOffset: nameStart,
                            endOffset: nameStart + name.length,
                            text: name,
                        },
                    ],
                },
            });
        }

        this.collectMacroVariableReferences(sql, declarations);
        return declarations.map(declaration => declaration.symbol);
    }

    private collectMacroVariableReferences(sql: string, declarations: MacroDeclaration[]): void {
        if (declarations.length === 0) {
            return;
        }

        for (const reference of this.scanMacroReferences(sql)) {
            const normalizedName = this.normalizeMacroName(reference.name);
            const matchingDeclarations = declarations.filter(candidate =>
                candidate.normalizedName === normalizedName
                && candidate.startOffset < reference.startOffset
            );
            const declaration = matchingDeclarations[matchingDeclarations.length - 1];

            declaration?.symbol.occurrences.push({
                kind: 'macro_variable',
                role: 'reference',
                startOffset: reference.startOffset,
                endOffset: reference.endOffset,
                text: reference.text,
            });
        }
    }

    private scanMacroReferences(sql: string): Array<{ name: string; startOffset: number; endOffset: number; text: string }> {
        const references: Array<{ name: string; startOffset: number; endOffset: number; text: string }> = [];
        let i = 0;

        while (i < sql.length) {
            if (sql[i] === '-' && sql[i + 1] === '-') {
                i += 2;
                while (i < sql.length && sql[i] !== '\n') {
                    i++;
                }
                continue;
            }

            if (sql[i] === '/' && sql[i + 1] === '*') {
                i += 2;
                while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
                    i++;
                }
                i += 2;
                continue;
            }

            if (sql[i] === "'") {
                i = this.skipQuotedLiteral(sql, i, "'");
                continue;
            }

            if (sql[i] === '"') {
                i = this.skipQuotedLiteral(sql, i, '"');
                continue;
            }

            const reference = this.readMacroReferenceAt(sql, i);
            if (reference) {
                references.push(reference);
                i = reference.endOffset;
                continue;
            }

            i++;
        }

        return references;
    }

    private readMacroReferenceAt(
        sql: string,
        offset: number,
    ): { name: string; startOffset: number; endOffset: number; text: string } | undefined {
        const ampersandMatch = sql.slice(offset).match(/^&([A-Za-z_][A-Za-z0-9_]*)/);
        if (ampersandMatch?.[1]) {
            return {
                name: ampersandMatch[1],
                startOffset: offset,
                endOffset: offset + ampersandMatch[0].length,
                text: ampersandMatch[0],
            };
        }

        const bracedMatch = sql.slice(offset).match(/^\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/);
        if (bracedMatch?.[1]) {
            return {
                name: bracedMatch[1],
                startOffset: offset,
                endOffset: offset + bracedMatch[0].length,
                text: bracedMatch[0],
            };
        }

        const dollarMatch = sql.slice(offset).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
        if (dollarMatch?.[1]) {
            return {
                name: dollarMatch[1],
                startOffset: offset,
                endOffset: offset + dollarMatch[0].length,
                text: dollarMatch[0],
            };
        }

        return undefined;
    }

    private skipQuotedLiteral(sql: string, startOffset: number, quote: "'" | '"'): number {
        let offset = startOffset + 1;
        while (offset < sql.length) {
            if (sql[offset] === quote) {
                if (sql[offset + 1] === quote) {
                    offset += 2;
                    continue;
                }
                return offset + 1;
            }
            offset++;
        }
        return offset;
    }

    private normalizeMacroName(name: string): string {
        return name.toUpperCase();
    }

    private sortSymbolsByDefinitionOffset(symbols: OutlineSymbol[]): OutlineSymbol[] {
        return [...symbols].sort(
            (left, right) => this.getSymbolStartOffset(left) - this.getSymbolStartOffset(right),
        );
    }

    private getSymbolStartOffset(symbol: OutlineSymbol): number {
        const definition = symbol.occurrences.find(occ => occ.role === 'definition');
        return definition?.startOffset ?? symbol.occurrences[0]?.startOffset ?? 0;
    }

    private createDocumentSymbol(document: vscode.TextDocument, symbol: OutlineSymbol): vscode.DocumentSymbol {
        const definition = symbol.occurrences.find(occ => occ.role === 'definition');
        
        if (!definition) {
            const firstOccurrence = symbol.occurrences[0];
            const range = this.offsetsToRange(document, firstOccurrence.startOffset, firstOccurrence.endOffset);
            return new vscode.DocumentSymbol(
                symbol.name,
                this.getSymbolDescription(symbol),
                this.getSymbolKind(symbol.kind),
                range,
                range
            );
        }

        const definitionRange = this.offsetsToRange(document, definition.startOffset, definition.endOffset);
        
        let minOffset = definition.startOffset;
        let maxOffset = definition.endOffset;
        for (const occurrence of symbol.occurrences) {
            minOffset = Math.min(minOffset, occurrence.startOffset);
            maxOffset = Math.max(maxOffset, occurrence.endOffset);
        }
        const fullRange = this.offsetsToRange(document, minOffset, maxOffset);

        const documentSymbol = new vscode.DocumentSymbol(
            symbol.name,
            this.getSymbolDescription(symbol),
            this.getSymbolKind(symbol.kind),
            fullRange,
            definitionRange
        );

        const references = symbol.occurrences.filter(occ => occ.role === 'reference');
        if (references.length > 0) {
            documentSymbol.children = references.map(ref => {
                const refRange = this.offsetsToRange(document, ref.startOffset, ref.endOffset);
                const refSymbol = new vscode.DocumentSymbol(
                    ref.text,
                    'Reference',
                    vscode.SymbolKind.Field,
                    refRange,
                    refRange
                );
                return refSymbol;
            });
        }

        return documentSymbol;
    }

    private getSymbolKind(kind: string): vscode.SymbolKind {
        switch (kind) {
            case 'cte':
                return vscode.SymbolKind.Struct;
            case 'table_alias':
                return vscode.SymbolKind.Variable;
            case 'table':
                return vscode.SymbolKind.Class;
            case 'macro_variable':
            case 'local_variable':
                return vscode.SymbolKind.Variable;
            default:
                return vscode.SymbolKind.Object;
        }
    }

    private getSymbolDescription(symbol: OutlineSymbol): string {
        const refCount = symbol.occurrences.filter(occ => occ.role === 'reference').length;
        const kindLabel = this.getKindLabel(symbol.kind);
        return `${kindLabel} (${refCount} reference${refCount !== 1 ? 's' : ''})`;
    }

    private getKindLabel(kind: string): string {
        switch (kind) {
            case 'cte':
                return 'CTE';
            case 'table_alias':
                return 'Alias';
            case 'table':
                return 'Table';
            case 'macro_variable':
                return 'Macro variable';
            case 'local_variable':
                return 'PL/SQL local variable';
            default:
                return 'Symbol';
        }
    }

    private offsetsToRange(document: vscode.TextDocument, startOffset: number, endOffset: number): vscode.Range {
        const start = document.positionAt(startOffset);
        const end = document.positionAt(endOffset);
        return new vscode.Range(start, end);
    }
}
