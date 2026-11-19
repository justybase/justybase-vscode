import { ResultsHtmlGenerator } from '../views/resultsHtmlGenerator';

const SHARED_URIS = {
    sharedScriptUri: { toString: () => 'shared-panel.js' } as never,
    sharedGridStyleUri: { toString: () => 'shared-grid.css' } as never,
    fontRegularUri: { toString: () => 'fonts/a.woff2' } as never,
    fontBoldUri: { toString: () => 'fonts/b.woff2' } as never,
    fontMediumUri: { toString: () => 'fonts/c.woff2' } as never,
};

describe('ResultsHtmlGenerator', () => {
    it('emits a shared-only shell', () => {
        const html = new ResultsHtmlGenerator('test-csp').generateHtml(SHARED_URIS);

        expect(html).toContain('id="shared-ui-root"');
        expect(html).toContain('href="shared-grid.css"');
        expect(html).toContain('src="shared-panel.js"');
        expect(html).toContain('body class="shared-ui-mode"');
        expect(html).not.toContain('id="layoutWrapper"');
        expect(html).not.toContain('toolbar-group--search');
        expect(html).not.toContain('id="globalFilter"');
        expect(html).not.toContain('id="rowViewPanel"');
        expect(html).not.toContain('resultPanel.css');
        expect(html).not.toContain('resultPanel.js');
        expect(html).not.toContain('tanstack-table-core');
        expect(html).not.toContain('tanstack-virtual-core');
        expect(html).not.toContain('init();');
        expect(html).not.toContain('__JUSTYBASE_UI_MODE__');
    });

    it('injects the configured results grid font family into the webview', () => {
        const generator = new ResultsHtmlGenerator('test-csp');
        const html = generator.generateHtml(SHARED_URIS, {
            resultGridFontFamily: 'JetBrains Mono, Consolas, monospace'
        });

        expect(html).toContain("document.documentElement.style.setProperty('--justybase-results-grid-font-family'");
        expect(html).toContain('JetBrains Mono, Consolas, monospace');
    });

    it('injects the configured default copy format into the shared shell', () => {
        const generator = new ResultsHtmlGenerator('test-csp');

        expect(generator.generateHtml(SHARED_URIS)).toContain('window.defaultCopyFormat = "markdown";');
        expect(generator.generateHtml(SHARED_URIS, { defaultCopyFormat: 'csv' }))
            .toContain('window.defaultCopyFormat = "csv";');
    });

    it('injects the configured default Excel format for the export menu', () => {
        const generator = new ResultsHtmlGenerator('test-csp');

        expect(generator.generateHtml(SHARED_URIS)).toContain('window.defaultExcelFormat = "xlsb";');
        expect(generator.generateHtml(SHARED_URIS, { defaultExcelFormat: 'xlsx' }))
            .toContain('window.defaultExcelFormat = "xlsx";');
        expect(generator.generateHtml(SHARED_URIS, { defaultExcelFormat: 'xlsx' }))
            .not.toContain('window.defaultExcelFormat = "xlsb";');
    });

    it('keeps the webview CSP strict and loads only the shared assets', () => {
        const html = new ResultsHtmlGenerator('test-csp').generateHtml(SHARED_URIS);

        expect(html).toContain("default-src 'none'");
        expect(html).toContain('script-src test-csp');
        expect(html).toContain('font-src test-csp');
        expect(html.match(/shared-panel\.js/gu)).toHaveLength(1);
        expect(html.match(/shared-grid\.css/gu)).toHaveLength(1);
    });
});
