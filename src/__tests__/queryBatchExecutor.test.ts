/**
 * Unit tests for core/queryBatchExecutor.ts
 * Tests the shared batch execution utilities extracted from queryRunner.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Mock vscode module
jest.mock("vscode", () => ({
    window: {
        createOutputChannel: jest.fn(() => ({
            appendLine: jest.fn(),
            show: jest.fn(),
            dispose: jest.fn(),
        })),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showErrorMessage: jest.fn(),
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((key: string, defaultValue: unknown) => {
                if (key === "query.executionTimeout") return 1800;
                if (key === "query.rowLimit") return 200000;
                return defaultValue;
            }),
        })),
        getWorkspaceFolder: jest.fn(),
    },
    Uri: {
        file: jest.fn((filePath: string) => ({
            scheme: "file",
            fsPath: filePath,
            toString: () => `file://${filePath}`,
        })),
        parse: jest.fn((value: string) => ({
            scheme: value.startsWith("file://") ? "file" : "untitled",
            fsPath: value.replace(/^file:\/\//, ""),
            toString: () => value,
        })),
    },
}));

// Mock variable utils
jest.mock("../core/variableUtils", () => {
    const actual = jest.requireActual("../core/variableUtils");
    return {
        ...actual,
        extractVariables: jest.fn().mockReturnValue(new Set<string>()),
        parseSetVariables: jest.fn((sql: string) => ({
            sql,
            setValues: {},
        })),
        replaceVariablesInSql: jest.fn(
            (sql: string, _vars: Record<string, string>) => sql,
        ),
    };
});

// Mock variable resolver
jest.mock("../core/variableResolver", () => ({
    promptForVariableValues: jest.fn().mockResolvedValue({}),
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
        setDocumentLastSessionId: jest.fn(),
    })),
}));

// Mock query history manager
jest.mock("../core/queryHistoryManager", () => ({
    QueryHistoryManager: {
        getInstance: jest.fn().mockReturnValue({
            addEntry: jest.fn().mockResolvedValue(undefined),
        }),
    },
}));

// Mock queryRunnerHelpers
jest.mock("../core/queryRunnerHelpers", () => ({
    handleBusyConnectionError: jest.fn().mockResolvedValue(false),
    executeDropSession: jest.fn().mockResolvedValue(undefined),
    getConnectionForDocument: jest.fn(),
}));

import {
    resolveBatchConnectionName,
    resolveBatchVariables,
    captureSessionId,
    setupBatchLogger,
    logBatch,
    executeMacroExport,
    createMacroFileReadContext,
    prepareQueryForExecution,
    logQueryToHistoryAsync,
    handleBatchRetry,
    handleBatchError,
    createDropSessionCallback,
    getQueryConfig,
} from "../core/queryBatchExecutor";
import { extractVariables, parseSetVariables } from "../core/variableUtils";
import { promptForVariableValues } from "../core/variableResolver";
import { handleBusyConnectionError } from "../core/queryRunnerHelpers";

describe("queryBatchExecutor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // resolveBatchConnectionName
    // -----------------------------------------------------------------------
    describe("resolveBatchConnectionName", () => {
        it("should use document-specific connection if available", () => {
            const connManager = {
                getConnectionForExecution: jest.fn().mockReturnValue("DocConn"),
                getActiveConnectionName: jest.fn(),
            } as any;

            expect(resolveBatchConnectionName(connManager, "file:///test.sql")).toBe(
                "DocConn",
            );
            expect(connManager.getConnectionForExecution).toHaveBeenCalledWith(
                "file:///test.sql",
            );
        });

        it("should fall back to active connection", () => {
            const connManager = {
                getConnectionForExecution: jest.fn().mockReturnValue(undefined),
                getActiveConnectionName: jest.fn().mockReturnValue("ActiveConn"),
            } as any;

            expect(resolveBatchConnectionName(connManager)).toBe("ActiveConn");
        });

        it("should throw when no connection available", () => {
            const connManager = {
                getConnectionForExecution: jest.fn().mockReturnValue(undefined),
                getActiveConnectionName: jest.fn().mockReturnValue(null),
            } as any;

            expect(() => resolveBatchConnectionName(connManager)).toThrow(
                "No connection selected",
            );
        });

        it("should prioritize document connection over active connection", () => {
            const connManager = {
                getConnectionForExecution: jest.fn().mockReturnValue("DocConn"),
                getActiveConnectionName: jest.fn().mockReturnValue("ActiveConn"),
            } as any;

            expect(resolveBatchConnectionName(connManager, "file:///test.sql")).toBe(
                "DocConn",
            );
            expect(connManager.getActiveConnectionName).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // resolveBatchVariables
    // -----------------------------------------------------------------------
    describe("resolveBatchVariables", () => {
        it("should return empty object when no variables", async () => {
            const ctx = {} as any;
            const result = await resolveBatchVariables(["SELECT 1"], ctx);
            expect(result).toEqual({});
        });

        it("should not prompt for variables declared before use", async () => {
            const ctx = {} as any;
            const result = await resolveBatchVariables(
                ["@SET myvar=default_val", "SELECT ${myvar}"],
                ctx,
            );

            expect(result).toEqual({});
            expect(promptForVariableValues).not.toHaveBeenCalled();
        });

        it("should prompt for variables without defaults", async () => {
            (parseSetVariables as jest.Mock).mockReturnValue({
                sql: "SELECT ${x}",
                setValues: {},
            });
            (extractVariables as jest.Mock).mockReturnValue(new Set(["x"]));
            (promptForVariableValues as jest.Mock).mockResolvedValue({
                x: "user_val",
            });

            const ctx = {} as any;
            const result = await resolveBatchVariables(["SELECT ${x}"], ctx);

            expect(promptForVariableValues).toHaveBeenCalled();
            expect(result).toHaveProperty("x", "user_val");
        });

        it("should not prompt for variables with @SET defaults", async () => {
            const ctx = {} as any;
            await resolveBatchVariables(["@SET x=set_val\nSELECT ${x}"], ctx);

            expect(promptForVariableValues).not.toHaveBeenCalled();
        });

        it("should prompt when a variable is referenced before a later %let in the same query", async () => {
            (promptForVariableValues as jest.Mock).mockResolvedValueOnce({
                X: "prompt_val",
            });

            const ctx = {} as any;
            const result = await resolveBatchVariables(
                ["SELECT &x; %let x=1; SELECT &x;"],
                ctx,
            );

            expect(promptForVariableValues).toHaveBeenCalledWith(
                new Set(["X"]),
                false,
                {},
                ctx,
            );
            expect(result).toEqual({ X: "prompt_val" });
        });

        it("should not prompt when a %let declaration appears before use in the same query", async () => {
            const ctx = {} as any;
            const result = await resolveBatchVariables(
                ["%let x=1; SELECT &x;"],
                ctx,
            );

            expect(result).toEqual({});
            expect(promptForVariableValues).not.toHaveBeenCalled();
        });

        it("should not require query context while scanning %SQL inside %let declarations", async () => {
            const ctx = {} as any;
            const result = await resolveBatchVariables(
                [`%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);`],
                ctx,
            );

            expect(result).toEqual({});
            expect(promptForVariableValues).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // captureSessionId
    // -----------------------------------------------------------------------
    describe("captureSessionId", () => {
        it("should capture session ID from connection", async () => {
            const mockReader = {
                read: jest.fn().mockResolvedValueOnce(true),
                getValue: jest.fn().mockReturnValue(12345),
                close: jest.fn().mockResolvedValue(undefined),
            };
            const mockCmd = {
                executeReader: jest.fn().mockResolvedValue(mockReader),
            };
            const connection = {
                createCommand: jest.fn().mockReturnValue(mockCmd),
            } as any;
            const connManager = {
                setDocumentLastSessionId: jest.fn(),
            } as any;

            const sid = await captureSessionId(
                connection,
                connManager,
                "file:///test.sql",
            );

            expect(sid).toBe("12345");
            expect(connManager.setDocumentLastSessionId).toHaveBeenCalled();
        });

        it("should return undefined when SID query fails", async () => {
            const connection = {
                createCommand: jest.fn().mockImplementation(() => {
                    throw new Error("Command failed");
                }),
            } as any;
            const connManager = {} as any;

            const sid = await captureSessionId(connection, connManager);
            expect(sid).toBeUndefined();
        });

        it("should call logCallback with session ID", async () => {
            const mockReader = {
                read: jest.fn().mockResolvedValueOnce(true),
                getValue: jest.fn().mockReturnValue(42),
                close: jest.fn().mockResolvedValue(undefined),
            };
            const connection = {
                createCommand: jest.fn().mockReturnValue({
                    executeReader: jest.fn().mockResolvedValue(mockReader),
                }),
            } as any;
            const connManager = {
                setDocumentLastSessionId: jest.fn(),
            } as any;
            const logCallback = jest.fn();

            await captureSessionId(connection, connManager, undefined, logCallback);

            expect(logCallback).toHaveBeenCalledWith("Connected. Session ID: 42");
        });

        it("should call logCallback with 'Connected.' when SID fails", async () => {
            const connection = {
                createCommand: jest.fn().mockImplementation(() => {
                    throw new Error("fail");
                }),
            } as any;
            const logCallback = jest.fn();

            await captureSessionId(connection, {} as any, undefined, logCallback);

            expect(logCallback).toHaveBeenCalledWith("Connected.");
        });
    });

    // -----------------------------------------------------------------------
    // setupBatchLogger
    // -----------------------------------------------------------------------
    describe("setupBatchLogger", () => {
        it("should return output channel when no logCallback", () => {
            const channel = setupBatchLogger(undefined, 5, "sequential");
            expect(channel).toBeDefined();
            expect(channel!.appendLine).toBeDefined();
        });

        it("should return undefined when logCallback is provided", () => {
            const channel = setupBatchLogger(jest.fn(), 5);
            expect(channel).toBeUndefined();
        });

        it("should show streaming mode label", () => {
            const channel = setupBatchLogger(undefined, 3, "streaming");
            expect(channel).toBeDefined();
            expect(channel!.appendLine).toHaveBeenCalledWith(
                expect.stringContaining("with streaming"),
            );
        });
    });

    // -----------------------------------------------------------------------
    // logBatch
    // -----------------------------------------------------------------------
    describe("logBatch", () => {
        it("should log to output channel when present", () => {
            const appendLine = jest.fn();
            logBatch({ appendLine } as any, undefined, "test msg");
            expect(appendLine).toHaveBeenCalledWith("test msg");
        });

        it("should call logCallback when present", () => {
            const callback = jest.fn();
            logBatch(undefined, callback, "test msg");
            expect(callback).toHaveBeenCalledWith("test msg");
        });

        it("should log to both when both present", () => {
            const appendLine = jest.fn();
            const callback = jest.fn();
            logBatch({ appendLine } as any, callback, "test msg");
            expect(appendLine).toHaveBeenCalledWith("test msg");
            expect(callback).toHaveBeenCalledWith("test msg");
        });

        it("should handle both undefined gracefully", () => {
            expect(() => logBatch(undefined, undefined, "test msg")).not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // prepareQueryForExecution
    // -----------------------------------------------------------------------
    describe("prepareQueryForExecution", () => {
        it("should parse and replace variables", async () => {
            const result = await prepareQueryForExecution("SELECT ${x}", { x: "42" });
            expect(result).toBe("SELECT 42");
        });

        it("should emit %PUT messages through the log callback", async () => {
            const logCallback = jest.fn();

            const result = await prepareQueryForExecution(
                "%PUT Sum is &sum;",
                { SUM: "8" },
                logCallback,
            );

            expect(result).toBe("");
            expect(logCallback).toHaveBeenCalledWith(">>> %PUT: Sum is 8");
        });

        it("persists directive variables across statements in source order", async () => {
            const vars: Record<string, string> = {};

            expect(await prepareQueryForExecution("%let x = 1;", vars)).toBe("");
            expect(vars).toEqual({ X: "1" });
            expect(await prepareQueryForExecution("SELECT &x;", vars)).toBe("SELECT 1;");
            expect(await prepareQueryForExecution("%let x = 2;", vars)).toBe("");
            expect(await prepareQueryForExecution("SELECT &x;", vars)).toBe("SELECT 2;");
        });

        it("expands %sql and %sqllist query macros", async () => {
            const queryExecutor = jest.fn()
                .mockResolvedValueOnce({ rows: [[42]] })
                .mockResolvedValueOnce({ rows: [["EAST"], ["WEST"]] });

            const result = await prepareQueryForExecution(
                "SELECT %sql(SELECT MAX(id) FROM t) AS max_id WHERE region IN (%sqllist(SELECT region FROM r));",
                {},
                undefined,
                queryExecutor,
            );

            expect(result).toBe("SELECT 42 AS max_id WHERE region IN ('EAST', 'WEST');");
            expect(queryExecutor).toHaveBeenCalledWith("SELECT MAX(id) FROM t");
            expect(queryExecutor).toHaveBeenCalledWith("SELECT region FROM r");
        });

        it("executes %SQL inside directive-only %let statements and skips empty SQL", async () => {
            const queryExecutor = jest.fn().mockResolvedValueOnce({ rows: [[20240731]] });
            const vars: Record<string, string> = {};

            const result = await prepareQueryForExecution(
                `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);`,
                vars,
                undefined,
                queryExecutor,
            );

            expect(result).toBe("");
            expect(vars).toMatchObject({
                DIM_TABLE: "JUST_DATA.ADMIN.DIMDATE",
                AS_OF_KEY: "20240731",
            });
            expect(queryExecutor).toHaveBeenCalledWith(
                "SELECT MAX(DATEKEY)\n  FROM JUST_DATA.ADMIN.DIMDATE",
            );
        });

        it("executes %EXPORT directives and writes an XLSX file", async () => {
            const outputPath = path.join(
                os.tmpdir(),
                `justybase_macro_export_${Date.now()}.xlsx`,
            );
            const queryExecutor = jest.fn().mockResolvedValueOnce({
                columns: [{ name: "ID", type: "INTEGER" }, { name: "NAME", type: "VARCHAR" }],
                rows: [[1, "Alpha"], [2, "Beta"]],
            });
            const logCallback = jest.fn();

            try {
                const result = await prepareQueryForExecution(
                    `%EXPORT(
  file='${outputPath}',
  sheet='Data',
  query=(SELECT ID, NAME FROM TEST_TABLE)
);`,
                    {},
                    logCallback,
                    queryExecutor,
                );

                expect(result).toBe("");
                expect(queryExecutor).toHaveBeenCalledWith("SELECT ID, NAME FROM TEST_TABLE");
                expect(fs.existsSync(outputPath)).toBe(true);
                expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
                expect(logCallback).toHaveBeenCalledWith(
                    `>>> %EXPORT: Exported 2 rows to ${outputPath}`,
                );
            } finally {
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
            }
        });

        it("reads %INCLUDE files through the macro file context", async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "justybase-macro-include-"));
            const sourcePath = path.join(tempDir, "main.sql");
            const includePath = path.join(tempDir, "settings.sql");
            fs.writeFileSync(includePath, "%LET x = 42;\n");

            try {
                const vars: Record<string, string> = {};
                const result = await prepareQueryForExecution(
                    "%INCLUDE 'settings.sql';\nSELECT &x;",
                    vars,
                    undefined,
                    undefined,
                    createMacroFileReadContext(sourcePath),
                );

                expect(result.trim()).toBe("SELECT 42;");
                expect(vars.X).toBe("42");
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it("rejects absolute %INCLUDE files outside the active workspace", async () => {
            const vscode = require("vscode");
            const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "justybase-workspace-"));
            const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "justybase-outside-"));
            const outsidePath = path.join(outsideDir, "outside.sql");
            fs.writeFileSync(outsidePath, "%LET x = 42;\n");
            vscode.workspace.getWorkspaceFolder.mockReturnValue({
                uri: { fsPath: workspaceDir },
            });

            try {
                await expect(
                    prepareQueryForExecution(
                        `%INCLUDE '${outsidePath}';`,
                        {},
                        undefined,
                        undefined,
                        createMacroFileReadContext(path.join(workspaceDir, "main.sql")),
                    ),
                ).rejects.toThrow("%INCLUDE path escapes the workspace");
            } finally {
                vscode.workspace.getWorkspaceFolder.mockReset();
                fs.rmSync(workspaceDir, { recursive: true, force: true });
                fs.rmSync(outsideDir, { recursive: true, force: true });
            }
        });

        it("rejects absolute %INCLUDE files outside allowed directories when no workspace is open", async () => {
            const vscode = require("vscode");
            const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "justybase-outside-"));
            const outsidePath = path.join(outsideDir, "outside.sql");
            fs.writeFileSync(outsidePath, "%LET x = 42;\n");
            vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined);
            vscode.workspace.workspaceFolders = undefined;

            try {
                await expect(
                    prepareQueryForExecution(
                        `%INCLUDE '${outsidePath}';`,
                        {},
                        undefined,
                        undefined,
                        createMacroFileReadContext(),
                    ),
                ).rejects.toThrow("%INCLUDE path escapes allowed directories");
            } finally {
                fs.rmSync(outsideDir, { recursive: true, force: true });
            }
        });

        it("logs macro script events from preprocessing", async () => {
            const logCallback = jest.fn();
            const readFile = jest.fn().mockResolvedValue({
                path: "/workspace/inc.sql",
                content: "SELECT 1;",
            });

            await prepareQueryForExecution(
                `%INCLUDE 'inc.sql';
%IF 1 = 1 %THEN %DO;
  %PUT included=1;
  SELECT 1;
%END;`,
                {},
                logCallback,
                undefined,
                {
                    ...createMacroFileReadContext("/workspace/main.sql"),
                    readFile,
                },
            );

            expect(logCallback).toHaveBeenCalledWith(">>> %INCLUDE: /workspace/inc.sql");
            expect(logCallback).toHaveBeenCalledWith(">>> %PUT: included=1");
            expect(logCallback).toHaveBeenCalledWith(">>> %IF: executed THEN branch");
        });

        it("refuses to overwrite %EXPORT targets unless overwrite is enabled", async () => {
            const outputPath = path.join(
                os.tmpdir(),
                `justybase_macro_export_existing_${Date.now()}.xlsx`,
            );
            fs.writeFileSync(outputPath, "existing");

            try {
                await expect(
                    executeMacroExport(
                        {
                            format: "xlsx",
                            filePath: outputPath,
                            query: "SELECT 1",
                            sheetName: "Data",
                            overwrite: false,
                        },
                        jest.fn(),
                    ),
                ).rejects.toThrow("%EXPORT target already exists");
            } finally {
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
            }
        });
    });

    // -----------------------------------------------------------------------
    // logQueryToHistoryAsync
    // -----------------------------------------------------------------------
    describe("logQueryToHistoryAsync", () => {
        it("should call addEntry on history manager", () => {
            const addEntry = jest.fn().mockResolvedValue(undefined);
            const historyManager = { addEntry } as any;

            logQueryToHistoryAsync(
                historyManager,
                "host1",
                "db1",
                "SELECT 1",
                "conn1",
            );

            expect(addEntry).toHaveBeenCalledWith(
                "host1",
                "db1",
                "unknown",
                "SELECT 1",
                "conn1",
                undefined,
                undefined,
                true,
                undefined,
                undefined,
                undefined,
                undefined,
            );
        });

        it("should handle addEntry rejection gracefully", () => {
            const addEntry = jest
                .fn()
                .mockRejectedValue(new Error("write failed"));
            const historyManager = { addEntry } as any;

            // Should not throw
            expect(() =>
                logQueryToHistoryAsync(
                    historyManager,
                    "host",
                    "db",
                    "SELECT 1",
                    "conn",
                ),
            ).not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // handleBatchRetry
    // -----------------------------------------------------------------------
    describe("handleBatchRetry", () => {
        it("should retry on broken connection error", async () => {
            const brokenError = new Error("Socket closed");
            const connManager = {
                closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
            } as any;
            const retryFn = jest.fn().mockResolvedValue("retried-result");

            const result = await handleBatchRetry(
                brokenError,
                false,
                connManager,
                "file:///test.sql",
                true,
                undefined,
                jest.fn(),
                retryFn,
            );

            expect(result).toEqual({ handled: true, result: "retried-result" });
            expect(connManager.closeDocumentPersistentConnection).toHaveBeenCalledWith(
                "file:///test.sql",
            );
            expect(retryFn).toHaveBeenCalled();
        });

        it("should NOT retry when isRetry is true", async () => {
            const brokenError = new Error("Socket closed");
            const connManager = { closeDocumentPersistentConnection: jest.fn() } as any;
            const retryFn = jest.fn();

            const result = await handleBatchRetry(
                brokenError,
                true, // already retried
                connManager,
                "file:///test.sql",
                true,
                undefined,
                undefined,
                retryFn,
            );

            expect(result).toEqual({ handled: false });
            expect(retryFn).not.toHaveBeenCalled();
        });

        it("should NOT retry for non-connection errors", async () => {
            const syntaxError = new Error("Syntax error");
            const connManager = { closeDocumentPersistentConnection: jest.fn() } as any;
            const retryFn = jest.fn();

            const result = await handleBatchRetry(
                syntaxError,
                false,
                connManager,
                "file:///test.sql",
                true,
                undefined,
                undefined,
                retryFn,
            );

            expect(result).toEqual({ handled: false });
            expect(retryFn).not.toHaveBeenCalled();
        });

        it("should NOT retry without document URI", async () => {
            const brokenError = new Error("Socket closed");
            const connManager = { closeDocumentPersistentConnection: jest.fn() } as any;
            const retryFn = jest.fn();

            const result = await handleBatchRetry(
                brokenError,
                false,
                connManager,
                undefined, // no document
                true,
                undefined,
                undefined,
                retryFn,
            );

            expect(result).toEqual({ handled: false });
        });

        it("should throw when retry also fails", async () => {
            const brokenError = new Error("Socket closed");
            const connManager = {
                closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
            } as any;
            const retryFn = jest
                .fn()
                .mockRejectedValue(new Error("Still broken"));

            await expect(
                handleBatchRetry(
                    brokenError,
                    false,
                    connManager,
                    "file:///test.sql",
                    true,
                    undefined,
                    jest.fn(),
                    retryFn,
                ),
            ).rejects.toThrow("Error (after reconnect attempt): Still broken");
        });
    });

    // -----------------------------------------------------------------------
    // handleBatchError
    // -----------------------------------------------------------------------
    describe("handleBatchError", () => {
        it("should throw busy connection error when detected", async () => {
            (handleBusyConnectionError as jest.Mock).mockResolvedValue(true);
            const connManager = {} as any;

            await expect(
                handleBatchError(
                    new Error("Connection is already executing a command"),
                    connManager,
                    undefined,
                    undefined,
                    "file:///test.sql",
                ),
            ).rejects.toThrow("Connection is busy");
        });

        it("should throw formatted error for regular errors", async () => {
            (handleBusyConnectionError as jest.Mock).mockResolvedValue(false);
            const connManager = {} as any;

            await expect(
                handleBatchError(
                    new Error("Table not found"),
                    connManager,
                    undefined,
                    undefined,
                ),
            ).rejects.toThrow("Error: Table not found");
        });

        it("should log error to output channel", async () => {
            (handleBusyConnectionError as jest.Mock).mockResolvedValue(false);
            const appendLine = jest.fn();
            const connManager = {} as any;

            await expect(
                handleBatchError(
                    new Error("Some error"),
                    connManager,
                    { appendLine } as any,
                    undefined,
                ),
            ).rejects.toThrow();

            expect(appendLine).toHaveBeenCalledWith("Error: Some error");
        });
    });

    // -----------------------------------------------------------------------
    // createDropSessionCallback
    // -----------------------------------------------------------------------
    describe("createDropSessionCallback", () => {
        it("should return a function", () => {
            const connManager = {} as any;
            const cb = createDropSessionCallback(connManager, "file:///test.sql");
            expect(typeof cb).toBe("function");
        });

        it("should call executeDropSession when invoked", async () => {
            const { executeDropSession } = require("../core/queryRunnerHelpers");
            const connManager = {} as any;
            const cb = createDropSessionCallback(connManager, "file:///test.sql");
            await cb!("123");
            expect(executeDropSession).toHaveBeenCalledWith(
                "123",
                connManager,
                "file:///test.sql",
            );
        });
    });

    // -----------------------------------------------------------------------
    // getQueryConfig
    // -----------------------------------------------------------------------
    describe("getQueryConfig", () => {
        it("should return default config values", () => {
            const config = getQueryConfig();
            expect(config).toEqual({
                queryTimeout: 1800,
                rowLimit: 200000,
            });
        });
    });
});
