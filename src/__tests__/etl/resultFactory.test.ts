/**
 * Unit tests for etl/utils/resultFactory.ts
 * Tests result factory functions and ResultBuilder class
 */

import {
  createSuccessResult,
  createErrorResult,
  createSkippedResult,
  createResult,
  ResultBuilder,
  resultBuilder,
} from "../../etl/utils/resultFactory";
import { EtlNodeStatus } from "../../etl/etlTypes";

describe("createSuccessResult", () => {
  it("should create success result with required fields", () => {
    const startTime = new Date("2024-01-01T10:00:00Z");
    const result = createSuccessResult("node-1", startTime);

    expect(result.nodeId).toBe("node-1");
    expect(result.status).toBe("success");
    expect(result.startTime).toBe(startTime);
    expect(result.endTime).toBeInstanceOf(Date);
    expect(result.error).toBeUndefined();
    expect(result.output).toBeUndefined();
    expect(result.rowsAffected).toBeUndefined();
  });

  it("should create success result with output", () => {
    const startTime = new Date();
    const output = { data: [1, 2, 3] };
    const result = createSuccessResult("node-1", startTime, { output });

    expect(result.output).toEqual(output);
  });

  it("should create success result with rowsAffected", () => {
    const startTime = new Date();
    const result = createSuccessResult("node-1", startTime, {
      rowsAffected: 100,
    });

    expect(result.rowsAffected).toBe(100);
  });

  it("should create success result with both output and rowsAffected", () => {
    const startTime = new Date();
    const output = { rows: 50 };
    const result = createSuccessResult("node-1", startTime, {
      output,
      rowsAffected: 50,
    });

    expect(result.output).toEqual(output);
    expect(result.rowsAffected).toBe(50);
  });

  it("should handle undefined options", () => {
    const startTime = new Date();
    const result = createSuccessResult("node-1", startTime, undefined);

    expect(result.status).toBe("success");
    expect(result.output).toBeUndefined();
  });

  it("should handle empty options object", () => {
    const startTime = new Date();
    const result = createSuccessResult("node-1", startTime, {});

    expect(result.status).toBe("success");
  });
});

describe("createErrorResult", () => {
  it("should create error result from string", () => {
    const startTime = new Date("2024-01-01T10:00:00Z");
    const result = createErrorResult(
      "node-1",
      startTime,
      "Something went wrong",
    );

    expect(result.nodeId).toBe("node-1");
    expect(result.status).toBe("error");
    expect(result.error).toBe("Something went wrong");
    expect(result.output).toBeUndefined();
    expect(result.rowsAffected).toBeUndefined();
  });

  it("should create error result from Error object", () => {
    const startTime = new Date();
    const error = new Error("Database connection failed");
    const result = createErrorResult("node-1", startTime, error);

    expect(result.error).toBe("Database connection failed");
  });

  it("should have startTime and endTime", () => {
    const startTime = new Date();
    const result = createErrorResult("node-1", startTime, "error");

    expect(result.startTime).toBe(startTime);
    expect(result.endTime).toBeInstanceOf(Date);
  });

  it("should handle custom error types", () => {
    const startTime = new Date();
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomError";
      }
    }
    const error = new CustomError("Custom error message");
    const result = createErrorResult("node-1", startTime, error);

    expect(result.error).toBe("Custom error message");
  });
});

describe("createSkippedResult", () => {
  it("should create skipped result", () => {
    const result = createSkippedResult("node-1");

    expect(result.nodeId).toBe("node-1");
    expect(result.status).toBe("skipped");
    expect(result.startTime).toBeInstanceOf(Date);
    expect(result.endTime).toBeInstanceOf(Date);
  });

  it("should have same startTime and endTime", () => {
    const result = createSkippedResult("node-1");

    expect(result.startTime.getTime()).toBe(result.endTime!.getTime());
  });

  it("should not have error, output, or rowsAffected", () => {
    const result = createSkippedResult("node-1");

    expect(result.error).toBeUndefined();
    expect(result.output).toBeUndefined();
    expect(result.rowsAffected).toBeUndefined();
  });
});

