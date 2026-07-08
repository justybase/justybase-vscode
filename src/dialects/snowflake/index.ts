import { createStubDialect } from '../stubDialectFactory';

export const snowflakeDialect = createStubDialect('snowflake', 'Snowflake', 443, {
    connectionFormOptions: {
        databasePlaceholder: 'Snowflake database',
        userPlaceholder: 'Snowflake user',
    },
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'upper',
        },
    },
});
