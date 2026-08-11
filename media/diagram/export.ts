export type DiagramExportFormat = 'svg' | 'png';

function downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Export the visible React Flow canvas. HTML node cards are wrapped in
 * foreignObject, so the export retains the same table/task typography while
 * edge SVG remains native and selectable in vector editors.
 */
export function exportReactFlowCanvas(
    root: HTMLElement,
    format: DiagramExportFormat,
    fileName: string,
): void {
    const viewport = root.querySelector<HTMLElement>('.react-flow__viewport');
    if (!viewport) return;

    const bounds = viewport.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(bounds.width));
    const height = Math.max(1, Math.ceil(bounds.height));
    const edgeSvg = root.querySelector<SVGElement>('.react-flow__edges');
    const edgeMarkup = edgeSvg ? new XMLSerializer().serializeToString(edgeSvg) : '';
    const nodeMarkup = [...viewport.querySelectorAll<HTMLElement>('.react-flow__node')]
        .map(node => `<foreignObject x="${node.offsetLeft}" y="${node.offsetTop}" width="${node.offsetWidth || 320}" height="${node.offsetHeight || 180}"><div xmlns="http://www.w3.org/1999/xhtml" class="diagram-export-node">${node.innerHTML}</div></foreignObject>`)
        .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="var(--vscode-editor-background, #1e1e1e)"/>${edgeMarkup}${nodeMarkup}</svg>`;

    if (format === 'svg') {
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), fileName.endsWith('.svg') ? fileName : `${fileName}.svg`);
        return;
    }

    const image = new Image();
    image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width * 2;
        canvas.height = height * 2;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.scale(2, 2);
        context.drawImage(image, 0, 0, width, height);
        canvas.toBlob(blob => {
            if (blob) downloadBlob(blob, fileName.endsWith('.png') ? fileName : `${fileName}.png`);
        }, 'image/png');
    };
    image.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
}
