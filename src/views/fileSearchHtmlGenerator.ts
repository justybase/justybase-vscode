export class FileSearchHtmlGenerator {
    constructor(private sessionId: string) {}

    public generateHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Search</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 0;
            margin: 0;
            color: var(--vscode-foreground);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
            font-size: 13px;
        }
        .search-header {
            flex-shrink: 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding: 8px 8px 10px;
        }
        .search-row,
        .replace-row {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .replace-row {
            display: none;
            margin-top: 4px;
            padding-left: 24px;
        }
        .replace-row.visible { display: flex; }
        .mode-toggle {
            width: 20px;
            height: 26px;
            padding: 0;
            border: none;
            background: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            border-radius: 3px;
        }
        .mode-toggle svg {
            transition: transform 0.1s ease;
        }
        .mode-toggle.replace-open svg { transform: rotate(90deg); }
        .mode-toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
        .input-group {
            flex: 1;
            min-width: 0;
            height: 26px;
            display: flex;
            align-items: center;
            box-sizing: border-box;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 2px;
            padding-right: 3px;
        }
        .input-group:focus-within { border-color: var(--vscode-focusBorder); }
        .input-group input {
            flex: 1;
            min-width: 0;
            height: 100%;
            border: none;
            outline: none;
            background: transparent;
            color: var(--vscode-input-foreground);
            padding: 0 6px;
            font-size: 13px;
            font-family: var(--vscode-font-family);
        }
        .input-group input::placeholder { color: var(--vscode-input-placeholderForeground); }
        .input-actions {
            display: flex;
            align-items: center;
            gap: 2px;
            flex-shrink: 0;
        }
        .search-toggle-btn {
            width: 22px;
            height: 22px;
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            border: 1px solid transparent;
            border-radius: 3px;
            background: transparent;
            color: var(--vscode-icon-foreground);
            opacity: 0.75;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            line-height: 1;
            flex-shrink: 0;
        }
        .search-toggle-btn:hover {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground);
        }
        .search-toggle-btn.active {
            opacity: 1;
            background: var(--vscode-inputOption-activeBackground);
            border-color: var(--vscode-inputOption-activeBorder, transparent);
            color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
        }
        .search-toggle-btn:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        /* Include/exclude scope buttons use a neutral pressed state, like the native filter icons */
        .scope-toggle.active {
            background: var(--vscode-toolbar-activeBackground, rgba(255, 255, 255, 0.1));
            border-color: transparent;
            color: var(--vscode-foreground);
        }
        .replace-all-btn,
        .cancel-btn {
            width: 22px;
            height: 22px;
        }
        .glob-field {
            margin-top: 8px;
        }
        .glob-label {
            display: block;
            font-size: 12px;
            margin-bottom: 4px;
            color: var(--vscode-foreground);
        }
        .options-row {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 8px;
            font-size: 12px;
        }
        .options-row select {
            height: 22px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 0 4px;
            border-radius: 2px;
            cursor: pointer;
            font-size: 12px;
            font-family: var(--vscode-font-family);
        }
        #status {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            flex-shrink: 0;
            font-size: 12px;
            border-top: 1px solid var(--vscode-panel-border);
            min-height: 20px;
        }
        .results {
            list-style: none;
            padding: 0;
            margin: 0;
            flex-grow: 1;
            overflow-y: auto;
        }
        .result-item {
            padding: 6px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            cursor: pointer;
        }
        .result-item:hover { background: var(--vscode-list-hoverBackground); }
        .file-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .file-name {
            font-weight: 600;
            font-size: 1.0em;
            color: var(--vscode-textLink-foreground);
        }
        .file-path {
            font-size: 0.85em;
            opacity: 0.6;
            margin-top: 1px;
        }
        .match-count {
            font-size: 0.8em;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 1px 6px;
            border-radius: 8px;
        }
        .section-header {
            padding: 8px 10px 4px 10px;
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
        }
        .filename-badge {
            font-size: 0.75em;
            background: var(--vscode-editorInfo-foreground);
            color: var(--vscode-editor-background);
            padding: 1px 5px;
            border-radius: 4px;
            margin-left: 6px;
        }
        .matches-container {
            margin-top: 4px;
            padding-left: 0;
        }
        .match-line {
            padding: 2px 8px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.85em;
            white-space: pre;
            overflow: hidden;
            text-overflow: ellipsis;
            cursor: pointer;
            border-radius: 2px;
        }
        .match-line:hover { background: var(--vscode-list-hoverBackground); }
        .match-line.active {
            background: var(--vscode-editor-findMatchHighlightBackground);
            border-left: 3px solid var(--vscode-focusBorder);
        }
        .match-line .line-num {
            display: inline-block;
            min-width: 28px;
            color: var(--vscode-editorLineNumber-foreground);
            margin-right: 6px;
            user-select: none;
        }
        .group-header {
            padding: 8px 10px 4px 10px;
            font-weight: bold;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
            position: sticky;
            top: 0;
            z-index: 10;
            font-size: 12px;
        }
        .group-count {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: normal;
        }
        .group-toggle {
            display: inline-block;
            font-size: 10px;
            margin-right: 4px;
            user-select: none;
        }
        .group-items {
            display: contents;
        }
        .searching-indicator {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
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
        .highlight {
            background: var(--vscode-editor-findMatchHighlightBackground);
            padding: 0 2px;
            border-radius: 2px;
        }
        .hint { padding: 10px; color: var(--vscode-descriptionForeground); text-align: center; }
    </style>
</head>
<body>
    <div class="search-header">
        <div class="search-row">
            <button class="mode-toggle" id="modeToggle" title="Toggle Replace" aria-label="Toggle Replace"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg></button>
            <div class="input-group">
                <input type="text" id="searchInput" placeholder="Search" aria-label="Search" />
                <div class="input-actions">
                    <button class="search-toggle-btn" id="btnCaseSensitive" title="Match Case" aria-label="Match Case">Aa</button>
                    <button class="search-toggle-btn" id="btnWholeWord" title="Match Whole Word" aria-label="Match Whole Word">ab</button>
                    <button class="search-toggle-btn" id="btnRegex" title="Use Regular Expression" aria-label="Use Regular Expression">.*</button>
                </div>
            </div>
            <button class="search-toggle-btn cancel-btn" id="cancelBtn" title="Cancel search" aria-label="Cancel search" style="display:none;">&#10005;</button>
        </div>
        <div class="replace-row" id="replaceRow">
            <div class="input-group">
                <input type="text" id="replaceInput" placeholder="Replace" aria-label="Replace" />
                <div class="input-actions">
                    <button class="search-toggle-btn replace-all-btn" id="replaceAllBtn" title="Replace All" aria-label="Replace All" style="display:none;"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2 4h9M9 1.5 11.5 4 9 6.5M14 12H5M7 9.5 4.5 12 7 14.5"/></svg></button>
                </div>
            </div>
        </div>
        <div class="glob-field">
            <label class="glob-label" for="includeInput">Files to include</label>
            <div class="input-group">
                <input type="text" id="includeInput" value="*.sql" placeholder="e.g. *.sql, src/**" spellcheck="false" aria-label="Files to include" />
                <div class="input-actions">
                    <button class="search-toggle-btn scope-toggle" id="btnOpenEditors" title="Search only in open editors" aria-label="Search only in open editors" aria-pressed="false"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1"/><line x1="2" y1="6" x2="14" y2="6"/></svg></button>
                </div>
            </div>
        </div>
        <div class="glob-field">
            <label class="glob-label" for="excludeInput">Files to exclude</label>
            <div class="input-group">
                <input type="text" id="excludeInput" placeholder="e.g. *.txt, build" spellcheck="false" aria-label="Files to exclude" />
                <div class="input-actions">
                    <button class="search-toggle-btn scope-toggle active" id="btnUseExclude" title="Use Exclude Settings and Ignore Files" aria-label="Use Exclude Settings and Ignore Files" aria-pressed="true"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2 3h12l-4.5 5.5V13l-3-1.5V8.5z"/></svg></button>
                </div>
            </div>
        </div>
        <div class="options-row">
            <select id="commentMode" title="Comment handling" aria-label="Comment handling">
                <option value="raw" selected>Include comments</option>
                <option value="noComments">Exclude comments</option>
                <option value="noCommentsNoLiterals">Exclude comments &amp; strings</option>
            </select>
            <select id="groupMode" title="Result layout" aria-label="Result layout">
                <option value="flat">Flat</option>
                <option value="grouped">Grouped</option>
            </select>
        </div>
    </div>
    <div id="status"></div>
    <ul class="results" id="resultsList">
        <li class="hint">Enter a search term and press Enter or click Search.</li>
    </ul>
    <script>
        try {
            var vscode = acquireVsCodeApi();
            var searchInput = document.getElementById('searchInput');
            var replaceInput = document.getElementById('replaceInput');
            var replaceAllBtn = document.getElementById('replaceAllBtn');
            var cancelBtn = document.getElementById('cancelBtn');
            var resultsList = document.getElementById('resultsList');
            var status = document.getElementById('status');
            var includeInput = document.getElementById('includeInput');
            var excludeInput = document.getElementById('excludeInput');
            var btnOpenEditors = document.getElementById('btnOpenEditors');
            var btnUseExclude = document.getElementById('btnUseExclude');
            var commentMode = document.getElementById('commentMode');
            var groupMode = document.getElementById('groupMode');
            var modeToggle = document.getElementById('modeToggle');
            var replaceRow = document.getElementById('replaceRow');
            var btnCaseSensitive = document.getElementById('btnCaseSensitive');
            var btnWholeWord = document.getElementById('btnWholeWord');
            var btnRegex = document.getElementById('btnRegex');

            var isSearching = false;
            var allResults = [];
            var allFileMatches = [];
            var activeMatchEl = null;
            var isReplaceMode = false;
            var currentSessionId = '${this.sessionId}';
            var autoSearchDebounce = null;
            var patternHistory = { include: [], exclude: [] };
            var historyCursor = { include: -1, exclude: -1 };
            var historyDraft = { include: '', exclude: '' };

            function getOptions() {
                return {
                    term: searchInput.value,
                    replaceText: replaceInput.value,
                    mode: isReplaceMode ? 'replace' : 'find',
                    commentMode: commentMode.value,
                    groupMode: groupMode.value,
                    includePattern: includeInput.value,
                    excludePattern: excludeInput.value,
                    useExcludeSettings: btnUseExclude.classList.contains('active'),
                    searchOnlyOpenEditors: btnOpenEditors.classList.contains('active'),
                    caseSensitive: btnCaseSensitive.classList.contains('active'),
                    wholeWord: btnWholeWord.classList.contains('active'),
                    useRegex: btnRegex.classList.contains('active')
                };
            }

            function setSearchingState(searching) {
                isSearching = searching;
                cancelBtn.style.display = searching ? 'flex' : 'none';
                if (replaceAllBtn) replaceAllBtn.disabled = searching;
            }

            function updateReplaceUI() {
                if (isReplaceMode) {
                    replaceRow.classList.add('visible');
                    replaceAllBtn.style.display = 'flex';
                    modeToggle.classList.add('replace-open');
                } else {
                    replaceRow.classList.remove('visible');
                    replaceAllBtn.style.display = 'none';
                    modeToggle.classList.remove('replace-open');
                }
            }

            function escapeHtml(value) {
                return String(value || '')
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            }

            function highlightText(text, term) {
                if (!term) return escapeHtml(text);
                var upper = text.toUpperCase();
                var idx = upper.indexOf(term.toUpperCase());
                if (idx === -1) return escapeHtml(text);
                return escapeHtml(text.substring(0, idx)) +
                    '<span class="highlight">' + escapeHtml(text.substring(idx, idx + term.length)) + '</span>' +
                    escapeHtml(text.substring(idx + term.length));
            }

            function getDateLabel(mtime) {
                var now = Date.now();
                var diff = now - mtime;
                var msPerDay = 86400000;
                if (diff < msPerDay) return 'Today';
                if (diff < 7 * msPerDay) return 'This Week';
                if (diff < 30 * msPerDay) return 'This Month';
                return 'Older';
            }

            function formatDate(mtime) {
                var d = new Date(mtime);
                return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
                    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            }

            function renderResults(results, fileMatches, group) {
                resultsList.innerHTML = '';
                activeMatchEl = null;

                if (results.length === 0 && fileMatches.length === 0) {
                    resultsList.innerHTML = '<li class="hint">No results found.</li>';
                    return;
                }

                if (results.length > 0) {
                    var contentHeader = document.createElement('div');
                    contentHeader.className = 'section-header';
                    contentHeader.innerHTML = '<span>Content Matches</span><span class="match-count">' + results.length + '</span>';
                    resultsList.appendChild(contentHeader);
                    if (group === 'flat') {
                        results.forEach(function(item) {
                            resultsList.appendChild(createFileResultElement(item));
                        });
                    } else {
                        renderGrouped(results);
                    }
                }

                if (fileMatches.length > 0) {
                    var fnHeader = document.createElement('div');
                    fnHeader.className = 'section-header';
                    fnHeader.innerHTML = '<span>Filename Matches</span><span class="match-count">' + fileMatches.length + '</span>';
                    resultsList.appendChild(fnHeader);
                    fileMatches.forEach(function(item) {
                        resultsList.appendChild(createFileResultElement(item));
                    });
                }
            }

            function renderGrouped(results) {
                var groups = {};
                results.forEach(function(item) {
                    var label = getDateLabel(item.mtime);
                    if (!groups[label]) groups[label] = [];
                    groups[label].push(item);
                });
                var order = ['Today', 'This Week', 'This Month', 'Older'];
                order.forEach(function(label) {
                    if (!groups[label]) return;
                    var items = groups[label];

                    var header = document.createElement('div');
                    header.className = 'group-header';
                    header.innerHTML = '<span><span class="group-toggle">&#9660;</span> ' + escapeHtml(label) + '</span><span class="group-count">' + items.length + '</span>';

                    var container = document.createElement('div');
                    container.className = 'group-items';

                    items.forEach(function(item) {
                        container.appendChild(createFileResultElement(item));
                    });

                    header.addEventListener('click', function() {
                        var toggle = header.querySelector('.group-toggle');
                        var collapsed = container.style.display === 'none';
                        container.style.display = collapsed ? '' : 'none';
                        if (toggle) {
                            toggle.style.display = 'inline-block';
                            toggle.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(-90deg)';
                            toggle.style.transition = 'transform 0.15s';
                        }
                    });

                    resultsList.appendChild(header);
                    resultsList.appendChild(container);
                });
            }

            function createFileResultElement(item) {
                var li = document.createElement('li');
                li.className = 'result-item';
                var term = searchInput.value;

                if (item.isFileNameMatch) {
                    li.innerHTML = '<div class="file-header">' +
                        '<span><span class="file-name">' + escapeHtml(item.fileName) + '</span><span class="filename-badge">filename</span></span>' +
                        '<span class="file-path">' + formatDate(item.mtime) + '</span>' +
                        '</div>' +
                        '<div class="file-path">' + escapeHtml(item.relativePath) + '</div>';
                    li.addEventListener('dblclick', function() {
                        vscode.postMessage({ type: 'openFile', fileUri: item.fileUri, line: 1 });
                    });
                    return li;
                }

                var matchLabel = item.matchCount + ' match' + (item.matchCount !== 1 ? 'es' : '');
                li.innerHTML = '<div class="file-header">' +
                    '<span class="file-name">' + escapeHtml(item.fileName) + '</span>' +
                    '<span class="match-count">' + matchLabel + '</span>' +
                    '</div>' +
                    '<div class="file-path">' + escapeHtml(item.relativePath) + ' &middot; ' + formatDate(item.mtime) + '</div>';

                var matchesContainer = document.createElement('div');
                matchesContainer.className = 'matches-container';
                matchesContainer.style.display = 'none';

                (item.matches || []).forEach(function(match) {
                    var matchDiv = document.createElement('div');
                    matchDiv.className = 'match-line';
                    matchDiv.innerHTML = '<span class="line-num">' + match.line + '</span>' + highlightText(match.lineContent, term);
                    matchDiv.addEventListener('click', function(e) {
                        e.stopPropagation();
                        if (activeMatchEl && activeMatchEl !== matchDiv) {
                            activeMatchEl.classList.remove('active');
                        }
                        matchDiv.classList.add('active');
                        activeMatchEl = matchDiv;
                        vscode.postMessage({ type: 'openFile', fileUri: item.fileUri, line: match.line });
                    });
                    matchesContainer.appendChild(matchDiv);
                });

                li.appendChild(matchesContainer);
                li.addEventListener('click', function() {
                    var isVisible = matchesContainer.style.display !== 'none';
                    matchesContainer.style.display = isVisible ? 'none' : 'block';
                });
                li.addEventListener('dblclick', function() {
                    if (item.matches && item.matches.length > 0) {
                        vscode.postMessage({ type: 'openFile', fileUri: item.fileUri, line: item.matches[0].line });
                    }
                });

                return li;
            }

            function doSearch() {
                var term = searchInput.value.trim();
                if (!term) return;
                allResults = [];
                allFileMatches = [];
                resultsList.innerHTML = '<li class="searching-indicator"><span class="spinner"></span> Searching...</li>';
                status.textContent = '';
                setSearchingState(true);
                vscode.postMessage({ type: 'search', options: getOptions() });
            }

            function triggerAutoSearch() {
                if (!searchInput.value.trim()) return;
                if (autoSearchDebounce) clearTimeout(autoSearchDebounce);
                autoSearchDebounce = setTimeout(function() {
                    doSearch();
                }, 200);
            }

            function doReplaceAll() {
                var term = searchInput.value.trim();
                if (!term) return;
                setSearchingState(true);
                status.textContent = 'Replacing...';
                vscode.postMessage({ type: 'replaceAll', options: getOptions() });
            }

            btnCaseSensitive.addEventListener('click', function() {
                btnCaseSensitive.classList.toggle('active');
                saveState();
                triggerAutoSearch();
            });
            btnWholeWord.addEventListener('click', function() {
                btnWholeWord.classList.toggle('active');
                saveState();
                triggerAutoSearch();
            });
            btnRegex.addEventListener('click', function() {
                btnRegex.classList.toggle('active');
                saveState();
                triggerAutoSearch();
            });

            commentMode.addEventListener('change', function() {
                saveState();
                triggerAutoSearch();
            });

            groupMode.addEventListener('change', function() {
                saveState();
                if (allResults.length > 0 || allFileMatches.length > 0) {
                    renderResults(allResults, allFileMatches, groupMode.value);
                }
            });

            [includeInput, excludeInput].forEach(function(input) {
                var key = input === includeInput ? 'include' : 'exclude';
                input.addEventListener('keyup', function(e) {
                    if (e.key === 'Enter') doSearch();
                });
                input.addEventListener('input', function() {
                    historyCursor[key] = -1;
                    saveState();
                    triggerAutoSearch();
                });
                input.addEventListener('keydown', function(e) {
                    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                    var list = patternHistory[key];
                    if (list.length === 0) return;
                    e.preventDefault();
                    var cursor = historyCursor[key];
                    if (cursor === -1) historyDraft[key] = input.value;
                    cursor = e.key === 'ArrowUp' ? Math.min(cursor + 1, list.length - 1) : Math.max(cursor - 1, -1);
                    historyCursor[key] = cursor;
                    input.value = cursor === -1 ? historyDraft[key] : list[cursor];
                    saveState();
                    triggerAutoSearch();
                });
            });

            function bindScopeToggle(button) {
                button.addEventListener('click', function() {
                    var active = button.classList.toggle('active');
                    button.setAttribute('aria-pressed', active ? 'true' : 'false');
                    saveState();
                    triggerAutoSearch();
                });
            }
            bindScopeToggle(btnOpenEditors);
            bindScopeToggle(btnUseExclude);

            modeToggle.addEventListener('click', function() {
                isReplaceMode = !isReplaceMode;
                updateReplaceUI();
                saveState();
            });

            replaceAllBtn.addEventListener('click', doReplaceAll);

            searchInput.addEventListener('keyup', function(e) {
                if (e.key === 'Enter') doSearch();
            });
            replaceInput.addEventListener('keyup', function(e) {
                if (e.key === 'Enter' && isReplaceMode) doReplaceAll();
            });

            cancelBtn.addEventListener('click', function() {
                vscode.postMessage({ type: 'cancel' });
            });

            window.addEventListener('message', function(event) {
                var message = event.data;
                switch (message.type) {
                    case 'results':
                        setSearchingState(false);
                        allResults = message.data || [];
                        allFileMatches = message.fileMatches || [];
                        renderResults(allResults, allFileMatches, message.groupMode || 'flat');
                        var total = allResults.length + allFileMatches.length;
                        status.textContent = total + ' file' + (total !== 1 ? 's' : '') + ' found';
                        break;
                    case 'searching':
                        status.textContent = message.message;
                        break;
                    case 'error':
                        setSearchingState(false);
                        resultsList.innerHTML = '';
                        status.textContent = 'Error: ' + message.message;
                        status.style.color = 'var(--vscode-errorForeground)';
                        break;
                    case 'cancelled':
                        setSearchingState(false);
                        resultsList.innerHTML = '';
                        status.textContent = 'Search cancelled.';
                        break;
                    case 'reset':
                        setSearchingState(false);
                        searchInput.value = '';
                        replaceInput.value = '';
                        allResults = [];
                        allFileMatches = [];
                        resultsList.innerHTML = '<li class="hint">Enter a search term and press Enter or click Search.</li>';
                        status.textContent = '';
                        break;
                    case 'history':
                        patternHistory = { include: message.include || [], exclude: message.exclude || [] };
                        break;
                    case 'replaceDone':
                        setSearchingState(false);
                        status.textContent = 'Replaced ' + message.matchCount + ' occurrence(s) in ' + message.modifiedCount + ' file(s)';
                        break;
                }
            });

            var stored = vscode.getState();
            if (stored && stored.sessionId === currentSessionId) {
                if (stored.term) searchInput.value = stored.term;
                if (stored.replaceText !== undefined) replaceInput.value = stored.replaceText;
                if (stored.commentMode) commentMode.value = stored.commentMode;
                if (stored.groupMode) groupMode.value = stored.groupMode;
                if (stored.includePattern !== undefined) includeInput.value = stored.includePattern;
                if (stored.excludePattern !== undefined) excludeInput.value = stored.excludePattern;
                if (stored.useExcludeSettings !== undefined) setToggle(btnUseExclude, stored.useExcludeSettings);
                if (stored.searchOnlyOpenEditors !== undefined) setToggle(btnOpenEditors, stored.searchOnlyOpenEditors);
                if (stored.caseSensitive) btnCaseSensitive.classList.add('active');
                if (stored.wholeWord) btnWholeWord.classList.add('active');
                if (stored.useRegex) btnRegex.classList.add('active');
                if (stored.isReplaceMode) {
                    isReplaceMode = true;
                    updateReplaceUI();
                }
                if (stored.results && stored.results.length > 0) {
                    allResults = stored.results;
                    allFileMatches = stored.fileMatches || [];
                    renderResults(allResults, allFileMatches, groupMode.value);
                }
            }

            function setToggle(button, active) {
                button.classList.toggle('active', !!active);
                button.setAttribute('aria-pressed', active ? 'true' : 'false');
            }

            function saveState() {
                vscode.setState({
                    sessionId: currentSessionId,
                    term: searchInput.value,
                    replaceText: replaceInput.value,
                    commentMode: commentMode.value,
                    groupMode: groupMode.value,
                    includePattern: includeInput.value,
                    excludePattern: excludeInput.value,
                    useExcludeSettings: btnUseExclude.classList.contains('active'),
                    searchOnlyOpenEditors: btnOpenEditors.classList.contains('active'),
                    caseSensitive: btnCaseSensitive.classList.contains('active'),
                    wholeWord: btnWholeWord.classList.contains('active'),
                    useRegex: btnRegex.classList.contains('active'),
                    isReplaceMode: isReplaceMode,
                    results: allResults,
                    fileMatches: allFileMatches
                });
            }

            searchInput.addEventListener('input', saveState);
            replaceInput.addEventListener('input', saveState);
            vscode.postMessage({ type: 'ready' });
        } catch (err) {
            var errDiv = document.createElement('div');
            errDiv.style.color = 'red';
            errDiv.innerText = 'Script Error: ' + err.message;
            document.body.appendChild(errDiv);
        }
    </script>
</body>
</html>`;
    }
}
