import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { DocumentParseSession } from '../sqlParser/documentParseSession';
import type { SqlStatementsParseResult } from '../sqlParser/parsingRuntime';
import { buildSqlLocalShadowContext, type SqlLocalShadowContext } from './parsers/sqlLocalShadowContext';
import { isOffsetInSqlComment } from '../sql/sqlSourceScan';

/**
 * Provides Ctrl+click DocumentLinks for schema object references:
 *   - DB..TABLE         (Netezza double-dot notation)
 *   - SCHEMA.TABLE      (schema-qualified table)
 *   - DB.SCHEMA.TABLE   (fully qualified)
 *   - TABLE             (unqualified table in FROM/JOIN context)
 *
 * Ctrl+click reveals the object in the schema tree only (no DDL).
 * F12 / Go to Table DDL is handled by netezza.goToCatalogDdl.
 *
 * PERFORMANCE:
 * - Regex scan is O(n) over document length, done once.
 * - Identifier parsing is O(1) per match (string ops, no tokenization).
 * - One semantic scope per call for document-wide alias detection (O(1) parse via session).
 * - CTE filtering is statement-scoped with at most one scope lookup per statement.
 */
export class NetezzaDocumentLinkProvider implements vscode.DocumentLinkProvider {
    constructor(
        private readonly parseSession?: DocumentParseSession,
        private readonly connectionManager?: Pick<
            ConnectionManager,
            'getExecutionDatabaseKind'
        >,
    ) {}

    public provideDocumentLinks(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.DocumentLink[] {
        const links: vscode.DocumentLink[] = [];
        const text = document.getText();
        const documentUri = document.uri.toString();
        const databaseKind = this.connectionManager?.getExecutionDatabaseKind?.(
            documentUri,
        );
        let parseResult: SqlStatementsParseResult | undefined;
        if (this.parseSession) {
            try {
                parseResult = this.parseSession.getParseResult({
                    documentUri,
                    documentVersion: document.version,
                    sql: text,
                    databaseKind,
                });
            } catch {
                // Fall back — dotted and regex-based links still work without parse.
            }
        }

        const shadowContext = buildSqlLocalShadowContext({
            documentUri,
            documentVersion: document.version,
            sql: text,
            databaseKind,
            parseSession: this.parseSession,
            parseResult,
        });
        const documentAliasNames = shadowContext.aliasNames;

        const linkedRanges = this.collectDottedLinks(
            text,
            links,
            document,
            documentAliasNames,
        );
        this.collectSingleWordTableLinks(
            text,
            links,
            document,
            shadowContext,
            linkedRanges,
        );

        return links;
    }

    /**
     * Match dotted identifiers and parse them directly from the regex match.
     */
    private collectDottedLinks(
        text: string,
        links: vscode.DocumentLink[],
        document: vscode.TextDocument,
        aliasNames: ReadonlySet<string>,
    ): Set<string> {
        const linkedRanges = new Set<string>();
        const regex = /[\w"\u00c0-\u024f]+(\.[\w"\u00c0-\u024f]*)+/g;

        let match;
        while ((match = regex.exec(text)) !== null) {
            const matchedText = match[0];
            if (isOffsetInSqlComment(text, match.index)) {
                continue;
            }
            const objectInfo = this.parseIdentifier(matchedText);

            if (!objectInfo) { continue; }

            const parts = matchedText.split('.');
            if (
                parts.length === 2 &&
                !objectInfo.database &&
                !this.isDdlObjectNameContext(text, match.index) &&
                aliasNames.has(parts[0].replace(/^"|"$/g, '').toUpperCase())
            ) {
                continue;
            }

            const startPos = document.positionAt(match.index);
            const endPos = document.positionAt(match.index + matchedText.length);
            const range = new vscode.Range(startPos, endPos);

            const link = this.createLink(matchedText, objectInfo, range);
            if (link) {
                links.push(link);
                linkedRanges.add(`${match.index}:${match.index + matchedText.length}`);
            }
        }

        return linkedRanges;
    }

