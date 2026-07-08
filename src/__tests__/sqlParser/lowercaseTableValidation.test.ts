jest.unmock('chevrotain');

import { SqlValidator } from '../../sqlParser/validator';
import { createMockSchemaProvider } from '../../sqlParser/schemaProvider';

describe('SqlValidator lowercase quoted table names', () => {
    const schema = createMockSchemaProvider([
        {
            database: 'JUST_DATA',
            schema: 'ADMIN',
            name: 'lower_table',
            columns: ['ID', 'NAME'],
        },
        {
            database: 'JUST_DATA',
            schema: 'ADMIN',
            name: 'ORDERS',
            columns: ['ORDER_ID'],
        },
    ]);
    const validator = new SqlValidator(schema);

    it('should validate SELECT * FROM db.schema."lower_table"', () => {
        const result = validator.validate('SELECT * FROM JUST_DATA.ADMIN."lower_table"');
        const sql003 = result.errors.filter((e) => e.code === 'SQL003');
        expect(sql003).toEqual([]);
    });

    it('should validate SELECT * FROM db.schema.lower_table when catalog name is lowercase', () => {
        const result = validator.validate('SELECT * FROM JUST_DATA.ADMIN.lower_table');
        const sql003 = result.errors.filter((e) => e.code === 'SQL003');
        expect(sql003).toEqual([]);
    });

    it('should validate table alias after quoted lowercase table', () => {
        const result = validator.validate('SELECT a.* FROM JUST_DATA.ADMIN."lower_table" a');
        const sql003 = result.errors.filter((e) => e.code === 'SQL003');
        expect(sql003).toEqual([]);
    });

    it('should validate unqualified column reference on quoted lowercase table', () => {
        const result = validator.validate('SELECT id FROM JUST_DATA.ADMIN."lower_table"');
        expect(result.errors.filter((e) => e.code === 'SQL003')).toEqual([]);
        expect(result.errors.filter((e) => e.code === 'SQL004')).toEqual([]);
    });

    it('should validate qualified column reference on quoted lowercase table', () => {
        const result = validator.validate('SELECT lower_table.id FROM JUST_DATA.ADMIN."lower_table"');
        expect(result.errors.filter((e) => e.code === 'SQL003')).toEqual([]);
        expect(result.errors.filter((e) => e.code === 'SQL004')).toEqual([]);
    });
});
