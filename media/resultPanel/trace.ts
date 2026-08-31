import { postHostMessage } from './protocol.js';
import type { ResultPanelTraceEventPayload } from './hostContracts.js';

let traceEnabled = false;
let traceSequence = 0;

export function configureResultPanelTrace(enabled: boolean): void {
    traceEnabled = enabled;
    if (!enabled) {
        traceSequence = 0;
    }
}

export function isResultPanelTraceEnabled(): boolean {
    return traceEnabled;
}

export function traceResultPanel(event: ResultPanelTraceEventPayload): void {
    if (!traceEnabled) {
        return;
    }

    // Errors from provider/driver messages can contain SQL or returned values.
    // The trace contract is intentionally metadata-only, even in console
    // diagnostics; the host-side artifact writer applies a second allow-list.
    const safeEvent = { ...event };
    delete safeEvent.error;
    const payload = {
        ...safeEvent,
        webviewSeq: ++traceSequence,
    } satisfies ResultPanelTraceEventPayload;
    console.debug(`[ResultPanelTrace] ${JSON.stringify(payload)}`);
    postHostMessage({ command: 'reportResultPanelTrace', event: payload });
}
