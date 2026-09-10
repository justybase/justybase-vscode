import { clickhouseDialect } from '../../extensions/clickhouse/src/clickhouseDialect';
import { clickhouseExplainProvider } from '../../extensions/clickhouse/src/clickhouseExplainParser';
import { mysqlDialect } from '../../extensions/mysql/src/mysqlDialect';
import { mysqlExplainProvider } from '../../extensions/mysql/src/mysqlExplainParser';
import { postgresqlDialect } from '../../extensions/postgresql/src/postgresqlDialect';
import { postgresqlExplainProvider } from '../../extensions/postgresql/src/postgresqlExplainParser';
import { snowflakeDialect } from '../../extensions/snowflake/src/snowflakeDialect';
import { snowflakeImportWizardProvider } from '../../extensions/snowflake/src/snowflakeImportPlanner';
import {
    snowflakeExplainProvider,
    snowflakeQueryProfileProvider,
} from '../../extensions/snowflake/src/snowflakeQueryProfile';
import { snowflakeStageWorkflowProvider } from '../../extensions/snowflake/src/snowflakeImportExport';
import { sqliteAdvancedFeatures } from '../dialects/sqlite/advancedFeatures';

describe('advanced feature provider wiring', () => {
    it('keeps explain providers attached to their owning dialects', () => {
        expect(sqliteAdvancedFeatures.explain?.buildQuery('SELECT 1')).toBe('EXPLAIN QUERY PLAN SELECT 1');
        expect(postgresqlDialect.advancedFeatures?.explain).toBe(postgresqlExplainProvider);
        expect(mysqlDialect.advancedFeatures?.explain).toBe(mysqlExplainProvider);
        expect(clickhouseDialect.advancedFeatures?.explain).toBe(clickhouseExplainProvider);
        expect(snowflakeDialect.advancedFeatures?.explain).toBe(snowflakeExplainProvider);
    });

    it('keeps Snowflake profile, stage, and import workflow providers on the dialect', () => {
        expect(snowflakeDialect.advancedFeatures?.queryProfile).toBe(snowflakeQueryProfileProvider);
        expect(snowflakeDialect.advancedFeatures?.stageWorkflow).toBe(snowflakeStageWorkflowProvider);
        expect(snowflakeDialect.advancedFeatures?.importWizard).toBe(snowflakeImportWizardProvider);
        expect(snowflakeImportWizardProvider.mode).toBe('workflow');
    });
});
