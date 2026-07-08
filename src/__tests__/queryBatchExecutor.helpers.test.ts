/**
 * Unit tests for core/queryBatchExecutor.ts helper functions
 * Tests: resolveBatchConnectionName, resolveBatchVariables, captureSessionId,
 * handleBatchRetry, handleBatchError, getQueryConfig, etc.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from "vscode";

jest.mock("vscode", () => ({
  window: {
    showErrorMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showInformationMessage: jest.fn(),
  },
  workspace: {
    getConfiguration: jest.fn().mockReturnValue({
      get: jest.fn().mockImplementation((_key: string, def: unknown) => def),
    }),
  },
  Uri: { file: jest.fn((p: string) => ({ fsPath: p })) },
}));

jest.mock("../core/queryRunnerUtils", () => ({
  normalizeUriKey: jest.fn().mockImplementation((uri: string) => uri),
  getOutputChannel: jest.fn().mockReturnValue({
    appendLine: jest.fn(),
    show: jest.fn(),
  }),
  isConnectionBrokenError: jest.fn().mockReturnValue(false),
  logOutput: jest.fn(),
}));

jest.mock("../core/queryHistoryManager", () => ({
  QueryHistoryManager: {
    getInstance: jest.fn().mockReturnValue({
      addEntry: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock("../core/variableUtils", () => ({
  extractVariables: jest.fn().mockReturnValue(new Set(["var1", "var2"])),
  formatPutLogMessage: jest.fn((message: string) => `>>> %PUT: ${message}`),
  parseSetVariables: jest.fn().mockImplementation((sql: string) => ({
    sql,
    setValues: {},
  })),
  replaceVariablesInSql: jest.fn().mockImplementation((sql: string) => sql),
}));

jest.mock("../core/variableResolver", () => ({
  promptForVariableValues: jest
    .fn()
    .mockResolvedValue({ var1: "val1", var2: "val2" }),
}));

jest.mock("../core/queryRunnerHelpers", () => ({
  handleBusyConnectionError: jest.fn().mockResolvedValue(false),
  executeDropSession: jest.fn().mockResolvedValue(undefined),
}));

import {
  resolveBatchConnectionName,
  resolveBatchVariables,
  captureSessionId,
  setupBatchLogger,
  logBatch,
  prepareQueryForExecution,
  logQueryToHistoryAsync,
  handleBatchRetry,
  handleBatchError,
  createDropSessionCallback,
  getQueryConfig,
} from "../core/queryBatchExecutor";

function createMockConnection() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    removeListener: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    createCommand: jest.fn().mockReturnValue({
      executeReader: jest.fn().mockResolvedValue({
        read: jest
          .fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
        getValue: jest.fn().mockReturnValue("12345"),
        close: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

function createMockConnManager(overrides: Record<string, any> = {}) {
  return {
    getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(true),
    getConnectionForExecution: jest.fn().mockReturnValue("testConn"),
    getActiveConnectionName: jest.fn().mockReturnValue("testConn"),
    getConnection: jest.fn().mockResolvedValue({
      host: "localhost",
      port: 5480,
      database: "testdb",
      user: "admin",
      password: "pass",
    }),
    setDocumentLastSessionId: jest.fn(),
    getDocumentLastSessionId: jest.fn(),
    getDocumentPersistentConnection: jest.fn(),
    closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function createMockContext(): vscode.ExtensionContext {
  return {
    extensionUri: { fsPath: "D:\\ext" } as vscode.Uri,
    subscriptions: [],
    globalState: { get: jest.fn(), update: jest.fn() },
    workspaceState: { get: jest.fn(), update: jest.fn() },
  } as unknown as vscode.ExtensionContext;
}

describe("queryBatchExecutor helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("resolveBatchConnectionName", () => {
    it("should use document connection when available", () => {
      const cm = createMockConnManager();
      const result = resolveBatchConnectionName(cm, "file:///test.sql");
      expect(result).toBe("testConn");
      expect(cm.getConnectionForExecution).toHaveBeenCalledWith(
        "file:///test.sql",
      );
    });

    it("should fallback to active connection", () => {
      const cm = createMockConnManager({
        getConnectionForExecution: jest.fn().mockReturnValue(undefined),
      });
      const result = resolveBatchConnectionName(cm, "file:///test.sql");
      expect(result).toBe("testConn");
      expect(cm.getActiveConnectionName).toHaveBeenCalled();
    });

    it("should throw when no connection available", () => {
      const cm = createMockConnManager({
        getConnectionForExecution: jest.fn().mockReturnValue(undefined),
        getActiveConnectionName: jest.fn().mockReturnValue(undefined),
      });
      expect(() => resolveBatchConnectionName(cm, "file:///test.sql")).toThrow(
        "No connection selected",
      );
    });

    it("should work without documentUri", () => {
      const cm = createMockConnManager();
      const result = resolveBatchConnectionName(cm, undefined);
      expect(result).toBe("testConn");
    });
  });

  describe("resolveBatchVariables", () => {
    it("should extract variables from queries", async () => {
      const ctx = createMockContext();
      const result = await resolveBatchVariables(["SELECT ${var1}"], ctx);
      expect(result).toEqual({ var1: "val1", var2: "val2" });
    });

    it("should handle empty queries array", async () => {
      const { extractVariables } = require("../core/variableUtils");
      (extractVariables as jest.Mock).mockReturnValueOnce(new Set());

      const ctx = createMockContext();
      const result = await resolveBatchVariables([], ctx);
      expect(result).toEqual({});
    });

    it("should not prompt when all variables have defaults", async () => {
      const { parseSetVariables } = require("../core/variableUtils");
      (parseSetVariables as jest.Mock).mockReturnValueOnce({
        sql: "SELECT 1",
        setValues: { var1: "default1", var2: "default2" },
      });
      const { extractVariables } = require("../core/variableUtils");
      (extractVariables as jest.Mock).mockReturnValueOnce(
        new Set(["var1", "var2"]),
      );

      const { promptForVariableValues } = require("../core/variableResolver");
      const ctx = createMockContext();
      await resolveBatchVariables(["SELECT 1"], ctx);

      expect(promptForVariableValues).not.toHaveBeenCalled();
    });
  });

  describe("captureSessionId", () => {
    it("should capture and store session ID", async () => {
      const conn = createMockConnection();
      const cm = createMockConnManager();
      const logCallback = jest.fn();

      const result = await captureSessionId(
        conn,
        cm,
        "file:///test.sql",
        logCallback,
      );

      expect(result).toBe("12345");
      expect(cm.setDocumentLastSessionId).toHaveBeenCalled();
      expect(logCallback).toHaveBeenCalledWith(
        expect.stringContaining("Session ID: 12345"),
      );
    });

    it("should return undefined on error", async () => {
      const conn = {
        createCommand: jest.fn().mockReturnValue({
          executeReader: jest.fn().mockRejectedValue(new Error("No session")),
        }),
      } as any;
      const cm = createMockConnManager();

      const result = await captureSessionId(conn, cm, "file:///test.sql");
      expect(result).toBeUndefined();
    });

    it("should handle reader.read() returning false", async () => {
      const conn = {
        createCommand: jest.fn().mockReturnValue({
          executeReader: jest.fn().mockResolvedValue({
            read: jest.fn().mockResolvedValue(false),
            close: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      } as any;
      const cm = createMockConnManager();

      const result = await captureSessionId(conn, cm, "file:///test.sql");
      expect(result).toBeUndefined();
    });

    it("should work without documentUri", async () => {
      const conn = createMockConnection();
      const cm = createMockConnManager();

      const result = await captureSessionId(conn, cm, undefined);
      expect(result).toBe("12345");
      expect(cm.setDocumentLastSessionId).not.toHaveBeenCalled();
    });
  });

  describe("setupBatchLogger", () => {
    it("should create output channel when no logCallback", () => {
      const { getOutputChannel } = require("../core/queryRunnerUtils");
      const mockChannel = { appendLine: jest.fn(), show: jest.fn() };
      (getOutputChannel as jest.Mock).mockReturnValue(mockChannel);

      const result = setupBatchLogger(undefined, 5, "sequential");

      expect(result).toBe(mockChannel);
      expect(mockChannel.show).toHaveBeenCalledWith(true);
    });

    it("should return undefined when logCallback provided", () => {
      const logCallback = jest.fn();
      const result = setupBatchLogger(logCallback, 5, "streaming");
      expect(result).toBeUndefined();
    });
  });

  describe("logBatch", () => {
    it("should log to output channel", () => {
      const channel = { appendLine: jest.fn() } as any;
      logBatch(channel, undefined, "test message");
      expect(channel.appendLine).toHaveBeenCalledWith("test message");
    });

    it("should call logCallback", () => {
      const logCallback = jest.fn();
      logBatch(undefined, logCallback, "test message");
      expect(logCallback).toHaveBeenCalledWith("test message");
    });

    it("should log to both when both provided", () => {
      const channel = { appendLine: jest.fn() } as any;
      const logCallback = jest.fn();
      logBatch(channel, logCallback, "test message");
      expect(channel.appendLine).toHaveBeenCalledWith("test message");
      expect(logCallback).toHaveBeenCalledWith("test message");
    });
  });

  describe("prepareQueryForExecution", () => {
    it("should strip @SET directives and replace variables", async () => {
      const result = await prepareQueryForExecution("SELECT ${var1}", {
        var1: "val1",
      });
      expect(result).toBe("SELECT val1");
    });
  });

  describe("logQueryToHistoryAsync", () => {
    it("should call addEntry on history manager", async () => {
      const mockAddEntry = jest.fn().mockResolvedValue(undefined);
      const historyManager = { addEntry: mockAddEntry } as any;

      logQueryToHistoryAsync(
        historyManager,
        "localhost",
        "testdb",
        "SELECT 1",
        "testConn",
      );

      await new Promise((resolve) => setImmediate(resolve));
      expect(mockAddEntry).toHaveBeenCalledWith(
        "localhost",
        "testdb",
        "unknown",
        "SELECT 1",
        "testConn",
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it("should handle errors silently", async () => {
      const consoleErrorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const mockAddEntry = jest
        .fn()
        .mockRejectedValue(new Error("write failed"));
      const historyManager = { addEntry: mockAddEntry } as any;

      logQueryToHistoryAsync(
        historyManager,
        "localhost",
        "testdb",
        "SELECT 1",
        "testConn",
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe("handleBatchRetry", () => {
    it("should not retry on first error if not broken connection", async () => {
      const cm = createMockConnManager();
      const { isConnectionBrokenError } = require("../core/queryRunnerUtils");
      (isConnectionBrokenError as jest.Mock).mockReturnValueOnce(false);

      const result = await handleBatchRetry(
        new Error("some error"),
        false,
        cm,
        "file:///test.sql",
        true,
        undefined,
        undefined,
        () => Promise.resolve([] as any),
      );

      expect(result).toEqual({ handled: false });
    });

    it("should retry on broken connection error", async () => {
      const cm = createMockConnManager();
      const { isConnectionBrokenError } = require("../core/queryRunnerUtils");
      (isConnectionBrokenError as jest.Mock).mockReturnValueOnce(true);

      const retryFn = jest.fn().mockResolvedValue(["result"] as any);
      const result = await handleBatchRetry(
        new Error("connection reset"),
        false,
        cm,
        "file:///test.sql",
        true,
        undefined,
        undefined,
        retryFn,
      );

      expect(result).toEqual({ handled: true, result: ["result"] });
      expect(cm.closeDocumentPersistentConnection).toHaveBeenCalledWith(
        "file:///test.sql",
      );
    });

    it("should prefer structured retry logging over plain log callback when provided", async () => {
      const cm = createMockConnManager();
      const { isConnectionBrokenError } = require("../core/queryRunnerUtils");
      (isConnectionBrokenError as jest.Mock).mockReturnValueOnce(true);

      const logCallback = jest.fn();
      const structuredRetryLog = jest.fn();

      await handleBatchRetry(
        new Error("connection reset"),
        false,
        cm,
        "file:///test.sql",
        true,
        undefined,
        logCallback,
        () => Promise.resolve([] as any),
        structuredRetryLog,
      );

      expect(structuredRetryLog).toHaveBeenCalledWith(
        "Connection was closed by server. Reconnecting and retrying...",
      );
      expect(logCallback).not.toHaveBeenCalled();
    });

    it("should not retry if already retry", async () => {
      const cm = createMockConnManager();
      const { isConnectionBrokenError } = require("../core/queryRunnerUtils");
      (isConnectionBrokenError as jest.Mock).mockReturnValueOnce(true);

      const result = await handleBatchRetry(
        new Error("connection reset"),
        true,
        cm,
        "file:///test.sql",
        true,
        undefined,
        undefined,
        () => Promise.resolve([] as any),
      );

      expect(result).toEqual({ handled: false });
    });

    it("should throw on retry error", async () => {
      const cm = createMockConnManager();
      const { isConnectionBrokenError } = require("../core/queryRunnerUtils");
      (isConnectionBrokenError as jest.Mock).mockReturnValueOnce(true);

      await expect(
        handleBatchRetry(
          new Error("connection reset"),
          false,
          cm,
          "file:///test.sql",
          true,
          undefined,
          undefined,
          () => Promise.reject(new Error("still broken")),
        ),
      ).rejects.toThrow("after reconnect attempt");
    });
  });

  describe("handleBatchError", () => {
    it("should throw formatted error", async () => {
      const cm = createMockConnManager();

      await expect(
        handleBatchError(new Error("test error"), cm, undefined, undefined),
      ).rejects.toThrow("Error: test error");
    });

    it("should check for busy connection", async () => {
      const cm = createMockConnManager();
      const {
        handleBusyConnectionError,
      } = require("../core/queryRunnerHelpers");
      (handleBusyConnectionError as jest.Mock).mockResolvedValueOnce(true);

      await expect(
        handleBatchError(
          new Error("busy"),
          cm,
          undefined,
          undefined,
          "file:///test.sql",
        ),
      ).rejects.toThrow("Connection is busy");
    });
  });

  describe("createDropSessionCallback", () => {
    it("should return callback that calls executeDropSession", async () => {
      const cm = createMockConnManager();
      const callback = createDropSessionCallback(cm, "file:///test.sql");

      expect(callback).toBeDefined();
      await callback!("12345");

      const { executeDropSession } = require("../core/queryRunnerHelpers");
      expect(executeDropSession).toHaveBeenCalledWith(
        "12345",
        cm,
        "file:///test.sql",
      );
    });

    it("should return undefined callback when no documentUri", () => {
      const cm = createMockConnManager();
      const callback = createDropSessionCallback(cm, undefined);
      expect(callback).toBeUndefined();
    });
  });

  describe("getQueryConfig", () => {
    it("should return default config values", () => {
      const { workspace } = require("vscode");
      (workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn().mockImplementation((_key: string, def: unknown) => def),
      });

      const config = getQueryConfig();
      expect(config.queryTimeout).toBe(1800);
      expect(config.rowLimit).toBe(200000);
    });

    it("should return config from settings", () => {
      const { workspace } = require("vscode");
      (workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn().mockImplementation((key: string, _def: unknown) => {
          if (key === "query.executionTimeout") return 3600;
          if (key === "query.rowLimit") return 500000;
          return undefined;
        }),
      });

      const config = getQueryConfig();
      expect(config.queryTimeout).toBe(3600);
      expect(config.rowLimit).toBe(500000);
    });
  });
});
