/**
 * Connection rendering for ETL Designer
 */

/**
 * Generates the connections script section
 */
export function getConnectionsScript(): string {
    return `
        function renderConnections() {
            const svg = document.getElementById('connections-svg');
            // Clear existing paths but keep defs
            svg.querySelectorAll('path').forEach(p => p.remove());

            for (const conn of project.connections) {
                const fromNode = project.nodes.find(n => n.id === conn.from);
                const toNode = project.nodes.find(n => n.id === conn.to);
                
                if (fromNode && toNode) {
                    const path = createConnectionPath(fromNode, toNode, conn);
                    svg.appendChild(path);
                }
            }
        }

        function createConnectionPath(from, to, conn) {
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            
            // Determine marker based on connection type
            const markerType = conn.connectionType === 'failure' ? 'arrowhead-failure' : 'arrowhead';
            const lineClass = conn.connectionType === 'failure' ? 'connection-line connection-failure' : 'connection-line';
            
            // Node dimensions
            const nodeWidth = 160;
            const nodeHeight = 70;
            
            // Calculate center points
            const fromCenterX = from.position.x + nodeWidth / 2;
            const fromCenterY = from.position.y + nodeHeight / 2;
            const toCenterX = to.position.x + nodeWidth / 2;
            const toCenterY = to.position.y + nodeHeight / 2;
            
            // Calculate relative position
            const dx = toCenterX - fromCenterX;
            const dy = toCenterY - fromCenterY;
            
            // Determine connection points based on relative position
            let x1, y1, x2, y2;
            
            // Choose source point (from node)
            if (Math.abs(dy) > Math.abs(dx)) {
                // Vertical connection dominates
                if (dy > 0) {
                    // Target is below - start from bottom
                    x1 = fromCenterX;
                    y1 = from.position.y + nodeHeight;
                } else {
                    // Target is above - start from top
                    x1 = fromCenterX;
                    y1 = from.position.y;
                }
            } else {
                // Horizontal connection dominates
                if (dx > 0) {
                    // Target is to the right - start from right
                    x1 = from.position.x + nodeWidth;
                    y1 = fromCenterY;
                } else {
                    // Target is to the left - start from left
                    x1 = from.position.x;
                    y1 = fromCenterY;
                }
            }
            
            // Choose target point (to node)
            if (Math.abs(dy) > Math.abs(dx)) {
                // Vertical connection
                if (dy > 0) {
                    // Coming from above - end at top
                    x2 = toCenterX;
                    y2 = to.position.y;
                } else {
                    // Coming from below - end at bottom
                    x2 = toCenterX;
                    y2 = to.position.y + nodeHeight;
                }
            } else {
                // Horizontal connection
                if (dx > 0) {
                    // Coming from left - end at left
                    x2 = to.position.x;
                    y2 = toCenterY;
                } else {
                    // Coming from right - end at right
                    x2 = to.position.x + nodeWidth;
                    y2 = toCenterY;
                }
            }

            // Create bezier curve with appropriate control points
            let d;
            if (Math.abs(dy) > Math.abs(dx)) {
                // Vertical curve
                const midY = (y1 + y2) / 2;
                d = 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + midY + ', ' + x2 + ' ' + midY + ', ' + x2 + ' ' + y2;
            } else {
                // Horizontal curve
                const midX = (x1 + x2) / 2;
                d = 'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2;
            }
            
            // 1. Hit path (invisible, wider)
            const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            hitPath.setAttribute('d', d);
            hitPath.setAttribute('class', 'connection-hit');
            hitPath.dataset.connectionId = conn.id;
            
            // Right-click to toggle connection type
            hitPath.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const currentType = conn.connectionType || 'success';
                const newType = currentType === 'success' ? 'failure' : 'success';
                vscode.postMessage({ 
                    type: 'toggleConnectionType', 
                    payload: { connectionId: conn.id, newType: newType }
                });
            });
            
            // Click to delete
            hitPath.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ type: 'confirmRemoveConnection', payload: conn.id });
            });

            // 2. Visible path
            const visiblePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            visiblePath.setAttribute('d', d);
            visiblePath.setAttribute('marker-end', 'url(#' + markerType + ')');
            visiblePath.setAttribute('class', lineClass);

            group.appendChild(hitPath);
            group.appendChild(visiblePath);
            
            return group;
        }

        function createTempLine(e) {
            const svg = document.getElementById('connections-svg');
            tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            tempLine.classList.add('temp-connection');
            svg.appendChild(tempLine);
            updateTempLine(e);
        }

        function updateTempLine(e) {
            if (!tempLine || !connectionStart) return;
            
            const fromNode = project.nodes.find(n => n.id === connectionStart);
            if (!fromNode) return;
            
            const canvas = document.getElementById('canvas');
            const rect = canvas.getBoundingClientRect();
            
            const x1 = fromNode.position.x + 160;
            const y1 = fromNode.position.y + 35;
            const x2 = (e.clientX - rect.left - pan.x) / scale;
            const y2 = (e.clientY - rect.top - pan.y) / scale;
            
            const midX = (x1 + x2) / 2;
            tempLine.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2);
        }

        function endConnection() {
            isConnecting = false;
            connectionStart = null;
            if (tempLine) {
                tempLine.remove();
                tempLine = null;
            }
        }
    `;
}
