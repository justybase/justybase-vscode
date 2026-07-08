/**
 * Netezza VS Code Extension - Query Runner Facade
 * 
 * This file has been decomposed into smaller, single-responsibility modules:
 * - queryCancellation.ts (StreamingManager and cancel functions)
 * - singleQueryExecutor.ts (runQueryRaw, runQuery, etc.)
 * - batchQueryExecutor.ts (runQueriesSequentially, runQueriesWithStreaming)
 * 
 * This file serves as a facade to maintain backward compatibility for imports.
 */

// Re-export common types
export { QueryResult } from "../types";
export type { StreamingChunk } from "./streaming";

// Re-export utilities used outside of core
export {
  OutputLogger,
  normalizeUriKey,
  isConnectionBrokenError,
  disposeSharedOutputChannel,
  ensureSharedOutputChannel,
  isBusyConnectionError,
} from "./queryRunnerUtils";

// Re-export cancellation functions and shared streaming manager
export {
  streamingManager,
  cancelCurrentQuery,
  cancelQueryByUri,
  cancelAllRunningQueries,
} from "./queryCancellation";

// Re-export single query execution functions
export {
  RunQueryRawOptions,
  isRunQueryRawOptions,
  runQueryRaw,
  executeRawQuery,
  runQuery,
  queryResultToRows,
  runQueryWithCatalog,
  parseQueryJsonResult,
  runExplainQuery,
  resolveConnectionName,
} from "./singleQueryExecutor";

// Re-export batch query execution functions
export {
  runQueriesSequentially,
  runQueriesWithStreaming,
} from "./batchQueryExecutor";
export type { BatchQueryRunOptions } from "./queryBatchExecutor";
