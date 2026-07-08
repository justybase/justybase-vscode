jest.unmock('chevrotain');

import type { CstNode, IRecognitionException, IToken } from 'chevrotain';
import { SqlLexer as baseSqlLexer, getSqlParserInstance as getBaseSqlParserInstance } from '../../sqlParser';
import {
    SqlLexer as netezzaSqlLexer
} from '../../dialects/netezza/sql/lexer';
import {
    getSqlParserInstance as getNetezzaSqlParserInstance
} from '../../dialects/netezza/sql/parser';

interface ParserWithStatements {
    input: IToken[];
    errors: IRecognitionException[];
    statements(): CstNode;
}

function parseSql(
    sql: string,
    lexer: { tokenize(text: string): { errors: unknown[]; tokens: IToken[] } },
    parser: ParserWithStatements
): { parserErrors: IRecognitionException[]; lexerErrors: unknown[] } {
    const lexResult = lexer.tokenize(sql);
    parser.input = lexResult.tokens;
    parser.errors = [];
    parser.statements();

    return {
        parserErrors: parser.errors,
        lexerErrors: lexResult.errors
    };
}

describe('BaseSqlParser architecture', () => {
    it('rejects TABLE WITH FINAL in the shared parser while keeping it in the Netezza parser', () => {
        const sql = 'SELECT F.* FROM TABLE WITH FINAL (DB1.SCH1.FLUID_FN()) F;';

        const baseResult = parseSql(sql, baseSqlLexer, getBaseSqlParserInstance() as unknown as ParserWithStatements);
        const netezzaResult = parseSql(
            sql,
            netezzaSqlLexer,
            getNetezzaSqlParserInstance() as unknown as ParserWithStatements
        );

        expect(baseResult.lexerErrors).toHaveLength(0);
        expect(baseResult.parserErrors.length).toBeGreaterThan(0);
        expect(netezzaResult.lexerErrors).toHaveLength(0);
        expect(netezzaResult.parserErrors).toHaveLength(0);
    });

    it('rejects DB..TABLE in the shared parser while keeping it in the Netezza parser', () => {
        const sql = 'SELECT * FROM DB1..TABLE1;';

        const baseResult = parseSql(sql, baseSqlLexer, getBaseSqlParserInstance() as unknown as ParserWithStatements);
        const netezzaResult = parseSql(
            sql,
            netezzaSqlLexer,
            getNetezzaSqlParserInstance() as unknown as ParserWithStatements
        );

        expect(baseResult.lexerErrors).toHaveLength(0);
        expect(baseResult.parserErrors.length).toBeGreaterThan(0);
        expect(netezzaResult.lexerErrors).toHaveLength(0);
        expect(netezzaResult.parserErrors).toHaveLength(0);
    });
});
