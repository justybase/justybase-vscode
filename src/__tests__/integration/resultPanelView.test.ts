
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as vscode from 'vscode';
import { ResultPanelView } from '../../views/resultPanelView';

const mockResultsConfigurationValues: Record<string, unknown> = {
    gridFontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace"
};
const mockEditorConfigurationValues: Record<string, unknown> = {
    fontFamily: 'Aptos'
};
let mockConfigurationChangeHandler: ((event: { affectsConfiguration: (section: string) => boolean }) => void) | undefined;

type MockedVsCodeModule = {
    window: {
        createWebviewPanel: jest.Mock;
        showInformationMessage: jest.Mock;
        activeTextEditor: unknown;
    };
    commands: {
        executeCommand: jest.Mock;
    };
    workspace: {
        fs: {
            writeFile: jest.Mock;
        };
        getConfiguration: jest.Mock;
        onDidChangeConfiguration: jest.Mock;
    };
};

type WebviewMessage = {
    command: string;
    sourceUri?: string;
};

type WebviewMessageHandler = (message: WebviewMessage) => void;

// Mock vscode
jest.mock('vscode', () => ({
    Uri: {
        parse: jest.fn().mockImplementation((s: unknown) => ({ toString: () => String(s) })),
        joinPath: jest.fn()
    },
    EventEmitter: jest.fn().mockImplementation(() => ({
        event: jest.fn(),
        fire: jest.fn()
    })),
    window: {
        createWebviewPanel: jest.fn(),
        showInformationMessage: jest.fn(),
        activeTextEditor: undefined
    },
    commands: {
        executeCommand: jest.fn()
    },
    workspace: {
        fs: { writeFile: jest.fn() },
        getConfiguration: jest.fn().mockImplementation((section: unknown) => ({
            get: jest.fn((key: string, defaultValue?: unknown) => {
                if (section === 'justybase.results') {
                    return mockResultsConfigurationValues[key] ?? defaultValue;
                }
                if (section === 'editor') {
                    return mockEditorConfigurationValues[key] ?? defaultValue;
                }
                return defaultValue;
            })
        })),
        onDidChangeConfiguration: jest.fn().mockImplementation((handler: unknown) => {
            if (typeof handler === 'function') {
                mockConfigurationChangeHandler = handler as (event: { affectsConfiguration: (section: string) => boolean }) => void;
            }
            return { dispose: jest.fn() };
        })
    },
    WebviewViewResolveContext: jest.fn(),
    CancellationToken: jest.fn()
}), { virtual: true });

