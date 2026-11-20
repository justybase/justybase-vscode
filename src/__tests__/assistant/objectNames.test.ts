import {
    normalizeObjectName,
    shortObjectName,
    sqlObjectName,
} from '../../core/assistant/objectNames';

describe('assistant object name qualification', () => {
    it('preserves the Netezza DATABASE..TABLE notation', () => {
        expect(normalizeObjectName({ object: 'DWH..ORDERS' })).toBe('DWH..ORDERS');
        expect(sqlObjectName({ object: 'DWH..ORDERS' })).toBe('"DWH".."ORDERS"');
    });

    it('applies explicit database and schema values', () => {
        expect(normalizeObjectName({ object: 'ORDERS', database: 'DWH', schema: 'ADMIN' }))
            .toBe('DWH.ADMIN.ORDERS');
        expect(normalizeObjectName({ object: 'ORDERS', database: 'DWH' })).toBe('DWH..ORDERS');
        expect(normalizeObjectName({ object: 'ADMIN.ORDERS', database: 'DWH' }))
            .toBe('DWH.ADMIN.ORDERS');
        expect(sqlObjectName({ object: 'ADMIN.ORDERS', database: 'DWH' }))
            .toBe('"DWH"."ADMIN"."ORDERS"');
    });

    it('supports quoted identifiers', () => {
        expect(sqlObjectName({ object: '"MyDb".."MyTable"' })).toBe('"MyDb".."MyTable"');
        expect(shortObjectName('"MyDb"."MyTable"')).toBe('MyTable');
    });

    it('rejects conflicting or malformed names', () => {
        expect(() => normalizeObjectName({ object: 'DWH..ORDERS', database: 'OTHER' }))
            .toThrow(/Conflicting database/);
        expect(() => normalizeObjectName({ object: 'ADMIN.ORDERS', schema: 'OTHER' }))
            .toThrow(/Conflicting schema/);
        expect(() => normalizeObjectName({ object: 'A..B..C' })).toThrow();
        expect(() => normalizeObjectName({ object: 'ORDERS; DROP TABLE X' })).toThrow();
    });
});
