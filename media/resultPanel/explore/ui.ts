/** Small DOM helpers: user values are always text, never markup. */
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
export function button(text: string, action: () => void): HTMLButtonElement {
    const node = element('button', text, 'explore-secondary-btn');
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
}
export function field(text: string, control: HTMLElement): HTMLLabelElement {
    control.setAttribute('aria-label', text);
    const label = element('label', undefined, 'explore-config-field');
    label.append(element('span', text), control);
    return label;
}
export function select(options: readonly [string, string][], value?: string): HTMLSelectElement {
    const control = element('select');
    for (const [id, text] of options) {
        const option = element('option', text);
        option.value = id;
        control.append(option);
    }
    if (value !== undefined) control.value = value;
    return control;
}
export function valueLabel(value: unknown): string {
    return value == null ? 'NULL' : value === '' ? '(Empty string)' : String(value);
}

/** Keep local inspection available when a result cannot be queried again. */
export function applyDatabaseAvailability(root: ParentNode, reason?: string): void {
    if (!reason) return;
    for (const control of root.querySelectorAll('button')) {
        if (/^(Run|Run Pivot|Σ Full stats|Search database|Load rows|SQL…|Open SQL)$/.test(control.textContent ?? '')) {
            control.disabled = true;
            control.title = reason;
        }
    }
}
