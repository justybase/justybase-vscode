import * as vscode from "vscode";
import { registerCoreCommands } from "../commands/coreCommands";
import type { CoreCommandsContext } from "../commands/coreCommands";

jest.mock("vscode", () => ({
  commands: {
    registerCommand: jest.fn(),
  },
  window: {
    activeTextEditor: undefined,
    showWarningMessage: jest.fn(),
    showInformationMessage: jest.fn(),
    openTextDocument: jest.fn(),
    showTextDocument: jest.fn(),
    createTextEditorDecorationType: jest.fn(() => ({})),
  },
  workspace: {
    openTextDocument: jest.fn(),
  },
  DecorationRangeBehavior: {
    ClosedClosed: 1,
  },
}));

jest.mock("../views/loginPanel", () => ({
  LoginPanel: {
    createOrShow: jest.fn(),
    createNew: jest.fn(),
  },
}));

jest.mock("../views/editDataProvider", () => ({
  EditDataProvider: {
    createOrShow: jest.fn(),
  },
}));

jest.mock("../views/etlDesignerView", () => ({
  EtlDesignerView: {
    setConnectionManager: jest.fn(),
    createOrShow: jest.fn(),
  },
}));

jest.mock("../etl/etlProjectManager", () => ({
  EtlProjectManager: {
    getInstance: jest.fn(() => ({
      createProject: jest.fn(),
      loadProject: jest.fn(),
      getCurrentProject: jest.fn(),
    })),
  },
}));

jest.mock("../sql/sqlParser", () => ({
  SqlParser: {
    getObjectAtPosition: jest.fn(),
  },
}));

jest.mock("../utils/shellUtils", () => ({
  buildExecCommand: jest.fn(),
}));

jest.mock("../core/queryRunner", () => ({
  runQueryRaw: jest.fn(),
  runExplainQuery: jest.fn(),
  runQueriesWithStreaming: jest.fn(),
  runQueriesSequentially: jest.fn(),
  queryResultToRows: jest.fn(),
}));

jest.mock("../metadata/prefetchSupport", () => ({
  supportsLegacyMetadataPrefetch: jest.fn(() => false),
}));

jest.mock("../services/perf/performanceEvents", () => ({
  createPerformanceTimer: jest.fn(() => ({
    finish: jest.fn(() => ({})),
  })),
  formatPerformanceEvent: jest.fn(() => ""),
}));

jest.mock("../utils/queryFlowEditor", () => ({
  findVisibleQueryFlowEditor: jest.fn(),
}));

jest.mock("../compatibility/configuration", () => ({
  getExtensionConfiguration: jest.fn(() => ({
    get: jest.fn(),
  })),
}));

