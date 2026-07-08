import * as vscode from 'vscode';
import { CopilotContext } from './types';
import { CopilotPromptManager } from './CopilotPromptManager';
import { getExtensionConfiguration } from '../../compatibility/configuration';

/**
 * Handles Copilot response modes (Auto apply vs Chat) and diff display
 */
export class CopilotResponseHandler {
    constructor(
        private promptManager: CopilotPromptManager
    ) { }

    /**
     * Helper to select Copilot response mode (Auto apply vs Chat)
     */
    public async selectCopilotMode(action: string): Promise<'auto' | 'chat' | undefined> {
        const result = await vscode.window.showQuickPick(
            [
                { label: '$(zap) Auto', description: 'Apply changes directly via diff', value: 'auto' as const },
                { label: '$(comment-discussion) Chat', description: 'Discuss in Copilot Chat', value: 'chat' as const }
            ],
            { placeHolder: `${action} - Select mode` }
        );
        return result?.value;
    }

    /**
     * Sends request to language model with timeout and optional diff display
     */
    public async sendToLanguageModel(
        copilotContext: CopilotContext,
        userPrompt: string,
        applyEdits: boolean,
        model?: vscode.LanguageModelChat
    ): Promise<string> {
        if (!model) {
            throw new Error('No language model available');
        }

        const systemPrompt = this.promptManager.buildSystemPrompt(copilotContext);
        const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

        const messages = [vscode.LanguageModelChatMessage.User(fullPrompt)];

        const response = await this.sendRequestWithTimeout(model, messages);
        let responseText = '';

        for await (const chunk of response.text) {
            responseText += chunk;
        }

        if (applyEdits) {
            await this.applyResponseToEditor(responseText);
        }

        return responseText;
    }

    /**
     * Applies a previously generated model response to the active editor via diff flow.
     */
    public async applyModelResponseToEditor(responseText: string): Promise<void> {
        await this.applyResponseToEditor(responseText);
    }

    /**
     * Sends request to Copilot Chat for interactive discussion
     */
    public async sendToChatInteractive(
        copilotContext: CopilotContext,
        userPrompt: string,
        title: string
    ): Promise<void> {
        const systemPrompt = this.promptManager.buildSystemPrompt(copilotContext);
        const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

        await vscode.commands.executeCommand(
            'workbench.action.chat.open',
            { query: fullPrompt }
        );

        vscode.window.showInformationMessage(`✅ ${title} sent to Copilot Chat. Check the Chat panel for interactive discussion.`);
    }

    /**
     * Sends message to Copilot Chat with custom prompt (for SQL generation)
     */
    public async sendToChatInteractiveWithCustomPrompt(
        customPrompt: string,
        title: string
    ): Promise<void> {
        await vscode.commands.executeCommand(
            'workbench.action.chat.open',
            { query: customPrompt }
        );

        vscode.window.showInformationMessage(`✅ ${title} sent to Copilot Chat. Describe your query requirements for interactive SQL generation.`);
    }

    /**
     * Sends request with configurable timeout
     */
    private async sendRequestWithTimeout(
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        token?: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatResponse> {
        const config = getExtensionConfiguration();
        const timeoutMs = config.get<number>('copilot.requestTimeout', 60000) ?? 60000;

        const timeoutSource = new vscode.CancellationTokenSource();
        const timeoutTimer = setTimeout(() => {
            timeoutSource.cancel();
        }, timeoutMs);

        const linkedSource = new vscode.CancellationTokenSource();
        if (token) {
            token.onCancellationRequested(() => linkedSource.cancel());
        }
        const timeoutSub = timeoutSource.token.onCancellationRequested(() => linkedSource.cancel());

        try {
            const response = await model.sendRequest(messages, {}, linkedSource.token);
            clearTimeout(timeoutTimer);
            return response;
        } catch (e: unknown) {
            clearTimeout(timeoutTimer);
            if (timeoutSource.token.isCancellationRequested) {
                throw new Error(`Copilot request timed out after ${timeoutMs} ms`, { cause: e });
            }
            throw e;
        } finally {
            timeoutSub.dispose();
            timeoutSource.dispose();
        }
    }

    /**
     * Applies AI response to the editor with diff view
     */
    private async applyResponseToEditor(responseText: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error('No active editor');
        }

        const document = editor.document;
        const selection = editor.selection;

        // Determine range to replace
        let rangeToReplace: vscode.Range;
        if (!selection.isEmpty) {
            rangeToReplace = selection;
        } else {
            rangeToReplace = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(document.lineCount, 0)
            );
        }

