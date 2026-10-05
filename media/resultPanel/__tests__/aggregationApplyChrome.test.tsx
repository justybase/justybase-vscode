import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { showAggregationDropdown } from '../filter.js';
import { addGrid, resetGrids } from '../state.js';
import { getResultPanelWindow } from '../types.js';

beforeEach(() => {
    document.body.innerHTML = '';
    resetGrids();
    const panel = getResultPanelWindow();
    panel.resultSets = [];
    panel.activeSource = undefined;
});

describe('aggregation apply chrome refresh', () => {
    it('schedules a chrome render so the header badge appears immediately', () => {
        const scheduleRender = jest.fn();
        const anchor = document.createElement('span');
        document.body.appendChild(anchor);

        showAggregationDropdown(
            { id: '0', columnDef: { header: 'DATEKEY', dataType: 'INT4' } } as never,
            { getState: () => ({ grouping: [] }) } as never,
            anchor,
            0,
            1,
            scheduleRender,
        );

        const apply = document.querySelector<HTMLButtonElement>('.column-aggregation-dropdown .filter-btn.primary');
        expect(apply).not.toBeNull();
        apply!.click();

        expect(scheduleRender).toHaveBeenCalledWith({ chrome: true });
    });

    it('falls back to a full grid render when no scheduler is provided', () => {
        const render = jest.fn();
        const anchor = document.createElement('span');
        document.body.appendChild(anchor);
        addGrid({ render } as never);

        showAggregationDropdown(
            { id: '0', columnDef: { header: 'DATEKEY', dataType: 'INT4' } } as never,
            { getState: () => ({ grouping: [] }) } as never,
            anchor,
            0,
            1,
        );

        const apply = document.querySelector<HTMLButtonElement>('.column-aggregation-dropdown .filter-btn.primary');
        apply!.click();

        expect(render).toHaveBeenCalled();
    });
});
