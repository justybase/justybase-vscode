import * as vscode from 'vscode';
import { formatExecuteStatementResult } from '../../core/assistant/audit';
import { escapeSqlIdentifier } from '../../utils/sqlUtils';
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

const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function qualifiedName(object: string, database?: string): string {
    const parts = object.split('.').map(part => part.trim()).filter(part => part.length > 0);
    if (parts.length === 0 || parts.length > 3 || parts.some(part => !VALID_IDENTIFIER.test(part))) {
        throw new Error('The object name must use simple Netezza identifiers.');
    }
    const escaped = parts.map(part => escapeSqlIdentifier(part));
    if (database) {
        if (!VALID_IDENTIFIER.test(database.trim())) {
            throw new Error('The database name must be a simple Netezza identifier.');
        }
        if (parts.length === 1) {
            return `${escapeSqlIdentifier(database.trim())}..${escaped[0]}`;
        }
    }
    return escaped.join('.');
}

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
        const shortName = options.input.object.split('.').filter(part => part.length > 0).pop() ?? '';
        if (options.input.confirm.trim().toLowerCase() !== shortName.toLowerCase()) {
            throw new Error(`confirm must equal the object name "${shortName}".`);
        }
        const sql = `DROP ${keyword} ${qualifiedName(options.input.object, options.input.database)}` +
            `${options.input.cascade ? ' CASCADE' : ''}`;
        const result = await this.copilotService.executeSql(sql, {});
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(formatExecuteStatementResult(result))
        ]);
    }
}
