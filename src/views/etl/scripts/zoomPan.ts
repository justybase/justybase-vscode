/**
 * Zoom and pan functionality for ETL Designer canvas
 */

/**
 * Generates the zoom/pan script section
 */
export function getZoomPanScript(): string {
    return `
        function updateTransform() {
            const wrapper = document.getElementById('zoom-wrapper');
            if (wrapper) {
                wrapper.style.transform = \`translate(\${pan.x}px, \${pan.y}px) scale(\${scale})\`;
            }
        }

        function setupZoomPan() {
            const container = document.getElementById('canvas');
            
            // Wheel zoom
            container.addEventListener('wheel', (e) => {
                if (e.ctrlKey || true) { 
                    e.preventDefault();
                    const zoomSensitivity = 0.001;
                    const delta = -e.deltaY * zoomSensitivity;
                    const newScale = Math.min(Math.max(0.1, scale + delta), 5);
                    scale = newScale;
                    updateTransform();
                }
            });

            // Pan
            container.addEventListener('mousedown', (e) => {
                if (e.target === container || e.target.id === 'nodes-container' || e.target.id === 'zoom-wrapper' || e.target.id === 'connections-svg') {
                    isPanning = true;
                    panStart = { x: e.clientX - pan.x, y: e.clientY - pan.y };
                    container.style.cursor = 'grabbing';
                }
            });

            window.addEventListener('mousemove', (e) => {
                if (isPanning) {
                    pan.x = e.clientX - panStart.x;
                    pan.y = e.clientY - panStart.y;
                    updateTransform();
                }
            });

            window.addEventListener('mouseup', () => {
                if (isPanning) {
                    isPanning = false;
                    container.style.cursor = 'grab';
                }
            });
        }
    `;
}
