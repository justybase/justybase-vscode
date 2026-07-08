import {
    composeImportTargetTable,
    getImportTargetLocationCapabilities,
    parseImportTargetLocation,
    resolveDefaultImportTargetLocation,
} from '../import/wizard/importTargetLocation';
import type { ConnectionDetails } from '../types';

const netezzaConnection: ConnectionDetails = {
    host: 'localhost',
    database: 'JUST_DATA',
    user: 'admin',
    dbType: 'netezza',
};

const mysqlConnection: ConnectionDetails = {
    host: 'localhost',
    database: 'sales',
    user: 'root',
    dbType: 'mysql',
};

describe('importTargetLocation', () => {
    it('enables database and schema selection for Netezza', () => {
        expect(getImportTargetLocationCapabilities('netezza')).toEqual({
            supportsDatabaseSelection: true,
            supportsSchemaSelection: true,
            enforceActiveDatabase: false,
        });
    });

    it('parses and composes a three-part Netezza target', () => {
        const location = parseImportTargetLocation(
            'RAW.ADMIN.ORDERS',
            netezzaConnection,
            'netezza',
        );

        expect(location).toEqual({
            database: 'RAW',
            schema: 'ADMIN',
            tableName: 'ORDERS',
        });

        expect(
            composeImportTargetTable(location, netezzaConnection, 'netezza'),
        ).toBe('RAW.ADMIN.ORDERS');
    });

    it('defaults missing schema and database from catalog for Netezza', () => {
        const location = resolveDefaultImportTargetLocation(
            { tableName: 'ORDERS' },
            netezzaConnection,
            'netezza',
            ['RAW', 'JUST_DATA'],
            ['ADMIN', 'PUBLIC'],
        );

        expect(location).toEqual({
            database: 'JUST_DATA',
            schema: 'ADMIN',
            tableName: 'ORDERS',
        });
    });

    it('uses database-only selection for MySQL', () => {
        expect(getImportTargetLocationCapabilities('mysql')).toEqual({
            supportsDatabaseSelection: true,
            supportsSchemaSelection: false,
            enforceActiveDatabase: false,
        });

        const location = parseImportTargetLocation('sales.orders', mysqlConnection, 'mysql');
        expect(location).toEqual({
            database: 'sales',
            schema: undefined,
            tableName: 'orders',
        });
        expect(composeImportTargetTable(location, mysqlConnection, 'mysql')).toBe('sales.orders');
    });

    it('uses Netezza double-dot notation when database is set without schema', () => {
        expect(
            composeImportTargetTable(
                { database: 'RAW', tableName: 'ORDERS' },
                netezzaConnection,
                'netezza',
            ),
        ).toBe('RAW..ORDERS');
    });
});
