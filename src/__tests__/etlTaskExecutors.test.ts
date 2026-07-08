/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for ETL Task Executors
 * Tests base task executor and specific task implementations
 */

import { BaseTaskExecutor } from "../etl/tasks/baseTaskExecutor";
import { SqlTaskExecutor } from "../etl/tasks/sqlTask";
import { VariableTaskExecutor } from "../etl/tasks/variableTask";
import { ContainerTaskExecutor } from "../etl/tasks/containerTask";
import {
  EtlNode,
  EtlNodeExecutionResult,
  SqlNodeConfig,
  VariableNodeConfig,
  ContainerNodeConfig,
  EtlExecutionResult,
} from "../etl/etlTypes";
import {
  ExecutionContext,
  IVariableResolver,
  IConnectionFactory,
  IExecutionEngine,
} from "../etl/interfaces";
import { IVariableManager } from "../etl/utils/variableManager";
import { NzConnection, NzDataReader } from "../types";

// Mock resultFactory
jest.mock("../etl/utils/resultFactory", () => ({
  createSuccessResult: jest.fn((nodeId, startTime, options) => ({
    nodeId,
    status: "success",
    startTime,
    endTime: new Date(),
    ...options,
  })),
  createErrorResult: jest.fn((nodeId, startTime, error) => ({
    nodeId,
    status: "error",
    startTime,
    endTime: new Date(),
    error: error instanceof Error ? error.message : error,
  })),
  ResultBuilder: jest.fn().mockImplementation((nodeId: string) => ({
    success: jest.fn().mockReturnThis(),
    error: jest.fn().mockReturnThis(),
    skipped: jest.fn().mockReturnThis(),
    withOutput: jest.fn().mockReturnThis(),
    withRowsAffected: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({
      nodeId,
      status: "skipped",
      startTime: new Date(),
      endTime: new Date(),
    }),
  })),
}));

