/**
 * Tests for databasesTool.ts
 */

import * as vscode from "vscode";
import {
  DatabasesTool,
  IDatabasesToolParameters,
} from "../services/copilotTools/databasesTool";
import { CopilotService } from "../services/copilotService";

jest.mock("vscode", () => ({
  MarkdownString: jest
    .fn()
    .mockImplementation((text: string) => ({ value: text })),
  LanguageModelTextPart: jest
    .fn()
    .mockImplementation((text: string) => ({ text })),
  LanguageModelToolResult: jest
    .fn()
    .mockImplementation((parts: unknown[]) => ({ parts })),
}));

describe("services/copilotTools/databasesTool", () => {
  let mockCopilotService: jest.Mocked<CopilotService>;
  let tool: DatabasesTool;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCopilotService = {
      getDatabases: jest.fn(),
    } as unknown as jest.Mocked<CopilotService>;

    tool = new DatabasesTool(mockCopilotService);
  });

  describe("prepareInvocation", () => {
    it("should return prepared invocation with correct message", async () => {
      const mockOptions =
        {} as vscode.LanguageModelToolInvocationPrepareOptions<IDatabasesToolParameters>;
      const mockToken = {} as vscode.CancellationToken;

      const result = await tool.prepareInvocation(mockOptions, mockToken);

      expect(result).toHaveProperty(
        "invocationMessage",
        "Fetching list of databases...",
      );
      expect(result.confirmationMessages).toHaveProperty(
        "title",
        "Get Databases",
      );
      expect(result.confirmationMessages?.message).toBeDefined();
    });

    it("should create MarkdownString for confirmation message", async () => {
      const mockOptions =
        {} as vscode.LanguageModelToolInvocationPrepareOptions<IDatabasesToolParameters>;
      const mockToken = {} as vscode.CancellationToken;

      await tool.prepareInvocation(mockOptions, mockToken);

      expect(vscode.MarkdownString).toHaveBeenCalledWith(
        "Fetch list of all databases accessible via the current connection?",
      );
    });
  });

  describe("invoke", () => {
    it("should return databases from copilotService", async () => {
      const mockDatabases = "DATABASE1\nDATABASE2\nDATABASE3";
      mockCopilotService.getDatabases.mockResolvedValue(mockDatabases);

      const mockOptions =
        {} as vscode.LanguageModelToolInvocationOptions<IDatabasesToolParameters>;
      const mockToken = {} as vscode.CancellationToken;

      await tool.invoke(mockOptions, mockToken);

      expect(mockCopilotService.getDatabases).toHaveBeenCalled();
      expect(vscode.LanguageModelTextPart).toHaveBeenCalledWith(mockDatabases);
      expect(vscode.LanguageModelToolResult).toHaveBeenCalled();
    });

    it("should handle errors from copilotService", async () => {
      mockCopilotService.getDatabases.mockRejectedValue(
        new Error("Connection failed"),
      );

      const mockOptions =
        {} as vscode.LanguageModelToolInvocationOptions<IDatabasesToolParameters>;
      const mockToken = {} as vscode.CancellationToken;

      await expect(tool.invoke(mockOptions, mockToken)).rejects.toThrow(
        "Failed to get databases: Connection failed",
      );
    });

    it("should handle non-Error exceptions", async () => {
      mockCopilotService.getDatabases.mockRejectedValue("String error");

      const mockOptions =
        {} as vscode.LanguageModelToolInvocationOptions<IDatabasesToolParameters>;
      const mockToken = {} as vscode.CancellationToken;

      await expect(tool.invoke(mockOptions, mockToken)).rejects.toThrow(
        "Failed to get databases: String error",
      );
    });

    it("should handle empty database list", async () => {
      mockCopilotService.getDatabases.mockResolvedValue("");

      const mockOptions =
        {} as vscode.LanguageModelToolInvocationOptions<IDatabasesToolParameters>;
      const mockToken = {} as vscode.CancellationToken;

      await tool.invoke(mockOptions, mockToken);

      expect(vscode.LanguageModelTextPart).toHaveBeenCalledWith("");
    });
  });
});
