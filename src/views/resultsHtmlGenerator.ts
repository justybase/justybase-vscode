import * as vscode from "vscode";

export interface ViewScriptUris {
  /** Shared React Result Panel entry. The legacy DOM renderer is not shipped. */
  sharedScriptUri: vscode.Uri;
  /** Shared React Result Grid skin, emitted with the webview bundles. */
  sharedGridStyleUri: vscode.Uri;
  fontRegularUri: vscode.Uri;
  fontBoldUri: vscode.Uri;
  fontMediumUri: vscode.Uri;
}

export interface ResultsHtmlOptions {
  resultGridFontFamily?: string;
  resultGridFontSize?: number;
  defaultCopyFormat?: string;
  /** Default Excel format for the Export menu: `xlsb` (binary, faster) or `xlsx`. */
  defaultExcelFormat?: 'xlsb' | 'xlsx';
}

const DEFAULT_RESULTS_GRID_FONT_FAMILY = "'JetBrains Mono', monospace";

/**
 * Webview shell for the shared Result Panel. The shell is intentionally small:
 * React owns the tabs, toolbar, grid and analysis surfaces, so the HTML only
 * provides the mount point, fonts, theme variables and postMessage bootstrap.
 */
export class ResultsHtmlGenerator {
  private _cspSource: string;

  constructor(cspSource: string) {
    this._cspSource = cspSource;
  }

  public generateHtml(
    uris: ViewScriptUris,
    options: ResultsHtmlOptions = {},
  ): string {
    const resultGridFontFamily = JSON.stringify(
      options.resultGridFontFamily || DEFAULT_RESULTS_GRID_FONT_FAMILY,
    );
    const resultGridFontSize = options.resultGridFontSize || 12;
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${this._cspSource} 'unsafe-inline'; worker-src ${this._cspSource} blob:; connect-src ${this._cspSource}; style-src ${this._cspSource} 'unsafe-inline'; font-src ${this._cspSource};">
            <title>Query Results</title>
            <link rel="preload" as="font" crossorigin href="${uris.fontRegularUri}">
            <link rel="preload" as="font" crossorigin href="${uris.fontMediumUri}">
            <link rel="preload" as="font" crossorigin href="${uris.fontBoldUri}">
            <style>
                @font-face {
                    font-family: 'JetBrains Mono';
                    src: url('${uris.fontRegularUri}') format('woff2');
                    font-weight: 400;
                    font-style: normal;
                }
                @font-face {
                    font-family: 'JetBrains Mono';
                    src: url('${uris.fontMediumUri}') format('woff2');
                    font-weight: 500;
                    font-style: normal;
                }
                @font-face {
                    font-family: 'JetBrains Mono';
                    src: url('${uris.fontBoldUri}') format('woff2');
                    font-weight: 700;
                    font-style: normal;
                }
            </style>
            <link rel="stylesheet" href="${uris.sharedGridStyleUri}">
            <script>
                window.defaultCopyFormat = ${JSON.stringify(options.defaultCopyFormat || 'markdown')};
                window.defaultExcelFormat = ${JSON.stringify(options.defaultExcelFormat === 'xlsx' ? 'xlsx' : 'xlsb')};
                document.documentElement.style.setProperty('--justybase-results-grid-font-family', ${resultGridFontFamily});
                document.documentElement.style.setProperty('--justybase-results-grid-font-size', '${resultGridFontSize}px');
            </script>
        </head>
        <body class="shared-ui-mode">
            <div id="shared-ui-root" aria-live="polite"></div>
            <script src="${uris.sharedScriptUri}"></script>
        </body>
        </html>`;
  }
}
