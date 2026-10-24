const vscode = acquireVsCodeApi();
const settingsConfig = JSON.parse(document.getElementById('settingsConfig').textContent || '{}');
const SECTIONS = settingsConfig.sections || [];
const NUMERIC_LIMITS = settingsConfig.numericLimits || {};
let currentSection = SECTIONS[0] ? SECTIONS[0].id : '';
let settingsValues = {};
let searchQuery = '';
let cachedUserSnippets = [];
let cachedPredefinedSnippets = [];

// Sidebar grouping keeps the 13 sections scannable without changing the registry.
const NAV_GROUPS = [
    { id: 'core', title: 'Core', sections: ['general', 'editor', 'sql', 'codelens'] },
    { id: 'data', title: 'Data', sections: ['query', 'ddl', 'schema', 'results', 'filepreview', 'importwizard'] },
    { id: 'integrations', title: 'Integrations', sections: ['copilot', 'mcp', 'snippets'] }
];

// ── Render Sidebar Navigation ──
function renderNav() {
    const nav = document.getElementById('sidebarNav');
    if (!nav) return;
    const icons = {
        'general': '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        'editor': '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        'sql': '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        'codelens': '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        'query': '<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
        'ddl': '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
        'schema': '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
        'results': '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>',
        'filepreview': '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
        'importwizard': '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        'copilot': '<svg viewBox="0 0 24 24"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2zM8 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm8 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
        'mcp': '<svg viewBox="0 0 24 24"><path d="M8 8.5 12 4l4 4.5"/><path d="M12 4v11"/><path d="M7 12H4v7h16v-7h-3"/><path d="M8 19v2h8v-2"/></svg>',
        'snippets': '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="8 10 12 14 16 10"/></svg>'
    };

    const sectionIds = new Set(SECTIONS.map(section => String(section.id)));
    const groupedIds = new Set(NAV_GROUPS.flatMap(group => group.sections));
    const leftover = SECTIONS
        .map(section => String(section.id))
        .filter(id => !groupedIds.has(id));
    const groups = [...NAV_GROUPS, { id: 'more', title: 'More', sections: leftover }];

    let html = '';
    for (const group of groups) {
        const items = group.sections.filter(id => sectionIds.has(id));
        if (items.length === 0) continue;
        html += '<div class="nav-group">';
        if (group.title) {
            html += '<div class="nav-group-title">' + escapeHtml(group.title) + '</div>';
        }
        for (const id of items) {
            const section = SECTIONS.find(candidate => String(candidate.id) === id);
            const count = Array.isArray(section.settings) ? section.settings.length : 0;
            const isActive = id === String(currentSection);
            html += '<div class="nav-item' + (isActive ? ' active' : '') + '" data-section="' + escapeHtml(id) + '" role="button" tabindex="0" aria-current="' + (isActive ? 'true' : 'false') + '">' +
                '<span class="nav-icon" aria-hidden="true">' + (icons[id] || '') + '</span>' +
                '<span class="nav-label">' + escapeHtml(String(section.title || section.id)) + '</span>' +
                '<span class="nav-count" title="' + count + ' settings">' + count + '</span>' +
                '</div>';
        }
        html += '</div>';
    }
    nav.innerHTML = html;

    nav.querySelectorAll('.nav-item').forEach(item => {
        const activate = () => {
            currentSection = item.dataset.section;
            renderNav();
            renderContent();
            const main = document.getElementById('mainContent');
            if (main) main.scrollTop = 0;
        };
        item.addEventListener('click', activate);
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
            }
        });
    });
}

// ── Render Settings Content ──
function renderContent() {
    const wrapper = document.getElementById('contentWrapper');
    const section = SECTIONS.find(s => s.id === currentSection);
    if (!section) {
        wrapper.innerHTML = '<div class="settings-empty"><strong>No settings available</strong><span>The settings registry could not be loaded.</span></div>';
        return;
    }

    const sectionSettings = Array.isArray(section.settings) ? section.settings : [];
    const hasResettable = sectionSettings.some(s => s.configKey);
    let html = '<div class="section-header">' +
        '<span class="section-title">' + escapeHtml(String(section.title || section.id)) + '</span>';
    if (hasResettable) {
        html += '<button class="section-reset-btn" data-section-reset="' + escapeHtml(String(section.id)) + '" title="Reset all settings in this section to defaults">↺ Reset All</button>';
    }
    html += '</div>';
    if (section.description) {
        html += '<div class="section-description">' + escapeHtml(String(section.description)) + '</div>';
    }

    html += '<div class="settings-card">';
    if (sectionSettings.length === 0) {
        html += '<div class="settings-empty"><strong>No settings in this section</strong><span>Choose another category or open the native VS Code settings.</span></div>';
    }
    for (const setting of sectionSettings) {
        const matchesSearch = !searchQuery || matchesFilter(setting, searchQuery);
        html += renderSettingRow(setting, matchesSearch);
    }
    html += '</div>';

    if (currentSection === 'mcp') {
        html += renderMcpStatus();
    }

    // Quick Actions section
    if (currentSection === 'general') {
        html += renderQuickActions();
    }

    wrapper.innerHTML = html;
    attachControlListeners();

    // Snippets section — add dynamic content container and fetch data
    if (currentSection === 'snippets') {
        const card = wrapper.querySelector('.settings-card');
        if (card) {
            const dynamicDiv = document.createElement('div');
            dynamicDiv.id = 'snippetsDynamicContent';
            dynamicDiv.innerHTML = '<div class="snippet-empty">Loading snippets...</div>';
            card.after(dynamicDiv);
        }
        vscode.postMessage({ command: 'getSnippets' });
    }
}

