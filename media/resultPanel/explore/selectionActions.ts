import type { ExploreFilterModel } from '@justybase/contracts';
import { filterExploreRows } from './filtering.js';
import { requestExploreOperation, openExploreSqlInEditor, cancelExploreRequests } from './hostBridge.js';
import { button, element, valueLabel, applyDatabaseAvailability } from './ui.js';

export interface ExploreSelection {
    label: string;
    filters: ExploreFilterModel;
    scope: 'sample' | 'database';
}

/** Selection captures the filters of the displayed chart, including stale charts. */
export function showSelectionActions(root: HTMLElement, selection: ExploreSelection, columns: readonly { name: string }[],
    sampleRows: readonly unknown[][], onFilter: (filters: ExploreFilterModel) => void, databaseReason?: string): void {
    root.replaceChildren();
    const panel = element('section', undefined, 'explore-selection-panel');
    panel.setAttribute('aria-label', 'Selection actions');
    const context = element('details');
    context.append(element('summary', 'Applied filters'), element('pre', JSON.stringify(selection.filters, null, 2)));
    const rowsRoot = element('div');
    const openSql = () => {
        void requestExploreOperation({ kind: 'rows', filters: selection.filters }, true).then(result => {
            if (panel.isConnected) openExploreSqlInEditor(result.sql, `Explore rows · ${selection.label}`);
        }).catch(reason => { rowsRoot.textContent = reason instanceof Error ? reason.message : String(reason); });
    };
    const renderRows = (rows: unknown[][], truncated: boolean) => {
        let page = 0;
        const draw = () => {
            rowsRoot.replaceChildren();
            rowsRoot.append(element('h3', 'Rows'), element('p', `${selection.scope === 'sample' ? 'Sample' : 'Database'} · ${truncated ? 'Showing first 1,000 matching rows' : `${rows.length.toLocaleString()} matching rows`}`));
            const wrapper = element('div', undefined, 'explore-table-wrapper');
            const table = element('table', undefined, 'explore-table');
            const head = element('tr');
            columns.forEach(column => head.append(element('th', column.name)));
            const thead = element('thead'); thead.append(head); table.append(thead);
            const body = element('tbody');
            for (const row of rows.slice(page * 100, (page + 1) * 100)) {
                const tr = element('tr'); columns.forEach((_, index) => tr.append(element('td', valueLabel(row[index])))); body.append(tr);
            }
            table.append(body); wrapper.append(table);
            const prev = button('Previous page', () => { page--; draw(); }); prev.disabled = page === 0;
            const next = button('Next page', () => { page++; draw(); }); next.disabled = (page + 1) * 100 >= rows.length;
            rowsRoot.append(wrapper, prev, element('span', ` Page ${page + 1} of ${Math.max(1, Math.ceil(rows.length / 100))} `), next, button('Open SQL', openSql));
            applyDatabaseAvailability(panel, databaseReason);
        };
        draw();
    };
    const load = () => {
        rowsRoot.replaceChildren(element('p', 'Loading rows…'), button('Cancel', cancelExploreRequests));
        void requestExploreOperation({ kind: 'rows', filters: selection.filters }).then(result => {
            if (panel.isConnected) renderRows(result.rows, result.truncated);
        }).catch(reason => {
            if (!panel.isConnected) return;
            rowsRoot.replaceChildren(element('p', reason instanceof Error ? reason.message : String(reason)), button('Retry', load));
        });
    };
    panel.append(element('h3', selection.label), element('p', `${selection.scope === 'sample' ? 'Sample' : 'Database'} · Selection uses the displayed result's filters`), context,
        button('Filter to selection', () => { onFilter(selection.filters); root.replaceChildren(); }),
        button('Show rows', () => {
            if (selection.scope === 'sample') {
                const rows = filterExploreRows(sampleRows, selection.filters);
                renderRows(rows.slice(0, 1000), rows.length > 1000);
            } else rowsRoot.replaceChildren(element('p', 'Database · Loads current data; it may differ from the chart.'), button('Load rows', load));
            applyDatabaseAvailability(panel, databaseReason);
        }), button('Open SQL', openSql), button('Close', () => root.replaceChildren()), rowsRoot);
    root.append(panel);
    applyDatabaseAvailability(panel, databaseReason);
    panel.querySelector('button')?.focus();
}