    /**
     * Unqualified table names in catalog-object contexts — reveal in schema on Ctrl+click.
     */
    private collectSingleWordTableLinks(
        text: string,
        links: vscode.DocumentLink[],
        document: vscode.TextDocument,
        shadowContext: SqlLocalShadowContext,
        linkedRanges: Set<string>,
    ): void {
        const regex = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|VIEW|CALL|EXEC(?:UTE)?(?:\s+PROCEDURE)?)\s+([\w"\u00c0-\u024f]+)/gi;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
            const matchedIdentifier = match[1];
            if (!matchedIdentifier) {
                continue;
            }

            const start = match.index + match[0].lastIndexOf(matchedIdentifier);
            if (isOffsetInSqlComment(text, start)) {
                continue;
            }
            const end = start + matchedIdentifier.length;
            const cleanName = matchedIdentifier.replace(/^"|"$/g, '');
            const contextText = match[0].slice(0, match[0].lastIndexOf(matchedIdentifier));
            if (/^\s*EXEC(?:UTE)?\b/i.test(contextText) && cleanName.toUpperCase() === 'AS') {
                continue;
            }

            const rangeKey = `${start}:${end}`;
            if (linkedRanges.has(rangeKey)) {
                continue;
            }

            if (text[start - 1] === '.' || text[end] === '.') {
                continue;
            }

            if (shadowContext.isShadowedAtOffset(cleanName, start)) {
                continue;
            }

            const objectInfo = {
                name: matchedIdentifier.replace(/^"|"$/g, ''),
            };
            const range = new vscode.Range(
                document.positionAt(start),
                document.positionAt(end),
            );
            const link = this.createLink(matchedIdentifier, objectInfo, range);
            if (link) {
                links.push(link);
            }
        }
    }

    private parseIdentifier(
        identifier: string
    ): { database?: string; schema?: string; name: string } | null {
        const clean = (s: string) => s.replace(/^"|"$/g, '');

        const doubleDot = identifier.indexOf('..');
        if (doubleDot !== -1) {
            return {
                database: clean(identifier.substring(0, doubleDot)),
                name: clean(identifier.substring(doubleDot + 2))
            };
        }

        const parts = identifier.split('.');
        if (parts.length === 1) {
            return { name: clean(parts[0]) };
        }
        if (parts.length === 2) {
            return { schema: clean(parts[0]), name: clean(parts[1]) };
        }
        if (parts.length === 3) {
            return {
                database: clean(parts[0]),
                schema: clean(parts[1]),
                name: clean(parts[2])
            };
        }
        return null;
    }

    private createLink(
        matchedText: string,
        objectInfo: { database?: string; schema?: string; name: string },
        range: vscode.Range
    ): vscode.DocumentLink | undefined {
        const isQuoted = matchedText.includes('"');
        const args: { name: string; schema?: string; database?: string } = {
            name: isQuoted ? objectInfo.name : objectInfo.name.toUpperCase()
        };

        if (objectInfo.schema) {
            args.schema = isQuoted ? objectInfo.schema : objectInfo.schema.toUpperCase();
        }

        if (objectInfo.database) {
            args.database = isQuoted ? objectInfo.database : objectInfo.database.toUpperCase();
        }

        const uri = vscode.Uri.parse(
            `command:netezza.revealInSchema?${encodeURIComponent(JSON.stringify(args))}`
        );

        const link = new vscode.DocumentLink(range, uri);
        link.tooltip = `Reveal ${objectInfo.name} in Schema`;
        return link;
    }

    private isDdlObjectNameContext(text: string, matchIndex: number): boolean {
        const prefix = text.slice(Math.max(0, matchIndex - 80), matchIndex);
        return /\b(?:CREATE|ALTER|DROP|TRUNCATE|RENAME)\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|NICKNAME|EXTERNAL\s+TABLE)\s+$/i.test(
            prefix,
        );
    }
}
