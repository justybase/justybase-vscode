import { TableReferenceExtractor } from '../../../services/copilot/TableReferenceExtractor';



describe('TableReferenceExtractor', () => {
    let extractor: TableReferenceExtractor;

    beforeEach(() => {
        extractor = new TableReferenceExtractor();
    });

    it('should extract simple table names', () => {
        const sql = 'SELECT * FROM CUSTOMERS JOIN ORDERS ON 1=1';
        const refs = extractor.extract(sql);

        expect(refs).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'CUSTOMERS' }),
            expect.objectContaining({ name: 'ORDERS' })
        ]));
    });

    it('should extract fully qualified names via DB..TABLE syntax', () => {
        const sql = 'SELECT * FROM DB1..CUSTOMERS';
        const refs = extractor.extract(sql);

        expect(refs).toEqual(expect.arrayContaining([
            expect.objectContaining({ database: 'DB1', name: 'CUSTOMERS' })
        ]));
    });

    it('should extract simple table names with schema', () => {
        const sql = 'SELECT * FROM SCHEMA1.CUSTOMERS';
        const refs = extractor.extract(sql);

        expect(refs).toEqual(expect.arrayContaining([
            expect.objectContaining({ schema: 'SCHEMA1', name: 'CUSTOMERS' })
        ]));
    });

    it('should extract fully qualified names with schema', () => {
        const sql = 'SELECT * FROM DB1.SCHEMA1.CUSTOMERS';
        const refs = extractor.extract(sql);

        expect(refs).toEqual(expect.arrayContaining([
            expect.objectContaining({ database: 'DB1', schema: 'SCHEMA1', name: 'CUSTOMERS' })
        ]));
    });

    it('should ignore references inside comments', () => {
        const sql = `
            SELECT * FROM VALID_TABLE
            -- SELECT * FROM COMMENT_TABLE
            /* 
               JOIN OTHERS ON ...
            */
        `;
        const refs = extractor.extract(sql);

        expect(refs).toContainEqual(expect.objectContaining({ name: 'VALID_TABLE' }));
        expect(refs).not.toContainEqual(expect.objectContaining({ name: 'COMMENT_TABLE' }));
        expect(refs).not.toContainEqual(expect.objectContaining({ name: 'OTHERS' }));
    });
});
