import { createStubDialect } from '../stubDialectFactory';

export const mssqlDialect = createStubDialect('mssql', 'MS SQL Server', 1433, {
    extensionDisplayName: 'JustyBase MS SQL Server Support',
    connectionFormOptions: {
        databasePlaceholder: 'Database name',
        userPlaceholder: 'SQL Server user',
    },
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'preserve',
        },
        qualification: {
            twoPartNameStyle: 'schema-object',
        },
    },
});
