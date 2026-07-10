/**
 * Utility functions for ETL Designer webview script
 */

/**
 * Generates the utility functions section of the script
 */
export function getUtilsScript(): string {
    return `
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function updateNodeStatus(nodeId, status) {
            const nodeEl = document.getElementById('node-' + nodeId);
            if (nodeEl) {
                nodeEl.classList.remove('running', 'success', 'error', 'pending', 'skipped');
                nodeEl.classList.add(status);
            }
            
            document.getElementById('status').textContent = status === 'running' 
                ? 'Running...' 
                : (status === 'error' ? 'Error!' : '');
        }
    `;
}
