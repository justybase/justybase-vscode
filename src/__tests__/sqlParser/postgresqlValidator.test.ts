jest.unmock('chevrotain');
import { SqlValidator } from '../../sqlParser/validator';
import { InMemorySchemaProvider } from '../../sqlParser/schemaProvider';
import { postgresqlSqlAuthoring } from '../../../packages/dialect-utils/src/authoring/postgresql';

describe('PostgreSQL semantic validation', () => {
  const schema = new InMemorySchemaProvider();
  schema.createTable(undefined, undefined, 'items', ['id', 'payload']);
  const validate = (sql: string) => {
    const result = new SqlValidator(schema, postgresqlSqlAuthoring.validation).validate(sql);
    return [...result.errors, ...result.warnings];
  };
  it.each([
    'SELECT ARRAY[missing] FROM items',
    'UPDATE items SET id=1 WHERE id=1 RETURNING missing',
    'INSERT INTO items(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET id=excluded.missing',
    'SELECT "ID" FROM items',
  ])('checks references in %s', sql => expect(validate(sql).map(x => x.code)).toContain('SQL004'));
  it('distinguishes quoted aliases from folded aliases', () => {
    expect(validate('SELECT i.id FROM items "I"').map(issue => issue.code)).toContain('SQL003');
  });
  it.each([
    'SELECT 1 WHERE true',
    'SELECT "I".id, i.payload FROM items "I" CROSS JOIN items i',
    'SELECT I.ID FROM ITEMS I',
    'UPDATE items AS i SET id=1 WHERE i.id=1 RETURNING i.id AS changed_id',
    'INSERT INTO items(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET id=excluded.id RETURNING id',
    'SELECT ARRAY[id] FROM items',
    'DELETE FROM items i USING items o WHERE i.id=o.id RETURNING i.id',
    'SELECT * FROM generate_series(1,2) AS t(id)',
    'CREATE TABLE typed(amount NUMERIC, label VARCHAR)',
  ])('avoids foreign dialect diagnostics for %s', sql => {
    expect(validate(sql).filter(x => ['SQL004','SQL042','SQL046','SQL013'].includes(x.code ?? ''))).toEqual([]);
  });
});
