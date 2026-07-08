import type {
    ResultPanelHostToWebviewMessage,
    ResultPanelWebviewToHostMessage,
} from './hostContracts.js';

interface ResultPanelVsCodeApi {
    postMessage(message: ResultPanelWebviewToHostMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
}

const fallbackVsCodeApi: ResultPanelVsCodeApi = {
    postMessage() {},
    getState() {
        return undefined;
    },
    setState() {},
};

const vscodeApi: ResultPanelVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = (globalThis as { acquireVsCodeApi?: () => ResultPanelVsCodeApi })
            .acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function' ? acquireVsCodeApiFn() : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postHostMessage(message: ResultPanelWebviewToHostMessage): void {
    vscodeApi.postMessage(message);
}

export function getHostState(): unknown {
    return vscodeApi.getState();
}

export function setHostState(state: unknown): void {
    vscodeApi.setState(state);
}

export function asHostMessage(message: unknown): ResultPanelHostToWebviewMessage {
    return message as ResultPanelHostToWebviewMessage;
}
