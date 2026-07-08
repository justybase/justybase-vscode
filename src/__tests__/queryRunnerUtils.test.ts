/**
 * Unit tests for core/queryRunnerUtils.ts
 * Tests the exported utility functions for query runner.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  normalizeUriKey,
  isConnectionBrokenError,
  isBusyConnectionError,
  createLogger,
  logOutput,
  resolveConnectionName,
  ConnectionResolverOptions,
  OutputLogger,
} from "../core/queryRunnerUtils";

// Mock vscode module
jest.mock("vscode", () => ({
  window: {
    createOutputChannel: jest.fn(() => ({
      appendLine: jest.fn(),
      show: jest.fn(),
      dispose: jest.fn(),
    })),
  },
}));

describe("queryRunnerUtils", () => {
  describe("normalizeUriKey", () => {
    it("should normalize Windows drive letter to lowercase", () => {
      expect(normalizeUriKey("file:///C:/Users/test.sql")).toBe(
        "file:///c:/Users/test.sql",
      );
      expect(normalizeUriKey("file:///D:/Projects/file.sql")).toBe(
        "file:///d:/Projects/file.sql",
      );
    });

    it("should preserve already lowercase drive letters", () => {
      expect(normalizeUriKey("file:///c:/Users/test.sql")).toBe(
        "file:///c:/Users/test.sql",
      );
    });

    it("should return non-file URIs unchanged", () => {
      expect(normalizeUriKey("untitled:Untitled-1")).toBe(
        "untitled:Untitled-1",
      );
      expect(normalizeUriKey("https://example.com")).toBe(
        "https://example.com",
      );
    });

    it("should handle URIs without drive letters", () => {
      expect(normalizeUriKey("file:///home/user/test.sql")).toBe(
        "file:///home/user/test.sql",
      );
    });

    it("should handle empty string", () => {
      expect(normalizeUriKey("")).toBe("");
    });
  });

  describe("isConnectionBrokenError", () => {
    it("should detect socket closed error", () => {
      expect(
        isConnectionBrokenError(new Error("Socket closed unexpectedly")),
      ).toBe(true);
    });

    it("should detect socket destroyed error", () => {
      expect(isConnectionBrokenError(new Error("Socket destroyed"))).toBe(true);
    });

    it("should detect connection reset error", () => {
      expect(
        isConnectionBrokenError(new Error("Connection reset by peer")),
      ).toBe(true);
    });

    it("should detect connection closed error", () => {
      expect(isConnectionBrokenError(new Error("Connection closed"))).toBe(
        true,
      );
    });

    it("should detect econnreset error", () => {
      expect(isConnectionBrokenError(new Error("ECONNRESET"))).toBe(true);
    });

    it("should detect epipe error", () => {
      expect(isConnectionBrokenError(new Error("EPIPE error"))).toBe(true);
    });

    it("should detect broken pipe error", () => {
      expect(isConnectionBrokenError(new Error("Broken pipe"))).toBe(true);
    });

    it("should not detect non-connection errors", () => {
      expect(isConnectionBrokenError(new Error("Syntax error"))).toBe(false);
      expect(isConnectionBrokenError(new Error("Table not found"))).toBe(false);
      expect(isConnectionBrokenError(new Error("Permission denied"))).toBe(
        false,
      );
    });

    it("should return false for non-Error types", () => {
      expect(isConnectionBrokenError("string error")).toBe(false);
      expect(isConnectionBrokenError(null)).toBe(false);
      expect(isConnectionBrokenError(undefined)).toBe(false);
      expect(isConnectionBrokenError({ message: "error" })).toBe(false);
      expect(isConnectionBrokenError(123)).toBe(false);
    });

    it("should be case-insensitive", () => {
      expect(isConnectionBrokenError(new Error("SOCKET CLOSED"))).toBe(true);
      expect(isConnectionBrokenError(new Error("Connection RESET"))).toBe(true);
      expect(isConnectionBrokenError(new Error("ECONNRESET"))).toBe(true);
    });
  });

  describe("isBusyConnectionError", () => {
    it("should detect busy connection error", () => {
      expect(
        isBusyConnectionError(
          new Error("Connection is already executing a command"),
        ),
      ).toBe(true);
    });

    it("should not detect other errors", () => {
      expect(isBusyConnectionError(new Error("Connection timeout"))).toBe(
        false,
      );
      expect(isBusyConnectionError(new Error("Socket closed"))).toBe(false);
    });

    it("should return false for non-Error types", () => {
      expect(isBusyConnectionError("error")).toBe(false);
      expect(isBusyConnectionError(null)).toBe(false);
    });
  });

  describe("createLogger", () => {
    const { window } = jest.requireMock("vscode");

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should create output channel when not silent and no callback", () => {
      const logger = createLogger(false, undefined);
      expect(logger.outputChannel).toBeDefined();
      expect(window.createOutputChannel).toHaveBeenCalled();
    });

    it("should not create output channel when silent", () => {
      const logger = createLogger(true, undefined);
      expect(logger.outputChannel).toBeUndefined();
    });

    it("should not create output channel when callback provided", () => {
      const callback = jest.fn();
      const logger = createLogger(false, callback);
      expect(logger.outputChannel).toBeUndefined();
      expect(logger.logCallback).toBe(callback);
    });

    it("should return empty logger when silent with callback", () => {
      const callback = jest.fn();
      const logger = createLogger(true, callback);
      expect(logger.outputChannel).toBeUndefined();
      expect(logger.logCallback).toBe(callback);
    });
  });

  describe("logOutput", () => {
    it("should log to output channel when present", () => {
      const mockAppendLine = jest.fn();
      const logger: OutputLogger = {
        outputChannel: { appendLine: mockAppendLine } as any,
      };
      logOutput(logger, "test message");
      expect(mockAppendLine).toHaveBeenCalledWith("test message");
    });

    it("should call logCallback when present", () => {
      const mockCallback = jest.fn();
      const logger: OutputLogger = { logCallback: mockCallback };
      logOutput(logger, "test message");
      expect(mockCallback).toHaveBeenCalledWith("test message");
    });

    it("should log to both when both present", () => {
      const mockAppendLine = jest.fn();
      const mockCallback = jest.fn();
      const logger: OutputLogger = {
        outputChannel: { appendLine: mockAppendLine } as any,
        logCallback: mockCallback,
      };
      logOutput(logger, "test message");
      expect(mockAppendLine).toHaveBeenCalledWith("test message");
      expect(mockCallback).toHaveBeenCalledWith("test message");
    });

    it("should handle empty logger gracefully", () => {
      const logger: OutputLogger = {};
      expect(() => logOutput(logger, "test message")).not.toThrow();
    });

    it("should handle undefined properties gracefully", () => {
      const logger: OutputLogger = {
        outputChannel: undefined,
        logCallback: undefined,
      };
      expect(() => logOutput(logger, "test message")).not.toThrow();
    });
  });

  describe("resolveConnectionName", () => {
    interface MockConnectionManager {
      getConnectionForExecution: jest.Mock;
      getActiveConnectionName: jest.Mock;
    }

    const createMockConnectionManager = (): MockConnectionManager => ({
      getConnectionForExecution: jest.fn(),
      getActiveConnectionName: jest.fn(),
    });

    it("should return provided connection name", () => {
      const mockManager = createMockConnectionManager();
      const options: ConnectionResolverOptions = {
        connectionName: "MyConnection",
      };
      expect(resolveConnectionName(mockManager as any, options)).toBe(
        "MyConnection",
      );
    });

    it("should use document connection when no name provided", () => {
      const mockManager = createMockConnectionManager();
      mockManager.getConnectionForExecution.mockReturnValue("DocConnection");
      const options: ConnectionResolverOptions = {
        documentUri: "file:///test.sql",
      };
      expect(resolveConnectionName(mockManager as any, options)).toBe(
        "DocConnection",
      );
    });

    it("should fall back to active connection", () => {
      const mockManager = createMockConnectionManager();
      mockManager.getConnectionForExecution.mockReturnValue(undefined);
      mockManager.getActiveConnectionName.mockReturnValue("ActiveConnection");
      const options: ConnectionResolverOptions = {
        documentUri: "file:///test.sql",
      };
      expect(resolveConnectionName(mockManager as any, options)).toBe(
        "ActiveConnection",
      );
    });

    it("should prioritize explicit name over document connection", () => {
      const mockManager = createMockConnectionManager();
      mockManager.getConnectionForExecution.mockReturnValue("DocConnection");
      const options: ConnectionResolverOptions = {
        connectionName: "ExplicitConnection",
        documentUri: "file:///test.sql",
      };
      expect(resolveConnectionName(mockManager as any, options)).toBe(
        "ExplicitConnection",
      );
    });

    it("should throw when no connection available", () => {
      const mockManager = createMockConnectionManager();
      mockManager.getConnectionForExecution.mockReturnValue(undefined);
      mockManager.getActiveConnectionName.mockReturnValue(undefined);
      const options: ConnectionResolverOptions = {};
      expect(() => resolveConnectionName(mockManager as any, options)).toThrow(
        "No connection selected",
      );
    });

    it("should throw when active connection returns null", () => {
      const mockManager = createMockConnectionManager();
      mockManager.getConnectionForExecution.mockReturnValue(undefined);
      mockManager.getActiveConnectionName.mockReturnValue(null);
      const options: ConnectionResolverOptions = {};
      expect(() => resolveConnectionName(mockManager as any, options)).toThrow(
        "No connection selected",
      );
    });
  });
});
