import { getElementById } from './dom.js';
import { setRowViewOpen } from './state.js';

export function syncRowViewToolbarButton(open: boolean): void {
    const btn = getElementById('rowViewBtn');
    if (!btn) {
        return;
    }
    btn.classList.toggle('hi', open);
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    // Sync right bar button
    const barBtn = getElementById('rowViewBarBtn');
    if (barBtn) {
        barBtn.classList.toggle('active', open);
    }
}

export function closeRowView(): void {
    setRowViewOpen(false);
    syncRowViewToolbarButton(false);
    getElementById('rowViewPanel')?.classList.remove('visible');
}
