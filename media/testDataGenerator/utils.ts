export function escapeHtml(text: string | null | undefined): string {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function quoteIdentifier(name: string): string {
    if (!name) return name;
    const isSimpleIdentifier = /^[A-Z_][A-Z0-9_]*$/i.test(name) && name === name.toUpperCase();
    if (isSimpleIdentifier) {
        return name;
    }
    return `"${name.replace(/"/g, '""')}"`;
}
