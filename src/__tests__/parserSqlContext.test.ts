jest.unmock('chevrotain');

import {
    parseSemanticScopeWithParser,
    parseAliasBindingsWithParser,
    parseLocalDefinitionsWithParser,
    parseVisibleLocalDefinitionsWithParser
} from '../providers/parsers/parserSqlContext';

describe('parserSqlContext', () => {
    it('parses alias bindings for TABLE WITH FINAL function sources', () => {
        const sql = 'SELECT F.* FROM TABLE WITH FINAL (DB1.SCH1.FLUID_FN()) F;';
        const bindings = parseAliasBindingsWithParser(sql);

        expect(bindings.get('F')).toEqual({
            db: 'DB1',
            schema: 'SCH1',
            table: 'FLUID_FN'
        });
    });

    it('keeps TABLE WITH FINAL function name binding without alias', () => {
        const sql = 'SELECT * FROM TABLE WITH FINAL (DB1.SCH1.FLUID_FN(1));';
        const bindings = parseAliasBindingsWithParser(sql);

        expect(bindings.get('FLUID_FN')).toEqual({
            db: 'DB1',
            schema: 'SCH1',
            table: 'FLUID_FN'
        });
    });

    it('parses PostgreSQL alias bindings for uppercase unquoted schema.table references', () => {
        const sql = 'SELECT o.__JB_COMPLETION__ FROM PUBLIC.ORDERS o';
        const bindings = parseAliasBindingsWithParser(sql, sql.indexOf('__JB_COMPLETION__'), 'postgresql');

        expect(bindings.get('O')).toEqual({
            schema: 'PUBLIC',
            table: 'ORDERS'
        });
    });

    it('parses Netezza alias bindings for DB..TABLE references', () => {
        const sql = 'SELECT a.__JB_COMPLETION__ FROM JUST_DATA..DIMACCOUNT a';
        const bindings = parseAliasBindingsWithParser(sql, sql.indexOf('__JB_COMPLETION__'));

        expect(bindings.get('A')).toEqual({
            db: 'JUST_DATA',
            table: 'DIMACCOUNT'
        });
    });

    it('keeps OF as a table alias in incomplete procedure token fallback', () => {
        const sql = `CREATE OR REPLACE PROCEDURE SOME_NAME()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
INSERT INTO JUST_DATA..DIMDATE(DATEKEY)
SELECT 1
FROM (SELECT DISTINCT 10 AS COL1 FROM DIMDATE) AS S
JOIN JUST_DATA..DIMEMPLOYEE E ON E.EMPLOYEEKEY = S.COL1
LEFT JOIN JUST_DATA..DIMACCOUNT OF ON E.BIRTHDATE = OF.__JB_COMPLETION__
RETURN 1;
END;
END_PROC;`;
        const scope = parseSemanticScopeWithParser(sql, sql.indexOf('__JB_COMPLETION__'));

        expect(scope.source).toBe('token');
        expect(scope.preferredAliasBindings.get('OF')).toEqual({
            db: 'JUST_DATA',
            table: 'DIMACCOUNT'
        });
    });

    it('parses PostgreSQL alias bindings for quoted schema.table references', () => {
        const sql = 'SELECT o.__JB_COMPLETION__ FROM "Sales"."Order Items" o';
        const bindings = parseAliasBindingsWithParser(sql, sql.indexOf('__JB_COMPLETION__'), 'postgresql');

        expect(bindings.get('O')).toEqual({
            schema: 'Sales',
            table: 'Order Items'
        });
    });

    it('does not leak inner subquery aliases into the outer query scope', () => {
        const sql = `SELECT D.__JB_COMPLETION__
FROM (
    SELECT X.ACCOUNTKEY
    FROM JUST_DATA..DIMACCOUNT X
) O
JOIN JUST_DATA..DIMDATE D ON D.DATEKEY = O.ACCOUNTKEY`;
        const bindings = parseAliasBindingsWithParser(sql, sql.indexOf('__JB_COMPLETION__'));

        expect(bindings.get('D')).toEqual({
            db: 'JUST_DATA',
            table: 'DIMDATE'
        });
        expect(bindings.has('X')).toBe(false);
    });

    it('builds a scoped snapshot with outer visible aliases and global fallback aliases', () => {
        const sql = `SELECT D.__JB_COMPLETION__
FROM (
    SELECT X.ACCOUNTKEY
    FROM JUST_DATA..DIMACCOUNT X
) O
JOIN JUST_DATA..DIMDATE D ON D.DATEKEY = O.ACCOUNTKEY`;
        const scope = parseSemanticScopeWithParser(sql, sql.indexOf('__JB_COMPLETION__'));

        expect(scope.aliasBindings.get('D')).toEqual({
            db: 'JUST_DATA',
            table: 'DIMDATE'
        });
        expect(scope.aliasBindings.has('X')).toBe(false);
        expect(scope.globalAliasBindings.get('X')).toEqual({
            db: 'JUST_DATA',
            table: 'DIMACCOUNT'
        });
    });

    it('parses quoted projected column names inside CTE local definitions', () => {
        const definitions = parseLocalDefinitionsWithParser(
            'WITH SALES_CTE AS (SELECT "Employee Id", "Full Name" FROM "HR"."Employees") SELECT * FROM SALES_CTE',
            'postgresql'
        );

        expect(definitions).toContainEqual({
            name: 'SALES_CTE',
            type: 'CTE',
            columns: ['Employee Id', 'Full Name']
        });
    });

    it('keeps later sibling CTEs hidden inside an earlier CTE body', () => {
        const sql = `WITH CTE1 AS (
    SELECT ID FROM USERS
),
CTE2 AS (
    SELECT ID FROM CTE1
)
SELECT * FROM CTE2`;
        const offset = sql.indexOf('ID FROM USERS');
        const visibleNames = parseVisibleLocalDefinitionsWithParser(sql, offset)
            .map((definition) => definition.name);

        expect(visibleNames).toEqual(['CTE1']);
    });

    it('keeps all local definitions while filtering visible ones at the cursor', () => {
        const sql = `WITH CTE1 AS (
    SELECT ID FROM USERS
),
CTE2 AS (
    SELECT ID FROM CTE1
)
SELECT * FROM CTE2`;
        const offset = sql.indexOf('ID FROM USERS');
        const scope = parseSemanticScopeWithParser(sql, offset);

        expect(scope.localDefinitions.map((definition) => definition.name)).toEqual(['CTE1', 'CTE2']);
        expect(scope.visibleLocalDefinitions.map((definition) => definition.name)).toEqual(['CTE1']);
    });

    it('keeps nested CTEs hidden in token fallback mode for incomplete JOIN statements', () => {
        const sql = `WITH CTE1 AS (
    WITH CTE2 AS (
        SELECT 1 AS ID, 'Alice' AS NAME
        UNION ALL
        SELECT 2 AS ID, 'Bob' AS NAME
    )
    SELECT CTE2.ID AS ID_2 FROM CTE2
)
SELECT * FROM CTE1 C
JOIN __JB_COMPLETION__`;
        const scope = parseSemanticScopeWithParser(sql, sql.indexOf('__JB_COMPLETION__'));

        expect(scope.localDefinitions.map((definition) => definition.name)).toEqual(
            expect.arrayContaining(['CTE1', 'CTE2'])
        );
        expect(scope.localDefinitions).toHaveLength(2);
        expect(scope.visibleLocalDefinitions.map((definition) => definition.name)).toEqual(['CTE1']);
    });

    it('exposes all top-level CTEs in the final statement scope', () => {
        const sql = `WITH CTE1 AS (
    SELECT ID FROM USERS
),
CTE2 AS (
    SELECT ID FROM CTE1
)
SELECT * FROM CTE2`;
        const offset = sql.lastIndexOf('SELECT * FROM CTE2') + 1;
        const visibleNames = parseVisibleLocalDefinitionsWithParser(sql, offset)
            .map((definition) => definition.name);

        expect(visibleNames).toEqual(['CTE1', 'CTE2']);
    });

    it('keeps nested INSERT CTE bodies from leaking inner CTEs into the outer insert scope', () => {
        const sql = `INSERT INTO TARGET_TABLE
WITH ABC AS (
    WITH DEF AS (
        SELECT 1 AS ID
    )
    SELECT ID FROM DEF
)
SELECT * FROM ABC`;
        const offset = sql.lastIndexOf('SELECT * FROM ABC') + 1;
        const scope = parseSemanticScopeWithParser(sql, offset);

        expect(scope.localDefinitions.map((definition) => definition.name)).toEqual(
            expect.arrayContaining(['ABC', 'DEF'])
        );
        expect(scope.visibleLocalDefinitions.map((definition) => definition.name)).toEqual(['ABC']);
    });

    it('parses qualified CTAS and global temp table local definitions', () => {
        const definitions = parseLocalDefinitionsWithParser(
            `CREATE TABLE JUST_DATA..TEST2 AS (SELECT 1 AS id);
             CREATE TABLE JUST_DATA.ADMIN.TEST3 AS (SELECT 2 AS id);
             CREATE GLOBAL TEMP TABLE TEST11 AS (SELECT 3 AS id);
             CREATE GLOBAL TEMP TABLE JUST_DATA.ADMIN.TEST12 AS (SELECT 4 AS id);`,
            'netezza',
        );

        expect(definitions).toEqual(
            expect.arrayContaining([
                { name: 'JUST_DATA..TEST2', type: 'Table', columns: ['id'] },
                { name: 'JUST_DATA.ADMIN.TEST3', type: 'Table', columns: ['id'] },
                { name: 'TEST11', type: 'Global Temp Table', columns: ['id'] },
                { name: 'JUST_DATA.ADMIN.TEST12', type: 'Global Temp Table', columns: ['id'] },
            ]),
        );
    });
});
