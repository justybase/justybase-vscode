import * as vscode from 'vscode';
import { formatExecuteStatementResult } from '../../core/assistant/audit';
import { shortObjectName, sqlObjectName } from '../../core/assistant/objectNames';
import type { CopilotToolService } from './copilotToolService';

export type DropObjectType =
    | 'table'
    | 'view'
    | 'procedure'
    | 'external table'
    | 'synonym'
    | 'nickname'
    | 'alias';

export interface IDropObjectToolParameters {
    object: string;
    objectType: DropObjectType;
    cascade?: boolean;
    database?: string;
    confirm: string;
}

const OBJECT_SQL: Record<DropObjectType, string> = {
    table: 'TABLE',
    view: 'VIEW',
    procedure: 'PROCEDURE',
    'external table': 'EXTERNAL TABLE',
    synonym: 'SYNONYM',
    nickname: 'NICKNAME',
    alias: 'ALIAS'
};

/** Drops a single object after an explicit confirmation value. */
export class DropObjectTool implements vscode.LanguageModelTool<IDropObjectToolParameters> {
    constructor(
        private readonly copilotService: CopilotToolService,
        private readonly allowDestructive: boolean,
    ) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IDropObjectToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Dropping ${options.input.objectType} ${options.input.object}...`,
            confirmationMessages: {
                title: 'Drop database object?',
                message: new vscode.MarkdownString(
                    `Permanently drop **${options.input.objectType} ${options.input.object}**` +
                    `${options.input.database ? ` from **${options.input.database}**` : ''}` +
                    `${options.input.cascade ? ' with **CASCADE**' : ''}?\n\nThis cannot be undone.`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDropObjectToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.allowDestructive) {
            throw new Error('Dropping objects requires the "full" access profile in JustyBase AI Tools settings.');
        }
        const keyword = OBJECT_SQL[options.input.objectType];
        if (!keyword) {
            throw new Error(`Unsupported objectType "${options.input.objectType}".`);
        }
        const shortName = shortObjectName(options.input.object) ?? '';
        if (options.input.confirm.trim().toLowerCase() !== shortName.toLowerCase()) {
            throw new Error(`confirm must equal the object name "${shortName}".`);
        }
        const target = sqlObjectName({
            object: options.input.object,
            database: options.input.database,
        });
        const sql = `DROP ${keyword} ${target}` +
            `${options.input.cascade ? ' CASCADE' : ''}`;
        const result = await this.copilotService.executeSql(sql, {});
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(formatExecuteStatementResult(result))
        ]);
    }
}