describe("registerCoreCommands", () => {
  let registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  let ctx: CoreCommandsContext;
  let metadataCache: {
    getStatsSnapshot: jest.Mock;
    logStats: jest.Mock;
    clearCache: jest.Mock;
    triggerConnectionPrefetch: jest.Mock;
  };

  const mockedRegisterCommand = vscode.commands.registerCommand as jest.Mock;
  const mockedShowWarningMessage = vscode.window.showWarningMessage as jest.Mock;
  const mockedOpenTextDocument = vscode.workspace.openTextDocument as jest.Mock;
  const mockedShowTextDocument = vscode.window.showTextDocument as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    registeredCommands = new Map();
    mockedRegisterCommand.mockImplementation((command: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, handler);
      return { dispose: jest.fn() };
    });

    metadataCache = {
      getStatsSnapshot: jest.fn(),
      logStats: jest.fn(),
      clearCache: jest.fn(),
      triggerConnectionPrefetch: jest.fn(),
    };

    ctx = {
      context: {
        extensionUri: {} as vscode.Uri,
      } as vscode.ExtensionContext,
      connectionManager: {
        getConnectionForExecution: jest.fn(),
        getActiveConnectionName: jest.fn(),
        setDocumentConnection: jest.fn(),
        getConnectionDatabaseKind: jest.fn(),
      } as unknown as CoreCommandsContext["connectionManager"],
      metadataCache: metadataCache as unknown as CoreCommandsContext["metadataCache"],
      schemaProvider: {
        clearAllErrors: jest.fn(),
        refresh: jest.fn(),
      } as unknown as CoreCommandsContext["schemaProvider"],
      resultPanelProvider: {
        triggerCopySelection: jest.fn(),
        getPerformanceStatsReport: jest.fn(),
        clearPerformanceStats: jest.fn(),
      } as unknown as CoreCommandsContext["resultPanelProvider"],
      keepConnectionStatusBar: {} as vscode.StatusBarItem,
      getDatabaseList: jest.fn(),
    };

    mockedOpenTextDocument.mockResolvedValue({ uri: { toString: () => "file:///tmp/stats.md" } });
    mockedShowTextDocument.mockResolvedValue(undefined);
  });

  const getCommand = (name: string): ((...args: unknown[]) => Promise<void>) => {
    registerCoreCommands(ctx);
    const command = registeredCommands.get(name);
    expect(command).toBeDefined();
    return command as (...args: unknown[]) => Promise<void>;
  };

  it("warns when metadata stats are requested without an active connection", async () => {
    (ctx.connectionManager.getConnectionForExecution as jest.Mock).mockReturnValue(undefined);
    (ctx.connectionManager.getActiveConnectionName as jest.Mock).mockReturnValue(undefined);

    const command = getCommand("netezza.showMetadataCacheStats");
    await command();

    expect(mockedShowWarningMessage).toHaveBeenCalledWith("No active connection. Select a connection first.");
    expect(metadataCache.getStatsSnapshot).not.toHaveBeenCalled();
  });

  it("opens a markdown report for the active connection", async () => {
    (ctx.connectionManager.getConnectionForExecution as jest.Mock).mockReturnValue("DEV");
    metadataCache.getStatsSnapshot.mockReturnValue({
      connectionName: "DEV",
      hits: {
        database: 2,
        schema: 1,
        table: 3,
        column: 4,
        procedure: 0,
        typeGroup: 1,
        objectLookup: 5,
      },
      misses: {
        database: 1,
        schema: 0,
        table: 1,
        column: 2,
        procedure: 0,
        typeGroup: 0,
        objectLookup: 1,
      },
      totalEntries: 12,
      ttlEvictions: 2,
      refreshOps: [
        {
          layer: "column",
          key: "DB1.S1.T1",
          durationMs: 7,
          timestamp: Date.now(),
          entryCount: 4,
        },
      ],
    });

    const command = getCommand("netezza.showMetadataCacheStats");
    await command();

    expect(metadataCache.logStats).toHaveBeenCalledWith("DEV");
    expect(mockedOpenTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "markdown",
        content: expect.stringContaining("# Metadata Cache Stats"),
      }),
    );
    expect(mockedOpenTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("| column | 4 | 2 | 66.7% |"),
      }),
    );
    expect(mockedOpenTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("| column | DB1.S1.T1 | 7 | 4 |"),
      }),
    );
    expect(mockedShowTextDocument).toHaveBeenCalled();
    expect(ctx.connectionManager.setDocumentConnection).toHaveBeenCalledWith("file:///tmp/stats.md", "DEV");
  });

  it("shows an informational message when result panel perf stats are empty", async () => {
    const command = getCommand("netezza.showResultPanelPerformanceStats");

    await command();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "No result panel performance samples recorded yet. Run queries and open results first."
    );
    expect(mockedOpenTextDocument).not.toHaveBeenCalled();
  });

  it("opens a markdown report for recorded result panel perf stats", async () => {
    (ctx.resultPanelProvider.getPerformanceStatsReport as jest.Mock).mockReturnValue(
      "# Result Panel Performance Stats\n\nSamples: 3"
    );
    (ctx.connectionManager.getActiveConnectionName as jest.Mock).mockReturnValue("DEV");

    const command = getCommand("netezza.showResultPanelPerformanceStats");
    await command();

    expect(mockedOpenTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "markdown",
        content: expect.stringContaining("# Result Panel Performance Stats"),
      }),
    );
    expect(ctx.connectionManager.setDocumentConnection).toHaveBeenCalledWith("file:///tmp/stats.md", "DEV");
    expect(mockedShowTextDocument).toHaveBeenCalled();
  });

  it("clears recorded result panel perf stats after confirmation", async () => {
    mockedShowWarningMessage.mockResolvedValue("Clear Stats");

    const command = getCommand("netezza.clearResultPanelPerformanceStats");
    await command();

    expect(mockedShowWarningMessage).toHaveBeenCalledWith(
      "Clear stored result panel first-paint samples? This resets the local runtime baseline used for dogfooding reports.",
      { modal: true },
      "Clear Stats",
    );
    expect(ctx.resultPanelProvider.clearPerformanceStats).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Result panel performance stats cleared."
    );
  });

  it("does not clear result panel perf stats when confirmation is dismissed", async () => {
    mockedShowWarningMessage.mockResolvedValue(undefined);

    const command = getCommand("netezza.clearResultPanelPerformanceStats");
    await command();

    expect(ctx.resultPanelProvider.clearPerformanceStats).not.toHaveBeenCalled();
  });
});
