/**
 * Event handlers for ETL Designer
 */

/**
 * Generates the event handlers script section
 */
export function getEventHandlersScript(): string {
    return `
        // Keyboard events for Delete key
        function setupKeyboardEvents() {
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Delete' && selectedNodeId) {
                    vscode.postMessage({ type: 'confirmRemoveNode', payload: selectedNodeId });
                }
            });
        }

        // Handle messages from extension
        window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.type) {
                case 'projectUpdate':
                    project = message.payload;
                    renderNodes();
                    renderConnections();
                    break;
                case 'nodeStatusUpdate':
                    updateNodeStatus(message.payload.nodeId, message.payload.status);
                    break;
                case 'executionStarted':
                    document.getElementById('btn-run').style.display = 'none';
                    document.getElementById('btn-stop').style.display = 'inline-block';
                    document.getElementById('status').textContent = 'Running...';
                    break;
                case 'executionEnded':
                    document.getElementById('btn-run').style.display = 'inline-block';
                    document.getElementById('btn-stop').style.display = 'none';
                    document.getElementById('status').textContent = message.payload?.status || '';
                    break;
                case 'containerChildUpdated':
                    // Refresh container editor with updated child node
                    if (containerEditorOpen && editingContainerId === message.payload.containerId) {
                        const updatedChild = message.payload.childNode;
                        const idx = containerNodes.findIndex(n => n.id === updatedChild.id);
                        if (idx >= 0) {
                            containerNodes[idx] = updatedChild;
                            renderContainerNodes();
                        }
                    }
                    break;
            }
        });

        function setupToolbarButtons() {
            document.getElementById('btn-new').addEventListener('click', () => {
                vscode.postMessage({ type: 'newProject' });
            });
            
            document.getElementById('btn-open').addEventListener('click', () => {
                vscode.postMessage({ type: 'loadProject' });
            });
            
            document.getElementById('btn-save').addEventListener('click', () => {
                vscode.postMessage({ type: 'saveProject' });
            });
            
            document.getElementById('btn-run').addEventListener('click', () => {
                vscode.postMessage({ type: 'runProject' });
            });
            
            document.getElementById('btn-stop').addEventListener('click', () => {
                vscode.postMessage({ type: 'stopProject' });
            });
        }
    `;
}
