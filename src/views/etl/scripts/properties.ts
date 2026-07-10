/**
 * Properties panel rendering for ETL Designer
 */

/**
 * Generates the properties panel script section
 */
export function getPropertiesScript(): string {
    return `
        function updatePropertiesPanel(node) {
            const content = document.getElementById('properties-content');
            
            if (!node) {
                content.innerHTML = '<p class="placeholder">Select a task to view properties</p>';
                return;
            }
            
            let configHtml = '';
            const config = node.config;
            
            switch (node.type) {
                case 'sql':
                    const queryPreview = config.query 
                        ? (config.query.length > 100 ? config.query.substring(0, 100) + '...' : config.query)
                        : '(not configured)';
                    configHtml = \`
                        <div class="property-group">
                            <span class="property-label">Connection</span>
                            <div class="property-value">\${escapeHtml(config.connection || 'Active connection')}</div>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Query</span>
                            <pre class="property-code">\${escapeHtml(queryPreview)}</pre>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Timeout</span>
                            <div class="property-value">\${config.timeout ? config.timeout + 's' : '(default)'}</div>
                        </div>
                    \`;
                    break;
                case 'python':
                    let scriptInfo = '(not configured)';
                    if (config.scriptPath) {
                        const pathParts = config.scriptPath.split(/[/\\\\\\\\]/);
                        scriptInfo = '📁 ' + pathParts[pathParts.length - 1];
                    } else if (config.script) {
                        const preview = config.script.length > 50 ? config.script.substring(0, 50) + '...' : config.script;
                        scriptInfo = preview;
                    }
                    configHtml = \`
                        <div class="property-group">
                            <span class="property-label">Script Source</span>
                            <div class="property-value">\${config.scriptPath ? 'File' : (config.script ? 'Inline' : 'Not set')}</div>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Script</span>
                            <pre class="property-code">\${escapeHtml(scriptInfo)}</pre>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Interpreter</span>
                            <div class="property-value">\${escapeHtml(config.pythonPath || 'Auto-detect')}</div>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Timeout</span>
                            <div class="property-value">\${config.timeout ? config.timeout + 's' : '(default)'}</div>
                        </div>
                    \`;
                    break;
                case 'export':
                    const outPath = config.outputPath 
                        ? config.outputPath.split(/[/\\\\\\\\]/).pop() 
                        : '(not configured)';
                    const exportQueryPreview = config.query 
                        ? (config.query.length > 50 ? config.query.substring(0, 50) + '...' : config.query)
                        : '(uses previous output)';
                    configHtml = \`
                        <div class="property-group">
                            <span class="property-label">Format</span>
                            <div class="property-value">\${config.format?.toUpperCase() || '(not set)'}</div>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Output File</span>
                            <div class="property-value">📄 \${escapeHtml(outPath)}</div>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Query</span>
                            <pre class="property-code">\${escapeHtml(exportQueryPreview)}</pre>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Timeout</span>
                            <div class="property-value">\${config.timeout ? config.timeout + 's' : '(default)'}</div>
                        </div>
                    \`;
                    break;
                case 'import':
                    const inPath = config.inputPath 
                        ? config.inputPath.split(/[/\\\\\\\\]/).pop() 
                        : '(not configured)';
                    configHtml = \`
                        <div class="property-group">
                            <span class="property-label">Format</span>
                            <div class="property-value">\${config.format?.toUpperCase() || 'Auto-detect'}</div>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Input File</span>
                            <div class="property-value">📄 \${escapeHtml(inPath)}</div>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Target Table</span>
                            <div class="property-value">\${escapeHtml(config.targetTable || '(not set)')}</div>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Create Table</span>
                            <div class="property-value">\${config.createTable !== false ? 'Yes (if needed)' : 'No'}</div>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Timeout</span>
                            <div class="property-value">\${config.timeout ? config.timeout + 's' : '(default)'}</div>
                        </div>
                    \`;
                    break;
                case 'container':
                    const childCount = (config.nodes || []).length;
                    configHtml = \`
                        <div class="property-group">
                            <span class="property-label">Child Tasks</span>
                            <div class="property-value">\${childCount} task(s)</div>
                        </div>
                    \`;
                    break;
                case 'variable':
                    const sourceLabels = {
                        'prompt': '📝 Prompt User',
                        'static': '🔒 Static Value',
                        'sql': '🗄️ SQL Query'
                    };
                    const sourceLabel = sourceLabels[config.source] || config.source;
                    let varDetails = '';
                    if (config.source === 'prompt') {
                        varDetails = \`
                            <div class="property-group">
                                <span class="property-label">Prompt Message</span>
                                <div class="property-value">\${escapeHtml(config.promptMessage || '(default)')}</div>
                            </div>
                            <div class="property-group">
                                <span class="property-label">Default Value</span>
                                <div class="property-value">\${escapeHtml(config.defaultValue || '(none)')}</div>
                            </div>
                        \`;
                    } else if (config.source === 'static') {
                        varDetails = \`
                            <div class="property-group">
                                <span class="property-label">Value</span>
                                <pre class="property-code">\${escapeHtml(config.value || '(empty)')}</pre>
                            </div>
                        \`;
                    } else if (config.source === 'sql') {
                        const sqlPreview = config.query 
                            ? (config.query.length > 50 ? config.query.substring(0, 50) + '...' : config.query)
                            : '(not configured)';
                        varDetails = \`
                            <div class="property-group">
                                <span class="property-label">Query</span>
                                <pre class="property-code">\${escapeHtml(sqlPreview)}</pre>
                            </div>
                            <div class="property-group">
                                <span class="property-label">Timeout</span>
                                <div class="property-value">\${config.timeout ? config.timeout + 's' : '(default)'}</div>
                            </div>
                        \`;
                    }
                    const varNameDisplay = config.variableName ? ('$' + '{' + escapeHtml(config.variableName) + '}') : '(not set)';
                    configHtml = \`
                        <div class="property-group">
                            <span class="property-label">Variable Name</span>
                            <div class="property-value" style="font-family: monospace;">\${varNameDisplay}</div>
                        </div>
                        <div class="property-group">
                            <span class="property-label">Source</span>
                            <div class="property-value">\${sourceLabel}</div>
                        </div>
                        \${varDetails}
                    \`;
                    break;
            }
            
            content.innerHTML = \`
                <div class="property-group">
                    <span class="property-label">ID</span>
                    <div class="property-value" style="font-family: monospace; font-size: 0.75em;">\${node.id}</div>
                </div>
                <div class="property-group">
                    <span class="property-label">Name</span>
                    <div class="property-value">\${escapeHtml(node.name)}</div>
                </div>
                <div class="property-group">
                    <span class="property-label">Type</span>
                    <div class="property-value">\${node.type.toUpperCase()}</div>
                </div>
                <div class="property-group">
                    <span class="property-label">Position</span>
                    <div class="property-value">(\${node.position.x}, \${node.position.y})</div>
                </div>
                <hr style="border: none; border-top: 1px solid var(--border-color); margin: 12px 0;">
                <h4 style="margin: 8px 0; font-size: 0.85em; color: var(--text-muted);">⚙️ Configuration</h4>
                \${configHtml}
                <button class="configure-btn" data-node-id="\${node.id}">
                    ✏️ Edit Configuration
                </button>
            \`;
            
            // Attach event listener to configure button (CSP-safe)
            const configBtn = content.querySelector('.configure-btn');
            if (configBtn) {
                configBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'configureNode', payload: node.id });
                });
            }
        }
    `;
}
