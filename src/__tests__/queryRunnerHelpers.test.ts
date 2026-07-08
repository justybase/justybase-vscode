/**
 * Unit tests for core/queryRunnerHelpers.ts
 * Covers: getConnectionForDocument, executeDropSession, logQueryToHistory, handleBusyConnectionError
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock("vscode", () => ({
    window: {
        showInformationMessage: jest.fn().mockResolvedValue(undefined),
        showWarningMessage: jest.fn().mockResolvedValue(undefined),
        showErrorMessage: jest.fn(),
    },
}));

jest.mock("../core/queryHistoryManager", () => ({
    QueryHistoryManager: {
        getInstance: jest.fn().mockReturnValue({
            addEntry: jest.fn().mockResolvedValue(undefined),
        }),
    },
}));

const mockTransientConnection = {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    createCommand: jest.fn().mockReturnValue({
        executeReader: jest.fn().mockResolvedValue({
            close: jest.fn().mockResolvedValue(undefined),
        }),
    }),
};

jest.mock("../core/connectionFactory", () => ({
    createConnectedDatabaseConnectionFromDetails: jest.fn().mockResolvedValue(mockTransientConnection),
    resolveConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
}));

jest.mock("../core/queryRunnerUtils", () => ({
    normalizeUriKey: jest.fn((uri: string) => uri),
    logOutput: jest.fn(),
}));

jest.mock("../utils/sqlConsole", () => ({
    isSqlConsoleDocument: jest.fn(),
    SQL_CONSOLE_HISTORY_TAG: "console",
}));

import * as vscode from "vscode";
import {
    getConnectionForDocument,
    executeDropSession,
    logQueryToHistory,
    handleBusyConnectionError,
} from "../core/queryRunnerHelpers";
import { createConnectedDatabaseConnectionFromDetails } from "../core/connectionFactory";
import { QueryHistoryManager } from "../core/queryHistoryManager";
import { isSqlConsoleDocument } from "../utils/sqlConsole";

describe("queryRunnerHelpers", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTransientConnection.createCommand.mockReturnValue({
            executeReader: jest.fn().mockResolvedValue({
                close: jest.fn().mockResolvedValue(undefined),
            }),
        });
    });

    // -----------------------------------------------------------------------
    // getConnectionForDocument
    // -----------------------------------------------------------------------
    describe("getConnectionForDocument", () => {
        it("should use persistent connection when keepConnectionOpen and documentUri provided", async () => {
            const mockConn = { id: "persistent" } as any;
            const connManager = {
                getDocumentPersistentConnection: jest.fn().mockResolvedValue(mockConn),
                getConnection: jest.fn(),
            } as any;

            const result = await getConnectionForDocument(
                connManager,
                "ConnA",
                true,
                "file:///test.sql",
            );

            expect(result.connection).toBe(mockConn);
            expect(result.shouldCloseConnection).toBe(false);
            expect(
                connManager.getDocumentPersistentConnection,
            ).toHaveBeenCalledWith("file:///test.sql", "ConnA");
        });

        it("should create new connection when keepConnectionOpen is false", async () => {
            const connManager = {
                getConnection: jest.fn().mockResolvedValue({
                    host: "host1",
                    port: 5480,
                    database: "db1",
                    user: "user1",
                    password: "pass1",
                }),
            } as any;

            const result = await getConnectionForDocument(
                connManager,
                "ConnA",
                false,
                "file:///test.sql",
            );

            expect(result.shouldCloseConnection).toBe(true);
            expect(result.connection).toBeDefined();
        });

        it("should create new connection when documentUri is undefined", async () => {
            const connManager = {
                getConnection: jest.fn().mockResolvedValue({
                    host: "host1",
                    port: 5480,
                    database: "db1",
                    user: "user1",
                    password: "pass1",
                }),
            } as any;

            const result = await getConnectionForDocument(
                connManager,
                "ConnA",
                true,
                undefined,
            );

            expect(result.shouldCloseConnection).toBe(true);
        });

        it("should throw when connection details not found", async () => {
            const connManager = {
                getConnection: jest.fn().mockResolvedValue(null),
            } as any;

            await expect(
                getConnectionForDocument(connManager, "Missing", false),
            ).rejects.toThrow("Connection 'Missing' not found");
        });

        it("should use default port 5480 when port is undefined", async () => {
            const connManager = {
                getConnection: jest.fn().mockResolvedValue({
                    host: "h",
                    database: "d",
                    user: "u",
                    password: "p",
                }),
            } as any;

            await getConnectionForDocument(connManager, "C", false);

            expect(createConnectedDatabaseConnectionFromDetails).toHaveBeenCalledWith(
                expect.objectContaining({ host: "h", database: "d", user: "u", password: "p" }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // executeDropSession
    // -----------------------------------------------------------------------
    describe("executeDropSession", () => {
        it("should drop session successfully", async () => {
            const connManager = {
                getActiveConnectionName: jest.fn().mockReturnValue("ConnA"),
                getConnection: jest.fn().mockResolvedValue({
                    host: "h",
                    port: 5480,
                    database: "d",
                    user: "u",
                    password: "p",
                }),
                getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(false),
            } as any;

            await executeDropSession("123", connManager);

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                "Session 123 dropped successfully.",
            );
        });

        it("should do nothing when no active connection", async () => {
            const connManager = {
                getActiveConnectionName: jest.fn().mockReturnValue(null),
            } as any;

            await executeDropSession("123", connManager);

            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it("should do nothing when connection details not found", async () => {
            const connManager = {
                getActiveConnectionName: jest.fn().mockReturnValue("ConnA"),
                getConnection: jest.fn().mockResolvedValue(null),
            } as any;

            await executeDropSession("123", connManager);

            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it("should re-establish persistent connection when keepConnectionOpen is true", async () => {
            const connManager = {
                getActiveConnectionName: jest.fn().mockReturnValue("ConnA"),
                getConnection: jest.fn().mockResolvedValue({
                    host: "h",
                    port: 5480,
                    database: "d",
                    user: "u",
                    password: "p",
                }),
                getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(true),
                closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
                getDocumentPersistentConnection: jest.fn().mockResolvedValue({}),
            } as any;

            await executeDropSession("123", connManager, "file:///test.sql");

            expect(
                connManager.closeDocumentPersistentConnection,
            ).toHaveBeenCalledWith("file:///test.sql");
            expect(
                connManager.getDocumentPersistentConnection,
            ).toHaveBeenCalledWith("file:///test.sql", "ConnA");
        });

        it("should NOT re-establish persistent connection when no documentUri", async () => {
            const connManager = {
                getActiveConnectionName: jest.fn().mockReturnValue("ConnA"),
                getConnection: jest.fn().mockResolvedValue({
                    host: "h",
                    port: 5480,
                    database: "d",
                    user: "u",
                    password: "p",
                }),
                getDocumentKeepConnectionOpen: jest.fn(),
                closeDocumentPersistentConnection: jest.fn(),
            } as any;

            await executeDropSession("123", connManager);

            expect(
                connManager.closeDocumentPersistentConnection,
            ).not.toHaveBeenCalled();
        });

        it("should show error message when drop fails", async () => {
            const connManager = {
                getActiveConnectionName: jest.fn().mockImplementation(() => {
                    throw new Error("Connection error");
                }),
            } as any;

            await executeDropSession("123", connManager);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining("Failed to drop session"),
            );
        });
    });

    // -----------------------------------------------------------------------
    // logQueryToHistory
    // -----------------------------------------------------------------------
    describe("logQueryToHistory", () => {
        it("should skip logging for non-user queries", async () => {
            const connManager = { getConnection: jest.fn() } as any;
            const ctx = {} as any;

            await logQueryToHistory(ctx, connManager, "C", "SELECT 1", false);

            expect(connManager.getConnection).not.toHaveBeenCalled();
        });

        it("should skip when connection details not found", async () => {
            const connManager = {
                getConnection: jest.fn().mockResolvedValue(null),
            } as any;
            const ctx = {} as any;

            await logQueryToHistory(ctx, connManager, "C", "SELECT 1", true);

            expect(
                QueryHistoryManager.getInstance,
            ).not.toHaveBeenCalled();
        });

        it("should log user query to history", async () => {
            const connManager = {
                getConnection: jest.fn().mockResolvedValue({
                    host: "h",
                    database: "d",
                }),
            } as any;
            const ctx = {} as any;
            const mockAddEntry = jest.fn().mockResolvedValue(undefined);
            (QueryHistoryManager.getInstance as jest.Mock).mockReturnValue({
                addEntry: mockAddEntry,
            });

            await logQueryToHistory(ctx, connManager, "C", "SELECT 1");

            expect(mockAddEntry).toHaveBeenCalledWith(
                "h",
                "d",
                expect.any(String),
                "SELECT 1",
                "C",
                undefined,
                undefined,
                true,
                undefined,
                undefined,
                undefined,
                undefined,
            );
        });

        it("should tag SQL console queries in history", async () => {
            const connManager = {
                getConnection: jest.fn().mockResolvedValue({
                    host: "h",
                    database: "d",
                }),
            } as any;
            const ctx = {} as any;
            const mockAddEntry = jest.fn().mockResolvedValue(undefined);
            (QueryHistoryManager.getInstance as jest.Mock).mockReturnValue({
                addEntry: mockAddEntry,
            });
            (isSqlConsoleDocument as jest.Mock).mockReturnValue(true);

            await logQueryToHistory(ctx, connManager, "C", "SELECT 1", true, "untitled:Console-C.sql");

            expect(mockAddEntry).toHaveBeenCalledWith(
                "h",
                "d",
                expect.any(String),
                "SELECT 1",
                "C",
                "console",
                undefined,
                true,
                undefined,
                undefined,
                undefined,
                undefined,
            );
        });

        it("should handle history logging errors gracefully", async () => {
            const connManager = {
                getConnection: jest.fn().mockResolvedValue({
                    host: "h",
                    database: "d",
                }),
            } as any;
            const ctx = {} as any;
            (QueryHistoryManager.getInstance as jest.Mock).mockReturnValue({
                addEntry: jest.fn().mockRejectedValue(new Error("write fail")),
            });

            // Should not throw
            await expect(
                logQueryToHistory(ctx, connManager, "C", "SELECT 1"),
            ).resolves.not.toThrow();
        });

        it("should default isUserQuery to true", async () => {
            const connManager = {
                getConnection: jest.fn().mockResolvedValue({
                    host: "h",
                    database: "d",
                }),
            } as any;
            const ctx = {} as any;
            const mockAddEntry = jest.fn().mockResolvedValue(undefined);
            (QueryHistoryManager.getInstance as jest.Mock).mockReturnValue({
                addEntry: mockAddEntry,
            });

            await logQueryToHistory(ctx, connManager, "C", "SELECT 1");

            expect(mockAddEntry).toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // handleBusyConnectionError
    // -----------------------------------------------------------------------
    describe("handleBusyConnectionError", () => {
        it("should return true for busy connection error with documentUri", async () => {
            const error = new Error("Connection is already executing a command");
            const connManager = {
                getDocumentLastSessionId: jest.fn().mockReturnValue("42"),
            } as any;
            const logger = { outputChannel: undefined, logCallback: undefined } as any;

            const result = await handleBusyConnectionError(
                error,
                connManager,
                logger,
                "file:///test.sql",
                false,
            );

            expect(result).toBe(true);
            expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        });

        it("should return false when error is not a busy connection", async () => {
            const error = new Error("Some other error");
            const connManager = {} as any;
            const logger = {} as any;

            const result = await handleBusyConnectionError(
                error,
                connManager,
                logger,
                "file:///test.sql",
                false,
            );

            expect(result).toBe(false);
        });

        it("should return false when silent is true", async () => {
            const error = new Error("Connection is already executing a command");
            const connManager = {} as any;
            const logger = {} as any;

            const result = await handleBusyConnectionError(
                error,
                connManager,
                logger,
                "file:///test.sql",
                true,
            );

            expect(result).toBe(false);
        });

        it("should return false when documentUri is undefined", async () => {
            const error = new Error("Connection is already executing a command");
            const connManager = {} as any;
            const logger = {} as any;

            const result = await handleBusyConnectionError(
                error,
                connManager,
                logger,
                undefined,
                false,
            );

            expect(result).toBe(false);
        });

        it("should handle when no session ID is known", async () => {
            const error = new Error("Connection is already executing a command");
            const connManager = {
                getDocumentLastSessionId: jest.fn().mockReturnValue(undefined),
            } as any;
            const logger = { outputChannel: undefined, logCallback: undefined } as any;

            const result = await handleBusyConnectionError(
                error,
                connManager,
                logger,
                "file:///test.sql",
                false,
            );

            expect(result).toBe(true);
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringContaining("busy"),
                "",
                "Reset Connection",
            );
        });

        it("should handle Drop Session selection", async () => {
            const error = new Error("Connection is already executing a command");
            const connManager = {
                getDocumentLastSessionId: jest.fn().mockReturnValue("42"),
                getActiveConnectionName: jest.fn().mockReturnValue("C"),
                getConnection: jest.fn().mockResolvedValue({
                    host: "h",
                    port: 5480,
                    database: "d",
                    user: "u",
                    password: "p",
                }),
                getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(false),
            } as any;
            const logger = { outputChannel: undefined, logCallback: undefined } as any;

            // Mock showWarningMessage to return the Drop Session selection
            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(
                "Drop Session 42",
            );

            await handleBusyConnectionError(
                error,
                connManager,
                logger,
                "file:///test.sql",
                false,
            );

            // Wait for the .then() handler to execute
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                "Session 42 dropped successfully.",
            );
        });

        it("should handle Reset Connection selection", async () => {
            const error = new Error("Connection is already executing a command");
            const connManager = {
                getDocumentLastSessionId: jest.fn().mockReturnValue("42"),
                closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
            } as any;
            const logger = { outputChannel: undefined, logCallback: undefined } as any;

            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(
                "Reset Connection",
            );

            await handleBusyConnectionError(
                error,
                connManager,
                logger,
                "file:///test.sql",
                false,
            );

            // Wait for the .then() handler
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(
                connManager.closeDocumentPersistentConnection,
            ).toHaveBeenCalledWith("file:///test.sql");
        });

        it("should handle non-Error objects", async () => {
            const error = "string error message";
            const connManager = {} as any;
            const logger = {} as any;

            const result = await handleBusyConnectionError(
                error,
                connManager,
                logger,
                "file:///test.sql",
                false,
            );

            expect(result).toBe(false);
        });
    });
});
