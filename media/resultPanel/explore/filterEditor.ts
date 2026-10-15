import type { ExploreFilterModel, ExploreValue } from '@justybase/contracts';
import { compareExploreNumbers, matchesExploreFilters } from '@justybase/result-core';
import type { ExploreColumnMeta } from './types.js';
import { requestExploreOperation } from './hostBridge.js';
import { button, element, field, select, valueLabel, applyDatabaseAvailability } from './ui.js';

/** Draft edits are isolated until Apply; database searches are always explicit. */
export function renderFilterEditor(root: HTMLElement, columns: readonly ExploreColumnMeta[], rows: readonly unknown[][],
    initial: ExploreFilterModel, onApply: (filters: ExploreFilterModel) => void, columnIndex?: number, databaseReason?: string): void {
    root.replaceChildren();
    const panel = element('section', undefined, 'explore-filter-editor');
    panel.setAttribute('aria-label', 'Edit Explore filter');
    const column = select(columns.map(item => [String(item.index), item.name]), String(columnIndex ?? columns[0]?.index ?? 0));
    const searchColumn = element('input');
    searchColumn.type = 'search';
    searchColumn.placeholder = 'Search columns';
    searchColumn.setAttribute('aria-label', 'Search columns');
    searchColumn.addEventListener('input', () => {
        for (const option of column.options) option.hidden = !option.text.toLowerCase().includes(searchColumn.value.toLowerCase());
    });
    const body = element('div');
    const error = element('div', undefined, 'explore-error');
    error.setAttribute('role', 'alert');
    const close = () => root.replaceChildren();
    panel.append(element('h3', 'Filter'), searchColumn, field('Column', column), body, error);
    root.append(panel);
    let generation = 0;
    const render = () => {
        const revision = ++generation;
        const index = Number(column.value);
        const meta = columns.find(item => item.index === index);
        if (!meta) return;
        body.replaceChildren();
        error.textContent = '';
        const next = structuredClone(initial);
        next.dimensions = next.dimensions.filter(item => item.columnIndex !== index);
        next.dates = next.dates.filter(item => item.columnIndex !== index);
        next.measures = next.measures.filter(item => item.columnIndex !== index);
        const finish = () => { onApply(next); close(); };
        if (meta.role === 'measure' || meta.role === 'date') {
            const numeric = meta.role === 'measure';
            const previous = numeric ? initial.measures.find(item => item.columnIndex === index) : initial.dates.find(item => item.columnIndex === index);
            const from = element('input');
            const to = element('input');
            const timestamp = /timestamp|datetime/i.test(meta.type ?? '');
            from.type = to.type = numeric ? 'text' : timestamp ? 'datetime-local' : 'date';
            if (numeric) { from.inputMode = to.inputMode = 'decimal'; }
            from.value = String(previous && 'min' in previous ? previous.min ?? '' : previous && 'from' in previous ? previous.from ?? '' : '');
            to.value = String(previous && 'max' in previous ? previous.max ?? '' : previous && 'to' in previous ? previous.to ?? '' : '');
            if (!numeric && !timestamp && previous && 'toExclusive' in previous && previous.toExclusive && to.value) {
                const date = new Date(`${to.value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 1); to.value = date.toISOString().slice(0, 10);
            }
            const apply = button('Apply', () => {
                const lower = from.value.trim(), upper = to.value.trim();
                const comparison = lower && upper ? numeric ? compareExploreNumbers(lower, upper) : lower.localeCompare(upper) : 0;
                if (numeric && ((lower && compareExploreNumbers(lower, lower) === undefined) || (upper && compareExploreNumbers(upper, upper) === undefined))) {
                    error.textContent = 'Enter a valid number.'; return;
                }
                if (comparison === undefined || comparison > 0) { error.textContent = 'The lower bound must not exceed the upper bound.'; return; }
                if (!from.checkValidity() || !to.checkValidity()) { error.textContent = 'Enter a valid date and time.'; return; }
                if (lower || upper) {
                    if (numeric) next.measures.push({ columnIndex: index, min: lower || undefined, max: upper || undefined });
                    else {
                        // A date-only upper bound includes the whole selected day.
                        let end = upper;
                        if (upper && !timestamp) {
                            const date = new Date(`${upper}T00:00:00Z`);
                            date.setUTCDate(date.getUTCDate() + 1);
                            end = date.toISOString().slice(0, 10);
                        }
                        next.dates.push({ columnIndex: index, grain: 'day', from: lower || undefined, to: end || undefined, toExclusive: !!upper && !timestamp });
                    }
                }
                finish();
            });
            body.append(field(numeric ? 'Min' : 'From', from), field(numeric ? 'Max' : 'To', to), apply, button('Cancel', close));
        } else {
            const previous = initial.dimensions.find(item => item.columnIndex === index);
            const mode = select([['include', 'Include'], ['exclude', 'Exclude']], previous?.mode ?? 'include');
            const selected = new Map<string, ExploreValue>((previous?.values ?? []).map(value => [JSON.stringify(value), value]));
            const nullInput = element('input'); nullInput.type = 'checkbox'; nullInput.checked = previous?.includeNull ?? false;
            const emptyInput = element('input'); emptyInput.type = 'checkbox'; emptyInput.checked = previous?.includeEmpty ?? false;
            const search = element('input'); search.type = 'search'; search.placeholder = 'Search values';
            const values = element('div', undefined, 'explore-value-options');
            const scope = element('div', 'Sample · First rows; not a random sample', 'explore-note');
            const available = new Map<string, ExploreValue>(selected);
            for (const row of rows) {
                if (!matchesExploreFilters(row, next)) continue;
                const raw = row[index];
                if (raw != null && raw !== '' && ['string', 'number', 'boolean', 'bigint'].includes(typeof raw)) {
                    const value = typeof raw === 'bigint' ? String(raw) : raw as ExploreValue;
                    available.set(JSON.stringify(value), value);
                }
            }
            const draw = () => {
                values.replaceChildren();
                const candidates = Array.from(available.entries()).filter(([key, value]) => selected.has(key) || String(value).toLowerCase().includes(search.value.toLowerCase()));
                const visible = candidates.sort(([a], [b]) => Number(selected.has(b)) - Number(selected.has(a))).slice(0, Math.max(100, selected.size));
                for (const [key, value] of visible) {
                    const input = element('input'); input.type = 'checkbox'; input.checked = selected.has(key);
                    input.addEventListener('change', () => { if (input.checked) selected.set(key, value); else selected.delete(key); });
                    values.append(field(valueLabel(value), input));
                }
                if (!visible.length) values.append(element('p', 'No matching values.'));
                if (candidates.length > visible.length) values.append(element('p', 'More values available. Refine the search.'));
            };
            search.addEventListener('input', draw);
            const database = button('Search database', () => {
                database.disabled = true; scope.textContent = 'Searching database…';
                void requestExploreOperation({ kind: 'values', columnIndex: index, search: search.value, filters: next }).then(result => {
                    if (!panel.isConnected || revision !== generation) return;
                    for (const row of result.rows) {
                        const value = row[0];
                        if (value != null && value !== '' && ['string', 'number', 'boolean'].includes(typeof value)) available.set(JSON.stringify(value), value as ExploreValue);
                    }
                    scope.textContent = `Database · ${result.rows.length} values${result.truncated ? ' · More values available; refine the search' : ''} · Original SQL limits preserved`;
                    draw();
                }).catch(reason => { if (panel.isConnected) error.textContent = String(reason instanceof Error ? reason.message : reason); })
                    .finally(() => { database.disabled = false; });
            });
            body.append(field('Mode', mode), field('Search values', search), database, scope, field('NULL', nullInput), field('Empty string', emptyInput), values,
                button('Apply', () => {
                    if (selected.size || nullInput.checked || emptyInput.checked) next.dimensions.push({ columnIndex: index, values: Array.from(selected.values()), mode: mode.value as 'include' | 'exclude', includeNull: nullInput.checked, includeEmpty: emptyInput.checked });
                    finish();
                }), button('Cancel', close));
            draw();
        }
        applyDatabaseAvailability(panel, databaseReason);
    };
    column.addEventListener('change', render);
    render();
    column.focus();
}
