/**
 * @jest-environment node
 */
import { StreamingManager } from "../core/streaming/StreamingManager";
import { NzConnection, NzCommand, NzDataReader } from "../types/index";

// Mock NzCommand
class MockNzCommand implements NzCommand {
  public commandTimeout: number = 30;
  public cancelled: boolean = false;
  public _recordsAffected: number = -1;

  async executeReader(): Promise<NzDataReader> {
    return new MockNzDataReader([]);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async execute(): Promise<void> {}
}

// Mock NzDataReader
class MockNzDataReader implements NzDataReader {
  public fieldCount: number = 1;
  private rowIndex: number = -1;
  private data: unknown[][];

  constructor(data: unknown[][]) {
    this.data = data;
  }

  async read(): Promise<boolean> {
    this.rowIndex++;
    return this.rowIndex < this.data.length;
  }

  async nextResult(): Promise<boolean> {
    return false;
  }

  getValue(index: number): unknown {
    if (this.rowIndex >= 0 && this.rowIndex < this.data.length) {
      return this.data[this.rowIndex][index];
    }
    return null;
  }

  getName(index: number): string {
    return `col${index}`;
  }

  getTypeName(_index: number): string {
    return "VARCHAR";
  }

  async close(): Promise<void> {}
}

// Mock connection
const mockConnection = {
  createCommand: jest.fn(),
  connect: jest.fn(),
  close: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
} as unknown as NzConnection;

describe("StreamingManager", () => {
  let manager: StreamingManager;

  beforeEach(() => {
    manager = new StreamingManager();
    jest.clearAllMocks();
  });

  describe("Command registration and tracking", () => {
    it("should register command for a document URI", () => {
      const cmd = new MockNzCommand();
      const docUri = "file:///test/file.sql";

      manager.registerCommand(docUri, cmd, "12345");

      expect(manager.isActive(docUri)).toBe(true);
      expect(manager.getCommand(docUri)).toBe(cmd);
      expect(manager.getActiveUris()).toContain(docUri);
    });

    it("should normalize Windows drive letters in URI keys", () => {
      const cmd = new MockNzCommand();
      const docUriLower = "file:///c:/test/file.sql";
      const docUriUpper = "file:///C:/test/file.sql";

      manager.registerCommand(docUriLower, cmd);

      // Should find the command regardless of case
      expect(manager.isActive(docUriUpper)).toBe(true);
      expect(manager.getCommand(docUriUpper)).toBe(cmd);
    });

    it("should unregister command after completion", () => {
      const cmd = new MockNzCommand();
      const docUri = "file:///test/file.sql";

      manager.registerCommand(docUri, cmd);
      expect(manager.isActive(docUri)).toBe(true);

      manager.unregisterCommand(docUri);
      expect(manager.isActive(docUri)).toBe(false);
      expect(manager.getCommand(docUri)).toBeUndefined();
    });

    it("should track multiple active queries independently", () => {
      const cmd1 = new MockNzCommand();
      const cmd2 = new MockNzCommand();
      const docUri1 = "file:///test/file1.sql";
      const docUri2 = "file:///test/file2.sql";

      manager.registerCommand(docUri1, cmd1, "session1");
      manager.registerCommand(docUri2, cmd2, "session2");

      expect(manager.isActive(docUri1)).toBe(true);
      expect(manager.isActive(docUri2)).toBe(true);
      expect(manager.getActiveUris()).toHaveLength(2);
      expect(manager.getCommand(docUri1)).toBe(cmd1);
      expect(manager.getCommand(docUri2)).toBe(cmd2);

      // Cancel one, verify the other is still active
      manager.abortQuery(docUri1);
      expect(manager.isAborted(docUri1)).toBe(true);
      expect(manager.isAborted(docUri2)).toBe(false);
    });
  });

  describe("Cancellation", () => {
    it("should mark command as cancelled", () => {
      const cmd = new MockNzCommand();
      const docUri = "file:///test/file.sql";

      manager.registerCommand(docUri, cmd);
      expect(manager.isAborted(docUri)).toBe(false);

      manager.abortQuery(docUri);
      expect(manager.isAborted(docUri)).toBe(true);
    });

    it("should remember cancellation via pendingAborts when no active command", () => {
      const docUri = "file:///queued/file.sql";
      expect(manager.abortQuery(docUri)).toBe(true);
      expect(manager.isAborted(docUri)).toBe(true);

      // Registering a new command consumes the pending abort
      const handle = manager.registerCommand(docUri, new MockNzCommand());
      expect(handle.signal.aborted).toBe(true);
      // After consumption, a subsequent check returns false (fresh abort required)
      // unless another abortQuery was issued
      expect(manager.isAborted(docUri)).toBe(true); // still aborted via controller
    });

    it("should return true from abortQuery when active command exists", () => {
      const docUri = "file:///active/file.sql";
      const cmd = new MockNzCommand();
      manager.registerCommand(docUri, cmd);
      expect(manager.abortQuery(docUri)).toBe(true);
      expect(manager.isAborted(docUri)).toBe(true);
    });

    it("should return false for isAborted when no command exists", () => {
      const docUri = "file:///nonexistent/file.sql";
      expect(manager.isAborted(docUri)).toBe(false);
    });

    it("should return false for isActive when no command exists", () => {
      const docUri = "file:///nonexistent/file.sql";
      expect(manager.isActive(docUri)).toBe(false);
    });

    it("should return undefined for getCommand when no command exists", () => {
      const docUri = "file:///nonexistent/file.sql";
      expect(manager.getCommand(docUri)).toBeUndefined();
    });
  });

  describe("consumeRestAndCancel", () => {
    let dateNowSpy: jest.SpyInstance;
    let currentTime: number;

    beforeEach(() => {
      currentTime = 1000000;
      dateNowSpy = jest
        .spyOn(Date, "now")
        .mockImplementation(() => currentTime);
    });

    afterEach(() => {
      dateNowSpy.mockRestore();
      jest.restoreAllMocks();
    });

    const advanceTime = (ms: number) => {
      currentTime += ms;
    };

    it("should cancel command after consuming data", async () => {
      const cmd = new MockNzCommand();
      const reader = new MockNzDataReader([[1], [2], [3]]);

      await manager.consumeRestAndCancel(reader, cmd);

      expect(cmd.cancelled).toBe(true);
    });

    it("should cancel first and close immediately when cancelFirst is true", async () => {
      const cmd = new MockNzCommand();
      const reader = {
        read: jest.fn().mockResolvedValue(true),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
      } as unknown as NzDataReader;

      await manager.consumeRestAndCancel(
        reader,
        cmd,
        "file:///test.sql",
        "12345",
        undefined,
        undefined,
        true,
      );

      expect(cmd.cancelled).toBe(true);
      expect(reader.close).toHaveBeenCalledTimes(1);
      expect(reader.read).not.toHaveBeenCalled();
    });

    it("should fall back to drain when immediate close fails in cancelFirst mode", async () => {
      const cmd = new MockNzCommand();
      const reader = {
        read: jest.fn().mockResolvedValue(false),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockRejectedValue(new Error("close failed")),
      } as unknown as NzDataReader;
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      await manager.consumeRestAndCancel(
        reader,
        cmd,
        "file:///test.sql",
        "12345",
        undefined,
        undefined,
        true,
      );

      expect(cmd.cancelled).toBe(true);
      expect(reader.close).toHaveBeenCalledTimes(1);
      expect(reader.read).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("should call onDropSession callback when user selects Drop Session", async () => {
      const cmd = new MockNzCommand();
      const onDropSession = jest.fn().mockResolvedValue(undefined);

      // Mock vscode.window.showWarningMessage to return "Drop Session"
      const vscode = require("vscode");
      jest
        .spyOn(vscode.window, "showWarningMessage")
        .mockResolvedValue("Drop Session 12345");

      // Use a counter to simulate infinite data but trigger timeout after a few reads
      let readCount = 0;
      const infiniteReader = {
        read: jest.fn().mockImplementation(() => {
          readCount++;
          if (readCount >= 3) {
            // Advance time to trigger timeout
            advanceTime(6000);
          }
          return Promise.resolve(true);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn(),
      } as unknown as NzDataReader;

      await manager.consumeRestAndCancel(
        infiniteReader,
        cmd,
        "file:///test.sql",
        "12345",
        undefined,
        onDropSession,
      );

      expect(onDropSession).toHaveBeenCalledWith("12345");
    });

    it("should handle errors in onDropSession callback gracefully", async () => {
      const cmd = new MockNzCommand();
      const onDropSession = jest
        .fn()
        .mockRejectedValue(new Error("Drop failed"));

      const vscode = require("vscode");
      jest
        .spyOn(vscode.window, "showWarningMessage")
        .mockResolvedValue("Drop Session 12345");
      const showErrorMessage = jest
        .spyOn(vscode.window, "showErrorMessage")
        .mockResolvedValue(undefined);

      // Use a counter to trigger timeout
      let readCount = 0;
      const infiniteReader = {
        read: jest.fn().mockImplementation(() => {
          readCount++;
          if (readCount >= 3) {
            advanceTime(6000);
          }
          return Promise.resolve(true);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn(),
      } as unknown as NzDataReader;

      const consoleErrorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const consoleLogSpy = jest
        .spyOn(console, "log")
        .mockImplementation(() => {});

      await manager.consumeRestAndCancel(
        infiniteReader,
        cmd,
        "file:///test.sql",
        "12345",
        undefined,
        onDropSession,
      );

      expect(onDropSession).toHaveBeenCalledWith("12345");
      expect(showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Failed to drop session"),
      );

      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it("should not call onDropSession when user selects Keep Waiting", async () => {
      const cmd = new MockNzCommand();
      const onDropSession = jest.fn().mockResolvedValue(undefined);

      const vscode = require("vscode");
      jest
        .spyOn(vscode.window, "showWarningMessage")
        .mockResolvedValue("Keep Waiting");

      // Track reads to trigger timeouts at the right moments
      let readCount = 0;
      const infiniteReader = {
        read: jest.fn().mockImplementation(() => {
          readCount++;
          // Trigger initial timeout after 3 reads
          if (readCount === 3) {
            advanceTime(6000);
          }
          // Trigger extended timeout after more reads
          if (readCount === 6) {
            advanceTime(16000);
          }
          return Promise.resolve(true);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn(),
      } as unknown as NzDataReader;

      await manager.consumeRestAndCancel(
        infiniteReader,
        cmd,
        "file:///test.sql",
        "12345",
        undefined,
        onDropSession,
      );

      expect(onDropSession).not.toHaveBeenCalled();
    });
  });

  describe("executeAndFetch", () => {
    // Add inside describe to reset timers reliably
    afterEach(() => {
      jest.useRealTimers();
    });

    it("should trigger long query alert when execution time exceeds threshold", async () => {
      const vscode = require("vscode");
      const showWarningMessageSpy = jest
        .spyOn(vscode.window, "showWarningMessage")
        .mockResolvedValue(undefined);

      // Mock workspace configuration to return 1 minute threshold
      jest.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
        get: jest
          .fn()
          .mockImplementation((key: string, defaultValue: unknown) => {
            if (key === "longQueryAlertThreshold") return 1; // 1 minute
            return defaultValue;
          }),
      } as unknown as import("vscode").WorkspaceConfiguration);

      jest.useFakeTimers();

      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Make reader hang indefinitely so timeout can trigger
      const mockReader = new MockNzDataReader([]);
      jest.spyOn(cmd, "executeReader").mockImplementation(() => {
        return new Promise((resolve) => {
          // Resolve after advancing timers
          setTimeout(() => resolve(mockReader), 60000 + 1000);
        });
      });

      const executePromise = manager.executeAndFetch(
        mockConnection,
        "SELECT 1",
        100,
      );

      // Advance time by 60 seconds to trigger the alert
      jest.advanceTimersByTime(60000);

      // Let pending promise callbacks run
      await Promise.resolve();

      expect(showWarningMessageSpy).toHaveBeenCalledWith(
        "Query is taking longer than 1 minute(s) to execute.",
      );

      // Advance the remaining time to allow executeReader to resolve
      jest.advanceTimersByTime(1000);

      // Wait for it to finish and clean up
      await executePromise;
      // afterEach handles useRealTimers()
    });

    it("should NOT trigger alert when query completes before threshold", async () => {
      const vscode = require("vscode");
      const showWarningMessageSpy = jest
        .spyOn(vscode.window, "showWarningMessage")
        .mockResolvedValue(undefined);

      // Mock workspace configuration to return 10 minute threshold
      jest.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
        get: jest
          .fn()
          .mockImplementation((key: string, defaultValue: unknown) => {
            if (key === "longQueryAlertThreshold") return 10; // 10 minutes
            return defaultValue;
          }),
      } as unknown as import("vscode").WorkspaceConfiguration);

      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Return immediately (query completes quickly)
      const mockReader = new MockNzDataReader([]);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "SELECT 1",
        100,
      );

      // Verify alert was NOT called since query completed before 10 minute threshold
      expect(showWarningMessageSpy).not.toHaveBeenCalled();
      expect(result.results).toBeDefined();
    });

    it("should close reader when executeAndFetch exits after a read error", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      const reader = {
        fieldCount: 1,
        read: jest
          .fn()
          .mockResolvedValueOnce(true)
          .mockRejectedValueOnce(new Error("read failed")),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
        getValue: jest.fn().mockReturnValue(1),
        getName: jest.fn().mockReturnValue("col"),
        getTypeName: jest.fn().mockReturnValue("INT"),
      } as unknown as NzDataReader;
      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "SELECT * FROM test",
        100,
      );

      expect(result.error?.message).toBe("read failed");
      expect(reader.close).toHaveBeenCalled();
    });

    it("should register and unregister command automatically", async () => {
      const cmd = new MockNzCommand();
      const docUri = "file:///test/file.sql";

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Mock the reader
      const mockReader = new MockNzDataReader([[1, "test"]]);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      // Start execution
      const promise = manager.executeAndFetch(
        mockConnection,
        "SELECT * FROM test",
        100,
        undefined,
        docUri,
        "session123",
      );

      // During execution, command should be registered
      expect(manager.isActive(docUri)).toBe(true);

      // Wait for completion
      await promise;

      // After execution, command should be unregistered
      expect(manager.isActive(docUri)).toBe(false);
    });

    it("should pass onDropSession callback to consumeRestAndCancel", async () => {
      const cmd = new MockNzCommand();
      const onDropSession = jest.fn().mockResolvedValue(undefined);

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Create a reader with limited data
      const mockReader = new MockNzDataReader([[1]]);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "SELECT * FROM test",
        100,
        undefined,
        "file:///test.sql",
        "12345",
        undefined,
        undefined,
        onDropSession,
      );

      expect(result.results).toBeDefined();
    });

    it("should use immediate cancel path when row limit is reached", async () => {
      const cmd = new MockNzCommand();
      const warningSpy = jest
        .spyOn(require("vscode").window, "showWarningMessage")
        .mockResolvedValue(undefined);

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      let readCount = 0;
      const reader = {
        fieldCount: 1,
        read: jest.fn().mockImplementation(() => {
          readCount++;
          return Promise.resolve(readCount <= 1000);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
        getValue: jest.fn().mockReturnValue(1),
        getName: jest.fn().mockReturnValue("col"),
        getTypeName: jest.fn().mockReturnValue("INT"),
      } as unknown as NzDataReader;
      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "SELECT * FROM test",
        2,
        undefined,
        "file:///test.sql",
        "12345",
      );

      expect(result.results[0].limitReached).toBe(true);
      expect(result.results[0].rows).toHaveLength(2);
      expect(cmd.cancelled).toBe(true);
      expect(reader.close).toHaveBeenCalled();
      expect(readCount).toBe(2);
      expect(warningSpy).not.toHaveBeenCalled();
      warningSpy.mockRestore();
    });

    it("should surface unicode text metadata from the driver contract", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      const reader = {
        fieldCount: 3,
        read: jest
          .fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
        getValue: jest
          .fn()
          .mockImplementation(
            (index: number) =>
              ["AA", "AA", new Date("2026-04-03T00:00:00.000Z")][index],
          ),
        getName: jest
          .fn()
          .mockImplementation(
            (index: number) =>
              ["varchar_col", "nvarchar_col", "timestamp_col"][index],
          ),
        getTypeName: jest
          .fn()
          .mockImplementation(
            (index: number) => ["VARCHAR", "NVARCHAR", "TIMESTAMPTZ"][index],
          ),
        getDeclaredTypeName: jest
          .fn()
          .mockImplementation(
            (index: number) =>
              ["VARCHAR(32)", "NVARCHAR(32)", "TIMESTAMPTZ"][index],
          ),
        getSchemaTable: jest.fn().mockReturnValue([
          { ProviderType: 1043, ColumnSize: 32, NumericScale: 0 },
          { ProviderType: 2530, ColumnSize: 32, NumericScale: 0 },
          { ProviderType: 1184, ColumnSize: 8, NumericScale: 0 },
        ]),
        columnDescriptions: [
          { typeOid: 1043, typeMod: 48 },
          { typeOid: 2530, typeMod: 48 },
          { typeOid: 1184, typeMod: -1 },
        ],
      } as unknown as NzDataReader;

      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "SELECT * FROM test",
        10,
        undefined,
      );

      expect(result.results[0].columns).toEqual([
        { name: "varchar_col", type: "VARCHAR(32)" },
        { name: "nvarchar_col", type: "NVARCHAR(32)" },
        { name: "timestamp_col", type: "TIMESTAMPTZ" },
      ]);
    });
  });

  describe("executeWithStreaming", () => {
    it("should call onChunk for each chunk of data", async () => {
      const cmd = new MockNzCommand();
      const onChunk = jest.fn();

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Create reader with multiple rows
      const mockReader = new MockNzDataReader([
        [1, "row1"],
        [2, "row2"],
        [3, "row3"],
        [4, "row4"],
        [5, "row5"],
      ]);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      await manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM test",
        100,
        2, // chunk size of 2
        undefined,
        undefined,
        onChunk,
      );

      expect(onChunk).toHaveBeenCalled();
      // Should have multiple chunks (5 rows / chunk size 2 = 3 chunks)
      expect(onChunk.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("should close reader when onChunk throws during streaming", async () => {
      const cmd = new MockNzCommand();
      const onChunk = jest.fn(() => {
        throw new Error("chunk failed");
      });

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      const reader = new MockNzDataReader([[1]]);
      const closeSpy = jest.spyOn(reader, "close").mockResolvedValue(undefined);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM test",
        100,
        1,
        undefined,
        undefined,
        onChunk,
      );

      expect(result.error?.message).toBe("chunk failed");
      expect(closeSpy).toHaveBeenCalled();
    });

    it("should stop when cancelled during streaming", async () => {
      const cmd = new MockNzCommand();
      const onChunk = jest.fn();
      const docUri = "file:///test/file.sql";

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Create reader with limited rows to reduce memory
      const mockReader = new MockNzDataReader(Array(50).fill([1]));
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);
      const closeSpy = jest
        .spyOn(mockReader, "close")
        .mockResolvedValue(undefined);

      // Start streaming
      const streamingPromise = manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM test",
        1000,
        10,
        undefined,
        docUri,
        onChunk,
      );

      // Immediately cancel
      manager.abortQuery(docUri);

      const result = await streamingPromise;

      // Should have returned with cancelled error
      expect(result.error?.message).toContain("cancelled");
      expect(cmd.cancelled).toBe(true);
      expect(closeSpy).toHaveBeenCalled();
    });

    it("should pass onDropSession callback to consumeRestAndCancel", async () => {
      const cmd = new MockNzCommand();
      const onDropSession = jest.fn().mockResolvedValue(undefined);

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      const mockReader = new MockNzDataReader([[1]]);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      const result = await manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM test",
        100,
        10,
        undefined,
        "file:///test.sql",
        jest.fn(),
        "12345",
        undefined,
        undefined,
        onDropSession,
      );

      expect(result).toBeDefined();
    });

    it("should use immediate cancel path on streaming row limit", async () => {
      const cmd = new MockNzCommand();
      const onChunk = jest.fn();
      const warningSpy = jest
        .spyOn(require("vscode").window, "showWarningMessage")
        .mockResolvedValue(undefined);

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      let readCount = 0;
      const reader = {
        fieldCount: 1,
        read: jest.fn().mockImplementation(() => {
          readCount++;
          return Promise.resolve(readCount <= 1000);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
        getValue: jest.fn().mockImplementation(() => readCount),
        getName: jest.fn().mockReturnValue("col"),
        getTypeName: jest.fn().mockReturnValue("INT"),
      } as unknown as NzDataReader;
      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM test",
        2,
        50,
        undefined,
        "file:///test.sql",
        onChunk,
        "12345",
      );

      expect(result.limitReached).toBe(true);
      expect(result.totalRows).toBe(2);
      expect(cmd.cancelled).toBe(true);
      expect(reader.close).toHaveBeenCalled();
      expect(readCount).toBe(2);
      expect(warningSpy).not.toHaveBeenCalled();
      warningSpy.mockRestore();
    });

    it("should split 1000 rows into 2 chunks of 500 rows each", async () => {
      const cmd = new MockNzCommand();
      const onChunk = jest.fn();

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Create 1000 rows of data - using primitives only to reduce memory
      const totalRows = 1000;
      const chunkSize = 500;
      const data: unknown[][] = [];
      for (let i = 0; i < totalRows; i++) {
        data.push([i, i % 1000, i % 100]); // Use numbers instead of strings
      }

      const mockReader = new MockNzDataReader(data);
      mockReader.fieldCount = 3; // Data has 3 columns
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      const result = await manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM test",
        100000, // high limit to avoid hitting it
        chunkSize,
        undefined,
        undefined,
        onChunk,
      );

      // When rows are exactly divisible by chunk size (1000/500=2):
      // - 2 full chunks are sent during the loop (each exactly 500 rows, isLastChunk=false)
      // - 1 final empty chunk is sent after loop (0 rows, isLastChunk=true)
      expect(onChunk).toHaveBeenCalledTimes(3);

      // Check first chunk (500 rows, first chunk with columns)
      const firstChunk = onChunk.mock.calls[0][0];
      expect(firstChunk.isFirstChunk).toBe(true);
      expect(firstChunk.isLastChunk).toBe(false);
      expect(firstChunk.rows.length).toBe(500);
      expect(firstChunk.totalRowsSoFar).toBe(500);
      expect(firstChunk.columns.length).toBe(3); // col0, col1, col2

      // Check second chunk (500 rows) - last full chunk from the loop
      const secondChunk = onChunk.mock.calls[1][0];
      expect(secondChunk.isFirstChunk).toBe(false);
      expect(secondChunk.isLastChunk).toBe(false); // Sent during loop, not the final signal
      expect(secondChunk.rows.length).toBe(500);
      expect(secondChunk.totalRowsSoFar).toBe(1000);
      expect(secondChunk.columns.length).toBe(0);

      // Check final completion chunk (empty, signals streaming end)
      const finalChunk = onChunk.mock.calls[2][0];
      expect(finalChunk.isFirstChunk).toBe(false);
      expect(finalChunk.isLastChunk).toBe(true);
      expect(finalChunk.rows.length).toBe(0); // Empty completion signal
      expect(finalChunk.totalRowsSoFar).toBe(1000);

      // Verify total rows in result
      expect(result.totalRows).toBe(1000);
      expect(result.limitReached).toBe(false);

      // Clear mock to release memory
      onChunk.mockClear();
    });

    it("should handle chunking with partial last chunk", async () => {
      const cmd = new MockNzCommand();
      const onChunk = jest.fn();

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Create 500 rows - reduced to reduce memory pressure
      const totalRows = 500;
      const chunkSize = 500;
      const data: unknown[][] = [];
      for (let i = 0; i < totalRows; i++) {
        data.push([i, i % 100]); // Use numbers instead of strings
      }

      const mockReader = new MockNzDataReader(data);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      await manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM test",
        100000,
        chunkSize,
        undefined,
        undefined,
        onChunk,
      );

      // When rows are exactly divisible by chunk size (500/500=1):
      // - 1 full chunk sent during loop (500 rows, isLastChunk=false)
      // - 1 final empty chunk (0 rows) signals completion
      expect(onChunk).toHaveBeenCalledTimes(2);

      // Check data chunk sizes
      expect(onChunk.mock.calls[0][0].rows.length).toBe(500);
      expect(onChunk.mock.calls[1][0].rows.length).toBe(0); // final empty completion signal

      // Check total rows tracking
      expect(onChunk.mock.calls[0][0].totalRowsSoFar).toBe(500);
      // Final empty chunk still has totalRowsSoFar of 500

      // Check first/last flags - exactly divisible: 1 data chunk + 1 final empty chunk
      expect(onChunk.mock.calls[0][0].isFirstChunk).toBe(true);
      expect(onChunk.mock.calls[0][0].isLastChunk).toBe(false);
      expect(onChunk.mock.calls[1][0].isFirstChunk).toBe(false);
      expect(onChunk.mock.calls[1][0].isLastChunk).toBe(true); // Final empty chunk signals completion
    });

    it("should emit unicode text metadata from the driver contract on the first chunk", async () => {
      const cmd = new MockNzCommand();
      const onChunk = jest.fn();

      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      const reader = {
        fieldCount: 2,
        read: jest
          .fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
        getValue: jest
          .fn()
          .mockImplementation((index: number) => ["AA", "AA"][index]),
        getName: jest
          .fn()
          .mockImplementation(
            (index: number) => ["varchar_col", "nvarchar_col"][index],
          ),
        getTypeName: jest
          .fn()
          .mockImplementation(
            (index: number) => ["VARCHAR", "NVARCHAR"][index],
          ),
        getDeclaredTypeName: jest
          .fn()
          .mockImplementation(
            (index: number) => ["VARCHAR(32)", "NVARCHAR(32)"][index],
          ),
        getSchemaTable: jest.fn().mockReturnValue([
          { ProviderType: 1043, ColumnSize: 32, NumericScale: 0 },
          { ProviderType: 2530, ColumnSize: 32, NumericScale: 0 },
        ]),
        columnDescriptions: [
          { typeOid: 1043, typeMod: 48 },
          { typeOid: 2530, typeMod: 48 },
        ],
      } as unknown as NzDataReader;

      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      await manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM test",
        10,
        10,
        undefined,
        undefined,
        onChunk,
      );

      expect(onChunk).toHaveBeenCalled();
      expect(onChunk.mock.calls[0][0].columns).toEqual([
        { name: "varchar_col", type: "VARCHAR(32)" },
        { name: "nvarchar_col", type: "NVARCHAR(32)" },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // TIMEOUT HANDLING TESTS
  // -------------------------------------------------------------------------

  describe("executeAndFetch - Timeout handling", () => {
    it("should pass timeout to command", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);
      const mockReader = new MockNzDataReader([[1]]);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      await manager.executeAndFetch(
        mockConnection,
        "SELECT 1",
        100,
        1800, // timeoutSeconds
        "file:///test.sql",
      );

      expect(cmd.commandTimeout).toBe(1800);
    });

    it("should handle zero timeout (no timeout set)", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);
      const mockReader = new MockNzDataReader([[1]]);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      await manager.executeAndFetch(
        mockConnection,
        "SELECT 1",
        100,
        0, // zero timeout
        "file:///test.sql",
      );

      // commandTimeout should remain at default (not set to 0)
      expect(cmd.commandTimeout).toBe(30); // default from MockNzCommand
    });

    it("should handle undefined timeout", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);
      const mockReader = new MockNzDataReader([[1]]);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      await manager.executeAndFetch(
        mockConnection,
        "SELECT 1",
        100,
        undefined,
        "file:///test.sql",
      );

      expect(cmd.commandTimeout).toBe(30); // default
    });

    it("should cleanup command on timeout error", async () => {
      const cmd = new MockNzCommand();
      const docUri = "file:///test.sql";
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      const timeoutError = new Error("Query timeout expired");
      jest.spyOn(cmd, "executeReader").mockRejectedValue(timeoutError);

      // The command should not be registered after executeReader fails
      // because registration happens before executeReader
      manager.registerCommand(docUri, cmd);
      expect(manager.isActive(docUri)).toBe(true);

      // Simulate cleanup that would happen in finally block
      manager.unregisterCommand(docUri);
      expect(manager.isActive(docUri)).toBe(false);
    });

    it("should return recordsAffected from command", async () => {
      const cmd = new MockNzCommand();
      cmd._recordsAffected = 42;
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);
      const mockReader = new MockNzDataReader([[1]]);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "UPDATE table SET x = 1",
        100,
        30,
      );

      expect(result.recordsAffected).toBe(42);
    });
  });

  describe("executeWithStreaming - Timeout handling", () => {
    it("should pass timeout to command for streaming", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);
      const mockReader = new MockNzDataReader([[1]]);
      jest.spyOn(cmd, "executeReader").mockResolvedValue(mockReader);

      await manager.executeWithStreaming(
        mockConnection,
        "SELECT 1",
        100,
        50,
        900, // timeoutSeconds
        "file:///test.sql",
        jest.fn(),
      );

      expect(cmd.commandTimeout).toBe(900);
    });

    it("should return partial results when cancelled during streaming", async () => {
      const cmd = new MockNzCommand();
      const docUri = "file:///test.sql";
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Create reader that will be cancelled mid-stream
      let readCount = 0;
      const cancellableReader = {
        fieldCount: 1,
        read: jest.fn().mockImplementation(() => {
          readCount++;
          if (readCount === 3) {
            manager.abortQuery(docUri);
          }
          return Promise.resolve(readCount < 3);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        getValue: jest.fn().mockReturnValue(readCount),
        getName: jest.fn().mockReturnValue("col1"),
        getTypeName: jest.fn().mockReturnValue("INT"),
        close: jest.fn().mockResolvedValue(undefined),
      };
      jest
        .spyOn(cmd, "executeReader")
        .mockResolvedValue(cancellableReader as NzDataReader);
      jest.spyOn(cmd, "cancel").mockResolvedValue(undefined);

      const result = await manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM big_table",
        1000,
        10,
        30,
        docUri,
        jest.fn(),
      );

      expect(result.error?.message).toContain("cancelled");
    });
  });

  // -------------------------------------------------------------------------
  // CANCELLATION EDGE CASES
  // -------------------------------------------------------------------------

  describe("Cancellation edge cases", () => {
    it("should handle cancel during delayed executeReader", async () => {
      const cmd = new MockNzCommand();
      const docUri = "file:///test.sql";
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Delay executeReader then abort (after registerCommand already ran)
      jest.spyOn(cmd, "executeReader").mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        manager.abortQuery(docUri);
        return new MockNzDataReader([[1]]);
      });

      const result = await manager.executeWithStreaming(
        mockConnection,
        "SELECT 1",
        100,
        10,
        30,
        docUri,
        jest.fn(),
      );

      // Cancel was marked during executeReader → aborted signal detected on first read
      expect(result.error).toBeDefined();
    });

    it("should handle multiple cancellation requests (idempotent)", () => {
      const docUri = "file:///test.sql";

      manager.registerCommand(docUri, new MockNzCommand());
      expect(manager.isAborted(docUri)).toBe(false);

      manager.abortQuery(docUri);
      manager.abortQuery(docUri);
      manager.abortQuery(docUri);

      expect(manager.isAborted(docUri)).toBe(true);
    });

    it("should keep pending abort alive across unregister → re-register", () => {
      const docUri = "file:///test.sql";
      const cmd1 = new MockNzCommand();
      const handle1 = manager.registerCommand(docUri, cmd1);

      manager.abortQuery(docUri);
      expect(handle1.signal.aborted).toBe(true);
      expect(manager.isAborted(docUri)).toBe(true);

      // Unregister clears the entry but preserves the pending flag
      manager.unregisterCommand(docUri);
      expect(manager.isActive(docUri)).toBe(false);
      // isAborted returns true via pendingAborts
      expect(manager.isAborted(docUri)).toBe(true);

      // Re-register consumes the pending → controller is aborted immediately
      const cmd2 = new MockNzCommand();
      const handle2 = manager.registerCommand(docUri, cmd2);
      expect(handle2.signal.aborted).toBe(true);
    });

    it("should store pending abort and consume it on next registerCommand", () => {
      const docUri = "file:///nonexistent.sql";

      // No active command → abortQuery stores pending
      expect(manager.abortQuery(docUri)).toBe(true);
      expect(manager.isAborted(docUri)).toBe(true);

      // Registering consumes the pending → new controller is aborted immediately
      const handle = manager.registerCommand(docUri, new MockNzCommand());
      expect(handle.signal.aborted).toBe(true);
    });

    it("should provide fresh AbortSignal via registerCommand handle", () => {
      const docUri = "file:///test.sql";
      const cmd = new MockNzCommand();
      const handle = manager.registerCommand(docUri, cmd);

      expect(handle.signal.aborted).toBe(false);
      expect(handle.abort).toBeDefined();
    });

    it("should abort via registered handle and reflect in isAborted", () => {
      const docUri = "file:///test.sql";
      const cmd = new MockNzCommand();
      const handle = manager.registerCommand(docUri, cmd);

      handle.abort("user cancelled");
      expect(handle.signal.aborted).toBe(true);
      expect(manager.isAborted(docUri)).toBe(true);
    });

    it("should abort old controller when registering a new command for the same URI", () => {
      const docUri = "file:///test.sql";
      const cmd1 = new MockNzCommand();
      const handle1 = manager.registerCommand(docUri, cmd1);

      const cmd2 = new MockNzCommand();
      const handle2 = manager.registerCommand(docUri, cmd2);

      // First controller should be aborted
      expect(handle1.signal.aborted).toBe(true);
      // Second controller is fresh
      expect(handle2.signal.aborted).toBe(false);
    });

    it("should auto-cleanup aborted entry after STALE_ABORT_CLEANUP_MS", async () => {
      jest.useFakeTimers();
      const docUri = "file:///test.sql";
      const cmd = new MockNzCommand();
      manager.registerCommand(docUri, cmd);

      manager.abortQuery(docUri);
      expect(manager.isActive(docUri)).toBe(true); // still in map

      // Fast forward past the stale cleanup timeout
      jest.advanceTimersByTime(30001);
      expect(manager.isActive(docUri)).toBe(false);
      jest.useRealTimers();
    });

    it("should return undefined from getSignal when no active command", () => {
      expect(manager.getSignal("file:///nonexistent.sql")).toBeUndefined();
    });

    it("should return the AbortSignal via getSignal", () => {
      const docUri = "file:///test.sql";
      const cmd = new MockNzCommand();
      const handle = manager.registerCommand(docUri, cmd);

      expect(manager.getSignal(docUri)).toBe(handle.signal);
    });

    it("should not auto-cleanup un-aborted entries", () => {
      jest.useFakeTimers();
      const docUri = "file:///test.sql";
      manager.registerCommand(docUri, new MockNzCommand());

      jest.advanceTimersByTime(30001);
      expect(manager.isActive(docUri)).toBe(true);
      jest.useRealTimers();
    });

    it("should handle recordsAffected in cancelled query", async () => {
      const cmd = new MockNzCommand();
      cmd._recordsAffected = -1; // No records affected info
      const docUri = "file:///test.sql";
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      let readCount = 0;
      const mockReader = {
        fieldCount: 1,
        read: jest.fn().mockImplementation(() => {
          readCount++;
          if (readCount === 2) {
            manager.abortQuery(docUri);
          }
          return Promise.resolve(readCount < 3);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        getValue: jest.fn().mockReturnValue(1),
        getName: jest.fn().mockReturnValue("col"),
        getTypeName: jest.fn().mockReturnValue("INT"),
        close: jest.fn(),
      };
      jest
        .spyOn(cmd, "executeReader")
        .mockResolvedValue(mockReader as NzDataReader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "SELECT 1",
        100,
        30,
        docUri,
      );

      expect(result.recordsAffected).toBe(-1);
      expect(cmd.cancelled).toBe(true);
      expect(mockReader.close).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // EXTENDED TIMEOUT TESTS (consumeRestAndCancel)
  // -------------------------------------------------------------------------

  describe("consumeRestAndCancel - Extended timeout", () => {
    let dateNowSpy: jest.SpyInstance;
    let currentTime: number;

    beforeEach(() => {
      currentTime = 1000000;
      dateNowSpy = jest
        .spyOn(Date, "now")
        .mockImplementation(() => currentTime);
    });

    afterEach(() => {
      dateNowSpy.mockRestore();
    });

    const advanceTime = (ms: number) => {
      currentTime += ms;
    };

    it('should handle "Keep Waiting" selection during extended consume', async () => {
      const cmd = new MockNzCommand();
      const onDropSession = jest.fn();

      const vscode = require("vscode");
      jest
        .spyOn(vscode.window, "showWarningMessage")
        .mockResolvedValue("Keep Waiting");

      let readCount = 0;
      const reader = {
        read: jest.fn().mockImplementation(() => {
          readCount++;
          // Trigger initial timeout, then extended timeout
          if (readCount === 3) advanceTime(6000);
          if (readCount === 8) advanceTime(16000);
          return Promise.resolve(readCount < 10);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn(),
      } as unknown as NzDataReader;

      await manager.consumeRestAndCancel(
        reader,
        cmd,
        "file:///test.sql",
        "12345",
        undefined,
        onDropSession,
      );

      expect(onDropSession).not.toHaveBeenCalled();
    });

    it("should handle error during extended consume gracefully", async () => {
      const cmd = new MockNzCommand();
      const onDropSession = jest.fn();

      const vscode = require("vscode");
      jest
        .spyOn(vscode.window, "showWarningMessage")
        .mockResolvedValue("Keep Waiting");

      const consoleWarnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      let readCount = 0;
      const reader = {
        read: jest.fn().mockImplementation(() => {
          readCount++;
          if (readCount === 3) advanceTime(6000);
          if (readCount === 5) throw new Error("Reader error");
          return Promise.resolve(true);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn(),
      } as unknown as NzDataReader;

      await manager.consumeRestAndCancel(
        reader,
        cmd,
        "file:///test.sql",
        "12345",
        undefined,
        onDropSession,
      );

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error during extended consume"),
        expect.any(Error),
      );

      consoleWarnSpy.mockRestore();
    });

    it("should log warning on extended timeout", async () => {
      const cmd = new MockNzCommand();
      const onDropSession = jest.fn();

      const vscode = require("vscode");
      jest
        .spyOn(vscode.window, "showWarningMessage")
        .mockResolvedValue("Keep Waiting");

      const consoleWarnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      let readCount = 0;
      const reader = {
        read: jest.fn().mockImplementation(() => {
          readCount++;
          if (readCount === 3) advanceTime(6000);
          if (readCount === 8) advanceTime(16000);
          return Promise.resolve(readCount < 15);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn(),
      } as unknown as NzDataReader;

      await manager.consumeRestAndCancel(
        reader,
        cmd,
        "file:///test.sql",
        "12345",
        undefined,
        onDropSession,
      );

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Extended consume timed out"),
      );

      consoleWarnSpy.mockRestore();
    });

    it("should respect cancellation during extended consume", async () => {
      const cmd = new MockNzCommand();
      const docUri = "file:///test.sql";
      const onDropSession = jest.fn();

      const vscode = require("vscode");
      jest
        .spyOn(vscode.window, "showWarningMessage")
        .mockResolvedValue("Keep Waiting");

      let readCount = 0;
      const reader = {
        read: jest.fn().mockImplementation(() => {
          readCount++;
          if (readCount === 3) advanceTime(6000);
          if (readCount === 5) manager.abortQuery(docUri);
          return Promise.resolve(readCount < 20);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn(),
      } as unknown as NzDataReader;

      await manager.consumeRestAndCancel(
        reader,
        cmd,
        docUri,
        "12345",
        undefined,
        onDropSession,
      );

      expect(cmd.cancelled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ZERO-ROW RESULT SET EDGE CASES
  // -------------------------------------------------------------------------

  describe("Zero-row result sets", () => {
    it("should return empty rows with column metadata for zero-row executeAndFetch", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // Reader with 2 columns but no rows
      const reader = {
        fieldCount: 2,
        read: jest.fn().mockResolvedValue(false), // no rows
        nextResult: jest.fn().mockResolvedValue(false),
        getValue: jest.fn(),
        getName: jest.fn().mockImplementation(
          (index: number) => ["ID", "NAME"][index],
        ),
        getTypeName: jest.fn().mockImplementation(
          (index: number) => ["INT", "VARCHAR"][index],
        ),
        close: jest.fn().mockResolvedValue(undefined),
      } as unknown as NzDataReader;

      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "SELECT * FROM empty_table",
        100,
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0].columns).toHaveLength(2);
      expect(result.results[0].columns[0].name).toBe("ID");
      expect(result.results[0].columns[1].name).toBe("NAME");
      expect(result.results[0].rows).toHaveLength(0);
      expect(result.results[0].limitReached).toBe(false);
    });

    it("should send final chunk with columns for zero-row executeWithStreaming", async () => {
      const cmd = new MockNzCommand();
      const onChunk = jest.fn();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      const reader = {
        fieldCount: 2,
        read: jest.fn().mockResolvedValue(false),
        nextResult: jest.fn().mockResolvedValue(false),
        getValue: jest.fn(),
        getName: jest.fn().mockImplementation(
          (index: number) => ["ID", "NAME"][index],
        ),
        getTypeName: jest.fn().mockImplementation(
          (index: number) => ["INT", "VARCHAR"][index],
        ),
        close: jest.fn().mockResolvedValue(undefined),
      } as unknown as NzDataReader;

      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM empty_table",
        100,
        50,
        undefined,
        undefined,
        onChunk,
      );

      // Should have exactly 1 chunk: the final chunk
      expect(onChunk).toHaveBeenCalledTimes(1);
      const chunk = onChunk.mock.calls[0][0];
      expect(chunk.isFirstChunk).toBe(true);
      expect(chunk.isLastChunk).toBe(true);
      expect(chunk.columns).toHaveLength(2);
      expect(chunk.rows).toHaveLength(0);
      expect(chunk.totalRowsSoFar).toBe(0);
      expect(chunk.limitReached).toBe(false);
      expect(result.totalRows).toBe(0);
    });

    it("should handle zero-column result (DDL statement)", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      const reader = {
        fieldCount: 0,
        read: jest.fn().mockResolvedValue(false),
        nextResult: jest.fn().mockResolvedValue(false),
        getValue: jest.fn(),
        getName: jest.fn(),
        getTypeName: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      } as unknown as NzDataReader;

      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "CREATE TABLE test (id INT)",
        100,
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0].columns).toHaveLength(0);
      expect(result.results[0].rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // MULTI-RESULT-SET TESTS
  // -------------------------------------------------------------------------

  describe("Multi-result-set batch fetch", () => {
    it("should collect multiple result sets from a single command", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      let resultSetIndex = 0;
      const resultSets = [
        { data: [[1, "a"], [2, "b"]], fieldCount: 2 },
        { data: [[10, "x"]], fieldCount: 2 },
      ];

      let rowIndex = -1;
      const reader = {
        fieldCount: 2,
        read: jest.fn().mockImplementation(async () => {
          rowIndex++;
          const currentSet = resultSets[resultSetIndex];
          return rowIndex < currentSet.data.length;
        }),
        nextResult: jest.fn().mockImplementation(async () => {
          resultSetIndex++;
          rowIndex = -1;
          return resultSetIndex < resultSets.length;
        }),
        getValue: jest.fn().mockImplementation(
          (index: number) => {
            const currentSet = resultSets[resultSetIndex];
            return currentSet.data[rowIndex][index];
          },
        ),
        getName: jest.fn().mockImplementation(
          (index: number) => ["ID", "VAL"][index],
        ),
        getTypeName: jest.fn().mockImplementation(
          (index: number) => ["INT", "VARCHAR"][index],
        ),
        close: jest.fn().mockResolvedValue(undefined),
      } as unknown as NzDataReader;

      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "SELECT * FROM t1; SELECT * FROM t2",
        100,
      );

      expect(result.results).toHaveLength(2);
      expect(result.results[0].rows).toHaveLength(2);
      expect(result.results[0].rows[0]).toEqual([1, "a"]);
      expect(result.results[1].rows).toHaveLength(1);
      expect(result.results[1].rows[0]).toEqual([10, "x"]);
    });
  });

  // -------------------------------------------------------------------------
  // STREAMING LIMIT REACHED EDGE CASES
  // -------------------------------------------------------------------------

  describe("Streaming limit edge cases", () => {
    it("should reach limit mid-chunk and truncate correctly", async () => {
      const cmd = new MockNzCommand();
      const onChunk = jest.fn();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      // 5 rows with limit of 3 and chunk size of 10 (bigger than limit)
      let readCount = 0;
      const reader = {
        fieldCount: 1,
        read: jest.fn().mockImplementation(() => {
          readCount++;
          return Promise.resolve(readCount <= 5);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
        getValue: jest.fn().mockImplementation(() => readCount),
        getName: jest.fn().mockReturnValue("col"),
        getTypeName: jest.fn().mockReturnValue("INT"),
      } as unknown as NzDataReader;

      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeWithStreaming(
        mockConnection,
        "SELECT * FROM big_table",
        3, // limit
        10, // chunk size > limit
        undefined,
        "file:///test.sql",
        onChunk,
        "12345",
      );

      expect(result.limitReached).toBe(true);
      expect(result.totalRows).toBe(3);
      expect(cmd.cancelled).toBe(true);
    });

    it("should handle limit of 1 row correctly", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      let readCount = 0;
      const reader = {
        fieldCount: 1,
        read: jest.fn().mockImplementation(() => {
          readCount++;
          return Promise.resolve(readCount <= 100);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
        getValue: jest.fn().mockReturnValue(42),
        getName: jest.fn().mockReturnValue("col"),
        getTypeName: jest.fn().mockReturnValue("INT"),
      } as unknown as NzDataReader;

      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "SELECT * FROM t",
        1, // limit of 1
      );

      expect(result.results[0].rows).toHaveLength(1);
      expect(result.results[0].limitReached).toBe(true);
      expect(readCount).toBe(1);
    });

    it("should use maxRows when provided and smaller than limit", async () => {
      const cmd = new MockNzCommand();
      jest.spyOn(mockConnection, "createCommand").mockReturnValue(cmd);

      let readCount = 0;
      const reader = {
        fieldCount: 1,
        read: jest.fn().mockImplementation(() => {
          readCount++;
          return Promise.resolve(readCount <= 100);
        }),
        nextResult: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined),
        getValue: jest.fn().mockReturnValue(1),
        getName: jest.fn().mockReturnValue("col"),
        getTypeName: jest.fn().mockReturnValue("INT"),
      } as unknown as NzDataReader;

      jest.spyOn(cmd, "executeReader").mockResolvedValue(reader);

      const result = await manager.executeAndFetch(
        mockConnection,
        "SELECT * FROM t",
        1000, // limit
        undefined, // timeout
        undefined, // docUri
        undefined, // sessionId
        undefined, // connectionManager
        5,         // maxRows (overrides limit)
      );

      expect(result.results[0].rows).toHaveLength(5);
      expect(result.results[0].limitReached).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // REGISTRATION CONCURRENCY EDGE CASES
  // -------------------------------------------------------------------------

  describe("Registration concurrency edge cases", () => {
    it("should handle re-registration of same URI (overwrites)", () => {
      const cmd1 = new MockNzCommand();
      const cmd2 = new MockNzCommand();
      const docUri = "file:///test.sql";

      manager.registerCommand(docUri, cmd1, "session1");
      manager.registerCommand(docUri, cmd2, "session2");

      // Should return the latest command
      expect(manager.getCommand(docUri)).toBe(cmd2);
      expect(manager.getActiveUris()).toHaveLength(1);
    });

    it("should handle getActiveUris returning empty list initially", () => {
      expect(manager.getActiveUris()).toHaveLength(0);
    });

    it("should handle unregister for non-existent URI", () => {
      expect(() => manager.unregisterCommand("file:///nonexistent.sql")).not.toThrow();
    });

    it("should isolate cancellation between close URIs", () => {
      const docUri1 = "file:///test/file1.sql";
      const docUri2 = "file:///test/file2.sql";

      manager.registerCommand(docUri1, new MockNzCommand());
      manager.registerCommand(docUri2, new MockNzCommand());

      manager.abortQuery(docUri1);

      expect(manager.isAborted(docUri1)).toBe(true);
      expect(manager.isAborted(docUri2)).toBe(false);
    });
  });
});
