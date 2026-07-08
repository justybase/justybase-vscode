import * as snowflakeExtension from '../../../../extensions/snowflake/src/extension';

describe('Snowflake optional extension smoke', () => {
    it('exports activate and deactivate entry points', () => {
        expect(typeof snowflakeExtension.activate).toBe('function');
        expect(typeof snowflakeExtension.deactivate).toBe('function');
    });
});
