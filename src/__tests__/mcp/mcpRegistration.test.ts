jest.mock('vscode');

const mockStart = jest.fn().mockResolvedValue(undefined);
const mockStop = jest.fn().mockResolvedValue(undefined);
const mockGetStatus = jest.fn();
const mockHttpManager = {
    start: mockStart,
    stop: mockStop,
    getStatus: mockGetStatus,
    onDidChangeStatus: jest.fn(() => ({ dispose: jest.fn() })),
    dispose: jest.fn()
};
const mockProvider = {
    setEnabled: jest.fn(),
    refresh: jest.fn()
};
const mockConfigureMcp = jest.fn();
const mockMcpConfig: Record<string, unknown> = {};

jest.mock('../../mcp/mcpServerDefinitionProvider', () => ({
    canRegisterMcpServerDefinitionProvider: () => true,
    registerMcpServerDefinitionProvider: jest.fn(() => mockProvider),
    NetezzaMcpServerDefinitionProvider: jest.fn()
}));

jest.mock('../../mcp/mcpHttpServerManager', () => ({
    McpHttpServerManager: jest.fn(() => mockHttpManager)
}));

jest.mock('../../views/settingsView', () => ({
    SettingsView: { configureMcp: mockConfigureMcp }
}));

jest.mock('../../mcp/mcpConnection', () => ({
    getConfiguredMcpConnectionName: () => 'Dev',
    getMcpConnectionSelectionError: () => undefined,
    resolveSelectedMcpConnection: jest.fn()
}));

jest.mock('../../compatibility/configuration', () => ({
    getExtensionConfiguration: (section?: string) => ({
        get: (key: string, defaultValue?: unknown) =>
            section === 'mcp' ? (mockMcpConfig[key] ?? defaultValue) : defaultValue
    })
}));

import * as vscode from 'vscode';
import { registerMcpFeatures } from '../../activation/mcpRegistration';

const flush = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
};

describe('MCP registration access wiring', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockMcpConfig.enabled = true;
        mockMcpConfig.externalEnabled = false;
        mockMcpConfig.port = 37210;
        mockGetStatus.mockReturnValue({ running: false });
    });

    it('passes the access policy to both transports and restarts HTTP when it changes', async () => {
        const context = { subscriptions: [] as { dispose(): void }[] } as unknown as vscode.ExtensionContext;
        const logger = { warn: jest.fn() } as unknown as Parameters<typeof registerMcpFeatures>[0]['logger'];

        registerMcpFeatures({
            context,
            connectionManager: {
                onDidChangeConnections: jest.fn(() => ({ dispose: jest.fn() }))
            } as never,
            logger
        });
        await flush();

        expect(mockProvider.setEnabled).toHaveBeenCalledWith(true);
        expect(mockConfigureMcp).toHaveBeenCalledWith(expect.objectContaining({
            connectionManager: expect.anything(),
            httpManager: mockHttpManager
        }));
        expect(mockStart).not.toHaveBeenCalled();

        mockMcpConfig.externalEnabled = true;
        const calls = (vscode.workspace.onDidChangeConfiguration as jest.Mock).mock.calls;
        const onChange = calls[calls.length - 1]?.[0];
        expect(typeof onChange).toBe('function');
        onChange({ affectsConfiguration: (key: string) => key === 'justybase.ai.tools' });
        await flush();

        expect(mockProvider.refresh).toHaveBeenCalled();
        expect(mockStart).toHaveBeenCalledWith(37210);

        onChange({ affectsConfiguration: (key: string) => key === 'justybase.mcp' });
        await flush();
        expect(mockProvider.refresh).toHaveBeenCalledTimes(3);
    });
});
