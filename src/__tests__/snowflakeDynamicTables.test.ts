import {
    buildObjectTypeQuery,
    buildObjectSearchQuery,
    buildColumnsWithKeysQuery,
} from '../../extensions/snowflake/src/snowflakeSystemQueries';

describe('Snowflake Dynamic Tables', () => {
    it('includes DYNAMIC TABLE in object type query routing', () => {
        const query = buildObjectTypeQuery('MYDB', 'DYNAMIC TABLE');
        expect(query).toContain('DYNAMIC TABLE');
        expect(query).toContain('SHOW DYNAMIC TABLES');
    });

    it('includes DYNAMIC TABLE in object search query', () => {
        const query = buildObjectSearchQuery('MYDB', '%ORDERS%');
        expect(query).toContain('DYNAMIC TABLE');
    });

    it('allows DYNAMIC TABLE in columns with keys query', () => {
        const query = buildColumnsWithKeysQuery('MYDB', 'PUBLIC', undefined, ['DYNAMIC TABLE']);
        expect(query).toContain('DYNAMIC TABLE');
    });
});
