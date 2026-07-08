import { describe, expect, it } from '@jest/globals';
import {
    buildHeavySchemaDdl,
    countDimensionTables,
    countFactTables,
    estimateHeavySchemaStats,
    resolveHeavySchemaDatabaseNames,
} from '../../../Benchmark/heavyPrefetchSchema';

describe('heavyPrefetchSchema', () => {
    const sampleConfig = {
        dbPrefix: 'NZ_PREFETCH_E2E',
        dbCount: 5,
        tablesPerDb: 100,
        columnsPerTable: 30,
        enrichedRatio: 0.2,
        synonymsPerDb: 50,
        proceduresPerDb: 25,
        schema: 'ADMIN',
    };

    it('resolves numbered database names', () => {
        expect(resolveHeavySchemaDatabaseNames(sampleConfig)).toEqual([
            'NZ_PREFETCH_E2E_01',
            'NZ_PREFETCH_E2E_02',
            'NZ_PREFETCH_E2E_03',
            'NZ_PREFETCH_E2E_04',
            'NZ_PREFETCH_E2E_05',
        ]);
    });

    it('estimates tens of thousands of columns for default scale', () => {
        const stats = estimateHeavySchemaStats(sampleConfig);
        expect(stats.totalTables).toBe(500);
        expect(stats.estimatedColumns).toBe(15_000);
        expect(stats.enrichedTables).toBeGreaterThanOrEqual(100);
    });

    it('emits PK, FK, comments, and DISTRIBUTE ON in DDL', () => {
        const ddl = buildHeavySchemaDdl(sampleConfig, 'NZ_PREFETCH_E2E_01').join('\n');
        expect(ddl).toContain('DISTRIBUTE ON (DIM_ID)');
        expect(ddl).toContain('DISTRIBUTE ON (ROW_ID)');
        expect(ddl).toContain('ADD CONSTRAINT PK_DIM_REF_001 PRIMARY KEY (DIM_ID)');
        expect(ddl).toContain('ADD CONSTRAINT FK_FACT_0005_DIM FOREIGN KEY (REF_DIM_ID) REFERENCES');
        expect(ddl).toContain('ON DELETE NO ACTION ON UPDATE NO ACTION');
        expect(ddl).toContain("COMMENT ON TABLE NZ_PREFETCH_E2E_01.ADMIN.FACT_0005 IS");
        expect(ddl).toContain('COMMENT ON COLUMN NZ_PREFETCH_E2E_01.ADMIN.FACT_0005.REF_DIM_ID IS');
        expect(countDimensionTables(sampleConfig)).toBe(10);
        expect(countFactTables(sampleConfig)).toBe(90);
    });
});
