jest.unmock('chevrotain');

import { describe, expect, it } from '@jest/globals';
import {
    CLICKHOUSE_SQL_PARSING_RUNTIME,
    parseSqlStatements,
} from '../../sqlParser/parsingRuntime';
import { clickhouseSqlAuthoring } from '../../../extensions/clickhouse/src/sql/authoring';
import { createSqlParserInstance } from '../../../src/dialects/clickhouse/sql/parser';
import { SqlLexer } from '../../../src/dialects/clickhouse/sql/lexer';

function parse(sql: string) {
    return parseSqlStatements({ sql, runtime: CLICKHOUSE_SQL_PARSING_RUNTIME });
}

describe('ClickHouse SQL parser', () => {
    it('tokenizes ClickHouse comments and query-only clauses', () => {
        const result = SqlLexer.tokenize(
            'SELECT * FROM events PREWHERE id > 0 ARRAY JOIN tags QUALIFY id = 1 # ClickHouse comment',
        );
        expect(result.errors).toHaveLength(0);
        expect(result.tokens.map(token => token.tokenType.name)).toEqual(
            expect.arrayContaining([
                'ClickHousePrewhere',
                'ClickHouseArrayJoin',
                'ClickHouseQualify',
            ]),
        );
    });

    it.each([
        'SELECT * FROM `analytics`.`events` PREWHERE event_date >= toDate(\'2024-01-01\')',
        'SELECT id, tag FROM events ARRAY JOIN tags',
        'SELECT id, row_number() OVER (PARTITION BY group_id ORDER BY id) AS rn FROM events QUALIFY rn = 1',
        'SELECT toDate(event_date) AS day, count() FROM events GROUP BY day ORDER BY day LIMIT 10 BY group_id WITH FILL FROM 1 TO 10 STEP 1',
        'INSERT INTO events (id, event_date) VALUES (1, \'2024-01-01\')',
        'INSERT INTO events FORMAT JSONEachRow',
        'OPTIMIZE TABLE `analytics`.`events` FINAL',
        'CREATE TABLE `analytics`.`events_copy` (id UInt64, event_date Date) ENGINE = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY (id, event_date) SETTINGS index_granularity = 8192',
    ])('accepts supported syntax: %s', sql => {
        const result = parse(sql);
        expect(result.lexResult.errors).toHaveLength(0);
        expect(result.actionableParserErrors).toHaveLength(0);
        expect(result.cst).toBeDefined();
    });

    it('rejects empty qualified-name segments', () => {
        const result = parse('SELECT * FROM analytics..events');
        expect(result.actionableParserErrors.length).toBeGreaterThan(0);
    });

    it('uses strict validation with ClickHouse types and functions', () => {
        expect(clickhouseSqlAuthoring.validation.syntaxValidationMode).toBe('strict');
        expect(clickhouseSqlAuthoring.validation.getTypeSpec('Array')).toBeDefined();
        expect(clickhouseSqlAuthoring.validation.getTypeSpec('LowCardinality')).toBeDefined();
        expect(clickhouseSqlAuthoring.validation.builtinFunctions.has('TODATE')).toBe(true);
        expect(clickhouseSqlAuthoring.validation.builtinFunctions.has('UNIQEXACT')).toBe(true);
    });

    it('creates isolated parser instances within the construction budget', () => {
        const start = Date.now();
        const parser = createSqlParserInstance();
        const elapsed = Date.now() - start;
        expect(parser).toBeDefined();
        expect(elapsed).toBeLessThan(2000);
    });
});
