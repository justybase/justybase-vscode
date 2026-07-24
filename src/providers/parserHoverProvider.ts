import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import type { DatabaseKind } from '../contracts/database';
import type { ColumnMetadata } from '../metadata/types';
import { getCachedColumnsFromMetadataCacheAsync } from '../metadata/columnCacheLookup';
import { SqlParser } from '../sql/sqlParser';
import { resolveSqlRenameSymbolWithSession } from '../sqlParser/documentParseSession';
import { resolveSqlRenameSymbol } from '../sqlParser/symbols';
import type { DocumentParseSession } from '../sqlParser/documentParseSession';
import { parseSemanticScopeWithParser } from './parsers/parserSqlContext';
import type { ResolvedSqlDataReference, SqlDataAffordanceResolver } from './sqlDataAffordanceResolver';
import type { AliasInfo, LocalDefinition } from './types';
import { isSqlLanguageClientReadyForDocument, isSqlLanguageClientRunning } from '../activation/lspRegistration';
import { getExtensionConfiguration } from '../compatibility/configuration';
import { formatQualifiedObjectPathForDisplay } from '../utils/identifierUtils';

const IDENTIFIER_RANGE_REGEX = /"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*/;
const MAX_COLUMN_DESCRIPTION_LENGTH = 500;

interface TableHoverContext {
    kind: 'alias' | 'table';
    name: string;
    binding: AliasInfo;
}

export class NetezzaParserHoverProvider implements vscode.HoverProvider {
    constructor(
        private readonly metadataCache: MetadataCache,
        private readonly connectionManager: ConnectionManager,
        private readonly dataAffordanceResolver?: SqlDataAffordanceResolver,
        private readonly parseSession?: DocumentParseSession,
    ) {}

    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const showHoverTooltips = getExtensionConfiguration('sql').get<boolean>('showHoverTooltips', true) ?? true;
        if (!showHoverTooltips) {
            return undefined;
        }

        if (this.dataAffordanceResolver) {
            const dataReference = await this.dataAffordanceResolver.getReferenceAtPosition(document, position);
            if (dataReference) {
                if (isSqlLanguageClientReadyForDocument(document)) {
                    return this.createViewDataActionHover(dataReference);
                }
                return await this.createDataAffordanceHover(document.uri.toString(), dataReference);
            }
        }

        if (isSqlLanguageClientReadyForDocument(document)) {
            return undefined;
        }

        const wordRange = document.getWordRangeAtPosition(position, IDENTIFIER_RANGE_REGEX);
        if (!wordRange) {
            return undefined;
        }

        const wordText = document.getText(wordRange);
        const identifier = this.stripQuotes(wordText).trim();
        if (!identifier) {
            return undefined;
        }

        const fullSql = document.getText();
        const offset = document.offsetAt(position);
        const documentUri = document.uri.toString();
        const documentKey = {
            documentId: documentUri,
            version: document.version,
        };
        const statement = SqlParser.getStatementAtPosition(fullSql, offset, documentKey);
        const statementSql = statement?.sql ?? fullSql;
        const statementRelativeOffset = statement
            ? Math.max(0, offset - statement.start)
            : offset;
        const databaseKind = this.connectionManager.getExecutionDatabaseKind?.(documentUri);

        const parseRequest = {
            documentUri,
            documentVersion: document.version,
            sql: fullSql,
            databaseKind,
        };
        const statementParseRequest = {
            ...parseRequest,
            sql: statementSql,
            cursorOffset: statementRelativeOffset,
        };

        const semanticScope = databaseKind === 'oracle'
            ? this.resolveStatementSemanticScope(parseRequest, fullSql, offset, databaseKind)
            : this.parseSession
                ? this.resolveStatementSemanticScope(statementParseRequest, statementSql, statementRelativeOffset, databaseKind)
                : parseSemanticScopeWithParser(statementSql, statementRelativeOffset, databaseKind);
        const aliasBindings = semanticScope.preferredAliasBindings;
        const localDefinitions = semanticScope.visibleLocalDefinitions;

