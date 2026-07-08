export function asHtml(
    node: Element | EventTarget | null | undefined,
): HTMLElement | null {
    if (!node) {
        return null;
    }
    if (typeof HTMLElement !== 'undefined' && node instanceof HTMLElement) {
        return node;
    }
    if (typeof node === 'object' && 'classList' in node && 'style' in node) {
        return node as HTMLElement;
    }
    return null;
}

export function getElementById<T extends HTMLElement = HTMLElement>(
    id: string,
): T | null {
    return document.getElementById(id) as T | null;
}

export function eventTargetAsInput(event: Event): HTMLInputElement | null {
    const el = asHtml(event.target);
    return el instanceof HTMLInputElement ? el : null;
}

export function eventTargetAsSelect(event: Event): HTMLSelectElement | null {
    const el = asHtml(event.target);
    return el instanceof HTMLSelectElement ? el : null;
}
