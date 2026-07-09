import * as vscode from 'vscode';

import { normalizeUriKey } from '../../core/queryRunnerUtils';
import type { ResultPanelView } from '../../views/resultPanelView';

const runningSources = new Set<string>();

function describeSource(sourceUri: string): string {
    if (sourceUri.startsWith('untitled:')) {
        return 'this untitled SQL tab';
    }

    const normalized = sourceUri.replace(/\\/g, '/');
    const filename = normalized.split('/').pop();
    return filename || 'this SQL tab';
}

export function tryAcquireQueryExecution(
    sourceUri: string,
    resultPanelProvider: Pick<ResultPanelView, 'log' | 'getActiveSource'>,
): vscode.Disposable | undefined {
    const key = normalizeUriKey(sourceUri);
    if (runningSources.has(key)) {
        const message = `SQL execution is already running for ${describeSource(sourceUri)}. Ignoring duplicate Run Query.`;
        if (resultPanelProvider.getActiveSource() === sourceUri) {
            resultPanelProvider.log(sourceUri, message);
        }
        void vscode.window.showInformationMessage(message);
        return undefined;
    }

    runningSources.add(key);
    return {
        dispose: () => {
            runningSources.delete(key);
        },
    };
}

export function isQueryExecutionRunning(sourceUri: string): boolean {
    return runningSources.has(normalizeUriKey(sourceUri));
}

export function clearQueryExecutionGateForTests(): void {
    runningSources.clear();
}
