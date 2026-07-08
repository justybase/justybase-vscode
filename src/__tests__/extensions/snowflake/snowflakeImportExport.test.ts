import {
    buildSnowflakeCopyIntoStageSql,
    buildSnowflakeCopyIntoTableSql,
    buildSnowflakeCreateStageTemplate,
    buildSnowflakeStageUsageGuide,
} from '../../../../extensions/snowflake/src/snowflakeImportExport';

describe('snowflakeImportExport', () => {
    it('builds COPY INTO table SQL for a staged import', () => {
        const sql = buildSnowflakeCopyIntoTableSql({
            tableName: 'ANALYTICS.PUBLIC.ORDERS',
            stage: {
                stageName: 'RAW_STAGE',
                stagePath: 'incoming/orders/',
            },
            fileFormatName: 'CSV_FORMAT',
            onError: 'ABORT_STATEMENT',
            matchByColumnName: 'CASE_INSENSITIVE',
            purge: true,
        });

        expect(sql).toContain('COPY INTO ANALYTICS.PUBLIC.ORDERS');
        expect(sql).toContain('FROM @RAW_STAGE/incoming/orders/');
        expect(sql).toContain('FORMAT_NAME = CSV_FORMAT');
        expect(sql).toContain('MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE');
        expect(sql).toContain('PURGE = TRUE');
    });

    it('builds COPY INTO table SQL with explicit columns and inline CSV file format options', () => {
        const sql = buildSnowflakeCopyIntoTableSql({
            tableName: 'ANALYTICS.PUBLIC.ORDERS',
            columns: ['ORDER_ID', 'CUSTOMER_NAME', 'TOTAL'],
            stage: {
                stageName: 'MY_STAGE',
                stagePath: 'orders.csv',
            },
            inlineFileFormat: {
                type: 'CSV',
                fieldDelimiter: ',',
                skipHeader: 1,
                fieldOptionallyEnclosedBy: '"',
                trimSpace: true,
                emptyFieldAsNull: true,
                nullIf: ['', 'NULL'],
            },
            onError: 'ABORT_STATEMENT',
        });

        expect(sql).toContain('COPY INTO ANALYTICS.PUBLIC.ORDERS (ORDER_ID, CUSTOMER_NAME, TOTAL)');
        expect(sql).toContain('FROM @MY_STAGE/orders.csv');
        expect(sql).toContain('TYPE = CSV');
        expect(sql).toContain("FIELD_DELIMITER = ','");
        expect(sql).toContain('SKIP_HEADER = 1');
        expect(sql).toContain(`FIELD_OPTIONALLY_ENCLOSED_BY = '"'`);
        expect(sql).toContain('EMPTY_FIELD_AS_NULL = TRUE');
    });

    it('builds COPY INTO stage SQL for export', () => {
        const sql = buildSnowflakeCopyIntoStageSql({
            tableName: 'ORDERS',
            database: 'ANALYTICS',
            schema: 'PUBLIC',
            stage: {
                stageName: 'RAW_STAGE',
            },
            fileFormatName: 'CSV_FORMAT',
            header: true,
            overwrite: true,
            single: false,
            maxFileSize: 128000000,
        });

        expect(sql).toContain('COPY INTO @RAW_STAGE');
        expect(sql).toContain('FROM ANALYTICS.PUBLIC.ORDERS');
        expect(sql).toContain('HEADER = TRUE');
        expect(sql).toContain('MAX_FILE_SIZE = 128000000');
    });

    it('builds stage creation template and usage guide', () => {
        const stageSql = buildSnowflakeCreateStageTemplate(
            { stageName: 'ANALYTICS.PUBLIC.RAW_STAGE' },
            's3://example-bucket/raw/',
        );
        const guide = buildSnowflakeStageUsageGuide({
            stageName: 'ANALYTICS.PUBLIC.RAW_STAGE',
            stagePath: 'landing/orders',
        });

        expect(stageSql).toContain('CREATE OR REPLACE STAGE ANALYTICS.PUBLIC.RAW_STAGE');
        expect(stageSql).toContain(`URL = 's3://example-bucket/raw/'`);

        expect(guide).toContain('# Snowflake Stage Workflow');
        expect(guide).toContain('COPY INTO');
        expect(guide).toContain('@ANALYTICS.PUBLIC.RAW_STAGE/landing/orders');
    });
});