describe("createResult", () => {
  it("should create result with custom status", () => {
    const startTime = new Date();
    const result = createResult("node-1", startTime, "pending");

    expect(result.status).toBe("pending");
  });

  it("should create result with all statuses", () => {
    const startTime = new Date();
    const statuses: EtlNodeStatus[] = [
      "pending",
      "running",
      "success",
      "error",
      "skipped",
    ];

    statuses.forEach((status) => {
      const result = createResult("node-1", startTime, status);
      expect(result.status).toBe(status);
    });
  });

  it("should create result with error", () => {
    const startTime = new Date();
    const result = createResult("node-1", startTime, "error", {
      error: "Test error",
    });

    expect(result.error).toBe("Test error");
  });

  it("should create result with output", () => {
    const startTime = new Date();
    const output = { key: "value" };
    const result = createResult("node-1", startTime, "success", { output });

    expect(result.output).toEqual(output);
  });

  it("should create result with rowsAffected", () => {
    const startTime = new Date();
    const result = createResult("node-1", startTime, "success", {
      rowsAffected: 42,
    });

    expect(result.rowsAffected).toBe(42);
  });

  it("should create result with all options", () => {
    const startTime = new Date();
    const result = createResult("node-1", startTime, "error", {
      error: "Failed",
      output: { partial: true },
      rowsAffected: 5,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("Failed");
    expect(result.output).toEqual({ partial: true });
    expect(result.rowsAffected).toBe(5);
  });

  it("should handle undefined options", () => {
    const startTime = new Date();
    const result = createResult("node-1", startTime, "running", undefined);

    expect(result.status).toBe("running");
    expect(result.error).toBeUndefined();
  });
});

describe("ResultBuilder", () => {
  describe("constructor", () => {
    it("should create builder with nodeId", () => {
      const builder = new ResultBuilder("test-node");
      const result = builder.build();

      expect(result.nodeId).toBe("test-node");
    });

    it("should set startTime automatically", () => {
      const builder = new ResultBuilder("node-1");
      const result = builder.build();

      expect(result.startTime).toBeInstanceOf(Date);
    });
  });

  describe("success", () => {
    it("should set status to success", () => {
      const result = new ResultBuilder("node-1").success().build();

      expect(result.status).toBe("success");
    });

    it("should return builder for chaining", () => {
      const builder = new ResultBuilder("node-1");
      const returned = builder.success();

      expect(returned).toBe(builder);
    });
  });

  describe("error", () => {
    it("should set status to error with string message", () => {
      const result = new ResultBuilder("node-1").error("Error message").build();

      expect(result.status).toBe("error");
      expect(result.error).toBe("Error message");
    });

    it("should set status to error with Error object", () => {
      const error = new Error("Test error");
      const result = new ResultBuilder("node-1").error(error).build();

      expect(result.status).toBe("error");
      expect(result.error).toBe("Test error");
    });

    it("should return builder for chaining", () => {
      const builder = new ResultBuilder("node-1");
      const returned = builder.error("error");

      expect(returned).toBe(builder);
    });
  });

  describe("skipped", () => {
    it("should set status to skipped", () => {
      const result = new ResultBuilder("node-1").skipped().build();

      expect(result.status).toBe("skipped");
    });

    it("should return builder for chaining", () => {
      const builder = new ResultBuilder("node-1");
      const returned = builder.skipped();

      expect(returned).toBe(builder);
    });
  });

  describe("withOutput", () => {
    it("should set output", () => {
      const output = { result: "data" };
      const result = new ResultBuilder("node-1").withOutput(output).build();

      expect(result.output).toEqual(output);
    });

    it("should work with any output type", () => {
      const output = [1, 2, 3];
      const result = new ResultBuilder("node-1").withOutput(output).build();

      expect(result.output).toEqual([1, 2, 3]);
    });

    it("should return builder for chaining", () => {
      const builder = new ResultBuilder("node-1");
      const returned = builder.withOutput({});

      expect(returned).toBe(builder);
    });
  });

  describe("withRowsAffected", () => {
    it("should set rowsAffected", () => {
      const result = new ResultBuilder("node-1").withRowsAffected(100).build();

      expect(result.rowsAffected).toBe(100);
    });

    it("should handle zero", () => {
      const result = new ResultBuilder("node-1").withRowsAffected(0).build();

      expect(result.rowsAffected).toBe(0);
    });

    it("should return builder for chaining", () => {
      const builder = new ResultBuilder("node-1");
      const returned = builder.withRowsAffected(5);

      expect(returned).toBe(builder);
    });
  });

  describe("build", () => {
    it("should default to pending status", () => {
      const result = new ResultBuilder("node-1").build();

      expect(result.status).toBe("pending");
    });

    it("should set endTime automatically", () => {
      const result = new ResultBuilder("node-1").build();

      expect(result.endTime).toBeInstanceOf(Date);
    });

    it("should build complete result with all fields", () => {
      const output = { data: "test" };
      const result = new ResultBuilder("node-1")
        .success()
        .withOutput(output)
        .withRowsAffected(50)
        .build();

      expect(result).toMatchObject({
        nodeId: "node-1",
        status: "success",
        output,
        rowsAffected: 50,
      });
      expect(result.startTime).toBeInstanceOf(Date);
      expect(result.endTime).toBeInstanceOf(Date);
    });
  });

  describe("method chaining", () => {
    it("should support full method chain", () => {
      const result = new ResultBuilder("node-1")
        .success()
        .withOutput({ rows: 10 })
        .withRowsAffected(10)
        .build();

      expect(result.status).toBe("success");
      expect(result.output).toEqual({ rows: 10 });
      expect(result.rowsAffected).toBe(10);
    });

    it("should allow overwriting values", () => {
      const result = new ResultBuilder("node-1")
        .success()
        .error("Overwritten")
        .build();

      expect(result.status).toBe("error");
      expect(result.error).toBe("Overwritten");
    });
  });
});

describe("resultBuilder factory function", () => {
  it("should create a ResultBuilder instance", () => {
    const builder = resultBuilder("node-1");

    expect(builder).toBeInstanceOf(ResultBuilder);
  });

  it("should create builder with correct nodeId", () => {
    const result = resultBuilder("my-node").build();

    expect(result.nodeId).toBe("my-node");
  });

  it("should support chaining from factory", () => {
    const result = resultBuilder("node-1")
      .success()
      .withRowsAffected(100)
      .build();

    expect(result.status).toBe("success");
    expect(result.rowsAffected).toBe(100);
  });
});
