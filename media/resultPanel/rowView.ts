import { getElementById } from './dom.js';
import { setRowViewOpen } from './state.js';

export function syncRowViewToolbarButton(open: boolean): void {
    const btn = getElementById('rowViewBtn');
    if (!btn) {
        return;
    }
    btn.classList.toggle('hi', open);
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
}

export function closeRowView(): void {
    setRowViewOpen(false);
    syncRowViewToolbarButton(false);
    getElementById('rowViewPanel')?.classList.remove('visible');
}
