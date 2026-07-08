import { postHostMessage } from '../protocol.js';
import { getResultPanelWindow } from '../types.js';

const vscode = { postMessage: postHostMessage };
let lastFocusRequestAt = 0;


export function panelGetIsEditMode(): boolean {
    const fn = getResultPanelWindow().getIsEditMode;
    return typeof fn === 'function' ? fn() : false;
}

export function parseDatasetIndex(element: Element): number | null {
    const value = (element as HTMLElement).dataset.index;
    if (value === undefined) {
        return null;
    }
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
}

export function requestResultsViewFocus() {
    if (typeof window.focus === 'function') {
        window.focus();
    }

    const now = Date.now();
    if (now - lastFocusRequestAt < 75) {
        return;
    }

    lastFocusRequestAt = now;
    vscode.postMessage({ command: 'focusView' });
}

export function isInputLikeElement(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        if (typeof HTMLElement === 'undefined' && typeof target === 'object' && target !== null && 'tagName' in target) {
            const mockElement = target as HTMLElement;
            return mockElement.tagName === 'INPUT'
                || mockElement.tagName === 'TEXTAREA'
                || mockElement.tagName === 'SELECT'
                || mockElement.isContentEditable;
        }
        return false;
    }

    return target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable;
}
