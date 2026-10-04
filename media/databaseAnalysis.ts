interface AnalysisVsCode { postMessage(message: unknown): void }
declare function acquireVsCodeApi(): AnalysisVsCode;
(() => {
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-command]') : null;
        if (!target) { return; }
        if (target.dataset.command === 'plan') {
            const details = document.getElementById('plan');
            if (details instanceof HTMLDetailsElement) { details.open = true; }
            document.querySelectorAll('.highlight').forEach(node => node.classList.remove('highlight'));
            const ids = target.dataset.nodes?.split(',') ?? [];
            ids.forEach(id => document.getElementById(`plan-${id}`)?.classList.add('highlight'));
            document.getElementById(`plan-${ids[0]}`)?.scrollIntoView({ block: 'center' });
        } else {
            vscode.postMessage({ command: target.dataset.command, index: target.dataset.index === undefined ? undefined : Number(target.dataset.index) });
        }
    });
    document.addEventListener('keydown', event => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof SVGElement && event.target.matches('[data-command]')) {
            event.preventDefault(); event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
    });
    document.getElementById('depth')?.addEventListener('change', event => {
        if (event.target instanceof HTMLSelectElement) { vscode.postMessage({ command: 'depth', value: event.target.value }); }
    });
    const svg = document.getElementById('graph');
    if (svg instanceof SVGSVGElement) {
        let drag: { x: number; y: number; left: number; top: number } | undefined;
        svg.addEventListener('wheel', event => {
            event.preventDefault();
            const box = svg.viewBox.baseVal;
            const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
            const width = Math.min(30_000, Math.max(100, box.width * factor));
            const ratio = width / box.width;
            box.x += (box.width - width) / 2; box.y += (box.height - box.height * ratio) / 2;
            box.width = width; box.height *= ratio;
        }, { passive: false });
        svg.addEventListener('pointerdown', event => {
            if (event.target instanceof Element && event.target.closest('[data-command]')) { return; }
            drag = { x: event.clientX, y: event.clientY, left: svg.viewBox.baseVal.x, top: svg.viewBox.baseVal.y };
            svg.setPointerCapture(event.pointerId);
        });
        svg.addEventListener('pointermove', event => {
            if (!drag) { return; }
            const box = svg.viewBox.baseVal, rect = svg.getBoundingClientRect();
            if (!rect.width || !rect.height) { return; }
            box.x = drag.left - (event.clientX - drag.x) * box.width / rect.width;
            box.y = drag.top - (event.clientY - drag.y) * box.height / rect.height;
        });
        const end = () => { drag = undefined; };
        svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end); svg.addEventListener('lostpointercapture', end);
    }
})();

export {};
