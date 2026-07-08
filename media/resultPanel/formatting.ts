import {
    getActiveGridIndex,
    getResultFormattingPayload,
    getResultFormattingState,
    setResultFormattingState
} from './state.js';
import { saveAllGridStates } from './grid/persistence.js';
import { postHostMessage } from './protocol.js';
import {
    getActiveSourceUri,
    getResultPanelWindow,
    getResultSetAt,
    requireActiveSourceUri,
} from './types.js';
import type { FormattingSettings } from './utils.js';
import { getElementById } from './dom.js';

const vscode = { postMessage: postHostMessage };

export interface ResultFormattingPanelOptions {
    scope?: 'column' | 'result' | 'global' | 'connection';
    columnId?: string;
    columnName?: string;
}

interface ColumnFormattingOverride {
    kind?: string;
    integer?: Partial<FormattingSettings['integer']>;
    decimal?: Partial<FormattingSettings['decimal']>;
}

interface FormattingPayload {
    global?: Partial<FormattingSettings>;
    connection?: Partial<FormattingSettings>;
    columnOverrides?: Record<string, ColumnFormattingOverride>;
}

const DEFAULT_SETTINGS: FormattingSettings = {
    integer: { useGrouping: true, groupSeparator: ' ' },
    decimal: {
        useGrouping: true,
        groupSeparator: ' ',
        decimalSeparator: '.',
        scale: 4,
        preserveTrailingZeros: true,
        roundingMode: 'half-up'
    },
    useFormattedValuesForExport: false
};

function cloneSettings(settings: FormattingSettings): FormattingSettings {
    return {
        integer: { ...settings.integer },
        decimal: { ...settings.decimal },
        useFormattedValuesForExport: settings.useFormattedValuesForExport
    };
}

function mergeSettings(
    base: FormattingSettings,
    override?: Partial<FormattingSettings> | null,
): FormattingSettings {
    if (!override) {
        return cloneSettings(base);
    }

    return {
        integer: { ...base.integer, ...(override.integer || {}) },
        decimal: { ...base.decimal, ...(override.decimal || {}) },
        useFormattedValuesForExport: override.useFormattedValuesForExport ?? base.useFormattedValuesForExport
    };
}

function getCurrentResultSet() {
    const rsIndex = getActiveGridIndex();
    const rs = getResultSetAt(rsIndex);
    return { rsIndex, rs };
}

function getEffectiveSettings(columnId?: string) {
    const payload = (getResultFormattingPayload() || {
        global: DEFAULT_SETTINGS,
        columnOverrides: {},
    }) as FormattingPayload;
    let effective = mergeSettings(DEFAULT_SETTINGS, payload.global);
    effective = mergeSettings(effective, payload.connection);

    const { rsIndex, rs } = getCurrentResultSet();
    if (rs) {
        effective = mergeSettings(
            effective,
            getResultFormattingState(rsIndex, rs.executionTimestamp, getActiveSourceUri())
        );
    }

    const columnOverride = columnId ? payload.columnOverrides?.[columnId] : undefined;
    if (columnOverride?.integer) {
        effective.integer = { ...effective.integer, ...columnOverride.integer };
    }
    if (columnOverride?.decimal) {
        effective.decimal = { ...effective.decimal, ...columnOverride.decimal };
    }

    return {
        effective,
        columnOverride
    };
}

