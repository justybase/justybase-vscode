import { describe, expect, it } from '@jest/globals';
import { sqliteDialect } from '../../../dialects/sqlite';
import { sqliteMetadataProvider } from '../../../dialects/sqlite/metadata/provider';
import { sqliteSqlAuthoring } from '../../../dialects/sqlite/sql/authoring';
import { normalizeSqliteExplainPlan, parseSqliteExplainPlan } from '../../../dialects/sqlite/explainParser';
import { sqliteImportTypeMapper } from '../../../dialects/sqlite/importTypeMapper';
import { sqliteTuningAdvisor } from '../../../dialects/sqlite/tuningAdvisor';

describe('SQLite native support coverage', () => {
    it('exposes native capabilities without server-only features', () => {
        expect(sqliteDialect.capabilities).toMatchObject({
            supportsExplainPlan: true,
            supportsExplainGraph: true,
            supportsTuningAdvisor: true,
            supportsTableMaintenance: true,
            supportsExternalTables: false,
            supportsProcedures: false,
            supportsSessionMonitor: false,
            supportsDistributionMetrics: false,
        });
        expect(sqliteSqlAuthoring.validation.databaseKind).toBe('sqlite');
        expect(sqliteSqlAuthoring.validation.syntaxValidationMode).toBe('strict');
        expect(sqliteSqlAuthoring.parsing?.parserModulePath).toContain('sqlite');
    });

    it('models catalogs and all native schema objects', () => {
        expect(sqliteMetadataProvider.defaultObjectTypes).toEqual(['TABLE', 'VIEW', 'INDEX', 'TRIGGER']);
        expect(sqliteMetadataProvider.buildTypeGroupsQuery('main')).toContain("'INDEX'");
        expect(sqliteMetadataProvider.buildObjectTypeQuery('main', 'INDEX')).toContain("type = 'index'");
        expect(sqliteMetadataProvider.buildObjectTypeQuery('main', 'PROCEDURE')).toContain('WHERE 1 = 0');
        expect(sqliteMetadataProvider.buildListSchemasQuery('main')).toContain('WHERE 1 = 0');
        expect(sqliteMetadataProvider.buildColumnsWithKeysQuery('main')).toContain('pragma_table_xinfo');
    });

    it('shares SQLite affinity mapping across imports', () => {
        expect(sqliteImportTypeMapper.createDataType('BOOLEAN').toString()).toBe('INTEGER');
        expect(sqliteImportTypeMapper.createDataType('VARCHAR(100)').toString()).toBe('TEXT');
        expect(sqliteImportTypeMapper.createDataType('TIMESTAMP').toString()).toBe('TIMESTAMP');
        expect(sqliteImportTypeMapper.createDataType('DATE').toString()).toBe('DATE');
        expect(sqliteImportTypeMapper.createDataType('TIME').toString()).toBe('TEXT');
        expect(sqliteImportTypeMapper.createDataType('DECIMAL', 10, 2).toString()).toBe('NUMERIC(10,2)');
        expect(sqliteImportTypeMapper.createDataType('DECIMAL(10, 2)').toString()).toBe('NUMERIC(10,2)');
    });

    it('normalizes SQLite EXPLAIN QUERY PLAN rows without inventing costs', () => {
        const raw = '2\t0\t0\tSCAN orders\n3\t2\t0\tSEARCH customers USING INDEX customers_id';
        expect(parseSqliteExplainPlan(raw)).toHaveLength(2);
        const normalized = normalizeSqliteExplainPlan(raw);
        expect(normalized).toContain('SCAN orders');
        expect(normalized).toContain('SEARCH customers USING INDEX');
        expect(normalized).toContain('cost=0..0');
    });

    it('provides SQLite-specific tuning recommendations', () => {
        const report = sqliteTuningAdvisor.analyze({
            sql: 'SELECT * FROM orders WHERE customer_id = 1',
            explainPlanText: '2\t0\t0\tSCAN orders\n3\t0\t0\tUSE TEMP B-TREE FOR ORDER BY',
        });
        expect(report.recommendations.map(item => item.id)).toEqual(
            expect.arrayContaining(['SLTA-001', 'SLTA-002', 'SLTA-004']),
        );
    });
});
