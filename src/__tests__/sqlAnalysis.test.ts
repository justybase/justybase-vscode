jest.unmock("chevrotain");
import { analyzeSql, objectId, type ObjectReference } from '../services/analysis/sqlAnalysis';
import { DependencyIndex } from '../services/analysis/dependencyIndex';
const context: ObjectReference = { database: 'DB', schema: 'PUBLIC', name: 'V', type: 'VIEW' };
const objects = (sql: string) => analyzeSql(sql, context).references.filter(r => r.kind === 'object').map(r => r.target.name);
describe('shared CST analysis', () => {
    test.each([
        ['SELECT * FROM CUSTOMER;', ['CUSTOMER']],
        ['SELECT * FROM DB1.PUBLIC.CUSTOMER;', ['CUSTOMER']],
        ['SELECT * FROM CUSTOMER C JOIN ORDERS O ON C.ID = O.ID;', ['CUSTOMER', 'ORDERS']],
        ['WITH X AS (SELECT * FROM SALES) SELECT * FROM X JOIN CUSTOMER C ON X.ID = C.ID;', ['SALES', 'CUSTOMER']],
        ['SELECT * FROM (SELECT * FROM CUSTOMER) X;', ['CUSTOMER']],
        ['CREATE VIEW V AS SELECT * FROM CUSTOMER;', ['CUSTOMER']],
    ])('%s', (sql, expected) => { expect(objects(sql)).toEqual(expected); });
    test('qualification, columns and equality joins', () => {
        const result = analyzeSql('SELECT C.NAME, O.ID FROM CUSTOMER C JOIN ORDERS O ON C.ID = O.ID;', context);
        expect(result.issues).toEqual([]);
        expect(result.references.find(r => r.column === 'NAME')?.target.name).toBe('CUSTOMER');
        expect(result.joins).toHaveLength(1);
        expect(analyzeSql('SELECT * FROM DB1.PUBLIC.CUSTOMER', context).references[0].target.database).toBe('DB1');
    });
    test('procedures and dynamic SQL', () => {
        const result = analyzeSql("CREATE PROCEDURE P() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC BEGIN SELECT ID INTO X FROM CUSTOMER; EXECUTE IMMEDIATE variable; CALL OTHER(); END; END_PROC;", context);
        expect(result.references.map(r => r.target.name)).toContain('CUSTOMER');
        expect(result.references.map(r => r.target.name)).toContain('OTHER');
        expect(result.issues.join(' ')).toMatch(/Dynamic/);
    });
    test('invalid SQL produces no invented references', () => {
        const result = analyzeSql('this is not sql FROM CUSTOMER', context);
        expect(result.references).toEqual([]); expect(result.issues).not.toHaveLength(0);
    });

    test('implicit cross-database schema and ambiguous columns remain partial', () => {
        const cross=analyzeSql('SELECT * FROM OTHER_DB..CUSTOMER',context);
        expect(cross.references.find(reference=>reference.kind==='object')?.target.schema).toBe('');
        expect(cross.issues.join(' ')).toContain('implicit target schema');
        const ambiguous=analyzeSql('SELECT ID FROM CUSTOMER C JOIN ORDERS O ON C.ID=O.ID',context);
        expect(ambiguous.issues.join(' ')).toContain('ambiguous');
        expect(ambiguous.references.filter(reference=>reference.column==='ID')).toHaveLength(2);
        expect(analyzeSql('SELECT * FROM CUSTOMER WHERE ID=ABS(-1)',context).patterns.map(pattern=>pattern.kind)).not.toContain('conversion');
    });
    test('patterns', () => {
        const result = analyzeSql("SELECT DISTINCT CAST(A.ID AS VARCHAR) FROM A CROSS JOIN B WHERE CAST(A.ID AS VARCHAR) = '1' GROUP BY A.ID ORDER BY A.ID", context);
        expect(result.patterns.map(p => p.kind)).toEqual(expect.arrayContaining(['distinct', 'conversion', 'group', 'sort', 'cartesian']));
    });
});
describe('dependency index', () => {
    const object = (name: string): ObjectReference => ({ ...context, name });
    test('reverse traversal, cycles and bounded depth', async () => {
        const index = new DependencyIndex();
        await index.update(['A','B','C'].map((name, i) => ({ object: object(name), sql: `SELECT * FROM ${['B','C','A'][i]}` })));
        expect(index.getReport(object('A'), 'incoming', 1).affected.map(a => a.object.name)).toEqual(['C']);
        expect(index.getReport(object('A'), 'incoming', 100).affected.map(a => a.object.name)).toEqual(['C','B']);
        expect(index.getReport(object('A'), 'outgoing', 100, undefined, 2).truncated).toBe(true);
    });
    test('definition changes and invalidation', async () => {
        const index = new DependencyIndex();
        await index.update([{ object: context, sql: 'SELECT ID FROM A' }]);
        expect(index.getReport(object('A'), 'incoming').affected).toHaveLength(1);
        await index.update([{ object: context, sql: 'SELECT ID FROM B' }]);
        expect(index.getReport(object('A'), 'incoming').affected).toHaveLength(0);
        index.invalidate(); expect(index.getReport(context, 'outgoing').edges).toHaveLength(0);
        expect(objectId(object('A'))).not.toBe(objectId({ ...object('A'), schema: 'OTHER' }));
    });
    test('column impact excludes unrelated columns and keeps indirect effects', async () => {
        const index = new DependencyIndex();
        await index.update([{ object: object('V'), sql: 'SELECT A.EMAIL FROM A' }, { object: object('W'), sql: 'SELECT ID FROM V' }]);
        expect(index.getReport(object('A'), 'incoming', 3, 'EMAIL').affected.map(a => a.object.name)).toEqual(['V','W']);
        expect(index.getReport(object('A'), 'incoming', 3, 'OTHER').affected).toEqual([]);
    });
    test('cancelled update cannot publish', async () => {
        const index = new DependencyIndex();
        expect(await index.update([{ object: context, sql: 'SELECT * FROM A' }], [], () => true)).toBe(false);
        expect(index.getReport(context, 'outgoing').edges).toEqual([]);
    });
});