        const symbol = this.parseSession
            ? this.resolveRenameSymbol(parseRequest, fullSql, offset, databaseKind)
            : resolveSqlRenameSymbol(fullSql, offset, databaseKind);

        const lineText = document.lineAt(position.line).text;
        const beforeWord = lineText.substring(0, wordRange.start.character);
        const afterWord = lineText.substring(wordRange.end.character);
        const qualifier = this.extractQualifierBeforeWord(beforeWord);
        const isQualifierToken = /^\s*\./.test(afterWord);

        const connectionName =
            this.connectionManager.getConnectionForExecution(documentUri)
            || this.connectionManager.getActiveConnectionName()
            || undefined;
        const effectiveDb = (await this.connectionManager.getEffectiveDatabase(documentUri)) || undefined;

        if (qualifier && !isQualifierToken) {
            const columnHover = await this.buildQualifiedColumnHover(
                identifier,
                qualifier,
                aliasBindings,
                localDefinitions,
                connectionName,
                effectiveDb,
                wordRange
            );
            if (columnHover) {
                return columnHover;
            }
        }

        if (symbol?.kind === 'cte') {
            const cteDefinition = this.findLocalDefinition(localDefinitions, symbol.name);
            if (cteDefinition) {
                return this.createLocalDefinitionHover(cteDefinition, wordRange);
            }
        }

        if (symbol?.kind === 'table_alias') {
            const aliasHover = await this.buildAliasHover(
                identifier,
                aliasBindings,
                localDefinitions,
                connectionName,
                effectiveDb,
                wordRange
            );
            if (aliasHover) {
                return aliasHover;
            }
        }

        if (isQualifierToken) {
            const qualifierHover = await this.buildAliasOrTableHover(
                identifier,
                aliasBindings,
                localDefinitions,
                connectionName,
                effectiveDb,
                wordRange
            );
            if (qualifierHover) {
                return qualifierHover;
            }
        }

        const localDefinition = this.findLocalDefinition(localDefinitions, identifier);
        if (localDefinition) {
            return this.createLocalDefinitionHover(localDefinition, wordRange);
        }

        const aliasOrTableHover = await this.buildAliasOrTableHover(
            identifier,
            aliasBindings,
            localDefinitions,
            connectionName,
            effectiveDb,
            wordRange
        );
        if (aliasOrTableHover) {
            return aliasOrTableHover;
        }

        const unqualifiedColumnHover = await this.buildUnqualifiedColumnHover(
            identifier,
            aliasBindings,
            localDefinitions,
            connectionName,
            effectiveDb,
            wordRange,
        );
        if (unqualifiedColumnHover) {
            return unqualifiedColumnHover;
        }

