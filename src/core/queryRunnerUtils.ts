/**
 * Query Runner Utilities
 * Pure utility functions extracted from queryRunner.ts for better testability and reusability.
 * These functions have no side effects and can be unit tested independently.
 */

import * as vscode from "vscode";
import { ConnectionManager } from "./connectionManager";
export { normalizeUriKey } from "./uriUtils";

/**
 * Output logger configuration for query execution logging.
 */
export interface OutputLogger {
  outputChannel?: vscode.OutputChannel;
  logCallback?: (msg: string) => void;
}

// Shared output channel instance (module-level state)
let sharedOutputChannel: vscode.OutputChannel | undefined;

/**
 * Get or create the shared output channel for Netezza SQL queries.
 * Creates the channel on first access and reuses it for subsequent calls.
 */
export function getOutputChannel(): vscode.OutputChannel {
  if (!sharedOutputChannel) {
    sharedOutputChannel = vscode.window.createOutputChannel("Netezza SQL");
  }
  return sharedOutputChannel;
}

/**
 * Dispose the shared output channel and clear the reference.
 * Safe to call multiple times.
 */
export function disposeSharedOutputChannel(): void {
  if (sharedOutputChannel) {
    try {
      sharedOutputChannel.dispose();
    } catch {
      // ignore disposal errors
    }
    sharedOutputChannel = undefined;
  }
}

/**
 * Ensure the shared output channel exists and return it.
 * Useful for tests to verify channel creation.
 */
export function ensureSharedOutputChannel(): vscode.OutputChannel {
  return getOutputChannel();
}

/**
 * Create an output logger configuration based on silent mode and callback.
 * - If not silent and no callback: creates/shows output channel
 * - If silent: no output channel
 * - If callback provided: uses callback instead of channel
 */
export function createLogger(
  silent: boolean,
  logCallback?: (msg: string) => void,
): OutputLogger {
  let outputChannel: vscode.OutputChannel | undefined;
  if (!silent && !logCallback) {
    outputChannel = getOutputChannel();
    outputChannel.show(true);
  }
  return { outputChannel, logCallback };
}

/**
 * Log a message to the configured output destination(s).
 * Supports both output channel and callback logging.
 */
export function logOutput(logger: OutputLogger, message: string): void {
  if (logger.outputChannel) {
    logger.outputChannel.appendLine(message);
  }
  if (logger.logCallback) {
    logger.logCallback(message);
  }
}

/**
 * Check if an error indicates a broken/closed connection that should trigger retry.
 * Detects common network/socket errors that occur when a connection is terminated.
 */
export function isConnectionBrokenError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("socket closed") ||
    msg.includes("socket destroyed") ||
    msg.includes("connection reset") ||
    msg.includes("connection closed") ||
    msg.includes("econnreset") ||
    msg.includes("epipe") ||
    msg.includes("broken pipe")
  );
}

/**
 * Connection resolver options for resolveConnectionName.
 */
export interface ConnectionResolverOptions {
  connectionName?: string;
  documentUri?: string;
}

/**
 * Resolve the connection name from various sources.
 * Priority: explicit name > document-specific > active connection.
 * Throws if no connection can be resolved.
 */
export function resolveConnectionName(
  connManager: ConnectionManager,
  options: ConnectionResolverOptions,
): string {
  let resolvedConnectionName = options.connectionName;

  if (!resolvedConnectionName && options.documentUri) {
    resolvedConnectionName = connManager.getConnectionForExecution(
      options.documentUri,
    );
  }
  if (!resolvedConnectionName) {
    resolvedConnectionName = connManager.getActiveConnectionName() || undefined;
  }

  if (!resolvedConnectionName) {
    throw new Error("No connection selected");
  }

  return resolvedConnectionName;
}

/**
 * Check if an error message indicates a busy connection.
 * Used to provide user-friendly error handling with recovery options.
 */
export function isBusyConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("Connection is already executing a command");
}
