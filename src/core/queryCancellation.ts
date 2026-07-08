import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { StreamingManager } from "./streaming";

// Shared StreamingManager instance for handling query streaming
// All query execution and cancellation goes through this manager
export const streamingManager = new StreamingManager();

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
                await cmd.cancel();
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
                await cmd.cancel();
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
                await cmd.cancel();
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.error(`[cancelAllRunningQueries] Failed to cancel ${uriStr}: ${msg}`);
            }
        }
    });

    await Promise.allSettled(cancelPromises);
    logger.info("[cancelAllRunningQueries] All active queries cancelled.");
}