describe("BaseTaskExecutor", () => {
  interface TestConfig {
    type: "sql";
    query: string;
  }

  class TestTaskExecutor extends BaseTaskExecutor<TestConfig> {
    async execute(
      _node: EtlNode,
      _context: ExecutionContext,
    ): Promise<EtlNodeExecutionResult> {
      const config = this.getConfig(_node);
      const startTime = new Date();

      if (!config.query) {
        return this.createError(_node.id, startTime, "Query is required");
      }

      return this.createSuccess(_node.id, startTime, { output: config.query });
    }
  }

  let executor: TestTaskExecutor;
  let mockVariableResolver: IVariableResolver;
  let mockContext: ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();

    mockVariableResolver = {
      resolve: jest.fn((template: string) => template),
    } as unknown as IVariableResolver;

    executor = new TestTaskExecutor(mockVariableResolver);

    mockContext = {
      extensionContext: {} as any,
      variables: {},
      nodeOutputs: new Map(),
      connectionDetails: {
        host: "localhost",
        port: 5480,
        database: "test",
        user: "admin",
        password: "password",
      },
      cancellationToken: {
        isCancellationRequested: false,
      } as any,
      onProgress: jest.fn(),
    };
  });

  describe("getConfig", () => {
    it("should return typed config from node", () => {
      const node: EtlNode = {
        id: "test-node",
        type: "sql",
        name: "Test Node",
        position: { x: 0, y: 0 },
        config: { type: "sql", query: "SELECT 1" },
      };

      const config = (executor as any).getConfig(node);
      expect(config).toEqual({ type: "sql", query: "SELECT 1" });
    });
  });

  describe("resolveVariables", () => {
    it("should resolve variables using the resolver", () => {
      (mockVariableResolver.resolve as jest.Mock).mockReturnValue(
        "SELECT * FROM users",
      );

      const result = (executor as any).resolveVariables(
        "SELECT * FROM ${table}",
        mockContext,
      );

      expect(mockVariableResolver.resolve).toHaveBeenCalledWith(
        "SELECT * FROM ${table}",
        {},
      );
      expect(result).toBe("SELECT * FROM users");
    });
  });

  describe("createSuccess", () => {
    it("should create a success result", () => {
      const startTime = new Date();
      const result = (executor as any).createSuccess("node-1", startTime, {
        rowsAffected: 10,
      });

      expect(result.status).toBe("success");
      expect(result.nodeId).toBe("node-1");
      expect(result.rowsAffected).toBe(10);
    });
  });

  describe("createError", () => {
    it("should create an error result from string", () => {
      const startTime = new Date();
      const result = (executor as any).createError(
        "node-1",
        startTime,
        "Error message",
      );

      expect(result.status).toBe("error");
      expect(result.error).toBe("Error message");
    });

    it("should create an error result from Error object", () => {
      const startTime = new Date();
      const result = (executor as any).createError(
        "node-1",
        startTime,
        new Error("Error message"),
      );

      expect(result.status).toBe("error");
      expect(result.error).toBe("Error message");
    });
  });

  describe("resultBuilder", () => {
    it("should return a ResultBuilder instance", () => {
      const builder = (executor as any).resultBuilder("node-1");
      expect(builder).toBeDefined();
      expect(builder.build).toBeDefined();
    });
  });

  describe("reportProgress", () => {
    it("should call progress callback when available", () => {
      (executor as any).reportProgress(mockContext, "Progress message");
      expect(mockContext.onProgress).toHaveBeenCalledWith("Progress message");
    });

    it("should not throw when progress callback is not available", () => {
      const contextWithoutProgress = { ...mockContext, onProgress: undefined };
      expect(() => {
        (executor as any).reportProgress(
          contextWithoutProgress,
          "Progress message",
        );
      }).not.toThrow();
    });
  });

  describe("isCancelled", () => {
    it("should return true when cancellation is requested", () => {
      mockContext.cancellationToken = { isCancellationRequested: true } as any;
      expect((executor as any).isCancelled(mockContext)).toBe(true);
    });

    it("should return false when cancellation is not requested", () => {
      expect((executor as any).isCancelled(mockContext)).toBe(false);
    });

    it("should return false when no cancellation token", () => {
      const contextWithoutToken = {
        ...mockContext,
        cancellationToken: undefined,
      };
      expect((executor as any).isCancelled(contextWithoutToken)).toBe(false);
    });
  });

  describe("validateRequired", () => {
    it("should return undefined for valid value", () => {
      const startTime = new Date();
      const result = (executor as any).validateRequired(
        "node-1",
        startTime,
        "valid",
        "Field",
      );
      expect(result).toBeUndefined();
    });

    it("should return error for undefined value", () => {
      const startTime = new Date();
      const result = (executor as any).validateRequired(
        "node-1",
        startTime,
        undefined,
        "Field",
      );
      expect(result).toBeDefined();
      expect(result.status).toBe("error");
      expect(result.error).toBe("Field is required");
    });

    it("should return error for null value", () => {
      const startTime = new Date();
      const result = (executor as any).validateRequired(
        "node-1",
        startTime,
        null,
        "Field",
      );
      expect(result).toBeDefined();
      expect(result.status).toBe("error");
    });

    it("should return error for empty string value", () => {
      const startTime = new Date();
      const result = (executor as any).validateRequired(
        "node-1",
        startTime,
        "",
        "Field",
      );
      expect(result).toBeDefined();
      expect(result.status).toBe("error");
    });
  });

  describe("safeExecute", () => {
    it("should return result when execution succeeds", async () => {
      const startTime = new Date();
      const successResult = {
        nodeId: "node-1",
        status: "success",
      } as EtlNodeExecutionResult;

      const result = await (executor as any).safeExecute(
        "node-1",
        startTime,
        async () => successResult,
      );

      expect(result).toBe(successResult);
    });

    it("should return error result when execution throws", async () => {
      const startTime = new Date();

      const result = await (executor as any).safeExecute(
        "node-1",
        startTime,
        async () => {
          throw new Error("Execution failed");
        },
      );

      expect(result.status).toBe("error");
      expect(result.error).toBe("Execution failed");
    });
  });
});

