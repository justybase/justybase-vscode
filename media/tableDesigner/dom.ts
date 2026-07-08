export function getElementById<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

export function eventTargetAsInput(event: Event): HTMLInputElement | null {
    const target = event.target;
    return target instanceof HTMLInputElement ? target : null;
}

export function eventTargetAsHtmlElement(event: Event): HTMLElement | null {
    const target = event.target;
    return target instanceof HTMLElement ? target : null;
}
