/** Escapes text for both element content and quoted attribute values. */
export function escapeHtml(text: string | null | undefined): string {
    if (!text) {
        return '';
    }
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function formatCount(value: number): string {
    return value.toLocaleString('en-US').replace(/,/g, ' ');
}
