import * as vscode from 'vscode';

export class ModelSelector {
    private selectedModelId: string | undefined;
    private statusBarItem: vscode.StatusBarItem;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'netezza.copilot.changeModel';

        // Load persisted model if present (workspace-specific)
        const saved = this.context.workspaceState.get<string>('copilot.selectedModelId');
        if (saved) {
            this.selectedModelId = saved;
        }
    }

    /**
     * Initializes model selection
     */
    public async init(): Promise<boolean> {
        try {
            // Get available Copilot models
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });

            if (models.length === 0) {
                this.statusBarItem.text = '$(copilot) No Models';
                this.statusBarItem.tooltip = 'No Copilot models available';
                this.statusBarItem.show();
                return false;
            }

            // Validate persisted model still exists
            if (this.selectedModelId) {
                const persistedModel = models.find(m => m.id === this.selectedModelId);
                if (!persistedModel) {
                    console.warn(`[ModelSelector] Persisted model ${this.selectedModelId} no longer available, clearing...`);
                    this.selectedModelId = undefined;
                    await this.context.workspaceState.update('copilot.selectedModelId', undefined);
                }
            }

            // If no valid model selected, pick a default
            if (!this.selectedModelId) {
                // Prefer gpt-4 or similar high capability models
                const preferred = models.find(m =>
                    m.family.toLowerCase().includes('gpt-4o') ||
                    m.family.toLowerCase().includes('claude-3-5-sonnet')
                ) || models[0];

                this.selectedModelId = preferred.id;
                await this.context.workspaceState.update('copilot.selectedModelId', this.selectedModelId);
                console.log(`[ModelSelector] Auto-selected model: ${preferred.name || preferred.family}`);
            }

            this.updateStatusBar();
            return true;
        } catch (error) {
            console.error('[ModelSelector] Failed to initialize:', error);
            this.statusBarItem.text = '$(copilot) Error';
            this.statusBarItem.tooltip = 'Click to select AI Model';
            this.statusBarItem.show();
            return false;
        }
    }

    /**
     * Updates status bar with current model info
     */
    private updateStatusBar() {
        if (this.selectedModelId) {
            vscode.lm.selectChatModels().then(models => {
                const model = models.find(m => m.id === this.selectedModelId);
                const name = model ? (model.name || model.family) : 'Copilot';

                // Try to extract cost from model metadata
                let costLabel = '';
                if (model) {
                    type ModelMeta = { detail?: string; tooltip?: string };
                    const meta = model as unknown as ModelMeta;
                    const explicit = meta.detail ?? meta.tooltip;
                    const cost = explicit?.match(/(0x|\d+(?:\.\d+)?x)/i)?.[1];
                    if (cost) {
                        costLabel = ` [${cost}]`;
                    }
                }

                this.statusBarItem.text = `$(copilot) ${name}${costLabel}`;
                this.statusBarItem.tooltip = `Using model: ${name}${costLabel}. Click to change.`;
                this.statusBarItem.show();
            });
        }
    }

    /**
     * Allows user to select a model via QuickPick
     */
    public async selectModel(): Promise<void> {
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });

            const modelItems = models.map(m => {
                type ModelMeta = { detail?: string; tooltip?: string };
                const meta = m as unknown as ModelMeta;
                const explicit = meta.detail ?? meta.tooltip;
                const cost = explicit?.match(/(0x|\d+(?:\.\d+)?x)/i)?.[1];

                return {
                    label: `$(sparkle) ${m.name || m.family}`,
                    description: cost ? `${cost} cost` : undefined,
                    detail: `${m.vendor} • ${m.family} • Max tokens: ${m.maxInputTokens}${explicit ? ' • ' + explicit : ''}`,
                    modelId: m.id,
                    model: m
                };
            });

            if (modelItems.length === 0) {
                vscode.window.showWarningMessage('No AI models detected. Ensure GitHub Copilot is installed and you are signed in.');
                return;
            }

            const selected = await vscode.window.showQuickPick(modelItems, {
                placeHolder: 'Select AI Model for SQL Generation',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (selected) {
                this.selectedModelId = selected.modelId;
                this.updateStatusBar();
                try {
                    await this.context.workspaceState.update('copilot.selectedModelId', this.selectedModelId);
                } catch (e) {
                    console.warn('Failed to persist selected model:', e);
                }
                vscode.window.showInformationMessage(`Model switched to: ${selected.model.name || selected.model.family}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to select model: ${error}`);
        }
    }

    public async clearPersistedModel(): Promise<void> {
        try {
            await this.context.workspaceState.update('copilot.selectedModelId', undefined);
            this.selectedModelId = undefined;
            this.statusBarItem.text = '$(copilot) Select Model';
            this.statusBarItem.tooltip = 'Click to select AI Model';
            vscode.window.showInformationMessage('Persisted model selection cleared. You will be prompted to select a model on next use.');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to clear model selection: ${msg}`);
        }
    }

    public getSelectedModelId(): string | undefined {
        return this.selectedModelId;
    }

    public async getModel(): Promise<vscode.LanguageModelChat | undefined> {
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            if (this.selectedModelId) {
                return models.find(m => m.id === this.selectedModelId);
            }
            // If no model selected, try to find a reasonable default
            return models.find(m => m.family.includes('gpt-4')) || models[0];
        } catch (error) {
            console.error('[ModelSelector] Failed to get model:', error);
            return undefined;
        }
    }
}
