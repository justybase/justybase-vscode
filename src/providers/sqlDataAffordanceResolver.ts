import * as vscode from 'vscode';
import type { IToken } from 'chevrotain';
import type { DatabaseKind } from '../contracts/database';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import { getCachedColumnsFromMetadataCache } from '../metadata/columnCacheLookup';
import type { ColumnMetadata, ObjectWithSchema, TableMetadata } from '../metadata/types';
import { SqlLexer } from '../sqlParser';
import type { DocumentParseSession } from '../sqlParser/documentParseSession';
import { isLargeScript } from '../sqlParser/validationConfig';
import { buildSqlLocalShadowContext, type SqlLocalShadowContext } from './parsers/sqlLocalShadowContext';
import { formatQualifiedObjectPathForDisplay } from '../utils/identifierUtils';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';

type TableReferenceSource =
    | 'FROM'
    | 'JOIN'
    | 'INSERT'
    | 'UPDATE'
    | 'DELETE'
    | 'MERGE_TARGET'
    | 'MERGE_SOURCE';

type ObjectNotation = 'database-schema-table' | 'database-table' | 'schema-table' | 'table';

interface ParsedTableReference {
    source: TableReferenceSource;
    notation: ObjectNotation;
    databaseName?: string;
    schemaName?: string;
    tableName: string;
    startOffset: number;
    endOffset: number;
    tableStartOffset: number;
    tableEndOffset: number;
}

interface CachedParseEntry {
    version: number;
    candidates: ParsedTableReference[];
}

export interface ViewTableDataCommandArgs {
    documentUri: string;
    tableName: string;
    schemaName?: string;
    databaseName?: string;
}

export interface ResolvedSqlDataReference {
    source: TableReferenceSource;
    notation: ObjectNotation;
    objectType: 'TABLE' | 'VIEW';
    databaseName: string;
    schemaName?: string;
    tableName: string;
    resolvedPath: string;
    description?: string;
    columnCount?: number;
    range: vscode.Range;
    commandArgs: ViewTableDataCommandArgs;
}

interface ParsedTableRefResult {
    candidate: ParsedTableReference;
    nextIndex: number;
}

interface ResolveContext {
    documentUri: string;
    connectionName: string;
    databaseKind?: DatabaseKind;
    effectiveDatabase?: string;
    objectsByDatabaseCache: Map<string, Map<string, ObjectWithSchema[]>>;
    shadowContext: SqlLocalShadowContext;
}

const ADMIN_SCHEMA = 'ADMIN';

export class SqlDataAffordanceResolver implements vscode.Disposable {
    private readonly _parseCache = new Map<string, CachedParseEntry>();

    constructor(
        private readonly _metadataCache: MetadataCache,
        private readonly _connectionManager: ConnectionManager,
        private readonly _parseSession?: DocumentParseSession,
    ) {}

    public dispose(): void {
        this._parseCache.clear();
    }

    public clear(documentUri?: vscode.Uri): void {
        if (!documentUri) {
            this._parseCache.clear();
            return;
        }

        this._parseCache.delete(documentUri.toString());
    }

    public isSupportedDocument(document: vscode.TextDocument): boolean {
        return isSqlAuthoringLanguageId(document.languageId);
    }

    public async getResolvedReferences(document: vscode.TextDocument): Promise<ResolvedSqlDataReference[]> {
        const resolveContext = await this.buildResolveContext(document);
        if (!resolveContext) {
            return [];
        }

        const parsedReferences = this.getParsedReferences(document);
        if (parsedReferences.length === 0) {
            return [];
        }

        const resolvedReferences: ResolvedSqlDataReference[] = [];
        for (const rawReference of parsedReferences) {
            const resolved = this.resolveReference(document, rawReference, resolveContext);
            if (resolved) {
                resolvedReferences.push(resolved);
            }
        }

        return this.dedupeResolvedReferences(resolvedReferences);
    }

    public async getReferenceAtPosition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<ResolvedSqlDataReference | undefined> {
        if (!this.isSupportedDocument(document)) {
            return undefined;
        }

        if (isLargeScript(document.getText().length)) {
            return undefined;
        }

        const offset = document.offsetAt(position);
        const rawReference = this.findParsedReferenceAtOffset(document, offset);
        if (!rawReference) {
            return undefined;
        }

        const resolveContext = await this.buildResolveContext(document);
        if (!resolveContext) {
            return undefined;
        }

        return this.resolveReference(document, rawReference, resolveContext);
    }