describe("SqlTaskExecutor", () => {
  let executor: SqlTaskExecutor;
  let mockConnectionFactory: IConnectionFactory;
  let mockVariableResolver: IVariableResolver;
  let mockConnection: jest.Mocked<NzConnection>;
  let mockContext: ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConnection = {
      createCommand: jest.fn(),
      close: jest.fn(),
    } as unknown as jest.Mocked<NzConnection>;

    mockConnectionFactory = {
      createConnection: jest.fn().mockResolvedValue(mockConnection),
    } as unknown as IConnectionFactory;

    mockVariableResolver = {
      resolve: jest.fn((template: string) => template),
    } as unknown as IVariableResolver;

    executor = new SqlTaskExecutor(mockVariableResolver, mockConnectionFactory);

    mockContext = {
      extensionContext: {} as any,
      variables: {},
      nodeOutputs: new Map(),
      connectionDetails: {
        host: "localhost",
        port: 5480,
        database: "test",
        user: "admin",
        password: "password",
      },
      cancellationToken: undefined,
      onProgress: jest.fn(),
    };
  });

  const createMockReader = (data: {
    columns: string[];
    rows: unknown[][];
  }): NzDataReader =>
    ({
      fieldCount: data.columns.length,
      getName: jest.fn((i: number) => data.columns[i]),
      getValue: jest.fn((i: number) => data.rows[0]?.[i] ?? null),
      read: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      close: jest.fn(),
    }) as unknown as NzDataReader;

  describe("execute", () => {
    it("should return error when query is empty", async () => {
      const node: EtlNode = {
        id: "sql-node",
        type: "sql",
        name: "SQL Node",
        position: { x: 0, y: 0 },
        config: { type: "sql", query: "" } as SqlNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("error");
      expect(result.error).toContain("SQL query");
    });

    it("should return error when connection details are missing", async () => {
      const node: EtlNode = {
        id: "sql-node",
        type: "sql",
        name: "SQL Node",
        position: { x: 0, y: 0 },
        config: { type: "sql", query: "SELECT 1" } as SqlNodeConfig,
      };

      const contextWithoutConnection = {
        ...mockContext,
        connectionDetails: undefined as any,
      };
      const result = await executor.execute(node, contextWithoutConnection);

      expect(result.status).toBe("error");
      expect(result.error).toContain("connection");
    });

    it("should execute query and return results", async () => {
      const mockReader = createMockReader({
        columns: ["ID", "NAME"],
        rows: [[1, "Test"]],
      });

      const mockCommand = {
        executeReader: jest.fn().mockResolvedValue(mockReader),
        commandTimeout: undefined,
      };

      mockConnection.createCommand.mockReturnValue(mockCommand as any);

      const node: EtlNode = {
        id: "sql-node",
        type: "sql",
        name: "SQL Node",
        position: { x: 0, y: 0 },
        config: { type: "sql", query: "SELECT * FROM users" } as SqlNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("success");
      expect(mockConnectionFactory.createConnection).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should handle query with timeout", async () => {
      const mockReader = createMockReader({
        columns: ["ID"],
        rows: [[1]],
      });

      const mockCommand = {
        executeReader: jest.fn().mockResolvedValue(mockReader),
        commandTimeout: undefined,
      };

      mockConnection.createCommand.mockReturnValue(mockCommand as any);

      const node: EtlNode = {
        id: "sql-node",
        type: "sql",
        name: "SQL Node",
        position: { x: 0, y: 0 },
        config: {
          type: "sql",
          query: "SELECT 1",
          timeout: 30,
        } as SqlNodeConfig,
      };

      await executor.execute(node, mockContext);

      expect(mockCommand.commandTimeout).toBe(30);
    });
  });
});

