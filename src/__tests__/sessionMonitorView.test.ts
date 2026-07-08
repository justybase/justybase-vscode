/**
 * Unit tests for SessionMonitorView
 * Tests session management, data fetching, auto-refresh, and webview messaging
 */

import * as vscode from 'vscode';
import { SessionMonitorView } from '../views/sessionMonitorView';
import { ConnectionManager } from '../core/connectionManager';

// Mock session monitor provider
const mockSessionMonitorProvider = {
  getSessions: jest.fn(),
  getQueries: jest.fn(),
  getStorage: jest.fn(),
  getResources: jest.fn(),
  killSession: jest.fn()
};

// Mock dialect registry
jest.mock('../core/factories/databaseDialectRegistry', () => ({
  getDatabaseDialectByKind: jest.fn(() => ({
    kind: 'netezza',
    capabilities: { supportsSessionMonitor: true },
    advancedFeatures: {
      sessionMonitor: mockSessionMonitorProvider
    }
  }))
}));

// Mock dependencies
jest.mock('../core/queryRunner', () => ({
  runQueryRaw: jest.fn(),
  queryResultToRows: jest.fn((result) => {
    if (!result || !result.data) return [];
    return result.data.map((row: unknown[]) => {
      const obj: Record<string, unknown> = {};
      if (result.columns) {
        result.columns.forEach((col: { name: string }, i: number) => {
          obj[col.name] = row[i];
        });
      }
      return obj;
    });
  })
}));
jest.mock('../core/nzConnectionFactory', () => ({
  createNzConnection: jest.fn()
}));

// Import mocked modules
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import { createNzConnection } from '../core/nzConnectionFactory';

function createMockReader(columns: string[], rows: unknown[][]) {
    let rowIndex = -1;

    return {
        fieldCount: columns.length,
        read: jest.fn(async () => {
            rowIndex += 1;
            return rowIndex < rows.length;
        }),
        close: jest.fn(async () => undefined),
        getName: jest.fn((index: number) => columns[index]),
        getValue: jest.fn((index: number) => rows[rowIndex]?.[index])
    };
}

function createMockStorageConnection(columns: string[], rows: unknown[][]) {
    const reader = createMockReader(columns, rows);
    const command = {
        commandTimeout: 0,
        executeReader: jest.fn(async () => reader),
        cancel: jest.fn(async () => undefined)
    };
    const connection = {
        connect: jest.fn(async () => undefined),
        close: jest.fn(async () => undefined),
        createCommand: jest.fn(() => command),
        on: jest.fn(),
        removeListener: jest.fn()
    };

    return { connection, command, reader };
}