    private async buildResolveContext(
        document: vscode.TextDocument,
    ): Promise<ResolveContext | undefined> {
        if (!this.isSupportedDocument(document)) {
            return undefined;
        }

        const documentUri = document.uri.toString();
        const connectionName =
            this._connectionManager.getConnectionForExecution(documentUri)
            || this._connectionManager.getActiveConnectionName()
            || undefined;
        if (!connectionName) {
            return undefined;
        }

        const databaseKind =
            this._connectionManager.getExecutionDatabaseKind?.(documentUri, connectionName)
            ?? this._connectionManager.getConnectionDatabaseKind?.(connectionName);
        const effectiveDatabase = (await this._connectionManager.getEffectiveDatabase(documentUri)) || undefined;
        const sql = document.getText();
        const shadowContext = buildSqlLocalShadowContext({
            documentUri,
            documentVersion: document.version,
            sql,
            databaseKind,
            parseSession: this._parseSession,
        });

        return {
            documentUri,
            connectionName,
            databaseKind,
            effectiveDatabase,
            objectsByDatabaseCache: new Map<string, Map<string, ObjectWithSchema[]>>(),
            shadowContext,
        };
    }

    private findParsedReferenceAtOffset(
        document: vscode.TextDocument,
        offset: number,
    ): ParsedTableReference | undefined {
        return this.getParsedReferences(document).find(
            (reference) =>
                offset >= reference.tableStartOffset
                && offset <= reference.tableEndOffset,
        );
    }

    private resolveReference(
        document: vscode.TextDocument,
        rawReference: ParsedTableReference,
        context: ResolveContext,
    ): ResolvedSqlDataReference | undefined {
        const reference = this.normalizeReferenceForDialect(rawReference, context.databaseKind);
        if (
            !reference.schemaName
            && this.isShadowedByLocalDefinition(reference, context.shadowContext)
        ) {
            return undefined;
        }

        const databaseName = reference.databaseName || context.effectiveDatabase;
        if (!databaseName) {
            return undefined;
        }

        const objectsByName = this.getObjectsByName(
            context.connectionName,
            databaseName,
            context.objectsByDatabaseCache,
        );
        const resolvedObject = this.resolveObject(objectsByName, reference.schemaName, reference.tableName);
        if (!resolvedObject) {
            return undefined;
        }

        const objectName = this.extractObjectName(resolvedObject.item) || reference.tableName;
        const schemaName = resolvedObject.schema || reference.schemaName;
        const objectType = this.toObjectType(resolvedObject.item);
        if (!objectType) {
            return undefined;
        }

        const columnCount = this.getCachedColumns(
            context.connectionName,
            databaseName,
            schemaName,
            objectName,
            context.databaseKind,
        )?.length;
        const range = new vscode.Range(
            document.positionAt(reference.tableStartOffset),
            document.positionAt(reference.tableEndOffset + 1)
        );

        return {
            source: reference.source,
            notation: reference.notation,
            objectType,
            databaseName,
            schemaName,
            tableName: objectName,
            resolvedPath: this.formatObjectPath(databaseName, schemaName, objectName, context.databaseKind),
            description: this.normalizeDescription(resolvedObject.description),
            columnCount,
            range,
            commandArgs: {
                documentUri: context.documentUri,
                databaseName,
                schemaName,
                tableName: objectName
            }
        };
    }

    private getParsedReferences(document: vscode.TextDocument): ParsedTableReference[] {
        const cacheKey = document.uri.toString();
        const cached = this._parseCache.get(cacheKey);
        if (cached && cached.version === document.version) {
            return cached.candidates;
        }

        const candidates = this.parseReferences(document.getText());
        this._parseCache.set(cacheKey, {
            version: document.version,
            candidates
        });

        if (this._parseCache.size > 50) {
            const firstKey = this._parseCache.keys().next().value;
            if (firstKey) {
                this._parseCache.delete(firstKey);
            }
        }

        return candidates;
    }

