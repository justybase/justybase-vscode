jest.unmock('chevrotain');

import { parseSqlStatements } from '../../sqlParser/parsingRuntime';
import { POSTGRESQL_VALID_SQL_CORPUS } from './postgresqlValidSqlCorpus';

function parse(sql: string) {
  return parseSqlStatements({ sql, databaseKind: 'postgresql' });
}

describe('PostgreSQL committed valid SQL corpus', () => {
  it.each([...POSTGRESQL_VALID_SQL_CORPUS])('parses without actionable errors: %s', sql => {
    const result = parse(sql);
    expect(result.lexResult.errors).toEqual([]);
    expect(
      result.actionableParserErrors.map(error => ({
        message: error.message,
        token: error.token?.image,
        offset: error.token?.startOffset,
      })),
    ).toEqual([]);
  });
});
