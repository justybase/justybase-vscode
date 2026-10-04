import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../../core/connectionManager';
import { createMacroFileReadContext, resolveBatchVariables } from '../../core/queryBatchExecutor';
import type { MacroPreprocessorContext } from '../../core/macroTypes';
import type { BatchQueryRunOptions } from '../../core/queryBatchExecutor';

/** Compare captured profiles without retaining serialized credentials in queued closures. */
export function executionTargetFingerprint(profile: unknown): string {
    return createHash('sha256').update(JSON.stringify(profile) ?? 'undefined').digest('hex');
}

/** Freeze interactive inputs and include files without running database/Python/export macros. */
export async function prepareQueuedQuery(
    queries: string[],
    context: vscode.ExtensionContext,
    sourceUri: string,
    manager: ConnectionManager,
    connectionName: string | undefined,
    databaseOverride: string | undefined,
    profile: string | undefined,
    signal?: AbortSignal,
): Promise<BatchQueryRunOptions> {
    if (signal?.aborted) throw new Error('Query preparation cancelled');
    const fileContext = createMacroFileReadContext(sourceUri);
    const files = new Map<string, Promise<{ path: string; content: string }>>();
    let sealed = false;
    const macroFileContext: MacroPreprocessorContext = {
        sourceName: fileContext.sourceName,
        readFile: (path, fromSource) => {
            const key = JSON.stringify([path, fromSource]);
            let file = files.get(key);
            if (!file) {
                if (sealed) return Promise.reject(new Error('Macro include was not captured at submission. Submit this query again.'));
                file = fileContext.readFile!(path, fromSource);
                files.set(key, file);
            }
            return file;
        },
    };
    const preparedVariables = Object.freeze(await resolveBatchVariables(queries, context, sourceUri, macroFileContext, signal));
    sealed = true;
    return {
        preparedVariables,
        macroFileContext,
        connectionName,
        validateExecutionTarget: async () => {
            const currentName = manager.getConnectionForExecution(sourceUri) || manager.getActiveConnectionName();
            if (!connectionName || currentName !== connectionName
                || manager.getDocumentDatabase(sourceUri) !== databaseOverride
                || executionTargetFingerprint(await manager.getConnection(connectionName)) !== profile) {
                throw new Error('Queued query target changed or is unavailable. Restore its connection/database or remove it and submit again.');
            }
        },
    };
}
