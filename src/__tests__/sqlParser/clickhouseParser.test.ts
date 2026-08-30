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
        'SELECT id, tag FROM events ARRAY JOIN tags WHERE id > 0',
        'SELECT id, row_number() OVER (PARTITION BY group_id ORDER BY id) AS rn FROM events QUALIFY rn = 1',
        'SELECT toDate(event_date) AS day, count() FROM events GROUP BY day ORDER BY day WITH FILL FROM 1 TO 10 STEP 1 LIMIT 10 BY group_id',
        'SELECT * FROM events SETTINGS max_threads = 1',
        'SELECT * FROM left_table ANY LEFT JOIN right_table USING (id)',
        'SELECT * FROM left_table LEFT ANY JOIN right_table USING (id)',
        'SELECT * FROM left_table LEFT ANTI JOIN right_table USING (id)',
        'SELECT * FROM left_table ASOF LEFT JOIN right_table ON left_table.ts >= right_table.ts',
        'SELECT * FROM events LIMIT 10 WITH TIES',
        'INSERT INTO events (id, event_date) VALUES (1, \'2024-01-01\')',
        'INSERT INTO events FORMAT JSONEachRow',
        'OPTIMIZE TABLE `analytics`.`events` FINAL',
        'SYSTEM FLUSH LOGS',
        'KILL QUERY WHERE query_id = \'query-1\' SYNC',
        'CREATE TABLE `analytics`.`events_copy` (id UInt64, event_date Date) ENGINE = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY (id, event_date) SETTINGS index_granularity = 8192',
        'CREATE TABLE nested_types (attrs Map(String, Array(Nullable(UInt64))), point Tuple(x Float64, y Float64), state AggregateFunction(uniq, UInt64), status Enum8(\'ok\' = 1, \'error\' = 2)) ENGINE = MergeTree ORDER BY tuple()',
        'CREATE TABLE ttl_table (id UInt64, event_time DateTime) ENGINE = MergeTree ORDER BY id TTL event_time + INTERVAL 1 DAY TO DISK \'slow\' SETTINGS index_granularity = 8192',
        'CREATE TABLE analytics.events ON CLUSTER production (id UInt64) ENGINE = Null',
        'CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.events_mv TO analytics.events_daily AS SELECT event_date, count() AS events FROM analytics.events GROUP BY event_date',
        'CREATE MATERIALIZED VIEW analytics.events_mv (event_date, events) TO analytics.events_daily (event_date, events) AS SELECT event_date, count() AS events FROM analytics.events GROUP BY event_date',
        'CREATE MATERIALIZED VIEW analytics.events_mv ON CLUSTER production ENGINE = Null AS SELECT 1',
        'CREATE MATERIALIZED VIEW analytics.events_mv ENGINE = SummingMergeTree() ORDER BY event_date POPULATE AS SELECT event_date, count() AS events FROM analytics.events GROUP BY event_date',
    ])('accepts supported syntax: %s', sql => {
        const result = parse(sql);
        expect(result.lexResult.errors).toHaveLength(0);
        expect(result.actionableParserErrors).toHaveLength(0);
        expect(result.cst).toBeDefined();
    });

    it.each([
        'SELECT id FROM events WHERE id > 0 ARRAY JOIN tags',
        'SELECT id FROM events LIMIT 10 WITH FILL',
    ])('rejects invalid ClickHouse clause order: %s', sql => {
        expect(parse(sql).actionableParserErrors.length).toBeGreaterThan(0);
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
        expect(clickhouseSqlAuthoring.validation.getTypeSpec('Map')).toBeDefined();
        expect(clickhouseSqlAuthoring.validation.getTypeSpec('Nested')).toBeDefined();
    });

    it('creates isolated parser instances within the construction budget', () => {
        const start = Date.now();
        const parser = createSqlParserInstance();
        const elapsed = Date.now() - start;
        expect(parser).toBeDefined();
        expect(elapsed).toBeLessThan(2000);
    });
});
