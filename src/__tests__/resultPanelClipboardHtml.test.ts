import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('result panel clipboard HTML', () => {
    const originalNumberFormat = Intl.NumberFormat;

    beforeEach(() => {
        jest.resetModules();
    });

    afterEach(() => {
        Intl.NumberFormat = originalNumberFormat;
        jest.restoreAllMocks();
    });

    it('emits numeric HTML cells with canonical Excel numeric payloads', () => {
        const { __testHooks } = require('../../media/resultPanel/selection.js');

        const payload = __testHooks.buildSelectedClipboardPayload({
            getAllColumns: () => [{
                id: 'amount',
                getIsVisible: () => true,
                columnDef: {
                    header: 'amount',
                    dataType: 'float',
                    scale: 0
                }
            }],
            getVisibleLeafColumns: function () { return this.getAllColumns(); },
            getRowModel: () => ({
                rows: [{
                    getValue: () => 2.5
                }]
            })
        }, new Set(['0-0']), true);

        expect(payload.text).toBe('amount\n2.5000');
        expect(payload.html).toContain('x:num="2.5"');
        expect(payload.html).toContain('>2.5000<');
    });

    it('localizes numeric display text without changing the Excel numeric payload', () => {
        Intl.NumberFormat = jest.fn(() => ({
            formatToParts: () => [
                { type: 'integer', value: '1' },
                { type: 'decimal', value: ',' },
                { type: 'fraction', value: '1' }
            ]
        })) as unknown as typeof Intl.NumberFormat;

        const { __testHooks } = require('../../media/resultPanel/selection.js');

        expect(__testHooks.localizeNumericDisplayText('2.5000')).toBe('2,5000');

        const payload = __testHooks.buildSelectedClipboardPayload({
            getAllColumns: () => [{
                id: 'amount',
                getIsVisible: () => true,
                columnDef: {
                    header: 'amount',
                    dataType: 'numeric',
                    scale: 4
                }
            }],
            getVisibleLeafColumns: function () { return this.getAllColumns(); },
            getRowModel: () => ({
                rows: [{
                    getValue: () => '2.5000'
                }]
            })
        }, new Set(['0-0']), true);

        expect(payload.html).toContain('x:num="2.5000"');
        expect(payload.html).toContain('>2,5000<');
    });
});