function renderSettingRow(setting, visible = true) {
    const isTextarea = setting.type === 'textarea' || setting.type === 'json';
    const label = String(setting.label || setting.id || 'Setting');
    const description = String(setting.description || '');
    try {
        return '<div class="setting-row' + (isTextarea ? ' textarea-row' : '') + (visible ? '' : ' search-hidden') + '" data-setting-id="' + escapeHtml(String(setting.id || '')) + '" data-label="' + escapeHtml((label + ' ' + description).toLowerCase()) + '">' +
            '<div class="setting-info">' +
            '<div class="setting-label">' + escapeHtml(label) + '</div>' +
            '<div class="setting-desc">' + escapeHtml(description) + '</div>' +
            '</div>' +
            '<div class="setting-control">' + renderControl(setting) + '</div>' +
            '</div>';
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return '<div class="setting-row setting-row-error"><div class="setting-info"><div class="setting-label">' + escapeHtml(label) + '</div><div class="setting-desc">Unable to render this setting: ' + escapeHtml(message) + '</div></div></div>';
    }
}

function renderMcpStatus() {
    const status = settingsValues.mcpStatus || {};
    const http = status.httpStatus || {};
    const tools = status.tools || [];
    let html = '<div class="mcp-status-card">';
    html += '<div class="mcp-status-title">MCP status</div>';

    if (status.selectionError) {
        html += '<div class="mcp-status-line error">⚠ ' + escapeHtml(status.selectionError) + '</div>';
    } else if (status.selectedConnection) {
        html += '<div class="mcp-status-line success">✓ Selected connection: <strong>' + escapeHtml(status.selectedConnection) + '</strong></div>';
    } else {
        html += '<div class="mcp-status-line warning">⚠ Select a Netezza connection before starting MCP.</div>';
    }

    html += '<div class="mcp-status-line">Copilot Chat: ' +
        (status.apiAvailable
            ? (status.copilotEnabled ? '<span class="status-good">enabled</span>' : 'disabled')
            : '<span class="status-muted">not available in this VS Code version</span>') +
        '</div>';

    if (status.externalEnabled && http.running) {
        html += '<div class="mcp-status-line success">✓ Local HTTP: running on <code>http://127.0.0.1:' +
            escapeHtml(String(http.port || settingsValues['mcp-port'] || 37210)) +
            '</code>' + (http.connectionName ? ' · ' + escapeHtml(http.connectionName) : '') + '</div>';
    } else if (status.externalEnabled) {
        html += '<div class="mcp-status-line error">⚠ Local HTTP: ' +
            escapeHtml(http.lastError || 'server is not running') + '</div>';
    } else {
        html += '<div class="mcp-status-line">Local HTTP: stopped</div>';
    }

    if (status.externalEnabled) {
        const port = http.port || settingsValues['mcp-port'] || 37210;
        const snippet = JSON.stringify({
            mcp: { 'netezza-schema': { type: 'remote', url: 'http://127.0.0.1:' + port } }
        }, null, 2);
        html += '<div class="mcp-snippet-label">OpenCode Streamable HTTP configuration</div>';
        html += '<pre class="mcp-snippet"><code>' + escapeHtml(snippet) + '</code></pre>';
    }

    html += '<details class="mcp-tools"><summary>Available read-only tools (' + tools.length + ')</summary><ul>';
    for (const tool of tools) {
        html += '<li><strong>' + escapeHtml(tool.name || '') + '</strong> — ' + escapeHtml(tool.description || '') + '</li>';
    }
    html += '</ul></details></div>';
    return html;
}

