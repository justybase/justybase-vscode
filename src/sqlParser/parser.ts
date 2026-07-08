import * as sharedSqlLexer from '../dialects/netezza/sql/lexer';
import { BaseSqlParser } from './BaseSqlParser';

export { BaseSqlParser } from './BaseSqlParser';

/**
 * Compatibility parser that exposes the shared grammar. Internal dialect-aware callers
 * should prefer parsingRuntime.ts so the default Netezza experience stays unchanged.
 */
export class SqlParser extends BaseSqlParser {
  constructor() {
    super(sharedSqlLexer);
    this.finalizeParser();
  }
}

let _sqlParserInstance: SqlParser | undefined;

export function createSqlParserInstance(): SqlParser {
  return new SqlParser();
}

export function getSqlParserInstance(): SqlParser {
  if (!_sqlParserInstance) {
    _sqlParserInstance = createSqlParserInstance();
  }
  return _sqlParserInstance;
}

export const sqlParser = {
  get input(): unknown[] {
    return getSqlParserInstance().input;
  },
  set input(val: unknown[]) {
    getSqlParserInstance().input = val as never;
  },
  get errors(): unknown[] {
    return getSqlParserInstance().errors;
  },
  set errors(val: unknown[]) {
    getSqlParserInstance().errors = val as never;
  },
  getBaseCstVisitorConstructor(): ReturnType<SqlParser['getBaseCstVisitorConstructor']> {
    return getSqlParserInstance().getBaseCstVisitorConstructor();
  },
  getBaseCstVisitorConstructorWithDefaults(): ReturnType<
    SqlParser['getBaseCstVisitorConstructorWithDefaults']
  > {
    return getSqlParserInstance().getBaseCstVisitorConstructorWithDefaults();
  },
  getSerializedGastProductions(): ReturnType<SqlParser['getSerializedGastProductions']> {
    return getSqlParserInstance().getSerializedGastProductions();
  },
} as unknown as SqlParser;