describe('ResultPanelView Integration', () => {
    let provider: ResultPanelView;
    let mockExtensionUri: vscode.Uri;
    // Use Partial<vscode.WebviewView> to allow mocking only necessary properties
    let mockWebview: {
        webview: {
            options: unknown;
            html: string;
            onDidReceiveMessage: jest.Mock;
            postMessage: jest.Mock;
            asWebviewUri: jest.Mock;
            cspSource: string;
        };
        onDidChangeVisibility: jest.Mock;
        show: jest.Mock;
        viewType: string;
        onDidDispose: jest.Mock;
        visible: boolean;
    };
    let postedMessages: unknown[] = [];

    beforeEach(() => {
        const { window } = jest.requireMock('vscode') as MockedVsCodeModule;
        window.activeTextEditor = undefined;
        mockResultsConfigurationValues.gridFontFamily = "Menlo, Monaco, Consolas, 'Courier New', monospace";
        mockEditorConfigurationValues.fontFamily = 'Aptos';
        mockConfigurationChangeHandler = undefined;

        mockExtensionUri = { toString: () => 'extension-uri' } as vscode.Uri;
        provider = new ResultPanelView(mockExtensionUri);

        postedMessages = [];
        mockWebview = {
            webview: {
                options: {},
                html: '',
                onDidReceiveMessage: jest.fn(),
                postMessage: jest.fn().mockImplementation((msg: unknown) => {
                    postedMessages.push(msg);
                    return Promise.resolve(true);
                }),
                asWebviewUri: jest.fn(),
                cspSource: 'test-csp'
            },
            onDidChangeVisibility: jest.fn(),
            show: jest.fn(),
            viewType: 'netezza.resultPanel',
            onDidDispose: jest.fn(),
            visible: true
        };

        // Resolve webview to attach listeners
        provider.resolveWebviewView(
            mockWebview as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            {} as vscode.CancellationToken
        );

        // Simulate "ready" message from frontend
        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0] as WebviewMessageHandler;
        messageHandler({ command: 'ready' });
    });

    afterEach(() => {
        provider.dispose();
    });

    test('should switch content when active source changes', () => {
        const uriA = 'file:///path/to/A.sql';
        const uriB = 'file:///path/to/B.sql';

        // 1. Start execution for A to populate it
        provider.startExecution(uriA);

        // Verify A is active
        expect(provider.getActiveSource()).toBe(uriA);

        // 2. Try to switch to B (which has no results yet)
        provider.setActiveSource(uriB);

        // CURRENT BUG EXPECTATION: It stays on A because B has no results map entry
        // DESIRED BEHAVIOR: It switches to B (active source updates) and sending "No results"

        // For TDD, let's assert the DESIRED behavior and expect failure first if strict, 
        // or assert the bug first. Let's assert the fix.
        expect(provider.getActiveSource()).toBe(uriB);
    });

    test('should hydrate pending execution state when webview becomes ready after execution starts', () => {
        const { commands } = jest.requireMock('vscode') as MockedVsCodeModule;
        commands.executeCommand.mockClear();

        const pendingProvider = new ResultPanelView(mockExtensionUri);
        const pendingSourceUri = 'untitled:Untitled-1';
        const pendingMessages: unknown[] = [];
        const pendingWebview = {
            webview: {
                options: {},
                html: '',
                onDidReceiveMessage: jest.fn(),
                postMessage: jest.fn().mockImplementation((msg: unknown) => {
                    pendingMessages.push(msg);
                    return Promise.resolve(true);
                }),
                asWebviewUri: jest.fn(),
                cspSource: 'test-csp'
            },
            onDidChangeVisibility: jest.fn(),
            show: jest.fn(),
            viewType: 'netezza.resultPanel',
            onDidDispose: jest.fn(),
            visible: true
        };

        pendingProvider.startExecution(pendingSourceUri);

        expect(commands.executeCommand).toHaveBeenCalledWith('netezza.results.focus');

        pendingProvider.resolveWebviewView(
            pendingWebview as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            {} as vscode.CancellationToken
        );

        const pendingMessageHandler = pendingWebview.webview.onDidReceiveMessage.mock.calls[0][0] as WebviewMessageHandler;
        pendingMessageHandler({ command: 'ready' });

        const hydrateMessage = pendingMessages.find(
            (message): message is { command: string; data: { activeSourceJson: string; activeResultSetIndex: number; executingSourcesJson: string } } =>
                typeof message === 'object'
                && message !== null
                && 'command' in message
                && (message as { command?: string }).command === 'hydrate'
        );

        expect(hydrateMessage).toBeDefined();
        expect(JSON.parse(hydrateMessage!.data.activeSourceJson)).toBe(pendingSourceUri);
        expect(hydrateMessage!.data.activeResultSetIndex).toBe(0);
        expect(JSON.parse(hydrateMessage!.data.executingSourcesJson)).toContain(pendingSourceUri);

        pendingProvider.dispose();
    });

    test('should reload webview html when results grid font configuration changes', () => {
        const initialHtml = mockWebview.webview.html;

        expect(initialHtml).toContain("Menlo, Monaco, Consolas, 'Courier New', monospace");
        expect(mockConfigurationChangeHandler).toBeDefined();

        mockResultsConfigurationValues.gridFontFamily = 'JetBrains Mono, Consolas, monospace';
        const mockEvent = {
            affectsConfiguration: jest.fn((section: string) => section === 'justybase.results.gridFontFamily')
        };

        mockConfigurationChangeHandler?.(mockEvent);

        expect(mockEvent.affectsConfiguration).toHaveBeenCalledWith('justybase.results.gridFontFamily');
        expect(mockWebview.webview.html).toContain('JetBrains Mono, Consolas, monospace');
        expect(mockWebview.webview.html).not.toBe(initialHtml);
    });

    test('should clear view when active source is closed', () => {
        const uriA = 'file:///path/to/A.sql';

        // 1. Start execution for A
        provider.startExecution(uriA);
        expect(provider.getActiveSource()).toBe(uriA);

        // 2. Close source A (simulate message from frontend "closeSource")
        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0] as WebviewMessageHandler;
        messageHandler({ command: 'closeSource', sourceUri: uriA });

        // 3. Verify active source is undefined/cleared
        expect(provider.getActiveSource()).toBeUndefined();

        // 4. Verify hydration was sent with empty/reset state
        const lastMessage = postedMessages[postedMessages.length - 1] as { command: string, data: { activeSourceJson: string } };
        expect(lastMessage.command).toBe('hydrate');

        // Check if data source is cleared/null in json
        const viewData = lastMessage.data;
        expect(JSON.parse(viewData.activeSourceJson)).toBeNull();
    });

    test('should keep focused SQL document as active source during rapid background updates', () => {
        const uriA = 'file:///path/to/A.sql';
        const uriB = 'file:///path/to/B.sql';
        const { window } = jest.requireMock('vscode') as MockedVsCodeModule;

        provider.startExecution(uriA);
        provider.setActiveSource(uriA);

        window.activeTextEditor = {
            document: {
                languageId: 'sql',
                uri: {
                    scheme: 'file',
                    toString: () => uriB
                }
            }
        };

        provider.log(uriA, 'Executing query 1/2...');
        provider.log(uriA, 'Executing query 2/2...');

        expect(provider.getActiveSource()).toBe(uriB);
    });

    describe('closeSource method', () => {
        test('should close source and update webview', () => {
            const uriA = 'file:///path/to/A.sql';
            const uriB = 'file:///path/to/B.sql';

            // 1. Start execution for both A and B
            provider.startExecution(uriA);
            provider.startExecution(uriB);

            // 2. Set A as active
            provider.setActiveSource(uriA);
            expect(provider.getActiveSource()).toBe(uriA);

            // 3. Close source A via the new public method
            provider.closeSource(uriA);

            // 4. Verify A is removed and B becomes active
            expect(provider.getActiveSource()).toBe(uriB);

            // 5. Verify webview was updated with hydration
            const lastMessage = postedMessages[postedMessages.length - 1] as { command: string };
            expect(lastMessage.command).toBe('hydrate');
        });

        test('should handle closing non-existent source gracefully', () => {
            const uriA = 'file:///path/to/A.sql';
            const uriNonExistent = 'file:///path:/nonexistent.sql';

            // Start execution for A
            provider.startExecution(uriA);
            provider.setActiveSource(uriA);
            expect(provider.getActiveSource()).toBe(uriA);

            // Close a source that doesn't exist in results - should not throw
            expect(() => provider.closeSource(uriNonExistent)).not.toThrow();

            // Original source A should still be active
            expect(provider.getActiveSource()).toBe(uriA);
        });

        test('should close all results when closing last source', () => {
            const uriA = 'file:///path/to/A.sql';

            // Start execution for A
            provider.startExecution(uriA);
            expect(provider.getActiveSource()).toBe(uriA);

            // Close the only source
            provider.closeSource(uriA);

            // Verify active source is undefined
            expect(provider.getActiveSource()).toBeUndefined();

            // Verify hydration was sent
            const lastMessage = postedMessages[postedMessages.length - 1] as { command: string, data: { activeSourceJson: string } };
            expect(lastMessage.command).toBe('hydrate');
            expect(JSON.parse(lastMessage.data.activeSourceJson)).toBeNull();
        });
    });
});