// ── Render User Snippets ──
function renderSnippetsContent(userSnippets, predefined) {
    const container = document.getElementById('snippetsDynamicContent');
    if (!container) return;

    // Cache for search filtering
    cachedUserSnippets = userSnippets || [];
    cachedPredefinedSnippets = predefined || [];
    const q = searchQuery ? searchQuery.toLowerCase() : '';

    let html = '';

    // Filter predefined snippets
    let filteredPredefined = predefined;
    if (q) {
        filteredPredefined = predefined.filter(sn =>
            sn.name.toLowerCase().includes(q) ||
            sn.prefix.some(p => p.toLowerCase().includes(q)) ||
            sn.description.toLowerCase().includes(q)
        );
    }
    const visiblePredefined = filteredPredefined.slice(0, q ? filteredPredefined.length : 10);

    // Filter user snippets
    let filteredUser = userSnippets;
    if (q) {
        filteredUser = userSnippets.filter(sn =>
            sn.label.toLowerCase().includes(q) ||
            (sn.sqlContent || '').toLowerCase().includes(q)
        );
    }

    // Predefined Snippets
    if (q && filteredPredefined.length === 0 && filteredUser.length === 0) {
        // No matching snippets at all — show empty message
        html += '<div class="snippet-empty">No snippets matching "' + escapeHtml(searchQuery) + '"</div>';
        container.innerHTML = html;
        attachSnippetListeners();
        return;
    }

    if (filteredPredefined.length > 0) {
        html += '<div class="snippet-subsection-title">Predefined <span class="count">(' + filteredPredefined.length + ' total' + (q ? ' matched' : '') + ')</span></div>';
        html += '<div class="snippet-list">';
        for (const sn of visiblePredefined) {
            const prefixText = sn.prefix.length > 0 ? sn.prefix.join(', ') : '—';
            html += '<div class="snippet-item predefined">' +
                '<div class="snippet-header">' +
                    '<span class="snippet-prefix">' + escapeHtml(prefixText) + '</span>' +
                    '<span class="snippet-title">' + escapeHtml(sn.name) + '</span>' +
                '</div>' +
                '<div class="snippet-desc">' +
                    escapeHtml(sn.description) +
                '</div>' +
            '</div>';
        }
        if (filteredPredefined.length > visiblePredefined.length && !q) {
            html += '<div class="snippet-more">+' + (filteredPredefined.length - 10) + ' more snippets. <a href="#" class="footer-link btn btn-compact" data-action="openSnippetsFile">Open file</a></div>';
        }
        html += '</div>';
    }

    // User Snippets
    html += '<div class="snippet-subsection-title">Custom <span class="count">(' + filteredUser.length + ' total' + (q ? ' matched' : '') + ')</span></div>';
    if (filteredUser.length === 0 && !q) {
        html += '<div class="snippet-empty">No custom snippets yet. Click "New" above to create one.</div>';
    } else if (filteredUser.length === 0) {
        // no op — already handled by overall empty check above
    } else {
        for (const sn of filteredUser) {
            html += renderSnippetItem(sn);
        }
    }

    container.innerHTML = html;
    attachSnippetListeners();
}

// ── Render Single Snippet Item ──
function renderSnippetItem(sn) {
    return '<div class="snippet-item" data-snippet-id="' + sn.id + '">' +
        '<div class="snippet-header">' +
            '<input class="snippet-name-input" value="' + escapeHtml(sn.label) + '" data-snippet-label="' + sn.id + '" placeholder="Snippet name" />' +
        '</div>' +
        '<div class="snippet-body">' +
            '<textarea class="snippet-sql-textarea" data-snippet-sql="' + sn.id + '" placeholder="Enter SQL..." spellcheck="false">' + escapeHtml(sn.sqlContent) + '</textarea>' +
        '</div>' +
        '<div class="snippet-actions">' +
            '<span class="snippet-status" id="snippet-status-' + sn.id + '"></span>' +
            '<button class="btn btn-primary btn-compact" data-snippet-save="' + sn.id + '">Save</button>' +
            '<button class="btn btn-danger btn-compact" data-snippet-delete="' + sn.id + '">Delete</button>' +
        '</div>' +
    '</div>';
}

// ── Attach Snippet Listeners ──
function attachSnippetListeners() {
    // Save buttons
    document.querySelectorAll('[data-snippet-save]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.snippetSave;
            const labelInput = document.querySelector('[data-snippet-label="' + id + '"]');
            const sqlTextarea = document.querySelector('[data-snippet-sql="' + id + '"]');
            const statusEl = document.getElementById('snippet-status-' + id);
            if (id && labelInput && sqlTextarea) {
                const label = labelInput.value.trim();
                const sql = sqlTextarea.value;
                if (!label) {
                    if (statusEl) { statusEl.textContent = 'Name is required'; statusEl.className = 'snippet-status'; }
                    return;
                }
                if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.className = 'snippet-status'; }
                vscode.postMessage({ command: 'updateSnippet', value: { id, label, sql } });
            }
        });
    });

    // Delete buttons
    document.querySelectorAll('[data-snippet-delete]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.snippetDelete;
            if (id && confirm('Delete this snippet?')) {
                vscode.postMessage({ command: 'deleteSnippet', value: id });
            }
        });
    });
}

