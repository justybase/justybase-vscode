export function getElementById<T extends HTMLElement = HTMLElement>(
    id: string,
): T | null {
    return document.getElementById(id) as T | null;
}
