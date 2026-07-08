import { ResultsHtmlGenerator } from '../views/resultsHtmlGenerator';

describe('ResultsHtmlGenerator', () => {
    it('includes row view and value viewer surfaces in the result panel HTML', () => {
        const generator = new ResultsHtmlGenerator('test-csp');
        const html = generator.generateHtml({
            scriptUri: { toString: () => 'script.js' } as never,
            virtualUri: { toString: () => 'virtual.js' } as never,
            mainScriptUri: { toString: () => 'main.js' } as never,
            styleUri: { toString: () => 'style.css' } as never,
            workerUri: { toString: () => 'worker.js' } as never,
            fontRegularUri: { toString: () => 'fonts/JetBrainsMono-Regular.woff2' } as never,
            fontBoldUri: { toString: () => 'fonts/JetBrainsMono-Bold.woff2' } as never,
            fontMediumUri: { toString: () => 'fonts/JetBrainsMono-Medium.woff2' } as never,
        });

        expect(html).toContain('id="rowViewPanel"');
        expect(html).toContain('id="rowViewBtn"');
        expect(html).toContain('Select 1 to 10 rows to view details or compare');
        expect(html).not.toContain('data-action="row-view"');
        expect(html).toContain('id="valueViewerOverlay"');
        expect(html).toContain('id="valueViewerBody"');
        expect(html).toContain('Copy Value');
    });

    it('does not acquire the VS Code API in the inline bootstrap script', () => {
        const generator = new ResultsHtmlGenerator('test-csp');
        const html = generator.generateHtml({
            scriptUri: { toString: () => 'script.js' } as never,
            virtualUri: { toString: () => 'virtual.js' } as never,
            mainScriptUri: { toString: () => 'main.js' } as never,
            styleUri: { toString: () => 'style.css' } as never,
            workerUri: { toString: () => 'worker.js' } as never,
            fontRegularUri: { toString: () => 'fonts/JetBrainsMono-Regular.woff2' } as never,
            fontBoldUri: { toString: () => 'fonts/JetBrainsMono-Bold.woff2' } as never,
            fontMediumUri: { toString: () => 'fonts/JetBrainsMono-Medium.woff2' } as never,
        });

        expect(html).not.toContain('const vscode = acquireVsCodeApi();');
        expect(html).toContain('const workerUri = "worker.js";');
        expect(html).toContain('init();');
    });

    it('injects the configured results grid font family into the webview', () => {
        const generator = new ResultsHtmlGenerator('test-csp');
        const html = generator.generateHtml({
            scriptUri: { toString: () => 'script.js' } as never,
            virtualUri: { toString: () => 'virtual.js' } as never,
            mainScriptUri: { toString: () => 'main.js' } as never,
            styleUri: { toString: () => 'style.css' } as never,
            workerUri: { toString: () => 'worker.js' } as never,
            fontRegularUri: { toString: () => 'fonts/JetBrainsMono-Regular.woff2' } as never,
            fontBoldUri: { toString: () => 'fonts/JetBrainsMono-Bold.woff2' } as never,
            fontMediumUri: { toString: () => 'fonts/JetBrainsMono-Medium.woff2' } as never,
        }, {
            resultGridFontFamily: 'JetBrains Mono, Consolas, monospace'
        });

        expect(html).toContain("document.documentElement.style.setProperty('--justybase-results-grid-font-family'");
        expect(html).toContain('JetBrains Mono, Consolas, monospace');
    });

    it('uses host-managed copy and keeps export actions in split button', () => {
        const generator = new ResultsHtmlGenerator('test-csp');
        const html = generator.generateHtml({
            scriptUri: { toString: () => 'script.js' } as never,
            virtualUri: { toString: () => 'virtual.js' } as never,
            mainScriptUri: { toString: () => 'main.js' } as never,
            styleUri: { toString: () => 'style.css' } as never,
            workerUri: { toString: () => 'worker.js' } as never,
            fontRegularUri: { toString: () => 'fonts/JetBrainsMono-Regular.woff2' } as never,
            fontBoldUri: { toString: () => 'fonts/JetBrainsMono-Bold.woff2' } as never,
            fontMediumUri: { toString: () => 'fonts/JetBrainsMono-Medium.woff2' } as never,
        });

        expect(html).toContain('window.justybaseUseHostCopyShortcut = true;');

        const exportAllIndex = html.indexOf('Export All to Excel');
        const exportSplitMenu = html.indexOf('exportSplitMenu');

        expect(exportAllIndex).toBeGreaterThan(-1);
        expect(exportSplitMenu).toBeGreaterThan(-1);
        expect(html).toContain('split-btn__menu-item');
    });
});
