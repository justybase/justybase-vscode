import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { runWithRequestBoundary } from "../server/requestBoundary";

describe("runWithRequestBoundary", () => {
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse("2026-04-03T12:00:00.000Z"));
    logger.log.mockReset();
    logger.error.mockReset();
  });

  afterEach(async () => {
    await jest.runOnlyPendingTimersAsync();
    jest.useRealTimers();
  });

  it("returns a fast successful result without emitting perf logs", async () => {
    const result = await runWithRequestBoundary(
      {
        operation: "completion",
        budgetMs: 1000,
        slowLogThresholdMs: 200,
        fallbackValue: [],
        logger,
        nowProvider: () => Date.now(),
      },
      async () => ["SELECT"],
    );

    expect(result).toEqual(["SELECT"]);
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs slow successful requests", async () => {
    const resultPromise = runWithRequestBoundary(
      {
        operation: "hover",
        budgetMs: 1000,
        slowLogThresholdMs: 200,
        fallbackValue: null,
        logger,
        nowProvider: () => Date.now(),
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { contents: "ok" };
      },
    );

    await jest.advanceTimersByTimeAsync(250);

    await expect(resultPromise).resolves.toEqual({ contents: "ok" });
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('"operation":"lsp.request.hover"'),
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('"duration_ms":250'),
    );
  });

  it("returns the fallback value on timeout and logs the timeout event", async () => {
    const resultPromise = runWithRequestBoundary(
      {
        operation: "completion",
        budgetMs: 100,
        fallbackValue: ["FALLBACK"],
        logger,
        nowProvider: () => Date.now(),
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return ["LATE"];
      },
    );

    await jest.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toEqual(["FALLBACK"]);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('"error_code":"TIMEOUT"'),
    );
  });

  it("returns the fallback value when cancelled before execution starts", async () => {
    const result = await runWithRequestBoundary(
      {
        operation: "definition",
        budgetMs: 500,
        fallbackValue: null,
        logger,
        token: { isCancellationRequested: true },
        nowProvider: () => Date.now(),
      },
      async () => ({ uri: "file:///ignored" }),
    );

    expect(result).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('"result":"cancelled"'),
    );
  });

  it("returns the fallback value and logs handler errors", async () => {
    const result = await runWithRequestBoundary(
      {
        operation: "hover",
        budgetMs: 500,
        fallbackValue: null,
        logger,
        nowProvider: () => Date.now(),
      },
      async () => {
        throw new Error("boom");
      },
    );

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"error_message":"boom"'),
    );
  });
});