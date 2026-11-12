import * as vscode from 'vscode';
import type { CopilotToolService } from './copilotToolService';

export type ObjectDetailSection =
    | 'ddl'
    | 'columns'
    | 'comments'
    | 'stats'
    | 'dependencies'
    | 'favorites';

export type ObjectDetailObjectType =
    | 'table'
    | 'view'
    | 'procedure'
    | 'external table'
    | 'synonym'
    | 'nickname'
    | 'alias';

export interface IGetObjectDetailsToolParameters {
    objectName?: string;
    objectType?: ObjectDetailObjectType;
    database?: string;
    schema?: string;
    sections?: ObjectDetailSection[];
}

const DEFAULT_SECTIONS: ObjectDetailSection[] = ['ddl', 'columns'];

/**
 * Unified object metadata tool. Replaces separate get_columns/get_ddl/
 * get_comments/get_table_stats/get_dependencies/get_favorites tools.
 */
export class GetObjectDetailsTool implements vscode.LanguageModelTool<IGetObjectDetailsToolParameters> {
    constructor(private copilotService: CopilotToolService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetObjectDetailsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const sections = options.input.sections ?? DEFAULT_SECTIONS;
        const target = options.input.objectName
            ? `${options.input.objectType || 'table'} ${options.input.objectName}`
            : 'workspace favorites';

        return {
            invocationMessage: `Reading ${sections.join(', ')} for ${target}...`,
            confirmationMessages: {
                title: 'Get Object Details',
                message: new vscode.MarkdownString(
                    `Read ${sections.join(', ')} for **${target}** from the connected Netezza catalog?`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetObjectDetailsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.collect(options.input);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to read object details: ${errorMsg}`, { cause: e });
        }
    }

    private async collect(input: IGetObjectDetailsToolParameters): Promise<string> {
        const sections = input.sections && input.sections.length > 0 ? input.sections : DEFAULT_SECTIONS;
        const objectName = input.objectName?.trim();
        const objectType = input.objectType || 'table';

        if (!objectName && !sections.every(section => section === 'favorites')) {
            throw new Error('"objectName" is required unless the only requested section is "favorites".');
        }

        const results: string[] = [];

        for (const section of sections) {
            const label = section.toUpperCase();
            try {
                results.push(`## ${label}\n${await this.readSection(section, objectName, objectType, input)}`);
            } catch (e: unknown) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                results.push(`## ${label}\nError: ${errorMsg}`);
            }
        }

        return results.join('\n\n');
    }

    private async readSection(
        section: ObjectDetailSection,
        objectName: string | undefined,
        objectType: ObjectDetailObjectType,
        input: IGetObjectDetailsToolParameters
    ): Promise<string> {
        if (section === 'favorites') {
            return this.copilotService.getWorkspaceTableProfilesSummary('summary');
        }

        if (!objectName) {
            return 'Skipped: objectName was not provided.';
        }

        switch (section) {
            case 'ddl':
                return this.copilotService.getDDL({
                    objectName,
                    objectType,
                    database: input.database,
                    schema: input.schema
                });
            case 'columns':
                return this.copilotService.getColumnsForTables([objectName], input.database);
            case 'comments':
                return this.copilotService.getComments(objectName, input.database, input.schema, true);
            case 'stats':
                if (objectType !== 'table' && objectType !== 'external table') {
                    return `Skipped: statistics are available for tables, not "${objectType}".`;
                }
                return this.copilotService.getTableStats(objectName, input.database);
            case 'dependencies': {
                if (objectType !== 'table' && objectType !== 'view' && objectType !== 'procedure') {
                    return `Skipped: dependencies are available for tables, views, and procedures, not "${objectType}".`;
                }
                const dependencyType = objectType === 'table'
                    ? 'TABLE'
                    : objectType === 'view'
                        ? 'VIEW'
                        : 'PROCEDURE';
                return this.copilotService.getObjectDependencies(objectName, input.database, dependencyType);
            }
            default:
                return `Unsupported section "${section}".`;
        }
    }
}
