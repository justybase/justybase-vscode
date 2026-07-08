import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import {
    buildCatalogUsageSearchPatterns,
    findCatalogUsagesInText,
    resolveCatalogObjectAtOffset,
} from '../server/catalogNavigation';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';

/**
 * Workspace-wide find usages for catalog objects (Shift+F12 on qualified names).
 */
export class CatalogReferenceProvider implements vscode.ReferenceProvider {
    constructor(private readonly connectionManager: ConnectionManager) {}

    public async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.ReferenceContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.Location[]> {
        const sql = document.getText();
        const offset = document.offsetAt(position);

        const catalogObject = resolveCatalogObjectAtOffset(
            sql,
            offset,
            this.connectionManager.getExecutionDatabaseKind(document.uri.toString()),
            this.connectionManager.getDocumentDatabase(document.uri.toString()) ??
                undefined,
            (await this.connectionManager.getEffectiveSchema(document.uri.toString())) ??
                undefined,
        );
        if (!catalogObject) {
            return [];
        }

        const patterns = buildCatalogUsageSearchPatterns(catalogObject);
        const locations: vscode.Location[] = [];

        const sqlDocuments = vscode.workspace.textDocuments.filter((doc) =>
            isSqlAuthoringLanguageId(doc.languageId),
        );

        for (const doc of sqlDocuments) {
            if (token.isCancellationRequested) {
                break;
            }
            const matches = findCatalogUsagesInText(doc.getText(), patterns);
            for (const match of matches) {
                const start = doc.positionAt(match.start);
                const end = doc.positionAt(match.end);
                locations.push(new vscode.Location(doc.uri, new vscode.Range(start, end)));
            }
        }

        const workspaceFiles = await vscode.workspace.findFiles(
            '**/*.{sql,nzsql}',
            '**/node_modules/**',
            200,
        );
        for (const fileUri of workspaceFiles) {
            if (token.isCancellationRequested) {
                break;
            }
            if (sqlDocuments.some((doc) => doc.uri.toString() === fileUri.toString())) {
                continue;
            }
            try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const matches = findCatalogUsagesInText(doc.getText(), patterns);
                for (const match of matches) {
                    const start = doc.positionAt(match.start);
                    const end = doc.positionAt(match.end);
                    locations.push(new vscode.Location(doc.uri, new vscode.Range(start, end)));
                }
            } catch {
                // Skip unreadable files
            }
        }

        return locations;
    }
}
