import { createStubDialect } from '../stubDialectFactory';

export const oracleDialect = createStubDialect('oracle', 'Oracle', 1521, {
    connectionFormOptions: {
        databasePlaceholder: 'SID or service name',
    },
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'upper',
        },
    },
});
