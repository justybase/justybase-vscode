import type {
    EditDataPanelHostToWebviewMessage,
    EditDataPanelWebviewToHostMessage,
} from './hostContracts.js';

interface EditDataPanelVsCodeApi {
    postMessage(message: EditDataPanelWebviewToHostMessage): void;
    setState(state: unknown): void;
    getState(): unknown;
}

const fallbackVsCodeApi: EditDataPanelVsCodeApi = {
    postMessage() {},
    setState() {},
    getState() {
        return undefined;
    },
};

export const vscode: EditDataPanelVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = (
            globalThis as { acquireVsCodeApi?: () => EditDataPanelVsCodeApi }
        ).acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function'
            ? acquireVsCodeApiFn()
            : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postToHost(message: EditDataPanelWebviewToHostMessage): void {
    vscode.postMessage(message);
}

export function asHostMessage(message: unknown): EditDataPanelHostToWebviewMessage {
    return message as EditDataPanelHostToWebviewMessage;
}
