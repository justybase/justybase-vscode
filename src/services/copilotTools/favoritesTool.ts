import * as vscode from 'vscode';

export interface IFavoritesToolParameters {
    includeNowProfileId?: string;
    mode?: 'full' | 'summary' | 'content';
    profileNames?: string[];
}

export class FavoritesTool implements vscode.LanguageModelTool<IFavoritesToolParameters> {
    constructor(private copilotService: CopilotService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IFavoritesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const includeNowProfileId = options.input.includeNowProfileId;
        const modeText = includeNowProfileId
            ? `listing favorites and including \`${includeNowProfileId}\` for next prompt`
            : 'listing favorites';

        return {
            invocationMessage: `Preparing ${modeText}...`,
            confirmationMessages: {
                title: 'Netezza Favorites',
                message: new vscode.MarkdownString(
                    `Show your favorite Netezza tables and SQL snippets?\n\n` +
                    `This includes table identifiers, scripts, notes, and inclusion mode.`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IFavoritesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const includeNowProfileId = options.input.includeNowProfileId;
            if (includeNowProfileId && includeNowProfileId.trim().length > 0) {
                const included = await this.copilotService.includeWorkspaceTableProfileNow(includeNowProfileId.trim());
                if (!included) {
                    throw new Error(`Profile "${includeNowProfileId}" was not found`);
                }
            }

            const summary = await this.copilotService.getWorkspaceTableProfilesSummary(
                options.input.mode,
                options.input.profileNames
            );
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(summary)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to read favorites: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
