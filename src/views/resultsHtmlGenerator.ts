import * as vscode from "vscode";

export interface ViewScriptUris {
  scriptUri: vscode.Uri;
  virtualUri: vscode.Uri;
  mainScriptUri: vscode.Uri;
  styleUri: vscode.Uri;
  workerUri: vscode.Uri;
  fontRegularUri: vscode.Uri;
  fontBoldUri: vscode.Uri;
  fontMediumUri: vscode.Uri;
}

export interface ResultsHtmlOptions {
  resultGridFontFamily?: string;
  resultGridFontSize?: number;
  defaultCopyFormat?: string;
}

const DEFAULT_RESULTS_GRID_FONT_FAMILY =
  "'JetBrains Mono', monospace";

export class ResultsHtmlGenerator {
  private _cspSource: string;

  constructor(cspSource: string) {
    this._cspSource = cspSource;
  }

  public generateHtml(
    uris: ViewScriptUris,
    options: ResultsHtmlOptions = {},
  ): string {
    const icons = this._getIcons();
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
            <link rel="stylesheet" href="${uris.styleUri}">
            <script src="${uris.scriptUri}"></script>
            <script src="${uris.virtualUri}"></script>
            <script>
                document.documentElement.style.setProperty('--justybase-results-grid-font-family', ${resultGridFontFamily});
                document.documentElement.style.setProperty('--justybase-results-grid-font-size', '${resultGridFontSize}px');
            </script>
        </head>
        <body>
            <div class="result-set-header" id="resultSetHeader">
                <div id="resultSetTabs" class="result-set-tabs" style="display: none;"></div>
                <span id="docIndicator" class="doc-indicator"></span>
            </div>
            <div id="executionStatusBanner" class="execution-status-banner" style="display: none;">
                <span id="executionStatusBannerText" class="execution-status-banner__text"></span>
                <button type="button" id="executionStatusBannerCancel" class="execution-status-banner__cancel" title="Cancel the current query" style="display: none;">Cancel</button>
            </div>
            <div id="resultLimitBanner" class="result-limit-banner" style="display: none;" role="status" aria-live="polite"></div>
            

            <div id="loadingOverlay" class="loading-overlay">
                <div class="loading-card">
                    <div class="loading-spinner">
                        <svg class="loading-spinner-circle" viewBox="0 0 50 50">
                            <circle class="loading-spinner-path" cx="25" cy="25" r="20" fill="none" stroke-width="4"/>
                        </svg>
                    </div>
                    <div class="loading-text">Generating data…</div>
                    <div class="loading-subtext" id="loadingSubtext"></div>
                    <div class="loading-actions">
                        <button type="button" id="hideLoadingOverlayBtn" class="loading-hide-btn" title="Hide overlay and keep the status bar">Hide</button>
                        <button type="button" id="cancelQueryBtn" class="loading-cancel-btn" title="Cancel the current query">Cancel</button>
                    </div>
                </div>
            </div>
            <div class="layout-wrapper" id="layoutWrapper">
                    <div class="controls">
                        <div class="layout-switcher" id="layoutSwitcher" role="radiogroup" aria-label="Result layout">
                            <button type="button" class="layout-switcher__btn active" data-layout="table" aria-pressed="true" title="Standard table layout">Table</button>
                            <button type="button" class="layout-switcher__btn" data-layout="table2" aria-pressed="false" title="Sidebar layout with schema and grouping">Table2</button>
                            <button type="button" class="layout-switcher__btn" data-layout="charts" aria-pressed="false" title="Professional range charts (ECharts)">Charts</button>
                        </div>
                        <input type="text" id="globalFilter" class="global-filter-input" placeholder="Filter rows..." onkeyup="onFilterChanged()" aria-label="Filter rows">
                        <div class="column-search-group">
                            <div class="column-search-wrapper">
                                <input type="text" id="columnSearch" class="column-search-input" placeholder="Find column..." autocomplete="off" oninput="onColumnSearchChanged()" onkeydown="onColumnSearchKeydown(event)" onblur="onColumnSearchBlur()" onfocus="onColumnSearchFocus()" aria-label="Find column">
                                <div id="columnSearchDropdown" class="column-search-dropdown" style="display: none;"></div>
                            </div>
                            <button type="button" class="btn btn-icon refresh-sql-btn" onclick="refreshActiveResult()" title="Re-run SQL for the active result set in the same source session" id="refreshResultBtn" aria-label="Refresh SQL">${icons.refresh}</button>
                            <button type="button" class="btn btn-icon clear-filters-btn" onclick="clearAllFilters()" title="Remove all filters and aggregations" id="clearFiltersBtn" aria-label="Clear filters and aggregations">${icons.clear}</button>
                        </div>
                        <div class="split-btn" id="exportSplitBtn">
                            <button class="btn split-btn__primary" onclick="toggleExportPrimaryMenu(event)" title="Export results" aria-haspopup="menu" aria-expanded="false" aria-controls="exportPrimaryMenu">${icons.export} Export</button>
                            <button class="btn split-btn__arrow" onclick="toggleExportSplitMenu(event)" title="More export options" aria-label="More export options">▾</button>
                            <div class="split-btn__menu export-primary-menu" id="exportPrimaryMenu" style="display:none" role="menu" aria-label="Export format"></div>
                            <div class="split-btn__menu" id="exportSplitMenu" style="display:none" onclick="handleExportSplitMenuClick(event)">
                                <div class="split-btn__menu-item" data-action="excel">fast xlsb export</div>
                                <div class="split-btn__menu-item" data-action="markdown">Markdown (.md)</div>
                                <div class="split-btn__menu-item" data-action="json">JSON</div>
                                <div class="split-btn__menu-item" data-action="csv">CSV</div>
                                <div class="split-btn__menu-separator"></div>
                                <div class="split-btn__menu-item" data-action="copy-html">Copy as HTML to clipboard</div>
                                <div class="split-btn__menu-item" data-action="copy-md">Copy as Markdown to clipboard</div>
                                <div class="split-btn__menu-item" data-action="copy-image">Copy as Image to clipboard</div>
                                <div class="split-btn__menu-separator"></div>
                                <div class="split-btn__menu-item" data-action="export-all-excel">Export All to Excel</div>
                                <div class="split-btn__menu-separator"></div>
                                <div class="split-btn__menu-item" data-action="query-duckdb">Query Locally</div>
                            </div>
                        </div>
                        <button type="button" class="btn btn-icon" onclick="exportActiveGridAsXlsb()" title="Fast XLSB export of the active data grid" aria-label="Export active data grid as XLSB">${icons.excel}</button>
                        <button class="btn" onclick="toggleColumnVisibilityDropdown()" title="Show/hide columns" id="columnVisibilityBtn" aria-label="Show or hide columns">${icons.eye} Columns</button>
                        <button class="btn" onclick="toggleRowView()" title="Row details and comparison (select 1–10 rows)" id="rowViewBtn" aria-label="Toggle row view" aria-pressed="false">${icons.rowView} Row View</button>

                        <div class="split-btn toolbar-more-btn" id="toolbarMoreBtn">
                            <button class="btn split-btn__primary" onclick="toggleToolbarMoreMenu(event)" title="More actions" aria-label="More actions" aria-haspopup="menu">⋯ More</button>
                            <div class="split-btn__menu toolbar-more-menu" id="toolbarMoreMenu" style="display:none" onclick="handleToolbarMoreMenuClick(event)" role="menu">
                                <div class="split-btn__menu-item toolbar-more-menu__section-label">View mode</div>
                                <div class="split-btn__menu-item" data-action="view-chart">Trend charts</div>
                                <div class="split-btn__menu-item" data-action="view-diff">Diff</div>
                                <div class="split-btn__menu-separator"></div>
                                <div class="split-btn__menu-item" data-action="formatting">Formatting…</div>
                                <div class="split-btn__menu-separator"></div>
                                <div class="split-btn__menu-item toolbar-more-menu__section-label">Storage</div>
                                <div class="split-btn__menu-item" data-action="move-to-disk">Move to disk (SQLite)</div>
                                <div class="split-btn__menu-item" data-action="move-all-to-disk">Move ALL result sets to disk</div>
                            </div>
                        </div>

                        <!-- Secondary controls (view mode — driven from More menu) -->
                        <div class="split-btn view-split-btn toolbar-secondary-control" id="viewSplitBtn">
                            <button class="btn split-btn__primary view-split-btn__label" id="viewModeLabel" onclick="setViewMode('table')" title="Current view mode">Table</button>
                            <button class="btn split-btn__arrow" onclick="toggleViewSplitMenu(event)" title="Switch view mode" aria-label="Switch view mode">▾</button>
                            <div class="split-btn__menu" id="viewSplitMenu" style="display:none" onclick="handleViewSplitMenuClick(event)">
                                <div class="split-btn__menu-item" data-mode="table">Table</div>
                                <div class="split-btn__menu-item" data-mode="chart">Charts</div>
                                <div class="split-btn__menu-item" data-mode="diff">Diff</div>
                            </div>
                            <select id="viewModeSelect" class="view-mode-select-hidden" aria-hidden="true">
                                <option value="table">Table</option>
                                <option value="chart">Charts</option>
                                <option value="diff">Diff</option>
                            </select>
                            <select id="diffBaselineSelect" class="view-mode-select-hidden" title="Choose baseline result set" style="display: none;" aria-hidden="true"></select>
                        </div>

                        <button id="editToggleBtn" class="toolbar-edit-control" onclick="toggleEditMode()" title="Toggle edit mode for editable result sets" style="display: none;">Edit</button>
                        <button id="saveEditsBtn" class="toolbar-edit-control primary" onclick="saveEdits()" title="Save all pending edits" style="display: none;">Save Changes</button>
                        <button id="discardEditsBtn" class="toolbar-edit-control" onclick="discardEdits()" title="Discard all pending edits" style="display: none;">Discard</button>

                        <button id="clearLogsBtn" onclick="clearLogs()" title="Clear execution logs" style="display: none;">${icons.trash} Clear Logs</button>
                        <span id="rowCountInfo" class="row-count-info" aria-live="polite"></span>
                    </div>

                    <div class="layout-body">
                    <div class="layout-sidebar" id="layoutSidebar">
                        <div class="sidebar-section" id="sidebarSchemaSection">
                            <div class="sidebar-section-title">SCHEMA</div>
                            <div id="sidebarSchemaList" class="sidebar-schema-list"></div>
                        </div>
                        <div class="sidebar-section" id="sidebarGroupSection">
                            <div class="sidebar-section-title">GROUP BY — DRAG # HANDLE</div>
                            <div id="sidebarGroupDropZone" class="sidebar-group-dropzone" ondragover="onDragOverGroup(event)" ondragleave="onDragLeaveGroup(event)" ondrop="onDropGroup(event)">
                                <span class="sidebar-group-hint">Drag columns here from headers or SCHEMA</span>
                            </div>
                            <button class="btn sidebar-group-clear" onclick="clearAllGrouping()">✕ Clear grouping</button>
                            <div class="sidebar-group-tip">
                                <strong>Tip:</strong> Reorder or show/hide columns in SCHEMA, or drag them to GROUP BY.
                            </div>
                        </div>
                    </div>
                    <div class="layout-content">
                        <div id="groupingPanel" class="grouping-panel" ondragover="onDragOverGroup(event)" ondragleave="onDragLeaveGroup(event)" ondrop="onDropGroup(event)">
                            <span class="drag-hint">Drag headers here to group</span>
                        </div>

                        <div id="mainSplitView" class="main-split-view">
                        <div id="gridContainer"></div>
                        <div id="analysisContainer" class="analysis-container" style="display: none;"></div>                        <div id="rowViewPanel" class="row-view-panel">
                        <div class="row-view-header">
                            <span>Row Details &amp; Comparison</span>
                            <div class="row-view-header-actions">
                                <div class="split-btn row-view-export-wrapper">
                                    <button class="btn row-view-export-btn" onclick="toggleRowViewExportMenu(event)" title="Export row view">⬇</button>
                                    <div class="split-btn__menu row-view-export-menu" id="rowViewExportMenu" style="display:none" onclick="handleRowViewExportClick(event)">
                                        <div class="split-btn__menu-item" data-action="image">Copy as Image</div>
                                        <div class="split-btn__menu-item" data-action="xlsb">Download as XLSB</div>
                                        <div class="split-btn__menu-item" data-action="markdown">Copy as Markdown</div>
                                    </div>
                                </div>
                                <span class="row-view-close" onclick="toggleRowView()">✕</span>
                            </div>
                        </div>
                        <div id="rowViewContent" class="row-view-content">
                            <div class="row-view-placeholder">Select 1 to 10 rows to view details or compare</div>
                        </div>
                    </div>
                        <div id="databaseGroupingPanel" class="database-grouping-panel">
                            <div id="groupingResizeHandle" class="grouping-resize-handle" role="separator" tabindex="0" aria-label="Resize grouping panel" aria-orientation="vertical"></div>
                            <div class="grouping-panel-header">
                                <span>Database Grouping</span>
                                <div class="header-actions">
                                    <button type="button" onclick="toggleDatabaseGroupingPanel()" class="close-btn" title="Close grouping panel">✕</button>
                                </div>
                            </div>
                            <div class="grouping-drop-zone" id="groupingDropZone">
                                <div class="drop-hint">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 5h18M3 12h18M3 19h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                                    <div>Drag columns here to group</div>
                                </div>
                                <div class="group-chips" id="groupingChipsContainer"></div>
                            </div>
                            <div class="grouping-functions-area" id="groupingFunctionsArea">
                                <div class="functions-title">FUNCTIONS</div>
                                <div class="function-chips" id="groupingFnChipsContainer"></div>
                                <button type="button" class="add-function-btn" id="addGroupingFnBtn">＋ Add Function</button>
                            </div>
                            <div class="grouping-limit-area">
                                <label for="groupingLimitSelect">Grouped rows</label>
                                <select id="groupingLimitSelect" title="Limit rows returned by the grouped query">
                                    <option value="source">Source query limit</option>
                                    <option value="100">100</option>
                                    <option value="500">500</option>
                                    <option value="1000">1,000</option>
                                    <option value="10000">10,000</option>
                                    <option value="unlimited">Unlimited</option>
                                </select>
                            </div>
                            <div class="grouping-actions">
                                <button type="button" class="secondary" onclick="clearGroupingConfig()" id="clearGroupingBtn" disabled>Clear</button>
                                <button type="button" onclick="runGroupingQuery()" id="runGroupingBtn" disabled>Run Grouping</button>
                            </div>
                            <div class="grouping-results" id="groupingResultsArea">
                                <div class="no-results">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 5h18M3 12h18M3 19h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                                    <div>Drag columns and run grouping</div>
                                </div>
                            </div>
                        </div>
                        <div class="result-panel-right-bar" id="resultPanelRightBar">
                            <button type="button" class="bar-btn" onclick="toggleRowView()" id="rowViewBarBtn" title="Row Details &amp; Comparison">
                                <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M1 3h14v1H1V3zm0 4h8v1H1V7zm0 4h6v1H1v-1zM11 3h4v10h-4V3zm1 1v8h2V4h-2z"/></svg>
                                <span class="tooltip">Row View</span>
                            </button>
                            <button type="button" class="bar-btn" onclick="toggleDatabaseGroupingPanel()" id="groupingBarBtn" title="Database Grouping">
                                <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M1 2h14v3H1V2zm0 5h14v3H1V7zm0 5h14v3H1v-3z"/><rect x="4" y="5" width="8" height="9" rx="1" fill="currentColor" opacity="0.3"/></svg>
                                <span class="tooltip">Database Grouping</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            <div id="rangeChartOverlay" class="range-chart-overlay" aria-hidden="true"></div>
            <div id="valueViewerOverlay" class="value-viewer-overlay">
                <div class="value-viewer-modal">
                    <div class="value-viewer-header">
                        <div>
                            <div id="valueViewerTitle" class="value-viewer-title">Cell Value</div>
                            <div id="valueViewerMeta" class="value-viewer-meta"></div>
                        </div>
                        <button id="valueViewerCloseBtn" class="value-viewer-close" title="Close Value Viewer">×</button>
                    </div>
                    <div id="valueViewerBody" class="value-viewer-body"></div>
                    <div class="value-viewer-actions">
                        <button id="valueViewerCopyBtn" class="primary">Copy Value</button>
                        <button id="valueViewerDismissBtn">Close</button>
                    </div>
                </div>
            </div>
            
            <script>
                // Initialize empty state
                window.sources = [];
                window.pinnedSources = new Set();
                window.pinnedResults = [];
                window.activeSource = '';
                window.resultSets = [];
                window.executingSources = new Set();
                window.justybaseUseHostCopyShortcut = true;
                window.defaultCopyFormat = ${JSON.stringify(options.defaultCopyFormat || 'markdown')};
                
                let grids = [];
                let activeGridIndex = 0;
                const workerUri = "${uris.workerUri}";
            </script>
            <script src="${uris.mainScriptUri}"></script>
            <script>
                function setViewMode(mode) {
                    var sel = document.getElementById('viewModeSelect');
                    if (sel) { sel.value = mode; sel.dispatchEvent(new Event('change')); }
                    var label = document.getElementById('viewModeLabel');
                    if (label) {
                        var names = { table:'Table', chart:'Charts', diff:'Diff' };
                        label.textContent = names[mode] || mode;
                    }
                    document.getElementById('viewSplitMenu').style.display = 'none';
                }
                window.toggleViewSplitMenu = function(event) {
                    event.stopPropagation();
                    var m = document.getElementById('viewSplitMenu');
                    m.style.display = m.style.display === 'none' ? 'block' : 'none';
                };
                window.handleViewSplitMenuClick = function(event) {
                    var item = event.target.closest('.split-btn__menu-item');
                    if (!item) return;
                    setViewMode(item.dataset.mode);
                };
                window.toggleRowViewExportMenu = function(event) {
                    event.stopPropagation();
                    var m = document.getElementById('rowViewExportMenu');
                    m.style.display = m.style.display === 'none' ? 'block' : 'none';
                };
                window.handleRowViewExportClick = function(event) {
                    var item = event.target.closest('.split-btn__menu-item');
                    if (!item) return;
                    document.getElementById('rowViewExportMenu').style.display = 'none';
                    var action = item.dataset.action;
                    if (action === 'image') copyRowViewAsImage();
                    else if (action === 'xlsb') exportRowViewAsXlsb();
                    else if (action === 'markdown') copyRowViewAsMarkdown();
                };
                window.syncViewModeBar = function(mode) {
                    var label = document.getElementById('viewModeLabel');
                    if (label) {
                        var names = { table:'Table', chart:'Charts', diff:'Diff' };
                        label.textContent = names[mode] || mode;
                    }
                    if (typeof window.syncLayoutSwitcher === 'function') {
                        window.syncLayoutSwitcher(mode);
                    }
                };
                window.clearAllGrouping = function() {
                    var grid = window.grids && window.grids[window.activeGridIndex || 0];
                    if (grid && grid.tanTable) {
                        grid.tanTable.setGrouping([]);
                    }
                };
                window.toggleDatabaseGroupingPanel = function() {
                    if (typeof window.__toggleDatabaseGroupingPanel === 'function') {
                        window.__toggleDatabaseGroupingPanel();
                    }
                };
                window.clearGroupingConfig = function() {
                    if (typeof window.__clearGroupingConfig === 'function') {
                        window.__clearGroupingConfig();
                    }
                };
                window.runGroupingQuery = function() {
                    if (typeof window.__runGroupingQuery === 'function') {
                        window.__runGroupingQuery();
                    }
                };
                window.exportActiveGridAsXlsb = function() {
                    if (typeof window.__exportActiveGridAsXlsb === 'function') {
                        window.__exportActiveGridAsXlsb();
                    }
                };
                window.setLayoutMode = function(mode) {
                    var isSidebar = mode === 'sidebar';
                    document.body.classList.toggle('sidebar-layout', isSidebar);
                    window.layoutMode = isSidebar ? 'sidebar' : 'top';
                    var stateObj = window.__getHostState ? window.__getHostState() : {};
                    if (!stateObj) stateObj = {};
                    stateObj._layoutMode = window.layoutMode;
                    if (window.__setHostState) window.__setHostState(stateObj);
                    if (typeof window.renderSidebarSchema === 'function') window.renderSidebarSchema();
                };
                window.toggleLayout = function() {
                    var next = document.body.classList.contains('sidebar-layout') ? 'top' : 'sidebar';
                    window.setLayoutMode(next);
                    if (typeof window.syncLayoutSwitcher === 'function') {
                        window.syncLayoutSwitcher('table');
                    }
                };
                window.syncLayoutSwitcher = function(viewMode) {
                    var switcher = document.getElementById('layoutSwitcher');
                    if (!switcher) return;
                    var activeLayout = null;
                    if (viewMode === 'range-chart') {
                        activeLayout = 'charts';
                    } else if (viewMode === 'table') {
                        activeLayout = document.body.classList.contains('sidebar-layout') ? 'table2' : 'table';
                    }
                    switcher.querySelectorAll('.layout-switcher__btn').forEach(function(btn) {
                        var isActive = !!activeLayout && btn.dataset.layout === activeLayout;
                        btn.classList.toggle('active', isActive);
                        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
                    });
                };
                window.setLayoutSwitcherDisabled = function(disabled) {
                    var switcher = document.getElementById('layoutSwitcher');
                    if (!switcher) return;
                    switcher.querySelectorAll('.layout-switcher__btn').forEach(function(btn) {
                        btn.disabled = !!disabled;
                    });
                    if (disabled) window.syncLayoutSwitcher('table');
                };
                window.applyLayoutSwitcherChoice = function(layout) {
                    if (layout === 'table') {
                        if (typeof window.closeRangeChartModal === 'function') window.closeRangeChartModal();
                        window.setLayoutMode('top');
                        setViewMode('table');
                    } else if (layout === 'table2') {
                        if (typeof window.closeRangeChartModal === 'function') window.closeRangeChartModal();
                        window.setLayoutMode('sidebar');
                        setViewMode('table');
                    } else if (layout === 'charts') {
                        var opened = typeof window.openRangeChartForActiveResult === 'function'
                            && window.openRangeChartForActiveResult();
                        if (!opened && typeof window.syncLayoutSwitcher === 'function') {
                            var modeSelect = document.getElementById('viewModeSelect');
                            window.syncLayoutSwitcher(modeSelect && modeSelect.value === 'table' ? 'table' : 'table');
                        }
                    }
                };
                (function initLayoutSwitcher() {
                    var switcher = document.getElementById('layoutSwitcher');
                    if (!switcher) return;
                    switcher.addEventListener('click', function(event) {
                        var btn = event.target.closest('.layout-switcher__btn');
                        if (!btn || btn.disabled) return;
                        window.applyLayoutSwitcherChoice(btn.dataset.layout);
                    });
                })();
                // Restore layout from persisted state
                try {
                    var savedState = window.__getHostState ? window.__getHostState() : null;
                    if (savedState && savedState._layoutMode === 'sidebar') {
                        window.setLayoutMode('sidebar');
                    }
                } catch(e) {}
                // Initialize on load
                init();
            </script>
        </body>
        </html>`;
  }

  private _getIcons() {
    return {
      eye: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 3c-3 0-6 2.5-6 5s3 5 6 5 6-2.5 6-5-3-5-6-5zm0 9c-2.5 0-4.5-2-4.5-4S5.5 4 8 4s4.5 2 4.5 4-2 4.5-4.5 4.5z"/><circle cx="8" cy="8" r="2"/></svg>`,
      rowView: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M2 2.5h5v2H2v-2zm0 4.5h8v2H2V7zm0 4.5h6v2H2v-2z"/><path d="M10 3h4v10h-4V3zm1 1v8h2V4h-2z"/></svg>`,
      excel: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M6 3h8v10H6V3zm-1 0H3v10h2V3zm-2-1h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M6 6h8v1H6V6zm0 2h8v1H6V8zm0 2h8v1H6v-1z"/></svg>`,
      copy: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M4 4h7v2H4V4zm0 4h7v2H4V8zm0 4h7v2H4v-2zM2 1h12v14H2V1zm1 1v12h10V2H3z"/></svg>`,
      csv: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M13 2H6L2 6v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zm-1 11H4V7h3V4h5v9z"/></svg>`,
      json: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M5 2c0-1.1.9-2 2-2h2a2 2 0 0 1 2 2v2h-2V2H7v2H5V2zm0 12c0 1.1.9 2 2 2h2a2 2 0 0 0 2-2v-2h-2v2H7v-2H5v2zM2 7v2h2V7H2zm10 0v2h2V7h-2z"/></svg>`,
      xml: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M11.5 1L7 15h2l4.5-14h-2zM4.5 1L0 15h2l4.5-14h-2z"/></svg>`,
      sql: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 0C3.6 0 0 1.8 0 4v8c0 2.2 3.6 4 8 4s8-1.8 8-4V4c0-2.2-3.6-4-8-4zm0 2c3.3 0 6 1.3 6 3s-2.7 3-6 3-6-1.3-6-3 2.7-3 6-3zm0 12c-3.3 0-6-1.3-6-3V9c1.6 1.7 4.3 2 6 2s4.4-.3 6-2v2c0 1.7-2.7 3-6 3z"/></svg>`,
      markdown: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M14.5 2H1.5C.7 2 0 2.7 0 3.5v9C0 13.3.7 14 1.5 14h13c.8 0 1.5-.7 1.5-1.5v-9c0-.8-.7-1.5-1.5-1.5zM3 11V5l2 2 2-2v6H6V7l-1 1-1-1v4H3zm10 0h-2V9h-2v2H7V5h2v2h2V5h2v6z"/></svg>`,
      export: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M6 3h8v10H6V3zm-1 0H3v10h2V3zm-2-1h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M6 6h8v1H6V6zm0 2h8v1H6V8zm0 2h8v1H6v-1z"/><path d="M10 12L8 14L6 12" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`, // Custom combo icon
      refresh: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 3v5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 21v-5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      duckdbQuery: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 1C4.1 1 1 2.6 1 4.5v7C1 13.4 4.1 15 8 15s7-1.6 7-3.5v-7C15 2.6 11.9 1 8 1zm0 1.5c3.2 0 5.5 1.2 5.5 2S11.2 6.5 8 6.5 2.5 5.3 2.5 4.5 4.8 2.5 8 2.5zm0 11c-3.2 0-5.5-1.2-5.5-2V7c1.2.9 3.2 1.5 5.5 1.5S12.3 7.9 13.5 7v4.5c0 .8-2.3 2-5.5 2z"/><path d="M10.8 8.2a2.8 2.8 0 1 0 1.4 5.2l1.7 1.7.9-.9-1.7-1.7a2.8 2.8 0 0 0-2.3-4.3zm0 1.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z"/></svg>`,
      checkAll: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M13.485 1.929l1.414 1.414-9.9 9.9-4.243-4.242 1.415-1.415 2.828 2.829z"/></svg>`,
      clear: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 7.293l4.146-4.147.708.708L8.707 8l4.147 4.146-.708.708L8 8.707l-4.146 4.147-.708-.708L7.293 8 3.146 3.854l.708-.708L8 7.293z"/></svg>`,
      trash: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M6.5 1h3l.5.5V3h3v1h-1v10h-1v-10h-7v10h-1V4h-1V3h3V1.5l.5-.5zM7 2v1h2V2H7zm-2 2v9h6V4H5zm1 1h1v7H6V5zm2 0h1v7H8V5z"/></svg>`,
      settings: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M6.98 1.4h2.04l.36 1.6c.29.09.58.21.84.36l1.44-.8 1.44 1.44-.8 1.44c.15.26.27.55.36.84l1.6.36v2.04l-1.6.36a4.3 4.3 0 0 1-.36.84l.8 1.44-1.44 1.44-1.44-.8a4.3 4.3 0 0 1-.84.36l-.36 1.6H6.98l-.36-1.6a4.3 4.3 0 0 1-.84-.36l-1.44.8-1.44-1.44.8-1.44a4.3 4.3 0 0 1-.36-.84l-1.6-.36V6.98l1.6-.36c.09-.29.21-.58.36-.84l-.8-1.44 1.44-1.44 1.44.8c.26-.15.55-.27.84-.36l.36-1.6zm1.02 4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z"/></svg>`,
      expand: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M14 2l-4 4 4 4V6h3V2h-3v4zM2 14l4-4-4-4v4H2v2h3v-4z"/></svg>`,
      charts: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M2 13V8h3v5H2zm4-4V3h3v6H6zm4 2V5h3v6h-3zm4-3V2h3v7h-3z"/></svg>`,
    };
  }
}
