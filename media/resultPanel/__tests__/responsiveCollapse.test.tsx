import { describe, expect, it } from '@jest/globals';
import {
    calculateResponsiveVirtualItemSize,
    getResponsiveHiddenColumnIds,
} from '../grid/responsiveCollapse.js';

describe('responsive result-grid columns', () => {
    it('collapses rightmost regular columns first and retains one data column', () => {
        expect(getResponsiveHiddenColumnIds({
            enabled: true,
            grouped: false,
            viewportWidth: 160,
            rowNumberWidth: 50,
            columns: [
                { id: '0', width: 100 },
                { id: '1', width: 100 },
                { id: '2', width: 100 },
            ],
        })).toEqual(['1', '2']);
    });

    it('keeps pinned columns and respects the current manually visible column order', () => {
        expect(getResponsiveHiddenColumnIds({
            enabled: true,
            grouped: false,
            viewportWidth: 250,
            rowNumberWidth: 50,
            columns: [
                { id: 'pinned', width: 120, pinned: true },
                { id: 'visible-first', width: 100 },
                { id: 'visible-rightmost', width: 100 },
            ],
        })).toEqual(['visible-rightmost']);

        expect(getResponsiveHiddenColumnIds({
            enabled: true,
            grouped: false,
            viewportWidth: 250,
            rowNumberWidth: 50,
            columns: [{ id: 'visible', width: 100 }],
        })).toEqual([]);
    });

    it('does not collapse for disabled, grouped, zero-width, or already-fitting layouts', () => {
        const options = {
            enabled: true,
            grouped: false,
            viewportWidth: 0,
            rowNumberWidth: 50,
            columns: [{ id: '0', width: 400 }, { id: '1', width: 400 }],
        };
        expect(getResponsiveHiddenColumnIds(options)).toEqual([]);
        expect(getResponsiveHiddenColumnIds({ ...options, enabled: false, viewportWidth: 100 })).toEqual([]);
        expect(getResponsiveHiddenColumnIds({ ...options, grouped: true, viewportWidth: 100 })).toEqual([]);
        expect(getResponsiveHiddenColumnIds({
            ...options,
            viewportWidth: 500,
            columns: [{ id: '0', width: 100 }, { id: '1', width: 100 }],
        })).toEqual([]);
        expect(getResponsiveHiddenColumnIds({
            ...options,
            viewportWidth: Number.NaN,
        })).toEqual([]);
        expect(getResponsiveHiddenColumnIds({
            ...options,
            viewportWidth: -1,
        })).toEqual([]);
        expect(getResponsiveHiddenColumnIds({
            ...options,
            viewportWidth: 100,
            columns: [],
        })).toEqual([]);
        expect(getResponsiveHiddenColumnIds({
            ...options,
            viewportWidth: 1,
            rowNumberWidth: Number.NaN,
            columns: [{ id: '0', width: 0 }, { id: '1', width: Number.NaN }],
        })).toEqual(['1']);
    });

    it('keeps all-pinned layouts scrollable instead of hiding pinned columns', () => {
        expect(getResponsiveHiddenColumnIds({
            enabled: true,
            grouped: false,
            viewportWidth: 100,
            rowNumberWidth: 50,
            columns: [
                { id: 'left', width: 200, pinned: true },
                { id: 'right', width: 200, pinned: true },
            ],
        })).toEqual([]);
    });
});

describe('responsive virtual row measurement', () => {
    it('counts both the primary row and its expanded details', () => {
        expect(calculateResponsiveVirtualItemSize(28, 64, 24)).toBe(92);
    });

    it('uses the normal row estimate when an element is not laid out yet', () => {
        expect(calculateResponsiveVirtualItemSize(0, 0, 30)).toBe(30);
        expect(calculateResponsiveVirtualItemSize(Number.NaN, -4, 0)).toBe(1);
    });
});
