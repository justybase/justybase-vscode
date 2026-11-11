import type { SnippetDto } from './hostContracts.js';

export function snippetPreview(sql: string): string {
    const compact = sql.replace(/\s+/g, ' ').trim();
    return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
}

export function parseTags(tags: string): string[] {
    return tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
}

export function filterSnippets(snippets: SnippetDto[], search: string): SnippetDto[] {
    const term = search.trim().toLowerCase();
    if (!term) {
        return [...snippets];
    }
    return snippets.filter((snippet) =>
        snippet.name.toLowerCase().includes(term)
        || snippet.tags.toLowerCase().includes(term)
        || snippet.sql.toLowerCase().includes(term),
    );
}

export function formatUpdatedAt(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString();
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
