jest.unmock("chevrotain");
import { analyzeSql, objectId, type ObjectReference } from '../services/analysis/sqlAnalysis';
import { DependencyIndex, describeProposedChange, parseProposedChange } from '../services/analysis/dependencyIndex';
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
    test('equality joins require bare column operands, not arbitrary expressions', () => {
        expect(analyzeSql('SELECT ID FROM A JOIN B ON A.ID = B.ID', context).joins).toHaveLength(1);
        expect(analyzeSql('SELECT ID FROM A WHERE A.X = A.Y', context).joins).toHaveLength(0);
        expect(analyzeSql('SELECT ID FROM A JOIN B ON A.X + B.Y = 100', context).joins).toHaveLength(0);
        expect(analyzeSql('SELECT ID FROM A WHERE A.ID = 100', context).joins).toHaveLength(0);
        expect(analyzeSql('SELECT ID FROM A JOIN B ON ABS(A.ID) = B.ID', context).joins).toHaveLength(0);
        expect(analyzeSql('SELECT ID FROM A JOIN B ON A.ID != B.ID', context).joins).toHaveLength(0);
    });
    test('bare star projects only its own FROM, not sibling subqueries', () => {
        const result = analyzeSql('SELECT A.* FROM A WHERE EXISTS (SELECT 1 FROM B)', context);
        expect(result.references.filter(r => r.kind === 'wildcard').map(r => r.target.name)).toEqual(['A']);
    });
    test('each star stays in its own SELECT scope', () => {
        const result = analyzeSql('SELECT * FROM A WHERE EXISTS (SELECT * FROM B)', context);
        expect(result.references.filter(r => r.kind === 'wildcard').map(r => r.target.name)).toEqual(['A','B']);
        const qualified = analyzeSql('SELECT A.* FROM A JOIN B ON A.ID = B.ID', context);
        expect(qualified.references.filter(r => r.kind === 'wildcard').map(r => r.target.name)).toEqual(['A']);
        expect(qualified.joins).toHaveLength(1);
    });
    test('multiplication is not a wildcard', () => {
        const result = analyzeSql('SELECT A.ID * B.ID FROM A JOIN B ON A.ID = B.ID', context);
        expect(result.references.filter(r => r.kind === 'wildcard')).toHaveLength(0);
        expect(result.references).not.toEqual([]);
    });
    test('namespace-aware identity separates routines from relations', () => {
        const table = { database: 'DB', schema: 'PUBLIC', name: 'X', type: 'TABLE' as const };
        const procedure = { ...table, type: 'PROCEDURE' as const };
        expect(objectId(table)).not.toBe(objectId(procedure));
        expect(objectId(table)).toBe(objectId({ ...table, type: 'VIEW' }));
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
    test('column references aggregate per object pair with column evidence', async () => {
        const index = new DependencyIndex();
        await index.update([{ object: object('V'), sql: 'SELECT A.EMAIL, A.NAME FROM A' }]);
        const report = index.getReport(object('A'), 'incoming', 1);
        expect(report.edges).toHaveLength(1);
        expect(report.edges[0].columns?.sort()).toEqual(['EMAIL','NAME']);
    });
    test('issues are collected only for reachable objects', async () => {
        const index = new DependencyIndex();
        await index.update([{ object: object('V'), sql: 'SELECT * FROM A' }, { object: object('W'), sql: 'this is not sql FROM Z' }]);
        expect(index.getReport(object('A'), 'incoming', 1).issues.join(' ')).not.toContain('parsed reliably');
    });
    test('procedures and tables with one name stay in separate namespaces', async () => {
        const index = new DependencyIndex();
        const procedure = { database: 'DB', schema: 'PUBLIC', name: 'X', type: 'PROCEDURE' as const };
        const table = { database: 'DB', schema: 'PUBLIC', name: 'X', type: 'TABLE' as const };
        await index.update([{ object: procedure, sql: 'SELECT ID FROM T' }]);
        expect(index.getReport(table, 'incoming', 1).affected).toEqual([]);
        expect(index.getReport(procedure, 'outgoing', 1).affected.map(a => a.object.name)).toEqual(['T']);
    });
    test('free-text change parsing keeps the explicit column and handles the to-form', () => {
        expect(parseProposedChange('Change column EMAIL to VARCHAR(5)')).toEqual({ kind: 'changeColumnType', column: 'EMAIL', toType: 'VARCHAR(5)' });
        expect(parseProposedChange('Change column EMAIL type to VARCHAR(5)')).toEqual({ kind: 'changeColumnType', column: 'EMAIL', toType: 'VARCHAR(5)' });
        expect(parseProposedChange('Change EMAIL to VARCHAR(5)')).toEqual({ kind: 'changeColumnType', column: 'EMAIL', toType: 'VARCHAR(5)' });
        expect(parseProposedChange('Change column EMAIL VARCHAR(10) to VARCHAR(5)')).toEqual({ kind: 'changeColumnType', column: 'EMAIL', fromType: 'VARCHAR(10)', toType: 'VARCHAR(5)' });
        expect(parseProposedChange('Change VARCHAR(10) -> VARCHAR(5)', 'EMAIL')).toEqual({ kind: 'changeColumnType', column: 'EMAIL', fromType: 'VARCHAR(10)', toType: 'VARCHAR(5)' });
    });
    test('same-named procedure and relation stay separate during traversal', async () => {
        const index = new DependencyIndex();
        const table = { database: 'DB', schema: 'PUBLIC', name: 'X', type: 'TABLE' as const };
        const procedure = { database: 'DB', schema: 'PUBLIC', name: 'X', type: 'PROCEDURE' as const };
        await index.update([{ object: procedure, sql: 'SELECT ID FROM X' }], [table, procedure]);
        const report = index.getReport(procedure, 'outgoing', 2);
        expect(report.affected.map(a => a.object.type)).toContain('TABLE');
    });
    test('proposed change drives severity instead of display text', async () => {
        const index = new DependencyIndex();
        await index.update([{ object: object('V'), sql: 'SELECT A.EMAIL FROM A' }, { object: object('W'), sql: 'SELECT * FROM A' }]);
        const dropped = index.getReport(object('A'), 'incoming', 1, undefined, 300, { kind: 'dropColumn', column: 'EMAIL' });
        expect(new Map(dropped.affected.map(a => [a.object.name, a.severity])).get('V')).toBe('high');
        expect(new Map(dropped.affected.map(a => [a.object.name, a.severity])).get('W')).toBe('medium');
        const removed = index.getReport(object('A'), 'incoming', 1, undefined, 300, { kind: 'dropObject' });
        expect(new Map(removed.affected.map(a => [a.object.name, a.severity])).get('W')).toBe('high');
    });
    test.each([
        ['Drop EMAIL', undefined, { kind: 'dropObject' }],
        ['drop column EMAIL', undefined, { kind: 'dropColumn', column: 'EMAIL' }],
        ['Rename column EMAIL to MAIL', undefined, { kind: 'renameColumn', from: 'EMAIL', to: 'MAIL' }],
        ['Change VARCHAR(10) -> VARCHAR(5)', 'EMAIL', { kind: 'changeColumnType', column: 'EMAIL', fromType: 'VARCHAR(10)', toType: 'VARCHAR(5)' }],
        ['rename table to NEW', undefined, { kind: 'renameObject', to: 'NEW' }],
        ['something else', 'EMAIL', { kind: 'dropColumn', column: 'EMAIL' }],
        ['something else', undefined, { kind: 'dropObject' }],
    ])('parseProposedChange classifies %s', (text, column, expected) => {
        expect(parseProposedChange(text, column)).toEqual(expected);
        expect(describeProposedChange(parseProposedChange(text, column), object('A'))).toContain('A');
    });
    test('cancelled update cannot publish', async () => {
        const index = new DependencyIndex();
        expect(await index.update([{ object: context, sql: 'SELECT * FROM A' }], [], () => true)).toBe(false);
        expect(index.getReport(context, 'outgoing').edges).toEqual([]);
    });
});