    private parseReferences(sql: string): ParsedTableReference[] {
        const lexResult = SqlLexer.tokenize(sql);
        const tokens = lexResult.tokens;
        if (tokens.length === 0) {
            return [];
        }

        const references: ParsedTableReference[] = [];
        let mergeStatementActive = false;

        for (let index = 0; index < tokens.length; index++) {
            const tokenName = tokens[index].tokenType.name;

            if (tokenName === 'Semicolon') {
                mergeStatementActive = false;
                continue;
            }

            if (tokenName === 'Merge') {
                mergeStatementActive = true;
                continue;
            }

            let parsedResult: ParsedTableRefResult | undefined;

            switch (tokenName) {
                case 'From':
                    parsedResult = this.parseTableReference(tokens, index + 1, 'FROM');
                    break;
                case 'Join':
                    parsedResult = this.parseTableReference(tokens, index + 1, 'JOIN');
                    break;
                case 'Update':
                    parsedResult = this.parseTableReference(tokens, index + 1, 'UPDATE');
                    break;
                case 'Delete':
                    if (tokens[index + 1]?.tokenType.name === 'From') {
                        parsedResult = this.parseTableReference(tokens, index + 2, 'DELETE');
                    }
                    break;
                case 'Insert':
                    if (tokens[index + 1]?.tokenType.name === 'Into') {
                        parsedResult = this.parseTableReference(tokens, index + 2, 'INSERT');
                    }
                    break;
                case 'Into':
                    if (mergeStatementActive) {
                        parsedResult = this.parseTableReference(tokens, index + 1, 'MERGE_TARGET');
                    }
                    break;
                case 'Using':
                    if (mergeStatementActive) {
                        parsedResult = this.parseTableReference(tokens, index + 1, 'MERGE_SOURCE');
                    }
                    break;
                default:
                    break;
            }

            if (parsedResult?.candidate.tableName) {
                references.push(parsedResult.candidate);
                index = Math.max(index, parsedResult.nextIndex - 1);
            } else if (parsedResult) {
                index = Math.max(index, parsedResult.nextIndex - 1);
            }
        }

        return references;
    }

    private parseTableReference(
        tokens: IToken[],
        startIndex: number,
        source: TableReferenceSource
    ): ParsedTableRefResult | undefined {
        if (startIndex >= tokens.length) {
            return undefined;
        }

        if (tokens[startIndex].tokenType.name === 'LParen') {
            const subqueryEnd = this.consumeBalancedParentheses(tokens, startIndex);
            if (subqueryEnd === undefined) {
                return undefined;
            }

            let nextIndex = subqueryEnd + 1;
            if (tokens[nextIndex]?.tokenType.name === 'As') {
                nextIndex += 1;
            }
            if (this.isIdentifierToken(tokens[nextIndex]) && !this.isAliasBoundaryToken(tokens[nextIndex])) {
                nextIndex += 1;
            }

            return {
                candidate: {
                    source,
                    notation: 'table',
                    tableName: '',
                    startOffset: 0,
                    endOffset: 0,
                    tableStartOffset: 0,
                    tableEndOffset: 0
                },
                nextIndex
            };
        }

        const parsedResult =
            this.parseTableWithFinalReference(tokens, startIndex, source) ||
            this.parseQualifiedTableName(tokens, startIndex, source);
        if (!parsedResult || !parsedResult.candidate.tableName) {
            return undefined;
        }

        let nextIndex = parsedResult.nextIndex;
        if (tokens[nextIndex]?.tokenType.name === 'As') {
            nextIndex += 1;
        }
        if (this.isIdentifierToken(tokens[nextIndex]) && !this.isAliasBoundaryToken(tokens[nextIndex])) {
            nextIndex += 1;
        }

        return {
            candidate: parsedResult.candidate,
            nextIndex
        };
    }

