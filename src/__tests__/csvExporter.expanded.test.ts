/**
 * Tests for CSV Exporter
 */

import * as vscode from "vscode";
import * as fs from "fs";
import { createConnectedDatabaseConnectionFromDetails } from "../core/connectionFactory";
import { exportToCsv, escapeCsvField } from "../export/csvExporter";
import { ExportCancelledError } from "../core/cancellation";
import { ConnectionDetails } from "../types";

// Mock fs module
jest.mock("fs", () => ({
  createWriteStream: jest.fn(),
}));

jest.mock("../core/connectionFactory", () => ({
  createConnectedDatabaseConnectionFromDetails: jest.fn(),
}));

// Mock netezza driver
const mockConnect = jest.fn();
const mockClose = jest.fn();
const mockExecuteReader = jest.fn();
const mockCreateCommand = jest.fn();
const mockRead = jest.fn();
const mockGetName = jest.fn();
const mockGetValue = jest.fn();
const mockCancel = jest.fn();
const mockReaderClose = jest.fn();

const mockConnection = {
  connect: mockConnect,
  close: mockClose,
  createCommand: mockCreateCommand,
};

jest.mock(
  "@justybase/netezza-driver",
  () => ({
    NzConnection: jest.fn().mockImplementation(() => mockConnection),
  }),
  { virtual: true },
);

