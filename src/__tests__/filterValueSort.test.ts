import { matchesFilterValueSearch, parseFilterNumericValue, sortFilterValues } from '../../media/resultPanel/filterValueSort';

describe('sortFilterValues', () => {
    it('sorts INT4 column values numerically ascending', () => {
        const sorted = sortFilterValues(['100', '10', '2', '1', '101'], 'INT4');

        expect(sorted).toEqual(['1', '2', '10', '100', '101']);
    });

    it('sorts numeric-looking values numerically when data type is unknown', () => {
        const sorted = sortFilterValues(['100', '10', '2', '1'], undefined);

        expect(sorted).toEqual(['1', '2', '10', '100']);
    });

    it('keeps alphabetical order for text columns', () => {
        const sorted = sortFilterValues(['b', 'a', 'c'], 'VARCHAR');

        expect(sorted).toEqual(['a', 'b', 'c']);
    });

    it('places NULL after numeric values', () => {
        const sorted = sortFilterValues(['10', 'NULL', '2'], 'INT4');

        expect(sorted).toEqual(['2', '10', 'NULL']);
    });

    it('sorts spaced YYYYMMDD display values numerically', () => {
        const sorted = sortFilterValues(['2011 01 16', '2010 12 28', '2011 01 01'], 'INT4');

        expect(sorted).toEqual(['2010 12 28', '2011 01 01', '2011 01 16']);
    });

    it('sorts grouped BIGINT display values numerically', () => {
        const sorted = sortFilterValues(['1 000', '123 456', '99 999'], 'INT8');

        expect(sorted).toEqual(['1 000', '99 999', '123 456']);
    });
});

describe('matchesFilterValueSearch', () => {
    it('matches compact numeric search against spaced date display', () => {
        expect(matchesFilterValueSearch('2010 12 28', '20101228')).toBe(true);
        expect(matchesFilterValueSearch('2010 12 28', '2010 12')).toBe(true);
        expect(matchesFilterValueSearch('2010 12 28', '20101229')).toBe(false);
    });

    it('matches compact numeric search against grouped BIGINT display', () => {
        expect(matchesFilterValueSearch('123 456', '123456')).toBe(true);
        expect(matchesFilterValueSearch('123 456', '1234')).toBe(true);
        expect(matchesFilterValueSearch('1 000 000', '1000000')).toBe(true);
        expect(matchesFilterValueSearch('123 456', '123457')).toBe(false);
    });

    it('parses grouped BIGINT values for numeric sort', () => {
        expect(parseFilterNumericValue('123 456')).toBe(123456);
        expect(parseFilterNumericValue('1 000 000')).toBe(1000000);
    });
});
