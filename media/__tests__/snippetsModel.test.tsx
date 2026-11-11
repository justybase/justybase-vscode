import type { SnippetDto } from '../snippets/hostContracts';
import {
    escapeHtml,
    filterSnippets,
    formatUpdatedAt,
    parseTags,
    snippetPreview,
} from '../snippets/model';

const snippets: SnippetDto[] = [
    {
        id: '1',
        name: 'Monthly totals',
        tags: 'report, monthly',
        sql: 'SELECT * FROM DIMDATE;',
        updatedAt: 1,
    },
    {
        id: '2',
        name: 'Users',
        tags: 'admin',
        sql: 'SELECT * FROM USERS;',
        updatedAt: 2,
    },
];

describe('snippets model', () => {
    it('filters by name, tags, and SQL text', () => {
        expect(filterSnippets(snippets, 'monthly').map((snippet) => snippet.id)).toEqual(['1']);
        expect(filterSnippets(snippets, 'admin').map((snippet) => snippet.id)).toEqual(['2']);
        expect(filterSnippets(snippets, 'DIMDATE').map((snippet) => snippet.id)).toEqual(['1']);
        expect(filterSnippets(snippets, '').map((snippet) => snippet.id)).toEqual(['1', '2']);
    });

    it('returns an empty list when nothing matches', () => {
        expect(filterSnippets(snippets, 'missing')).toEqual([]);
    });

    it('parses comma-separated tags and trims empty entries', () => {
        expect(parseTags('report, monthly,,')).toEqual(['report', 'monthly']);
    });

    it('shortens long SQL previews', () => {
        const longSql = 'SELECT '.repeat(50);
        expect(snippetPreview(longSql).length).toBeLessThanOrEqual(160);
        expect(snippetPreview('SELECT 1;')).toBe('SELECT 1;');
    });

    it('escapes HTML-sensitive characters', () => {
        expect(escapeHtml('<b>"x" & \'y\'</b>')).toBe(
            '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;',
        );
    });

    it('formats the updated timestamp', () => {
        expect(formatUpdatedAt(Date.UTC(2026, 0, 15))).toMatch(/2026/);
    });
});
