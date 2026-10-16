// Master pane: the list of groups. Keyboard navigation follows the WAI listbox pattern
// (roving selection with arrow, Home, End, PageUp and PageDown keys).

import { ANALYTICAL_SCORE_ANOMALOUS, type AnalyticalGroup, type AnomalyRuleId } from './types.js';
import { el, formatPercent } from './elements.js';

const RULE_SHORT_LABEL: Record<AnomalyRuleId, string> = {
    MEAN_SHIFT: 'mean',
    RANGE_OUTLIER: 'range',
    HIGH_VARIABILITY: 'spread',
    NULL_RATE_DELTA: 'nulls',
    CONSTANT_IN_GROUP: 'constant',
    TOP_VALUE_DOMINANCE: 'dominant',
    RARE_VALUE: 'rare',
    DATE_WINDOW_SHIFT: 'dates',
    SMALL_GROUP: 'small',
    LARGE_GROUP: 'large',
    MIX_SHIFT: 'mix',
};

const MAX_LISTED_FLAGS = 3;
const PAGE_STEP = 10;

export interface MasterPaneOptions {
    groups: readonly AnalyticalGroup[];
    selectedKey?: string;
    onSelect: (key: string) => void;
}

function nextIndex(current: number, key: string, length: number): number | null {
    switch (key) {
        case 'ArrowDown': return Math.min(length - 1, current + 1);
        case 'ArrowUp': return Math.max(0, current - 1);
        case 'Home': return 0;
        case 'End': return length - 1;
        case 'PageDown': return Math.min(length - 1, current + PAGE_STEP);
        case 'PageUp': return Math.max(0, current - PAGE_STEP);
        default: return null;
    }
}

function buildFlagChip(group: AnalyticalGroup, flagIndex: number): HTMLElement {
    const flag = group.flags[flagIndex];
    const columnName = group.columns.find(column => column.columnIndex === flag.columnIndex)?.name;
    const label = `${RULE_SHORT_LABEL[flag.rule]}${columnName ? ` · ${columnName}` : ''}`;
    const chip = el('span', `analytical-flag analytical-flag--${flag.severity}`, label);
    chip.title = flag.message;
    // Severity is also conveyed by text, not only colour.
    chip.dataset.severity = flag.severity;
    return chip;
}

function buildItem(group: AnalyticalGroup, selected: boolean, onSelect: (key: string) => void): HTMLElement {
    const item = el('div', 'analytical-group');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', selected ? 'true' : 'false');
    item.tabIndex = selected ? 0 : -1;
    item.dataset.key = group.key;
    if (selected) item.classList.add('is-selected');
    if (group.anomalous) item.classList.add('is-anomalous');
    item.addEventListener('click', () => onSelect(group.key));

    const main = el('div', 'analytical-group-main');
    main.append(
        el('span', 'analytical-group-label', group.label),
        el('span', 'analytical-group-count', `${group.rowCount} · ${formatPercent(group.share)}`),
    );
    const bar = el('span', 'analytical-share-bar');
    const fill = el('span', 'analytical-share-fill');
    fill.style.width = `${Math.min(100, Math.max(0, group.share * 100))}%`;
    bar.append(fill);
    main.append(bar);
    const score = el('span', 'analytical-score', String(group.score));
    score.title = `Anomaly score (${ANALYTICAL_SCORE_ANOMALOUS}+ is anomalous)`;
    main.append(score);
    item.append(main);

    if (group.flags.length > 0) {
        const flags = el('div', 'analytical-group-flags');
        const shown = Math.min(MAX_LISTED_FLAGS, group.flags.length);
        for (let index = 0; index < shown; index++) {
            flags.append(buildFlagChip(group, index));
        }
        if (group.flags.length > shown) {
            flags.append(el('span', 'analytical-flag analytical-flag--more', `+${group.flags.length - shown}`));
        }
        item.append(flags);
    }
    return item;
}

export function renderMasterPane(options: MasterPaneOptions): HTMLElement {
    const { groups, selectedKey, onSelect } = options;
    const root = el('div', 'analytical-master');
    const list = el('div', 'analytical-master-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Groups');

    if (groups.length === 0) {
        list.append(el('div', 'analytical-empty', 'No groups match the current filter.'));
    }
    groups.forEach(group => list.append(buildItem(group, group.key === selectedKey, onSelect)));

    list.addEventListener('keydown', (event) => {
        const current = Math.max(0, groups.findIndex(group => group.key === selectedKey));
        const target = nextIndex(current, event.key, groups.length);
        if (target === null || groups.length === 0) {
            return;
        }
        event.preventDefault();
        onSelect(groups[target].key);
    });

    root.append(list);
    return root;
}
