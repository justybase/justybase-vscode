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
            padding: 8px;
        }
        .input-group {
            display: flex;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            border-radius: 2px;
            height: 26px;
            align-items: center;
            overflow: hidden;
        }
        .input-group:focus-within {
            border-color: var(--vscode-focusBorder);
        }
        .input-group input {
            border: none;
            flex: 1;
            background: transparent;
            color: var(--vscode-input-foreground);
            padding: 0 6px;
            height: 100%;
            outline: none;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            min-width: 0;
        }
        .input-actions {
            display: flex;
            height: 100%;
            flex-shrink: 0;
        }
        .search-toggle-btn {
            border: none;
            background: none;
            color: var(--vscode-input-placeholderForeground);
            cursor: pointer;
            padding: 0 6px;
            font-size: 12px;
            font-family: var(--vscode-font-family);
            height: 100%;
            display: flex;
            align-items: center;
            border-left: 1px solid var(--vscode-panel-border);
            user-select: none;
            transition: background 0.1s, color 0.1s;
        }
        .search-toggle-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-input-foreground);
        }
        .search-toggle-btn.active {
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            border-left-color: var(--vscode-button-background);
        }
        .search-toggle-btn + .search-toggle-btn {
            border-left: 1px solid var(--vscode-panel-border);
        }
        .search-toggle-btn.active + .search-toggle-btn,
        .search-toggle-btn + .search-toggle-btn.active {
            border-left-color: var(--vscode-button-background);
        }
        .input-row {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 6px;
        }
        .input-row:last-child { margin-bottom: 0; }
        .mode-toggle {
            background: none;
            border: none;
            color: var(--vscode-icon-foreground);
            cursor: pointer;
            padding: 0 6px;
            height: 26px;
            display: flex;
            align-items: center;
            font-size: 12px;
            border-radius: 2px;
            flex-shrink: 0;
        }
        .mode-toggle:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .mode-toggle.replace-open {
            color: var(--vscode-focusBorder);
        }
        .replace-row {
            display: none;
            margin-top: 6px;
        }
        .replace-row.visible { display: block; }
        .action-row {
            display: flex;
            gap: 4px;
            margin-top: 6px;
        }
        .action-row button {
            cursor: pointer;
            border-radius: 2px;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            padding: 3px 12px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-contrastBorder, transparent);
        }
        .action-row button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .action-row button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .action-row button.primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .options-row {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-top: 6px;
            font-size: 12px;
            flex-wrap: wrap;
        }
        .options-row label {
            display: flex;
            align-items: center;
            gap: 3px;
            cursor: pointer;
            user-select: none;
        }
        .options-row select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 2px 4px;
            border-radius: 2px;
            cursor: pointer;
            font-size: 12px;
            font-family: var(--vscode-font-family);
        }
        .options-row input[type="checkbox"] { cursor: pointer; }
        .spacer { flex: 1; }
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
        <div class="input-row">
            <button class="mode-toggle" id="modeToggle" title="Toggle Replace">&#9654;</button>
            <div class="input-group">
                <input type="text" id="searchInput" placeholder="Search" />
                <div class="input-actions">
                    <button class="search-toggle-btn" id="btnCaseSensitive" title="Match Case">Aa</button>
                    <button class="search-toggle-btn" id="btnWholeWord" title="Match Whole Word">ab</button>
                    <button class="search-toggle-btn" id="btnRegex" title="Use Regular Expression">.*</button>
                </div>
            </div>
        </div>
        <div class="replace-row" id="replaceRow">
            <div class="input-group">
                <input type="text" id="replaceInput" placeholder="Replace" />
            </div>
        </div>
        <div class="action-row">
            <button id="searchBtn" class="primary">Search</button>
            <button id="replaceAllBtn" style="display:none;">Replace All</button>
            <button id="cancelBtn" style="display:none;">Cancel</button>
        </div>
        <div class="options-row">
            <label><input type="checkbox" id="chkSql" checked /> .sql</label>
            <label><input type="checkbox" id="chkPy" /> .py</label>
            <div class="spacer"></div>
            <select id="commentMode">
                <option value="raw" selected>Include comments</option>
                <option value="noComments">Exclude comments</option>
                <option value="noCommentsNoLiterals">Exclude comments &amp; strings</option>
            </select>
            <select id="groupMode">
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
            var searchBtn = document.getElementById('searchBtn');
            var replaceAllBtn = document.getElementById('replaceAllBtn');
            var cancelBtn = document.getElementById('cancelBtn');
            var resultsList = document.getElementById('resultsList');
            var status = document.getElementById('status');
            var chkSql = document.getElementById('chkSql');
            var chkPy = document.getElementById('chkPy');
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

            function getFileTypes() {
                var types = [];
                if (chkSql.checked) types.push('sql');
                if (chkPy.checked) types.push('py');
                return types;
            }

            function getOptions() {
                return {
                    term: searchInput.value,
                    replaceText: replaceInput.value,
                    mode: isReplaceMode ? 'replace' : 'find',
                    commentMode: commentMode.value,
                    groupMode: groupMode.value,
                    fileTypes: getFileTypes(),
                    caseSensitive: btnCaseSensitive.classList.contains('active'),
                    wholeWord: btnWholeWord.classList.contains('active'),
                    useRegex: btnRegex.classList.contains('active')
                };
            }

            function setSearchingState(searching) {
                isSearching = searching;
                cancelBtn.style.display = searching ? 'inline-block' : 'none';
                searchBtn.disabled = searching;
                if (replaceAllBtn) replaceAllBtn.disabled = searching;
            }

            function updateReplaceUI() {
                if (isReplaceMode) {
                    replaceRow.classList.add('visible');
                    replaceAllBtn.style.display = 'inline-block';
                    modeToggle.classList.add('replace-open');
                    modeToggle.textContent = '\u25BC';
                } else {
                    replaceRow.classList.remove('visible');
                    replaceAllBtn.style.display = 'none';
                    modeToggle.classList.remove('replace-open');
                    modeToggle.textContent = '\u25B6';
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
                var fileTypes = getFileTypes();
                if (fileTypes.length === 0) {
                    status.textContent = 'Select at least one file type.';
                    return;
                }
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
                var fileTypes = getFileTypes();
                if (fileTypes.length === 0) {
                    status.textContent = 'Select at least one file type.';
                    return;
                }
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

            chkSql.addEventListener('change', function() {
                saveState();
                triggerAutoSearch();
            });
            chkPy.addEventListener('change', function() {
                saveState();
                triggerAutoSearch();
            });

            modeToggle.addEventListener('click', function() {
                isReplaceMode = !isReplaceMode;
                updateReplaceUI();
                saveState();
            });

            searchBtn.addEventListener('click', doSearch);
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
                if (stored.chkSql !== undefined) chkSql.checked = stored.chkSql;
                if (stored.chkPy !== undefined) chkPy.checked = stored.chkPy;
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

            function saveState() {
                vscode.setState({
                    sessionId: currentSessionId,
                    term: searchInput.value,
                    replaceText: replaceInput.value,
                    commentMode: commentMode.value,
                    groupMode: groupMode.value,
                    chkSql: chkSql.checked,
                    chkPy: chkPy.checked,
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