function matchesFilter(setting, query) {
    const q = query.toLowerCase();
    return String(setting.label || '').toLowerCase().includes(q) ||
           String(setting.description || '').toLowerCase().includes(q) ||
           (setting.configKey && String(setting.configKey).toLowerCase().includes(q));
}

function renderControl(setting) {
    const val = settingsValues[setting.id] ?? setting.defaultValue;
    let controlHtml = '';
    switch (setting.type) {
        case 'toggle':
            controlHtml = '<label class="toggle"><input type="checkbox" data-key="' + (setting.configKey || '') + '" data-id="' + setting.id + '"' + (val ? ' checked' : '') + '><span class="toggle-slider"></span></label>';
            break;
        case 'select':
            const options = setting.id === 'mcp-connection-name'
                ? (settingsValues.mcpConnectionOptions || setting.options || [])
                : (setting.options || []);
            const valueType = options.some(opt => typeof opt.value === 'number') ? 'number' : 'string';
            let selHtml = '<select class="select-control" data-key="' + escapeHtml(String(setting.configKey || '')) + '" data-id="' + escapeHtml(String(setting.id || '')) + '" data-value-type="' + valueType + '">';
            for (const opt of options) {
                selHtml += '<option value="' + escapeHtml(String(opt.value)) + '"' + (String(val) === String(opt.value) ? ' selected' : '') + '>' + escapeHtml(String(opt.label)) + '</option>';
            }
            selHtml += '</select>';
            controlHtml = selHtml;
            break;
        case 'number':
            const numVal = val ?? setting.defaultValue ?? 0;
            const formatted = typeof numVal === 'number' ? numVal.toLocaleString('en-US') : String(numVal);
            // Only show formatted helper for large-number settings (whitelist by ID)
            const LARGE_NUMBER_IDS = [
                'query-row-limit', 'query-execution-timeout',
                'results-disk-threshold', 'results-disk-mem-threshold',
                'results-disk-batch', 'results-idle-spill-rows',
                'cache-ttl', 'memory-warning-bytes',
                'results-max-data', 'results-max-pinned',
                'filepreview-max-rows'
            ];
            const showFormatted = LARGE_NUMBER_IDS.includes(setting.id);
            const limits = NUMERIC_LIMITS[setting.configKey] || {};
            const min = limits.min !== undefined ? ' min="' + limits.min + '"' : '';
            const max = limits.max !== undefined ? ' max="' + limits.max + '"' : '';
            controlHtml = '<div class="number-control">' +
                '<input type="number" class="number-input" data-key="' + escapeHtml(String(setting.configKey || '')) + '" data-id="' + escapeHtml(String(setting.id || '')) + '" value="' + escapeHtml(String(numVal)) + '"' + min + max + '>' +
                (showFormatted ? '<span class="number-formatted" id="fmt-' + escapeHtml(String(setting.id || '')) + '">' + escapeHtml(formatted) + '</span>' : '') +
            '</div>';
            break;
        case 'text':
            controlHtml = '<input type="text" class="text-input" data-key="' + escapeHtml(String(setting.configKey || '')) + '" data-id="' + escapeHtml(String(setting.id || '')) + '" value="' + escapeHtml(String(val ?? setting.defaultValue ?? '')) + '">';
            break;
        case 'button':
            const cls = setting.id === 'clear-cache' ? 'btn btn-danger' : 'btn';
            controlHtml = '<button class="' + cls + '" data-action="' + escapeHtml(String(setting.action || '')) + '">' + escapeHtml(String(setting.actionLabel || 'Action')) + '</button>';
            break;
        case 'textarea':
            controlHtml = renderTextareaControl(setting);
            return controlHtml;
        case 'json':
            controlHtml = renderJsonControl(setting);
            return controlHtml;
        default:
            controlHtml = '';
            break;
    }
    // Add reset button for settings with a configKey
    if (setting.configKey && setting.type !== 'textarea') {
        const defaultHint = setting.defaultValue !== undefined ? 'Reset to default: ' + formatSettingValue(setting.defaultValue) : 'Reset to default';
        controlHtml += '<button class="reset-btn" data-reset-key="' + escapeHtml(String(setting.configKey)) + '" data-reset-id="' + escapeHtml(String(setting.id || '')) + '" title="' + escapeHtml(String(defaultHint)) + '" aria-label="Reset ' + escapeHtml(String(setting.label || setting.id || 'setting')) + ' to default">↺</button>';
    }
    return controlHtml;
}

