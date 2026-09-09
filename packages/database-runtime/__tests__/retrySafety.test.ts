import { isSafeToRetrySql } from '../src';

describe('isSafeToRetrySql', () => {
  it.each([
    'SELECT 1',
    '\uFEFF -- reason\n /* nested /* note */ done */ SELECT * FROM T',
    '/* request */ SELECT \'semi;colon\'',
    '-- request\nVALUES (1, 2)',
    'SELECT \'mutate_customer(42)\'',
    'SELECT $$mutate_customer(42)$$',
    'SELECT $body$mutate_customer(42)$body$',
    'SELECT 1 /* mutate_customer(42) */',
    'SELECT 1 -- mutate_customer(42)\n',
    '--compact comment\nSELECT * FROM T',
    'SELECT * FROM T WHERE id = $1',
    'SELECT payload #>> \'{items,path}\' FROM events',
    'SHOW TABLES',
    'DESCRIBE T',
    'EXPLAIN SELECT 1',
    'EXPLAIN VERBOSE SELECT 1',
    'SELECT payload #> \'{items}\' FROM events',
  ])('accepts a conservative read shape: %s', sql => {
    expect(isSafeToRetrySql(sql)).toBe(true);
  });

  it.each([
    'SELECT 1; SELECT 2',
    'SELECT * INTO new_table FROM old_table',
    'SELECT nextval(\'order_id\')',
    'SELECT customer_seq.NEXTVAL FROM dual',
    'SELECT user_defined_function(value) FROM values_table',
    'SELECT "user_defined_function"(value) FROM values_table',
    'SELECT [user_defined_function](value) FROM values_table',
    'SELECT `user_defined_function`(value) FROM values_table',
    'SELECT функция(42)',
    'SELECT 1 # mutate_customer(42)',
    'SELECT 1--mutate_customer(42)',
    'SELECT 1 /*! mutate_customer(42) */',
    '/*! SET @state = 1 */ SELECT 1',
    'SELECT value FROM values_table FOR UPDATE',
    'VALUES NEXT VALUE FOR customer_seq',
    'VALUES mutate_customer(42)',
    'EXPLAIN ANALYZE SELECT 1',
    'EXPLAIN SELECT * INTO new_table FROM old_table',
    'EXPLAIN INSERT INTO new_table VALUES (1)',
    'SELECT 1 /* unterminated',
    'SELECT $$unterminated',
    'SELECT 1; -- trailing statement\nSELECT 2',
  ])('rejects a shape that must not be replayed: %s', sql => {
    expect(isSafeToRetrySql(sql)).toBe(false);
  });
});