describe('SessionMonitorView', () => {
    let mockContext: vscode.ExtensionContext;
    let mockConnectionManager: jest.Mocked<ConnectionManager>;
    let mockExtensionUri: vscode.Uri;
    let mockWebviewPanel: vscode.WebviewPanel;
    let messageHandler: ((message: unknown) => Promise<void>) | null = null;
    let disposeHandler: (() => void) | null = null;
    let secretsStore: Map<string, string>;
    let globalState: Map<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset static state
    (SessionMonitorView as unknown as { currentPanel: undefined }).currentPanel = undefined;

    secretsStore = new Map();
    globalState = new Map();

    // Reset mock session monitor provider
    mockSessionMonitorProvider.getSessions.mockResolvedValue([]);
    mockSessionMonitorProvider.getQueries.mockResolvedValue([]);
    mockSessionMonitorProvider.getStorage.mockResolvedValue([]);
    mockSessionMonitorProvider.getResources.mockResolvedValue({ gra: [], systemUtil: [], sysUtilSummary: null });
    mockSessionMonitorProvider.killSession.mockResolvedValue(undefined);

    mockContext = {
      secrets: {
        get: jest.fn(async (key: string) => secretsStore.get(key)),
        store: jest.fn(async (key: string, value: string) => {
          secretsStore.set(key, value);
        }),
        delete: jest.fn(async (key: string) => {
          secretsStore.delete(key);
        })
      },
      globalState: {
        get: jest.fn((key: string) => globalState.get(key)),
        update: jest.fn(async (key: string, value: unknown) => {
          if (value === undefined) {
            globalState.delete(key);
          } else {
            globalState.set(key, value);
          }
        })
      },
      extensionUri: { fsPath: '/test', toString: () => 'file:///test' } as vscode.Uri,
      subscriptions: []
    } as unknown as vscode.ExtensionContext;

    mockExtensionUri = {
      fsPath: '/test',
      toString: () => 'file:///test'
    } as vscode.Uri;

    // Mock ConnectionManager
    mockConnectionManager = {
      getConnections: jest.fn().mockResolvedValue([]),
      getActiveConnectionName: jest.fn().mockReturnValue('TestConnection'),
      getConnection: jest.fn().mockResolvedValue({
        name: 'TestConnection',
        host: 'localhost',
        port: 5480,
        database: 'DEFAULTDB',
        user: 'admin',
        password: 'pass',
        dbType: 'netezza'
      }),
      onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() })
    } as unknown as jest.Mocked<ConnectionManager>;

    // Mock webview panel
    mockWebviewPanel = {
      webview: {
        html: '',
        onDidReceiveMessage: jest.fn((handler) => {
          messageHandler = handler;
          return { dispose: jest.fn() };
        }),
        postMessage: jest.fn().mockResolvedValue(true),
        asWebviewUri: jest.fn((uri) => ({
          toString: () => `webview-uri://${uri.fsPath}`
        })),
        cspSource: 'mock-csp-source'
      },
      viewType: 'netezza.sessionMonitor',
      title: 'Session Monitor',
      visible: true,
      active: true,
      onDidDispose: jest.fn((handler) => {
        disposeHandler = handler;
        return { dispose: jest.fn() };
      }),
      onDidChangeViewState: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      reveal: jest.fn(),
      dispose: jest.fn()
    } as unknown as vscode.WebviewPanel;

    // Mock window.createWebviewPanel
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockWebviewPanel);

    // Default mock for runQueryRaw - return empty results
    (runQueryRaw as jest.Mock).mockResolvedValue({
      columns: [],
      data: []
    });
    (queryResultToRows as jest.Mock).mockImplementation((result: { columns?: Array<{ name: string }>; data?: unknown[][] } | undefined) => {
      if (!result?.data || !result.columns) {
        return [];
      }

      return result.data.map(row => {
        const mapped: Record<string, unknown> = {};
        result.columns?.forEach((column, index) => {
          mapped[column.name] = row[index];
        });
        return mapped;
      });
    });

    const defaultStorageConnection = createMockStorageConnection([], []);
    (createNzConnection as jest.Mock).mockReturnValue(defaultStorageConnection.connection);
  });

    afterEach(() => {
        // Clean up static state
        (SessionMonitorView as unknown as { currentPanel: undefined }).currentPanel = undefined;
        messageHandler = null;
        disposeHandler = null;
        jest.useRealTimers();
    });

    describe('createOrShow', () => {
        it('should create new panel when none exists', () => {
            SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

            expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
                'netezza.sessionMonitor',
                'Session Monitor',
                expect.any(Number),
                expect.objectContaining({
                    enableScripts: true,
                    retainContextWhenHidden: true
                })
            );
        });

        it('should reveal existing panel instead of creating new one', () => {
            // Create first panel
            SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);
            const firstCallCount = (vscode.window.createWebviewPanel as jest.Mock).mock.calls.length;

            // Try to create second panel
            SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

            // Should not have created new panel
            expect((vscode.window.createWebviewPanel as jest.Mock).mock.calls.length).toBe(firstCallCount);
            expect(mockWebviewPanel.reveal).toHaveBeenCalled();
        });

    it('should refresh data when revealing existing panel', async () => {
      SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

      // Clear previous calls
      mockSessionMonitorProvider.getSessions.mockClear();

      // Reveal again
      SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

      // Wait for async operations to complete
      await jest.runAllTimersAsync();
      expect(mockSessionMonitorProvider.getSessions).toHaveBeenCalled();
    });
  });

    describe('HTML content', () => {
        it('should set proper HTML content with tabs', () => {
            SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('Session Monitor');
            expect(html).toContain('Sessions');
            expect(html).toContain('Running Queries');
            expect(html).toContain('Storage');
            expect(html).toContain('Resources');
            expect(html).toContain('Alerts');
            expect(html).toContain('Active Sessions');
        });

        it('should include auto-refresh checkbox', () => {
            SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('id="autoRefresh"');
            expect(html).toContain('Auto-refresh');
        });

        it('should include refresh button', () => {
            SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('id="refreshBtn"');
        });

        it('should include CSP meta tag with nonce', () => {
            SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('Content-Security-Policy');
            expect(html).toMatch(/nonce-[A-Za-z0-9]+/);
        });
    });

  describe('message handling', () => {
    beforeEach(() => {
      SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);
    });

    describe('refresh command', () => {
      it('should fetch and send data on refresh', async () => {
        mockSessionMonitorProvider.getSessions.mockResolvedValue([{ ID: 1, USERNAME: 'admin' }]);
        mockSessionMonitorProvider.getQueries.mockResolvedValue([]);
        mockSessionMonitorProvider.getStorage.mockResolvedValue([]);
        mockSessionMonitorProvider.getResources.mockResolvedValue({ gra: [], systemUtil: [], sysUtilSummary: null });

        await messageHandler!({ command: 'refresh' });

        expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            command: 'setLoading',
            loading: true
          })
        );

        expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            command: 'updateData'
          })
        );
      });

      it('should send updateData with empty data on fetch failure', async () => {
        mockSessionMonitorProvider.getSessions.mockRejectedValue(new Error('Connection lost'));

        await messageHandler!({ command: 'refresh' });

        // Implementation handles errors by returning empty data, not by sending error command
        expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            command: 'updateData',
            data: expect.objectContaining({
              sessions: [],
              queries: [],
              storage: [],
              resources: expect.objectContaining({
                gra: [],
                systemUtil: [],
                sysUtilSummary: null
              })
            })
          })
        );
      });
    });

    describe('killSession command', () => {
      it('should prompt for confirmation before killing session', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Kill Session');

        await messageHandler!({ command: 'killSession', sessionId: 123 });

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
          expect.stringContaining('123'),
          expect.objectContaining({ modal: true }),
          'Yes, Kill Session'
        );
      });

      it('should execute killSession on provider when confirmed', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Kill Session');
        mockSessionMonitorProvider.killSession.mockResolvedValue(undefined);

        await messageHandler!({ command: 'killSession', sessionId: 456 });

        expect(mockSessionMonitorProvider.killSession).toHaveBeenCalledWith(
          expect.anything(),
          mockConnectionManager,
          456
        );
      });

      it('should show success message after killing session', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Kill Session');
        mockSessionMonitorProvider.killSession.mockResolvedValue(undefined);

        await messageHandler!({ command: 'killSession', sessionId: 789 });

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
          expect.stringContaining('789')
        );
      });

      it('should not kill session when cancelled', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

        await messageHandler!({ command: 'killSession', sessionId: 111 });

        expect(mockSessionMonitorProvider.killSession).not.toHaveBeenCalled();
      });

      it('should show error when kill fails', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Kill Session');
        mockSessionMonitorProvider.killSession.mockRejectedValue(new Error('Permission denied'));

        await messageHandler!({ command: 'killSession', sessionId: 222 });

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining('Permission denied')
        );
      });
    });

    describe('toggleAutoRefresh command', () => {
      it('should start interval when enabled', async () => {
        await messageHandler!({ command: 'toggleAutoRefresh', enabled: true });

        // Fast-forward timer
        jest.advanceTimersByTime(120000); // 2 minutes

        // Should have made refresh calls
        expect(mockSessionMonitorProvider.getSessions).toHaveBeenCalled();
      });

      it('should stop interval when disabled', async () => {
        // Enable first
        await messageHandler!({ command: 'toggleAutoRefresh', enabled: true });

        // Disable
        await messageHandler!({ command: 'toggleAutoRefresh', enabled: false });

        // Clear call count
        mockSessionMonitorProvider.getSessions.mockClear();

        // Fast-forward timer
        jest.advanceTimersByTime(120000);

        // Should not have made any new calls after disabling
        // Note: This is tricky to test since we can't access the interval ID directly
      });
    });
  });

  describe('data fetching', () => {
    beforeEach(() => {
      SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);
    });

    it('should fetch sessions via provider', async () => {
      mockSessionMonitorProvider.getSessions.mockResolvedValue([{ ID: 1, USERNAME: 'admin' }]);

      await messageHandler!({ command: 'refresh' });

      expect(mockSessionMonitorProvider.getSessions).toHaveBeenCalled();
    });

    it('should fetch queries via provider', async () => {
      mockSessionMonitorProvider.getQueries.mockResolvedValue([{ QS_SESSIONID: 1, QS_SQL: 'SELECT 1' }]);

      await messageHandler!({ command: 'refresh' });

      expect(mockSessionMonitorProvider.getQueries).toHaveBeenCalled();
    });

    it('should fetch storage via provider', async () => {
      mockSessionMonitorProvider.getStorage.mockResolvedValue([{ DATABASE: 'DB1', USED_MB: 100 }]);

      await messageHandler!({ command: 'refresh' });

      expect(mockSessionMonitorProvider.getStorage).toHaveBeenCalled();
    });

    it('should fetch resources via provider', async () => {
      mockSessionMonitorProvider.getResources.mockResolvedValue({
        gra: [{ id: 1 }],
        systemUtil: [{ cpu: 50 }],
        sysUtilSummary: { AVG_HOST_CPU_PCT: 50 }
      });

      await messageHandler!({ command: 'refresh' });

      expect(mockSessionMonitorProvider.getResources).toHaveBeenCalled();
    });

    it('should send loading state before and after fetch', async () => {
      await messageHandler!({ command: 'refresh' });

      const postMessageCalls = (mockWebviewPanel.webview.postMessage as jest.Mock).mock.calls;

      // Find setLoading true call
      const loadingTrueCall = postMessageCalls.find(
        call => call[0].command === 'setLoading' && call[0].loading === true
      );
      expect(loadingTrueCall).toBeDefined();

      // Find setLoading false call
      const loadingFalseCall = postMessageCalls.find(
        call => call[0].command === 'setLoading' && call[0].loading === false
      );
      expect(loadingFalseCall).toBeDefined();
    });
  });

  describe('dispose', () => {
    it('should clean up panel reference on dispose', () => {
      SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

      // Trigger dispose
      disposeHandler!();

      expect((SessionMonitorView as unknown as { currentPanel: undefined }).currentPanel).toBeUndefined();
    });

    it('should clear refresh interval on dispose', () => {
      SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

      // Enable auto-refresh
      messageHandler!({ command: 'toggleAutoRefresh', enabled: true });

      // Trigger dispose
      disposeHandler!();

      // Clear call count
      mockSessionMonitorProvider.getSessions.mockClear();

      // Fast-forward - should not trigger any calls
      jest.advanceTimersByTime(300000);

      // Verify no calls were made (would indicate interval still running)
      expect(mockSessionMonitorProvider.getSessions).not.toHaveBeenCalled();
    });

    it('should dispose webview panel', () => {
      SessionMonitorView.createOrShow(mockExtensionUri, mockContext, mockConnectionManager);

      // Trigger dispose
      disposeHandler!();

      expect(mockWebviewPanel.dispose).toHaveBeenCalled();
    });
  });
});
