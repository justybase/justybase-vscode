// Detail pane: per-column statistics for the selected group, compared with the whole population.
// Columns with anomaly flags come first, ordered by their strongest flag.

import { evidenceRows } from './explain.js';
import type { AnomalyFlag } from './types.js';
import { el, formatPercent, formatStatNumber } from './elements.js';
import { ANALYTICAL_TOP_VALUES, type AnalyticalColumnStats, type AnalyticalGroup } from './types.js';

const ROLE_BADGE: Record<AnalyticalColumnStats['role'], string> = {
    dimension: 'DIM',
    measure: 'MEA',
    date: 'DATE',
    unknown: '?',
};

export interface DetailPaneOptions {
    group: AnalyticalGroup | undefined;
    population: readonly AnalyticalColumnStats[];
}

/** One-line summary of a column's statistics, used both for the group and the population. */
export function describeColumnStats(stats: AnalyticalColumnStats): string {
    const parts: string[] = [];
    if (stats.numeric) {
        const n = stats.numeric;
        parts.push(`min ${formatStatNumber(n.min)}`, `max ${formatStatNumber(n.max)}`, `avg ${formatStatNumber(n.mean)}`, `σ ${formatStatNumber(n.stddev)}`);
        if (n.cv !== null) {
            parts.push(`CV ${n.cv.toFixed(2)}`);
        }
    }
    if (stats.date) {
        parts.push(`${stats.date.min} → ${stats.date.max}`);
    }
    if (!stats.numeric && !stats.date) {
        parts.push(`${stats.distinctCount}${stats.distinctApprox ? '+' : ''} distinct`);
    }
    const nonNull = stats.rowCount - stats.nullCount;
    if (stats.topValues.length > 0 && !stats.numeric && nonNull > 0) {
        const top = stats.topValues.slice(0, Math.min(3, ANALYTICAL_TOP_VALUES))
            .map(entry => `${entry.value} ${formatPercent(entry.count / nonNull)}`);
        parts.push(`top: ${top.join(' · ')}`);
    }
    parts.push(`null ${formatPercent(stats.nullRate)}`);
    return parts.join(' · ');
}

function strongestStrength(stats: AnalyticalColumnStats, flagsByColumn: ReadonlyMap<number, number>): number {
    return flagsByColumn.get(stats.columnIndex) ?? 0;
}

/** A flag row with a 'Why?' disclosure listing the evidence behind it. */
export function buildFlagDisclosure(flag: AnomalyFlag): HTMLElement {
    const row = el('li', `analytical-flag analytical-flag--${flag.severity}`);
    row.dataset.rule = flag.rule;
    const details = el('details', 'analytical-why');
    const summary = el('summary', '', `${flag.message}`);
    summary.title = 'Why was this flagged?';
    details.append(summary);
    const definition = el('dl', 'analytical-why-rows');
    for (const item of evidenceRows(flag)) {
        definition.append(el('dt', '', item.label), el('dd', '', item.value));
    }
    details.append(definition);
    row.append(details);
    return row;
}

function buildColumnItem(
    stats: AnalyticalColumnStats,
    population: AnalyticalColumnStats | undefined,
    flags: AnalyticalGroup['flags'],
): HTMLElement {
    const item = el('li', 'analytical-column');
    if (flags.length > 0) item.classList.add('has-flags');

    const head = el('div', 'analytical-column-head');
    head.append(
        el('span', 'analytical-column-name', stats.name),
        el('span', `analytical-role analytical-role--${stats.role}`, ROLE_BADGE[stats.role]),
    );
    item.append(head);
    item.append(el('div', 'analytical-column-stats', describeColumnStats(stats)));
    if (population) {
        item.append(el('div', 'analytical-column-overall', `overall: ${describeColumnStats(population)}`));
    }
    if (flags.length > 0) {
        const list = el('ul', 'analytical-column-flags');
        for (const flag of flags) {
            list.append(buildFlagDisclosure(flag));
        }
        item.append(list);
    }
    return item;
}

export function renderDetailPane(options: DetailPaneOptions): HTMLElement {
    const { group, population } = options;
    const root = el('section', 'analytical-detail');
    root.setAttribute('aria-label', 'Group statistics');

    if (!group) {
        root.append(el('div', 'analytical-empty', 'Select a group to see its column statistics.'));
        return root;
    }

    const header = el('div', 'analytical-detail-head');
    header.append(el('h3', 'analytical-detail-title', group.label));
    const summary = `${group.rowCount} rows · ${formatPercent(group.share)} of result · score ${group.score}`;
    header.append(el('div', 'analytical-detail-summary', summary));
    if (group.anomalous) {
        header.append(el('span', 'analytical-detail-badge', 'Anomalous'));
    }
    if (group.isReference) {
        header.append(el('span', 'analytical-detail-badge', 'Reference'));
    }
    root.append(header);

    const populationByIndex = new Map(population.map(stats => [stats.columnIndex, stats] as const));
    const strongest = new Map<number, number>();
    for (const flag of group.flags) {
        if (flag.columnIndex === undefined) continue;
        strongest.set(flag.columnIndex, Math.max(strongest.get(flag.columnIndex) ?? 0, flag.strength));
    }
    const ordered = [...group.columns].sort((a, b) => {
        const diff = strongestStrength(b, strongest) - strongestStrength(a, strongest);
        return diff !== 0 ? diff : a.columnIndex - b.columnIndex;
    });

    const list = el('ul', 'analytical-columns');
    for (const stats of ordered) {
        const flags = group.flags.filter(flag => flag.columnIndex === stats.columnIndex);
        list.append(buildColumnItem(stats, populationByIndex.get(stats.columnIndex), flags));
    }
    root.append(list);

    const groupFlags = group.flags.filter(flag => flag.columnIndex === undefined);
    if (groupFlags.length > 0) {
        const note = el('ul', 'analytical-column-flags analytical-group-flags-list');
        for (const flag of groupFlags) {
            note.append(buildFlagDisclosure(flag));
        }
        root.append(note);
    }
    return root;
}