        return undefined;
    }

    private async buildQualifiedColumnHover(
        columnName: string,
        qualifier: string,
        aliasBindings: Map<string, AliasInfo>,
        localDefinitions: LocalDefinition[],
        connectionName: string | undefined,
        effectiveDb: string | undefined,
        range: vscode.Range
    ): Promise<vscode.Hover | undefined> {
        const localSource = this.findLocalDefinition(localDefinitions, qualifier);
        if (localSource) {
            if (localSource.columns.some(column => column.toUpperCase() === columnName.toUpperCase())) {
                return this.createColumnHover(range, columnName, `${localSource.type} \`${localSource.name}\``);
            }
            return undefined;
        }

        const binding = aliasBindings.get(qualifier.toUpperCase());
        if (!binding) {
            return undefined;
        }

        const localAliasTarget = this.findLocalDefinition(localDefinitions, binding.table);
        if (localAliasTarget) {
            if (localAliasTarget.columns.some(column => column.toUpperCase() === columnName.toUpperCase())) {
                return this.createColumnHover(
                    range,
                    columnName,
                    `Alias \`${qualifier}\` → ${localAliasTarget.type} \`${localAliasTarget.name}\``
                );
            }
            return undefined;
        }

        const dbName = binding.db || effectiveDb;
        const databaseKind = this.connectionManager.getConnectionDatabaseKind?.(connectionName);
        const metadataColumns = await this.getCachedColumns(
            connectionName,
            dbName,
            binding.schema,
            binding.table,
            databaseKind,
        );
        if (!metadataColumns) {
            return this.createColumnHover(
                range,
                columnName,
                `Alias \`${qualifier}\` → \`${this.formatObjectPath(dbName, binding.schema, binding.table, databaseKind)}\``
            );
        }

        const metadataColumn = metadataColumns.find(
            column => this.extractColumnName(column).toUpperCase() === columnName.toUpperCase()
        );

        const hover = this.createColumnHover(
            range,
            columnName,
            `Alias \`${qualifier}\` → \`${this.formatObjectPath(dbName, binding.schema, binding.table, databaseKind)}\``,
            metadataColumn
        );
        return hover;
    }

    private async buildAliasHover(
        aliasName: string,
        aliasBindings: Map<string, AliasInfo>,
        localDefinitions: LocalDefinition[],
        connectionName: string | undefined,
        effectiveDb: string | undefined,
        range: vscode.Range
    ): Promise<vscode.Hover | undefined> {
        const localAliasDefinition = this.findLocalDefinition(localDefinitions, aliasName);
        if (localAliasDefinition) {
            const markdown = new vscode.MarkdownString();
            markdown.appendMarkdown(`**Alias** \`${aliasName}\``);
            markdown.appendMarkdown(`\n\n→ ${localAliasDefinition.type} \`${localAliasDefinition.name}\``);
            this.appendLocalColumns(markdown, localAliasDefinition.columns);
            return new vscode.Hover(markdown, range);
        }

        const binding = aliasBindings.get(aliasName.toUpperCase());
        if (!binding) {
            return undefined;
        }

        return await this.createTableHover(
            {
                kind: 'alias',
                name: aliasName,
                binding
            },
            localDefinitions,
            connectionName,
            effectiveDb,
            range
        );
    }

    private async buildAliasOrTableHover(
        identifier: string,
        aliasBindings: Map<string, AliasInfo>,
        localDefinitions: LocalDefinition[],
        connectionName: string | undefined,
        effectiveDb: string | undefined,
        range: vscode.Range
    ): Promise<vscode.Hover | undefined> {
        const binding = aliasBindings.get(identifier.toUpperCase());
        if (!binding) {
            return undefined;
        }

        const context: TableHoverContext = {
            kind: binding.table.toUpperCase() === identifier.toUpperCase() ? 'table' : 'alias',
            name: identifier,
            binding
        };

        return await this.createTableHover(context, localDefinitions, connectionName, effectiveDb, range);
    }

    private async createTableHover(
        context: TableHoverContext,
        localDefinitions: LocalDefinition[],
        connectionName: string | undefined,
        effectiveDb: string | undefined,
        range: vscode.Range
    ): Promise<vscode.Hover> {
        const markdown = new vscode.MarkdownString();
        const dbName = context.binding.db || effectiveDb;
        const databaseKind = this.connectionManager.getConnectionDatabaseKind?.(connectionName);
        const resolvedPath = this.formatObjectPath(dbName, context.binding.schema, context.binding.table, databaseKind);

        if (context.kind === 'alias') {
            markdown.appendMarkdown(`**Alias** \`${context.name}\``);
        } else {
            markdown.appendMarkdown(`**Object** \`${context.name}\``);
        }
        markdown.appendMarkdown(`\n\n→ \`${resolvedPath}\``);

        const localTarget = this.findLocalDefinition(localDefinitions, context.binding.table);
        if (localTarget) {
            markdown.appendMarkdown(`\n\nType: ${localTarget.type}`);
            this.appendLocalColumns(markdown, localTarget.columns);
            return new vscode.Hover(markdown, range);
        }

        const metadataObject =
            connectionName && dbName
                ? this.metadataCache.findObjectWithType(connectionName, dbName, context.binding.schema, context.binding.table)
                : undefined;
        if (metadataObject) {
            markdown.appendMarkdown(`\n\nType: ${this.toObjectTypeLabel(metadataObject.objType)}`);
        }

        const description = this.getCachedTableDescription(
            connectionName,
            dbName,
            metadataObject?.schema || context.binding.schema,
            context.binding.table
        );
        if (description) {
            markdown.appendMarkdown(`\n\nDescription: ${description}`);
        }

        if (!this.shouldSkipColumnsForLsp) {
            const metadataColumns = await this.getCachedColumns(
                connectionName,
                dbName,
                context.binding.schema,
                context.binding.table,
                databaseKind,
            );
            if (metadataColumns) {
                this.appendMetadataColumns(markdown, metadataColumns);
            }
        }

        return new vscode.Hover(markdown, range);
    }

    private async createDataAffordanceHover(documentUri: string, reference: ResolvedSqlDataReference): Promise<vscode.Hover> {
        const markdown = new vscode.MarkdownString();
        const typeLabel = reference.objectType === 'VIEW' ? 'View' : 'Table';
        const connectionName =
            this.connectionManager.getConnectionForExecution(documentUri) || undefined;
        const databaseKind = this.connectionManager.getExecutionDatabaseKind?.(documentUri);
        const cachedColumns = await this.getCachedColumns(
            connectionName,
            reference.databaseName,
            reference.schemaName,
            reference.tableName,
            databaseKind,
        );
        const description =
            reference.description
            || this.getCachedTableDescription(
                this.connectionManager.getConnectionForExecution(documentUri) || undefined,
                reference.databaseName,
                reference.schemaName,
                reference.tableName
            );

        markdown.appendMarkdown(`**${typeLabel}** \`${reference.tableName}\``);
        markdown.appendMarkdown(`\n\nPath: \`${reference.resolvedPath}\``);
        markdown.appendMarkdown(`\n\nCached stats:`);
        markdown.appendMarkdown(`\n- Type: ${typeLabel}`);
        if (reference.schemaName) {
            markdown.appendMarkdown(`\n- Schema: \`${reference.schemaName}\``);
        }
        if (reference.columnCount !== undefined) {
            markdown.appendMarkdown(`\n- Columns: ${reference.columnCount}`);
        }
        if (description) {
            markdown.appendMarkdown(`\n\nDescription: ${description}`);
        }
        if (cachedColumns && !this.shouldSkipColumnsForLsp) {
            this.appendMetadataColumns(markdown, cachedColumns);
        }

        markdown.appendMarkdown(
            `\n\n[View Data](command:netezza.action.viewTableData?${encodeURIComponent(JSON.stringify([reference.commandArgs]))})`
        );
        markdown.isTrusted = true;

        return new vscode.Hover(markdown, reference.range);
    }

    private createViewDataActionHover(reference: ResolvedSqlDataReference): vscode.Hover {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(
            `[View Data](command:netezza.action.viewTableData?${encodeURIComponent(JSON.stringify([reference.commandArgs]))})`
        );
        markdown.isTrusted = true;
        return new vscode.Hover(markdown, reference.range);
    }

    private getUniqueTableBindings(
        aliasBindings: Map<string, AliasInfo>,
    ): AliasInfo[] {
        const seen = new Set<string>();
        const unique: AliasInfo[] = [];
        for (const binding of aliasBindings.values()) {
            const key = `${binding.db ?? ''}|${binding.schema ?? ''}|${binding.table.toUpperCase()}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            unique.push(binding);
        }
        return unique;
    }

    private buildUnqualifiedLocalColumnHover(
        columnName: string,
        localDefinitions: LocalDefinition[],
        range: vscode.Range
    ): vscode.Hover | undefined {
        const matches = localDefinitions.filter(definition =>
            definition.columns.some(column => column.toUpperCase() === columnName.toUpperCase())
        );

        if (matches.length !== 1) {
            return undefined;
        }

        return this.createColumnHover(range, columnName, `${matches[0].type} \`${matches[0].name}\``);
    }

    private async buildUnqualifiedColumnHover(
        columnName: string,
        aliasBindings: Map<string, AliasInfo>,
        localDefinitions: LocalDefinition[],
        connectionName: string | undefined,
        effectiveDb: string | undefined,
        range: vscode.Range,
    ): Promise<vscode.Hover | undefined> {
        const localHover = this.buildUnqualifiedLocalColumnHover(
            columnName,
            localDefinitions,
            range,
        );
        if (localHover) {
            return localHover;
        }

        const uniqueBindings = this.getUniqueTableBindings(aliasBindings);
        const matches: Array<{ binding: AliasInfo; column: ColumnMetadata }> = [];

        for (const binding of uniqueBindings) {
            const dbName = binding.db || effectiveDb;
            if (!dbName) {
                continue;
            }

            const databaseKind = this.connectionManager.getConnectionDatabaseKind?.(connectionName);
            const metadataColumns = await this.getCachedColumns(
                connectionName,
                dbName,
                binding.schema,
                binding.table,
                databaseKind,
            );
            if (!metadataColumns) {
                continue;
            }

            const metadataColumn = metadataColumns.find(
                column => this.extractColumnName(column).toUpperCase() === columnName.toUpperCase(),
            );
            if (metadataColumn) {
                matches.push({ binding, column: metadataColumn });
            }
        }

        if (matches.length !== 1) {
            return undefined;
        }

        const { binding, column } = matches[0];
        const dbName = binding.db || effectiveDb;
        const databaseKind = this.connectionManager.getConnectionDatabaseKind?.(connectionName);
        return this.createColumnHover(
            range,
            columnName,
            `\`${this.formatObjectPath(dbName, binding.schema, binding.table, databaseKind)}\``,
            column,
        );
    }

    private createLocalDefinitionHover(definition: LocalDefinition, range: vscode.Range): vscode.Hover {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${definition.type}** \`${definition.name}\``);
        this.appendLocalColumns(markdown, definition.columns);
        return new vscode.Hover(markdown, range);
    }

    private createColumnHover(
        range: vscode.Range,
        columnName: string,
        sourceLabel: string,
        column?: ColumnMetadata
    ): vscode.Hover {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**Column** \`${columnName}\``);
        markdown.appendMarkdown(`\n\nSource: ${sourceLabel}`);

        if (column) {
            const columnType = this.extractColumnType(column);
            const columnDescription = this.extractColumnDescription(column);
            if (columnType) {
                markdown.appendMarkdown(`\n\nType: \`${columnType}\``);
            }
            if (columnDescription) {
                markdown.appendMarkdown(`\n\nDescription: ${columnDescription}`);
            }
        }

        return new vscode.Hover(markdown, range);
    }

    private get shouldSkipColumnsForLsp(): boolean {
        return isSqlLanguageClientRunning();
    }

    private appendLocalColumns(markdown: vscode.MarkdownString, columns: string[]): void {
        if (columns.length === 0) {
            return;
        }

        const preview = columns.map(column => `\`${column}\``).join(', ');
        markdown.appendMarkdown(`\n\nColumns (${columns.length}): ${preview}`);
    }

    private appendMetadataColumns(markdown: vscode.MarkdownString, columns: ColumnMetadata[]): void {
        if (columns.length === 0) {
            return;
        }

        markdown.appendMarkdown(`\n\nColumns (${columns.length} cached):`);
        columns.forEach(column => {
            const name = this.extractColumnName(column);
            const type = this.extractColumnType(column);
            const description = this.extractColumnDescription(column);
            let line = `\n- \`${name}\`${type ? ` (${type})` : ''}`;
            if (description) {
                const truncated = description.length > MAX_COLUMN_DESCRIPTION_LENGTH
                    ? description.substring(0, MAX_COLUMN_DESCRIPTION_LENGTH) + '…'
                    : description;
                line += ` — ${truncated}`;
            }
            markdown.appendMarkdown(line);
        });
    }

    private resolveStatementSemanticScope(
        statementParseRequest: {
            documentUri: string;
            documentVersion: number;
            sql: string;
            databaseKind?: DatabaseKind;
            cursorOffset?: number;
        },
        statementSql: string,
        statementRelativeOffset: number,
        databaseKind?: DatabaseKind,
    ) {
        if (!this.parseSession) {
            return parseSemanticScopeWithParser(
                statementSql,
                statementRelativeOffset,
                databaseKind,
            );
        }

        try {
            return this.parseSession.getSemanticScope(statementParseRequest);
        } catch {
            return parseSemanticScopeWithParser(
                statementSql,
                statementRelativeOffset,
                databaseKind,
            );
        }
    }

    private resolveRenameSymbol(
        parseRequest: {
            documentUri: string;
            documentVersion: number;
            sql: string;
            databaseKind?: DatabaseKind;
        },
        fullSql: string,
        offset: number,
        databaseKind?: DatabaseKind,
    ) {
        if (!this.parseSession) {
            return resolveSqlRenameSymbol(fullSql, offset, databaseKind);
        }

        try {
            return resolveSqlRenameSymbolWithSession(
                this.parseSession,
                parseRequest,
                offset,
            );
        } catch {
            return resolveSqlRenameSymbol(fullSql, offset, databaseKind);
        }
    }

    private async getCachedColumns(
        connectionName: string | undefined,
        dbName: string | undefined,
        schemaName: string | undefined,
        tableName: string,
        databaseKind?: DatabaseKind,
    ): Promise<ColumnMetadata[] | undefined> {
        if (!connectionName || !dbName) {
            return undefined;
        }

        return getCachedColumnsFromMetadataCacheAsync(
            this.metadataCache,
            connectionName,
            dbName,
            schemaName,
            tableName,
            databaseKind,
        );
    }

    private getCachedTableDescription(
        connectionName: string | undefined,
        dbName: string | undefined,
        schemaName: string | undefined,
        tableName: string
    ): string | undefined {
        if (!connectionName || !dbName) {
            return undefined;
        }

        const normalizedName = tableName.toUpperCase();
        const normalizedSchema = (schemaName || '').toUpperCase();
        const objects = this.metadataCache.getObjectsWithSchema(connectionName, dbName);

        for (const objectInfo of objects) {
            const objectName = this.extractTableName(objectInfo.item);
            if (!objectName || objectName.toUpperCase() !== normalizedName) {
                continue;
            }

            if (normalizedSchema && objectInfo.schema.toUpperCase() !== normalizedSchema) {
                continue;
            }

            if (objectInfo.description && objectInfo.description.trim()) {
                return objectInfo.description.trim();
            }
        }

        return undefined;
    }

    private extractTableName(item: { label?: string | { label: string }; OBJNAME?: string; TABLENAME?: string }): string | undefined {
        if (typeof item.label === 'string') {
            return item.label;
        }
        if (item.label && typeof item.label === 'object') {
            return item.label.label;
        }
        return item.OBJNAME || item.TABLENAME;
    }

    private extractColumnName(column: ColumnMetadata): string {
        return column.label || column.ATTNAME;
    }

    private extractColumnType(column: ColumnMetadata): string | undefined {
        const detail = column.detail || column.FORMAT_TYPE;
        return detail && detail.trim() ? detail : undefined;
    }

    private extractColumnDescription(column: ColumnMetadata): string | undefined {
        const description =
            column.documentation
            ?? (typeof column.DESCRIPTION === 'string' ? column.DESCRIPTION : undefined);
        return description && description.trim() ? description : undefined;
    }

    private findLocalDefinition(localDefinitions: LocalDefinition[], name: string): LocalDefinition | undefined {
        const normalized = name.toUpperCase();
        return localDefinitions.find(definition => definition.name.toUpperCase() === normalized);
    }

    private extractQualifierBeforeWord(beforeWord: string): string | undefined {
        const qualifierMatch = beforeWord.match(/([A-Za-z0-9_$"]+)\s*\.\s*$/);
        if (!qualifierMatch) {
            return undefined;
        }
        return this.stripQuotes(qualifierMatch[1]);
    }

    private stripQuotes(identifier: string): string {
        if (identifier.length >= 2 && identifier.startsWith('"') && identifier.endsWith('"')) {
            return identifier.slice(1, -1);
        }
        return identifier;
    }

    private formatObjectPath(
        dbName: string | undefined,
        schemaName: string | undefined,
        tableName: string,
        kind?: string
    ): string {
        return formatQualifiedObjectPathForDisplay(dbName, schemaName, tableName, kind);
    }

    private toObjectTypeLabel(objType: string): string {
        return objType.toUpperCase() === 'VIEW' ? 'View' : 'Table';
    }
}