    private parseTableWithFinalReference(
        tokens: IToken[],
        startIndex: number,
        source: TableReferenceSource
    ): ParsedTableRefResult | undefined {
        if (
            tokens[startIndex]?.tokenType.name !== 'Table' ||
            tokens[startIndex + 1]?.tokenType.name !== 'With' ||
            tokens[startIndex + 2]?.tokenType.name !== 'Final' ||
            tokens[startIndex + 3]?.tokenType.name !== 'LParen'
        ) {
            return undefined;
        }

        const functionName = this.parseQualifiedTableName(tokens, startIndex + 4, source);
        if (!functionName || tokens[functionName.nextIndex]?.tokenType.name !== 'LParen') {
            return undefined;
        }

        const functionArgsEnd = this.consumeBalancedParentheses(tokens, functionName.nextIndex);
        if (functionArgsEnd === undefined || tokens[functionArgsEnd]?.tokenType.name !== 'RParen') {
            return undefined;
        }

        return {
            candidate: functionName.candidate,
            nextIndex: functionArgsEnd + 1
        };
    }

    private parseQualifiedTableName(
        tokens: IToken[],
        startIndex: number,
        source: TableReferenceSource
    ): ParsedTableRefResult | undefined {
        if (!this.isIdentifierToken(tokens[startIndex])) {
            return undefined;
        }

        const identifierTokens: IToken[] = [tokens[startIndex]];
        let dotCount = 0;
        let index = startIndex + 1;

        while (index < tokens.length && tokens[index].tokenType.name === 'Dot') {
            dotCount += 1;
            index += 1;

            if (index < tokens.length && tokens[index].tokenType.name === 'Dot') {
                dotCount += 1;
                index += 1;
            }

            if (!this.isIdentifierToken(tokens[index])) {
                break;
            }

            identifierTokens.push(tokens[index]);
            index += 1;
        }

        const names = identifierTokens.map(token => this.normalizeTokenText(token));
        const notation =
            names.length === 3
                ? 'database-schema-table'
                : names.length === 2
                    ? dotCount >= 2
                        ? 'database-table'
                        : 'schema-table'
                    : 'table';

        const candidate: ParsedTableReference = {
            source,
            notation,
            databaseName: notation === 'database-schema-table' || notation === 'database-table' ? names[0] : undefined,
            schemaName: notation === 'database-schema-table' || notation === 'schema-table' ? names[names.length - 2] : undefined,
            tableName: names[names.length - 1],
            startOffset: identifierTokens[0].startOffset ?? 0,
            endOffset: identifierTokens[identifierTokens.length - 1].endOffset ?? (identifierTokens[0].startOffset ?? 0),
            tableStartOffset: identifierTokens[identifierTokens.length - 1].startOffset ?? 0,
            tableEndOffset:
                identifierTokens[identifierTokens.length - 1].endOffset
                ?? (identifierTokens[identifierTokens.length - 1].startOffset ?? 0)
        };

        return {
            candidate,
            nextIndex: index
        };
    }

    private consumeBalancedParentheses(tokens: IToken[], startIndex: number): number | undefined {
        if (tokens[startIndex]?.tokenType.name !== 'LParen') {
            return undefined;
        }

        let depth = 1;
        let index = startIndex + 1;
        while (index < tokens.length) {
            const tokenName = tokens[index].tokenType.name;
            if (tokenName === 'LParen') {
                depth += 1;
            } else if (tokenName === 'RParen') {
                depth -= 1;
                if (depth === 0) {
                    return index;
                }
            }
            index += 1;
        }

        return undefined;
    }

    private getObjectsByName(
        connectionName: string,
        databaseName: string,
        cache: Map<string, Map<string, ObjectWithSchema[]>>
    ): Map<string, ObjectWithSchema[]> {
        const cacheKey = `${connectionName}|${databaseName}`.toUpperCase();
        const cached = cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const objectsByName = new Map<string, ObjectWithSchema[]>();
        const objects = this._metadataCache.getObjectsWithSchema(connectionName, databaseName);
        for (const objectInfo of objects) {
            const objectType = this.toObjectType(objectInfo.item);
            const objectName = this.extractObjectName(objectInfo.item);
            if (!objectType || !objectName) {
                continue;
            }

            const key = objectName.toUpperCase();
            const matches = objectsByName.get(key) || [];
            matches.push(objectInfo);
            objectsByName.set(key, matches);
        }

        cache.set(cacheKey, objectsByName);
        return objectsByName;
    }

