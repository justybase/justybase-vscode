export class SchemaSearchHtmlGenerator {

    constructor(private sessionId: string) {
    }

    public generateHtml(): string {
        return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Schema Search</title>
        <style>
            body {
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                padding: 0;
                margin: 0;
                color: var(--vscode-foreground);
                background-color: var(--vscode-sideBar-background);
                display: flex;
                flex-direction: column;
                height: 100vh;
                overflow: hidden;
            }
            :root {
                color-scheme: light dark;
            }
            select {
                background-color: var(--vscode-dropdown-background, var(--vscode-input-background));
                color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
                border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, var(--vscode-panel-border)));
                padding: 3px 6px;
                border-radius: 2px;
                cursor: pointer;
                font-size: 12px;
                font-family: var(--vscode-font-family);
                outline: none;
                max-width: 100%;
            }
            select:focus-visible {
                border-color: var(--vscode-focusBorder);
                outline: 1px solid var(--vscode-focusBorder);
                outline-offset: -1px;
            }
            select option,
            select optgroup {
                background-color: var(--vscode-dropdown-background, var(--vscode-input-background));
                color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
            }
            select:disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }
            .search-box {
                display: flex;
                gap: 5px;
                padding: 8px 10px;
                flex-shrink: 0;
                border-bottom: 1px solid var(--vscode-panel-border);
                background-color: var(--vscode-sideBar-background);
            }
            input {
                flex-grow: 1;
                padding: 4px 8px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                font-size: 12px;
            }
            button {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                background-color: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: 1px solid var(--vscode-contrastBorder, transparent);
                padding: 4px 10px;
                cursor: pointer;
                border-radius: 2px;
                font-family: var(--vscode-font-family);
                font-size: 12px;
                line-height: 18px;
            }
            button:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
            button.primary { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }
            button.primary:hover { background-color: var(--vscode-button-hoverBackground); }
            button:disabled { opacity: 0.6; cursor: default; }
            #status {
                padding: 4px 12px;
                flex-shrink: 0;
                font-size: 11px;
                color: var(--vscode-descriptionForeground);
                min-height: 18px;
            }
            #status.status-error { color: var(--vscode-errorForeground); }
            #status.status-warning { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
            .results {
                padding: 0;
                margin: 0;
                flex-grow: 1;
                overflow-y: auto;
            }
            .empty-state {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 32px 16px;
                text-align: center;
                color: var(--vscode-descriptionForeground);
                gap: 8px;
            }
            .empty-state-icon {
                font-size: 28px;
                opacity: 0.7;
            }
            .empty-state-title {
                font-size: 13px;
                font-weight: 600;
                color: var(--vscode-foreground);
            }
            .empty-state-detail {
                font-size: 12px;
                max-width: 260px;
                line-height: 1.4;
            }
            .results-inner {
                padding: 6px 8px 12px;
            }
            .result-group {
                margin-bottom: 10px;
                border: 1px solid var(--vscode-panel-border);
                border-radius: 6px;
                overflow: hidden;
                background: var(--vscode-editor-background);
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
            }
            .result-group.group-priority-table { --group-accent: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
            .result-group.group-priority-view { --group-accent: var(--vscode-symbolIcon-interfaceForeground, #75beff); }
            .result-group.group-priority-column { --group-accent: var(--vscode-symbolIcon-fieldForeground, #b180d7); }
            .result-group.group-priority-other { --group-accent: var(--vscode-descriptionForeground); }
            .group-header {
                padding: 9px 12px;
                font-weight: 600;
                font-size: 12px;
                letter-spacing: 0.02em;
                text-transform: uppercase;
                background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-inactiveSelectionBackground));
                border-bottom: 1px solid var(--vscode-panel-border);
                border-left: 3px solid var(--group-accent, var(--vscode-focusBorder));
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: pointer;
                user-select: none;
                position: sticky;
                top: 0;
                z-index: 10;
            }
            .group-header:hover {
                background: var(--vscode-list-hoverBackground);
            }
            .group-header-label {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .group-type-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                border-radius: 4px;
                font-size: 11px;
                background: color-mix(in srgb, var(--group-accent) 18%, transparent);
                color: var(--group-accent);
                flex-shrink: 0;
            }
            .group-count {
                background: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                padding: 2px 8px;
                border-radius: 10px;
                font-size: 10px;
                font-weight: 600;
                min-width: 20px;
                text-align: center;
            }
            .group-toggle::before {
                content: '▼';
                display: inline-block;
                font-size: 9px;
                width: 12px;
                transition: transform 0.2s;
            }
            .group-toggle.collapsed::before {
                transform: rotate(-90deg);
            }
            .group-items.collapsed {
                display: none;
            }
            .result-row {
                padding: 9px 12px 9px 14px;
                border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
                border-left: 2px solid transparent;
                display: flex;
                flex-direction: column;
                gap: 3px;
                cursor: pointer;
                transition: background-color 0.12s ease, border-left-color 0.12s ease;
            }
            .result-row:last-child {
                border-bottom: none;
            }
            .result-row:hover,
            .result-row:focus-visible {
                background: var(--vscode-list-hoverBackground);
            }
            .result-row.row-priority-table:hover,
            .result-row.row-priority-table:focus-visible { border-left-color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
            .result-row.row-priority-view:hover,
            .result-row.row-priority-view:focus-visible { border-left-color: var(--vscode-symbolIcon-interfaceForeground, #75beff); }
            .result-row.row-priority-column:hover,
            .result-row.row-priority-column:focus-visible { border-left-color: var(--vscode-symbolIcon-fieldForeground, #b180d7); }
            .result-row.row-priority-other:hover,
            .result-row.row-priority-other:focus-visible { border-left-color: var(--vscode-descriptionForeground); }
            .result-row:focus-visible {
                outline: 1px solid var(--vscode-focusBorder);
                outline-offset: -1px;
            }
            .result-row-main {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                min-width: 0;
            }
            .result-name {
                font-weight: 600;
                font-size: 13px;
                color: var(--vscode-foreground);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .result-row:hover .result-name,
            .result-row:focus-visible .result-name {
                color: var(--vscode-textLink-foreground);
            }
            .result-meta {
                font-size: 11px;
                color: var(--vscode-descriptionForeground);
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 4px;
                line-height: 1.35;
            }
            .meta-separator {
                opacity: 0.45;
                user-select: none;
            }
            .meta-path {
                font-family: var(--vscode-editor-font-family, monospace);
                font-size: 10.5px;
            }
            .type-badge {
                font-size: 10px;
                background: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                padding: 1px 6px;
                border-radius: 3px;
                flex-shrink: 0;
            }
            .cache-badge {
                background-color: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                padding: 1px 6px;
                border-radius: 4px;
                font-size: 10px;
                flex-shrink: 0;
                border: 1px solid var(--vscode-contrastBorder, transparent);
            }
            .spinner {
                border: 2px solid transparent;
                border-top: 2px solid var(--vscode-progressBar-background);
                border-radius: 50%;
                width: 14px;
                height: 14px;
                animation: spin 1s linear infinite;
                display: inline-block;
                vertical-align: middle;
                margin-right: 8px;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            .options-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 5px 10px;
                font-size: 12px;
                border-bottom: 1px solid var(--vscode-panel-border);
                background-color: var(--vscode-sideBar-background);
            }
            .options-row label {
                display: flex;
                align-items: center;
                gap: 4px;
                cursor: pointer;
            }
            #sourceModeSelect {
                max-width: 130px;
                text-overflow: ellipsis;
            }
            .searching-indicator {
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                color: var(--vscode-descriptionForeground);
            }
            .compact-group-header.group-priority-table { --group-accent: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
            .compact-group-header.group-priority-view { --group-accent: var(--vscode-symbolIcon-interfaceForeground, #75beff); }
            .compact-group-header.group-priority-column { --group-accent: var(--vscode-symbolIcon-fieldForeground, #b180d7); }
            .compact-group-header.group-priority-other { --group-accent: var(--vscode-descriptionForeground); }
            .compact-table {
                width: 100%;
                border-collapse: collapse;
                table-layout: fixed;
                border: 1px solid var(--vscode-panel-border);
                border-radius: 6px;
                overflow: hidden;
            }
            .compact-table th {
                background: var(--vscode-editor-background);
                position: sticky;
                top: 0;
                z-index: 10;
                text-align: left;
                padding: 6px 10px;
                font-size: 11px;
                border-bottom: 1px solid var(--vscode-panel-border);
                font-weight: 600;
                color: var(--vscode-descriptionForeground);
                resize: horizontal;
                overflow: auto;
            }
            .compact-row {
                border-bottom: 1px solid var(--vscode-panel-border);
                cursor: pointer;
            }
            .compact-row:hover {
                background: var(--vscode-list-hoverBackground);
            }
            .compact-row.expanded {
                background: var(--vscode-list-activeSelectionBackground);
                color: var(--vscode-list-activeSelectionForeground);
            }
            .compact-cell {
                padding: 4px 10px;
                font-size: 12px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .compact-cell.type-cell { width: 70px; }
            .compact-cell.name-cell { width: 30%; font-weight: 600; color: var(--vscode-textLink-foreground); }
            .compact-cell.db-cell, .compact-cell.schema-cell { width: 15%; }
            .row-details {
                padding: 12px 10px 12px 40px;
                background: var(--vscode-editor-inactiveSelectionBackground);
                border-bottom: 1px solid var(--vscode-panel-border);
                font-size: 12px;
            }
            .details-grid {
                display: grid;
                grid-template-columns: max-content 1fr;
                gap: 6px 16px;
                margin-bottom: 10px;
            }
            .details-label {
                font-weight: 600;
                color: var(--vscode-descriptionForeground);
            }
            .action-btn {
                padding: 4px 12px;
            }
            .facet-row {
                display: flex;
                gap: 10px;
                padding: 6px 10px;
                border-bottom: 1px solid var(--vscode-panel-border);
                flex-wrap: wrap;
                font-size: 11px;
                background: var(--vscode-sideBar-background);
                flex-shrink: 0;
            }
            .facet-row label {
                display: flex;
                align-items: center;
                gap: 4px;
                color: var(--vscode-foreground);
            }
            .facet-row select {
                min-width: 72px;
            }
            .empty-state-compact {
                padding: 12px 16px 16px;
            }
            .empty-state-compact .empty-state-title {
                font-size: 12px;
                font-weight: 500;
            }
            .empty-state-compact .empty-state-detail {
                font-size: 11px;
            }
        </style>
    </head>
    <body>
        <div class="search-box">
            <input type="text" id="searchInput" placeholder="Search tables, columns, view definitions, procedure source..." />
            <button id="searchBtn" class="primary">Search</button>
            <button id="cancelBtn" style="display: none;" title="Cancel search">✕</button>
            <button id="resetBtn" title="Reset search">↺</button>
        </div>
        <div class="options-row">
            <label>
                Mode:
                <select id="sourceModeSelect">
                    <option value="">Objects Only</option>
                    <option value="raw">Source: Raw</option>
                    <option value="objectsRaw">Objects + Source Raw</option>
                    <option value="noComments">Source: No Comments</option>
                    <option value="noCommentsNoLiterals">Source: No Comments / Strings</option>
                </select>
            </label>
            <label>
                Layout:
                <select id="layoutSelect">
                    <option value="standard" selected>Standard List</option>
                    <option value="compact">Compact Grid</option>
                </select>
            </label>
            <div style="display: flex; gap: 4px; margin-left: auto;">
                <button id="exportXlsbBtn" class="secondary" title="Export to XLSB" style="padding: 2px 6px;">📥</button>
                <button id="settingsToggleBtn" class="secondary" title="Search Settings" style="padding: 2px 6px;">⚙️</button>
            </div>
        </div>
        <div id="advancedOptions" style="display: none; padding: 5px 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-inactiveSelectionBackground); font-size: 12px; gap: 10px; flex-wrap: wrap;">
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                Connection:
                <select id="connectionSelect" style="min-width: 220px;">
                    <option value="">Auto (Active SQL tab / Active connection)</option>
                </select>
            </label>
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                Sort:
                <select id="sortSelect">
                    <option value="db_name">Database, then Name</option>
                    <option value="name">Name</option>
                    <option value="type_name">Type, then Name</option>
                </select>
            </label>
        </div>
        <div id="facetRow" class="facet-row" style="display: none;">
            <label>
                Type:
                <select id="typeFilter">
                    <option value="">All</option>
                </select>
            </label>
            <label>
                Schema:
                <select id="schemaFilter">
                    <option value="">All</option>
                </select>
            </label>
            <label>
                Match:
                <select id="matchTypeFilter">
                    <option value="">All</option>
                </select>
            </label>
        </div>
        <div id="status"></div>
        <div class="results" id="resultsList" role="listbox" aria-label="Search results"></div>

        <script>
            try {
                /**
                 * @typedef {import('../src/contracts/webviews/schemaSearchContracts').SchemaSearchConnectionOption} SchemaSearchConnectionOption
                 * @typedef {import('../src/contracts/webviews/schemaSearchContracts').SchemaSearchHostToWebviewMessage} SchemaSearchHostToWebviewMessage
                 * @typedef {import('../src/contracts/webviews/schemaSearchContracts').SchemaSearchPersistedState} SchemaSearchPersistedState
                 * @typedef {import('../src/contracts/webviews/schemaSearchContracts').SchemaSearchResultItem} SchemaSearchResultItem
                 * @typedef {import('../src/contracts/webviews/schemaSearchContracts').SchemaSearchSourceMode} SchemaSearchSourceMode
                 * @typedef {import('../src/contracts/webviews/schemaSearchContracts').SchemaSearchWebviewToHostMessage} SchemaSearchWebviewToHostMessage
                 * @typedef {{ postMessage: (message: SchemaSearchWebviewToHostMessage) => void, getState: () => unknown, setState: (state: unknown) => void }} SchemaSearchVsCodeApi
                 */

                /** @type {SchemaSearchVsCodeApi} */
                const vscode = acquireVsCodeApi();
                const searchInput = document.getElementById('searchInput');
                const searchBtn = document.getElementById('searchBtn');
                const cancelBtn = document.getElementById('cancelBtn');
                const resetBtn = document.getElementById('resetBtn');
                const sourceModeSelect = document.getElementById('sourceModeSelect');
                const connectionSelect = document.getElementById('connectionSelect');
                const layoutSelect = document.getElementById('layoutSelect');
                const resultsList = document.getElementById('resultsList');
                const status = document.getElementById('status');
                const facetRow = document.getElementById('facetRow');
                const typeFilter = document.getElementById('typeFilter');
                const schemaFilter = document.getElementById('schemaFilter');
                const matchTypeFilter = document.getElementById('matchTypeFilter');

                let isSearching = false;
                let allResults = [];
                let recentResults = [];
                let hadStreamingResults = false;

                /**
                 * @param {SchemaSearchWebviewToHostMessage} message
                 */
                function postToHost(message) {
                    vscode.postMessage(message);
                }

                /**
                 * @param {unknown} message
                 * @returns {SchemaSearchHostToWebviewMessage}
                 */
                function asHostMessage(message) {
                    return message;
                }

                function clearStatusClasses() {
                    status.classList.remove('status-error', 'status-warning');
                }

                function showInitialEmptyState() {
                    facetRow.style.display = 'none';
                    if (recentResults.length > 0) {
                        renderResults(recentResults);
                        const hint = document.createElement('div');
                        hint.className = 'empty-state empty-state-compact';
                        hint.innerHTML = \`
                            <div class="empty-state-title">Search schema objects</div>
                            <div class="empty-state-detail">Enter at least 2 characters to search tables, columns, views, and more.</div>
                        \`;
                        resultsList.appendChild(hint);
                        return;
                    }

                    resultsList.innerHTML = \`
                        <div class="empty-state">
                            <div class="empty-state-icon">🔍</div>
                            <div class="empty-state-title">Search schema objects</div>
                            <div class="empty-state-detail">Search tables, columns, views, procedures, and source code. Minimum 2 characters.</div>
                        </div>
                    \`;
                }

                function showNoResultsEmptyState() {
                    resultsList.innerHTML = \`
                        <div class="empty-state">
                            <div class="empty-state-icon">🔍</div>
                            <div class="empty-state-title">No results found</div>
                            <div class="empty-state-detail">Try a different term or switch the search mode.</div>
                        </div>
                    \`;
                }

                function showSearchingIndicator() {
                    resultsList.innerHTML = '<div class="searching-indicator"><span class="spinner"></span> Searching...</div>';
                }

                function updateResultStatus(extraMessage) {
                    clearStatusClasses();
                    if (extraMessage) {
                        status.textContent = extraMessage;
                        return;
                    }
                    if (allResults.length === 0) {
                        status.textContent = '';
                        return;
                    }
                    const countLabel = allResults.length === 1 ? '1 result' : allResults.length + ' results';
                    if (isSearching) {
                        status.textContent = countLabel + ' · searching...';
                    } else if (hadStreamingResults) {
                        status.textContent = countLabel + ' · cache + database';
                    } else {
                        status.textContent = countLabel;
                    }
                }

                // Session ID to differentiate between VS Code sessions
                const currentSessionId = '${this.sessionId}';
                
                // Initialize state with all persisted fields
                const storedState = vscode.getState();
                
                // Check if state is from a different session (VS Code was restarted)
                /** @type {SchemaSearchPersistedState} */
                let state;
                if (storedState && storedState.sessionId === currentSessionId) {
                    // Same session - restore state (panel was hidden/shown)
                    state = storedState;
                } else {
                    // Different session or no state - start fresh (VS Code was restarted)
                    state = { 
                        sessionId: currentSessionId,
                        layout: 'standard', 
                        sortBy: 'db_name',
                        searchTerm: '',
                        sourceMode: '',
                        connectionName: '',
                        results: [],
                        typeFilter: '',
                        schemaFilter: '',
                        matchTypeFilter: ''
                    };
                }
                
                // Restore UI state from persisted state
                layoutSelect.value = state.layout || 'standard';
                const sortSelect = document.getElementById('sortSelect');
                sortSelect.value = state.sortBy || 'db_name';
                searchInput.value = state.searchTerm || '';
                sourceModeSelect.value = state.sourceMode || '';
                connectionSelect.value = state.connectionName || '';
                typeFilter.value = state.typeFilter || '';
                schemaFilter.value = state.schemaFilter || '';
                matchTypeFilter.value = state.matchTypeFilter || '';
                
                // Restore results if available (only from same session)
                if (state.results && state.results.length > 0) {
                    allResults = state.results;
                    renderResults(allResults);
                    updateFacetControls(collectFacetsFromResults(allResults));
                    updateResultStatus();
                } else {
                    showInitialEmptyState();
                }
                
                // Helper function to save current state
                function saveState() {
                    const currentState = vscode.getState() || {};
                    vscode.setState({
                        ...currentState,
                        sessionId: currentSessionId,
                        layout: layoutSelect.value,
                        sortBy: sortSelect.value,
                        searchTerm: searchInput.value,
                        sourceMode: sourceModeSelect.value,
                        connectionName: connectionSelect.value,
                        typeFilter: typeFilter.value,
                        schemaFilter: schemaFilter.value,
                        matchTypeFilter: matchTypeFilter.value,
                        results: allResults
                    });
                }

                function populateFacetSelect(select, values, selectedValue) {
                    const current = selectedValue || select.value || '';
                    select.innerHTML = '<option value="">All</option>';
                    values.forEach(value => {
                        const option = document.createElement('option');
                        option.value = value;
                        option.textContent = value;
                        select.appendChild(option);
                    });
                    if ([...select.options].some(option => option.value === current)) {
                        select.value = current;
                    }
                }

                /**
                 * @param {SchemaSearchResultItem[]} results
                 */
                function collectFacetsFromResults(results) {
                    const types = new Set();
                    const schemas = new Set();
                    const matchTypes = new Set();
                    results.forEach(item => {
                        if (item.TYPE) {
                            types.add(item.TYPE.toUpperCase());
                        }
                        if (item.SCHEMA) {
                            schemas.add(item.SCHEMA.toUpperCase());
                        }
                        matchTypes.add((item.MATCH_TYPE || 'NAME').toUpperCase());
                    });
                    return {
                        types: Array.from(types).sort(),
                        schemas: Array.from(schemas).sort(),
                        matchTypes: Array.from(matchTypes).sort(),
                    };
                }

                function updateFacetControls(facets) {
                    const resolvedFacets = facets || (allResults.length > 0 ? collectFacetsFromResults(allResults) : null);
                    if (!resolvedFacets) {
                        facetRow.style.display = 'none';
                        return;
                    }
                    populateFacetSelect(typeFilter, resolvedFacets.types || [], state.typeFilter);
                    populateFacetSelect(schemaFilter, resolvedFacets.schemas || [], state.schemaFilter);
                    populateFacetSelect(matchTypeFilter, resolvedFacets.matchTypes || [], state.matchTypeFilter);
                    facetRow.style.display = allResults.length > 0 ? 'flex' : 'none';
                }

                function getFilteredResults() {
                    const typeValue = (typeFilter.value || '').toUpperCase();
                    const schemaValue = (schemaFilter.value || '').toUpperCase();
                    const matchValue = (matchTypeFilter.value || '').toUpperCase();
                    return allResults.filter(item => {
                        if (typeValue && (item.TYPE || '').toUpperCase() !== typeValue) return false;
                        if (schemaValue && (item.SCHEMA || '').toUpperCase() !== schemaValue) return false;
                        if (matchValue && (item.MATCH_TYPE || 'NAME').toUpperCase() !== matchValue) return false;
                        return true;
                    });
                }

                [typeFilter, schemaFilter, matchTypeFilter].forEach(select => {
                    select.addEventListener('change', () => {
                        saveState();
                        if (allResults.length > 0) {
                            renderResults(getFilteredResults());
                            updateResultStatus();
                        }
                    });
                });
                
                sortSelect.addEventListener('change', () => {
                    saveState();
                    if (allResults.length > 0) {
                        renderResults(allResults);
                        updateResultStatus();
                    }
                });

                layoutSelect.addEventListener('change', () => {
                    saveState();
                    if (allResults.length > 0) {
                        renderResults(allResults);
                        updateResultStatus();
                    }
                });
                
                // Save search term on input change
                searchInput.addEventListener('input', () => {
                    const currentState = vscode.getState() || {};
                    vscode.setState({ ...currentState, searchTerm: searchInput.value });
                });
                
                // Save source mode on change
                sourceModeSelect.addEventListener('change', () => {
                    const currentState = vscode.getState() || {};
                    vscode.setState({ ...currentState, sourceMode: sourceModeSelect.value });
                });

                connectionSelect.addEventListener('change', () => {
                    const currentState = vscode.getState() || {};
                    vscode.setState({ ...currentState, connectionName: connectionSelect.value });
                    postToHost({
                        type: 'requestRecents',
                        connectionName: connectionSelect.value || undefined,
                    });
                });

                document.getElementById('exportXlsbBtn').addEventListener('click', () => {
                    if (allResults.length > 0) {
                        postToHost({ type: 'exportXlsb', results: allResults });
                    }
                });

                document.getElementById('settingsToggleBtn').addEventListener('click', () => {
                    const advancedOptions = document.getElementById('advancedOptions');
                    advancedOptions.style.display = advancedOptions.style.display === 'none' ? 'flex' : 'none';
                });

                function setSearchingState(searching) {
                    isSearching = searching;
                    cancelBtn.style.display = searching ? 'inline-flex' : 'none';
                    searchBtn.disabled = searching;
                    if (!searching && allResults.length > 0) {
                        updateResultStatus();
                    }
                }

                function startSearch(term) {
                    allResults = [];
                    hadStreamingResults = false;
                    showSearchingIndicator();
                    clearStatusClasses();
                    status.textContent = '';
                    setSearchingState(true);

                    const sourceMode = sourceModeSelect.value;
                    const connectionName = connectionSelect.value || undefined;
                    if (sourceMode === 'objectsRaw') {
                        postToHost({ type: 'searchCombined', value: term, mode: 'raw', connectionName });
                    } else if (sourceMode && sourceMode !== '') {
                        postToHost({ type: 'searchSource', value: term, mode: /** @type {SchemaSearchSourceMode} */ (sourceMode), connectionName });
                    } else {
                        postToHost({ type: 'search', value: term, connectionName });
                    }
                }

                searchBtn.addEventListener('click', () => {
                    const term = searchInput.value.trim();
                    if (!term) {
                        return;
                    }
                    if (term.length < 2) {
                        clearStatusClasses();
                        status.classList.add('status-warning');
                        status.textContent = 'Search term must be at least 2 characters.';
                        return;
                    }
                    startSearch(term);
                });

                searchInput.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter') {
                        searchBtn.click();
                    }
                });

                cancelBtn.addEventListener('click', () => {
                    postToHost({ type: 'cancel' });
                });

                resetBtn.addEventListener('click', () => {
                    postToHost({ type: 'reset' });
                });

                window.addEventListener('message', event => {
                    const message = asHostMessage(event.data);
                    switch (message.type) {
                        case 'results':
                            // Clear spinner or previous results if not appending or if spinner is still visible
                            if (!message.append || resultsList.querySelector('.searching-indicator')) {
                                resultsList.innerHTML = '';
                            }
                            
                            if (!message.append) {
                                allResults = [];
                            } else {
                                hadStreamingResults = true;
                            }
                            
                            allResults = allResults.concat(message.data);
                            allResults.sort((a, b) => {
                                const typeCompare = compareObjectTypesByPriority(a.TYPE || '', b.TYPE || '');
                                if (typeCompare !== 0) {
                                    return typeCompare;
                                }
                                const dbCompare = (a.DATABASE || '').localeCompare(b.DATABASE || '');
                                if (dbCompare !== 0) {
                                    return dbCompare;
                                }
                                return (a.NAME || '').localeCompare(b.NAME || '');
                            });
                            setSearchingState(false);
                            
                            if (allResults.length === 0) {
                                showNoResultsEmptyState();
                                clearStatusClasses();
                                status.textContent = 'No results found.';
                                facetRow.style.display = 'none';
                            } else {
                                updateFacetControls(collectFacetsFromResults(allResults));
                                renderResults(getFilteredResults());
                                updateResultStatus();
                            }
                            saveState();
                            break;
                        case 'searching':
                            clearStatusClasses();
                            updateResultStatus(message.message);
                            break;
                        case 'error':
                            setSearchingState(false);
                            if (resultsList.querySelector('.searching-indicator') && allResults.length === 0) {
                                showInitialEmptyState();
                            }
                            clearStatusClasses();
                            status.classList.add('status-error');
                            status.textContent = 'Error: ' + message.message;
                            break;
                        case 'cancelled':
                            setSearchingState(false);
                            if (resultsList.querySelector('.searching-indicator')) {
                                if (allResults.length > 0) {
                                    renderResults(allResults);
                                } else {
                                    showInitialEmptyState();
                                }
                            }
                            clearStatusClasses();
                            if (allResults.length > 0) {
                                const countLabel = allResults.length === 1 ? '1 result' : allResults.length + ' results';
                                status.textContent = 'Search cancelled — ' + countLabel + ' shown';
                            } else {
                                status.textContent = 'Search cancelled.';
                            }
                            break;
                        case 'reset':
                            setSearchingState(false);
                            hadStreamingResults = false;
                            searchInput.value = '';
                            allResults = [];
                            showInitialEmptyState();
                            clearStatusClasses();
                            status.textContent = '';
                            vscode.setState({ 
                                sessionId: currentSessionId,
                                layout: layoutSelect.value, 
                                sortBy: sortSelect.value,
                                searchTerm: '',
                                sourceMode: sourceModeSelect.value,
                                connectionName: connectionSelect.value,
                                results: []
                            });
                            postToHost({
                                type: 'requestRecents',
                                connectionName: connectionSelect.value || undefined,
                            });
                            break;
                        case 'recents':
                            recentResults = message.data || [];
                            if (allResults.length === 0 && !isSearching) {
                                showInitialEmptyState();
                            }
                            break;
                        case 'connections':
                            const selectedConnection = connectionSelect.value || state.connectionName || '';
                            connectionSelect.innerHTML = '<option value="">Auto (Active SQL tab / Active connection)</option>';
                            (message.connections || []).forEach(connection => {
                                const option = document.createElement('option');
                                option.value = connection.name;
                                option.textContent = connection.label;
                                connectionSelect.appendChild(option);
                            });
                            if ([...connectionSelect.options].some(option => option.value === selectedConnection)) {
                                connectionSelect.value = selectedConnection;
                            } else {
                                connectionSelect.value = '';
                            }
                            saveState();
                            break;
                    }
                });

                postToHost({ type: 'requestConnections' });

                function navigateToItem(item) {
                    postToHost({ 
                        type: 'navigate', 
                        database: item.DATABASE,
                        schema: item.SCHEMA,
                        name: item.NAME,
                        objType: item.TYPE,
                        parent: item.PARENT,
                        connectionName: item.connectionName
                    });
                }

                function escapeHtml(value) {
                    return String(value || '')
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#39;');
                }

                /**
                 * @param {SchemaSearchResultItem} item
                 */
                function formatQualifiedPath(item) {
                    const db = (item.DATABASE || '').trim();
                    const schema = (item.SCHEMA || '').trim();
                    if (db && schema) {
                        return db + '.' + schema;
                    }
                    if (db) {
                        return db;
                    }
                    if (schema) {
                        return schema;
                    }
                    return '';
                }

                /**
                 * @param {string} type
                 * @returns {'table' | 'view' | 'column' | 'other'}
                 */
                function getObjectTypeCategory(type) {
                    const normalized = (type || '').trim().toUpperCase();
                    if (
                        normalized === 'TABLE'
                        || normalized === 'EXTERNAL TABLE'
                        || (normalized.includes('TABLE') && !normalized.includes('VIEW'))
                    ) {
                        return 'table';
                    }
                    if (normalized === 'VIEW' || normalized.includes('VIEW')) {
                        return 'view';
                    }
                    if (normalized === 'COLUMN') {
                        return 'column';
                    }
                    return 'other';
                }

                /**
                 * @param {string} type
                 */
                function getObjectTypeSortPriority(type) {
                    const category = getObjectTypeCategory(type);
                    if (category === 'table') return 1;
                    if (category === 'view') return 2;
                    if (category === 'column') return 3;
                    return 4;
                }

                /**
                 * @param {string} typeA
                 * @param {string} typeB
                 */
                function compareObjectTypesByPriority(typeA, typeB) {
                    const priorityCompare = getObjectTypeSortPriority(typeA) - getObjectTypeSortPriority(typeB);
                    if (priorityCompare !== 0) {
                        return priorityCompare;
                    }
                    return typeA.localeCompare(typeB);
                }

                /**
                 * @param {string} type
                 */
                function getTypeGroupIcon(type) {
                    const category = getObjectTypeCategory(type);
                    if (category === 'table') return '⊞';
                    if (category === 'view') return '◫';
                    if (category === 'column') return '▤';
                    return '◇';
                }

                /**
                 * @param {SchemaSearchResultItem[]} items
                 * @param {string} sortVal
                 */
                function sortItemsWithinGroup(items, sortVal) {
                    const sorted = [...items];
                    if (sortVal === 'name') {
                        sorted.sort((a, b) => a.NAME.localeCompare(b.NAME));
                    } else if (sortVal === 'type_name') {
                        sorted.sort((a, b) => compareObjectTypesByPriority(a.TYPE, b.TYPE) || a.NAME.localeCompare(b.NAME));
                    } else {
                        sorted.sort((a, b) => (a.DATABASE || '').localeCompare(b.DATABASE || '') || a.NAME.localeCompare(b.NAME));
                    }
                    return sorted;
                }

                /**
                 * @param {HTMLElement} row
                 * @param {SchemaSearchResultItem} item
                 */
                function attachResultRowKeyboard(row, item) {
                    row.tabIndex = 0;
                    row.addEventListener('click', () => navigateToItem(item));
                    row.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            navigateToItem(item);
                        }
                    });
                }

                function renderResults(results) {
                    resultsList.innerHTML = '';
                    const inner = document.createElement('div');
                    inner.className = 'results-inner';
                    resultsList.appendChild(inner);

                    if (layoutSelect.value === 'compact') {
                        renderCompactResults(results, inner);
                    } else {
                        renderStandardResults(results, inner);
                    }
                }

                function renderStandardResults(results, container) {
                    const sortVal = sortSelect.value;
                    const groups = {};
                    results.forEach(item => {
                        const groupKey = item.TYPE;
                        if (!groups[groupKey]) groups[groupKey] = [];
                        groups[groupKey].push(item);
                    });
                    const sortedGroups = Object.keys(groups).sort(compareObjectTypesByPriority);
                    sortedGroups.forEach(type => {
                        const groupItems = sortItemsWithinGroup(groups[type], sortVal);
                        const category = getObjectTypeCategory(type);
                        const section = document.createElement('section');
                        section.className = 'result-group group-priority-' + category;

                        const groupHeader = document.createElement('div');
                        groupHeader.className = 'group-header';
                        groupHeader.innerHTML = \`
                            <span class="group-header-label">
                                <span class="group-toggle"></span>
                                <span class="group-type-icon" aria-hidden="true">\${getTypeGroupIcon(type)}</span>
                                <span>\${escapeHtml(type)}</span>
                            </span>
                            <span class="group-count">\${groupItems.length}</span>
                        \`;

                        const itemsContainer = document.createElement('div');
                        itemsContainer.className = 'group-items';
                        itemsContainer.setAttribute('role', 'group');
                        itemsContainer.setAttribute('aria-label', type);

                        groupHeader.addEventListener('click', () => {
                            const toggle = groupHeader.querySelector('.group-toggle');
                            toggle.classList.toggle('collapsed');
                            itemsContainer.classList.toggle('collapsed');
                        });

                        section.appendChild(groupHeader);
                        groupItems.forEach(item => {
                            const row = document.createElement('div');
                            const itemCategory = getObjectTypeCategory(item.TYPE);
                            row.className = 'result-row row-priority-' + itemCategory;
                            row.setAttribute('role', 'option');

                            const safeName = escapeHtml(item.NAME);
                            const safePath = escapeHtml(formatQualifiedPath(item));
                            const safeParent = escapeHtml(item.PARENT);
                            const safeDescription = escapeHtml(item.DESCRIPTION);

                            const metaParts = [];
                            if (safePath) {
                                metaParts.push('<span class="meta-path">' + safePath + '</span>');
                            }
                            if (item.PARENT) {
                                metaParts.push('<span>Parent: ' + safeParent + '</span>');
                            }
                            if (item.DESCRIPTION && item.DESCRIPTION !== 'Result from Cache') {
                                metaParts.push('<span style="font-style: italic;">' + safeDescription + '</span>');
                            }
                            if (item.MATCH_TYPE && item.MATCH_TYPE !== 'NAME') {
                                metaParts.push('<span class="cache-badge">' + escapeHtml(item.MATCH_TYPE) + '</span>');
                            }
                            const metaHtml = metaParts.join('<span class="meta-separator">·</span>');

                            let badgesHtml = '';
                            if (item.MATCH_TYPE === 'RECENT') {
                                badgesHtml += '<span class="cache-badge">Recent</span>';
                            }
                            if (item.DESCRIPTION === 'Result from Cache') {
                                badgesHtml += '<span class="cache-badge">Cached</span>';
                            }

                            row.innerHTML = \`
                                <div class="result-row-main">
                                    <span class="result-name">\${safeName}</span>
                                    \${badgesHtml}
                                </div>
                                <div class="result-meta">\${metaHtml}</div>
                            \`;

                            attachResultRowKeyboard(row, item);
                            itemsContainer.appendChild(row);
                        });

                        section.appendChild(itemsContainer);
                        container.appendChild(section);
                    });
                }

                function renderCompactResults(results, container) {
                    const sortVal = sortSelect.value;
                    const table = document.createElement('table');
                    table.className = 'compact-table';
                    table.innerHTML = \`
                        <thead>
                            <tr>
                                <th class="compact-cell type-cell">Type</th>
                                <th class="compact-cell name-cell">Name</th>
                                <th class="compact-cell db-cell">Database</th>
                                <th class="compact-cell schema-cell">Schema</th>
                                <th class="compact-cell desc-cell">Description</th>
                            </tr>
                        </thead>
                    \`;
                    
                    const groups = {};
                    results.forEach(item => {
                        if (!groups[item.TYPE]) groups[item.TYPE] = [];
                        groups[item.TYPE].push(item);
                    });
                    const sortedTypes = Object.keys(groups).sort(compareObjectTypesByPriority);

                    sortedTypes.forEach(type => {
                        const typeGroup = sortItemsWithinGroup(groups[type], sortVal);
                        const category = getObjectTypeCategory(type);

                        const headerTbody = document.createElement('tbody');
                        const headerTr = document.createElement('tr');
                        headerTr.className = 'group-header-row';
                        headerTr.innerHTML = \`
                            <td colspan="5" class="compact-group-header group-priority-\${category}" style="padding: 8px 10px; font-weight: 600; color: var(--vscode-foreground); background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-inactiveSelectionBackground)); border-bottom: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--group-accent, var(--vscode-focusBorder)); cursor: pointer;">
                                <span class="group-toggle"></span>
                                <span class="group-type-icon" aria-hidden="true">\${getTypeGroupIcon(type)}</span>
                                \${escapeHtml(type)}
                                <span class="group-count">\${typeGroup.length}</span>
                            </td>
                        \`;
                        headerTbody.appendChild(headerTr);
                        table.appendChild(headerTbody);

                        const contentTbody = document.createElement('tbody');
                        
                        headerTr.onclick = () => {
                            const toggle = headerTr.querySelector('.group-toggle');
                            toggle.classList.toggle('collapsed');
                            contentTbody.style.display = toggle.classList.contains('collapsed') ? 'none' : '';
                        };

                        typeGroup.forEach(item => {
                            const tr = document.createElement('tr');
                            tr.className = 'compact-row';
                            
                            let displayDesc = item.DESCRIPTION;
                            if (displayDesc === 'Result from Cache') displayDesc = 'Cached';
                            const safeType = escapeHtml(item.TYPE);
                            const safeName = escapeHtml(item.NAME);
                            const safeDatabase = escapeHtml(item.DATABASE);
                            const safeSchema = escapeHtml(item.SCHEMA);
                            const safeDisplayDesc = escapeHtml(displayDesc || '');
                            
                            tr.innerHTML = \`
                                <td class="compact-cell type-cell"><span class="type-badge">\${safeType}</span></td>
                                <td class="compact-cell name-cell" title="\${safeName}">\${safeName}</td>
                                <td class="compact-cell db-cell" title="\${safeDatabase}">\${safeDatabase}</td>
                                <td class="compact-cell schema-cell" title="\${safeSchema}">\${safeSchema}</td>
                                <td class="compact-cell desc-cell" title="\${safeDisplayDesc}">\${safeDisplayDesc}</td>
                            \`;
                            
                            const detailTr = document.createElement('tr');
                            detailTr.style.display = 'none';
                            const detailTd = document.createElement('td');
                            detailTd.colSpan = 5;
                            detailTd.className = 'row-details';
                            const safeDetailName = escapeHtml(item.NAME);
                            const safeDetailType = escapeHtml(item.TYPE);
                            const safeDetailDatabase = escapeHtml(item.DATABASE);
                            const safeDetailSchema = escapeHtml(item.SCHEMA);
                            const safeDetailParent = escapeHtml(item.PARENT);
                            const safeDetailDescription = escapeHtml(item.DESCRIPTION);
                            
                            let detailsHtml = '<div class="details-grid">';
                            detailsHtml += \`<div class="details-label">Object Name:</div><div>\${safeDetailName}</div>\`;
                            detailsHtml += \`<div class="details-label">Type:</div><div>\${safeDetailType}</div>\`;
                            detailsHtml += \`<div class="details-label">Database:</div><div>\${safeDetailDatabase}</div>\`;
                            detailsHtml += \`<div class="details-label">Schema:</div><div>\${safeDetailSchema}</div>\`;
                            if (item.PARENT) detailsHtml += \`<div class="details-label">Parent:</div><div>\${safeDetailParent}</div>\`;
                            if (item.DESCRIPTION && item.DESCRIPTION !== 'Result from Cache') {
                                detailsHtml += \`<div class="details-label">Description:</div><div>\${safeDetailDescription}</div>\`;
                            } else if (item.DESCRIPTION === 'Result from Cache') {
                                detailsHtml += \`<div class="details-label">Note:</div><div><span class="cache-badge">Result from Cache</span></div>\`;
                            }
                            detailsHtml += \`</div><button class="primary action-btn">👁️ Open definition</button>\`;
                            
                            detailTd.innerHTML = detailsHtml;
                            detailTr.appendChild(detailTd);
                            
                            tr.onclick = () => {
                                const isExpanded = detailTr.style.display !== 'none';
                                detailTr.style.display = isExpanded ? 'none' : 'table-row';
                                if (isExpanded) {
                                    tr.classList.remove('expanded');
                                } else {
                                    tr.classList.add('expanded');
                                }
                            };
                            
                            tr.ondblclick = () => {
                                navigateToItem(item);
                            };
                            
                            const openBtn = detailTd.querySelector('button');
                            if (openBtn) {
                                openBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    navigateToItem(item);
                                };
                            }
                            
                            contentTbody.appendChild(tr);
                            contentTbody.appendChild(detailTr);
                        });
                        
                        table.appendChild(contentTbody);
                    });
                    
                    container.appendChild(table);
                }
            } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.style.color = 'red';
    errDiv.innerText = 'Script Error: ' + err.message;
    document.body.appendChild(errDiv);
}
</script>
    </body>
    </html>`;
    }
}
