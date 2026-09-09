import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { StreamingManager } from "./streaming";
import { cancelCommandAndCloseReader } from './cancellation';

// The exported object is a compatibility facade. Its mutable command and
// abort maps live in the activation-owned StreamingManager instance selected
// below, so separate activations/tests can use isolated managers.
let defaultStreamingManager = new StreamingManager();

export function createStreamingManager(): StreamingManager {
    return new StreamingManager();
}

export function setDefaultStreamingManager(manager: StreamingManager): void {
    const previous = defaultStreamingManager;
    defaultStreamingManager = manager;
    void previous.dispose().catch(error => {
        Logger.getInstance().warn(`[queryCancellation] Previous streaming manager disposal failed: ${error instanceof Error ? error.message : String(error)}`, error);
    });
}

export async function disposeDefaultStreamingManager(): Promise<void> {
    await defaultStreamingManager.dispose();
}

class StreamingManagerFacade {
    public registerCommand(...args: Parameters<StreamingManager['registerCommand']>): ReturnType<StreamingManager['registerCommand']> {
        return defaultStreamingManager.registerCommand(...args);
    }

    public unregisterCommand(...args: Parameters<StreamingManager['unregisterCommand']>): ReturnType<StreamingManager['unregisterCommand']> {
        return defaultStreamingManager.unregisterCommand(...args);
    }

    public abortQuery(...args: Parameters<StreamingManager['abortQuery']>): ReturnType<StreamingManager['abortQuery']> {
        return defaultStreamingManager.abortQuery(...args);
    }

    public isAborted(...args: Parameters<StreamingManager['isAborted']>): ReturnType<StreamingManager['isAborted']> {
        return defaultStreamingManager.isAborted(...args);
    }

    public clearAborted(...args: Parameters<StreamingManager['clearAborted']>): ReturnType<StreamingManager['clearAborted']> {
        return defaultStreamingManager.clearAborted(...args);
    }

    public isActive(...args: Parameters<StreamingManager['isActive']>): ReturnType<StreamingManager['isActive']> {
        return defaultStreamingManager.isActive(...args);
    }

    public getCommand(...args: Parameters<StreamingManager['getCommand']>): ReturnType<StreamingManager['getCommand']> {
        return defaultStreamingManager.getCommand(...args);
    }

    public getSignal(...args: Parameters<StreamingManager['getSignal']>): ReturnType<StreamingManager['getSignal']> {
        return defaultStreamingManager.getSignal(...args);
    }

    public getActiveUris(...args: Parameters<StreamingManager['getActiveUris']>): ReturnType<StreamingManager['getActiveUris']> {
        return defaultStreamingManager.getActiveUris(...args);
    }

    public consumeRestAndCancel(...args: Parameters<StreamingManager['consumeRestAndCancel']>): ReturnType<StreamingManager['consumeRestAndCancel']> {
        return defaultStreamingManager.consumeRestAndCancel(...args);
    }

    public executeAndFetch(...args: Parameters<StreamingManager['executeAndFetch']>): ReturnType<StreamingManager['executeAndFetch']> {
        return defaultStreamingManager.executeAndFetch(...args);
    }

    public executeWithStreaming(...args: Parameters<StreamingManager['executeWithStreaming']>): ReturnType<StreamingManager['executeWithStreaming']> {
        return defaultStreamingManager.executeWithStreaming(...args);
    }

    public dispose(): Promise<void> {
        return defaultStreamingManager.dispose();
    }
}

export const streamingManager = new StreamingManagerFacade();

// ---------------------------------------------------------------------------
// Cancel functions
// ---------------------------------------------------------------------------

export async function cancelCurrentQuery(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage("No active editor to cancel query for.");
        return;
    }

    if (!editor.document) {
        vscode.window.showWarningMessage("No active document to cancel query for.");
        return;
    }

    const docUri = editor.document.uri.toString();
    streamingManager.abortQuery(docUri);
    const isActive = streamingManager.isActive(docUri);

    if (isActive) {
        const cmd = streamingManager.getCommand(docUri);
        if (cmd) {
            try {
                const cleanup = await cancelCommandAndCloseReader(cmd, undefined, { timeoutMs: 5000 });
                if (cleanup.cancelError) {
                    throw cleanup.cancelError;
                }
                vscode.window.showInformationMessage("Cancellation request sent.");
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Failed to cancel query: ${msg}`);
            }
        }
    } else {
        vscode.window.showInformationMessage(
            "Cancellation requested. It will be applied to the next query on this tab.",
        );
    }
}

export async function cancelQueryByUri(
    docUri: string | vscode.Uri,
): Promise<void> {
    const uriStr = typeof docUri === "string" ? docUri : docUri.toString();
    const isActive = streamingManager.isActive(uriStr);
    streamingManager.abortQuery(uriStr);

    const logger = Logger.getInstance();
    logger.debug(`[cancelQueryByUri] Found state for ${uriStr}: ${isActive}`);

    if (isActive) {
        vscode.window.showInformationMessage("Cancellation request sent.");

        const cmd = streamingManager.getCommand(uriStr);
        if (cmd) {
            try {
                logger.debug(
                    `[cancelQueryByUri] Calling cmd.cancel() for ${uriStr}`,
                );
                const cleanup = await cancelCommandAndCloseReader(cmd, undefined, { timeoutMs: 5000 });
                if (cleanup.cancelError) {
                    throw cleanup.cancelError;
                }
                logger.debug(
                    `[cancelQueryByUri] cmd.cancel() completed for ${uriStr}`,
                );
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.error(
                    `[cancelQueryByUri] Failed to cancel: ${msg}`,
                    e instanceof Error ? e : undefined,
                );
                vscode.window.showErrorMessage(`Failed to cancel query: ${msg}`);
            }
        }
    } else {
        vscode.window.showInformationMessage(
            "Cancellation requested. Remaining statements will be skipped.",
        );
        logger.warn(`[cancelQueryByUri] No active command found for ${uriStr}`);
        logger.debug(
            `[cancelQueryByUri] Active URIs: ${streamingManager.getActiveUris().join(", ")}`,
        );
    }
}

export async function cancelAllRunningQueries(): Promise<void> {
    const activeUris = streamingManager.getActiveUris();
    const logger = Logger.getInstance();

    if (activeUris.length === 0) {
        logger.debug("[cancelAllRunningQueries] No active queries to cancel.");
        return;
    }

    logger.info(`[cancelAllRunningQueries] Cancelling ${activeUris.length} active queries...`);

    const cancelPromises = activeUris.map(async (uriStr) => {
        streamingManager.abortQuery(uriStr);
        const cmd = streamingManager.getCommand(uriStr);
        if (cmd) {
            try {
                logger.debug(`[cancelAllRunningQueries] Calling cmd.cancel() for ${uriStr}`);
                const cleanup = await cancelCommandAndCloseReader(cmd, undefined, { timeoutMs: 5000 });
                if (cleanup.cancelError) {
                    throw cleanup.cancelError;
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.error(`[cancelAllRunningQueries] Failed to cancel ${uriStr}: ${msg}`);
            }
        }
    });

    await Promise.allSettled(cancelPromises);
    logger.info("[cancelAllRunningQueries] All active queries cancelled.");
}
