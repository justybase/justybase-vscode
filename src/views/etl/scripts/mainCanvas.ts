/**
 * Main canvas operations for ETL Designer
 */

/**
 * Generates the main canvas script section
 */
export function getMainCanvasScript(): string {
    return `
        function renderNodes() {
            const container = document.getElementById('nodes-container');
            container.innerHTML = '';

            for (const node of project.nodes) {
                const el = createNodeElement(node);
                container.appendChild(el);
            }
        }

        function createNodeElement(node, isContainerChild = false) {
            const el = document.createElement('div');
            const isSelected = isContainerChild 
                ? containerSelectedNodeId === node.id 
                : selectedNodeId === node.id;
            el.className = 'etl-node ' + node.type + (isSelected ? ' selected' : '');
            el.id = (isContainerChild ? 'container-node-' : 'node-') + node.id;
            el.style.left = node.position.x + 'px';
            el.style.top = node.position.y + 'px';

            // Show child count badge for containers
            const childCountBadge = node.type === 'container' && node.config?.nodes?.length > 0
                ? \`<span class="node-child-count">\${node.config.nodes.length}</span>\`
                : '';

            el.innerHTML = \`
                <div class="node-actions">
                    <button class="node-delete-btn" data-node="\${node.id}" title="Delete task">×</button>
                </div>
                <div class="node-type-indicator"></div>
                <div class="node-content">
                    <div class="node-header">
                        <span class="node-icon">\${nodeIcons[node.type] || '📋'}</span>
                        <span class="node-name">\${escapeHtml(node.name)}\${childCountBadge}</span>
                    </div>
                    <div class="node-type">\${node.type}</div>
                </div>
                <div class="node-connectors">
                    <div class="connector input" data-node="\${node.id}" data-type="input"></div>
                    <div class="connector output" data-node="\${node.id}" data-type="output"></div>
                </div>
            \`;

            setupNodeEvents(el, node);
            return el;
        }

        function setupNodeEvents(el, node) {
            // Delete button click
            const deleteBtn = el.querySelector('.node-delete-btn');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    vscode.postMessage({ type: 'confirmRemoveNode', payload: node.id });
                });
            }

            // Drag
            el.addEventListener('mousedown', (e) => {
                if (e.target.classList.contains('connector')) return;
                if (e.target.classList.contains('node-delete-btn')) return;
                
                selectedNodeId = node.id;
                isDragging = true;
                
                const rect = el.getBoundingClientRect();
                dragOffset.x = (e.clientX - rect.left) / scale;
                dragOffset.y = (e.clientY - rect.top) / scale;
                
                // Update selection
                document.querySelectorAll('.etl-node').forEach(n => n.classList.remove('selected'));
                el.classList.add('selected');
                
                updatePropertiesPanel(node);
            });

            // Double-click to configure (or open container editor)
            el.addEventListener('dblclick', () => {
                if (node.type === 'container') {
                    openContainerEditor(node.id);
                } else {
                    vscode.postMessage({ type: 'configureNode', payload: node.id });
                }
            });

            // Connector events
            el.querySelectorAll('.connector').forEach(conn => {
                conn.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    if (conn.dataset.type === 'output') {
                        isConnecting = true;
                        connectionStart = node.id;
                        createTempLine(e);
                    }
                });

                conn.addEventListener('mouseup', (e) => {
                    if (isConnecting && conn.dataset.type === 'input' && connectionStart !== node.id) {
                        vscode.postMessage({
                            type: 'addConnection',
                            payload: { from: connectionStart, to: node.id }
                        });
                    }
                    endConnection();
                });
            });

            // Context menu for delete
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                vscode.postMessage({ type: 'confirmRemoveNode', payload: node.id });
            });
        }

        function setupToolboxDrag() {
            document.querySelectorAll('.toolbox-item').forEach(item => {
                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('nodeType', item.dataset.type);
                });
            });
        }

        function setupCanvasDrop() {
            const canvas = document.getElementById('canvas');
            
            canvas.addEventListener('dragover', (e) => {
                e.preventDefault();
                // Visual feedback for file drag
                if (e.dataTransfer.types.includes('Files')) {
                    canvas.classList.add('drag-over');
                }
            });

            canvas.addEventListener('dragleave', (e) => {
                canvas.classList.remove('drag-over');
            });
            
            canvas.addEventListener('drop', (e) => {
                e.preventDefault();
                canvas.classList.remove('drag-over');
                
                // Handle toolbox item drop (existing functionality)
                const nodeType = e.dataTransfer.getData('nodeType');
                if (nodeType) {
                    const rect = canvas.getBoundingClientRect();
                    const x = (e.clientX - rect.left - pan.x) / scale;
                    const y = (e.clientY - rect.top - pan.y) / scale;
                    
                    vscode.postMessage({
                        type: 'addNode',
                        payload: { type: nodeType, position: { x, y } }
                    });
                    return;
                }
                
                // Handle external file drop (new functionality)
                const files = e.dataTransfer.files;
                if (files && files.length > 0) {
                    const file = files[0];
                    const fileName = file.name.toLowerCase();
                    
                    // Check if it's an Excel or CSV file
                    if (fileName.endsWith('.xlsx') || fileName.endsWith('.xlsb') || 
                        fileNameName.endsWith('.csv') || fileName.endsWith('.txt')) {
                        
                        const rect = canvas.getBoundingClientRect();
                        const x = (e.clientX - rect.left - pan.x) / scale;
                        const y = (e.clientY - rect.top - pan.y) / scale;
                        
                        // Send file path to extension for processing
                        vscode.postMessage({
                            type: 'dropFile',
                            payload: { 
                                filePath: file.path,
                                fileName: file.name,
                                position: { x, y }
                            }
                        });
                    } else {
                        vscode.postMessage({
                            type: 'showError',
                            payload: 'Unsupported file format. Only XLSX, XLSB, CSV, and TXT files are supported.'
                        });
                    }
                }
            });

            // Mouse move for dragging and connecting
            document.addEventListener('mousemove', (e) => {
                if (isDragging && selectedNodeId) {
                    const canvas = document.getElementById('canvas');
                    const rect = canvas.getBoundingClientRect();
                    const x = (e.clientX - rect.left - pan.x) / scale - dragOffset.x;
                    const y = (e.clientY - rect.top - pan.y) / scale - dragOffset.y;
                    
                    // Update node position in DOM
                    const nodeEl = document.getElementById('node-' + selectedNodeId);
                    if (nodeEl) {
                        nodeEl.style.left = Math.max(0, x) + 'px';
                        nodeEl.style.top = Math.max(0, y) + 'px';
                    }
                    
                    // Update connections
                    const node = project.nodes.find(n => n.id === selectedNodeId);
                    if (node) {
                        node.position = { x: Math.max(0, x), y: Math.max(0, y) };
                        renderConnections();
                    }
                }
                
                if (isConnecting && tempLine) {
                    updateTempLine(e);
                }
            });

            document.addEventListener('mouseup', (e) => {
                if (isDragging && selectedNodeId) {
                    // Save position
                    const node = project.nodes.find(n => n.id === selectedNodeId);
                    if (node) {
                        vscode.postMessage({
                            type: 'updateNodePosition',
                            payload: { nodeId: selectedNodeId, position: node.position }
                        });
                    }
                }
                
                isDragging = false;
                endConnection();
            });

            // Deselect on canvas click
            canvas.addEventListener('click', (e) => {
                if (e.target === canvas || e.target.classList.contains('nodes-layer')) {
                    selectedNodeId = null;
                    document.querySelectorAll('.etl-node').forEach(n => n.classList.remove('selected'));
                    updatePropertiesPanel(null);
                }
            });
        }
    `;
}
