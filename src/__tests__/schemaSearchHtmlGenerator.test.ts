import { SchemaSearchHtmlGenerator } from '../views/schemaSearchHtmlGenerator';

describe('SchemaSearchHtmlGenerator', () => {
    it('should include escapeHtml helper for dynamic content rendering', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain('function escapeHtml(value)');
        expect(html).toContain("replace(/&/g, '&amp;')");
    });

    it('should avoid shadowing the native window.postMessage bridge', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain('function postToHost(message)');
        expect(html).not.toContain('function postMessage(message)');
    });

    it('should use escaped placeholders in dynamic innerHTML templates', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain('${escapeHtml(type)}');
        expect(html).toContain('${safeName}');
        expect(html).toContain('${safeDisplayDesc}');
    });

    it('should default to standard list layout for new sessions', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain("layout: 'standard'");
        expect(html).toContain("state.layout || 'standard'");
        expect(html).toContain('<option value="standard" selected>Standard List</option>');
    });

    it('should format qualified paths as database then schema', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain('function formatQualifiedPath(item)');
        expect(html).toContain("return db + '.' + schema");
        expect(html).toContain('formatQualifiedPath(item)');
        expect(html).not.toContain('${safeSchema}.${safeDatabase}');
    });

    it('should use explicit empty states and preserve partial results on cancel', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain('function showInitialEmptyState()');
        expect(html).toContain('function showNoResultsEmptyState()');
        expect(html).toContain('Search cancelled — ');
        expect(html).toContain('if (allResults.length > 0)');
    });

    it('should validate minimum search term length before posting to host', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain('term.length < 2');
        expect(html).toContain('Search term must be at least 2 characters.');
    });

    it('should support keyboard navigation on standard list rows', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain('function attachResultRowKeyboard(row, item)');
        expect(html).toContain("e.key === 'Enter'");
        expect(html).toContain("e.key === ' '");
        expect(html).toContain('navigateToItem(item)');
        expect(html).not.toContain('requestPreview');
        expect(html).toContain('role="listbox"');
        expect(html).toContain("setAttribute('role', 'option')");
    });

    it('should order result groups tables, views, columns, then other types', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain('function compareObjectTypesByPriority(typeA, typeB)');
        expect(html).toContain("if (category === 'table') return 1");
        expect(html).toContain("if (category === 'view') return 2");
        expect(html).toContain("if (category === 'column') return 3");
        expect(html).toContain('Object.keys(groups).sort(compareObjectTypesByPriority)');
    });

    it('should theme facet and option dropdowns with VS Code variables', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain('color-scheme: light dark');
        expect(html).toContain('var(--vscode-dropdown-background, var(--vscode-input-background))');
        expect(html).toContain('.facet-row select');
        expect(html).toContain('select option');
    });

    it('should compute facets from merged results and support recent objects', () => {
        const html = new SchemaSearchHtmlGenerator('test-session-id').generateHtml();

        expect(html).toContain('function collectFacetsFromResults(results)');
        expect(html).toContain("type: 'requestRecents'");
        expect(html).toContain("case 'recents':");
        expect(html).toContain('recentResults');
    });
});
