/**
 * Unit tests for sqlParser barrel exports.
 */

import * as sqlParserModule from '../sqlParser';

describe('sqlParser/index exports', () => {
    it('exports core parser/validator APIs', () => {
        expect(sqlParserModule.SqlValidator).toBeDefined();
        expect(sqlParserModule.sqlValidator).toBeDefined();
        expect(sqlParserModule.SqlLexer).toBeDefined();
        expect(sqlParserModule.sqlParser).toBeDefined();
        expect(sqlParserModule.getSqlParserInstance).toBeDefined();
        expect(sqlParserModule.BaseSqlParser).toBeDefined();
        expect(sqlParserModule.parseSqlStatements).toBeDefined();
        expect(sqlParserModule.resolveSqlParsingRuntime).toBeDefined();
        expect(sqlParserModule.runWithSqlParserSession).toBeDefined();
        expect(sqlParserModule.SqlVisitor).toBeDefined();
        expect(sqlParserModule.ScopeBuilder).toBeDefined();
    });
});
