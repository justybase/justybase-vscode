import { describe, expect, it } from '@jest/globals';
import {
    buildListIndexesQuery,
    buildListPartitionsQuery,
    buildTablePropertiesQuery,
} from '../../../../extensions/mysql/src/mysqlSystemQueries';

function compact(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('MySQL structural metadata queries', () => {
    it('loads table engine and server version for capability detection', () => {
        const query = compact(buildTablePropertiesQuery('sales', 'orders'));

        expect(query).toContain('t.ENGINE AS ENGINE');
        expect(query).toContain('VERSION() AS SERVER_VERSION');
        expect(query).toContain("t.TABLE_SCHEMA = 'sales'");
        expect(query).toContain("t.TABLE_TYPE = 'BASE TABLE'");
    });

    it('selects index ordering, expression, prefix, visibility, and statistics fields', () => {
        const query = compact(buildListIndexesQuery('sales', "orders'2026"));

        expect(query).toContain('FROM information_schema.statistics s');
        expect(query).toContain('s.SEQ_IN_INDEX AS SEQ_IN_INDEX');
        expect(query).toContain('s.EXPRESSION AS EXPRESSION');
        expect(query).toContain('s.SUB_PART AS SUB_PART');
        expect(query).toContain('s.IS_VISIBLE AS IS_VISIBLE');
        expect(query).toContain("s.TABLE_NAME = 'orders''2026'");
        expect(query).toContain('ORDER BY s.INDEX_NAME, s.SEQ_IN_INDEX');
    });

    it('selects partition and subpartition metadata plus storage estimates', () => {
        const query = compact(buildListPartitionsQuery('sales', 'orders'));

        expect(query).toContain('FROM information_schema.partitions p');
        expect(query).toContain('p.SUBPARTITION_NAME AS SUBPARTITION_NAME');
        expect(query).toContain('p.PARTITION_METHOD AS PARTITION_METHOD');
        expect(query).toContain('p.PARTITION_DESCRIPTION AS PARTITION_DESCRIPTION');
        expect(query).toContain('p.DATA_LENGTH AS DATA_LENGTH');
        expect(query).toContain('p.INDEX_LENGTH AS INDEX_LENGTH');
        expect(query).toContain('ORDER BY p.PARTITION_ORDINAL_POSITION, p.SUBPARTITION_ORDINAL_POSITION');
    });
});
