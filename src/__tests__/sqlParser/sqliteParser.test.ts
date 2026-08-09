jest.unmock('chevrotain');

import { describe, expect, it } from '@jest/globals';
import {
    SQLITE_SQL_PARSING_RUNTIME,
    parseSqlStatements,
    resolveSqlParsingRuntime,
} from '../../sqlParser/parsingRuntime';
import { sqliteSqlAuthoring } from '../../dialects/sqlite/sql/authoring';

function parse(sql: string) {
    return parseSqlStatements({ sql, runtime: SQLITE_SQL_PARSING_RUNTIME });
}

describe('SqliteSqlParser', () => {
    it('registers the SQLite runtime for kind and authoring contexts', () => {
        expect(resolveSqlParsingRuntime({ databaseKind: 'sqlite' }).id).toBe('sqlite');
        expect(resolveSqlParsingRuntime({ authoring: sqliteSqlAuthoring }).id).toBe('sqlite');
    });

    it.each([
        'SELECT id, count(*) FROM main.orders WHERE id BETWEEN 1 AND 10 GROUP BY id ORDER BY id LIMIT 5 OFFSET 1',
        'WITH recent AS (SELECT id FROM orders) SELECT id FROM recent',
        'INSERT OR REPLACE INTO orders (id, name) VALUES (1, \'one\') RETURNING id',
        'UPDATE orders SET name = \'two\' WHERE id = 1 RETURNING id, name',
        'DELETE FROM orders WHERE id = 1 RETURNING id',
        'CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL) STRICT',
        'CREATE TABLE untyped_columns (id, name NOT NULL, payload DEFAULT 1)',
        'CREATE TABLE generated_orders (id INT, name TEXT, name_length INT GENERATED ALWAYS AS (length(name)) STORED)',
        'CREATE INDEX IF NOT EXISTS orders_name_idx ON orders (name COLLATE NOCASE)',
        'CREATE VIEW IF NOT EXISTS recent_orders AS SELECT id FROM orders',
        'INSERT INTO orders (id, name) VALUES (1, \'one\') ON CONFLICT (id) DO UPDATE SET name = \'updated\' RETURNING id',
        'ATTACH \'other.db\' AS other',
        'PRAGMA main.foreign_keys = ON',
        'PRAGMA foreign_keys',
        'EXPLAIN QUERY PLAN SELECT * FROM orders WHERE id = 1',
        'SAVEPOINT unit_test',
        'RELEASE SAVEPOINT unit_test',
    ])('parses native SQLite syntax: %s', (sql) => {
        const result = parse(sql);
        expect(result.lexResult.errors).toHaveLength(0);
        expect(result.actionableParserErrors).toHaveLength(0);
        expect(result.cst).toBeDefined();
    });

    it('parses a trigger body', () => {
        const result = parse(`CREATE TRIGGER orders_ai AFTER INSERT ON orders
FOR EACH ROW BEGIN
  UPDATE orders SET name = 'updated' WHERE id = 1;
END`);
        expect(result.actionableParserErrors).toHaveLength(0);
    });

    it.each([
        'SELECT * FROM DB..TABLE',
        'GROOM TABLE orders VERSIONS',
        'CREATE TABLE orders (id INTEGER) DISTRIBUTE ON (id)',
        'CREATE EXTERNAL TABLE ext_orders (id INTEGER)',
    ])('rejects non-SQLite syntax: %s', (sql) => {
        const result = parse(sql);
        expect(result.actionableParserErrors.length).toBeGreaterThan(0);
    });

    it.each([
        // Inline column-level REFERENCES (without FOREIGN KEY prefix)
        'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))',
        'CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE)',
        'CREATE TABLE child (parent_id INTEGER CONSTRAINT fk REFERENCES parent(id))',
        // SQLite non-reserved keywords in identifier positions
        'SELECT rowid FROM t',
        'SELECT int FROM t',
        'SELECT double FROM t',
        'SELECT always FROM t',
        'SELECT stored FROM t',
        'SELECT analyze FROM t',
        'SELECT rowid, int FROM t WHERE double = 1',
        'CREATE TABLE t (rowid INTEGER, stored TEXT)',
        // BEGIN/COMMIT/ROLLBACK TRANSACTION
        'BEGIN TRANSACTION',
        'BEGIN IMMEDIATE TRANSACTION',
        'COMMIT TRANSACTION',
        'ROLLBACK TRANSACTION',
        'ROLLBACK TO SAVEPOINT sp1',
        // RETURNING * (and qualified star)
        'INSERT INTO t (x) VALUES (1) RETURNING *',
        'UPDATE t SET x = 1 RETURNING *, rowid',
        'DELETE FROM t RETURNING t.*',
        // ATTACH DATABASE
        'ATTACH DATABASE \'other.db\' AS other',
        // Named NOT NULL / DEFAULT constraints
        'CREATE TABLE t (x INTEGER CONSTRAINT nn NOT NULL)',
        'CREATE TABLE t (x INTEGER CONSTRAINT df DEFAULT 0)',
        'CREATE TABLE t (x INTEGER CONSTRAINT nn NOT NULL CONSTRAINT df DEFAULT 0)',
        // Column-level ON CONFLICT
        'CREATE TABLE t (x INTEGER PRIMARY KEY ON CONFLICT ROLLBACK)',
        'CREATE TABLE t (x INTEGER UNIQUE ON CONFLICT IGNORE)',
        'CREATE TABLE t (x INTEGER NOT NULL ON CONFLICT FAIL)',
        // Builtin functions colliding with keyword tokens
        'SELECT random()',
        'SELECT replace(name, \'a\', \'b\') FROM t',
        'SELECT glob(\'a*\', name) FROM t',
        'SELECT like(\'a%\', name) FROM t',
        // LIMIT forms
        'SELECT * FROM t LIMIT -1',
        'SELECT * FROM t LIMIT 5, 10',
        'SELECT * FROM t LIMIT 5 OFFSET 10',
        // UPDATE/DELETE ... ORDER BY ... LIMIT
        'UPDATE t SET x = 1 ORDER BY id LIMIT 5',
        'DELETE FROM t WHERE x = 1 ORDER BY id LIMIT 5',
        // GLOB / REGEXP / MATCH operators
        'SELECT * FROM t WHERE name GLOB \'a*\'',
        'SELECT * FROM t WHERE name NOT GLOB \'a*\'',
        'SELECT * FROM t WHERE name REGEXP \'^a\'',
        'SELECT * FROM t WHERE name MATCH \'a\'',
        // COLLATE in expressions
        'SELECT name COLLATE NOCASE FROM t',
        'SELECT * FROM t WHERE name COLLATE NOCASE = \'abc\'',
        'SELECT * FROM t WHERE name = \'abc\' COLLATE NOCASE',
        'SELECT * FROM t ORDER BY name COLLATE NOCASE',
        // WINDOW clause + OVER named window
        'SELECT sum(x) OVER w FROM t WINDOW w AS (PARTITION BY y ORDER BY z)',
        'SELECT sum(x) OVER (PARTITION BY y) FROM t',
        'SELECT rank() OVER w FROM t WINDOW w AS (ORDER BY z ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING)',
        // CREATE VIRTUAL TABLE
        'CREATE VIRTUAL TABLE vt USING fts5(content)',
        'CREATE VIRTUAL TABLE IF NOT EXISTS vt USING fts5(content, \'tokenize = porter\')',
        'CREATE TEMP VIRTUAL TABLE vt USING rtree(id, x, y)',
        // Schema-qualified trigger names
        'CREATE TRIGGER main.trig AFTER INSERT ON t BEGIN SELECT 1; END',
        // FK actions, MATCH and deferrability on inline REFERENCES
        'CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE ON UPDATE SET NULL)',
        'CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)',
        // PRAGMA with the reserved "temp" schema qualifier
        'PRAGMA temp.cache_size = 2000',
    ])('parses valid SQLite accepted by the runtime: %s', (sql) => {
        const result = parse(sql);
        expect(result.lexResult.errors).toHaveLength(0);
        expect(result.actionableParserErrors).toHaveLength(0);
    });

    it.each([
        'SELECT rowid FROM t',
        'BEGIN TRANSACTION',
        'COMMIT TRANSACTION',
        'INSERT INTO t(x) VALUES (1) RETURNING *',
        'ATTACH DATABASE \'x\' AS y',
        'SELECT random()',
        'CREATE TABLE t (x INTEGER CONSTRAINT nn NOT NULL)',
        'CREATE TABLE t (x INTEGER PRIMARY KEY ON CONFLICT ROLLBACK)',
        'CREATE TABLE t (x INTEGER REFERENCES o(id))',
        'SELECT * FROM t LIMIT 5, 10',
        'UPDATE t SET x = 1 LIMIT 1',
        'SELECT x FROM t WHERE x GLOB \'a*\'',
        'SELECT x COLLATE NOCASE FROM t',
        'SELECT x FROM t WINDOW w AS (PARTITION BY y)',
        'CREATE VIRTUAL TABLE vt USING fts5(content)',
        'CREATE TRIGGER main.trig AFTER INSERT ON t BEGIN SELECT 1; END',
    ])('reports no actionable errors for valid snippet: %s', (sql) => {
        const result = parse(sql);
        expect(result.actionableParserErrors).toHaveLength(0);
    });
});
