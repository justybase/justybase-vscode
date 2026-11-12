import { beforeEach, describe, expect, it } from '@jest/globals';
import { updateControlsVisibility } from '../grid/alternateViews.js';
import { getResultPanelWindow } from '../types.js';
import type { ResultSet } from '../types.js';

function resultSet(overrides: Partial<ResultSet> = {}): ResultSet {
    return {
        name: 'Result 1',
        columns: [],
        data: [],
        isLog: false,
        isError: false,
        isTextContent: false,
        storageMode: 'memory',
        executionTimestamp: 1,
        ...overrides,
    } as unknown as ResultSet;
}

function installToolbar(): { controls: HTMLElement; group: HTMLElement; clearLogsBtn: HTMLElement } {
    document.body.innerHTML =
        `<div class="controls">` +
        `<div class="toolbar-group toolbar-group--view"><button>Table</button></div>` +
        `<div class="toolbar-separator"></div>` +
        `<button id="clearLogsBtn">Clear Logs</button>` +
        `</div>`;
    return {
        controls: document.querySelector('.controls') as HTMLElement,
        group: document.querySelector('.toolbar-group--view') as HTMLElement,
        clearLogsBtn: document.getElementById('clearLogsBtn') as HTMLElement,
    };
}

describe('result panel toolbar visibility per result kind', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        getResultPanelWindow().resultSets = [];
    });

    it('collapses the toolbar for an error result', () => {
        const { controls, group } = installToolbar();
        getResultPanelWindow().resultSets = [resultSet({ isError: true })];

        updateControlsVisibility(0);

        expect(controls.style.display).toBe('none');
        expect(group.style.display).toBe('none');
    });

    it('restores the toolbar when switching from an error to a data result', () => {
        const { controls, group } = installToolbar();
        getResultPanelWindow().resultSets = [resultSet({ isError: true }), resultSet({ data: [[1]] })];

        updateControlsVisibility(0);
        expect(controls.style.display).toBe('none');

        updateControlsVisibility(1);
        expect(controls.style.display).toBe('');
        expect(group.style.display).toBe('');
    });

    it('keeps the logs toolbar row for Clear Logs', () => {
        const { controls, group, clearLogsBtn } = installToolbar();
        getResultPanelWindow().resultSets = [resultSet({ isLog: true, data: [['12:00', 'log line']] })];

        updateControlsVisibility(0);

        expect(controls.style.display).toBe('');
        expect(clearLogsBtn.style.display).toBe('inline-flex');
        expect(group.style.display).toBe('none');
    });
});
