// Grouping-column picker for the Analytical view: ordered chips, an add menu and one-click suggestions.

import type { SchemaColumn } from './analyticalState.js';
import { el } from './elements.js';
import { ANALYTICAL_MAX_GROUP_COLUMNS, type AnalyticalGroupColumnRef } from './types.js';

export interface GroupPickerOptions {
    columns: readonly SchemaColumn[];
    chosen: readonly AnalyticalGroupColumnRef[];
    suggestions: readonly SchemaColumn[];
    onAdd: (column: SchemaColumn) => void;
    onRemove: (index: number) => void;
}

export function renderGroupPicker(options: GroupPickerOptions): HTMLElement {
    const { columns, chosen, suggestions, onAdd, onRemove } = options;
    const root = el('div', 'analytical-picker');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Group by columns');

    const chosenIndexes = new Set(chosen.map(ref => ref.index));
    const chips = el('div', 'analytical-chips');
    if (chosen.length === 0) {
        chips.append(el('span', 'analytical-picker-hint', 'Group by:'));
    }
    chosen.forEach((ref, position) => {
        const chip = el('span', 'analytical-chip');
        chip.append(el('span', 'analytical-chip-order', String(position + 1)), el('span', 'analytical-chip-name', ref.name));
        const remove = el('button', 'analytical-chip-remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove grouping by ${ref.name}`);
        remove.addEventListener('click', () => onRemove(ref.index));
        chip.append(remove);
        chips.append(chip);
    });
    root.append(chips);

    if (chosen.length < ANALYTICAL_MAX_GROUP_COLUMNS) {
        const available = columns.filter(column => !chosenIndexes.has(column.index));
        if (available.length > 0) {
            const select = el('select', 'analytical-add');
            select.setAttribute('aria-label', 'Add a grouping column');
            select.append(new Option('+ Add column…', ''));
            for (const column of available) {
                select.append(new Option(column.name, String(column.index)));
            }
            select.addEventListener('change', () => {
                const column = columns.find(item => String(item.index) === select.value);
                if (column) {
                    onAdd(column);
                    // Reset to the placeholder so the control returns to "+ Add column…" for the next pick.
                    select.value = '';
                }
            });
            root.append(select);
        }

        const suggested = suggestions.filter(column => !chosenIndexes.has(column.index));
        if (suggested.length > 0) {
            const row = el('div', 'analytical-suggestions');
            row.append(el('span', 'analytical-suggestions-label', 'Suggested:'));
            for (const column of suggested) {
                const button = el('button', 'analytical-suggestion', column.name);
                button.type = 'button';
                button.addEventListener('click', () => onAdd(column));
                row.append(button);
            }
            root.append(row);
        }
    }
    return root;
}