    private resolveObject(
        objectsByName: Map<string, ObjectWithSchema[]>,
        schemaName: string | undefined,
        tableName: string
    ): ObjectWithSchema | undefined {
        const matches = objectsByName.get(tableName.toUpperCase()) || [];
        if (matches.length === 0) {
            return undefined;
        }

        if (schemaName) {
            return matches.find(match => match.schema.toUpperCase() === schemaName.toUpperCase());
        }

        if (matches.length === 1) {
            return matches[0];
        }

        const adminMatch = matches.find(match => match.schema.toUpperCase() === ADMIN_SCHEMA);
        return adminMatch;
    }

    private getCachedColumns(
        connectionName: string,
        databaseName: string,
        schemaName: string | undefined,
        tableName: string,
        databaseKind?: DatabaseKind,
    ): ColumnMetadata[] | undefined {
        return getCachedColumnsFromMetadataCache(
            this._metadataCache,
            connectionName,
            databaseName,
            schemaName,
            tableName,
            databaseKind,
        );
    }

    private isShadowedByLocalDefinition(
        reference: ParsedTableReference,
        shadowContext: SqlLocalShadowContext,
    ): boolean {
        if (reference.notation !== 'table') {
            return false;
        }

        return shadowContext.isShadowedAtOffset(
            reference.tableName,
            reference.tableStartOffset,
        );
    }

    private dedupeResolvedReferences(references: ResolvedSqlDataReference[]): ResolvedSqlDataReference[] {
        const deduped = new Map<string, ResolvedSqlDataReference>();
        for (const reference of references) {
            const key = `${reference.range.start.line}:${reference.range.start.character}:${reference.range.end.line}:${reference.range.end.character}`;
            if (!deduped.has(key)) {
                deduped.set(key, reference);
            }
        }
        return Array.from(deduped.values());
    }

    private normalizeTokenText(token: IToken): string {
        const text = token.image;
        if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
            return text.slice(1, -1);
        }
        return text;
    }

    private isIdentifierToken(token: IToken | undefined): token is IToken {
        if (!token) {
            return false;
        }
        const tokenName = token.tokenType.name;
        return tokenName === 'Identifier' || tokenName === 'QuotedIdentifier';
    }

    private isAliasBoundaryToken(token: IToken | undefined): boolean {
        if (!token) {
            return true;
        }

        return new Set([
            'Join',
            'Inner',
            'Left',
            'Right',
            'Full',
            'Outer',
            'Cross',
            'Natural',
            'On',
            'Where',
            'GroupBy',
            'OrderBy',
            'Having',
            'Limit',
            'Offset',
            'Union',
            'Intersect',
            'Except',
            'Comma',
            'Semicolon',
            'Using',
            'Set',
            'Values',
            'When'
        ]).has(token.tokenType.name);
    }

    private toObjectType(item: TableMetadata): 'TABLE' | 'VIEW' | undefined {
        const objectType = (item.objType || (item.kind === 18 ? 'VIEW' : 'TABLE')).toUpperCase();
        if (objectType === 'TABLE' || objectType === 'VIEW') {
            return objectType;
        }
        return undefined;
    }

    private extractObjectName(item: TableMetadata): string | undefined {
        if (typeof item.label === 'string') {
            return item.label;
        }
        if (item.label && typeof item.label === 'object' && 'label' in item.label) {
            return item.label.label;
        }
        return item.OBJNAME || item.TABLENAME;
    }

    private normalizeDescription(description: string | undefined): string | undefined {
        if (!description || !description.trim()) {
            return undefined;
        }
        return description.trim();
    }

    private formatObjectPath(
        databaseName: string,
        schemaName: string | undefined,
        tableName: string,
        kind?: string
    ): string {
        return formatQualifiedObjectPathForDisplay(databaseName, schemaName, tableName, kind);
    }

    private normalizeReferenceForDialect(
        reference: ParsedTableReference,
        databaseKind: ReturnType<ConnectionManager['getExecutionDatabaseKind']>
    ): ParsedTableReference {
        if (databaseKind !== 'sqlite' || reference.notation !== 'schema-table' || !reference.schemaName) {
            return reference;
        }

        return {
            ...reference,
            notation: 'database-table',
            databaseName: reference.schemaName,
            schemaName: undefined
        };
    }
}
