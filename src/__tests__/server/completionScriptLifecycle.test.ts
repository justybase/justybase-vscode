jest.unmock('chevrotain');

import { parseLocalDefinitionsWithParser } from '../../providers/parsers/parserSqlContext';
import { filterScriptDefinitionsAt } from '../../server/completionLocalDefinitionUtils';

function visibleColumnsAt(sqlWithCaret: string): string[][] {
    const cursor = sqlWithCaret.indexOf('|');
    const sql = sqlWithCaret.replace('|', '');
    return filterScriptDefinitionsAt(parseLocalDefinitionsWithParser(sql, 'netezza'), cursor)
        .filter(definition => definition.name.toUpperCase() === 'TT')
        .map(definition => definition.columns.map(column => column.toUpperCase()));
}

describe('script-local table lifecycle for completion', () => {
    const create = 'CREATE TEMP TABLE TT AS SELECT ORDER_ID FROM ORDERS;\n';

    it('is visible after its CREATE statement', () => {
        expect(visibleColumnsAt(`${create}SELECT TT.|X FROM TT`)).toEqual([['ORDER_ID']]);
    });

    it('is not visible before its CREATE statement', () => {
        expect(visibleColumnsAt(`SELECT TT.|X FROM TT;\n${create}`)).toEqual([]);
    });

    it('ends at a DROP before the caret but not at a DROP after it', () => {
        expect(visibleColumnsAt(`${create}DROP TABLE TT;\nSELECT TT.|X FROM TT`)).toEqual([]);
        expect(visibleColumnsAt(`${create}SELECT TT.|X FROM TT;\nDROP TABLE TT;`)).toEqual([['ORDER_ID']]);
    });

    it('uses the re-created definition after CREATE -> DROP -> CREATE', () => {
        expect(visibleColumnsAt(
            `${create}DROP TABLE TT;\nCREATE TEMP TABLE TT AS SELECT CUSTOMER_NAME FROM CUSTOMERS;\nSELECT TT.|X FROM TT`,
        )).toEqual([['CUSTOMER_NAME']]);
    });
});
