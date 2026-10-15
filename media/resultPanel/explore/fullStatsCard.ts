import type { ExploreFilterModel } from '@justybase/contracts';
import { requestExploreFullStats, openExploreSqlInEditor, cancelExploreRequests, type FullStatisticsPayload } from './hostBridge.js';
import { button, element } from './ui.js';

export interface FullStatsSnapshot {
    result: FullStatisticsPayload;
    filters: ExploreFilterModel;
    computedAt: number;
}

/** Keep the last database computation visible while filters change or a retry fails. */
export function renderFullStatsCard(card: HTMLElement, columnIndex: number, filters: ExploreFilterModel,
    cache: Map<number, FullStatsSnapshot>, run = false): void {
    let root = card.querySelector<HTMLElement>('.explore-full-stats');
    if (!root) { root = element('div', undefined, 'explore-full-stats'); card.append(root); }
    const target = root;
    const draw = () => {
        target.replaceChildren();
        const snapshot = cache.get(columnIndex);
        if (!snapshot) return;
        const stale = JSON.stringify(snapshot.filters) !== JSON.stringify(filters);
        target.append(element('p', stale ? 'Out of date · Run statistics to apply current filters'
            : `Database · ${new Date(snapshot.computedAt).toLocaleTimeString()} · Original SQL limits preserved`, 'explore-note explore-database-status'));
        const context = element('details');
        context.append(element('summary', 'Applied filters'), element('pre', JSON.stringify(snapshot.filters, null, 2)));
        target.append(context);
        const grid = element('div', undefined, 'explore-full-stats-grid');
        const labels: Record<string, string> = { count: 'Count', distinct: 'Distinct', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', stddev: 'StdDev', p25: 'p25', p50: 'Median', p75: 'p75' };
        for (const [key, value] of Object.entries(snapshot.result.values)) {
            if (snapshot.result.percentilesUnavailable && ['p25', 'p50', 'p75'].includes(key)) continue;
            if (snapshot.result.stddevUnavailable && key === 'stddev') continue;
            const cell = element('div', undefined, 'explore-full-stat');
            cell.append(element('span', labels[key] ?? key, 'explore-full-stat-label'), element('span', value == null ? '—' : String(value), 'explore-full-stat-value')); grid.append(cell);
        }
        target.append(grid, button('Open SQL', () => openExploreSqlInEditor(snapshot.result.sql, 'Explore statistics')));
    };
    if (!run) { draw(); return; }
    if (target.dataset.running === 'true') return;
    target.dataset.running = 'true';
    const status = element('p', 'Computing database statistics…');
    status.append(button('Cancel', cancelExploreRequests)); target.prepend(status);
    void requestExploreFullStats(columnIndex, filters).then(result => {
        if (!card.isConnected) return;
        cache.set(columnIndex, { result, filters: structuredClone(filters), computedAt: Date.now() }); draw();
    }).catch(error => {
        if (!card.isConnected) return;
        status.textContent = error instanceof Error ? error.message : String(error);
        status.append(button('Retry', () => renderFullStatsCard(card, columnIndex, filters, cache, true)));
    }).finally(() => { delete target.dataset.running; });
}
