import * as vscode from 'vscode';
import { resolveExtensionSqlRenameSymbol } from '../core/extensionDocumentParseSession';
import type { SqlRenameOccurrence } from '../sqlParser/symbols';

function occurrenceToLocation(document: vscode.TextDocument, occurrence: SqlRenameOccurrence): vscode.Location {
    const start = document.positionAt(occurrence.startOffset);
    const end = document.positionAt(occurrence.endOffset);
    return new vscode.Location(document.uri, new vscode.Range(start, end));
}

export class NetezzaParserNavigationProvider implements vscode.DefinitionProvider, vscode.ReferenceProvider {
    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> {
        const symbol = resolveExtensionSqlRenameSymbol(document, document.offsetAt(position));
        if (!symbol) {
            return undefined;
        }

        const definition = symbol.occurrences.find(occurrence => occurrence.role === 'definition') ?? symbol.target;
        return occurrenceToLocation(document, definition);
    }

    public async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.Location[] | undefined> {
        const symbol = resolveExtensionSqlRenameSymbol(document, document.offsetAt(position));
        if (!symbol) {
            return undefined;
        }

        const occurrences = context.includeDeclaration
            ? symbol.occurrences
            : symbol.occurrences.filter(occurrence => occurrence.role !== 'definition');

        return occurrences.map(occurrence => occurrenceToLocation(document, occurrence));
    }
}