        // Extract SQL code blocks if present
        const newContent = this.extractSqlFromResponse(responseText);

        // Show diff for user confirmation
        await this.showDiff(document, rangeToReplace, newContent);
    }

    /**
     * Extracts SQL code from AI response
     */
    private extractSqlFromResponse(response: string): string {
        // Try to extract SQL from code blocks
        const codeBlockMatch = response.match(/```(?:sql)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
            return codeBlockMatch[1].trim();
        }
        // If no code block, return the whole response
        return response.trim();
    }

    /**
     * Shows diff editor for reviewing changes
     */
    private async showDiff(
        document: vscode.TextDocument,
        rangeToReplace: vscode.Range,
        newContent: string
    ): Promise<void> {
        const originalText = document.getText(rangeToReplace);

        // Check if there are any changes
        if (originalText.trim() === newContent.trim()) {
            vscode.window.showInformationMessage('No changes detected - content is identical.');
            return;
        }

        // Create untitled documents for diff comparison
        const originalDoc = await vscode.workspace.openTextDocument({
            content: originalText,
            language: document.languageId
        });

        const newDoc = await vscode.workspace.openTextDocument({
            content: newContent,
            language: document.languageId
        });

        // Show diff editor
        await vscode.commands.executeCommand(
            'vscode.diff',
            originalDoc.uri,
            newDoc.uri,
            `AI Suggestions: ${document.fileName.split(/[\\/]/).pop() || 'file'}`,
            { preview: true }
        );

        // Ask user what to do with the changes
        const choice = await vscode.window.showInformationMessage(
            'Review the AI-suggested changes in the diff editor.',
            { modal: true },
            'Apply Changes',
            'Apply & Close Diff',
            'Discard'
        );

        if (choice === 'Apply Changes' || choice === 'Apply & Close Diff') {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, rangeToReplace, newContent);
            const success = await vscode.workspace.applyEdit(edit);

            if (success) {
                vscode.window.showInformationMessage('✅ Changes applied successfully.');

                if (choice === 'Apply & Close Diff') {
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                }
            } else {
                vscode.window.showErrorMessage('Failed to apply changes.');
            }
        } else if (choice === 'Discard') {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
    }

    /**
     * Detects if SQL contains a stored procedure definition
     */
    public isProcedureCode(sql: string): boolean {
        const procedurePattern = /CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+/i;
        return procedurePattern.test(sql);
    }

    /**
     * Converts data array to markdown table format
     */
    public convertDataToMarkdown(data: Record<string, unknown>[]): string {
        if (data.length === 0) {
            return '*No data*';
        }

        // Limit to first 50 rows for context length
        const displayData = data.slice(0, 50);
        const hasMore = data.length > 50;

        // Get column names from first row
        const columns = Object.keys(displayData[0]);

        // Build header
        let markdown = '| ' + columns.join(' | ') + ' |\n';
        markdown += '| ' + columns.map(() => '---').join(' | ') + ' |\n';

        // Build rows
        for (const row of displayData) {
            const values = columns.map(col => {
                const val = row[col];
                if (val === null || val === undefined) {
                    return 'NULL';
                }
                // Escape pipe characters and limit length
                const str = String(val).replace(/\|/g, '\\|');
                return str.length > 100 ? str.substring(0, 97) + '...' : str;
            });
            markdown += '| ' + values.join(' | ') + ' |\n';
        }

        if (hasMore) {
            markdown += `\n*... and ${data.length - 50} more rows (total: ${data.length} rows)*`;
        }

        return markdown;
    }
}
