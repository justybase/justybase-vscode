// Small DOM builder for the Analytical view. Result values always go through textContent,
// never innerHTML, so cell data cannot inject markup into the webview.

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

export function formatPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

export function formatStatNumber(value: number): string {
    if (!Number.isFinite(value)) {
        return String(value);
    }
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e6 || abs < 0.01)) {
        return value.toExponential(2);
    }
    return Number(value.toFixed(2)).toLocaleString('en-US');
}
