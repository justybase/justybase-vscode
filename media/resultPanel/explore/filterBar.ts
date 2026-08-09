// Filter bar UI: chips for active explore filters + undo/redo/clear +
// SQL preview / open-in-editor actions.

import { getElementById } from '../dom.js';
import { postHostMessage } from '../protocol.js';
import type { ExploreColumnMeta, ExploreFilterModel } from './types.js';
import { previewExploreFilteredSql, openExploreSqlInEditor } from './hostBridge.js';
import { showSqlPreviewModal } from './previewModal.js';
import type { ExploreFilterState } from './filterState.js';

export interface FilterBarCallbacks {
    onUndo: () => void;
    onRedo: () => void;
    onClear: () => void;
    onRemoveChip: (kind: 'dimension' | 'date' | 'measure', columnIndex: number, value?: string) => void;
    onEditChip: (kind: 'dimension' | 'date' | 'measure', columnIndex: number) => void;
}

export function renderFilterBar(
    root: HTMLElement,
    filters: ExploreFilterModel,
    columns: readonly ExploreColumnMeta[],
    state: ExploreFilterState,
    callbacks: FilterBarCallbacks,
): void {
    root.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'explore-filter-bar';

    const chips = document.createElement('div');
    chips.className = 'explore-filter-chips';

    const columnName = (index: number): string => columns[index]?.name ?? `Col ${index + 1}`;

    for (const dimension of filters.dimensions) {
        for (const value of dimension.values) {
            chips.appendChild(buildChip(
                'dimension',
                dimension.columnIndex,
                `${columnName(dimension.columnIndex)} = ${value}`,
                () => callbacks.onRemoveChip('dimension', dimension.columnIndex, value),
                () => callbacks.onEditChip('dimension', dimension.columnIndex),
            ));
        }
    }
    for (const date of filters.dates) {
        const label = `${columnName(date.columnIndex)} ${date.grain}${date.from ? ` ≥ ${date.from}` : ''}${date.to ? ` ≤ ${date.to}` : ''}`;
        chips.appendChild(buildChip(
            'date',
            date.columnIndex,
            label,
            () => callbacks.onRemoveChip('date', date.columnIndex),
            () => callbacks.onEditChip('date', date.columnIndex),
        ));
    }
    for (const measure of filters.measures) {
        const label = `${columnName(measure.columnIndex)} ${measure.min !== undefined ? ` ≥ ${measure.min}` : ''}${measure.max !== undefined ? ` ≤ ${measure.max}` : ''}`.trim();
        chips.appendChild(buildChip(
            'measure',
            measure.columnIndex,
            label,
            () => callbacks.onRemoveChip('measure', measure.columnIndex),
            () => callbacks.onEditChip('measure', measure.columnIndex),
        ));
    }

    if (filters.dimensions.length === 0 && filters.dates.length === 0 && filters.measures.length === 0) {
        const hint = document.createElement('span');
        hint.className = 'explore-filter-hint';
        hint.textContent = 'No filters — click a top value or use Filter on a card.';
        chips.appendChild(hint);
    }

    bar.appendChild(chips);

    const actions = document.createElement('div');
    actions.className = 'explore-filter-actions';

    actions.appendChild(buildActionButton('↩ Undo', state.canUndo, callbacks.onUndo, 'Undo last filter change'));
    actions.appendChild(buildActionButton('↪ Redo', state.canRedo, callbacks.onRedo, 'Redo filter change'));
    actions.appendChild(buildActionButton('✕ Clear', state.historyDepth > 0 || filters.dimensions.length + filters.dates.length + filters.measures.length > 0, callbacks.onClear, 'Clear all filters'));
    actions.appendChild(buildActionButton('SQL…', true, () => {
        void previewExploreFilteredSql(filters).then(sql => {
            showSqlPreviewModal({ title: 'Filtered SQL', sql, onOpenInEditor: sqlText => openExploreSqlInEditor(sqlText, 'Explore filtered query') });
        }).catch(error => {
            postHostMessage({ command: 'error', text: error instanceof Error ? error.message : String(error) });
        });
    }, 'Preview the filtered query SQL'));

    bar.appendChild(actions);
    root.appendChild(bar);
}

function buildChip(
    kind: 'dimension' | 'date' | 'measure',
    columnIndex: number,
    label: string,
    onRemove: () => void,
    onEdit: () => void,
): HTMLElement {
    const chip = document.createElement('span');
    chip.className = `explore-filter-chip explore-filter-chip-${kind}`;
    chip.dataset.kind = kind;
    chip.dataset.columnIndex = String(columnIndex);

    const labelSpan = document.createElement('span');
    labelSpan.className = 'explore-filter-chip-label';
    labelSpan.textContent = label;
    labelSpan.title = 'Edit filter';
    labelSpan.addEventListener('click', onEdit);
    chip.appendChild(labelSpan);

    const remove = document.createElement('button');
    remove.className = 'explore-filter-chip-remove';
    remove.textContent = '×';
    remove.title = 'Remove filter';
    remove.setAttribute('aria-label', 'Remove filter');
    remove.addEventListener('click', event => {
        event.stopPropagation();
        onRemove();
    });
    chip.appendChild(remove);
    return chip;
}

function buildActionButton(text: string, enabled: boolean, onClick: () => void, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'explore-filter-action';
    button.textContent = text;
    button.disabled = !enabled;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
}

export function getFilterBarRoot(): HTMLElement | null {
    return getElementById('exploreFilterBar');
}
