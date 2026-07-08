/** Shared delay before showing the yellow running/retrying banner (avoids flicker on fast queries). */

export const RUNNING_UI_DELAY_MS = 5000;

type RunningUiRefreshListener = () => void;

const listeners = new Set<RunningUiRefreshListener>();

let delayTimer: ReturnType<typeof setTimeout> | null = null;
let trackedSource: string | null = null;
let startedAt = 0;

export function subscribeRunningUiRefresh(listener: RunningUiRefreshListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function notifyRunningUiRefresh(): void {
    listeners.forEach((listener) => {
        listener();
    });
}

export function resetRunningUiDelay(): void {
    if (delayTimer !== null) {
        clearTimeout(delayTimer);
        delayTimer = null;
    }
    trackedSource = null;
    startedAt = 0;
}

export function markRunningUiPending(sourceUri: string): void {
    if (trackedSource !== sourceUri) {
        if (delayTimer !== null) {
            clearTimeout(delayTimer);
            delayTimer = null;
        }
        trackedSource = sourceUri;
        startedAt = Date.now();
    }
}

export function scheduleRunningUiRefresh(): void {
    if (delayTimer !== null) {
        return;
    }
    const remaining = RUNNING_UI_DELAY_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
        return;
    }
    delayTimer = setTimeout(() => {
        delayTimer = null;
        notifyRunningUiRefresh();
    }, remaining);
}

export function shouldDeferRunningUi(): boolean {
    return Date.now() - startedAt < RUNNING_UI_DELAY_MS;
}