describe("export/csvExporter", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockWriteStream: any;
  let mockProgress: vscode.Progress<{ message?: string; increment?: number }>;
  let mockCancellationToken: vscode.CancellationToken;

  const connectionDetails: ConnectionDetails = {
    host: "localhost",
    port: 5480,
    database: "TESTDB",
    user: "admin",
    password: "secret",
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock write stream
    mockWriteStream = {
      write: jest.fn().mockReturnValue(true),
      end: jest.fn(),
      on: jest.fn().mockImplementation((event, callback) => {
        if (event === "finish") {
          setTimeout(() => callback(), 0);
        }
        return mockWriteStream;
      }),
      once: jest.fn().mockImplementation((event, callback) => {
        if (event === "drain" || event === "finish") {
          setTimeout(() => callback(), 0);
        }
        return mockWriteStream;
      }),
    };

    (fs.createWriteStream as jest.Mock).mockReturnValue(mockWriteStream);

    // Setup mock progress
    mockProgress = {
      report: jest.fn(),
    };

    // Setup mock cancellation token
    mockCancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(),
    } as unknown as vscode.CancellationToken;

    // Setup mock command
    mockCreateCommand.mockReturnValue({
      executeReader: mockExecuteReader,
      commandTimeout: 0,
      cancel: mockCancel,
    });

    // Setup mock reader
    mockExecuteReader.mockResolvedValue({
      fieldCount: 3,
      getName: mockGetName,
      getValue: mockGetValue,
      read: mockRead,
      close: mockReaderClose,
    });

    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockImplementation(
      async () => {
        await mockConnect();
        return mockConnection;
      },
    );
  });

  describe("exportToCsv", () => {
    it("should export data to CSV file", async () => {
      // Setup reader to return 2 rows
      let readCount = 0;
      mockRead.mockImplementation(() => {
        readCount++;
        return Promise.resolve(readCount <= 2);
      });

      mockGetName.mockImplementation((i: number) => ["id", "name", "value"][i]);
      mockGetValue.mockImplementation(
        (i: number) => [readCount, `Name${readCount}`, readCount * 10][i],
      );

      await exportToCsv(
        connectionDetails,
        "SELECT * FROM test",
        "/tmp/test.csv",
      );

      expect(createConnectedDatabaseConnectionFromDetails).toHaveBeenCalledWith(connectionDetails);
      expect(mockConnect).toHaveBeenCalled();
      expect(fs.createWriteStream).toHaveBeenCalledWith("/tmp/test.csv", {
        encoding: "utf8",
        highWaterMark: 64 * 1024,
      });
      expect(mockWriteStream.write).toHaveBeenCalled();
      expect(mockWriteStream.end).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it("should report progress during export", async () => {
      let readCount = 0;
      mockRead.mockImplementation(() => {
        readCount++;
        return Promise.resolve(readCount <= 2);
      });

      mockGetName.mockImplementation((i: number) => ["id", "name", "value"][i]);
      mockGetValue.mockImplementation(
        (i: number) => [readCount, `Name${readCount}`, readCount * 10][i],
      );

      await exportToCsv(
        connectionDetails,
        "SELECT * FROM test",
        "/tmp/test.csv",
        mockProgress,
      );

      expect(mockProgress.report).toHaveBeenCalledWith({
        message: "Connecting to database...",
      });
      expect(mockProgress.report).toHaveBeenCalledWith({
        message: "Executing query...",
      });
      expect(mockProgress.report).toHaveBeenCalledWith({
        message: "Writing to CSV...",
      });
      expect(mockProgress.report).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Completed"),
        }),
      );
    });

    it("should handle cancellation before starting", async () => {
      mockCancellationToken.isCancellationRequested = true;

      await expect(
        exportToCsv(
          connectionDetails,
          "SELECT * FROM test",
          "/tmp/test.csv",
          mockProgress,
          undefined,
          mockCancellationToken,
        ),
      ).rejects.toThrow("Export cancelled by user");

      expect(mockConnect).not.toHaveBeenCalled();
    });

    it("should handle cancellation during export", async () => {
      let readCount = 0;
      const cancelAfter = 2;

      mockRead.mockImplementation(() => {
        readCount++;
        if (readCount === cancelAfter) {
          mockCancellationToken.isCancellationRequested = true;
        }
        return Promise.resolve(readCount <= 5);
      });

      mockGetName.mockImplementation((i: number) => ["id", "name"][i]);
      mockGetValue.mockImplementation(
        (i: number) => [readCount, `Name${readCount}`][i],
      );

      await expect(exportToCsv(
        connectionDetails,
        "SELECT * FROM test",
        "/tmp/test.csv",
        mockProgress,
        undefined,
        mockCancellationToken,
      )).rejects.toBeInstanceOf(ExportCancelledError);

      expect(mockProgress.report).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("cancelled"),
        }),
      );
      expect(mockCancel).toHaveBeenCalledTimes(1);
    });

    it("should use default port when not specified", async () => {
      const detailsWithoutPort: ConnectionDetails = {
        host: "localhost",
        database: "TESTDB",
        user: "admin",
        password: "secret",
      };

      mockRead.mockResolvedValue(false);
      mockGetName.mockReturnValue("id");

      await exportToCsv(detailsWithoutPort, "SELECT 1", "/tmp/test.csv");

      expect(createConnectedDatabaseConnectionFromDetails).toHaveBeenCalledWith(detailsWithoutPort);
    });

    it("should set command timeout when provided", async () => {
      mockRead.mockResolvedValue(false);
      mockGetName.mockReturnValue("id");

      await exportToCsv(
        connectionDetails,
        "SELECT * FROM test",
        "/tmp/test.csv",
        undefined,
        30000,
      );

      const mockCmd = mockCreateCommand.mock.results[0].value;
      expect(mockCmd.commandTimeout).toBe(30000);
    });

    it("should handle read errors gracefully", async () => {
      mockRead.mockRejectedValue(new Error("Read error"));
      mockGetName.mockReturnValue("id");

      await expect(exportToCsv(
        connectionDetails,
        "SELECT * FROM test",
        "/tmp/test.csv",
        mockProgress,
      )).rejects.toThrow("Read error");

      expect(mockProgress.report).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Error"),
        }),
      );
      expect(mockWriteStream.end).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it("should handle backpressure during write", async () => {
      // Simulate backpressure - write returns false when buffer is full
      let writeCallCount = 0;
      mockWriteStream.write.mockImplementation(() => {
        writeCallCount++;
        // Return false on buffer write to simulate backpressure
        return writeCallCount <= 2 ? false : true;
      });

      let readCount = 0;
      mockRead.mockImplementation(() => {
        readCount++;
        return Promise.resolve(readCount <= 600); // More than BUFFER_SIZE
      });

      mockGetName.mockImplementation((_i: number) => "id");
      mockGetValue.mockImplementation((_i: number) => readCount);

      await exportToCsv(
        connectionDetails,
        "SELECT * FROM test",
        "/tmp/test.csv",
      );

      // Verify that write was called multiple times (including with backpressure)
      expect(mockWriteStream.write).toHaveBeenCalledTimes(3); // header + buffer write + remaining
    });

    it("should close connection even on connection error", async () => {
      (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockRejectedValue(
        new Error("Connection failed"),
      );

      await expect(
        exportToCsv(connectionDetails, "SELECT * FROM test", "/tmp/test.csv"),
      ).rejects.toThrow("Connection failed");
    });

    it("should close connection in finally block", async () => {
      mockRead.mockResolvedValue(false);
      mockGetName.mockReturnValue("id");

      await exportToCsv(
        connectionDetails,
        "SELECT * FROM test",
        "/tmp/test.csv",
      );

      expect(mockClose).toHaveBeenCalled();
    });

    it("should handle empty result set", async () => {
      // Setup reader with 1 field but no rows
      mockExecuteReader.mockResolvedValue({
        fieldCount: 1,
        getName: mockGetName,
        getValue: mockGetValue,
        read: mockRead,
      });

      mockRead.mockResolvedValue(false);
      mockGetName.mockReturnValue("id");

      await exportToCsv(
        connectionDetails,
        "SELECT * FROM empty",
        "/tmp/test.csv",
        mockProgress,
      );

      expect(mockWriteStream.write).toHaveBeenCalledWith("id\n");
      expect(mockProgress.report).toHaveBeenCalledWith({
        message: "Completed: 0 rows exported",
      });
    });

    it("should report progress every 1000 rows", async () => {
      let readCount = 0;
      mockRead.mockImplementation(() => {
        readCount++;
        return Promise.resolve(readCount <= 1500);
      });

      mockGetName.mockReturnValue("id");
      mockGetValue.mockReturnValue(1);

      await exportToCsv(
        connectionDetails,
        "SELECT * FROM test",
        "/tmp/test.csv",
        mockProgress,
      );

      expect(mockProgress.report).toHaveBeenCalledWith({
        message: "Processed 1000 rows...",
      });
    });
  });

  describe("escapeCsvField", () => {
    it("should return empty string for null", () => {
      expect(escapeCsvField(null)).toBe("");
    });

    it("should return empty string for undefined", () => {
      expect(escapeCsvField(undefined)).toBe("");
    });

    it("should convert number to string", () => {
      expect(escapeCsvField(123)).toBe("123");
      expect(escapeCsvField(123.45)).toBe("123.45");
    });

    it("should convert boolean to string", () => {
      expect(escapeCsvField(true)).toBe("true");
      expect(escapeCsvField(false)).toBe("false");
    });

    it("should handle string without special chars", () => {
      expect(escapeCsvField("hello")).toBe("hello");
    });

    it("should escape string with comma", () => {
      expect(escapeCsvField("hello,world")).toBe('"hello,world"');
    });

    it("should escape string with quotes", () => {
      expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
    });

    it("should escape string with newline", () => {
      expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    });

    it("should escape string with carriage return", () => {
      expect(escapeCsvField("line1\rline2")).toBe('"line1\rline2"');
    });

    it("should handle bigint within safe range", () => {
      expect(escapeCsvField(BigInt(123))).toBe("123");
    });

    it("should handle bigint outside safe range", () => {
      const bigNum = BigInt("9999999999999999999");
      expect(escapeCsvField(bigNum)).toBe("9999999999999999999");
    });

    it("should format Date as ISO string", () => {
      const date = new Date("2024-01-15T10:30:00.000Z");
      expect(escapeCsvField(date)).toBe("2024-01-15T10:30:00.000Z");
    });

    it("should handle Buffer as hex string", () => {
      const buffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      expect(escapeCsvField(buffer)).toBe("48656c6c6f");
    });

    it("should stringify objects", () => {
      const obj = { name: "test", value: 123 };
      expect(escapeCsvField(obj)).toBe('"{""name"":""test"",""value"":123}"');
    });

    it("should stringify arrays", () => {
      const arr = [1, 2, 3];
      expect(escapeCsvField(arr)).toBe('"[1,2,3]"');
    });

    it("should handle mixed special characters", () => {
      expect(escapeCsvField('he said, "hi"\n')).toBe('"he said, ""hi""\n"');
    });

    it("should handle zero", () => {
      expect(escapeCsvField(0)).toBe("0");
    });

    it("should handle empty string", () => {
      expect(escapeCsvField("")).toBe("");
    });

    it("should handle string with only quotes", () => {
      expect(escapeCsvField('"')).toBe('""""');
    });

    it("should handle nested objects", () => {
      const nested = { level1: { level2: "value" } };
      const result = escapeCsvField(nested);
      expect(result).toContain("{");
      expect(result).toContain("}");
    });
  });
});
