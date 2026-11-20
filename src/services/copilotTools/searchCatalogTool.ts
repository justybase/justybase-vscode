import * as vscode from 'vscode';
import type { CatalogSearchKind } from '../../core/assistant/toolCatalog';
import type { CopilotToolService } from './copilotToolService';

export interface ISearchCatalogToolParameters {
    kind: CatalogSearchKind;
    query?: string;
    database?: string;
    schema?: string;
}

/** Unified catalog discovery tool for the Copilot surface. */
export class SearchCatalogTool implements vscode.LanguageModelTool<ISearchCatalogToolParameters> {
    constructor(private readonly copilotService: CopilotToolService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ISearchCatalogToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const kind = options.input.kind ?? 'tables';
        const query = options.input.query ? ` matching "${options.input.query}"` : '';
        const database = options.input.database ? ` in ${options.input.database}` : '';

        return {
            invocationMessage: `Searching ${kind}${query}${database}...`,
            confirmationMessages: {
                title: 'Search Database Catalog',
                message: new vscode.MarkdownString(
                    `Search the connected Netezza catalog for ${kind}${query}${database}?`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ISearchCatalogToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.search(options.input);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Catalog search failed: ${message}`, { cause: error });
        }
    }

    private async search(input: ISearchCatalogToolParameters): Promise<string> {
        const kind = input.kind ?? 'tables';
        const query = input.query?.trim();

        switch (kind) {
            case 'databases':
                return this.copilotService.getDatabases();
            case 'schemas':
                return this.copilotService.getSchemas(input.database);
            case 'tables':
                return this.copilotService.getTablesFromDatabase(input.database, input.schema);
            case 'views':
                return this.copilotService.getViews(input.database, input.schema);
            case 'procedures':
                return this.copilotService.getProcedures(input.database, input.schema);
            case 'external_tables':
                return this.copilotService.getExternalTables(input.database, input.schema, query);
            case 'columns':
                this.requireQuery(query, kind);
                return this.copilotService.searchSchema(query, 'COLUMNS', input.database);
            case 'all':
                this.requireQuery(query, kind);
                return this.copilotService.searchSchema(query, 'ALL', input.database);
            default:
                throw new Error(`Unsupported kind "${kind}".`);
        }
    }

    private requireQuery(query: string | undefined, kind: string): asserts query is string {
        if (!query) {
            throw new Error(`A "query" is required when kind is "${kind}".`);
        }
    }
}
