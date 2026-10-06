import * as importDispatcher from '../import/importDispatcher';
import * as connectionFactory from '../core/connectionFactory';
import * as clickhouseImporter from '../import/clickhouseImporter';
import { clickHouseImportWizardAdapter } from '../import/wizard/adapters/ClickHouseImportWizardAdapter';
import { snowflakeImportWizardAdapter } from '../import/wizard/adapters/SnowflakeImportWizardAdapter';
import {
    BaseImportWizardAdapter,
    withImportSheetOption,
} from '../import/wizard/adapters/DatabaseImportWizardAdapter';

class TestAdapter extends BaseImportWizardAdapter {
    public readonly kind = 'postgresql' as const;

    public constructor() {
        super('direct');
    }

    public mapInferredType(typeName: string): string {
        return typeName;
    }

    public buildCreateTableSql(): string {
        return 'CREATE TABLE public.orders (...)';
    }
}

describe('withImportSheetOption', () => {
    it('returns undefined options when nothing was provided', () => {
        expect(withImportSheetOption(undefined, undefined)).toBeUndefined();
        expect(withImportSheetOption(undefined, '   ')).toBeUndefined();
    });

    it('returns the original options when no sheet is requested', () => {
        const options = { hasHeaders: true, sheetName: 'First' };
        expect(withImportSheetOption(options, undefined)).toBe(options);
    });

    it('trims the requested sheet and overrides the existing value', () => {
        expect(withImportSheetOption({ hasHeaders: true, sheetName: 'First' }, ' Second ')).toEqual({
            hasHeaders: true,
            sheetName: 'Second',
        });
    });
});

describe('BaseImportWizardAdapter.execute', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('forwards the merged worksheet option to the dispatcher', async () => {
        const dispatchSpy = jest
            .spyOn(importDispatcher, 'importDataForConnection')
            .mockResolvedValue({ success: true, message: 'ok' });
        const adapter = new TestAdapter();

        const result = await adapter.execute({
            filePath: '/tmp/orders.xlsx',
            targetTable: 'public.orders',
            connectionDetails: {
                dbType: 'postgresql',
                host: 'localhost',
                database: 'warehouse',
                user: 'postgres',
            } as never,
            columnOptions: { hasHeaders: true },
            sheetName: ' Second ',
        });

        expect(result.success).toBe(true);
        expect(dispatchSpy).toHaveBeenCalledWith(
            '/tmp/orders.xlsx',
            'public.orders',
            expect.objectContaining({ dbType: 'postgresql' }),
            undefined,
            undefined,
            { hasHeaders: true, sheetName: 'Second' },
            undefined,
        );
    });

    it('leaves column options unchanged when no explicit sheet is set', async () => {
        const dispatchSpy = jest
            .spyOn(importDispatcher, 'importDataForConnection')
            .mockResolvedValue({ success: true, message: 'ok' });
        const adapter = new TestAdapter();
        const columnOptions = { sheetName: 'Second' };

        await adapter.execute({
            filePath: '/tmp/orders.xlsx',
            targetTable: 'public.orders',
            connectionDetails: {
                dbType: 'postgresql',
                host: 'localhost',
                database: 'warehouse',
                user: 'postgres',
            } as never,
            columnOptions,
        });

        expect(dispatchSpy).toHaveBeenCalledWith(
            '/tmp/orders.xlsx',
            'public.orders',
            expect.objectContaining({ dbType: 'postgresql' }),
            undefined,
            undefined,
            columnOptions,
            undefined,
        );
    });
});

describe('custom adapter execute implementations', () => {
    const connectionDetails = {
        dbType: 'snowflake',
        host: 'localhost',
        database: 'warehouse',
        user: 'user',
    } as never;

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('forwards the merged worksheet option to the Snowflake result provider', async () => {
        const createResult = jest.fn().mockResolvedValue({ success: false, message: 'plan' });
        jest.spyOn(connectionFactory, 'getRequiredDatabaseImportWizardProvider').mockReturnValue({
            createResult,
        } as never);

        await snowflakeImportWizardAdapter.execute({
            filePath: '/tmp/orders.xlsx',
            targetTable: 'analytics.public.orders',
            connectionDetails,
            columnOptions: { hasHeaders: true },
            sheetName: ' Second ',
        });

        expect(createResult).toHaveBeenCalledWith({
            filePath: '/tmp/orders.xlsx',
            targetTable: 'analytics.public.orders',
            columnOptions: { hasHeaders: true, sheetName: 'Second' },
        });
    });

    it('forwards the merged worksheet option to the ClickHouse importer', async () => {
        const importSpy = jest
            .spyOn(clickhouseImporter, 'importDataToClickHouse')
            .mockResolvedValue({ success: true, message: 'ok' });

        await clickHouseImportWizardAdapter.execute({
            filePath: '/tmp/orders.xlsx',
            targetTable: 'events',
            connectionDetails,
            columnOptions: { hasHeaders: true },
            sheetName: ' Second ',
        });

        expect(importSpy).toHaveBeenCalledWith(
            '/tmp/orders.xlsx',
            'events',
            connectionDetails,
            undefined,
            undefined,
            { hasHeaders: true, sheetName: 'Second' },
            undefined,
        );
    });
});
