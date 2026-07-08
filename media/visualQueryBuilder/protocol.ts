import type {
    VisualQueryBuilderHostToWebviewMessage,
    VisualQueryBuilderWebviewToHostMessage,
} from './hostContracts.js';

interface VisualQueryBuilderVsCodeApi {
    postMessage(message: VisualQueryBuilderWebviewToHostMessage): void;
    setState(state: unknown): void;
    getState(): unknown;
}

const fallbackVsCodeApi: VisualQueryBuilderVsCodeApi = {
    postMessage() {},
    setState() {},
    getState() {
        return undefined;
    },
};

export const vscode: VisualQueryBuilderVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = (
            globalThis as { acquireVsCodeApi?: () => VisualQueryBuilderVsCodeApi }
        ).acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function'
            ? acquireVsCodeApiFn()
            : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postToHost(message: VisualQueryBuilderWebviewToHostMessage): void {
    vscode.postMessage(message);
}

export function asHostMessage(message: unknown): VisualQueryBuilderHostToWebviewMessage {
    return message as VisualQueryBuilderHostToWebviewMessage;
}
