import { mySqlImportWizardAdapter } from '../import/wizard/adapters/MySqlImportWizardAdapter';
import { netezzaImportWizardAdapter } from '../import/wizard/adapters/NetezzaImportWizardAdapter';
import { snowflakeImportWizardAdapter } from '../import/wizard/adapters/SnowflakeImportWizardAdapter';
import { verticaImportWizardAdapter } from '../import/wizard/adapters/VerticaImportWizardAdapter';
import { accessImportWizardAdapter } from '../import/wizard/adapters/AccessImportWizardAdapter';
import { accessBatchImportConfig } from '../import/accessImporter';

describe('import wizard adapters', () => {
    it('maps Access source types and builds direct INSERT previews', () => {
        expect(accessImportWizardAdapter.mapInferredType('VARCHAR(80)')).toBe('TEXT(255)');
        expect(accessImportWizardAdapter.mapInferredType('BIGINT')).toBe('INTEGER');
        expect(accessImportWizardAdapter.mapInferredType('DATE')).toBe('DATETIME');

        const plan = accessImportWizardAdapter.buildExecutionPlan({
            filePath: '/tmp/orders.csv',
            targetTable: 'Orders',
            connectionDetails: {
                dbType: 'access',
                host: '',
                database: '/tmp/orders.accdb',
                user: '',
            } as never,
            columns: [
                { sourceIndex: 0, columnName: 'ID', dataType: 'INTEGER' },
                { sourceIndex: 1, columnName: 'NAME', dataType: 'TEXT(255)' },
            ],
            previewRows: [['1', "O'Reilly"]],
            detectedDelimiter: ',',
            decimalDelimiter: '.',
        });

        expect(plan.mode).toBe('direct');
        expect(plan.createTableSql).toContain('CREATE TABLE Orders');
        expect(plan.loadSql).toContain("'O''Reilly'");
    });

    it('maps Access batch literals without corrupting nulls, booleans, or quotes', () => {
        const column = (targetDataType: string) => ({
            sourceIndex: 0,
            columnName: 'VALUE',
            dataType: targetDataType,
            sourceDataType: targetDataType,
            targetDataType,
        });

        expect(accessBatchImportConfig.toSqlLiteral(null, column('TEXT(255)'), '.')).toBe('NULL');
        expect(accessBatchImportConfig.toSqlLiteral('yes', column('BOOLEAN'), '.')).toBe('TRUE');
        expect(accessBatchImportConfig.toSqlLiteral('0', column('BOOLEAN'), '.')).toBe('FALSE');
        expect(accessBatchImportConfig.toSqlLiteral("O'Reilly", column('TEXT(255)'), '.')).toBe("'O''Reilly'");
        expect(accessBatchImportConfig.toSqlLiteral('12.50', column('DECIMAL(10,2)'), '.')).toBe('12.50');
    });

    it('uses standalone CREATE and load SQL previews for Netezza advanced mode', () => {
        const plan = netezzaImportWizardAdapter.buildExecutionPlan({
            filePath: '/tmp/orders.csv',
            targetTable: 'ADMIN.ORDERS',
            connectionDetails: {
                dbType: 'netezza',
                host: 'localhost',
                database: 'SYSTEM',
                user: 'admin',
            } as never,
            columns: [
                { sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' },
                { sourceIndex: 1, columnName: 'AMOUNT', dataType: 'NUMERIC(18,2)' },
            ],
            previewRows: [['1', '10.50']],
            detectedDelimiter: ',',
            decimalDelimiter: '.',
            importer: {
                getDelegate: () => ({
                    generateStandaloneCreateTableSql: () => 'CREATE TABLE ADMIN.ORDERS (ID BIGINT) DISTRIBUTE ON RANDOM;',
                    generateLoadIntoExistingTableSql: () => 'INSERT INTO ADMIN.ORDERS (ID) SELECT ID FROM EXTERNAL ...;',
                }),
            } as never,
        });

        expect(plan.mode).toBe('direct');
        expect(plan.createTableSql).toContain('CREATE TABLE ADMIN.ORDERS');
        expect(plan.loadSql).toContain('INSERT INTO ADMIN.ORDERS');
    });

    it('builds workflow plans for Snowflake and omits COPY INTO for workbook sources', () => {
        const csvPlan = snowflakeImportWizardAdapter.buildExecutionPlan({
            filePath: '/tmp/orders.csv',
            targetTable: 'RAW.PUBLIC.ORDERS',
            connectionDetails: {
                dbType: 'snowflake',
                host: 'example.snowflakecomputing.com',
                database: 'RAW',
                user: 'user',
            } as never,
            columns: [
                { sourceIndex: 0, columnName: 'id', dataType: 'BIGINT' },
                { sourceIndex: 1, columnName: 'created_at', dataType: 'DATETIME' },
            ],
            previewRows: [['1', '2026-03-22 10:00:00']],
            detectedDelimiter: ',',
            decimalDelimiter: '.',
        });
        expect(csvPlan.mode).toBe('workflow');
        expect(csvPlan.loadSql).toContain('COPY INTO');
        expect(csvPlan.nextSteps?.length).toBeGreaterThan(0);

        const workbookPlan = snowflakeImportWizardAdapter.buildExecutionPlan({
            filePath: '/tmp/orders.xlsx',
            targetTable: 'RAW.PUBLIC.ORDERS',
            connectionDetails: {
                dbType: 'snowflake',
                host: 'example.snowflakecomputing.com',
                database: 'RAW',
                user: 'user',
            } as never,
            columns: [{ sourceIndex: 0, columnName: 'id', dataType: 'BIGINT' }],
            previewRows: [['1']],
            detectedDelimiter: ',',
            decimalDelimiter: '.',
        });
        expect(workbookPlan.loadSql).toBeUndefined();
        expect(workbookPlan.warnings[0]).toContain('does not load Excel workbooks directly');
    });

    it('builds batch INSERT previews for MySQL direct mode', () => {
        const plan = mySqlImportWizardAdapter.buildExecutionPlan({
            filePath: '/tmp/orders.csv',
            targetTable: 'sales.orders',
            connectionDetails: {
                dbType: 'mysql',
                host: 'localhost',
                database: 'sales',
                user: 'root',
            } as never,
            columns: [
                { sourceIndex: 0, columnName: 'id', dataType: 'BIGINT' },
                { sourceIndex: 1, columnName: 'amount', dataType: 'NUMERIC(18,2)' },
            ],
            previewRows: [['1', '10.50'], ['2', '20.25']],
            detectedDelimiter: ',',
            decimalDelimiter: '.',
        });

        expect(plan.mode).toBe('direct');
        expect(plan.createTableSql).toContain('CREATE TABLE');
        expect(plan.loadSql).toContain('INSERT INTO');
        expect(plan.loadSql).toContain('Preview shows sample rows only');
    });

    it('builds batch INSERT previews for Vertica direct mode', () => {
        const plan = verticaImportWizardAdapter.buildExecutionPlan({
            filePath: '/tmp/orders.csv',
            targetTable: 'sales.orders',
            connectionDetails: {
                dbType: 'vertica',
                host: 'localhost',
                database: 'warehouse',
                user: 'dbadmin',
            } as never,
            columns: [
                { sourceIndex: 0, columnName: 'id', dataType: 'BIGINT' },
                { sourceIndex: 1, columnName: 'notes', dataType: 'TEXT' },
                { sourceIndex: 2, columnName: 'created_at', dataType: 'DATETIME' },
            ],
            previewRows: [['1', 'hello', '2026-03-22 10:00:00']],
            detectedDelimiter: ',',
            decimalDelimiter: '.',
        });

        expect(plan.mode).toBe('direct');
        expect(plan.createTableSql).toContain('CREATE TABLE');
        expect(plan.createTableSql).toContain('notes LONG VARCHAR');
        expect(plan.loadSql).toContain('INSERT INTO');
        expect(plan.loadSql).toContain("TIMESTAMP '2026-03-22 10:00:00'");
    });
});
