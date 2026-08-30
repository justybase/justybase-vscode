import { describe, expect, it } from '@jest/globals';
import type { DatabaseDdlColumnInfo, DatabaseDdlKeyInfo } from '@justybase/contracts';
import { clickhouseAdvancedFeatures } from '../../../../extensions/clickhouse/src/clickhouseDdlGenerator';

const columns: DatabaseDdlColumnInfo[] = [
    {
        name: 'event_date',
        description: null,
        fullTypeName: 'Date',
        notNull: true,
        defaultValue: null,
    },
    {
        name: 'event_id',
        description: "event's id",
        fullTypeName: 'UInt64',
        notNull: true,
        defaultValue: null,
    },
];

const primaryKeys = new Map<string, DatabaseDdlKeyInfo>([
    ['PRIMARY', {
        type: 'PRIMARY KEY',
        typeChar: 'P',
        columns: ['event_date', 'event_id'],
        pkDatabase: null,
        pkSchema: null,
        pkRelation: null,
        pkColumns: [],
        updateType: '',
        deleteType: '',
    }],
]);

describe('ClickHouse DDL generation', () => {
    const ddl = clickhouseAdvancedFeatures.ddl!;

    it('reuses source DDL and safely replaces the original target name', () => {
        const sourceDdl = [
            'CREATE TABLE `source`.`events` (',
            '    `event_date` Date,',
            '    `event_id` UInt64',
            ') ENGINE = ReplacingMergeTree(version)',
            'PARTITION BY toYYYYMM(event_date)',
            'PRIMARY KEY (event_date, event_id)',
            'ORDER BY (toYYYYMM(event_date), event_id)',
            'TTL event_date + INTERVAL 30 DAY',
            'SETTINGS index_granularity = 8192;',
        ].join('\n');

        const result = ddl.buildTableDDLFromCache(
            'analytics',
            'analytics',
            'events_copy',
            columns,
            [],
            [],
            primaryKeys,
            undefined,
            undefined,
            {
                engine: 'ReplacingMergeTree',
                sourceDdl,
            },
        );

        expect(result).toContain('CREATE TABLE analytics.events_copy');
        expect(result).toContain('ReplacingMergeTree(version)');
        expect(result).toContain('PARTITION BY toYYYYMM(event_date)');
        expect(result).toContain('ORDER BY (toYYYYMM(event_date), event_id)');
        expect(result).toContain('SETTINGS index_granularity = 8192');
    });

    it('reconstructs all available storage clauses when source DDL is absent', () => {
        const result = ddl.buildTableDDLFromCache(
            'analytics',
            'analytics',
            'events_copy',
            columns,
            [],
            [],
            primaryKeys,
            undefined,
            undefined,
            {
                engine: 'ReplacingMergeTree',
                engineClause: 'ReplacingMergeTree(version)',
                partitionBy: 'toYYYYMM(event_date)',
                primaryKey: '(event_date, event_id)',
                orderBy: '(toYYYYMM(event_date), event_id)',
                sampleBy: 'event_id',
                ttl: 'event_date + INTERVAL 30 DAY',
                settings: 'index_granularity = 8192',
            },
        );

        expect(result).toContain('ENGINE = ReplacingMergeTree(version)');
        expect(result).toContain('PARTITION BY toYYYYMM(event_date)');
        expect(result).toContain('PRIMARY KEY (event_date, event_id)');
        expect(result).toContain('ORDER BY (toYYYYMM(event_date), event_id)');
        expect(result).toContain('SAMPLE BY event_id');
        expect(result).toContain('TTL event_date + INTERVAL 30 DAY');
        expect(result).toContain('SETTINGS index_granularity = 8192');
    });

    it('does not silently invent a MergeTree definition without metadata', () => {
        expect(() => ddl.buildTableDDLFromCache(
            'analytics',
            'analytics',
            'events_copy',
            columns,
            [],
            [],
            primaryKeys,
        )).toThrow(/table definition metadata is required/i);
    });
});