function createModal() {
    const overlay = document.createElement('div');
    overlay.id = 'resultFormattingOverlay';
    overlay.className = 'result-formatting-overlay';
    overlay.innerHTML = `
        <div class="result-formatting-modal">
            <div class="result-formatting-header">
                <div>
                    <strong>Result Formatting</strong>
                    <div id="resultFormattingSubtitle" class="result-formatting-subtitle"></div>
                </div>
                <button id="resultFormattingCloseBtn" class="secondary" type="button">Close</button>
            </div>
            <div class="result-formatting-body">
                <div class="result-formatting-section-title">Grid Appearance</div>
                <label class="result-formatting-field">
                    <span>Font family</span>
                    <select id="resultFormattingFont">
                        <option value="'JetBrains Mono', monospace">JetBrains Mono</option>
                        <option value="'Fira Code', monospace">Fira Code</option>
                        <option value="'Cascadia Code', monospace">Cascadia Code</option>
                        <option value="'Source Code Pro', monospace">Source Code Pro</option>
                        <option value="'IBM Plex Mono', monospace">IBM Plex Mono</option>
                        <option value="'Menlo', monospace">Menlo</option>
                        <option value="'Consolas', monospace">Consolas</option>
                        <option value="'Ubuntu Mono', monospace">Ubuntu Mono</option>
                        <option value="'Droid Sans Mono', monospace">Droid Sans Mono</option>
                        <option value="'Courier New', monospace">Courier New</option>
                        <option value="editor">Editor Font (follow VS Code setting)</option>
                    </select>
                </label>
                <label class="result-formatting-field">
                    <span>Font size</span>
                    <select id="resultFormattingFontSize">
                        <option value="9">9</option>
                        <option value="10">10</option>
                        <option value="11">11</option>
                        <option value="12">12</option>
                        <option value="13">13</option>
                        <option value="14">14</option>
                        <option value="15">15</option>
                        <option value="16">16</option>
                        <option value="18">18</option>
                        <option value="20">20</option>
                        <option value="24">24</option>
                    </select>
                </label>
                <div class="result-formatting-section-title">Numeric Formatting</div>
                <label class="result-formatting-field">
                    <span>Scope</span>
                    <select id="resultFormattingScope">
                        <option value="global">Global</option>
                        <option value="connection">Connection</option>
                        <option value="result">Current result</option>
                        <option value="column">Column</option>
                    </select>
                </label>
                <label class="result-formatting-field" id="resultFormattingKindField">
                    <span>Column kind</span>
                    <select id="resultFormattingKind">
                        <option value="auto">Auto</option>
                        <option value="integer">Integer</option>
                        <option value="decimal">Decimal</option>
                    </select>
                </label>
                <div class="result-formatting-grid">
                    <label class="result-formatting-checkbox">
                        <input type="checkbox" id="resultFormattingIntegerGrouping">
                        <span>Group integer values</span>
                    </label>
                    <label class="result-formatting-checkbox">
                        <input type="checkbox" id="resultFormattingDecimalGrouping">
                        <span>Group decimal values</span>
                    </label>
                    <label class="result-formatting-field">
                        <span>Group separator</span>
                        <select id="resultFormattingGroupSeparator">
                            <option value=" ">Space</option>
                            <option value=",">Comma</option>
                            <option value="_">Underscore</option>
                        </select>
                    </label>
                    <label class="result-formatting-field">
                        <span>Decimal separator</span>
                        <select id="resultFormattingDecimalSeparator">
                            <option value=".">Dot</option>
                            <option value=",">Comma</option>
                        </select>
                    </label>
                    <label class="result-formatting-field">
                        <span>Decimal places</span>
                        <input type="number" id="resultFormattingScale" min="0" max="12" step="1">
                    </label>
                    <label class="result-formatting-field">
                        <span>Rounding mode</span>
                        <select id="resultFormattingRounding">
                            <option value="half-up">Half up</option>
                            <option value="half-even">Half even</option>
                            <option value="floor">Floor</option>
                            <option value="ceil">Ceil</option>
                            <option value="truncate">Truncate</option>
                        </select>
                    </label>
                    <label class="result-formatting-checkbox">
                        <input type="checkbox" id="resultFormattingTrailingZeros">
                        <span>Preserve trailing zeros</span>
                    </label>
                    <label class="result-formatting-checkbox" id="resultFormattingExportField">
                        <input type="checkbox" id="resultFormattingExportMode">
                        <span>Use formatted values for export</span>
                    </label>
                </div>
                <div class="result-formatting-preview">
                    <div class="result-formatting-preview-label">Preview</div>
                    <div id="resultFormattingPreview" class="result-formatting-preview-value"></div>
                </div>
            </div>
            <div class="result-formatting-actions">
                <button id="resultFormattingApplyBtn" type="button">Apply</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#resultFormattingCloseBtn')?.addEventListener('click', closeResultFormattingPanel);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeResultFormattingPanel();
        }
    });

    return overlay;
}

function getModal() {
    return document.getElementById('resultFormattingOverlay') || createModal();
}

function asInput(id: string): HTMLInputElement | null {
    return getElementById(id) as HTMLInputElement | null;
}

function asSelect(id: string): HTMLSelectElement | null {
    return getElementById(id) as HTMLSelectElement | null;
}

function readFormState() {
    const scope = asSelect('resultFormattingScope')?.value ?? 'result';
    const kind = asSelect('resultFormattingKind')?.value ?? 'auto';
    return {
        scope,
        kind,
        settings: {
            integer: {
                useGrouping: asInput('resultFormattingIntegerGrouping')?.checked ?? false,
                groupSeparator: asSelect('resultFormattingGroupSeparator')?.value ?? ' '
            },
            decimal: {
                useGrouping: asInput('resultFormattingDecimalGrouping')?.checked ?? false,
                groupSeparator: asSelect('resultFormattingGroupSeparator')?.value ?? ' ',
                decimalSeparator: asSelect('resultFormattingDecimalSeparator')?.value ?? '.',
                scale: Number(asInput('resultFormattingScale')?.value || 0),
                preserveTrailingZeros: asInput('resultFormattingTrailingZeros')?.checked ?? false,
                roundingMode: asSelect('resultFormattingRounding')?.value ?? 'half-up'
            },
            useFormattedValuesForExport: asInput('resultFormattingExportMode')?.checked ?? false
        } satisfies FormattingSettings
    };
}

function updatePreviewValue() {
    const { settings, kind } = readFormState();
    const preview = document.getElementById('resultFormattingPreview');
    if (!preview) {
        return;
    }

    if (kind === 'integer') {
        const integerValue = settings.integer.useGrouping ? '123 456 789' : '123456789';
        preview.textContent = integerValue.replace(/ /g, settings.integer.groupSeparator);
        return;
    }

    const groupedInt = settings.decimal.useGrouping ? `123${settings.decimal.groupSeparator}456` : '123456';
    const fraction = settings.decimal.preserveTrailingZeros
        ? '7890'.slice(0, settings.decimal.scale).padEnd(settings.decimal.scale, '0')
        : '789'.slice(0, settings.decimal.scale);
    preview.textContent = settings.decimal.scale > 0
        ? `${groupedInt}${settings.decimal.decimalSeparator}${fraction}`
        : groupedInt;
}

function updateScopeVisibility() {
    const scope = asSelect('resultFormattingScope')?.value;
    const kindField = getElementById('resultFormattingKindField');
    const exportField = getElementById('resultFormattingExportField');
    if (kindField) kindField.style.display = scope === 'column' ? 'flex' : 'none';
    if (exportField) exportField.style.display = scope === 'column' ? 'none' : 'flex';
}

function bindPreviewListeners() {
    [
        'resultFormattingScope',
        'resultFormattingKind',
        'resultFormattingIntegerGrouping',
        'resultFormattingDecimalGrouping',
        'resultFormattingGroupSeparator',
        'resultFormattingDecimalSeparator',
        'resultFormattingScale',
        'resultFormattingRounding',
        'resultFormattingTrailingZeros',
        'resultFormattingExportMode'
    ].forEach(id => {
        const element = document.getElementById(id);
        if (!element) {
            return;
        }
        element.onchange = () => {
            updateScopeVisibility();
            updatePreviewValue();
        };
    });
}

function applyFormValues(options: ResultFormattingPanelOptions = {}) {
    const { effective, columnOverride } = getEffectiveSettings(options.columnId);
    const scopeSelect = asSelect('resultFormattingScope');
    const kindSelect = asSelect('resultFormattingKind');
    if (scopeSelect) scopeSelect.value = options.scope || 'result';
    if (kindSelect) kindSelect.value = columnOverride?.kind || 'auto';
    const integerGrouping = asInput('resultFormattingIntegerGrouping');
    const decimalGrouping = asInput('resultFormattingDecimalGrouping');
    const groupSeparator = asSelect('resultFormattingGroupSeparator');
    const decimalSeparator = asSelect('resultFormattingDecimalSeparator');
    const scaleInput = asInput('resultFormattingScale');
    const roundingSelect = asSelect('resultFormattingRounding');
    const trailingZeros = asInput('resultFormattingTrailingZeros');
    const exportMode = asInput('resultFormattingExportMode');
    if (integerGrouping) integerGrouping.checked = effective.integer.useGrouping ?? false;
    if (decimalGrouping) decimalGrouping.checked = effective.decimal.useGrouping ?? false;
    if (groupSeparator) groupSeparator.value = effective.decimal.groupSeparator ?? ' ';
    if (decimalSeparator) decimalSeparator.value = effective.decimal.decimalSeparator ?? '.';
    if (scaleInput) scaleInput.value = String(effective.decimal.scale ?? 4);
    if (roundingSelect) roundingSelect.value = effective.decimal.roundingMode ?? 'half-up';
    if (trailingZeros) trailingZeros.checked = effective.decimal.preserveTrailingZeros ?? false;
    if (exportMode) exportMode.checked = effective.useFormattedValuesForExport;

    const subtitle = getElementById('resultFormattingSubtitle');
    if (subtitle) {
        subtitle.textContent = options.columnName
            ? `Column: ${options.columnName}`
            : 'Configure numeric rendering for this results view.';
    }
    updateScopeVisibility();
    updatePreviewValue();
}

function applyFormatting(options: ResultFormattingPanelOptions = {}) {
    const { rsIndex, rs } = getCurrentResultSet();
    if (!rs) {
        return;
    }

    const formState = readFormState();
    const scope = formState.scope;

    if (scope === 'result') {
        setResultFormattingState(rsIndex, formState.settings, rs.executionTimestamp, getActiveSourceUri());
        saveAllGridStates();
        getResultPanelWindow().refreshResultsGrid?.();
        closeResultFormattingPanel();
        return;
    }

    if (scope === 'column' && options.columnId) {
        vscode.postMessage({
            command: 'updateResultFormatting',
            sourceUri: requireActiveSourceUri(),
            scope,
            columnId: options.columnId,
            settings: {
                kind: formState.kind,
                integer: formState.settings.integer,
                decimal: formState.settings.decimal
            }
        });
        closeResultFormattingPanel();
        return;
    }

    vscode.postMessage({
        command: 'updateResultFormatting',
        sourceUri: requireActiveSourceUri(),
        scope,
        settings: formState.settings
    });
    closeResultFormattingPanel();
}

function getCurrentGridFont(): string {
    var v = document.documentElement.style.getPropertyValue('--justybase-results-grid-font-family').trim();
    if (!v) {
        v = getComputedStyle(document.documentElement).getPropertyValue('--justybase-results-grid-font-family').trim();
    }
    return v;
}

function setGridFont(fontFamily: string): void {
    document.documentElement.style.setProperty('--justybase-results-grid-font-family', fontFamily);
}

function selectFontInDropdown(fontFamily: string) {
    const sel = asSelect('resultFormattingFont');
    if (!sel) return;
    // Try exact match first
    for (let i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === fontFamily) {
            sel.value = fontFamily;
            return;
        }
    }
    for (let i = 0; i < sel.options.length; i++) {
        const optVal = sel.options[i].value.replace(/'/g, '').toLowerCase();
        const fontLower = fontFamily.replace(/'/g, '').toLowerCase();
        if (optVal && fontLower.indexOf(optVal.split(',')[0]) >= 0) {
            sel.value = sel.options[i].value;
            return;
        }
    }
    sel.value = '';
}

function getCurrentGridFontSize(): number {
    let v = document.documentElement.style.getPropertyValue('--justybase-results-grid-font-size').trim();
    if (!v) {
        v = getComputedStyle(document.documentElement).getPropertyValue('--justybase-results-grid-font-size').trim();
    }
    return parseInt(v, 10) || 12;
}

function setGridFontSize(size: number): void {
    document.documentElement.style.setProperty('--justybase-results-grid-font-size', `${size}px`);
}

function selectFontSizeInDropdown(size: number): void {
    const sel = asSelect('resultFormattingFontSize');
    if (!sel) return;
    for (let i = 0; i < sel.options.length; i++) {
        if (parseInt(sel.options[i].value, 10) === size) {
            sel.value = String(size);
            return;
        }
    }
    sel.value = '12';
}

export function openResultFormattingPanel(options: ResultFormattingPanelOptions = {}): void {
    const modal = getModal();
    modal.style.display = 'flex';
    modal.dataset.columnId = options.columnId || '';
    modal.dataset.columnName = options.columnName || '';
    applyFormValues(options);
    bindPreviewListeners();

    // Font dropdown: select current font
    var currentFont = getCurrentGridFont();
    selectFontInDropdown(currentFont);

    // Font auto-save on change
    const fontSelect = asSelect('resultFormattingFont');
    if (fontSelect) {
        fontSelect.onchange = function () {
            const newFont = fontSelect.value;
        if (newFont === 'editor') {
            // Use editor font - read from CSS or fallback to default
            var editorFont = getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family').trim();
            if (editorFont) {
                setGridFont(editorFont);
            } else {
                setGridFont('Consolas, monospace');
            }
        } else {
            setGridFont(newFont);
        }
        vscode.postMessage({ command: 'updateGridFontFamily', fontFamily: newFont });
        };
    }

    const fontSizeSelect = asSelect('resultFormattingFontSize');
    if (fontSizeSelect) {
        const currentSize = getCurrentGridFontSize();
        selectFontSizeInDropdown(currentSize);
        fontSizeSelect.onchange = function () {
            const newSize = parseInt(fontSizeSelect.value, 10);
            if (!isNaN(newSize)) {
                setGridFontSize(newSize);
                vscode.postMessage({ command: 'updateGridFontSize', fontSize: newSize });
            }
        };
    }

    const applyButton = getElementById('resultFormattingApplyBtn');
    if (applyButton) {
        applyButton.onclick = () => applyFormatting(options);
    }
}

export function closeResultFormattingPanel(): void {
    const modal = document.getElementById('resultFormattingOverlay');
    if (modal) {
        modal.style.display = 'none';
    }
}

export function getCurrentExportFormattingMetadata(): {
    useFormattedValues: boolean;
    payload: ReturnType<typeof getResultFormattingPayload>;
    resultOverride: ReturnType<typeof getResultFormattingState> | null;
} {
    const { effective } = getEffectiveSettings();
    const { rsIndex, rs } = getCurrentResultSet();
    return {
        useFormattedValues: effective.useFormattedValuesForExport,
        payload: getResultFormattingPayload(),
        resultOverride: rs
            ? getResultFormattingState(rsIndex, rs.executionTimestamp, getActiveSourceUri())
            : null
    };
}