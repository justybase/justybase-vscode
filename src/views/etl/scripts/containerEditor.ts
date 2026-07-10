/**
 * Container editor functionality for ETL Designer
 */

/**
 * Generates the container editor script section
 */
export function getContainerEditorScript(): string {
    return `
        function setupContainerEditor() {
            // Close button
            document.getElementById('container-editor-close').addEventListener('click', closeContainerEditor);
            document.getElementById('container-editor-cancel').addEventListener('click', closeContainerEditor);
            document.getElementById('container-editor-save').addEventListener('click', saveContainerAndClose);

            // Toolbox drag for container editor
            document.querySelectorAll('.toolbox-item[data-container="true"]').forEach(item => {
                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('containerNodeType', item.dataset.type);
                });
            });

            // Canvas drop for container editor
            const containerCanvas = document.getElementById('container-canvas');
            containerCanvas.addEventListener('dragover', (e) => e.preventDefault());
            containerCanvas.addEventListener('drop', (e) => {
                e.preventDefault();
                const nodeType = e.dataTransfer.getData('containerNodeType');
                if (nodeType && containerEditorOpen) {
                    const rect = containerCanvas.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    addContainerChildNode(nodeType, { x, y });
                }
            });

            // Click to deselect in container canvas
            containerCanvas.addEventListener('click', (e) => {
                if (e.target === containerCanvas || e.target.id === 'container-nodes' || e.target.id === 'container-zoom-wrapper') {
                    containerSelectedNodeId = null;
                    document.querySelectorAll('#container-nodes .etl-node').forEach(n => n.classList.remove('selected'));
                }
            });

            // Mouse move for container dragging
            document.addEventListener('mousemove', (e) => {
                if (containerIsDragging && containerSelectedNodeId) {
                    const canvas = document.getElementById('container-canvas');
                    const rect = canvas.getBoundingClientRect();
                    const x = e.clientX - rect.left - containerDragOffset.x;
                    const y = e.clientY - rect.top - containerDragOffset.y;

                    const nodeEl = document.getElementById('container-node-' + containerSelectedNodeId);
                    if (nodeEl) {
                        nodeEl.style.left = Math.max(0, x) + 'px';
                        nodeEl.style.top = Math.max(0, y) + 'px';
                    }

                    const node = containerNodes.find(n => n.id === containerSelectedNodeId);
                    if (node) {
                        node.position = { x: Math.max(0, x), y: Math.max(0, y) };
                        renderContainerConnections();
                    }
                }

                if (containerIsConnecting && containerTempLine) {
                    updateContainerTempLine(e);
                }
            });

            document.addEventListener('mouseup', () => {
                containerIsDragging = false;
                endContainerConnection();
            });

            // Escape to close
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && containerEditorOpen) {
                    closeContainerEditor();
                }
                if (e.key === 'Delete' && containerEditorOpen && containerSelectedNodeId) {
                    removeContainerChildNode(containerSelectedNodeId);
                }
            });
        }

        function openContainerEditor(containerId) {
            const containerNode = project.nodes.find(n => n.id === containerId);
            if (!containerNode || containerNode.type !== 'container') return;

            editingContainerId = containerId;
            containerEditorOpen = true;
            containerNodes = JSON.parse(JSON.stringify(containerNode.config.nodes || []));
            containerConnections = JSON.parse(JSON.stringify(containerNode.config.connections || []));
            containerSelectedNodeId = null;

            document.getElementById('container-editor-title').textContent = '📦 Edit: ' + containerNode.name;
            document.getElementById('container-editor-overlay').style.display = 'flex';

            renderContainerNodes();
            renderContainerConnections();
        }

        function closeContainerEditor() {
            containerEditorOpen = false;
            editingContainerId = null;
            containerNodes = [];
            containerConnections = [];
            document.getElementById('container-editor-overlay').style.display = 'none';
        }

        function saveContainerAndClose() {
            if (!editingContainerId) return;

            vscode.postMessage({
                type: 'updateContainerNodes',
                payload: {
                    containerId: editingContainerId,
                    nodes: containerNodes,
                    connections: containerConnections
                }
            });

            closeContainerEditor();
        }

        function renderContainerNodes() {
            const container = document.getElementById('container-nodes');
            container.innerHTML = '';

            for (const node of containerNodes) {
                const el = createContainerNodeElement(node);
                container.appendChild(el);
            }
        }

        function createContainerNodeElement(node) {
            const el = document.createElement('div');
            el.className = 'etl-node ' + node.type + (containerSelectedNodeId === node.id ? ' selected' : '');
            el.id = 'container-node-' + node.id;
            el.style.left = node.position.x + 'px';
            el.style.top = node.position.y + 'px';

            el.innerHTML = \`
                <div class="node-actions">
                    <button class="node-delete-btn" data-node="\${node.id}" title="Delete">×</button>
                </div>
                <div class="node-type-indicator"></div>
                <div class="node-content">
                    <div class="node-header">
                        <span class="node-icon">\${nodeIcons[node.type] || '📋'}</span>
                        <span class="node-name">\${escapeHtml(node.name)}</span>
                    </div>
                    <div class="node-type">\${node.type}</div>
                </div>
                <div class="node-connectors">
                    <div class="connector input" data-node="\${node.id}" data-type="input"></div>
                    <div class="connector output" data-node="\${node.id}" data-type="output"></div>
                </div>
            \`;

            setupContainerNodeEvents(el, node);
            return el;
        }

        function setupContainerNodeEvents(el, node) {
            // Delete button
            const deleteBtn = el.querySelector('.node-delete-btn');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeContainerChildNode(node.id);
                });
            }

            // Drag
            el.addEventListener('mousedown', (e) => {
                if (e.target.classList.contains('connector')) return;
                if (e.target.classList.contains('node-delete-btn')) return;

                containerSelectedNodeId = node.id;
                containerIsDragging = true;

                const rect = el.getBoundingClientRect();
                containerDragOffset.x = e.clientX - rect.left;
                containerDragOffset.y = e.clientY - rect.top;

                document.querySelectorAll('#container-nodes .etl-node').forEach(n => n.classList.remove('selected'));
                el.classList.add('selected');
            });

            // Double-click to configure (first save, then configure)
            el.addEventListener('dblclick', () => {
                // First save current state to backend
                vscode.postMessage({
                    type: 'updateContainerNodes',
                    payload: {
                        containerId: editingContainerId,
                        nodes: containerNodes,
                        connections: containerConnections
                    }
                });
                // Then request configuration
                vscode.postMessage({ 
                    type: 'configureContainerChildNode', 
                    payload: { containerId: editingContainerId, nodeId: node.id } 
                });
            });

            // Connector events
            el.querySelectorAll('.connector').forEach(conn => {
                conn.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    if (conn.dataset.type === 'output') {
                        containerIsConnecting = true;
                        containerConnectionStart = node.id;
                        createContainerTempLine(e);
                    }
                });

                conn.addEventListener('mouseup', () => {
                    if (containerIsConnecting && conn.dataset.type === 'input' && containerConnectionStart !== node.id) {
                        addContainerConnection(containerConnectionStart, node.id);
                    }
                    endContainerConnection();
                });
            });

            // Context menu delete
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                removeContainerChildNode(node.id);
            });
        }

        function addContainerChildNode(type, position) {
            const nodeNames = {
                sql: 'SQL Task',
                python: 'Python Script',
                export: 'Export Data',
                import: 'Import Data',
                variable: 'Variable'
            };

            const defaultConfigs = {
                sql: { type: 'sql', query: '', connection: 'default' },
                python: { type: 'python', script: '' },
                export: { type: 'export', format: 'csv', outputPath: '' },
                import: { type: 'import', format: 'csv', inputPath: '', targetTable: '' },
                variable: { type: 'variable', variableName: '', source: 'prompt', promptMessage: 'Enter value' }
            };

            const newNode = {
                id: 'child-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
                type: type,
                name: nodeNames[type] || 'New Task',
                position: position,
                config: defaultConfigs[type] || {}
            };

            containerNodes.push(newNode);
            renderContainerNodes();
            renderContainerConnections();
        }

        function removeContainerChildNode(nodeId) {
            containerNodes = containerNodes.filter(n => n.id !== nodeId);
            containerConnections = containerConnections.filter(c => c.from !== nodeId && c.to !== nodeId);
            if (containerSelectedNodeId === nodeId) containerSelectedNodeId = null;
            renderContainerNodes();
            renderContainerConnections();
        }

        function addContainerConnection(from, to) {
            // Check if connection already exists
            if (containerConnections.some(c => c.from === from && c.to === to)) return;

            containerConnections.push({
                id: 'conn-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
                from: from,
                to: to
            });
            renderContainerConnections();
        }

        function renderContainerConnections() {
            const svg = document.getElementById('container-connections-svg');
            svg.querySelectorAll('path').forEach(p => p.remove());

            for (const conn of containerConnections) {
                const fromNode = containerNodes.find(n => n.id === conn.from);
                const toNode = containerNodes.find(n => n.id === conn.to);

                if (fromNode && toNode) {
                    const path = createContainerConnectionPath(fromNode, toNode, conn);
                    svg.appendChild(path);
                }
            }
        }

        function createContainerConnectionPath(from, to, conn) {
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');

            // Determine marker based on connection type
            const markerType = conn.connectionType === 'failure' ? 'container-arrowhead-failure' : 'container-arrowhead';
            const lineClass = conn.connectionType === 'failure' ? 'connection-line connection-failure' : 'connection-line';

            // Source: always right side (output connector)
            const x1 = from.position.x + 160;
            const y1 = from.position.y + 35;
            
            // Determine target connection point based on relative positions
            let x2, y2;
            const nodeWidth = 160;
            const nodeHeight = 70;
            
            const dx = to.position.x - from.position.x;
            const dy = to.position.y - from.position.y;
            
            if (dx > 50) {
                x2 = to.position.x;
                y2 = to.position.y + 35;
            } else if (dx < -50 && Math.abs(dy) < 80) {
                x2 = to.position.x + nodeWidth;
                y2 = to.position.y + 35;
            } else if (dy > 30) {
                x2 = to.position.x + nodeWidth / 2;
                y2 = to.position.y;
            } else if (dy < -30) {
                x2 = to.position.x + nodeWidth / 2;
                y2 = to.position.y + nodeHeight;
            } else {
                x2 = to.position.x;
                y2 = to.position.y + 35;
            }

            // Create bezier curve with appropriate control points
            let d;
            if (dx > 50) {
                const midX = (x1 + x2) / 2;
                d = 'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2;
            } else if (dx < -50 && Math.abs(dy) < 80) {
                d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + 60) + ' ' + y1 + ', ' + (x2 + 60) + ' ' + y2 + ', ' + x2 + ' ' + y2;
            } else if (dy > 30) {
                d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + 40) + ' ' + y1 + ', ' + x2 + ' ' + (y2 - 40) + ', ' + x2 + ' ' + y2;
            } else if (dy < -30) {
                d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + 40) + ' ' + y1 + ', ' + x2 + ' ' + (y2 + 40) + ', ' + x2 + ' ' + y2;
            } else {
                const midX = (x1 + x2) / 2;
                d = 'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2;
            }

            const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            hitPath.setAttribute('d', d);
            hitPath.setAttribute('class', 'connection-hit');
            
            // Right-click to toggle connection type
            hitPath.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const currentType = conn.connectionType || 'success';
                const newType = currentType === 'success' ? 'failure' : 'success';
                // Update locally
                conn.connectionType = newType;
                renderContainerConnections();
            });
            
            // Click to delete
            hitPath.addEventListener('click', (e) => {
                e.stopPropagation();
                containerConnections = containerConnections.filter(c => c.id !== conn.id);
                renderContainerConnections();
            });

            const visiblePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            visiblePath.setAttribute('d', d);
            visiblePath.setAttribute('marker-end', 'url(#' + markerType + ')');
            visiblePath.setAttribute('class', lineClass);

            group.appendChild(hitPath);
            group.appendChild(visiblePath);

            return group;
        }

        function createContainerTempLine(e) {
            const svg = document.getElementById('container-connections-svg');
            containerTempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            containerTempLine.classList.add('temp-connection');
            svg.appendChild(containerTempLine);
            updateContainerTempLine(e);
        }

        function updateContainerTempLine(e) {
            if (!containerTempLine || !containerConnectionStart) return;

            const fromNode = containerNodes.find(n => n.id === containerConnectionStart);
            if (!fromNode) return;

            const canvas = document.getElementById('container-canvas');
            const rect = canvas.getBoundingClientRect();

            const x1 = fromNode.position.x + 160;
            const y1 = fromNode.position.y + 35;
            const x2 = e.clientX - rect.left;
            const y2 = e.clientY - rect.top;

            const midX = (x1 + x2) / 2;
            containerTempLine.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2);
        }

        function endContainerConnection() {
            containerIsConnecting = false;
            containerConnectionStart = null;
            if (containerTempLine) {
                containerTempLine.remove();
                containerTempLine = null;
            }
        }
    `;
}
