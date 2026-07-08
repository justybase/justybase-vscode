import type { CancellationToken } from "vscode-languageserver/node";
import {
  createPerformanceTimer,
  formatPerformanceEvent,
  type PerformanceMetadata,
} from "../services/perf/performanceEvents";

export interface RequestBoundaryLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface RequestBoundaryOptions<TResult> {
  operation: string;
  documentUri?: string;
  budgetMs: number;
  fallbackValue: TResult;
  logger: RequestBoundaryLogger;
  token?: Pick<CancellationToken, "isCancellationRequested">;
  slowLogThresholdMs?: number;
  nowProvider?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface RequestBoundaryContext {
  isCancellationRequested(): boolean;
}

type OperationOutcome<TResult> =
  | { kind: "success"; value: TResult }
  | { kind: "error"; error: unknown };

/**
 * Applies a soft latency budget, consistent cancellation checks, and structured
 * performance/error logging around LSP request handlers.
 */
export async function runWithRequestBoundary<TResult>(
  options: RequestBoundaryOptions<TResult>,
  operation: (context: RequestBoundaryContext) => Promise<TResult>,
): Promise<TResult> {
  const {
    operation: operationName,
    documentUri,
    budgetMs,
    fallbackValue,
    logger,
    token,
    slowLogThresholdMs = Math.max(0, Math.round(budgetMs / 2)),
    nowProvider,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;
  const timer = createPerformanceTimer(`lsp.request.${operationName}`, {
    nowProvider,
  });
  const metadata = buildMetadata(documentUri, budgetMs);
  const isCancellationRequested = () => !!token?.isCancellationRequested;

  if (isCancellationRequested()) {
    logger.log(
      formatPerformanceEvent(
        timer.finish({
          result: "cancelled",
          errorCode: "CANCELLED_BEFORE_START",
          metadata,
        }),
      ),
    );
    return fallbackValue;
  }

  const operationPromise = (async (): Promise<OperationOutcome<TResult>> => {
    try {
      const value = await operation({ isCancellationRequested });
      return { kind: "success", value };
    } catch (error: unknown) {
      return { kind: "error", error };
    }
  })();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise: Promise<OperationOutcome<TResult> | "timeout"> =
    budgetMs > 0
      ? new Promise((resolve) => {
          timeoutHandle = setTimeoutFn(() => resolve("timeout"), budgetMs);
        })
      : Promise.resolve(operationPromise);
  const outcome =
    budgetMs > 0
      ? await Promise.race<OperationOutcome<TResult> | "timeout">([
          operationPromise,
          timeoutPromise,
        ])
      : await operationPromise;

  if (timeoutHandle !== undefined) {
    clearTimeoutFn(timeoutHandle);
  }

  if (outcome === "timeout") {
    logger.log(
      formatPerformanceEvent(
        timer.finish({
          result: "error",
          errorCode: "TIMEOUT",
          metadata,
        }),
      ),
    );
    return fallbackValue;
  }

  if (outcome.kind === "error") {
    const errorCode = isCancellationRequested() ? "CANCELLED" : "HANDLER_ERROR";
    logger.error(
      formatPerformanceEvent(
        timer.finish({
          result: isCancellationRequested() ? "cancelled" : "error",
          errorCode,
          metadata: {
            ...metadata,
            error_message: toErrorMessage(outcome.error),
          },
        }),
      ),
    );
    return fallbackValue;
  }

  if (isCancellationRequested()) {
    logger.log(
      formatPerformanceEvent(
        timer.finish({
          result: "cancelled",
          errorCode: "CANCELLED_AFTER_RUN",
          metadata,
        }),
      ),
    );
    return fallbackValue;
  }

  const successEvent = timer.finish({ result: "ok", metadata });
  if (successEvent.duration_ms >= slowLogThresholdMs) {
    logger.log(formatPerformanceEvent(successEvent));
  }

  return outcome.value;
}

function buildMetadata(
  documentUri: string | undefined,
  budgetMs: number,
): PerformanceMetadata {
  const metadata: PerformanceMetadata = {
    budget_ms: budgetMs,
  };
  if (documentUri) {
    metadata.document_uri = documentUri;
  }
  return metadata;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}