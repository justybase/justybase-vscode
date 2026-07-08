import type {
    ImportWizardHostToWebviewMessage,
    ImportWizardWebviewToHostMessage,
} from './hostContracts.js';

interface ImportWizardVsCodeApi {
    postMessage(message: ImportWizardWebviewToHostMessage): void;
    setState(state: unknown): void;
    getState(): unknown;
}

const fallbackVsCodeApi: ImportWizardVsCodeApi = {
    postMessage() {},
    setState() {},
    getState() {
        return undefined;
    },
};

export const vscode: ImportWizardVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = (
            globalThis as { acquireVsCodeApi?: () => ImportWizardVsCodeApi }
        ).acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function'
            ? acquireVsCodeApiFn()
            : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postToHost(message: ImportWizardWebviewToHostMessage): void {
    vscode.postMessage(message);
}

export function asHostMessage(message: unknown): ImportWizardHostToWebviewMessage {
    return message as ImportWizardHostToWebviewMessage;
}
