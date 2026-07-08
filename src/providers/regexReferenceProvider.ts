import * as vscode from 'vscode';

export class NetezzaRegexReferenceProvider implements vscode.ReferenceProvider {
    public async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.ReferenceContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.Location[] | undefined> {
        const range = document.getWordRangeAtPosition(position);
        if (!range) {
            return undefined;
        }

        const symbol = document.getText(range);
        if (!symbol) {
            return undefined;
        }

        const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedSymbol}\\b`, 'gi');
        const locations: vscode.Location[] = [];

        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
            const line = document.lineAt(lineNumber).text;
            let match: RegExpExecArray | null;
            regex.lastIndex = 0;
            while ((match = regex.exec(line)) !== null) {
                const matchRange = new vscode.Range(
                    new vscode.Position(lineNumber, match.index),
                    new vscode.Position(lineNumber, match.index + symbol.length)
                );
                locations.push(new vscode.Location(document.uri, matchRange));
            }
        }

        // Definition/location enrichment removed together with NetezzaDefinitionProvider.
        // The provider was replaced by NetezzaDocumentLinkProvider which provides
        // clickable links for schema objects without side effects on hover.

        return locations;
    }
}

