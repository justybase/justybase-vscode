// Options panel for the Analytical view: detection mode, minimum group size, rule switches and the
// columns to analyse. Every control changes persisted state; the caller re-scores the cached result,
// so no option here starts a new computation.

import { ANOMALY_RULES } from './anomalyRules.js';
import { DETECTION_CHOICE_HELP, DETECTION_CHOICE_LABELS, DETECTION_CHOICES, DETECTION_MODE_NAME } from './detectionConfig.js';
import { el } from './elements.js';
import {
    ANALYTICAL_DEFAULT_MIN_GROUP_ROWS,
    type AnalyticalPersistedState,
    type AnomalyRuleId,
    type DetectionMode,
} from './types.js';

const MIN_GROUP_ROWS_MAX = 1000;

export interface OptionsColumn {
    index: number;
    name: string;
}

export interface OptionsGroup {
    key: string;
    label: string;
}

export interface OptionsPanelInput {
    open: boolean;
    state: AnalyticalPersistedState;
    effectiveMode: DetectionMode;
    columns: readonly OptionsColumn[];
    /** Listed groups, offered as the reference group in reference mode. */
    groups: readonly OptionsGroup[];
    panelId: string;
    onToggle: () => void;
    onUpdate: (update: (state: AnalyticalPersistedState) => AnalyticalPersistedState) => void;
}

function labelledCheckbox(text: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
    const label = el('label', 'analytical-toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    label.append(input, el('span', '', text));
    return label;
}

export function renderOptionsPanel(input: OptionsPanelInput): HTMLElement {
    const { open, state, effectiveMode, columns, groups, panelId, onToggle, onUpdate } = input;
    const root = el('div', 'analytical-options-root');

    const toggle = el('button', 'analytical-button', open ? 'Hide options' : 'Options');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-controls', panelId);
    toggle.addEventListener('click', onToggle);
    root.append(toggle);

    if (!open) {
        return root;
    }

    const section = el('section', 'analytical-options');
    section.id = panelId;
    section.setAttribute('aria-label', 'Analysis options');

    // Detection mode
    const modeRow = el('div', 'analytical-option-row');
    const modeLabel = el('label', '', 'Detection mode');
    const modeSelect = el('select', 'analytical-select');
    modeSelect.id = `${panelId}-mode`;
    modeLabel.htmlFor = modeSelect.id;
    for (const choice of DETECTION_CHOICES) {
        modeSelect.append(new Option(DETECTION_CHOICE_LABELS[choice], choice, false, state.detection.mode === choice));
    }
    modeSelect.addEventListener('change', () => {
        const mode = DETECTION_CHOICES.find(choice => choice === modeSelect.value) ?? 'default';
        onUpdate(current => ({ ...current, detection: { mode } }));
    });
    modeRow.append(modeLabel, modeSelect);
    section.append(modeRow);
    const help = el('p', 'analytical-option-help', `${DETECTION_CHOICE_HELP[state.detection.mode]} Effective: ${DETECTION_MODE_NAME[effectiveMode]}.`);
    help.setAttribute('aria-live', 'polite');
    section.append(help);

    if (state.detection.mode === 'reference') {
        const referenceRow = el('div', 'analytical-option-row');
        const referenceLabel = el('label', '', 'Reference group');
        const referenceSelect = el('select', 'analytical-select');
        referenceSelect.id = `${panelId}-reference`;
        referenceLabel.htmlFor = referenceSelect.id;
        referenceSelect.append(new Option('Choose a group', '', false, state.detection.referenceGroupKey === undefined));
        for (const group of groups) {
            referenceSelect.append(new Option(group.label, group.key, false, group.key === state.detection.referenceGroupKey));
        }
        referenceSelect.addEventListener('change', () => {
            const referenceGroupKey = referenceSelect.value === '' ? undefined : referenceSelect.value;
            onUpdate(current => ({ ...current, detection: { ...current.detection, referenceGroupKey } }));
        });
        referenceRow.append(referenceLabel, referenceSelect);
        section.append(referenceRow);
    }

    // Minimum group size
    const sizeRow = el('div', 'analytical-option-row');
    const sizeLabel = el('label', '', 'Minimum group size');
    const sizeInput = el('input');
    sizeInput.id = `${panelId}-min-rows`;
    sizeLabel.htmlFor = sizeInput.id;
    sizeInput.type = 'number';
    sizeInput.min = '1';
    sizeInput.max = String(MIN_GROUP_ROWS_MAX);
    sizeInput.value = String(state.minGroupRows || ANALYTICAL_DEFAULT_MIN_GROUP_ROWS);
    sizeInput.addEventListener('change', () => {
        const parsed = Number.parseInt(sizeInput.value, 10);
        const minGroupRows = Number.isFinite(parsed) ? Math.min(MIN_GROUP_ROWS_MAX, Math.max(1, parsed)) : ANALYTICAL_DEFAULT_MIN_GROUP_ROWS;
        sizeInput.value = String(minGroupRows);
        onUpdate(current => ({ ...current, minGroupRows }));
    });
    sizeRow.append(sizeLabel, sizeInput);
    section.append(sizeRow);

    // Rules
    const rules = el('fieldset', 'analytical-option-group');
    rules.append(el('legend', '', 'Rules'));
    const disabled = new Set<AnomalyRuleId>(state.disabledRules);
    for (const rule of ANOMALY_RULES) {
        rules.append(labelledCheckbox(rule.title, !disabled.has(rule.id), checked => {
            onUpdate(current => {
                const next = new Set<AnomalyRuleId>(current.disabledRules);
                if (checked) next.delete(rule.id);
                else next.add(rule.id);
                return { ...current, disabledRules: [...next] };
            });
        }));
    }
    section.append(rules);

    // Columns
    const excluded = new Set(state.excludedColumns.map(ref => ref.index));
    const columnGroup = el('fieldset', 'analytical-option-group');
    columnGroup.append(el('legend', '', 'Columns to analyse'));
    for (const column of columns) {
        columnGroup.append(labelledCheckbox(column.name, !excluded.has(column.index), checked => {
            onUpdate(current => {
                const others = current.excludedColumns.filter(ref => ref.index !== column.index);
                return {
                    ...current,
                    excludedColumns: checked ? others : [...others, { index: column.index, name: column.name }],
                };
            });
        }));
    }
    section.append(columnGroup);

    const reset = el('button', 'analytical-button', 'Reset options');
    reset.type = 'button';
    reset.addEventListener('click', () => {
        onUpdate(current => ({
            ...current,
            detection: { mode: 'default' },
            minGroupRows: ANALYTICAL_DEFAULT_MIN_GROUP_ROWS,
            disabledRules: [],
            excludedColumns: [],
        }));
    });
    section.append(reset);

    root.append(section);
    return root;
}