function renderTextareaControl(setting) {
    const val = settingsValues[setting.id] ?? '';
    const defaultHint = setting.defaultValue !== undefined ? '↺ Reset to default: ' + setting.defaultValue : '↺ Reset to default prompt';
    const promptType = setting.id.replace('copilot-prompt-', '');
    return '<textarea class="textarea-control" data-key="' + (setting.configKey || '') + '" data-id="' + setting.id + '" placeholder="Customize this prompt...">' + escapeHtml(val) + '</textarea>' +
        '<div class="textarea-actions">' +
            '<button class="btn btn-test-prompt" data-prompt-id="' + setting.id + '" data-prompt-type="' + promptType + '" title="Send this prompt to AI with a test query">▶ Test Prompt</button>' +
            '<button class="reset-btn" data-reset-key="' + setting.configKey + '" data-reset-id="' + setting.id + '" title="' + escapeHtml(defaultHint) + '" aria-label="Reset ' + escapeHtml(String(setting.label || setting.id)) + ' to default">↺</button>' +
            '<span class="textarea-status" id="status-' + setting.id + '"></span>' +
        '</div>' +
        '<div class="prompt-test-result" id="test-result-' + setting.id + '"></div>';
}

function renderJsonControl(setting) {
    const value = settingsValues[setting.id] ?? setting.defaultValue ?? (setting.jsonKind === 'array' || setting.jsonKind === 'objectArray' ? [] : {});
    const serialized = JSON.stringify(value, null, 2);
    const defaultHint = setting.defaultValue !== undefined ? '↺ Reset to default: ' + formatSettingValue(setting.defaultValue) : '↺ Reset to default';
    return '<div class="json-control">' +
        '<textarea class="json-textarea" data-key="' + escapeHtml(String(setting.configKey || '')) + '" data-id="' + escapeHtml(String(setting.id || '')) + '" data-json-kind="' + escapeHtml(String(setting.jsonKind || '')) + '" spellcheck="false">' + escapeHtml(serialized) + '</textarea>' +
        '<div class="json-toolbar"><span class="json-status" id="json-status-' + escapeHtml(String(setting.id || '')) + '" role="status" aria-live="polite">Valid JSON</span>' +
        '<button class="reset-btn" data-reset-key="' + escapeHtml(String(setting.configKey || '')) + '" data-reset-id="' + escapeHtml(String(setting.id || '')) + '" title="' + escapeHtml(defaultHint) + '" aria-label="Reset ' + escapeHtml(String(setting.label || setting.id || 'setting')) + ' to default">↺</button></div>' +
        '</div>';
}

function formatSettingValue(value) {
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return String(value);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
}

function renderQuickActions() {
    return '<div class="quick-actions">' +
        '<div class="section-header"><span class="section-title">Quick Actions</span></div>' +
        '<div class="footer-links">' +
            '<button class="footer-link btn" data-action="openConnection">Connect to Database</button>' +
            '<button class="footer-link btn" data-action="refreshSchema">Refresh Schema</button>' +
            '<button class="footer-link btn" data-action="showMetadataStats">Metadata Cache Stats</button>' +
        '</div>' +
    '</div>';
}

function sendCmd(cmd) {
    vscode.postMessage({ command: cmd });
}



