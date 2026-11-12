import * as vscode from 'vscode';
import type { CopilotToolService } from './copilotToolService';

export type CatalogObjectType =
    | 'databases'
    | 'schemas'
    | 'tables'
    | 'views'
    | 'procedures'
    | 'external tables'
    | 'columns'
    | 'all'
    | 'locations';

export interface ISearchCatalogToolParameters {
    objectType?: CatalogObjectType;
    pattern?: string;
    database?: string;
    schema?: string;
}

/**
 * Unified catalog discovery tool. Replaces separate databases/schemas/tables/
 * views/procedures/external-tables/search-schema/find-locations tools.
 */
export class SearchCatalogTool implements vscode.LanguageModelTool<ISearchCatalogToolParameters> {
    constructor(private copilotService: CopilotToolService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ISearchCatalogToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const objectType = options.input.objectType || 'tables';
        const pattern = options.input.pattern ? ` matching "${options.input.pattern}"` : '';
        const database = options.input.database ? ` in ${options.input.database}` : '';

        return {
            invocationMessage: `Searching ${objectType}${pattern}${database}...`,
            confirmationMessages: {
                title: 'Search Database Catalog',
                message: new vscode.MarkdownString(
                    `Search the connected Netezza catalog for ${objectType}${pattern}${database}?`
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
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Catalog search failed: ${errorMsg}`, { cause: e });
        }
    }

    private async search(input: ISearchCatalogToolParameters): Promise<string> {
        const objectType = input.objectType || 'tables';
        const pattern = input.pattern?.trim();

        switch (objectType) {
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
            case 'external tables':
                return this.copilotService.getExternalTables(input.database, input.schema, pattern);
            case 'columns':
                this.requirePattern(pattern, objectType);
                return this.copilotService.searchSchema(pattern, 'COLUMNS', input.database);
            case 'all':
                this.requirePattern(pattern, objectType);
                return this.copilotService.searchSchema(pattern, 'ALL', input.database);
            case 'locations':
                this.requirePattern(pattern, objectType);
                return this.copilotService.findTableLocations(pattern);
            default:
                throw new Error(`Unsupported objectType "${objectType}".`);
        }
    }

    private requirePattern(pattern: string | undefined, objectType: string): asserts pattern is string {
        if (!pattern) {
            throw new Error(`A "pattern" is required when objectType is "${objectType}".`);
        }
    }
}
