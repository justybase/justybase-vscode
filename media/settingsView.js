const vscode = acquireVsCodeApi();
const settingsConfig = JSON.parse(document.getElementById('settingsConfig').textContent || '{}');
const SECTIONS = settingsConfig.sections || [];
const NUMERIC_LIMITS = settingsConfig.numericLimits || {};
let currentSection = SECTIONS[0].id;
let settingsValues = {};
let searchQuery = '';
let cachedUserSnippets = [];
let cachedPredefinedSnippets = [];

// ── Render Sidebar Navigation ──
function renderNav() {
    const nav = document.getElementById('sidebarNav');
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
        'snippets': '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="8 10 12 14 16 10"/></svg>'
    };
    nav.innerHTML = SECTIONS.map(s =>
        '<div class="nav-item' + (s.id === currentSection ? ' active' : '') + '" data-section="' + s.id + '">' +
            '<span class="nav-icon">' + (icons[s.id] || '') + '</span>' +
            '<span>' + s.title + '</span>' +
        '</div>'
    ).join('');

    nav.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            currentSection = item.dataset.section;
            renderNav();
            renderContent();
            document.getElementById('mainContent').scrollTop = 0;
        });
    });
}

// ── Render Settings Content ──
function renderContent() {
    const wrapper = document.getElementById('contentWrapper');
    const section = SECTIONS.find(s => s.id === currentSection);
    if (!section) return;

    const hasResettable = section.settings.some(s => s.configKey);
    let html = '<div class="section-header">' +
        '<span class="section-icon"></span>' +
        '<span class="section-title">' + section.title + '</span>';
    if (hasResettable) {
        html += '<button class="section-reset-btn" data-section-reset="' + section.id + '" title="Reset all settings in this section to defaults">↺ Reset All</button>';
    }
    html += '</div>';
    if (section.description) {
        html += '<div class="section-description">' + section.description + '</div>';
    }

    html += '<div class="settings-card">';
    for (const setting of section.settings) {
        const matchesSearch = !searchQuery || matchesFilter(setting, searchQuery);
        const isTextarea = setting.type === 'textarea';
        html += '<div class="setting-row' + (isTextarea ? ' textarea-row' : '') + (matchesSearch ? '' : ' search-hidden') + '" data-setting-id="' + setting.id + '" data-label="' + (setting.label + ' ' + setting.description).toLowerCase() + '">';
        html += '<div class="setting-info">';
        html += '<div class="setting-label">';
        html += setting.label + '</div>';
        html += '<div class="setting-desc">' + setting.description + '</div>';
        html += '</div>';
        html += '<div class="setting-control">' + renderControl(setting) + '</div>';
        html += '</div>';
    }
    html += '</div>';

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
        html += '<div style="margin-bottom:16px;">';
        for (const sn of visiblePredefined) {
            const prefixText = sn.prefix.length > 0 ? sn.prefix.join(', ') : '—';
            html += '<div class="snippet-item" style="margin-bottom:6px;">' +
                '<div class="snippet-header">' +
                    '<span class="snippet-prefix">' + escapeHtml(prefixText) + '</span>' +
                    '<span style="flex:1;font-size:12px;font-weight:500;">' + escapeHtml(sn.name) + '</span>' +
                '</div>' +
                '<div class="snippet-body" style="font-size:11px;color:var(--fg-dim);padding:6px 12px;">' +
                    escapeHtml(sn.description) +
                '</div>' +
            '</div>';
        }
        if (filteredPredefined.length > visiblePredefined.length && !q) {
            html += '<div style="text-align:center;padding:8px;font-size:11px;color:var(--fg-muted);">+' + (filteredPredefined.length - 10) + ' more snippets. <a href="#" class="footer-link btn" data-action="openSnippetsFile" style="display:inline-flex;padding:2px 8px;">Open file</a></div>';
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
            '<button class="btn btn-primary" data-snippet-save="' + sn.id + '" style="padding:3px 10px;font-size:11px;">Save</button>' +
            '<button class="btn btn-danger" data-snippet-delete="' + sn.id + '" style="padding:3px 10px;font-size:11px;">Delete</button>' +
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
    return setting.label.toLowerCase().includes(q) ||
           setting.description.toLowerCase().includes(q) ||
           (setting.configKey && setting.configKey.toLowerCase().includes(q));
}

function renderControl(setting) {
    const val = settingsValues[setting.id];
    let controlHtml = '';
    switch (setting.type) {
        case 'toggle':
            controlHtml = '<label class="toggle"><input type="checkbox" data-key="' + (setting.configKey || '') + '" data-id="' + setting.id + '"' + (val ? ' checked' : '') + '><span class="toggle-slider"></span></label>';
            break;
        case 'select':
            const valueType = (setting.options || []).some(opt => typeof opt.value === 'number') ? 'number' : 'string';
            let selHtml = '<select class="select-control" data-key="' + (setting.configKey || '') + '" data-id="' + setting.id + '" data-value-type="' + valueType + '">';
            for (const opt of (setting.options || [])) {
                selHtml += '<option value="' + opt.value + '"' + (String(val) === String(opt.value) ? ' selected' : '') + '>' + opt.label + '</option>';
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
            controlHtml = '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:1px;">' +
                '<input type="number" class="number-input" data-key="' + (setting.configKey || '') + '" data-id="' + setting.id + '" value="' + numVal + '"' + min + max + '>' +
                (showFormatted ? '<span class="number-formatted" id="fmt-' + setting.id + '">' + formatted + '</span>' : '') +
            '</div>';
            break;
        case 'text':
            controlHtml = '<input type="text" class="text-input" data-key="' + (setting.configKey || '') + '" data-id="' + setting.id + '" value="' + escapeHtml(String(val ?? setting.defaultValue ?? '')) + '">';
            break;
        case 'button':
            const cls = setting.id === 'clear-cache' ? 'btn btn-danger' : 'btn';
            controlHtml = '<button class="' + cls + '" data-action="' + (setting.action || '') + '">' + (setting.actionLabel || 'Action') + '</button>';
            break;
        case 'textarea':
            controlHtml = renderTextareaControl(setting);
            return controlHtml;
        default:
            controlHtml = '';
            break;
    }
    // Add reset button for settings with a configKey
    if (setting.configKey && setting.type !== 'textarea') {
        const defaultHint = setting.defaultValue !== undefined ? 'Reset to default: ' + setting.defaultValue : 'Reset to default';
        controlHtml += '<button class="reset-btn" data-reset-key="' + setting.configKey + '" data-reset-id="' + setting.id + '" title="' + escapeHtml(String(defaultHint)) + '">↺</button>';
    }
    return controlHtml;
}

function renderTextareaControl(setting) {
    const val = settingsValues[setting.id] ?? '';
    const defaultHint = setting.defaultValue !== undefined ? '↺ Reset to default: ' + setting.defaultValue : '↺ Reset to default prompt';
    const promptType = setting.id.replace('copilot-prompt-', '');
    return '<textarea class="textarea-control" data-key="' + (setting.configKey || '') + '" data-id="' + setting.id + '" placeholder="Customize this prompt...">' + escapeHtml(val) + '</textarea>' +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:4px;">' +
            '<button class="btn btn-test-prompt" data-prompt-id="' + setting.id + '" data-prompt-type="' + promptType + '" title="Send this prompt to AI with a test query">▶ Test Prompt</button>' +
            '<button class="reset-btn" data-reset-key="' + setting.configKey + '" data-reset-id="' + setting.id + '" title="' + escapeHtml(defaultHint) + '">↺</button>' +
            '<span class="textarea-status" id="status-' + setting.id + '"></span>' +
        '</div>' +
        '<div class="prompt-test-result" id="test-result-' + setting.id + '"></div>';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
}

function renderQuickActions() {
    return '<div style="margin-top: 20px;">' +
        '<div class="section-header"><span class="section-icon"></span><span class="section-title">Quick Actions</span></div>' +
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
                document.getElementById('newSnippetOverlay')?.classList.add('show');
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

// ── Toast ──
function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1800);
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
        let html = '<div class="section-header"><span class="section-icon"></span><span class="section-title">Search Results</span></div>';

        let foundAny = false;
        for (const section of SECTIONS) {
            const matchingSettings = section.settings.filter(s => matchesFilter(s, searchQuery));
            if (matchingSettings.length > 0) {
                foundAny = true;
                html += '<div class="section-group" style="margin-bottom:20px;">';
                html += '<div class="section-description" style="margin-bottom:6px;font-weight:600;color:var(--fg);">' + section.title + '</div>';
                html += '<div class="settings-card">';
                for (const setting of matchingSettings) {
                    const isTextarea = setting.type === 'textarea';
                    html += '<div class="setting-row' + (isTextarea ? ' textarea-row' : '') + '" data-setting-id="' + setting.id + '">';
                    html += '<div class="setting-info">';
                    html += '<div class="setting-label">';
                    html += setting.label + '</div>';
                    html += '<div class="setting-desc">' + setting.description + '</div>';
                    html += '</div>';
                    html += '<div class="setting-control">' + renderControl(setting) + '</div>';
                    html += '</div>';
                }
                html += '</div></div>';
            }
        }

        if (!foundAny) {
            html += '<div style="text-align:center;padding:40px 20px;color:var(--fg-dim);">';
            html += '<div style="font-size:20px;margin-bottom:8px;font-weight:500;">No settings found</div>';
            html += '<div style="font-size:12px;margin-top:4px;">Try a different search term</div>';
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
            } else {
                showToast('✗ Save failed: ' + (msg.error || 'Unknown error'));
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
            showToast('✗ Operation failed: ' + (msg.error || 'Unknown error'));
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
                document.getElementById('newSnippetOverlay')?.classList.remove('show');
                document.getElementById('newSnippetName').value = '';
                document.getElementById('newSnippetSql').value = '';
            } else {
                showToast('✗ Failed: ' + (msg.error || 'Unknown error'));
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
                showToast('✗ Delete failed: ' + (msg.error || 'Error'));
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

// ── One-time modal init (outside attachControlListeners to avoid duplicates) ──
(function initModal() {
    const cancelBtn = document.getElementById("newSnippetCancel");
    const createBtn = document.getElementById("newSnippetCreate");
    const overlay = document.getElementById("newSnippetOverlay");
    if (cancelBtn) cancelBtn.addEventListener("click", () => document.getElementById("newSnippetOverlay")?.classList.remove("show"));
    if (createBtn) createBtn.addEventListener("click", () => {
        const nameInput = document.getElementById("newSnippetName");
        const sqlInput = document.getElementById("newSnippetSql");
        if (nameInput && sqlInput) {
            const name = nameInput.value.trim();
            const sql = sqlInput.value.trim();
            if (!name) { showToast("Name is required"); return; }
            if (!sql) { showToast("SQL is required"); return; }
            vscode.postMessage({ command: "createSnippet", value: { label: name, sql: sql } });
        }
    });
    if (overlay) overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.classList.remove("show");
    });
})();