// ── Attach Event Listeners ──
function attachControlListeners() {
    // Toggles
    document.querySelectorAll('.toggle input[type="checkbox"]').forEach(el => {
        el.addEventListener('change', () => {
            const key = el.dataset.key;
            const id = el.dataset.id;
            settingsValues[id] = el.checked;
            vscode.postMessage({ command: 'updateSetting', key: key, value: el.checked });
            showToast('Setting updated');
        });
    });

    // Selects
    document.querySelectorAll('.select-control').forEach(el => {
        el.addEventListener('change', () => {
            const key = el.dataset.key;
            const id = el.dataset.id;
            const value = el.dataset.valueType === 'number' ? Number(el.value) : el.value;
            settingsValues[id] = value;
            vscode.postMessage({ command: 'updateSetting', key: key, value: value });
            showToast('Setting updated');
        });
    });

    // Numbers
    document.querySelectorAll('.number-input').forEach(el => {
        let debounce;
        el.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                const key = el.dataset.key;
                const id = el.dataset.id;
                const numVal = parseInt(el.value, 10);
                if (!isNaN(numVal)) {
                    settingsValues[id] = numVal;
                    vscode.postMessage({ command: 'updateSetting', key: key, value: numVal });
                    showToast('Setting updated');
                    // Update formatted helper in-place (#6)
                    const fmtEl = document.getElementById('fmt-' + id);
                    if (fmtEl) {
                        fmtEl.textContent = numVal.toLocaleString('en-US');
                    }
                }
            }, 500);
        });
    });

    // Text inputs
    document.querySelectorAll('.text-input').forEach(el => {
        el.addEventListener('change', () => {
            const key = el.dataset.key;
            const id = el.dataset.id;
            if (key && id) {
                settingsValues[id] = el.value;
                vscode.postMessage({ command: 'updateSetting', key: key, value: el.value });
            }
        });
    });

    // Buttons
    document.querySelectorAll('.btn[data-action]').forEach(el => {
        el.addEventListener('click', () => {
            const action = el.dataset.action;
            // Handle New Snippet locally instead of round-trip to host (#3)
            if (action === 'newSnippet') {
                openSnippetModal();
                return;
            }
            vscode.postMessage({ command: action });
        });
    });

    // Textareas — auto-save with debounce
    document.querySelectorAll('.textarea-control').forEach(el => {
        const key = el.dataset.key;
        const id = el.dataset.id;
        const statusEl = document.getElementById('status-' + id);
        let debounce;
        el.addEventListener('input', () => {
            clearTimeout(debounce);
            if (statusEl) {
                statusEl.textContent = 'Unsaved changes...';
                statusEl.className = 'textarea-status visible';
            }
            debounce = setTimeout(async () => {
                if (key) {
                    vscode.postMessage({ command: 'updateSetting', key: key, value: el.value });
                }
            }, 800);
        });
    });

    // JSON settings — validate locally before sending structured values to the host.
    document.querySelectorAll('.json-textarea').forEach(el => {
        const key = el.dataset.key;
        const id = el.dataset.id;
        const kind = el.dataset.jsonKind;
        const statusEl = id ? document.getElementById('json-status-' + id) : null;
        let debounce;
        el.addEventListener('input', () => {
            clearTimeout(debounce);
            if (statusEl) {
                statusEl.textContent = 'Checking JSON...';
                statusEl.className = 'json-status pending';
            }
            debounce = setTimeout(() => {
                try {
                    const value = JSON.parse(el.value);
                    validateJsonValue(value, kind);
                    if (key && id) {
                        settingsValues[id] = value;
                        vscode.postMessage({ command: 'updateSetting', key: key, value: value });
                    }
                    el.removeAttribute('aria-invalid');
                    if (statusEl) {
                        statusEl.textContent = '✓ Valid JSON';
                        statusEl.className = 'json-status valid';
                    }
                } catch (error) {
                    el.setAttribute('aria-invalid', 'true');
                    if (statusEl) {
                        statusEl.textContent = '✗ ' + (error instanceof Error ? error.message : 'Invalid JSON');
                        statusEl.className = 'json-status invalid';
                    }
                }
            }, 500);
        });
    });

    // Test Prompt buttons
    document.querySelectorAll('.btn-test-prompt[data-prompt-id]').forEach(el => {
        el.addEventListener('click', () => {
            if (el.classList.contains('loading')) return;
            const promptId = el.dataset.promptId;
            const promptType = el.dataset.promptType;
            const textarea = document.querySelector('.textarea-control[data-id="' + promptId + '"]');
            if (textarea && promptType) {
                el.classList.add('loading');
                const promptText = textarea.value;
                const resultEl = document.getElementById('test-result-' + promptId);
                if (resultEl) {
                    resultEl.innerHTML = '<span class="loading-spinner"></span> Contacting AI...';
                    resultEl.className = 'prompt-test-result visible loading';
                }
                vscode.postMessage({ command: 'testPrompt', key: promptType, value: promptText });
            }
        });
    });

    // Section reset button
    document.querySelectorAll('.section-reset-btn[data-section-reset]').forEach(el => {
        el.addEventListener('click', () => {
            const sectionId = el.dataset.sectionReset;
            if (sectionId) {
                const section = SECTIONS.find(s => s.id === sectionId);
                const resettableCount = section ? section.settings.filter(s => s.configKey).length : 0;
                if (resettableCount >= 3) {
                    if (!confirm('Reset all ' + resettableCount + ' settings in \u0022' + section.title + '\u0022 to their defaults?')) {
                        return;
                    }
                }
                vscode.postMessage({ command: 'resetSection', key: sectionId });
                showToast('Resetting all settings...');
            }
        });
    });

    // Reset buttons
    document.querySelectorAll('.reset-btn[data-reset-key]').forEach(el => {
        el.addEventListener('click', () => {
            const key = el.dataset.resetKey;
            const id = el.dataset.resetId;
            if (key) {
                vscode.postMessage({ command: 'resetSetting', key: key });
                showToast('Resetting to default...');
            }
        });
    });

}

