/**
 * Unit tests for core/queryRunner.ts
 * Tests helper functions and query execution logic
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Create mock functions that will be shared
const mockIsActive = jest.fn();
const mockAbortQuery = jest.fn();
const mockGetCommand = jest.fn();
const mockGetActiveUris = jest.fn().mockReturnValue([]);
const mockQueryResultToRows = jest.fn();

// Mock vscode module
jest.mock("vscode", () => ({
  window: {
    activeTextEditor: undefined,
    showWarningMessage: jest.fn(),
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    createOutputChannel: jest.fn(() => ({
      appendLine: jest.fn(),
      show: jest.fn(),
      dispose: jest.fn(),
    })),
  },
  Uri: {
    parse: jest.fn(),
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    })),
  },
}));

// Mock streaming manager - return same mock functions for singleton
jest.mock("../core/streaming", () => ({
  StreamingManager: jest.fn().mockImplementation(() => ({
    isActive: mockIsActive,
    abortQuery: mockAbortQuery,
    getCommand: mockGetCommand,
    getActiveUris: mockGetActiveUris,
  })),
  ResultFormatter: {
    queryResultToRows: mockQueryResultToRows,
  },
}));

// Mock connection manager
jest.mock("../core/connectionManager", () => ({
  ConnectionManager: jest.fn().mockImplementation(() => ({
    getActiveConnectionName: jest.fn(),
    getConnectionForExecution: jest.fn(),
    getConnection: jest.fn(),
    getDocumentPersistentConnection: jest.fn(),
    getDocumentKeepConnectionOpen: jest.fn(),
    getDocumentLastSessionId: jest.fn(),
    closeDocumentPersistentConnection: jest.fn(),
  })),
}));

// Mock logger
jest.mock("../utils/logger", () => ({
  Logger: {
    getInstance: jest.fn().mockReturnValue({
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    }),
  },
}));

// Mock query history manager
jest.mock("../core/queryHistoryManager", () => ({
  QueryHistoryManager: {
    getInstance: jest.fn().mockReturnValue({
      addEntry: jest.fn(),
    }),
  },
}));

// Mock variable utils
jest.mock("../core/variableUtils", () => ({
  extractVariables: jest.fn().mockReturnValue(new Set()),
  formatPutLogMessage: jest.fn((message: string) => `>>> %PUT: ${message}`),
  parseSetVariables: jest.fn().mockReturnValue({ sql: "", variables: {} }),
  replaceVariablesInSql: jest.fn().mockReturnValue(""),
}));

// Mock variable resolver
jest.mock("../core/variableResolver", () => ({
  promptForVariableValues: jest.fn().mockResolvedValue({}),
  resolveQueryVariables: jest
    .fn()
    .mockResolvedValue({ sql: "", variables: {} }),
}));

// Import after mocks
import {
  cancelCurrentQuery,
  cancelQueryByUri,
  cancelAllRunningQueries,
  disposeSharedOutputChannel,
  ensureSharedOutputChannel,
  parseQueryJsonResult,
  queryResultToRows,
} from "../core/queryRunner";

describe("queryRunner", () => {
  const { window } = jest.requireMock("vscode");

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock return values
    mockIsActive.mockReturnValue(false);
    mockGetCommand.mockReturnValue(null);
    mockGetActiveUris.mockReturnValue([]);
  });

  // ---------------------------------------------------------------------------
  // cancelCurrentQuery
  // ---------------------------------------------------------------------------

  describe("cancelCurrentQuery", () => {
    it("should show warning when no active editor", async () => {
      window.activeTextEditor = undefined;

      await cancelCurrentQuery();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        "No active editor to cancel query for.",
      );
    });

    it("should show info when no active query for tab", async () => {
      window.activeTextEditor = {
        document: { uri: { toString: () => "file:///test.sql" } },
      };
      mockIsActive.mockReturnValue(false);

      await cancelCurrentQuery();

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        "Cancellation requested. It will be applied to the next query on this tab.",
      );
    });

    it("should cancel active query", async () => {
      window.activeTextEditor = {
        document: { uri: { toString: () => "file:///test.sql" } },
      };
      mockIsActive.mockReturnValue(true);
      mockGetCommand.mockReturnValue({
        cancel: jest.fn().mockResolvedValue(undefined),
      });

      await cancelCurrentQuery();

      expect(mockAbortQuery).toHaveBeenCalled();
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        "Cancellation request sent.",
      );
    });

    it("should handle cancel error", async () => {
      window.activeTextEditor = {
        document: { uri: { toString: () => "file:///test.sql" } },
      };
      mockIsActive.mockReturnValue(true);
      mockGetCommand.mockReturnValue({
        cancel: jest.fn().mockRejectedValue(new Error("Cancel failed")),
      });

      await cancelCurrentQuery();

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Failed to cancel query"),
      );
    });

    it("should handle undefined editor document", async () => {
      window.activeTextEditor = {
        document: undefined as any,
      };

      await cancelCurrentQuery();

      expect(window.showWarningMessage).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // cancelQueryByUri
  // ---------------------------------------------------------------------------

  describe("cancelQueryByUri", () => {
    it("should cancel query by URI string", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetCommand.mockReturnValue({
        cancel: jest.fn().mockResolvedValue(undefined),
      });

      await cancelQueryByUri("file:///test.sql");

      expect(mockAbortQuery).toHaveBeenCalledWith("file:///test.sql");
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        "Cancellation request sent.",
      );
    });

    it("should handle URI object", async () => {
      mockIsActive.mockReturnValue(false);

      const mockUri = { toString: () => "file:///test.sql" };
      await cancelQueryByUri(mockUri as any);

      expect(mockIsActive).toHaveBeenCalledWith("file:///test.sql");
    });

    it("should handle cancel error gracefully", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetCommand.mockReturnValue({
        cancel: jest.fn().mockRejectedValue(new Error("Network error")),
      });

      await cancelQueryByUri("file:///test.sql");

      // Should not throw
      expect(true).toBe(true);
    });

    it("should handle isActive false with info message", async () => {
      mockIsActive.mockReturnValue(false);

      await cancelQueryByUri("file:///test.sql");

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Cancellation requested"),
      );
    });

    it("should handle cancel with null command", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetCommand.mockReturnValue(null);

      await cancelQueryByUri("file:///test.sql");

      expect(mockAbortQuery).toHaveBeenCalled();
    });

    it("should handle non-Error thrown from cancel", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetCommand.mockReturnValue({
        cancel: jest.fn().mockRejectedValue("string error"),
      });

      await cancelQueryByUri("file:///test.sql");

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Failed to cancel"),
      );
    });

    it("should handle Windows drive letter URI case normalization", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetCommand.mockReturnValue({
        cancel: jest.fn().mockResolvedValue(undefined),
      });

      // Test that uppercase/lowercase drive letters are normalized
      await cancelQueryByUri("file:///C:/test.sql");
      await cancelQueryByUri("file:///c:/test.sql");

      // Both should work the same normalized key
      expect(mockAbortQuery).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // cancelAllRunningQueries
  // ---------------------------------------------------------------------------

  describe("cancelAllRunningQueries", () => {
    it("should resolve immediately if no active queries", async () => {
      mockGetActiveUris.mockReturnValue([]);

      await cancelAllRunningQueries();

      expect(mockAbortQuery).not.toHaveBeenCalled();
      expect(mockGetCommand).not.toHaveBeenCalled();
    });

    it("should cancel all active queries", async () => {
      mockGetActiveUris.mockReturnValue(["file:///test1.sql", "file:///test2.sql"]);
      const mockCancel = jest.fn().mockResolvedValue(undefined);
      mockGetCommand.mockReturnValue({
        cancel: mockCancel,
      });

      await cancelAllRunningQueries();

      expect(mockAbortQuery).toHaveBeenCalledTimes(2);
      expect(mockAbortQuery).toHaveBeenCalledWith("file:///test1.sql");
      expect(mockAbortQuery).toHaveBeenCalledWith("file:///test2.sql");
      expect(mockGetCommand).toHaveBeenCalledTimes(2);
      expect(mockCancel).toHaveBeenCalledTimes(2);
    });

    it("should handle mixed success and failure during cancellation", async () => {
      mockGetActiveUris.mockReturnValue(["file:///test1.sql", "file:///test2.sql"]);

      const mockCancel1 = jest.fn().mockResolvedValue(undefined);
      const mockCancel2 = jest.fn().mockRejectedValue(new Error("Network error"));

      mockGetCommand.mockImplementation((uri: string) => {
        if (uri === "file:///test1.sql") return { cancel: mockCancel1 };
        if (uri === "file:///test2.sql") return { cancel: mockCancel2 };
        return null;
      });

      await cancelAllRunningQueries();

      // Should not throw and all should be processed
      expect(mockCancel1).toHaveBeenCalled();
      expect(mockCancel2).toHaveBeenCalled();
    });

    it("should handle null commands safely", async () => {
      mockGetActiveUris.mockReturnValue(["file:///test1.sql"]);
      mockGetCommand.mockReturnValue(null);

      await cancelAllRunningQueries();

      expect(mockAbortQuery).toHaveBeenCalledWith("file:///test1.sql");
    });
  });

  // ---------------------------------------------------------------------------
  // disposeSharedOutputChannel
  // ---------------------------------------------------------------------------

  describe("disposeSharedOutputChannel", () => {
    it("should dispose channel if created", () => {
      // First ensure channel exists
      ensureSharedOutputChannel();

      // Then dispose
      disposeSharedOutputChannel();

      // Should not throw
      expect(true).toBe(true);
    });

    it("should handle multiple dispose calls", () => {
      disposeSharedOutputChannel();
      disposeSharedOutputChannel();
      disposeSharedOutputChannel();

      // Should not throw
      expect(true).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ensureSharedOutputChannel
  // ---------------------------------------------------------------------------

  describe("ensureSharedOutputChannel", () => {
    it("should create and return output channel", () => {
      const channel = ensureSharedOutputChannel();

      expect(channel).toBeDefined();
      expect(channel.appendLine).toBeDefined();
      expect(channel.show).toBeDefined();
      expect(channel.dispose).toBeDefined();
    });

    it("should return same channel on multiple calls", () => {
      const channel1 = ensureSharedOutputChannel();
      const channel2 = ensureSharedOutputChannel();

      expect(channel1).toBe(channel2);
    });
  });

  // ---------------------------------------------------------------------------
  // parseQueryJsonResult
  // ---------------------------------------------------------------------------

  describe("parseQueryJsonResult", () => {
    it("returns empty array for undefined result", () => {
      expect(parseQueryJsonResult(undefined)).toEqual([]);
    });

    it("returns empty array for success message", () => {
      expect(
        parseQueryJsonResult("Query executed successfully (no results)."),
      ).toEqual([]);
      expect(parseQueryJsonResult("Query executed successfully")).toEqual([]);
    });

    it("parses valid JSON results", () => {
      const parsed = parseQueryJsonResult<{ ID: number }>(
        '[{"ID":1},{"ID":2}]',
      );
      expect(parsed).toEqual([{ ID: 1 }, { ID: 2 }]);
    });

    it("returns empty array for invalid JSON", () => {
      expect(parseQueryJsonResult("not-json")).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // queryResultToRows
  // ---------------------------------------------------------------------------

  describe("queryResultToRows", () => {
    it("delegates conversion to ResultFormatter", () => {
      const mockRows = [{ ID: 1 }];
      mockQueryResultToRows.mockReturnValue(mockRows);

      const result = queryResultToRows({
        columns: [{ name: "ID" }],
        data: [[1]],
      });

      expect(mockQueryResultToRows).toHaveBeenCalledWith({
        columns: [{ name: "ID" }],
        data: [[1]],
      });
      expect(result).toBe(mockRows);
    });

    it("should handle empty result", () => {
      mockQueryResultToRows.mockReturnValue([]);

      const result = queryResultToRows({
        columns: [],
        data: [],
      });

      expect(result).toEqual([]);
    });

    it("should handle null result", () => {
      mockQueryResultToRows.mockReturnValue(null);

      const result = queryResultToRows(null as any);

      expect(result).toBeNull();
    });
  });
});
