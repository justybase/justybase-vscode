import { createStubDialect } from '../stubDialectFactory';

export const db2Dialect = createStubDialect('db2', 'Db2', 50000, {
    connectionFormOptions: {
        databasePlaceholder: 'Db2 database name',
        userPlaceholder: 'Db2 user',
    },
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'upper',
        },
    },
});