function validateJsonValue(value, kind) {
    if (kind === 'array') {
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
            throw new Error('Expected a JSON array of strings');
        }
        return;
    }
    if (kind === 'objectArray') {
        if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
            throw new Error('Expected a JSON array of objects');
        }
        return;
    }
    const levels = ['error', 'warning', 'information', 'hint', 'off'];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected a JSON object');
    }
    for (const [rule, level] of Object.entries(value)) {
        if (!rule.trim() || typeof level !== 'string' || !levels.includes(level)) {
            throw new Error('Rule values must be error, warning, information, hint, or off');
        }
    }
}

// ── Toast ──
let toastTimer;
function showToast(msg, variant) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.classList.toggle('error', variant === 'error');
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

// ── Search ──
document.getElementById('searchInput').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();

    if (currentSection === 'snippets') {
        // Inline filter — use cached data, no round-trip
        // If cache is empty, wait for initial load (data arriving via snippetsData)
        if (cachedUserSnippets.length > 0 || cachedPredefinedSnippets.length > 0) {
            renderSnippetsContent(cachedUserSnippets, cachedPredefinedSnippets);
        }
        return;
    }

    if (searchQuery) {
        // Search across ALL sections
        const wrapper = document.getElementById('contentWrapper');
        let html = '<div class="section-header"><span class="section-title">Search Results</span></div>';

        let foundAny = false;
        for (const section of SECTIONS) {
            const sectionSettings = Array.isArray(section.settings) ? section.settings : [];
            const matchingSettings = sectionSettings.filter(s => matchesFilter(s, searchQuery));
            if (matchingSettings.length > 0) {
                foundAny = true;
                html += '<div class="section-group">';
                html += '<div class="section-group-title">' + escapeHtml(String(section.title || section.id)) + '</div>';
                html += '<div class="settings-card">';
                for (const setting of matchingSettings) {
                    html += renderSettingRow(setting);
                }
                html += '</div></div>';
            }
        }

        if (!foundAny) {
            html += '<div class="search-empty">';
            html += '<div class="search-empty-icon" aria-hidden="true">🔍</div>';
            html += '<div class="search-empty-title">No settings found</div>';
            html += '<div class="search-empty-hint">Try a different search term</div>';
            html += '</div>';
        }

        wrapper.innerHTML = html;

        // Re-attach listeners for search results
        attachControlListeners();
    } else {
        renderContent();
    }
});

// ── Message Handler ──
window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.command) {
        case 'settingsData':
            settingsValues = msg.data || {};
            renderContent();
            break;
        case 'settingUpdated':
            if (msg.success) {
                showToast('Saved');
                const input = document.querySelector('[data-key="' + msg.key + '"]');
                const statusEl = input && document.getElementById('status-' + input.dataset.id);
                if (statusEl) {
                    statusEl.textContent = '✓ Saved';
                    statusEl.className = 'textarea-status visible saved';
                    setTimeout(() => { statusEl.className = 'textarea-status'; }, 2000);
                }
                const jsonStatusEl = input && document.getElementById('json-status-' + input.dataset.id);
                if (jsonStatusEl) {
                    jsonStatusEl.textContent = '✓ Saved';
                    jsonStatusEl.className = 'json-status valid';
                }
            } else {
                showToast('✗ Save failed: ' + (msg.error || 'Unknown error'), 'error');
                vscode.postMessage({ command: 'getSettings' });
            }
            break;
        case 'settingReset':
            showToast('Reset to default');
            break;
        case 'sectionReset':
            showToast('✓ Section reset (' + (msg.count || 0) + ' settings restored to default)');
            break;
        case 'operationFailed':
            showToast('✗ Operation failed: ' + (msg.error || 'Unknown error'), 'error');
            vscode.postMessage({ command: 'getSettings' });
            break;
        case 'snippetsData':
            if (currentSection === 'snippets') {
                renderSnippetsContent(msg.userSnippets || [], msg.predefined || []);
            }
            break;
        case 'snippetCreated':
            if (msg.success) {
                showToast('✓ Snippet created');
                const nameInput = document.getElementById('newSnippetName');
                const sqlInput = document.getElementById('newSnippetSql');
                if (nameInput) nameInput.value = '';
                if (sqlInput) sqlInput.value = '';
                closeSnippetModal();
            } else {
                showToast('✗ Failed: ' + (msg.error || 'Unknown error'), 'error');
            }
            break;
        case 'snippetUpdated':
            if (msg.success) {
                showToast('✓ Snippet saved');
                const statusEl2 = document.getElementById('snippet-status-' + msg.id);
                if (statusEl2) {
                    statusEl2.textContent = '✓ Saved';
                    statusEl2.className = 'snippet-status saved';
                    setTimeout(() => { statusEl2.className = 'snippet-status'; }, 2000);
                }
            } else {
                const errorStatus = document.getElementById('snippet-status-' + msg.id);
                if (errorStatus) { errorStatus.textContent = '✗ ' + (msg.error || 'Error'); }
            }
            break;
        case 'snippetDeleted':
            if (msg.success) {
                showToast('✓ Snippet deleted');
            } else {
                showToast('✗ Delete failed: ' + (msg.error || 'Error'), 'error');
            }
            break;
        case 'testPromptResult':
            const resultId = 'copilot-prompt-' + msg.promptType;
            const resultEl = document.getElementById('test-result-' + resultId);
            // Re-enable the test button
            const testBtn = document.querySelector('.btn-test-prompt[data-prompt-id="' + resultId + '"]');
            if (testBtn) testBtn.classList.remove('loading');
            if (resultEl) {
                if (msg.status === 'loading') {
                    resultEl.innerHTML = '<span class="loading-spinner"></span> Contacting AI...';
                    resultEl.className = 'prompt-test-result visible loading';
                } else if (msg.status === 'success') {
                    resultEl.textContent = msg.result;
                    resultEl.className = 'prompt-test-result visible';
                } else if (msg.status === 'error') {
                    resultEl.textContent = '❌ ' + (msg.error || 'Unknown error');
                    resultEl.className = 'prompt-test-result visible error';
                }
            }
            break;
    }
});