describe("VariableTaskExecutor", () => {
  let executor: VariableTaskExecutor;
  let mockConnectionFactory: IConnectionFactory;
  let mockVariableResolver: IVariableResolver;
  let mockVariableManager: IVariableManager;
  let mockConnection: jest.Mocked<NzConnection>;
  let mockContext: ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConnection = {
      createCommand: jest.fn(),
      close: jest.fn(),
    } as unknown as jest.Mocked<NzConnection>;

    mockConnectionFactory = {
      createConnection: jest.fn().mockResolvedValue(mockConnection),
    } as unknown as IConnectionFactory;

    mockVariableResolver = {
      resolve: jest.fn((template: string) => template),
    } as unknown as IVariableResolver;

    mockVariableManager = {
      set: jest.fn(),
      get: jest.fn(),
      has: jest.fn(),
      getAll: jest.fn().mockReturnValue({}),
      promptForValue: jest.fn().mockResolvedValue("user-input"),
    } as unknown as IVariableManager;

    executor = new VariableTaskExecutor(
      mockVariableResolver,
      mockConnectionFactory,
    );
    executor.setVariableManager(mockVariableManager);

    mockContext = {
      extensionContext: {} as any,
      variables: {},
      nodeOutputs: new Map(),
      connectionDetails: {
        host: "localhost",
        port: 5480,
        database: "test",
        user: "admin",
        password: "password",
      },
      cancellationToken: undefined,
      onProgress: jest.fn(),
    };
  });

  describe("execute", () => {
    it("should return error when variable name is missing", async () => {
      const node: EtlNode = {
        id: "var-node",
        type: "variable",
        name: "Variable Node",
        position: { x: 0, y: 0 },
        config: {
          type: "variable",
          variableName: "",
          source: "static",
        } as VariableNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("error");
      expect(result.error).toContain("Variable name");
    });

    it("should return error when variable manager is not available", async () => {
      executor.setVariableManager(null as any);

      const node: EtlNode = {
        id: "var-node",
        type: "variable",
        name: "Variable Node",
        position: { x: 0, y: 0 },
        config: {
          type: "variable",
          variableName: "testVar",
          source: "static",
          value: "test",
        } as VariableNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("error");
      expect(result.error).toContain("Variable manager");
    });

    it("should handle static variable assignment", async () => {
      const node: EtlNode = {
        id: "var-node",
        type: "variable",
        name: "Variable Node",
        position: { x: 0, y: 0 },
        config: {
          type: "variable",
          variableName: "testVar",
          source: "static",
          value: "static-value",
        } as VariableNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("success");
      expect(mockVariableManager.set).toHaveBeenCalledWith(
        "testVar",
        "static-value",
      );
      expect(mockContext.variables.testVar).toBe("static-value");
    });

    it("should handle prompt variable assignment", async () => {
      (mockVariableManager.promptForValue as jest.Mock).mockResolvedValue(
        "user-value",
      );

      const node: EtlNode = {
        id: "var-node",
        type: "variable",
        name: "Variable Node",
        position: { x: 0, y: 0 },
        config: {
          type: "variable",
          variableName: "testVar",
          source: "prompt",
          promptMessage: "Enter value",
          defaultValue: "default",
        } as VariableNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("success");
      expect(mockVariableManager.promptForValue).toHaveBeenCalledWith(
        "testVar",
        "Enter value",
        "default",
      );
      expect(mockVariableManager.set).toHaveBeenCalledWith(
        "testVar",
        "user-value",
      );
    });

    it("should return error for unknown source type", async () => {
      const node: EtlNode = {
        id: "var-node",
        type: "variable",
        name: "Variable Node",
        position: { x: 0, y: 0 },
        config: {
          type: "variable",
          variableName: "testVar",
          source: "unknown" as any,
        } as VariableNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("error");
      expect(result.error).toContain("Unknown variable source");
    });

    it("should handle cancelled prompt", async () => {
      (mockVariableManager.promptForValue as jest.Mock).mockResolvedValue(
        undefined,
      );

      const node: EtlNode = {
        id: "var-node",
        type: "variable",
        name: "Variable Node",
        position: { x: 0, y: 0 },
        config: {
          type: "variable",
          variableName: "testVar",
          source: "prompt",
        } as VariableNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("error");
      expect(result.error).toContain("not set");
    });
  });
});

describe("ContainerTaskExecutor", () => {
  let executor: ContainerTaskExecutor;
  let mockEngine: IExecutionEngine;
  let mockVariableResolver: IVariableResolver;
  let mockContext: ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();

    mockEngine = {
      registerExecutor: jest.fn(),
      execute: jest.fn(),
    } as unknown as IExecutionEngine;

    mockVariableResolver = {
      resolve: jest.fn((template: string) => template),
    } as unknown as IVariableResolver;

    executor = new ContainerTaskExecutor(mockEngine, mockVariableResolver);

    mockContext = {
      extensionContext: {} as any,
      variables: {},
      nodeOutputs: new Map(),
      connectionDetails: {
        host: "localhost",
        port: 5480,
        database: "test",
        user: "admin",
        password: "password",
      },
      cancellationToken: undefined,
      onProgress: jest.fn(),
    };
  });

  describe("execute", () => {
    it("should return success for empty container", async () => {
      const node: EtlNode = {
        id: "container-node",
        type: "container",
        name: "Container",
        position: { x: 0, y: 0 },
        config: {
          type: "container",
          nodes: [],
          connections: [],
        } as ContainerNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("success");
      expect(result.output).toBe("Empty container - nothing to execute");
    });

    it("should execute nested nodes and return success", async () => {
      const nestedNode: EtlNode = {
        id: "nested-node",
        type: "sql",
        name: "Nested SQL",
        position: { x: 0, y: 0 },
        config: { type: "sql", query: "SELECT 1" },
      };

      const mockExecutionResult: EtlExecutionResult = {
        projectName: "Container: Test Container",
        startTime: new Date(),
        endTime: new Date(),
        status: "completed",
        nodeResults: new Map([
          [
            "nested-node",
            { nodeId: "nested-node", status: "success", startTime: new Date() },
          ],
        ]),
      };

      (mockEngine.execute as jest.Mock).mockResolvedValue(mockExecutionResult);

      const node: EtlNode = {
        id: "container-node",
        type: "container",
        name: "Test Container",
        position: { x: 0, y: 0 },
        config: {
          type: "container",
          nodes: [nestedNode],
          connections: [],
        } as ContainerNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("success");
      expect(mockEngine.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Container: Test Container",
          nodes: [nestedNode],
        }),
        mockContext,
      );
    });

    it("should handle cancelled execution", async () => {
      const nestedNode: EtlNode = {
        id: "nested-node",
        type: "sql",
        name: "Nested SQL",
        position: { x: 0, y: 0 },
        config: { type: "sql", query: "SELECT 1" },
      };

      const mockExecutionResult: EtlExecutionResult = {
        projectName: "Container: Test Container",
        startTime: new Date(),
        endTime: new Date(),
        status: "cancelled",
        nodeResults: new Map(),
      };

      (mockEngine.execute as jest.Mock).mockResolvedValue(mockExecutionResult);

      const node: EtlNode = {
        id: "container-node",
        type: "container",
        name: "Test Container",
        position: { x: 0, y: 0 },
        config: {
          type: "container",
          nodes: [nestedNode],
          connections: [],
        } as ContainerNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("skipped");
    });

    it("should handle failed execution", async () => {
      const nestedNode: EtlNode = {
        id: "nested-node",
        type: "sql",
        name: "Nested SQL",
        position: { x: 0, y: 0 },
        config: { type: "sql", query: "SELECT 1" },
      };

      const mockExecutionResult: EtlExecutionResult = {
        projectName: "Container: Test Container",
        startTime: new Date(),
        endTime: new Date(),
        status: "failed",
        nodeResults: new Map([
          [
            "nested-node",
            {
              nodeId: "nested-node",
              status: "error",
              error: "SQL Error",
              startTime: new Date(),
            },
          ],
        ]),
      };

      (mockEngine.execute as jest.Mock).mockResolvedValue(mockExecutionResult);

      const node: EtlNode = {
        id: "container-node",
        type: "container",
        name: "Test Container",
        position: { x: 0, y: 0 },
        config: {
          type: "container",
          nodes: [nestedNode],
          connections: [],
        } as ContainerNodeConfig,
      };

      const result = await executor.execute(node, mockContext);

      expect(result.status).toBe("error");
      expect(result.error).toBe("SQL Error");
    });
  });
});
