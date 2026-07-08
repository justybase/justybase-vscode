/**
 * Typed DOM helpers for the result panel webview.
 * Prefer these over repeated `as HTMLElement` casts at call sites.
 */

export function asHtml(
    node: Element | EventTarget | null | undefined,
): HTMLElement | null {
    if (!node) {
        return null;
    }
    if (typeof HTMLElement !== 'undefined' && node instanceof HTMLElement) {
        return node;
    }
    // Jest/jsdom mocks may provide plain objects with HTMLElement-like APIs.
    if (typeof node === 'object' && 'classList' in node && 'style' in node) {
        return node as HTMLElement;
    }
    return null;
}

/** @deprecated Use `asHtml` — kept for incremental migration. */
export const asHTMLElement = asHtml;

export function getElementById<T extends HTMLElement = HTMLElement>(
    id: string,
): T | null {
    return document.getElementById(id) as T | null;
}

export function queryHtml(
    root: ParentNode,
    selector: string,
): HTMLElement | null {
    return asHtml(root.querySelector(selector));
}

export function queryHtmlAll(
    root: ParentNode,
    selector: string,
): HTMLElement[] {
    return Array.from(root.querySelectorAll(selector))
        .map((node) => asHtml(node))
        .filter((node): node is HTMLElement => node !== null);
}

export function eventTargetAsHtml(event: Event): HTMLElement | null {
    return asHtml(event.target);
}
