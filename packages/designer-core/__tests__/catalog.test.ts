import {
  parseDuckDbConstraints,
  parseDuckDbIndexes,
  parseSqliteCheckConstraints,
  parseSqliteTrigger,
  splitTopLevelList,
  viewQueryFromSource,
} from '../src/catalog';
import { describe, expect, it } from '@jest/globals';

describe('designer catalog parsers', () => {
  it('splits nested and quoted catalog lists at top-level commas', () => {
    expect(splitTopLevelList('a, func(1, 2), "a,b"')).toEqual(['a', 'func(1, 2)', '"a,b"']);
  });

  it('parses SQLite checks and trigger metadata without a database runtime', () => {
    expect(parseSqliteCheckConstraints('CREATE TABLE orders (id INTEGER, CONSTRAINT positive CHECK (id > 0), CHECK (id < 100));')).toEqual([
      { kind: 'check', name: 'positive', expression: 'id > 0' },
      { kind: 'check', expression: 'id < 100' },
    ]);
    expect(parseSqliteTrigger('orders_audit', 'CREATE TRIGGER orders_audit AFTER UPDATE OF status ON orders WHEN NEW.status <> OLD.status BEGIN SELECT 1; END;')).toMatchObject({
      name: 'orders_audit',
      timing: 'AFTER',
      events: ['UPDATE'],
      updateColumns: ['status'],
      whenExpression: 'NEW.status <> OLD.status',
    });
  });

  it('normalizes DuckDB constraints, indexes, and view source', () => {
    expect(parseDuckDbConstraints([
      { constraint_type: 'FOREIGN KEY', constraint_name: 'fk_orders_customer', constraint_column_names: ['customer_id'], referenced_table: 'customers', referenced_column_names: ['id'] },
      { constraint_type: 'CHECK', constraint_name: 'positive', constraint_text: 'amount >= 0' },
    ], 'main')).toEqual([
      { kind: 'foreignKey', name: 'fk_orders_customer', columns: ['customer_id'], referencedSchema: 'main', referencedTable: 'customers', referencedColumns: ['id'], enforced: true },
      { kind: 'check', name: 'positive', expression: 'amount >= 0', enforced: true },
    ]);
    expect(parseDuckDbIndexes([{ index_name: 'idx_orders', expressions: ['customer_id'], is_unique: 1, sql: 'CREATE INDEX idx_orders' }])).toEqual([
      { kind: 'relational', name: 'idx_orders', columns: [{ expression: 'customer_id' }], unique: true, sourceDdl: 'CREATE INDEX idx_orders' },
    ]);
    expect(viewQueryFromSource('CREATE VIEW orders_view AS SELECT * FROM orders;')).toBe('SELECT * FROM orders');
  });
});
