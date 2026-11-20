import * as vscode from 'vscode';
import { normalizeObjectName } from '../../core/assistant/objectNames';
import type { ObjectSection } from '../../core/assistant/toolCatalog';
import type { CopilotToolService } from './copilotToolService';

export type ObjectDetailObjectType =
    | 'table'
    | 'view'
    | 'procedure'
    | 'external table'
    | 'synonym'
    | 'nickname'
    | 'alias';

export interface IGetObjectToolParameters {
    object: string;
    objectType?: ObjectDetailObjectType;
    database?: string;
    schema?: string;
    sections?: ObjectSection[];
}

const DEFAULT_SECTIONS: ObjectSection[] = ['ddl', 'columns'];

/**
 * One-call object metadata tool: DDL, columns, comments, statistics,
 * constraints and dependencies. Replaces the former narrow metadata tools.
 */
export class GetObjectTool implements vscode.LanguageModelTool<IGetObjectToolParameters> {
    constructor(private readonly copilotService: CopilotToolService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetObjectToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const sections = options.input.sections?.length ? options.input.sections : DEFAULT_SECTIONS;
        const target = `${options.input.objectType || 'table'} ${options.input.object}`;

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
        options: vscode.LanguageModelToolInvocationOptions<IGetObjectToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(await this.collect(options.input))
            ]);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to read object details: ${message}`, { cause: error });
        }
    }

    private async collect(input: IGetObjectToolParameters): Promise<string> {
        const sections = input.sections?.length ? input.sections : DEFAULT_SECTIONS;
        const objectType = input.objectType ?? 'table';
        const results: string[] = [];

        for (const section of sections) {
            const label = section.toUpperCase();
            try {
                results.push(`## ${label}\n${await this.readSection(section, input.object, objectType, input)}`);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                results.push(`## ${label}\nError: ${message}`);
            }
        }

        return results.join('\n\n');
    }

    private async readSection(
        section: ObjectSection,
        object: string,
        objectType: ObjectDetailObjectType,
        input: IGetObjectToolParameters
    ): Promise<string> {
        switch (section) {
            case 'ddl':
                return this.copilotService.getDDL({
                    objectName: object,
                    objectType,
                    database: input.database,
                    schema: input.schema
                });
            case 'columns':
                return this.copilotService.getColumnsForTables(
                    [normalizeObjectName({ object, database: input.database, schema: input.schema })],
                    input.database
                );
            case 'comments':
                return this.copilotService.getComments(object, input.database, input.schema, true);
            case 'stats':
                if (objectType !== 'table' && objectType !== 'external table') {
                    return `Skipped: statistics are available for tables and external tables, not "${objectType}".`;
                }
                return this.copilotService.getTableStats(
                    normalizeObjectName({ object, database: input.database, schema: input.schema }),
                    input.database
                );
            case 'constraints':
                if (objectType !== 'table') {
                    return `Skipped: constraints are available for tables, not "${objectType}".`;
                }
                return this.copilotService.getTableConstraints(object, input.database, input.schema);
            case 'dependencies': {
                if (objectType !== 'table' && objectType !== 'view' && objectType !== 'procedure') {
                    return `Skipped: dependencies are available for tables, views and procedures, not "${objectType}".`;
                }
                const dependencyType = objectType === 'table'
                    ? 'TABLE'
                    : objectType === 'view'
                        ? 'VIEW'
                        : 'PROCEDURE';
                return this.copilotService.getObjectDependencies(
                    normalizeObjectName({ object, database: input.database, schema: input.schema }),
                    input.database,
                    dependencyType
                );
            }
            default:
                return `Unsupported section "${section}".`;
        }
    }
}