// ── Init ──
renderNav();
renderContent();
vscode.postMessage({ command: 'getSettings' });

// ── Modal ──
let modalReturnFocus = null;

function getFocusableElements(container) {
    return Array.from(container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(element => !element.disabled && element.offsetParent !== null);
}

function openSnippetModal() {
    const overlay = document.getElementById('newSnippetOverlay');
    if (!overlay) return;
    modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.classList.add('show');
    const nameInput = document.getElementById('newSnippetName');
    if (nameInput) nameInput.focus();
}

function closeSnippetModal() {
    const overlay = document.getElementById('newSnippetOverlay');
    if (!overlay) return;
    overlay.classList.remove('show');
    const returnTarget = modalReturnFocus;
    modalReturnFocus = null;
    if (returnTarget && document.contains(returnTarget)) returnTarget.focus();
}

document.addEventListener('keydown', event => {
    const overlay = document.getElementById('newSnippetOverlay');
    const isOpen = Boolean(overlay && overlay.classList.contains('show'));

    if (isOpen && event.key === 'Escape') {
        event.preventDefault();
        closeSnippetModal();
        return;
    }

    if (isOpen && event.key === 'Tab' && overlay) {
        const focusable = getFocusableElements(overlay);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
        return;
    }

    const target = event.target;
    const isTyping = target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (!isTyping && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            event.preventDefault();
            searchInput.focus();
            searchInput.select();
        }
    }
});

// ── Init ──
renderNav();
renderContent();
vscode.postMessage({ command: 'getSettings' });

// ── One-time shell init (outside attachControlListeners to avoid duplicates) ──
(function initShell() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.setAttribute('aria-label', 'Search settings');
    }

    const toast = document.getElementById('toast');
    if (toast) {
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.setAttribute('aria-atomic', 'true');
    }

    const overlay = document.getElementById('newSnippetOverlay');
    const modal = overlay ? overlay.querySelector('.new-snippet-modal') : null;
    if (modal) {
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', 'New custom snippet');
    }

    const cancelBtn = document.getElementById('newSnippetCancel');
    const createBtn = document.getElementById('newSnippetCreate');
    if (cancelBtn) cancelBtn.addEventListener('click', closeSnippetModal);
    if (createBtn) createBtn.addEventListener('click', () => {
        const nameInput = document.getElementById('newSnippetName');
        const sqlInput = document.getElementById('newSnippetSql');
        if (!nameInput || !sqlInput) return;
        const name = nameInput.value.trim();
        const sql = sqlInput.value.trim();
        if (!name) {
            showToast('Name is required', 'error');
            nameInput.focus();
            return;
        }
        if (!sql) {
            showToast('SQL is required', 'error');
            sqlInput.focus();
            return;
        }
        vscode.postMessage({ command: 'createSnippet', value: { label: name, sql } });
    });
    if (overlay) {
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeSnippetModal();
        });
    }
})();
