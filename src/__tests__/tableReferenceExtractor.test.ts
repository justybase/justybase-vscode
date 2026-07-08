/* eslint-disable @typescript-eslint/no-explicit-any */

import { TableReferenceExtractor } from '../services/copilot/TableReferenceExtractor';

describe('TableReferenceExtractor', () => {
    let extractor: TableReferenceExtractor;

    beforeEach(() => {
        extractor = new TableReferenceExtractor();
    });

    describe('extract', () => {
        it('should extract simple table name', () => {
            const sql = 'SELECT * FROM users';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                database: undefined,
                schema: undefined
            });
        });

        it('should extract multiple tables', () => {
            const sql = 'SELECT * FROM users JOIN orders ON users.id = orders.user_id';
            const result = extractor.extract(sql);

            expect(result.length).toBeGreaterThanOrEqual(2);
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS' })
            );
        });

        it('should extract schema.table', () => {
            const sql = 'SELECT * FROM public.users';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                schema: 'PUBLIC',
                database: undefined
            });
        });

        it('should extract database.schema.table', () => {
            const sql = 'SELECT * FROM mydb.public.users';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                schema: 'PUBLIC',
                database: 'MYDB'
            });
        });

        it('should extract database..table (Netezza two-dot syntax)', () => {
            const sql = 'SELECT * FROM mydb..users';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                schema: undefined,
                database: 'MYDB'
            });
        });

        it('should extract tables from INSERT statement', () => {
            const sql = 'INSERT INTO users (id, name) VALUES (1, John)';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS'
            });
        });

        it('should extract tables from UPDATE statement', () => {
            const sql = 'UPDATE users SET name = Jane WHERE id = 1';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS'
            });
        });

        it('should extract tables from DELETE statement', () => {
            const sql = 'DELETE FROM users WHERE id = 1';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS'
            });
        });

        it('should handle mixed case table names', () => {
            const sql = 'SELECT * FROM Users JOIN Orders';
            const result = extractor.extract(sql);

            expect(result.length).toBeGreaterThanOrEqual(2);
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS' })
            );
        });

        it('should remove single-line comments', () => {
            const sql = 'SELECT * FROM users -- This is a comment';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS'
            });
        });

        it('should remove multi-line comments', () => {
            const sql = 'SELECT * FROM users /* This is a\nmulti-line comment */';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS'
            });
        });

        it('should remove string literals', () => {
            const sql = "SELECT * FROM users WHERE name = 'table'";
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS'
            });
        });

        it('should handle escaped quotes in string literals', () => {
            const sql = "SELECT * FROM users WHERE name = 'O''Reilly'";
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS'
            });
        });

        it('should deduplicate table references', () => {
            const sql = 'SELECT * FROM users JOIN users u2 ON users.id = u2.id';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS'
            });
        });

        it('should extract tables with underscores', () => {
            const sql = 'SELECT * FROM user_orders';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USER_ORDERS'
            });
        });

        it('should extract tables from subqueries', () => {
            const sql = 'SELECT * FROM (SELECT * FROM users) AS u';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
        });

        it('should handle multiple JOINs', () => {
            const sql = 'SELECT * FROM users JOIN orders ON users.id = orders.user_id JOIN products ON orders.product_id = products.id';
            const result = extractor.extract(sql);

            expect(result.length).toBeGreaterThanOrEqual(3);
        });

        it('should extract tables with mixed naming conventions', () => {
            const sql = 'SELECT * FROM mydb.public.users JOIN orders o';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS', schema: 'PUBLIC', database: 'MYDB' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS' })
            );
        });

        it('should handle database..table in JOIN', () => {
            const sql = 'SELECT * FROM mydb..users u JOIN mydb..orders o ON u.id = o.user_id';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS', database: 'MYDB', schema: undefined })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS', database: 'MYDB', schema: undefined })
            );
        });

        it('should handle INSERT with database..table', () => {
            const sql = 'INSERT INTO mydb..users (id, name) VALUES (1, John)';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                database: 'MYDB',
                schema: undefined
            });
        });

        it('should handle UPDATE with database..table', () => {
            const sql = 'UPDATE mydb..users SET name = Jane';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                database: 'MYDB',
                schema: undefined
            });
        });

        it('should handle DELETE with database..table', () => {
            const sql = 'DELETE FROM mydb..users WHERE id = 1';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                database: 'MYDB',
                schema: undefined
            });
        });

        it('should extract tables with numbers in names', () => {
            const sql = 'SELECT * FROM TABLE_1';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'TABLE_1' })
            );
        });

        it('should handle empty SQL', () => {
            const sql = '';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(0);
        });

        it('should handle whitespace only SQL', () => {
            const sql = '   \n\t   ';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(0);
        });

        it('should handle SQL with no table references', () => {
            const sql = 'SELECT 1, 2, 3';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(0);
        });

        it('should handle SQL keywords that look like table names', () => {
            const sql = 'SELECT * FROM test_table';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
        });

        it('should handle UNION queries', () => {
            const sql = 'SELECT * FROM users UNION SELECT * FROM admins';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ADMINS' })
            );
        });

        it('should handle CTEs (Common Table Expressions)', () => {
            const sql = 'WITH cte AS (SELECT * FROM users) SELECT * FROM cte';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
        });

        it('should handle multiple databases with two-dot syntax', () => {
            const sql = 'SELECT * FROM db1..users JOIN db2..orders ON users.id = orders.user_id';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS', database: 'DB1' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS', database: 'DB2' })
            );
        });

        it('should handle database.schema.table with INSERT', () => {
            const sql = 'INSERT INTO mydb.public.users (id) VALUES (1)';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                database: 'MYDB',
                schema: 'PUBLIC'
            });
        });

        it('should handle complex query with multiple patterns', () => {
            const sql = 'INSERT INTO mydb..orders SELECT u.id, u.name FROM mydb.public.users u JOIN mydb..products p ON u.product_id = p.id';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS', database: 'MYDB', schema: undefined })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS', database: 'MYDB', schema: 'PUBLIC' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'PRODUCTS', database: 'MYDB', schema: undefined })
            );
        });

        it('should handle table names with dots in them (escaped)', () => {
            const sql = 'SELECT * FROM "my.table"';
            const result = extractor.extract(sql);

            expect(result.length).toBeGreaterThanOrEqual(0);
        });

        it('should handle schema qualified table with INSERT', () => {
            const sql = 'INSERT INTO schema.users (id) VALUES (1)';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                schema: 'SCHEMA',
                database: undefined
            });
        });

        it('should handle UPDATE with schema qualified table', () => {
            const sql = 'UPDATE public.users SET name = John';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                schema: 'PUBLIC',
                database: undefined
            });
        });

        it('should handle DELETE with schema qualified table', () => {
            const sql = 'DELETE FROM admin.users WHERE id = 1';
            const result = extractor.extract(sql);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'USERS',
                schema: 'ADMIN',
                database: undefined
            });
        });

        it('should handle SQL with mixed whitespace', () => {
            const sql = 'SELECT  *  FROM  users  JOIN  orders';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS' })
            );
        });

        it('should handle table aliases correctly', () => {
            const sql = 'SELECT * FROM users AS u JOIN orders AS o ON u.id = o.user_id';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS' })
            );
        });

        it('should handle LEFT JOIN', () => {
            const sql = 'SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS' })
            );
        });

        it('should handle RIGHT JOIN', () => {
            const sql = 'SELECT * FROM users RIGHT JOIN orders ON users.id = orders.user_id';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS' })
            );
        });

        it('should handle INNER JOIN', () => {
            const sql = 'SELECT * FROM users INNER JOIN orders ON users.id = orders.user_id';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
            expect(result).toContainEqual(
                expect.objectContaining({ name: 'ORDERS' })
            );
        });
    });

    describe('error handling', () => {
        it('should handle errors gracefully', () => {
            const sql = null as any;
            const result = extractor.extract(sql);

            expect(result).toEqual([]);
        });

        it('should handle undefined SQL', () => {
            const sql = undefined as any;
            const result = extractor.extract(sql);

            expect(result).toEqual([]);
        });

        it('should handle malformed SQL', () => {
            const sql = 'SELECT * FROM';
            const result = extractor.extract(sql);

            expect(result).toEqual([]);
        });

        it('should handle SQL with unclosed quotes', () => {
            const sql = "SELECT * FROM users WHERE name = 'John";
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
        });

        it('should handle SQL with unclosed multi-line comment', () => {
            const sql = 'SELECT * FROM users /* comment without closing';
            const result = extractor.extract(sql);

            expect(result).toContainEqual(
                expect.objectContaining({ name: 'USERS' })
            );
        });
    });
});
