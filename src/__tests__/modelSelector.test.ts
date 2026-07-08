/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import { ModelSelector } from '../services/copilot/ModelSelector';

jest.mock('vscode', () => ({
    StatusBarAlignment: {
        Left: 1,
        Right: 2
    },
    window: {
        createStatusBarItem: jest.fn().mockReturnValue({
            show: jest.fn(),
            hide: jest.fn(),
            text: '',
            tooltip: '',
            command: ''
        }),
        showQuickPick: jest.fn(),
        showInformationMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn()
    },
    lm: {
        selectChatModels: jest.fn()
    }
}), { virtual: true });

describe('ModelSelector', () => {
    let modelSelector: ModelSelector;
    let mockContext: vscode.ExtensionContext;

    const mockModels = [
        {
            id: 'gpt-4o',
            name: 'GPT-4o',
            family: 'gpt-4o',
            vendor: 'copilot',
            maxInputTokens: 128000
        },
        {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            family: 'gpt-4-turbo',
            vendor: 'copilot',
            maxInputTokens: 128000
        },
        {
            id: 'claude-3-5-sonnet',
            name: 'Claude 3.5 Sonnet',
            family: 'claude-3-5-sonnet',
            vendor: 'copilot',
            maxInputTokens: 200000
        }
    ];

    beforeEach(() => {
        jest.clearAllMocks();

        mockContext = {
            extensionUri: { toString: () => 'file:///test' },
            workspaceState: {
                get: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined)
            },
            globalState: {
                get: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined)
            },
            subscriptions: []
        } as any;

        (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue(mockModels as any);
        modelSelector = new ModelSelector(mockContext);
    });

    describe('constructor', () => {
        it('should create status bar item', () => {
            expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
                vscode.StatusBarAlignment.Right,
                100
            );
        });

        it('should set status bar command', () => {
            const statusBarItem = (vscode.window.createStatusBarItem as jest.Mock).mock.results[0].value;
            expect(statusBarItem.command).toBe('netezza.copilot.changeModel');
        });

        it('should load persisted model if available', () => {
            mockContext.workspaceState.get = jest.fn().mockReturnValue('gpt-4o');

            const selector = new ModelSelector(mockContext);

            expect(mockContext.workspaceState.get).toHaveBeenCalledWith('copilot.selectedModelId');
            expect(selector['selectedModelId']).toBe('gpt-4o');
        });

        it('should initialize with no persisted model', () => {
            mockContext.workspaceState.get = jest.fn().mockReturnValue(undefined);

            const selector = new ModelSelector(mockContext);

            expect(selector['selectedModelId']).toBeUndefined();
        });

        it('should set selectedModelId from persisted value', () => {
            mockContext.workspaceState.get = jest.fn().mockReturnValue('claude-3-5-sonnet');

            const selector = new ModelSelector(mockContext);

            expect(selector['selectedModelId']).toBe('claude-3-5-sonnet');
        });
    });

    describe('init', () => {
        it('should initialize successfully with available models', async () => {
            const result = await modelSelector.init();

            expect(result).toBe(true);
        });

        it('should auto-select gpt-4o model when no persisted model', async () => {
            mockContext.workspaceState.get = jest.fn().mockReturnValue(undefined);

            const selector = new ModelSelector(mockContext);
            await selector.init();

            expect(selector['selectedModelId']).toBe('gpt-4o');
            expect(mockContext.workspaceState.update).toHaveBeenCalledWith(
                'copilot.selectedModelId',
                'gpt-4o'
            );
        });

        it('should auto-select claude model when no persisted model and no gpt-4o', async () => {
            const modelsWithoutGpt4o = [
                {
                    id: 'claude-3-5-sonnet',
                    name: 'Claude 3.5 Sonnet',
                    family: 'claude-3-5-sonnet',
                    vendor: 'copilot',
                    maxInputTokens: 200000
                },
                {
                    id: 'gpt-3.5-turbo',
                    name: 'GPT-3.5 Turbo',
                    family: 'gpt-3.5-turbo',
                    vendor: 'copilot',
                    maxInputTokens: 16000
                }
            ];
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue(modelsWithoutGpt4o as any);

            const selector = new ModelSelector(mockContext);
            await selector.init();

            expect(selector['selectedModelId']).toBe('claude-3-5-sonnet');
        });

        it('should auto-select first model when no preferred model found', async () => {
            const genericModels = [
                {
                    id: 'generic-model-1',
                    name: 'Generic Model 1',
                    family: 'generic',
                    vendor: 'copilot',
                    maxInputTokens: 100000
                }
            ];
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue(genericModels as any);

            const selector = new ModelSelector(mockContext);
            await selector.init();

            expect(selector['selectedModelId']).toBe('generic-model-1');
        });

        it('should validate persisted model and clear if not found', async () => {
            mockContext.workspaceState.get = jest.fn().mockReturnValue('non-existent-model');

            const selector = new ModelSelector(mockContext);
            await selector.init();

            expect(mockContext.workspaceState.update).toHaveBeenCalledWith(
                'copilot.selectedModelId',
                undefined
            );
        });

        it('should keep persisted model if still available', async () => {
            mockContext.workspaceState.get = jest.fn().mockReturnValue('gpt-4-turbo');

            const selector = new ModelSelector(mockContext);
            await selector.init();

            expect(selector['selectedModelId']).toBe('gpt-4-turbo');
            expect(mockContext.workspaceState.update).not.toHaveBeenCalledWith(
                'copilot.selectedModelId',
                undefined
            );
        });

        it('should return false when no models available', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

            const selector = new ModelSelector(mockContext);
            const result = await selector.init();

            expect(result).toBe(false);
            const statusBarItem = (vscode.window.createStatusBarItem as jest.Mock).mock.results[0].value;
            expect(statusBarItem.text).toBe('$(copilot) No Models');
            expect(statusBarItem.tooltip).toBe('No Copilot models available');
        });

        it('should update status bar on successful init', async () => {
            await modelSelector.init();

            const statusBarItem = (vscode.window.createStatusBarItem as jest.Mock).mock.results[0].value;
            expect(statusBarItem.show).toHaveBeenCalled();
        });

        it('should handle error during initialization', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockRejectedValue(new Error('API error'));

            const selector = new ModelSelector(mockContext);
            const result = await selector.init();

            expect(result).toBe(false);
            const statusBarItem = (vscode.window.createStatusBarItem as jest.Mock).mock.results[0].value;
            expect(statusBarItem.text).toBe('$(copilot) Error');
        });
    });

    describe('selectModel', () => {
        beforeEach(async () => {
            await modelSelector.init();
            jest.clearAllMocks();
        });

        it('should show quick pick with available models', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: '$(sparkle) GPT-4o',
                modelId: 'gpt-4o'
            });

            await modelSelector.selectModel();

            expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
                expect.any(Array),
                expect.objectContaining({
                    placeHolder: 'Select AI Model for SQL Generation'
                })
            );
        });

        it('should format model items correctly', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            await modelSelector.selectModel();

            const quickPickCall = (vscode.window.showQuickPick as jest.Mock).mock.calls[0];
            const items = quickPickCall[0];

            expect(items[0]).toMatchObject({
                label: expect.stringContaining('GPT-4o'),
                modelId: 'gpt-4o'
            });
        });

        it('should update selected model when user selects one', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: '$(sparkle) Claude 3.5 Sonnet',
                modelId: 'claude-3-5-sonnet',
                model: mockModels[2]
            });

            await modelSelector.selectModel();

            expect(modelSelector.getSelectedModelId()).toBe('claude-3-5-sonnet');
            expect(mockContext.workspaceState.update).toHaveBeenCalledWith(
                'copilot.selectedModelId',
                'claude-3-5-sonnet'
            );
        });

        it('should show information message when model selected', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: '$(sparkle) GPT-4 Turbo',
                modelId: 'gpt-4-turbo',
                model: mockModels[1]
            });

            await modelSelector.selectModel();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                'Model switched to: GPT-4 Turbo'
            );
        });

        it('should not change model when user cancels selection', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            const originalModelId = modelSelector.getSelectedModelId();
            await modelSelector.selectModel();

            expect(modelSelector.getSelectedModelId()).toBe(originalModelId);
            expect(mockContext.workspaceState.update).not.toHaveBeenCalled();
        });

        it('should show warning when no models available', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

            await modelSelector.selectModel();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'No AI models detected. Ensure GitHub Copilot is installed and you are signed in.'
            );
        });

        it('should handle error during model selection', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockRejectedValue(new Error('Selection error'));

            await modelSelector.selectModel();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Failed to select model: Error: Selection error'
            );
        });

        it('should handle persistence error gracefully', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: '$(sparkle) GPT-4o',
                modelId: 'gpt-4o',
                model: mockModels[0]
            });
            const updateMock = jest.fn(() => {
                throw new Error('Storage error');
            });
            mockContext.workspaceState.update = updateMock;

            await modelSelector.selectModel();

            expect(modelSelector.getSelectedModelId()).toBe('gpt-4o');
        });
    });

    describe('clearPersistedModel', () => {
        beforeEach(async () => {
            await modelSelector.init();
            jest.clearAllMocks();
        });

        it('should clear persisted model', async () => {
            await modelSelector.clearPersistedModel();

            expect(modelSelector.getSelectedModelId()).toBeUndefined();
            expect(mockContext.workspaceState.update).toHaveBeenCalledWith(
                'copilot.selectedModelId',
                undefined
            );
        });

        it('should update status bar after clearing', async () => {
            await modelSelector.clearPersistedModel();

            // Access statusBarItem directly from the modelSelector instance
            const statusBarItem = (modelSelector as any).statusBarItem;
            expect(statusBarItem.text).toBe('$(copilot) Select Model');
            expect(statusBarItem.tooltip).toBe('Click to select AI Model');
        });

        it('should show information message after clearing', async () => {
            await modelSelector.clearPersistedModel();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                'Persisted model selection cleared. You will be prompted to select a model on next use.'
            );
        });

        it('should handle error when clearing persisted model', async () => {
            const updateMock = jest.fn(() => {
                throw new Error('Clear error');
            });
            mockContext.workspaceState.update = updateMock;

            await modelSelector.clearPersistedModel();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Failed to clear model selection: Clear error'
            );
        });
    });

    describe('getSelectedModelId', () => {
        it('should return undefined when no model selected', () => {
            const selector = new ModelSelector(mockContext);

            expect(selector.getSelectedModelId()).toBeUndefined();
        });

        it('should return selected model ID', async () => {
            await modelSelector.init();

            expect(modelSelector.getSelectedModelId()).toBeDefined();
            expect(typeof modelSelector.getSelectedModelId()).toBe('string');
        });

        it('should return correct model ID after selection', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([mockModels[0]] as any);
            mockContext.workspaceState.get = jest.fn().mockReturnValue('gpt-4o');

            const selector = new ModelSelector(mockContext);
            await selector.init();

            expect(selector.getSelectedModelId()).toBe('gpt-4o');
        });
    });

    describe('getModel', () => {
        it('should return model object for selected ID', async () => {
            await modelSelector.init();

            const model = await modelSelector.getModel();

            expect(model).toBeDefined();
            expect(mockModels).toContainEqual(model);
        });

        it('should return undefined when no models available', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

            const selector = new ModelSelector(mockContext);
            await selector.init();

            const model = await selector.getModel();

            expect(model).toBeUndefined();
        });

        it('should return first available model when no model selected', async () => {
            const selector = new ModelSelector(mockContext);
            const model = await selector.getModel();

            expect(model).toBeDefined();
            expect(model?.id).toBe(mockModels[0].id);
        });

        it('should prefer gpt-4 family models', async () => {
            const mixedModels = [
                { id: 'gpt-3.5-turbo', name: 'GPT-3.5', family: 'gpt-3.5', vendor: 'copilot', maxInputTokens: 16000 },
                { id: 'claude-3-sonnet', name: 'Claude 3', family: 'claude-3', vendor: 'copilot', maxInputTokens: 100000 },
                { id: 'gpt-4', name: 'GPT-4', family: 'gpt-4', vendor: 'copilot', maxInputTokens: 8000 }
            ];
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue(mixedModels as any);

            const selector = new ModelSelector(mockContext);
            const model = await selector.getModel();

            expect(model?.family).toContain('gpt-4');
        });

        it('should handle error when getting models', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockRejectedValue(new Error('Get model error'));

            const selector = new ModelSelector(mockContext);
            const model = await selector.getModel();

            expect(model).toBeUndefined();
        });

        it('should return selected model when available', async () => {
            await modelSelector.init();

            const model = await modelSelector.getModel();

            expect(model?.id).toBe(modelSelector.getSelectedModelId());
        });
    });

    describe('updateStatusBar', () => {
        it('should update status bar with model name', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([mockModels[0]] as any);

            const selector = new ModelSelector(mockContext);
            await selector.init();

            const statusBarItem = (vscode.window.createStatusBarItem as jest.Mock).mock.results[0].value;
            expect(statusBarItem.text).toContain('GPT-4o');
            expect(statusBarItem.tooltip).toContain('Using model: GPT-4o');
        });

        it('should show status bar after update', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([mockModels[1]] as any);

            const selector = new ModelSelector(mockContext);
            await selector.init();

            const statusBarItem = (vscode.window.createStatusBarItem as jest.Mock).mock.results[0].value;
            expect(statusBarItem.show).toHaveBeenCalled();
        });
    });
});
