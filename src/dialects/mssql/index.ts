import { createStubDialect } from '../stubDialectFactory';

export const mssqlDialect = createStubDialect('mssql', 'MS SQL Server', 1433, {
    extensionDisplayName: 'MSSQL Tools (justybase)',
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
